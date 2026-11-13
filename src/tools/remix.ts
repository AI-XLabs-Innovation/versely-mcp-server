// Versely Remix: Swap ("put me in this video") and Copy the moves, plus the
// trend library they start from (backend /remix/*, web /remix, iPhone Swap).
//
//   versely_list_remix_trends   the trend library: trending clips by tab, and
//                               Versely's own ready-made moves
//   versely_prepare_remix_clip  a 4-15 s clip to remix, from a library trend, a
//                               ready-made move, a post link, or the user's own
//                               upload (POST /remix/sources/preview, then
//                               POST /remix/sources). Free.
//   versely_quote_swap          the exact credits (POST /remix/swap/quote). Free.
//   versely_swap_video          the paid step (POST /remix/swap): 1-4 versions
//                               on one hold; refused when the price moved
//   versely_get_swap            follows the versions (GET /status/:id each)
//
// A swap replaces people, outfits, products, places or the style in the clip
// with the user's photos or avatars and keeps the motion, camera, cuts, lip
// sync and sound. "Moves" puts one character into the clip's motion. The
// backend looks at the clip and the photos before any charge (nudity and
// sexual acts are refused for everyone) and refuses named real people in the
// text. The engines behind it are never named here.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { errorResult, extractMediaAssets, jsonResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";
import { VerselyApiError } from "../errors.js";
import { classifyStatus } from "./status.js";
import { loadTrialStatus } from "./user.js";

// ─── Shared pieces ───────────────────────────────────────────────────────────

export const REMIX_TABS = [
  "trending", "dance", "transitions", "couples", "money", "cars", "fashion", "sports", "pets", "ai-remixes", "versely",
] as const;

const RemixType = z
  .enum(["swap", "moves"])
  .default("swap")
  .describe(
    "'swap' (default): replace people, outfits, products, places or the style in the clip and keep everything else. " +
      "'moves': one character (the user's photo or avatar) performs the clip's motion.",
  );
const Resolution = z.enum(["480p", "720p", "1080p"]).default("720p").describe("Output resolution. Default 720p; 480p costs least.");
const Quality = z.enum(["lite", "plus"]).default("lite").describe("'lite' (default) or 'plus' (a second engine that costs more). Quote both when the user asks for the best result.");
const Versions = z.number().int().min(1).max(4).default(1).describe("How many versions to make (1-4). Each one is charged.");
const ClipId = z.string().min(8).describe("clip_id from versely_prepare_remix_clip.");

/** The API calls Copy the moves "motion" and the second quality "pro". */
const wireMode = (t: "swap" | "moves") => (t === "moves" ? "motion" : "swap");
const wireQuality = (q: "lite" | "plus") => (q === "plus" ? "pro" : "lite");
const typeLabel = (t: "swap" | "moves") => (t === "moves" ? "Copy the moves" : "Swap");
const credits = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;
const secs = (n: number) => `${Math.round(n * 10) / 10} s`;

const POLL = { interval_ms: 8000, timeout_ms: 30 * 60_000 };

/**
 * The backend's own sentence for a refusal (`{ code, message }` or
 * `{ error: { code, message } }`), written to be shown as is. Credit and
 * plugin-allowance refusals are left to the client's wording (rethrown).
 */
function refusal(err: unknown): ToolResult {
  if (!(err instanceof VerselyApiError) || err.code || err.status === 401 || err.status === 402) throw err;
  const body = (err.body ?? {}) as Record<string, unknown>;
  const nested = (body.error && typeof body.error === "object" ? body.error : {}) as Record<string, unknown>;
  const message =
    (typeof body.message === "string" && body.message) ||
    (typeof nested.message === "string" && nested.message) ||
    (typeof body.error === "string" && body.error) ||
    "";
  if (!message) throw err;
  const code = (typeof body.code === "string" && body.code) || (typeof nested.code === "string" && nested.code) || "";
  const hint =
    code === "not_your_upload"
      ? " Store the user's file with versely_upload_media first and pass the URL it returns."
      : code === "source_not_found"
        ? " Prepare the clip again with versely_prepare_remix_clip."
        : code === "too_long_trimmed" || code === "too_short" || code === "invalid_range"
          ? " A clip to remix is 4 to 15 seconds: pass start and end."
          : "";
  const charged = /nothing was charged/i.test(message) ? "" : " Nothing was charged.";
  return errorResult(`${message}${hint}${charged}`);
}

