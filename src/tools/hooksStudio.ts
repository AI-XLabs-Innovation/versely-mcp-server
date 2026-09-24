// The Hooks studio (backend /hooks/*, web /hooks): a library of ready-made
// hook clips (a presenter reacting, a product moment...) each with a
// suggested line, which the user picks from and REUSES with their own brand's
// text burned on; packs of new AI hook videos for a brand, or for one of the
// user's CHARACTERS (a consistent presenter made from a description or photo);
// royalty-free music beds; and scheduling a finished collection to social
// accounts. Plus social post analytics (views, likes... over time).

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { jsonResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";
import { brandContextBlock } from "./brands.js";

const COLLECTION_POLL = { interval_ms: 6000, timeout_ms: 30 * 60_000 };
const TERMINAL = new Set(["completed", "partial", "failed", "cancelled", "canceled"]);

/** A hook collection as media-card state: pending until it settles, then its finished videos. */
function collectionCard(payload: unknown, id: string): ToolResult {
  const col = ((payload as any)?.collection ?? {}) as Record<string, any>;
  const items = (((payload as any)?.items ?? []) as Array<Record<string, any>>).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const status = String(col.status ?? "queued");
  const done = items.filter((it) => it.status === "completed" && it.video_url);
  const pending = !TERMINAL.has(status);
  const cardStatus = pending ? "pending" : done.length ? "completed" : "failed";
  const assets = done.map((it, i) => ({ url: String(it.video_url), label: it.hook_line ? String(it.hook_line) : `Hook ${i + 1}` }));
  const text = pending
    ? `Hook collection ${id} (${col.kind ?? "hooks"}) is ${status}: ${done.length} of ${items.length || col.count || "?"} ready. ` +
      `If an inline preview is shown it updates on its own; otherwise call versely_get_hook_collection with collection_id="${id}".`
    : cardStatus === "failed"
      ? `Hook collection ${id} ${status === "cancelled" || status === "canceled" ? "was cancelled" : "failed"}${col.error ? `: ${col.error}` : ""}.`
      : `Hook collection ${id} is ${status}:\n` + assets.map((a, i) => `${i + 1}. ${a.label}: ${a.url}`).join("\n") +
        `\nSchedule it to social accounts with versely_schedule_hook_collection.`;
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      kind: assets.length > 1 ? "gallery" : "video",
      status: cardStatus,
      task_id: id,
      assets,
      ...(col.title ? { title: String(col.title) } : {}),
      ...(items.length ? { progress: done.length / items.length } : {}),
      ...(cardStatus === "failed" ? { error: String(col.error ?? "No hook could be made; unspent credits are refunded.") } : {}),
      ...(pending ? { poll: { tool_name: "versely_get_hook_collection", args: { collection_id: id }, ...COLLECTION_POLL } } : {}),
    },
  };
}

async function brandContextFor(ctx: ToolContext, brandId: string | undefined, brief: string | undefined): Promise<string | undefined> {
  if (brandId) {
    const res = await ctx.client.get<{ brand_kits?: Array<Record<string, any>> }>("/api/v1/agentic/brand-kit", { query: { brand_id: brandId } });
    const kit = (res?.brand_kits ?? []).find((k) => k?.id === brandId);
    if (!kit) throw new Error(`Brand ${brandId} is not one of the user's brands (versely_list_brands).`);
    return [brandContextBlock(kit), brief ? `Brief: ${brief}` : ""].filter(Boolean).join("\n");
  }
  return brief?.trim() || undefined;
}

async function startCollection(ctx: ToolContext, body: Record<string, unknown>, toolName: string, toolArgs: Record<string, unknown>): Promise<ToolResult> {
  const res = await ctx.client.post<{ collection?: { id?: string }; collection_id?: string; id?: string }>("/api/v1/hooks/collections", body);
  const id = res?.collection?.id ?? res?.collection_id ?? res?.id;
  if (typeof id !== "string" || !id) return jsonResult(res);
  let card: ToolResult;
  try {
    card = collectionCard(await ctx.client.get(`/api/v1/hooks/collections/${encodeURIComponent(id)}`), id);
  } catch {
    card = collectionCard({ collection: { status: "queued" }, items: [] }, id);
  }
  return { ...card, structuredContent: { ...card.structuredContent, toolName, toolArgs } };
}

