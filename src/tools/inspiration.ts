// Inspiration: Versely's library of viral TikTok / Instagram posts, with the
// OUTLIERS flagged (posts that got far more views than the account has
// followers - "65x" - the ones worth copying), the trending sounds behind them
// (each with a royalty-free Versely music bed), and what to do with a post:
// recreate it (a slideshow post as a captioned slideshow, a video post as quick
// hook videos), break down why it worked (trend analysis), or import its video.
//
// Backend: /inspiration/* (public, free), /trend-analysis/* (1 credit),
// /trending-feed/* (search + post info free, import 1 credit), /hooks/quick*.
// Web: versely-web /inspiration (lib/inspiration.ts builds the same recreate
// prompts used here).

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { metaForMediaCard } from "../ui/templates.js";
import { STUDIO_TEXT_STYLE, startedSlideshowResult } from "./slideshow.js";
import { brandContextBlock } from "./brands.js";

type Post = Record<string, any>;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const line = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** "65×" - views over followers, the web's outlier chip. */
function outlierLabel(p: Post): string | null {
  const n = num(p.outlier_score);
  if (p.is_outlier !== true || n == null || n <= 0) return null;
  const r = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${r}×`;
}

function slideLines(p: Post): string[] {
  return Array.isArray(p.slide_texts) ? p.slide_texts.map(line).filter(Boolean) : [];
}

/** A library post in the fields that matter to a person choosing one. */
export function postSummary(p: Post): Record<string, unknown> {
  const slides = slideLines(p);
  return {
    id: p.id,
    type: p.content_type,
    platform: p.platform,
    url: p.url,
    author: p.author_handle ? `@${String(p.author_handle).replace(/^@/, "")}` : p.author_name,
    followers: num(p.author_followers),
    plays: num(p.plays),
    likes: num(p.likes),
    shares: num(p.shares),
    saves: num(p.saves),
    ...(outlierLabel(p) ? { outlier: `${outlierLabel(p)} more views than followers` } : {}),
    niche: p.niche,
    medium: p.product_medium,
    hook: line(p.hook_text) || undefined,
    ...(slides.length ? { slides } : {}),
    caption: line(p.caption).slice(0, 300) || undefined,
    music: line(p.music_title) || undefined,
    cover_url: p.cover_url,
    posted_at: p.posted_at,
  };
}

/** The slideshow studio's idea for a slideshow post (web slideshowIdea). */
function slideshowIdea(p: Post): string {
  const hook = line(p.hook_text);
  const caption = line(p.caption);
  const slides = slideLines(p);
  const blocks: string[] = [];
  if (hook) blocks.push(hook);
  if (slides.length) blocks.push(slides.map((t, i) => `${i + 1}. ${t}`).join("\n"));
  if (caption && caption !== hook) blocks.push(caption);
  return (blocks.join("\n\n").trim() || "Recreate this TikTok slideshow.").slice(0, 1500);
}

/** The hooks studio's brief for a video post (web hooksBrief), within the 3-500 limit. */
function hooksBrief(p: Post): string {
  const hook = line(p.hook_text);
  const caption = line(p.caption);
  const text = [hook, caption && caption !== hook ? caption : ""].filter(Boolean).join(". ");
  return (text ? `${text}. Recreate this as an original hook.` : "Recreate this TikTok as an original hook.").slice(0, 500);
}

async function loadPost(ctx: ToolContext, id: string): Promise<Post> {
  const res = await ctx.client.get<{ post?: Post }>(`/api/v1/inspiration/posts/${encodeURIComponent(id)}`);
  if (!res?.post) throw new Error(`Inspiration post ${id} was not found.`);
  return res.post;
}

// --- Library -----------------------------------------------------------------------

const versely_list_inspiration_niches = defineTool({
  name: "versely_list_inspiration_niches",
  description:
    "The niches in Versely's inspiration library of viral TikTok / Instagram posts, with how many posts and how many " +
    "outliers each has, and the product types (mediums) posts are tagged with. Free.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => jsonResult(await ctx.client.get("/api/v1/inspiration/niches")),
});

const versely_find_inspiration = defineTool({
  name: "versely_find_inspiration",
  description:
    "Find viral posts to learn from or copy in Versely's inspiration library. Outliers are posts that got far more " +
    "views than the account has followers (e.g. '65× more views than followers') - the proven ideas. Filter by niche, " +
    "type (slideshow or video), product medium, small creators, or words. To SHOW posts to the user, prefer " +
    "versely_browse with collection 'inspiration' (a visual grid). Recreate one with versely_recreate_inspiration. Free.",
  inputSchema: z.object({
    niche: z.string().optional().describe("A niche slug from versely_list_inspiration_niches (e.g. 'fitness')."),
    type: z.enum(["slideshow", "video"]).optional(),
    outliers_only: z.boolean().optional().describe("Only outliers (default true)."),
    sort: z.enum(["outlier", "views", "recent"]).optional().describe("Default 'outlier' (biggest outliers first)."),
    small_creators: z.boolean().optional().describe("Only accounts under 100K followers."),
    medium: z.string().optional().describe("Product medium, e.g. mobile_app, saas, ecommerce, creator_brand."),
    platform: z.enum(["tiktok", "instagram", "all"]).optional().describe("Default tiktok."),
    q: z.string().max(200).optional().describe("Words in the hook, caption or slides."),
    limit: z.number().int().min(1).max(30).optional().describe("Default 12."),
    cursor: z.string().optional().describe("next_cursor from a previous call, for the next page."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<{ posts?: Post[]; next_cursor?: string | null; total?: number }>("/api/v1/inspiration/posts", {
      query: {
        niche: input.niche,
        type: input.type,
        outliers: input.outliers_only === false ? undefined : 1,
        sort: input.sort,
        small: input.small_creators ? 1 : undefined,
        medium: input.medium,
        platform: input.platform,
        q: input.q,
        limit: input.limit ?? 12,
        cursor: input.cursor,
      },
    });
    return jsonResult({
      total: res?.total ?? null,
      posts: (res?.posts ?? []).map(postSummary),
      next_cursor: res?.next_cursor ?? null,
    });
  },
});

const versely_get_inspiration_post = defineTool({
  name: "versely_get_inspiration_post",
  description: "Everything about one inspiration post: stats, outlier score, hook, every slide's text, caption, sound, cover and slide images.",
  inputSchema: z.object({ post_id: z.string() }),
  handler: async (input, ctx) => {
    const p = await loadPost(ctx, input.post_id);
    return jsonResult({ ...postSummary(p), slide_image_urls: p.slide_image_urls, video_duration_s: num(p.video_duration_s) });
  },
});

const versely_list_trending_sounds = defineTool({
  name: "versely_list_trending_sounds",
  description:
    "The sounds behind the outliers right now, ranked: how many outlier posts use each, total views, niches, sample " +
    "hooks, the vibe (genre, mood, energy, BPM), and a royalty-free Versely music bed made to match (`bed.url`), which " +
    "is safe to use under slideshows and videos. To SHOW them with playable previews, use versely_browse with " +
    "collection 'trending_sounds'. Free.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional().describe("Default 20.") }),
  handler: async (input, ctx) => jsonResult(await ctx.client.get("/api/v1/inspiration/sounds", { query: { limit: input.limit ?? 20 } })),
});

// --- Recreate ----------------------------------------------------------------------

const HOOKS_POLL = { interval_ms: 6000, timeout_ms: 20 * 60_000 };

/** Quick-hook batch as media-card state: pending until every hook is done, then the finished videos. */
function hooksCard(payload: unknown, batchId: string): ToolResult {
  const hooks: Array<Record<string, any>> = ((payload as any)?.data?.hooks ?? []) as any[];
  const done = hooks.filter((h) => h.status === "completed" && h.video_url);
  const failed = hooks.filter((h) => h.status === "failed");
  const pending = hooks.length === 0 || hooks.some((h) => h.status !== "completed" && h.status !== "failed");
  const status = pending ? "pending" : done.length ? "completed" : "failed";
  const assets = done.map((h, i) => ({ url: String(h.video_url), label: h.hook_line ? String(h.hook_line) : `Hook ${i + 1}` }));
  const text = pending
    ? `Hook batch ${batchId}: ${done.length} of ${hooks.length || "?"} ready. If an inline preview is shown it updates on its ` +
      `own; otherwise call versely_get_hooks with batch_id="${batchId}". Do not call it finished before it says so.`
    : status === "failed"
      ? `Hook batch ${batchId} failed: ${failed.map((h) => h.error).filter(Boolean).join("; ") || "no hook could be made"} (credits refunded).`
      : `Hook batch ${batchId} is ready:\n` + assets.map((a, i) => `${i + 1}. ${a.label}: ${a.url}`).join("\n") +
        (failed.length ? `\n${failed.length} could not be made and were refunded.` : "");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      kind: assets.length > 1 ? "gallery" : "video",
      status,
      task_id: batchId,
      assets,
      ...(hooks.length ? { progress: done.length / hooks.length } : {}),
      ...(status === "failed" ? { error: "No hook could be made; the credits are refunded." } : {}),
      ...(pending ? { poll: { tool_name: "versely_get_hooks", args: { batch_id: batchId }, ...HOOKS_POLL } } : {}),
    },
  };
}

const HookRequest = {
  count: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional().describe("How many hook videos (1, 2 or 4; default 1)."),
  vibe: z.enum(["cafe", "morning", "kitchen", "outdoor", "selfie"]).optional().describe("The setting the presenter is in."),
  hook_line: z.string().max(90).optional().describe("Your own hook line to burn on (else one is written)."),
  face: z.enum(["random", "character"]).optional().describe("A random presenter (default) or one of the user's characters."),
  character_id: z.string().optional().describe("With face 'character': the character's id."),
  video_model: z.string().optional().describe("Default 'VEO 3.1 Fast' (see versely_list_hook_models)."),
  duration: z.number().int().optional().describe("Seconds; the model decides the allowed values (versely_list_hook_models)."),
  captions: z.boolean().optional().describe("Burn the hook line on (default true)."),
};

async function startHooks(ctx: ToolContext, body: Record<string, unknown>, toolName: string, toolArgs: Record<string, unknown>): Promise<ToolResult> {
  const res = await ctx.client.post<{ data?: { batch_id?: string } }>("/api/v1/hooks/quick", body);
  const batchId = res?.data?.batch_id;
  if (typeof batchId !== "string" || !batchId) return jsonResult(res);
  const card = hooksCard(res, batchId);
  return { ...card, structuredContent: { ...card.structuredContent, toolName, toolArgs } };
}

const versely_create_hooks = defineTool({
  name: "versely_create_hooks",
  description:
    "Make short hook videos (the scroll-stopping first seconds of a TikTok / Reel): a presenter in a setting, with the " +
    "hook line burned on. Give a brief (what the product or post is about). Spends the user's Versely credits (per " +
    "hook, by model and length); the inline card fills in as the videos land.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    brief: z.string().min(3).max(500).describe("What the hooks are for: the product, offer or idea (3-500 characters)."),
    ...HookRequest,
  }),
  handler: async (input, ctx) => startHooks(ctx, { ...input }, "versely_create_hooks", input),
});

const versely_get_hooks = defineTool({
  name: "versely_get_hooks",
  description: "Check a batch of hook videos from versely_create_hooks / versely_recreate_inspiration: which are ready, with their videos.",
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({ batch_id: z.string() }),
  handler: async (input, ctx) => hooksCard(await ctx.client.get(`/api/v1/hooks/quick/${encodeURIComponent(input.batch_id)}`), input.batch_id),
});

const versely_list_hook_models = defineTool({
  name: "versely_list_hook_models",
  description: "The video models hook videos can use, with their allowed durations and prices, and the settings (vibes).",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => jsonResult(await ctx.client.get("/api/v1/hooks/quick/models")),
});

const versely_recreate_inspiration = defineTool({
  name: "versely_recreate_inspiration",
  description:
    "Recreate an inspiration post as the user's own content, like the web's Recreate button: a SLIDESHOW post becomes " +
    "a captioned slideshow with the same hook and slide structure (optionally for one of the user's brands), a VIDEO " +
    "post becomes quick hook videos from its hook. Spends the user's Versely credits; the inline card fills in.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    post_id: z.string().describe("The inspiration post's id (versely_find_inspiration / versely_browse inspiration)."),
    brand_id: z.string().optional().describe("Make it for one of the user's brands (versely_list_brands)."),
    twist: z.string().max(300).optional().describe("How the user's version differs, e.g. 'for busy parents'."),
    num_images: z.number().int().min(1).max(20).optional().describe("Slideshow posts: slides (default: the post's own count)."),
    caption_style: z.string().optional().describe("Slideshow posts: a slideshow style id (versely_browse slideshow_styles)."),
    model: z.string().optional().describe("Slideshow posts: image model (default 'Flux Pro Ultra')."),
    ...HookRequest,
  }),
  handler: async (input, ctx) => {
    const post = await loadPost(ctx, input.post_id);
    let brandContext: string | undefined;
    if (input.brand_id) {
      const kits = await ctx.client.get<{ brand_kits?: Array<Record<string, any>> }>("/api/v1/agentic/brand-kit", { query: { brand_id: input.brand_id } });
      const kit = (kits?.brand_kits ?? []).find((k) => k?.id === input.brand_id);
      if (!kit) throw new Error(`Brand ${input.brand_id} is not one of the user's brands.`);
      brandContext = brandContextBlock(kit);
    }
    const twist = input.twist ? `\n\nMake it: ${input.twist}` : "";

    if (post.content_type === "slideshow") {
      const slides = slideLines(post).length;
      const body: Record<string, unknown> = {
        prompt: slideshowIdea(post) + twist,
        num_images: input.num_images ?? Math.min(20, Math.max(1, slides || 5)),
        content_type: "reel",
        model: input.model ?? "Flux Pro Ultra",
        bake_overlays: true,
        ...(input.caption_style ? { caption_style: input.caption_style } : { text_style: STUDIO_TEXT_STYLE }),
        ...(brandContext ? { brand_context: brandContext } : {}),
      };
      const started = await ctx.client.post("/api/v1/slideshow/create-automated", body, { timeoutMs: SYNC_TIMEOUT_MS });
      return startedSlideshowResult(ctx, started, { toolName: "versely_recreate_inspiration", toolArgs: input });
    }

    const brief = (hooksBrief(post) + (input.twist ? ` Make it ${input.twist}.` : "") +
      (brandContext ? ` For this brand: ${brandContext.replace(/\s+/g, " ")}` : "")).slice(0, 500);
    const { post_id, brand_id, twist: _t, num_images, caption_style, model, ...hook } = input;
    return startHooks(ctx, { brief, ...hook }, "versely_recreate_inspiration", input);
  },
});