// ─── Trend library ───────────────────────────────────────────────────────────

interface LibraryItem {
  id?: string;
  kind?: "trend" | "versely";
  inspiration_id?: string;
  motion_id?: string;
  platform?: string;
  cover_url?: string;
  duration?: number;
  views?: number;
  author_handle?: string;
  caption?: string;
  category?: string;
  suggested_mode?: "swap" | "motion";
  people?: number;
}

interface LibraryPage {
  available?: boolean;
  modes?: { swap?: boolean; motion?: boolean };
  tabs?: Array<{ id: string; label: string; count?: number }>;
  tab?: string;
  items?: LibraryItem[];
  next_cursor?: string | null;
}

export function trendOf(it: LibraryItem): Record<string, unknown> {
  const own = it.kind === "versely";
  return {
    ...(own ? { move_id: it.motion_id } : { trend_id: it.inspiration_id }),
    title: (it.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 140) || (own ? "Versely move" : "Trending clip"),
    ...(it.author_handle ? { creator: `@${String(it.author_handle).replace(/^@/, "")}` } : {}),
    ...(it.platform ? { platform: it.platform } : {}),
    ...(typeof it.views === "number" ? { views: it.views } : {}),
    seconds: it.duration,
    ...(typeof it.people === "number" ? { people: it.people } : {}),
    category: it.category,
    suggested: it.suggested_mode === "motion" ? "moves" : "swap",
    cover_url: it.cover_url,
  };
}