const CaptionMode = z.enum(["auto", "none", "custom"]).optional().describe("Burn a line on: 'auto' (written per hook, default), 'custom' (caption_text), or 'none'.");
const Vibes = z.array(z.string()).max(5).optional().describe("Settings to vary between, e.g. ['cafe','outdoor'] (see the library's vibes).");
const Emotions = z.array(z.string()).max(5).optional().describe("Presenter emotions, e.g. ['surprised','excited'].");

// --- Library, saves -------------------------------------------------------------------

const versely_list_hook_library = defineTool({
  name: "versely_list_hook_library",
  description:
    "Ready-made hook clips in Versely's hook library, each with a suggested line; with brand_id or brief the lines are " +
    "picked and rewritten for that brand. To SHOW them for the user to pick, prefer versely_browse (collection " +
    "'hook_library'). Reuse picks with versely_reuse_hooks. Free.",
  inputSchema: z.object({
    brand_id: z.string().optional().describe("Pick and word hooks for this brand (versely_list_brands)."),
    brief: z.string().max(500).optional().describe("What the hooks are for, when there's no saved brand."),
    vibe: z.string().optional(),
    emotion: z.string().optional(),
    limit: z.number().int().min(1).max(40).optional().describe("Default 12."),
  }),
  handler: async (input, ctx) =>
    jsonResult(
      await ctx.client.get("/api/v1/hooks/deck", {
        query: { brand_kit_id: input.brand_id, brief: input.brief, vibe: input.vibe, emotion: input.emotion, limit: input.limit ?? 12 },
      }),
    ),
});

const versely_save_hook = defineTool({
  name: "versely_save_hook",
  description: "Save a hook clip from the library to the user's saved hooks (optionally with their own line), to reuse later.",
  inputSchema: z.object({ hook_id: z.string(), hook_line: z.string().max(200).optional() }),
  handler: async (input, ctx) =>
    jsonResult(await ctx.client.post("/api/v1/hooks/swipe", { hook_id: input.hook_id, action: "save", ...(input.hook_line ? { hook_line: input.hook_line } : {}) })),
});

const versely_list_saved_hooks = defineTool({
  name: "versely_list_saved_hooks",
  description: "The hook clips the user saved (at most 20 at a time), with their lines.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => jsonResult(await ctx.client.get("/api/v1/hooks/saves")),
});

const versely_unsave_hook = defineTool({
  name: "versely_unsave_hook",
  description: "Remove a hook clip from the user's saved hooks (frees a slot).",
  inputSchema: z.object({ hook_id: z.string() }),
  handler: async (input, ctx) => jsonResult(await ctx.client.delete(`/api/v1/hooks/saves/${encodeURIComponent(input.hook_id)}`)),
});

const versely_list_music_beds = defineTool({
  name: "versely_list_music_beds",
  description: "Royalty-free music beds for hooks and videos (versely_browse 'music_beds' plays them).",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => jsonResult(await ctx.client.get("/api/v1/hooks/music-beds")),
});

// --- Collections ------------------------------------------------------------------------

const versely_quote_hooks = defineTool({
  name: "versely_quote_hooks",
  description: "What a hook collection would cost before making it: reuse (per library clip) or a pack / character pack (3, 5 or 10 new hooks).",
  inputSchema: z.object({
    kind: z.enum(["reuse", "pack", "character_pack"]),
    count: z.number().int().optional().describe("pack / character_pack: 3, 5 or 10. reuse: how many clips."),
    hook_ids: z.array(z.string()).max(20).optional().describe("reuse: the clips."),
    caption: z.boolean().optional().describe("reuse: burn the lines on (default true)."),
    caption_mode: CaptionMode,
  }),
  handler: async (input, ctx) => jsonResult(await ctx.client.post("/api/v1/hooks/quote", input)),
});