// --- Why it worked: trend analysis -------------------------------------------------

const ANALYSIS_WAIT_MS = 45_000;

async function readAnalysis(ctx: ToolContext, id: string): Promise<Record<string, any>> {
  return ctx.client.get<Record<string, any>>(`/api/v1/trend-analysis/${encodeURIComponent(id)}`);
}

function analysisResult(a: Record<string, any>, id: string): ToolResult {
  const status = String(a?.status ?? "");
  if (status === "completed") {
    return jsonResult({
      analysis_id: id,
      status,
      platform: a.platform,
      url: a.originalUrl,
      title: a.title,
      author: a.author,
      stats: a.stats,
      analysis: a.analysis,
    });
  }
  if (status === "failed") return jsonResult({ analysis_id: id, status, error: a.error ?? "The analysis failed; the credit is refunded." });
  return jsonResult({
    analysis_id: id,
    status: status || "working",
    note: `Still working. Call versely_get_post_analysis with analysis_id="${id}" in about 30 seconds.`,
  });
}

const versely_analyze_post = defineTool({
  name: "versely_analyze_post",
  description:
    "Break down why a social video or post worked - its hook, the scene-by-scene timeline, audio, editing, visual style " +
    "and what keeps people watching - from its link (TikTok, Instagram, YouTube, X, Facebook, LinkedIn). Costs 1 Versely " +
    "credit. Waits up to about 45 seconds for the result; if it isn't done, check with versely_get_post_analysis.",
  inputSchema: z.object({ url: z.string().url().describe("The post's link.") }),
  handler: async (input, ctx) => {
    const started = await ctx.client.post<{ id?: string }>("/api/v1/trend-analysis/analyze", { url: input.url });
    const id = started?.id;
    if (typeof id !== "string" || !id) return jsonResult(started);
    const deadline = Date.now() + ANALYSIS_WAIT_MS;
    let last: Record<string, any> = { status: "scraping" };
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        last = await readAnalysis(ctx, id);
      } catch {
        /* keep waiting */
      }
      if (last?.status === "completed" || last?.status === "failed") break;
    }
    return analysisResult(last, id);
  },
});