const versely_list_remix_trends = defineTool({
  name: "versely_list_remix_trends",
  description:
    "The Versely Remix trend library: short trending clips people recreate with themselves in them, by tab " +
    "(trending, dance, transitions, couples, money, cars, fashion, sports, pets, ai-remixes), plus Versely's own " +
    "ready-made moves (tab 'versely'). FREE. Each item says whether it suits a swap or copying the moves and how " +
    "many people are in it. To SHOW them for the user to pick, prefer versely_browse (collection 'remix_trends', " +
    "category = the tab). Turn a pick into a clip with versely_prepare_remix_clip (trend_id or move_id).",
  inputSchema: z.object({
    tab: z.enum(REMIX_TABS).default("trending").describe("Which tab. 'versely' is Versely's own ready-made moves."),
    limit: z.number().int().min(1).max(30).default(12),
    cursor: z.string().optional().describe("next_cursor from the previous page."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<LibraryPage>("/api/v1/remix/library", {
      query: { tab: input.tab, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
    });
    if (res?.available === false) {
      return jsonResult({ available: false, items: [], note: "Remix isn't available right now. Try again later." });
    }
    return jsonResult({
      available: true,
      can_swap: res?.modes?.swap !== false,
      can_copy_moves: res?.modes?.motion !== false,
      tab: res?.tab ?? input.tab,
      tabs: (res?.tabs ?? []).map((t) => ({ tab: t.id, label: t.label, count: t.count ?? 0 })),
      items: (res?.items ?? []).map(trendOf),
      next_cursor: res?.next_cursor ?? null,
    });
  },
});

// ─── The clip ────────────────────────────────────────────────────────────────

interface PreviewView {
  preview_id?: string;
  duration?: number;
  suggested?: { start?: number; end?: number };
  min_window?: number;
  max_window?: number;
}

interface SourceView {
  source_id?: string;
  video_url?: string;
  poster_url?: string | null;
  duration?: number;
  width?: number;
  height?: number;
  has_audio?: boolean;
  original_duration?: number;
  start?: number;
  expires_at?: string;
}

const versely_prepare_remix_clip = defineTool({
  name: "versely_prepare_remix_clip",
  description:
    "Get a clip ready to remix: 4 to 15 seconds, cut with its sound. FREE. Give exactly one of: `trend_id` or " +
    "`move_id` (from versely_list_remix_trends or the versely_browse 'remix_trends' picker), `link` (a TikTok, " +
    "Instagram, YouTube or X post), or `video_url` (the user's own video stored in their Versely library: store an " +
    "attached file with versely_upload_media first). Without start/end the liveliest stretch (about 8 s) is used; " +
    "a shorter clip costs less. Returns a clip_id (kept 6 days) for versely_quote_swap and versely_swap_video. " +
    "For a link or their own video, the user must own the clip or have permission to use it.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    trend_id: z.string().optional().describe("A library trend's trend_id."),
    move_id: z.string().optional().describe("One of Versely's ready-made moves (move_id)."),
    link: z.string().url().optional().describe("A TikTok, Instagram, YouTube or X post link."),
    video_url: z.string().url().optional().describe("The user's own video in their Versely library (from versely_upload_media)."),
    start: z.number().min(0).optional().describe("Where the clip starts, in seconds into the video."),
    end: z.number().positive().optional().describe("Where it ends. The clip is 4 to 15 seconds long."),
  }),
  handler: async (input, ctx) => {
    const given = [input.trend_id, input.move_id, input.link, input.video_url].filter((v) => typeof v === "string" && v.trim());
    if (given.length !== 1) {
      return errorResult("Give exactly one of trend_id, move_id, link or video_url. Nothing was charged.");
    }
    if ((input.start === undefined) !== (input.end === undefined)) {
      return errorResult("Pass both start and end, or neither. Nothing was charged.");
    }
    if (input.start !== undefined && input.end !== undefined) {
      const len = input.end - input.start;
      if (len < 4 || len > 15) return errorResult("A clip to remix is 4 to 15 seconds long: adjust start and end. Nothing was charged.");
    }
    const from = input.trend_id
      ? { inspiration_id: input.trend_id.trim() }
      : input.move_id
        ? { motion_id: input.move_id.trim() }
        : input.link
          ? { link: input.link.trim() }
          : { video_url: input.video_url!.trim() };
    let source: SourceView;
    try {
      const preview = await ctx.client.post<PreviewView>("/api/v1/remix/sources/preview", from);
      if (!preview?.preview_id) return jsonResult(preview);
      const start = input.start ?? preview.suggested?.start ?? 0;
      const end = input.end ?? preview.suggested?.end ?? Math.min(preview.duration ?? 15, 15);
      source = await ctx.client.post<SourceView>("/api/v1/remix/sources", { preview_id: preview.preview_id, start, end });
    } catch (err) {
      return refusal(err);
    }
    if (!source?.source_id) return jsonResult(source);
    const seconds = source.duration ?? 0;
    const size = source.width && source.height ? `, ${source.width}x${source.height}` : "";
    const text =
      `Clip ready: ${secs(seconds)}${size}, ${source.has_audio === false ? "no sound" : "with its sound"}` +
      `${typeof source.start === "number" && source.start > 0 ? `, starting ${secs(source.start)} into the video` : ""}. ` +
      `clip_id: ${source.source_id} (kept until ${source.expires_at ?? "6 days from now"}). ` +
      `Nothing was charged. Next: ask what to replace and with which photo or avatar, then versely_quote_swap.`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        kind: "video",
        status: "completed",
        task_id: source.source_id,
        assets: source.video_url ? [{ url: source.video_url, label: "Clip to remix" }] : [],
        title: "Clip to remix",
        duration_seconds: seconds,
      },
    };
  },
});

// ─── Quote ───────────────────────────────────────────────────────────────────

interface SwapFit {
  resolution?: string;
  seconds?: number;
  credits?: number;
}

interface SwapQuote {
  credits?: number;
  per_variant?: number;
  seconds?: number;
  variants?: number;
  resolution?: string;
  quality?: string;
  fits?: SwapFit[];
  minimum?: SwapFit;
}

async function quote(
  ctx: ToolContext,
  args: { clip_id: string; type: "swap" | "moves"; resolution: string; quality: "lite" | "plus"; versions: number },
  balance?: number,
): Promise<SwapQuote> {
  return ctx.client.post<SwapQuote>("/api/v1/remix/swap/quote", {
    source_id: args.clip_id,
    mode: wireMode(args.type),
    resolution: args.resolution,
    quality: wireQuality(args.quality),
    variants: args.versions,
    ...(balance !== undefined ? { fit_credits: Math.max(0, Math.floor(balance)) } : {}),
  });
}