const versely_reuse_hooks = defineTool({
  name: "versely_reuse_hooks",
  description:
    "Turn picked library hook clips (versely_browse 'hook_library') into the user's own hooks: their brand's line is " +
    "burned on each clip, with optional music. Fast and cheap - no new video is generated. Spends Versely credits " +
    "(versely_quote_hooks); the inline card fills in. Up to 20 clips.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    hook_ids: z.array(z.string()).min(1).max(20).describe("Library clip ids."),
    lines: z.record(z.string().max(200)).optional().describe("Your line per clip: { hook_id: line }. Missing ones are written for the brand."),
    brand_id: z.string().optional(),
    brief: z.string().max(1000).optional().describe("What it's for, when there's no saved brand."),
    title: z.string().max(120).optional(),
    music_bed_id: z.string().optional().describe("From versely_list_music_beds / versely_browse music_beds."),
    trending_sound_id: z.string().optional().describe("A trending sound (versely_list_trending_sounds); its royalty-free bed is used."),
    caption: z.boolean().optional().describe("Burn the lines on (default true)."),
  }),
  handler: async (input, ctx) => {
    const brand_context = await brandContextFor(ctx, input.brand_id, input.brief);
    return startCollection(
      ctx,
      {
        kind: "reuse",
        hook_ids: input.hook_ids,
        ...(input.lines ? { lines: input.lines } : {}),
        ...(input.brand_id ? { brand_kit_id: input.brand_id } : {}),
        ...(brand_context ? { brand_context } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.music_bed_id ? { music_bed_id: input.music_bed_id } : {}),
        ...(input.trending_sound_id ? { trending_sound_id: input.trending_sound_id } : {}),
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        source: "mcp",
      },
      "versely_reuse_hooks",
      input,
    );
  },
});

const PackFields = {
  brand_id: z.string().optional().describe("Make the hooks for this brand (versely_list_brands)."),
  brief: z.string().max(1000).optional().describe("What the hooks are for (required without brand_id)."),
  count: z.union([z.literal(3), z.literal(5), z.literal(10)]).optional().describe("How many hooks: 3, 5 (default) or 10."),
  caption_mode: CaptionMode,
  caption_text: z.string().max(200).optional().describe("With caption_mode 'custom': the line to burn on every hook."),
  vibes: Vibes,
  emotions: Emotions,
  title: z.string().max(120).optional(),
};

const versely_create_hook_pack = defineTool({
  name: "versely_create_hook_pack",
  description:
    "Generate a pack of new AI hook videos (3, 5 or 10) for a brand or brief, with varied settings and emotions and a " +
    "line burned on. Spends Versely credits (versely_quote_hooks with kind 'pack'); the inline card fills in.",
  meta: metaForMediaCard(),
  inputSchema: z.object(PackFields),
  handler: async (input, ctx) => {
    const brand_context = await brandContextFor(ctx, input.brand_id, input.brief);
    if (!brand_context) throw new Error("Pass brand_id or a brief: the hooks need something to be about.");
    const { brand_id, brief: _b, ...rest } = input;
    return startCollection(ctx, { kind: "pack", brand_context, ...(brand_id ? { brand_kit_id: brand_id } : {}), ...rest }, "versely_create_hook_pack", input);
  },
});

const versely_create_character_hook_pack = defineTool({
  name: "versely_create_character_hook_pack",
  description:
    "Generate a pack of hook videos (3, 5 or 10) starring one of the user's characters - the same presenter in every " +
    "hook - for a brand or brief. Spends Versely credits; the inline card fills in.",
  meta: metaForMediaCard(),
  inputSchema: z.object({ character_id: z.string().describe("From versely_list_hook_characters / versely_browse hook_characters."), ...PackFields }),
  handler: async (input, ctx) => {
    const brand_context = await brandContextFor(ctx, input.brand_id, input.brief);
    if (!brand_context) throw new Error("Pass brand_id or a brief: the hooks need something to be about.");
    const { brand_id, brief: _b, ...rest } = input;
    return startCollection(ctx, { kind: "character_pack", brand_context, ...(brand_id ? { brand_kit_id: brand_id } : {}), ...rest }, "versely_create_character_hook_pack", input);
  },
});