const versely_get_post_analysis = defineTool({
  name: "versely_get_post_analysis",
  description: "Read a post breakdown started with versely_analyze_post (or an earlier one from versely_list_post_analyses).",
  inputSchema: z.object({ analysis_id: z.string() }),
  handler: async (input, ctx) => analysisResult(await readAnalysis(ctx, input.analysis_id), input.analysis_id),
});

const versely_list_post_analyses = defineTool({
  name: "versely_list_post_analyses",
  description: "The user's earlier post breakdowns, newest first.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (input, ctx) => jsonResult(await ctx.client.get("/api/v1/trend-analysis/history", { query: { limit: input.limit, offset: input.offset } })),
});

// --- Search + import -----------------------------------------------------------------

const versely_search_social_posts = defineTool({
  name: "versely_search_social_posts",
  description:
    "Search live social posts: TikTok, YouTube or Instagram Reels by keyword, TikTok by hashtag, or TikTok songs. " +
    "Good for finding current examples beyond the curated inspiration library. Free.",
  inputSchema: z.object({
    platform: z.enum(["tiktok", "youtube", "instagram", "hashtags", "songs"]),
    query: z.string().min(1).max(200),
  }),
  handler: async (input, ctx) =>
    jsonResult(await ctx.client.get("/api/v1/trending-feed/search", { query: { platform: input.platform, query: input.query } })),
});