const tier = (resolution: string | undefined, quality: "lite" | "plus") => `${resolution ?? ""}${quality === "plus" ? ", Plus" : ""}`.trim();

const versely_quote_swap = defineTool({
  name: "versely_quote_swap",
  description:
    "The exact credits to remix a prepared clip, with the user's balance. FREE. The price depends on the clip's " +
    "length, the resolution, the quality and how many versions. Show it to the user before versely_swap_video and " +
    "pass it there as confirm_credits. When the balance is short, the answer lists what the balance does cover " +
    "(a lower resolution or a shorter clip): offer those; never suggest buying credits.",
  inputSchema: z.object({
    clip_id: ClipId,
    type: RemixType,
    resolution: Resolution,
    quality: Quality,
    versions: Versions,
  }),
  handler: async (input, ctx) => {
    let balance: number | undefined;
    try {
      const status = await loadTrialStatus(ctx);
      balance = status.freeAccount ? undefined : status.credits;
    } catch {
      /* the price stands without the balance */
    }
    let q: SwapQuote;
    try {
      q = await quote(ctx, input, balance);
    } catch (err) {
      return refusal(err);
    }
    if (typeof q?.credits !== "number") return jsonResult(q);
    const each = input.versions > 1 && typeof q.per_variant === "number" ? ` (${credits(q.per_variant)} each for ${input.versions} versions)` : "";
    const lines = [
      `${typeLabel(input.type)}: ${credits(q.credits)}${each} for ${secs(q.seconds ?? 0)} at ${tier(q.resolution ?? input.resolution, input.quality)}.` +
        (balance !== undefined ? ` Balance: ${credits(balance)}.` : ""),
    ];
    if (balance !== undefined && q.credits > balance) {
      const fits = (q.fits ?? []).filter((f) => typeof f.credits === "number" && typeof f.seconds === "number");
      lines.push(
        fits.length
          ? "The balance is short of that. It does cover: " +
              fits.map((f) => `${f.seconds} s at ${f.resolution} for ${credits(f.credits!)}`).join("; ") +
              ". For a shorter clip, prepare it again with a shorter start/end."
          : q.minimum && typeof q.minimum.credits === "number"
            ? `The balance is short of that, and of the smallest remix there is (${q.minimum.seconds} s at ${q.minimum.resolution}, ${credits(q.minimum.credits)}).`
            : "The balance is short of that.",
      );
    } else {
      lines.push(`Start it only after the user says yes: versely_swap_video with confirm_credits: ${q.credits}.`);
    }
    return { content: [{ type: "text", text: lines.join(" ") }] };
  },
});

// ─── Swap ────────────────────────────────────────────────────────────────────

const SwapItem = z.object({
  replaces: z
    .enum(["person", "outfit", "product", "place", "style", "other"])
    .describe("What this photo replaces in the clip. For 'moves': person (the character), and optionally place and style."),
  target: z
    .string()
    .max(120)
    .optional()
    .describe("Which one in the clip, as a name not an instruction: 'the woman on the left', 'his jacket', 'the cup'. Leave out when there is only one."),
  image_url: z.string().url().optional().describe("A photo of what goes in (https). For the user's own photo, store it with versely_upload_media first."),
  avatar_id: z.string().optional().describe("An avatar instead of a photo: one of the user's own (versely_list_hook_characters) or a ready-made one (versely_list_ready_made_avatars). People and outfits only."),
});

interface SwapStarted {
  job_ids?: string[];
  credits_held?: number;
  per_variant?: number;
  variants?: number;
  variants_failed?: number;
  credits_refunded?: number;
  resolution?: string;
  seconds?: number;
  duplicate?: boolean;
}

/** A finished job's videos: the status payload's own result list, else any video link in it. */
function resultVideos(data: Record<string, unknown> | null | undefined): string[] {
  const listed = Array.isArray(data?.result_urls) ? data!.result_urls : typeof data?.result_url === "string" ? [data.result_url] : [];
  const urls = listed.filter((u): u is string => typeof u === "string" && !!u.trim());
  return urls.length ? urls : extractMediaAssets(data).filter((a) => a.kind === "video").map((a) => a.url);
}