const versely_get_hook_collection = defineTool({
  name: "versely_get_hook_collection",
  description: "Check a hook collection (reuse, pack or character pack): its status and finished videos.",
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({ collection_id: z.string() }),
  handler: async (input, ctx) =>
    collectionCard(await ctx.client.get(`/api/v1/hooks/collections/${encodeURIComponent(input.collection_id)}`), input.collection_id),
});

const versely_list_hook_collections = defineTool({
  name: "versely_list_hook_collections",
  description: "The user's hook collections, newest first, with status and counts.",
  inputSchema: z.object({
    kind: z.enum(["reuse", "pack", "character_pack"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (input, ctx) => jsonResult(await ctx.client.get("/api/v1/hooks/collections", { query: input })),
});

const versely_cancel_hook_collection = defineTool({
  name: "versely_cancel_hook_collection",
  description: "Stop a hook collection that is still being made; hooks already finished are kept.",
  inputSchema: z.object({ collection_id: z.string() }),
  handler: async (input, ctx) =>
    jsonResult(await ctx.client.post(`/api/v1/hooks/collections/${encodeURIComponent(input.collection_id)}/cancel`, {})),
});

const versely_schedule_hook_collection = defineTool({
  name: "versely_schedule_hook_collection",
  description:
    "Post a finished hook collection to the user's connected social accounts, one hook at a time on a schedule " +
    "(default every 24 hours from start_at). Each post is charged like any social post. Confirm the accounts and " +
    "schedule with the user first.",
  inputSchema: z.object({
    collection_id: z.string(),
    account_ids: z.array(z.string()).min(1).describe("Account ids from versely_list_social_accounts."),
    start_at: z.string().optional().describe("ISO-8601 time of the first post (default: soon)."),
    every_hours: z.number().int().min(1).max(336).optional().describe("Hours between posts (default 24)."),
    caption_suffix: z.string().max(500).optional().describe("Added to every post's caption (e.g. hashtags, a link)."),
    item_ids: z.array(z.string()).optional().describe("Only these hooks of the collection."),
  }),
  handler: async (input, ctx) => {
    const { collection_id, ...body } = input;
    return jsonResult(await ctx.client.post(`/api/v1/hooks/collections/${encodeURIComponent(collection_id)}/schedule`, body));
  },
});

// --- Characters --------------------------------------------------------------------------

const versely_list_hook_characters = defineTool({
  name: "versely_list_hook_characters",
  description: "The user's hook characters (consistent presenters for hook packs), with their portraits and status.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => jsonResult(await ctx.client.get("/api/v1/hooks/characters")),
});

const versely_create_hook_character = defineTool({
  name: "versely_create_hook_character",
  description:
    "Create a hook character - a consistent presenter - from a description and/or a reference photo: Versely draws " +
    "portraits to choose from (spends Versely credits per portrait). Check them with versely_get_hook_character, then " +
    "choose one with versely_pick_character_portrait. Up to 12 characters.",
  inputSchema: z.object({
    name: z.string().min(1).max(60),
    description: z.string().max(600).optional().describe("Who they are: age, look, style, vibe."),
    reference_image_url: z.string().url().optional().describe("A photo to base them on."),
    brand_id: z.string().optional(),
    count: z.number().int().min(1).max(6).optional().describe("Portraits to draw (default 4)."),
  }),
  handler: async (input, ctx) => {
    const { brand_id, ...rest } = input;
    return jsonResult(await ctx.client.post("/api/v1/hooks/characters", { ...rest, ...(brand_id ? { brand_kit_id: brand_id } : {}) }));
  },
});

const versely_upload_hook_character = defineTool({
  name: "versely_upload_hook_character",
  description: "Create a hook character straight from a photo the user already has (no portraits drawn, free).",
  inputSchema: z.object({
    name: z.string().min(1).max(60),
    image_url: z.string().url(),
    description: z.string().max(600).optional(),
    brand_id: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const { brand_id, ...rest } = input;
    return jsonResult(await ctx.client.post("/api/v1/hooks/characters/upload", { ...rest, ...(brand_id ? { brand_kit_id: brand_id } : {}) }));
  },
});

const versely_get_hook_character = defineTool({
  name: "versely_get_hook_character",
  description: "One hook character, with its portraits (refreshed while they are being drawn).",
  inputSchema: z.object({ character_id: z.string() }),
  handler: async (input, ctx) => jsonResult(await ctx.client.get(`/api/v1/hooks/characters/${encodeURIComponent(input.character_id)}`)),
});

const versely_pick_character_portrait = defineTool({
  name: "versely_pick_character_portrait",
  description: "Choose which of a character's portraits is its face in hooks.",
  inputSchema: z.object({ character_id: z.string(), image_url: z.string().url().describe("One of the character's portrait URLs.") }),
  handler: async (input, ctx) =>
    jsonResult(await ctx.client.patch(`/api/v1/hooks/characters/${encodeURIComponent(input.character_id)}`, { image_url: input.image_url })),
});

const versely_delete_hook_character = defineTool({
  name: "versely_delete_hook_character",
  description: "Remove one of the user's hook characters.",
  inputSchema: z.object({ character_id: z.string() }),
  handler: async (input, ctx) => jsonResult(await ctx.client.delete(`/api/v1/hooks/characters/${encodeURIComponent(input.character_id)}`)),
});

// --- Post analytics -------------------------------------------------------------------------

const versely_get_social_analytics_overview = defineTool({
  name: "versely_get_social_analytics_overview",
  description: "How the user's published posts are doing overall: total views, likes, comments and shares, and the top posts. Part of a subscription.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => jsonResult(await ctx.client.get("/api/v1/social-analytics/overview")),
});

const versely_get_post_analytics = defineTool({
  name: "versely_get_post_analytics",
  description:
    "Live stats of one of the user's published posts (views, likes, comments, shares, per platform). refresh: true " +
    "collects the latest numbers first. Part of a subscription.",
  inputSchema: z.object({
    post_id: z.string().describe("The post's id from versely_list_posts."),
    refresh: z.boolean().optional(),
  }),
  handler: async (input, ctx) => {
    if (input.refresh) {
      try {
        await ctx.client.post(`/api/v1/social-analytics/${encodeURIComponent(input.post_id)}/collect`, {});
      } catch {
        /* the read below still answers with the last snapshot */
      }
    }
    return jsonResult(await ctx.client.get(`/api/v1/social-analytics/${encodeURIComponent(input.post_id)}`));
  },
});

const versely_get_post_analytics_history = defineTool({
  name: "versely_get_post_analytics_history",
  description: "How one of the user's posts grew over time: its stats snapshots, newest first. Part of a subscription.",
  inputSchema: z.object({ post_id: z.string(), limit: z.number().int().min(1).max(200).optional() }),
  handler: async (input, ctx) =>
    jsonResult(await ctx.client.get(`/api/v1/social-analytics/${encodeURIComponent(input.post_id)}/history`, { query: { limit: input.limit } })),
});

export const hooksStudioTools: Tool[] = [
  versely_list_hook_library,
  versely_save_hook,
  versely_list_saved_hooks,
  versely_unsave_hook,
  versely_list_music_beds,
  versely_quote_hooks,
  versely_reuse_hooks,
  versely_create_hook_pack,
  versely_create_character_hook_pack,
  versely_get_hook_collection,
  versely_list_hook_collections,
  versely_cancel_hook_collection,
  versely_schedule_hook_collection,
  versely_list_hook_characters,
  versely_create_hook_character,
  versely_upload_hook_character,
  versely_get_hook_character,
  versely_pick_character_portrait,
  versely_delete_hook_character,
  versely_get_social_analytics_overview,
  versely_get_post_analytics,
  versely_get_post_analytics_history,
];
