// Brands: a brand kit read from a link (website, product page, social profile
// or post), kept on the account, and used by slideshows, automations and
// campaigns (backend /api/v1/agentic/brand-kit*).
//
//   POST /agentic/brand-kit/analyze {url}  reads the link and saves the kit
//        (a NEW brand name makes a new kit; the same name updates it). Free
//        from this route, the same as the web's Brand page.
//   GET  /agentic/brand-kit[?brand_id=]    { brand_kit, brand_kits }
//   PUT  /agentic/brand-kit                edit fields (brand_id picks which)
//   PUT  /agentic/brand-kit/default        { brand_id }
//   POST /agentic/brand-kit/archive        { brand_id }

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { jsonResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { metaForMediaCard } from "../ui/templates.js";
import { STUDIO_TEXT_STYLE, slideshowResult, startedSlideshowResult } from "./slideshow.js";

type BrandKit = Record<string, any>;

async function listBrandKits(ctx: ToolContext): Promise<BrandKit[]> {
  const res = await ctx.client.get<{ brand_kits?: BrandKit[] }>("/api/v1/agentic/brand-kit");
  return Array.isArray(res?.brand_kits) ? res.brand_kits : [];
}

async function getBrandKit(ctx: ToolContext, brandId: string): Promise<BrandKit> {
  const res = await ctx.client.get<{ brand_kit?: BrandKit | null; brand_kits?: BrandKit[] }>(
    "/api/v1/agentic/brand-kit",
    { query: { brand_id: brandId } },
  );
  const kit = (res?.brand_kits ?? []).find((k) => k?.id === brandId) ?? (res?.brand_kit?.id === brandId ? res.brand_kit : null);
  if (!kit) throw new Error(`Brand ${brandId} is not one of the user's brands. Use versely_list_brands.`);
  return kit;
}

const clip = (v: unknown, n: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The brand as the slideshow planner's facts - the same block the backend's
 * brand automations send (services/hookPack.service brandProfileBlock).
 */
export function brandContextBlock(kit: BrandKit): string {
  const lines: string[] = [];
  if (kit.name) lines.push(`Name: ${clip(kit.name, 80)}`);
  if (kit.tagline) lines.push(`Tagline: ${clip(kit.tagline, 140)}`);
  if (kit.brand_type) lines.push(`Type: ${clip(kit.brand_type, 60)}`);
  if (kit.description) lines.push(`About: ${clip(kit.description, 400)}`);
  if (kit.audience) lines.push(`Audience: ${clip(kit.audience, 200)}`);
  if (kit.voice_tone) lines.push(`Voice: ${clip(kit.voice_tone, 160)}`);
  const products = (Array.isArray(kit.products) ? kit.products : []).slice(0, 6).map((pr: any) => {
    const bits = [clip(pr?.name, 60)];
    if (pr?.price) bits.push(clip(pr.price, 20));
    if (pr?.description) bits.push(clip(pr.description, 90));
    return bits.join(" — ");
  });
  if (products.length) lines.push(`Products:\n- ${products.join("\n- ")}`);
  const offerings = (Array.isArray(kit.offerings) ? kit.offerings : [])
    .slice(0, 4)
    .map((o: any) => [clip(o?.name, 60), o?.what ? clip(o.what, 90) : ""].filter(Boolean).join(": "));
  if (offerings.length && !products.length) lines.push(`Offerings:\n- ${offerings.join("\n- ")}`);
  const props = (Array.isArray(kit.value_props) ? kit.value_props : [])
    .slice(0, 4)
    .map((vp: any) => `${clip(vp?.problem, 90)} → ${clip(vp?.solution, 90)}`);
  if (props.length) lines.push(`Value props:\n- ${props.join("\n- ")}`);
  const proof = (Array.isArray(kit.proof_points) ? kit.proof_points : []).slice(0, 4).map((x: unknown) => clip(x, 90));
  if (proof.length) lines.push(`Proof: ${proof.join("; ")}`);
  const angles = (Array.isArray(kit.content_angles) ? kit.content_angles : []).slice(0, 5).map((x: unknown) => clip(x, 80));
  if (angles.length) lines.push(`Angles that work: ${angles.join("; ")}`);
  return lines.join("\n").slice(0, 1800);
}

/** A kit in a few fields, for lists and replies. */
function brandSummary(kit: BrandKit): Record<string, unknown> {
  return {
    brand_id: kit.id,
    name: kit.name,
    ...(kit.tagline ? { tagline: kit.tagline } : {}),
    ...(kit.brand_type ? { type: kit.brand_type } : {}),
    ...(kit.website_url ? { website_url: kit.website_url } : {}),
    ...(kit.logo_url ? { logo_url: kit.logo_url } : {}),
    ...(kit.is_default ? { is_default: true } : {}),
  };
}

/** Read a link into a brand kit and return it with its id (the analyze route answers without one). */
export async function analyzeLink(ctx: ToolContext, url: string): Promise<{ kit: BrandKit | null; brand: BrandKit; uncertain: string[]; saved: boolean }> {
  const res = await ctx.client.post<{ saved?: boolean; brand?: BrandKit; uncertain?: string[] }>(
    "/api/v1/agentic/brand-kit/analyze",
    { url },
    { timeoutMs: SYNC_TIMEOUT_MS },
  );
  const brand = res?.brand ?? {};
  const name = String(brand.name ?? "").trim().toLowerCase();
  const kits = await listBrandKits(ctx).catch(() => []);
  const kit =
    kits.find((k) => String(k?.name ?? "").trim().toLowerCase() === name) ??
    kits.find((k) => k?.website_url && brand.website_url && k.website_url === brand.website_url) ??
    null;
  return { kit, brand, uncertain: Array.isArray(res?.uncertain) ? res.uncertain : [], saved: res?.saved !== false };
}

const versely_analyze_brand = defineTool({
  name: "versely_analyze_brand",
  description:
    "Read a brand from a link - its website, a product page, a social profile or a post - and save it to the user's " +
    "Versely brands: name, what it does, products, audience, voice, content angles, logo and colours. Returns its " +
    "brand_id, which versely_create_brand_slideshow and versely_create_slideshow_automation (brand_kit_id) use to " +
    "make content on-brand. A link to a brand already saved updates it. Takes up to a minute. Show the user a short " +
    "summary and anything marked uncertain, and let them correct it (versely_update_brand).",
  inputSchema: z.object({
    url: z.string().url().describe("The brand's link: website, product page, social profile or post (full https URL)."),
  }),
  handler: async (input, ctx) => {
    const { kit, brand, uncertain, saved } = await analyzeLink(ctx, input.url);
    return jsonResult({
      ...(kit ? { brand_id: kit.id } : {}),
      saved,
      brand: {
        name: brand.name,
        tagline: brand.tagline,
        type: brand.brand_type,
        description: brand.description,
        audience: brand.audience,
        voice: brand.voice_tone,
        products: (Array.isArray(brand.products) ? brand.products : []).slice(0, 8).map((p: any) => p?.name).filter(Boolean),
        content_angles: brand.content_angles,
        colors: brand.colors,
        logo_url: brand.logo_url,
        website_url: brand.website_url,
      },
      uncertain,
      ...(kit ? {} : { note: "Read, but the saved brand could not be found by name; see versely_list_brands." }),
    });
  },
});

const versely_list_brands = defineTool({
  name: "versely_list_brands",
  description:
    "The brands saved on the user's account (from links they analyzed): brand_id, name, tagline, website, logo, and " +
    "which one is the default.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const kits = await listBrandKits(ctx);
    return jsonResult({
      brands: kits.map(brandSummary),
      ...(kits.length === 0 ? { note: "No brands yet: read one from a link with versely_analyze_brand." } : {}),
    });
  },
});

const versely_get_brand = defineTool({
  name: "versely_get_brand",
  description: "Everything saved about one of the user's brands: description, audience, voice, products, value props, angles, colours, logo.",
  inputSchema: z.object({ brand_id: z.string().describe("From versely_list_brands or versely_analyze_brand.") }),
  handler: async (input, ctx) => jsonResult(await getBrandKit(ctx, input.brand_id)),
});

const Product = z.object({
  name: z.string().max(120),
  price: z.string().max(40).optional(),
  description: z.string().max(600).optional(),
  url: z.string().url().optional(),
  image_url: z.string().url().optional(),
});

const versely_update_brand = defineTool({
  name: "versely_update_brand",
  description:
    "Correct or add to one of the user's saved brands. Only the fields given change. `products` and " +
    "`product_shots` replace the saved lists.",
  inputSchema: z.object({
    brand_id: z.string().describe("From versely_list_brands."),
    name: z.string().max(120).optional(),
    tagline: z.string().max(240).optional(),
    description: z.string().max(2000).optional(),
    audience: z.string().max(600).optional(),
    voice_tone: z.string().max(600).optional().describe("How the brand talks, e.g. 'playful, short sentences'."),
    website_url: z.string().url().optional(),
    logo_url: z.string().url().optional(),
    colors: z.record(z.string().regex(/^#[0-9a-fA-F]{3,8}$/)).optional().describe("Name → #hex, e.g. {\"primary\":\"#ff6600\"}."),
    products: z.array(Product).max(20).optional(),
    product_shots: z
      .array(z.object({ url: z.string().url(), name: z.string().max(80).optional() }))
      .max(10)
      .optional()
      .describe("Product photos (public https URLs) used under UGC presenters."),
  }),
  handler: async (input, ctx) => {
    const { brand_id, ...fields } = input;
    if (Object.keys(fields).length === 0) throw new Error("Nothing to change: pass at least one field.");
    await ctx.client.put("/api/v1/agentic/brand-kit", { brand_id, ...fields });
    return jsonResult({ updated: true, brand: brandSummary(await getBrandKit(ctx, brand_id)) });
  },
});

const versely_set_default_brand = defineTool({
  name: "versely_set_default_brand",
  description: "Make one of the user's brands the default - what brand work uses when no brand is named.",
  inputSchema: z.object({ brand_id: z.string() }),
  handler: async (input, ctx) => {
    await ctx.client.put("/api/v1/agentic/brand-kit/default", { brand_id: input.brand_id });
    return jsonResult({ default_brand_id: input.brand_id });
  },
});

const versely_archive_brand = defineTool({
  name: "versely_archive_brand",
  description:
    "Archive one of the user's brands: it leaves their brand list (and automations for it pause with a message). It " +
    "can be restored from the web app's Brand page.",
  inputSchema: z.object({ brand_id: z.string() }),
  handler: async (input, ctx) => {
    await ctx.client.post("/api/v1/agentic/brand-kit/archive", { brand_id: input.brand_id });
    return jsonResult({ archived: input.brand_id });
  },
});

const versely_create_brand_slideshow = defineTool({
  name: "versely_create_brand_slideshow",
  description:
    "Make a slideshow for one of the user's brands - value-first content for its audience, in its voice, mentioning " +
    "it lightly. Pass brand_id, or just the brand's `url` (it is read and saved first, like versely_analyze_brand). " +
    "`topic` is optional: without it the slideshow takes the brand's first content angle. source 'ai' draws the " +
    "slides with an image model; 'pinterest' uses matching Pinterest pictures. Spends the user's Versely credits; the " +
    "inline card fills in as the slides land. For a recurring series use versely_create_slideshow_automation with " +
    "brand_kit_id.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    brand_id: z.string().optional().describe("From versely_list_brands / versely_analyze_brand."),
    url: z.string().url().optional().describe("The brand's link, when it is not saved yet (read and saved first)."),
    topic: z.string().max(300).optional().describe("What this slideshow is about. Default: one of the brand's content angles."),
    source: z.enum(["ai", "pinterest"]).optional().describe("'ai' (default) or 'pinterest'."),
    model: z.string().optional().describe("Image model for 'ai', from versely_list_slideshow_options (default 'Flux Pro Ultra')."),
    num_images: z.number().int().min(1).max(20).optional().describe("Slides (default 5)."),
    content_type: z.enum(["reel", "story", "post", "portrait", "landscape"]).optional().describe("Slide shape (default 'reel')."),
    caption_style: z.string().optional().describe("Caption style id from versely_list_slideshow_options; omit for classic captions."),
  }),
  handler: async (input, ctx) => {
    let brandId = input.brand_id;
    if (!brandId) {
      if (!input.url) throw new Error("Pass brand_id (versely_list_brands) or the brand's url.");
      const read = await analyzeLink(ctx, input.url);
      if (!read.kit) throw new Error("The link was read but the brand could not be saved; try versely_analyze_brand.");
      brandId = String(read.kit.id);
    }
    const kit = await getBrandKit(ctx, brandId);
    const angles = (Array.isArray(kit.content_angles) ? kit.content_angles : []).filter(
      (a: unknown): a is string => typeof a === "string" && !!a.trim(),
    );
    const topic = input.topic?.trim() || angles[0] || `Useful ideas for ${kit.audience || "the brand's audience"}`;
    // Pinterest overlays use the heavier outline its own automations use.
    const textStyle = input.source === "pinterest" ? { ...STUDIO_TEXT_STYLE, stroke_width: 6 } : STUDIO_TEXT_STYLE;
    const common: Record<string, unknown> = {
      prompt: topic,
      num_images: input.num_images ?? 5,
      content_type: input.content_type ?? "reel",
      brand_context: brandContextBlock(kit),
      ...(input.caption_style ? { caption_style: input.caption_style } : { text_style: textStyle }),
    };
    const toolArgs = { brand_id: brandId, topic, source: input.source ?? "ai" };

    if (input.source === "pinterest") {
      // Answers with the finished slideshow (captions baked from text_style).
      const done = await ctx.client.post<{ data?: { slideshow_id?: string } }>(
        "/api/v1/slideshow/create-pinterest-auto",
        common,
        { timeoutMs: SYNC_TIMEOUT_MS },
      );
      const id = done?.data?.slideshow_id;
      if (typeof id === "string" && id) {
        const row = await ctx.client.get(`/api/v1/slideshow/${encodeURIComponent(id)}`);
        return withBrand(slideshowResult(row, { toolName: "versely_create_brand_slideshow", toolArgs }), kit);
      }
      return jsonResult(done);
    }

    const started = await ctx.client.post("/api/v1/slideshow/create-automated", {
      ...common,
      model: input.model ?? "Flux Pro Ultra",
      bake_overlays: true,
    }, { timeoutMs: SYNC_TIMEOUT_MS });
    return withBrand(await startedSlideshowResult(ctx, started, { toolName: "versely_create_brand_slideshow", toolArgs }), kit);
  },
});

/** Say which brand and topic the slideshow is for. */
function withBrand(result: ToolResult, kit: BrandKit): ToolResult {
  const note = `Brand: ${kit.name ?? "brand"} (brand_id ${kit.id}).`;
  return { ...result, content: [...result.content, { type: "text", text: note }] };
}

export const brandTools: Tool[] = [
  versely_analyze_brand,
  versely_list_brands,
  versely_get_brand,
  versely_update_brand,
  versely_set_default_brand,
  versely_archive_brand,
  versely_create_brand_slideshow,
];