const versely_get_social_post_info = defineTool({
  name: "versely_get_social_post_info",
  description: "Read a public social post from its link: author, caption, stats, cover, media. Free.",
  inputSchema: z.object({ url: z.string().url() }),
  handler: async (input, ctx) => jsonResult(await ctx.client.get("/api/v1/trending-feed/post-info", { query: { url: input.url } })),
});

const versely_import_social_video = defineTool({
  name: "versely_import_social_video",
  description:
    "Bring a public social post's video (TikTok, Instagram, YouTube, X...) into the user's Versely video library, to " +
    "caption, dub, overlay or remix. Only for videos the user has the right to reuse. Costs 1 Versely credit.",
  meta: metaForMediaCard(),
  inputSchema: z.object({ url: z.string().url().describe("The post's link.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<{ video?: Record<string, any> }>("/api/v1/trending-feed/import", { url: input.url }, { timeoutMs: SYNC_TIMEOUT_MS });
    const v = res?.video;
    if (!v?.url) return jsonResult(res);
    return mediaResult(
      { video_url: v.url },
      {
        kind: "video",
        toolName: "versely_import_social_video",
        toolArgs: input,
        extra: { status: "completed", title: v.title, prompt: v.title },
      },
    );
  },
});

export const inspirationTools: Tool[] = [
  versely_list_inspiration_niches,
  versely_find_inspiration,
  versely_get_inspiration_post,
  versely_list_trending_sounds,
  versely_recreate_inspiration,
  versely_create_hooks,
  versely_get_hooks,
  versely_list_hook_models,
  versely_analyze_post,
  versely_get_post_analysis,
  versely_list_post_analyses,
  versely_search_social_posts,
  versely_get_social_post_info,
  versely_import_social_video,
];