/** The card for a set of swap jobs: pending until every version settles. */
export async function swapCard(ctx: ToolContext, jobIds: string[]): Promise<ToolResult> {
  const states = await Promise.all(
    jobIds.map(async (id) => {
      try {
        const data = await ctx.client.get<Record<string, unknown>>(`/api/v1/status/${encodeURIComponent(id)}`);
        const state = classifyStatus(data);
        const urls = state === "completed" ? resultVideos(data) : [];
        const error = state === "failed" ? String(data?.error || data?.message || "This version could not be made.") : "";
        return { id, state: state === "completed" && urls.length === 0 ? ("pending" as const) : state, urls, error };
      } catch {
        // A status read that fails says nothing about the job: keep following it.
        return { id, state: "pending" as const, urls: [] as string[], error: "" };
      }
    }),
  );
  const done = states.filter((s) => s.state === "completed");
  const failed = states.filter((s) => s.state === "failed");
  const pending = states.length - done.length - failed.length;
  const assets = states.flatMap((s, i) =>
    s.state === "completed" && s.urls[0] ? [{ url: s.urls[0], label: states.length > 1 ? `Version ${i + 1}` : "Remixed video" }] : [],
  );
  const status = pending > 0 ? "pending" : assets.length ? "completed" : "failed";
  const failNote = failed.length
    ? ` ${failed.length} of ${states.length} could not be made (${failed[0]!.error}); the credits held for ${failed.length === 1 ? "it" : "them"} are returned.`
    : "";
  const text =
    status === "pending"
      ? `Remix in progress: ${done.length} of ${states.length} ready.${failNote} It usually takes a few minutes. The card updates by itself; ` +
        `otherwise call versely_get_swap with job_ids ${JSON.stringify(jobIds)} again in a minute. It is NOT finished yet; do not start it again.`
      : status === "completed"
        ? `Remix ready:\n${assets.map((a) => `${a.label}: ${a.url}`).join("\n")}${failNote}`
        : `The remix could not be made: ${failed[0]?.error ?? "unknown reason"}. The credits held for it are returned. Nothing else was charged.`;
  return {
    content: [{ type: "text", text }],
    ...(status === "failed" ? { isError: true } : {}),
    structuredContent: {
      kind: assets.length > 1 ? "gallery" : "video",
      status,
      task_id: jobIds[0],
      assets,
      title: "Versely Remix",
      ...(states.length > 1 ? { progress: (done.length + failed.length) / states.length } : {}),
      ...(status === "failed" ? { error: failed[0]?.error ?? "The remix could not be made." } : {}),
      ...(status === "pending" ? { poll: { tool_name: "versely_get_swap", args: { job_ids: jobIds }, ...POLL } } : {}),
    },
  };
}

