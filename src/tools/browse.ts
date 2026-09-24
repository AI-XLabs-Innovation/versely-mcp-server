// versely_browse: show the user a visual picker (ui/picker.ts) of things they
// choose from - slideshow styles, avatars, voices, AI / workflow / slideshow
// templates, their brands - instead of a list of ids in the chat. A pick comes
// back as the user's next message, worded so the model knows exactly what to
// pass where ("... (caption_style: pink-pop)").
//
// The model gets the ids too (content text), so a user who names an option
// instead of clicking still works, and hosts without MCP Apps still get a
// usable answer.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { metaForPicker } from "../ui/templates.js";
import { PICKER_META_KEY } from "../ui/picker.js";
import { loadVeedAvatars } from "./avatars.js";

interface PickItem {
  id: string;
  title: string;
  subtitle?: string;
  image?: string;
  images?: string[];
  video?: string;
  audio?: string;
  badge?: string;
  /** The message a pick sends, as the user. */
  pick: string;
}

interface CollectionDef {
  title: string;
  noun: string;
  /** Landscape previews (16:9) instead of portrait. */
  wide?: boolean;
  /** The backend already searched for q (in more than the title): no second filter here. */
  serverSearch?: boolean;
  load: (ctx: ToolContext, opts: { category?: string; q?: string }) => Promise<PickItem[]>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

function heygen(generation: "v3" | "v5"): CollectionDef {
  const label = generation.toUpperCase();
  return {
    title: `HeyGen Avatar ${label} avatars`,
    noun: "avatar",
    load: async (ctx) => {
      const res = await ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/avatar/heygen", { query: { model: generation } });
      return (res?.data ?? []).map((a) => ({
        id: String(a.avatar_id),
        title: String(a.name ?? a.avatar_id),
        subtitle: str(a.gender) && a.gender !== "unknown" ? String(a.gender) : undefined,
        image: str(a.preview_image_url),
        video: str(a.preview_video_url),
        pick: `Use the HeyGen Avatar ${label} avatar ${quote(String(a.name ?? a.avatar_id))} (avatar_id: ${String(a.avatar_id)}).`,
      }));
    },
  };
}

function heygenVoices(generation: "v3" | "v5"): CollectionDef {
  const label = generation.toUpperCase();
  return {
    title: `HeyGen Avatar ${label} voices`,
    noun: "voice",
    load: async (ctx) => {
      const res = await ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/avatar/heygen/voices", { query: { model: generation } });
      return (res?.data ?? []).map((v) => ({
        id: String(v.voice_id),
        title: String(v.name ?? v.voice_id),
        subtitle: [str(v.language), str(v.gender) && v.gender !== "unknown" ? String(v.gender) : undefined].filter(Boolean).join(" · ") || undefined,
        audio: str(v.preview_audio),
        pick: `Use the HeyGen Avatar ${label} voice ${quote(String(v.name ?? v.voice_id))} (voice_id: ${String(v.voice_id)}).`,
      }));
    },
  };
}

const compact = (n: unknown): string => {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return "";
  return v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(Math.round(v));
};

const COLLECTIONS: Record<string, CollectionDef> = {
  inspiration: {
    title: "Viral outliers",
    noun: "post",
    serverSearch: true,
    load: async (ctx, { category, q }) => {
      const res = await ctx.client.get<{ posts?: Array<Record<string, any>> }>("/api/v1/inspiration/posts", {
        query: { outliers: 1, sort: "outlier", limit: 60, ...(category ? { niche: category } : {}), ...(q ? { q } : {}) },
      });
      return (res?.posts ?? []).map((p) => {
        const hook = String(p.hook_text || p.caption || "Untitled").replace(/\s+/g, " ").trim();
        const score = Number(p.outlier_score);
        const x = Number.isFinite(score) && score > 0 ? (score >= 10 ? Math.round(score) : Math.round(score * 10) / 10) : null;
        const slides: string[] = Array.isArray(p.slide_image_urls) ? p.slide_image_urls.filter((u: unknown) => typeof u === "string") : [];
        return {
          id: String(p.id),
          title: hook.slice(0, 90),
          subtitle: [p.author_handle ? `@${String(p.author_handle).replace(/^@/, "")}` : "", p.plays != null ? `${compact(p.plays)} views` : "", p.content_type]
            .filter(Boolean).join(" · "),
          image: str(p.cover_url) ?? slides[0],
          images: slides.slice(0, 5),
          badge: x ? `${x}×` : undefined,
          pick: `Recreate this viral ${p.content_type === "slideshow" ? "slideshow" : "video"} for me: ${quote(hook.slice(0, 120))} (inspiration post_id: ${String(p.id)}).`,
        };
      });
    },
  },
  trending_sounds: {
    title: "Trending sounds",
    noun: "sound",
    load: async (ctx) => {
      const res = await ctx.client.get<{ sounds?: Array<Record<string, any>> }>("/api/v1/inspiration/sounds", { query: { limit: 50 } });
      return (res?.sounds ?? []).map((snd) => ({
        id: String(snd.id),
        title: String(snd.title ?? "Sound"),
        subtitle: [str(snd.author), `${Number(snd.outlier_uses) || 0} outlier posts`, snd.vibe?.mood ? String(snd.vibe.mood) : ""]
          .filter(Boolean).join(" · "),
        audio: str(snd.bed?.url),
        badge: snd.rank != null ? `#${snd.rank}` : undefined,
        pick: snd.bed?.url
          ? `Use the trending sound ${quote(String(snd.title))}: its royalty-free Versely version is ${String(snd.bed.url)} (sound_id: ${String(snd.id)}).`
          : `Use the trending sound ${quote(String(snd.title))} (sound_id: ${String(snd.id)}); it has no royalty-free version yet.`,
      }));
    },
  },
  slideshow_styles: {
    title: "Slideshow styles",
    noun: "style",
    load: async (ctx) => {
      const res = await ctx.client.get<{ data?: Array<Record<string, any>> }>("/api/v1/slideshow/caption-styles");
      return (res?.data ?? []).map((s) => {
        const slides: string[] = Array.isArray(s.example?.slides) ? s.example.slides.filter((u: unknown) => typeof u === "string") : [];
        return {
          id: String(s.id),
          title: String(s.label ?? s.id),
          subtitle: str(s.blurb),
          image: slides[0],
          images: slides.slice(0, 5),
          pick: `Use the ${quote(String(s.label ?? s.id))} slideshow style (caption_style: ${String(s.id)}).`,
        };
      });
    },
  },
  heygen_avatars_v5: heygen("v5"),
  heygen_avatars_v3: heygen("v3"),
  heygen_voices_v5: heygenVoices("v5"),
  heygen_voices_v3: heygenVoices("v3"),
  veed_avatars: {
    title: "Veed avatars",
    noun: "avatar",
    load: async (ctx) =>
      (await loadVeedAvatars(ctx)).map((a) => ({
        id: a.id,
        title: a.name,
        subtitle: a.orientation === "portrait" ? "9:16 portrait" : "16:9 landscape",
        video: a.preview_video_url,
        image: a.preview_image_url,
        pick: `Use the Veed avatar ${quote(a.name)} (avatar_id: ${a.id}).`,
      })),
  },
  avatar_x_avatars: {
    title: "Avatar X avatars",
    noun: "avatar",
    load: async (ctx) => {
      const res = await ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/avatar/avatar-x");
      return (res?.data ?? []).map((a) => ({
        id: String(a.value),
        title: String(a.name ?? a.value),
        subtitle: str(a.orientation),
        image: str(a.preview_image_url),
        video: str(a.preview_video_url),
        pick: `Use the Avatar X avatar ${quote(String(a.name ?? a.value))} (avatar_id: ${String(a.value)}).`,
      }));
    },
  },
  ai_templates: {
    title: "AI templates",
    noun: "template",
    load: async (ctx, { category }) => {
      const res = await ctx.client.get<{ data?: Array<Record<string, any>> }>("/api/v1/templates");
      return (res?.data ?? [])
        .filter((t) => !category || String(t.category ?? "").toLowerCase() === category.toLowerCase())
        .map((t) => {
          const needs = (Array.isArray(t.inputs) ? t.inputs : [])
            .filter((i: any) => i?.required && !i?.defaultUrl)
            .map((i: any) => `${i.label} (${i.field})`);
          return {
            id: String(t.id),
            title: String(t.name ?? t.id),
            subtitle: str(t.description),
            image: str(t.thumbnailUrl),
            video: str(t.previewVideoUrl),
            badge: typeof t.estimatedCreditCost === "number" ? `${t.estimatedCreditCost} credits` : undefined,
            pick:
              `Use the AI template ${quote(String(t.name ?? t.id))} (template_id: ${String(t.id)}).` +
              (needs.length ? ` It needs: ${needs.join(", ")}.` : ""),
          };
        });
    },
  },
  workflow_templates: {
    title: "Workflow templates",
    noun: "template",
    load: async (ctx, { category }) => {
      const res = await ctx.client.get<{ templates?: Array<Record<string, any>> }>("/api/v1/public-workflows", {
        query: { limit: 100, ...(category ? { category } : {}) },
      });
      return (res?.templates ?? []).map((t) => ({
        id: String(t.slug ?? t.id),
        title: String(t.title ?? t.slug),
        subtitle: str(t.description),
        image: str(t.thumbnail_url),
        video: str(t.preview_video_url),
        badge: typeof t.estimated_credit_cost === "number" ? `~${t.estimated_credit_cost} credits` : undefined,
        pick: `Use the workflow template ${quote(String(t.title ?? t.slug))} (template: ${String(t.slug ?? t.id)}).`,
      }));
    },
  },
  slideshow_templates: {
    title: "Slideshow templates",
    noun: "template",
    load: async (ctx, { category }) => {
      const res = await ctx.client.get<{ templates?: Array<Record<string, any>> }>("/api/v1/public-slideshows", {
        query: { limit: 100, ...(category ? { category } : {}) },
      });
      return (res?.templates ?? []).map((t) => ({
        id: String(t.slug ?? t.id),
        title: String(t.title ?? t.slug),
        subtitle: str(t.description),
        image: str(t.thumbnail_url),
        video: str(t.preview_video_url),
        badge: [
          typeof t.num_images === "number" ? `${t.num_images} slides` : undefined,
          typeof t.estimated_credit_cost === "number" ? `~${t.estimated_credit_cost} credits` : undefined,
        ].filter(Boolean).join(" · ") || undefined,
        pick: `Recreate the slideshow template ${quote(String(t.title ?? t.slug))} (template: ${String(t.slug ?? t.id)}).`,
      }));
    },
  },
  brands: {
    title: "Your brands",
    noun: "brand",
    load: async (ctx) => {
      const res = await ctx.client.get<{ brand_kits?: Array<Record<string, unknown>> }>("/api/v1/agentic/brand-kit");
      return (res?.brand_kits ?? []).map((b) => ({
        id: String(b.id),
        title: String(b.name ?? "Brand"),
        subtitle: str(b.tagline) ?? str(b.website_url),
        image: str(b.logo_url),
        badge: b.is_default ? "Default" : undefined,
        pick: `Use my brand ${quote(String(b.name ?? "brand"))} (brand_id: ${String(b.id)}).`,
      }));
    },
  },
};

export const BROWSE_COLLECTIONS = Object.keys(COLLECTIONS) as [string, ...string[]];

const USE_HINT: Record<string, string> = {
  slideshow_styles: "Pass the id as caption_style to the slideshow tools (or versely_apply_caption_style).",
  heygen_avatars_v5: "Pass it as avatar_id to versely_generate_lipsync with model 'HeyGen Avatar V5'.",
  heygen_avatars_v3: "Pass it as avatar_id to versely_generate_lipsync with model 'HeyGen Avatar V3'.",
  heygen_voices_v5: "Pass it as voice_id to versely_generate_lipsync with model 'HeyGen Avatar V5'.",
  heygen_voices_v3: "Pass it as voice_id to versely_generate_lipsync with model 'HeyGen Avatar V3'.",
  veed_avatars: "Pass it as avatar_id to versely_generate_lipsync with model 'Veed Avatars'.",
  avatar_x_avatars: "Pass it as avatar_id to versely_generate_lipsync with model 'Avatar X Text to Video'.",
  ai_templates: "Run it with versely_run_ai_template.",
  workflow_templates: "Copy it to the user's workflows with versely_use_workflow_template.",
  slideshow_templates: "Make it with versely_use_slideshow_template.",
  brands: "Pass it as brand_id / brand_kit_id to the brand tools.",
  inspiration: "Recreate it with versely_recreate_inspiration (post_id), or break it down with versely_analyze_post (its url).",
  trending_sounds: "Use the royalty-free bed URL as music (e.g. audio_url of versely_slideshow_to_video).",
};

const versely_browse = defineTool({
  name: "versely_browse",
  description:
    "Show the user a visual picker to choose from - with previews - instead of listing options in text: " +
    "inspiration (viral outlier posts; category = niche), trending_sounds (with playable royalty-free versions), " +
    "slideshow_styles (caption styles with example slides), heygen_avatars_v5 / heygen_avatars_v3, " +
    "heygen_voices_v5 / heygen_voices_v3, veed_avatars, avatar_x_avatars, ai_templates, workflow_templates, " +
    "slideshow_templates, brands. The user clicks 'Use this' and their choice arrives as their next message, with " +
    "the id to use. Don't repeat the options in your reply: tell the user to pick one above (or name it). " +
    "Use q to narrow a big collection (e.g. HeyGen avatars by name).",
  meta: metaForPicker(),
  inputSchema: z.object({
    collection: z.enum(BROWSE_COLLECTIONS).describe("What to show."),
    q: z.string().optional().describe("Only options whose name or description contains this."),
    category: z.string().optional().describe("inspiration: a niche slug (versely_list_inspiration_niches); templates: a category."),
    limit: z.number().int().min(1).max(60).optional().describe("How many to show (default 24)."),
    offset: z.number().int().min(0).optional().describe("Skip this many (the picker's Show more uses it)."),
  }),
  handler: async (input, ctx) => {
    const def = COLLECTIONS[input.collection]!;
    const all = await def.load(ctx, { category: input.category, q: input.q });
    const q = input.q?.trim().toLowerCase();
    const matched = q && !def.serverSearch
      ? all.filter((it) => `${it.title} ${it.subtitle ?? ""} ${it.id}`.toLowerCase().includes(q))
      : all;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 24;
    const items = matched.slice(offset, offset + limit);
    const more = offset + items.length < matched.length;
    const picker = {
      collection: input.collection,
      title: def.title,
      noun: def.noun,
      wide: def.wide === true,
      items,
      total: matched.length,
      offset,
      q: input.q ?? null,
      category: input.category ?? null,
      more,
    };
    const text =
      items.length === 0
        ? `No ${def.noun}s match${input.q ? ` "${input.q}"` : ""}.`
        : `Showing ${items.length} of ${matched.length} ${def.title.toLowerCase()} in a visual picker the user can see; ` +
          `they choose by clicking "Use this" and the choice arrives as their next message. Don't list these in your ` +
          `reply: ask them to pick one above, or to name one. ${USE_HINT[input.collection] ?? ""}` +
          (more ? ` More: call again with offset=${offset + items.length}.` : "") +
          `\nIds: ${items.map((it) => `${it.id} = ${it.title}`).join("; ")}`;
    const result: ToolResult = {
      content: [{ type: "text", text }],
      structuredContent: { picker },
      _meta: { [PICKER_META_KEY]: picker },
    };
    return result;
  },
});

export const browseTools: Tool[] = [versely_browse];