const versely_swap_video = defineTool({
  name: "versely_swap_video",
  description:
    "Remix a prepared clip. PAID: spends the quoted credits once (a version that fails is refunded). " +
    "type 'swap' replaces what the `swaps` list names (a person, an outfit, a product, a place, the style) with the " +
    "photo or avatar given for each, and keeps the clip's motion, camera, cuts, lip sync and sound. type 'moves' " +
    "makes one character perform the clip's motion (swaps: one person, optionally a place and a style). " +
    "Before calling: (1) versely_prepare_remix_clip for the clip_id, (2) versely_quote_swap, (3) show the user the " +
    "price and ask them to confirm they own the clip or have permission to use it, and that anyone whose photo " +
    "goes in has agreed; only after their yes pass confirm_credits and rights_confirmed. If the price changed, " +
    "the call is refused with the new one. It cannot change what is said in the clip. Not allowed: nudity or " +
    "sexual content, and putting a celebrity's or other public figure's face in. Rendering takes a few minutes; " +
    "the card follows it, otherwise check versely_get_swap. Never start the same remix twice.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    clip_id: ClipId,
    type: RemixType,
    swaps: z.array(SwapItem).min(1).max(8).describe("What goes in: one entry per thing replaced (1-8). Each has exactly one of image_url or avatar_id."),
    note: z.string().max(500).optional().describe("Optional extra direction in the user's words, e.g. 'keep the logo on the shirt'."),
    resolution: Resolution,
    quality: Quality,
    versions: Versions,
    confirm_credits: z.number().positive().describe("The exact price the user approved (from versely_quote_swap). Must equal the current quote."),
    rights_confirmed: z
      .literal(true)
      .describe("true only after the user confirmed they own the clip or have permission to use it, and that anyone whose photo goes in has agreed."),
  }),
  handler: async (input, ctx) => {
    for (const [i, s] of input.swaps.entries()) {
      if (!!s.image_url === !!s.avatar_id) {
        return errorResult(`Swap ${i + 1} needs exactly one of image_url or avatar_id. Nothing was charged.`);
      }
    }
    // Never charge a price the user did not see.
    let q: SwapQuote;
    try {
      q = await quote(ctx, input);
    } catch (err) {
      return refusal(err);
    }
    if (typeof q?.credits === "number" && q.credits !== input.confirm_credits) {
      return errorResult(
        `The price is now ${credits(q.credits)} (${secs(q.seconds ?? 0)} at ${tier(q.resolution ?? input.resolution, input.quality)}), ` +
          `not ${credits(input.confirm_credits)}: nothing charged. Show the user the new price and, if they agree, call again with confirm_credits: ${q.credits}.`,
      );
    }
    let started: SwapStarted;
    try {
      started = await ctx.client.post<SwapStarted>("/api/v1/remix/swap", {
        source_id: input.clip_id,
        mode: wireMode(input.type),
        slots: input.swaps.map((s) => ({
          role: s.replaces,
          ...(s.target?.trim() ? { target: s.target.trim() } : {}),
          ...(s.image_url ? { image_url: s.image_url } : { avatar_id: s.avatar_id }),
        })),
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        resolution: input.resolution,
        quality: wireQuality(input.quality),
        variants: input.versions,
        keep_audio: true,
        rights_confirmed: true,
        batch_id: randomUUID(),
      });
    } catch (err) {
      return refusal(err);
    }
    const jobIds = (started?.job_ids ?? []).filter((id): id is string => typeof id === "string" && !!id);
    if (jobIds.length === 0) return jsonResult(started);
    const held = started.credits_held ?? input.confirm_credits;
    const notStarted =
      (started.variants_failed ?? 0) > 0
        ? ` ${started.variants_failed} version${started.variants_failed === 1 ? "" : "s"} could not start and ${credits(started.credits_refunded ?? 0)} came back.`
        : "";
    const text =
      `${typeLabel(input.type)} started: ${jobIds.length} version${jobIds.length === 1 ? "" : "s"}, ${credits(held)} held ` +
      `(returned for any version that fails).${notStarted} It takes a few minutes. The card updates by itself; otherwise ` +
      `check versely_get_swap with job_ids ${JSON.stringify(jobIds)} in a minute or two. It is NOT finished yet; do not start it again.`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        kind: jobIds.length > 1 ? "gallery" : "video",
        status: "pending",
        task_id: jobIds[0],
        assets: [],
        title: "Versely Remix",
        poll: { tool_name: "versely_get_swap", args: { job_ids: jobIds }, ...POLL },
      },
    };
  },
});

const versely_get_swap = defineTool({
  name: "versely_get_swap",
  description:
    "Follow a remix started with versely_swap_video: how many versions are ready, the finished videos, and any that " +
    "failed (their credits are returned automatically). FREE. On hosts that show the card it updates by itself, so " +
    "call this only when you need the video links, and at most about once a minute.",
  // The card polls this tool, so it must be open to the app as well as the model.
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({
    job_ids: z.array(z.string().min(4)).min(1).max(4).describe("The job_ids versely_swap_video returned."),
  }),
  handler: async (input, ctx) => swapCard(ctx, input.job_ids),
});

export const remixTools: Tool[] = [
  versely_list_remix_trends,
  versely_prepare_remix_clip,
  versely_quote_swap,
  versely_swap_video,
  versely_get_swap,
];
