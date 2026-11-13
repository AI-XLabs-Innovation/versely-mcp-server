// Captions studio (backend services/styledCaptions, web /captions): the
// current way to caption a talking video. The speech is transcribed and the
// words are burned in, word-timed, in one of two kinds of look:
//
//   free looks     Versely's own animated looks, rendered on Versely's servers.
//                  No credits at any length (a daily render cap applies).
//   premium looks  rendered elsewhere and charged up front per STARTED minute
//                  of video (at least one), from credits_per_minute in
//                  GET /captions/styles; refunded if the render fails.
//
//   GET  /captions/styles           both catalogues, the premium ones priced now
//   POST /captions/transcribe       video -> words + measured length (free; used
//                                   here only to price a premium look)
//   POST /captions/styled           start a render: 202 { job_id, credits_charged, duration_sec }
//   GET  /captions/styled/:jobId    the job: status, progress, video_url / error
//
// There is no quote endpoint and the render takes no confirm price, so the
// premium price is worked out here exactly as the service charges it:
// credits_per_minute x max(1, ceil(seconds / 60)), with the seconds measured by
// the backend's own probe (the transcribe call downloads and measures the file
// the same way the render does). A premium call without confirm_credits only
// quotes; one whose confirm_credits differs from the price is refused.
//
// The backend's premium ids are "veed-<preset>": the vendor's name. This module
// shows them as "premium-<preset>" and translates both ways, and never passes
// the premium thumbnails (their file names carry it too).

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { VerselyApiError } from "../errors.js";
import { metaForMediaCard } from "../ui/templates.js";

// --- Backend shapes ------------------------------------------------------------

interface FreeLook {
  id: string;
  name?: string;
  summary?: string;
  /** calm | boxed | loud */
  group?: string;
  backdrop?: boolean;
  /** Needs the person cut out: refused (422) until that ships. */
  needsMatte?: boolean;
  accent?: string;
}

interface PremiumLook {
  /** "veed-<preset>" */
  id: string;
  preset: string;
  name?: string;
  tier?: "dynamic" | "basic";
  credits_per_minute?: number;
  thumb_url?: string;
  sample_url?: string;
}

interface StylesResponse {
  styles?: FreeLook[];
  premium?: PremiumLook[];
}

type JobStatus = "queued" | "transcribing" | "rendering" | "done" | "failed";

interface CaptionJob {
  job_id: string;
  status: JobStatus | string;
  progress?: number;
  video_url?: string;
  thumbnail_url?: string;
  error?: string;
  error_code?: string;
  credits_charged?: number;
  refunded?: boolean;
  style?: string;
  duration_sec?: number;
  created_at?: string;
}

/** The backend answers `{ success, ...fields }`; tolerate a `data` wrapper too. */
function body<T>(res: unknown): T {
  const r = (res ?? {}) as Record<string, unknown>;
  const inner = r.data;
  return (inner && typeof inner === "object" && !Array.isArray(inner) ? inner : r) as T;
}

// --- Look ids --------------------------------------------------------------------

const BACKEND_PREMIUM_PREFIX = "veed-";
const PUBLIC_PREMIUM_PREFIX = "premium-";

/** The preset behind a premium look id ("premium-glass", or the backend's own form), else null. */
function premiumPresetOf(look: string): string | null {
  const m = /^(?:premium|veed)-([a-z0-9]+)$/i.exec(look.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** The id this server shows for a backend style id. */
function publicLookId(style: string | undefined): string {
  const s = String(style ?? "");
  return s.startsWith(BACKEND_PREMIUM_PREFIX) ? PUBLIC_PREMIUM_PREFIX + s.slice(BACKEND_PREMIUM_PREFIX.length) : s;
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "Glass (premium)" for a premium id, the id itself for a free look. */
function lookLabel(style: string | undefined): string {
  const preset = style ? premiumPresetOf(style) : null;
  return preset ? `${cap(preset)} (premium)` : String(style ?? "caption look");
}

// --- Price --------------------------------------------------------------------------

/**
 * Started minutes, at least one: the service bills ceil(seconds / 60) on the
 * unrounded length, and the transcribe answer rounds to the millisecond, so a
 * length sitting exactly on a minute is counted up (never quote under the charge).
 */
export function billedMinutes(seconds: number): number {
  return Math.max(1, Math.ceil((seconds + 0.001) / 60));
}

/** "1 min 05 s", "42 s" */
function formatLength(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "unknown length";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}

function credits(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}

/**
 * Measured lengths by video URL, so the confirming call does not download and
 * transcribe the file a second time (ChatGPT cuts a call at ~60 s). A miss
 * (another process, expired) simply measures again.
 */
const MEASURE_TTL_MS = 60 * 60_000;
const MEASURE_MAX = 500;
const measured = new Map<string, { at: number; seconds: number; noSpeech: boolean }>();

async function measureVideo(ctx: ToolContext, videoUrl: string, language?: string): Promise<{ seconds: number; noSpeech: boolean }> {
  const key = videoUrl.trim();
  const hit = measured.get(key);
  if (hit && Date.now() - hit.at < MEASURE_TTL_MS) return hit;
  const res = body<{ duration?: number; no_speech?: boolean; words?: unknown[] }>(
    await ctx.client.post(
      "/api/v1/captions/transcribe",
      { video_url: key, ...(language ? { language } : {}) },
      { timeoutMs: SYNC_TIMEOUT_MS },
    ),
  );
  if (typeof res.duration !== "number" || !(res.duration > 0)) {
    throw new Error("Could not measure the video's length to price the premium look. Nothing was charged.");
  }
  const entry = {
    at: Date.now(),
    seconds: res.duration,
    noSpeech: res.no_speech === true || (Array.isArray(res.words) && res.words.length === 0),
  };
  measured.delete(key);
  measured.set(key, entry);
  while (measured.size > MEASURE_MAX) {
    const oldest = measured.keys().next().value;
    if (oldest === undefined) break;
    measured.delete(oldest);
  }
  return entry;
}

interface PremiumQuote {
  preset: string;
  name: string;
  perMinute: number;
  minutes: number;
  credits: number;
  seconds: number;
  noSpeech: boolean;
}

/** The price of one premium look on one video, as the service will charge it, or a refusal. */
async function quotePremium(
  ctx: ToolContext,
  preset: string,
  videoUrl: string,
  language: string | undefined,
): Promise<PremiumQuote | ToolResult> {
  const styles = body<StylesResponse>(await ctx.client.get("/api/v1/captions/styles"));
  const entry = (styles.premium ?? []).find((p) => p.preset === preset || p.id === BACKEND_PREMIUM_PREFIX + preset);
  if (!entry || typeof entry.credits_per_minute !== "number") {
    return errorResult(
      `"${PUBLIC_PREMIUM_PREFIX}${preset}" is not a premium look. Nothing was charged. ` +
        `See the looks with versely_list_caption_looks.`,
    );
  }
  const m = await orRefusal(() => measureVideo(ctx, videoUrl, language));
  if (isToolResult(m)) return m;
  const minutes = billedMinutes(m.seconds);
  return {
    preset,
    name: entry.name || cap(preset),
    perMinute: entry.credits_per_minute,
    minutes,
    credits: entry.credits_per_minute * minutes,
    seconds: m.seconds,
    noSpeech: m.noSpeech,
  };
}

function priceLine(q: PremiumQuote): string {
  return `${credits(q.credits)} (${q.minutes} started minute${q.minutes === 1 ? "" : "s"} x ${q.perMinute})`;
}

/**
 * The service's own refusals of the input (400 bad file or look, 422 a look
 * that is not available yet, 429 the daily cap) carry a sentence fit for the
 * user in `error`; nothing was started or charged. 402 and the plugin
 * refusals are left to the client's wording.
 */
async function orRefusal<T>(call: () => Promise<T>): Promise<T | ToolResult> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof VerselyApiError && [400, 422, 429].includes(err.status)) {
      const said = (err.body as { error?: unknown } | null)?.error;
      if (typeof said === "string" && said.trim()) {
        const text = said.trim().replace(/\(?see GET \/captions\/styles\)?/g, "(see versely_list_caption_looks)");
        return errorResult(`Not started, nothing charged: ${/[.!?)]$/.test(text) ? text : `${text}.`}`);
      }
    }
    throw err;
  }
}

function isToolResult(v: unknown): v is ToolResult {
  return !!v && typeof v === "object" && Array.isArray((v as ToolResult).content);
}

const NO_SPEECH_NOTE =
  " Note: no speech was heard in this video, so there may be no words to caption; check with the user before paying.";

/**
 * A failed premium render's error can carry the renderer's own reason; keep
 * the service names behind premium looks out of what the user is shown.
 */
function scrub(text: string | undefined): string | undefined {
  return text?.replace(/\b(veed|fal(\.ai)?)\b/gi, "the renderer");
}

// --- Card -----------------------------------------------------------------------------

const JOB_POLL = { interval_ms: 8_000, timeout_ms: 45 * 60_000 };
const IN_FLIGHT = new Set(["queued", "transcribing", "rendering"]);

function jobCard(job: CaptionJob, echo: Record<string, unknown> = {}): Record<string, unknown> {
  const label = lookLabel(job.style);
  if (job.status === "done" && job.video_url) {
    return {
      kind: "video",
      assets: [{ url: job.video_url, label: `Captioned video · ${label}` }],
      status: "completed",
      task_id: job.job_id,
      ...echo,
    };
  }
  if (job.status === "failed" || job.status === "done") {
    return {
      kind: "video",
      assets: [],
      status: "failed",
      task_id: job.job_id,
      error: scrub(job.error) || "The captions could not be made.",
      ...echo,
    };
  }
  const progress = Math.min(0.97, Math.max(0.02, Number(job.progress) || 0));
  const stage = job.status === "transcribing" ? "Transcribing" : job.status === "rendering" ? "Rendering captions" : "Queued";
  return {
    kind: "video",
    assets: [],
    status: "pending",
    task_id: job.job_id,
    progress,
    message: `${stage} (${label}).`,
    poll: { tool_name: "versely_get_caption_job", args: { job_id: job.job_id }, ...JOB_POLL },
    ...echo,
  };
}

function jobText(job: CaptionJob): string {
  const id = job.job_id;
  const label = lookLabel(job.style);
  if (job.status === "done" && job.video_url) {
    return (
      `Captions done (${label}, ${formatLength(job.duration_sec)}): ${job.video_url}\n` +
      `The video is saved in the user's Versely library.`
    );
  }
  if (job.status === "failed" || job.status === "done") {
    // The backend's error already says what happened to paid credits.
    if (job.error) return `Captions job ${id} failed: ${scrub(job.error)}`;
    const money = (job.credits_charged ?? 0) > 0 ? (job.refunded === false ? " The credits were not refunded automatically." : " The credits were refunded.") : "";
    return `Captions job ${id} failed: the captions could not be made.${money}`;
  }
  const pct = Math.round(Math.min(1, Math.max(0, Number(job.progress) || 0)) * 100);
  return (
    `Captions job ${id} is ${job.status} (${pct}%, ${label}) and is NOT finished yet. ` +
    `The card updates by itself; otherwise check versely_get_caption_job { job_id: "${id}" } again in a minute. ` +
    `Do not start it again.`
  );
}

// --- Tools --------------------------------------------------------------------------------

const VIDEO_INPUT =
  "A direct, public https link to the video FILE (MP4, MOV, WebM...): an earlier Versely result, or a file stored " +
  "with versely_upload_media. Not a page link (YouTube, TikTok, Instagram). Up to 10 minutes and 200 MB.";

const versely_list_caption_looks = defineTool({
  name: "versely_list_caption_looks",
  description:
    "List the caption looks for versely_caption_video. FREE. Free looks: id, name, group (calm, boxed or loud) and one " +
    "line on what it looks like; they cost nothing. Premium looks: id (premium-...), name, whether it is animated, its " +
    "price in credits per started minute of video, and a short sample clip. When the user has no preference, suggest " +
    "two or three looks that fit the video (punchy reels: loud; long talks: calm or boxed). `which` narrows the list.",
  inputSchema: z.object({
    which: z
      .enum(["all", "free", "premium"])
      .optional()
      .describe("'free', 'premium' or 'all' (default)."),
  }),
  handler: async (input, ctx) => {
    const res = body<StylesResponse>(await ctx.client.get("/api/v1/captions/styles"));
    const free = res.styles ?? [];
    const premium = res.premium ?? [];
    if (!free.length && !premium.length) return jsonResult(res);
    const which = input.which ?? "all";
    const lines: string[] = ["Caption looks for versely_caption_video (pass the id as `look`)."];

    if (which !== "premium" && free.length) {
      const usable = free.filter((s) => !s.needsMatte);
      const soon = free.filter((s) => s.needsMatte);
      lines.push("", "FREE looks (no credits; a daily limit applies):");
      const groups: string[] = [];
      for (const s of usable) if (!groups.includes(s.group || "other")) groups.push(s.group || "other");
      for (const g of groups) {
        lines.push(`${cap(g)}:`);
        for (const s of usable.filter((x) => (x.group || "other") === g)) {
          lines.push(`- ${s.id}: ${s.name || s.id}. ${s.summary ?? ""}`.trimEnd());
        }
      }
      if (soon.length) {
        lines.push(`Not available yet: ${soon.map((s) => `${s.id} (${s.name || s.id})`).join(", ")}.`);
      }
    }

    if (which !== "free" && premium.length) {
      lines.push(
        "",
        "PREMIUM looks (PAID: credits per started minute of video, at least one minute; versely_caption_video without " +
          "confirm_credits returns the exact price for a video):",
      );
      for (const [tier, title] of [["dynamic", "Animated"], ["basic", "Basic"]] as const) {
        const rows = premium.filter((p) => (p.tier ?? "basic") === tier);
        if (!rows.length) continue;
        lines.push(`${title}:`);
        for (const p of rows) {
          const price = typeof p.credits_per_minute === "number" ? `${credits(p.credits_per_minute)} a minute` : "price unknown";
          lines.push(`- ${PUBLIC_PREMIUM_PREFIX}${p.preset}: ${p.name || cap(p.preset)}, ${price}${p.sample_url ? `. Sample: ${p.sample_url}` : ""}`);
        }
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
});

const versely_caption_video = defineTool({
  name: "versely_caption_video",
  description:
    "Add animated, word-timed captions to a talking video with Versely's captions studio: it transcribes the speech and " +
    "burns the words in, in the look picked from versely_list_caption_looks. Use this by default whenever the user wants " +
    "captions or subtitles on a video with speech. Free looks are FREE. A premium look (premium-...) is PAID: its " +
    "credits per started minute times the video's length, at least one minute. For a premium look, call first WITHOUT " +
    "confirm_credits: nothing starts, nothing is charged, and the exact price for this video comes back. Show the user " +
    "that price, and only after they agree call again with confirm_credits set to it; a different number is refused " +
    "with the current price, nothing charged. Video: " +
    VIDEO_INPUT +
    " Rendering runs in the background (a minute or two for a short clip, longer for a long one) and the result is " +
    "saved to the user's library; the card follows it, or check versely_get_caption_job. A failed premium render is " +
    "refunded. The other caption tools do different jobs: versely_add_captions burns one fixed line, " +
    "versely_add_timestamped_captions burns lines with times you supply, versely_add_auto_captions translates the " +
    "subtitles or renders an SRT you have, and versely_apply_caption_style restyles a slideshow, not a video.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    video_url: z.string().url().max(4096).describe(VIDEO_INPUT),
    look: z
      .string()
      .min(1)
      .max(60)
      .describe(
        "A look id from versely_list_caption_looks: a free look such as 'bold-pop', 'clean', 'boxed', 'one-word' or " +
          "'subtitle', or a premium look such as 'premium-glass'.",
      ),
    position: z
      .enum(["bottom", "middle", "top"])
      .optional()
      .describe("Free looks only: where the captions sit (default 'bottom')."),
    accent: z
      .string()
      .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "A colour like '#FFD400'.")
      .optional()
      .describe("Free looks only: the highlight colour, like '#FFD400' (default: the look's own)."),
    language: z
      .string()
      .regex(/^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3})$/, "A language code like 'en', 'hi' or 'pt-BR'.")
      .optional()
      .describe("The spoken language as a code like 'en', 'hi' or 'pt-BR' (default: detected)."),
    confirm_credits: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Premium looks only: the exact price the user approved, from a call without it. Leave it out to get the price. " +
          "Not needed for free looks.",
      ),
  }),
  handler: async (input, ctx) => {
    const toolArgs = input as Record<string, unknown>;
    const preset = premiumPresetOf(input.look);
    const language = input.language?.trim() || undefined;

    if (!preset) {
      const look = input.look.trim();
      const res = await orRefusal(() =>
        ctx.client.post(
          "/api/v1/captions/styled",
          {
            video_url: input.video_url,
            style: look,
            ...(input.position ? { position: input.position } : {}),
            ...(input.accent ? { accent: input.accent } : {}),
            ...(language ? { language } : {}),
          },
          { timeoutMs: SYNC_TIMEOUT_MS },
        ),
      );
      return isToolResult(res) ? res : startedResult(res, look, toolArgs);
    }

    const quote = await quotePremium(ctx, preset, input.video_url, language);
    if (!("credits" in quote)) return quote;
    const lookId = PUBLIC_PREMIUM_PREFIX + preset;

    if (input.confirm_credits === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              `Not started, nothing charged. "${quote.name}" is a premium look at ${credits(quote.perMinute)} per started ` +
              `minute. This video is ${formatLength(quote.seconds)}, so captioning it costs ${priceLine(quote)}. ` +
              `Show the user this price and ask. If they agree, call versely_caption_video again with the same video_url ` +
              `and look "${lookId}" and confirm_credits: ${quote.credits}. Free looks cost nothing.` +
              (quote.noSpeech ? NO_SPEECH_NOTE : ""),
          },
        ],
        structuredContent: {
          kind: "video",
          assets: [],
          status: "info",
          message: `${quote.name}: ${credits(quote.credits)} for this ${formatLength(quote.seconds)} video. Not started yet.`,
          toolName: "versely_caption_video",
          toolArgs,
        },
      };
    }

    if (input.confirm_credits !== quote.credits) {
      return errorResult(
        `Not started, nothing charged: captioning this ${formatLength(quote.seconds)} video with "${quote.name}" costs ` +
          `${priceLine(quote)}, and you passed ${input.confirm_credits}. Show the user this price and ask again; if they ` +
          `agree, call versely_caption_video with look "${lookId}" and confirm_credits: ${quote.credits}.`,
      );
    }

    const res = await orRefusal(() =>
      ctx.client.post(
        "/api/v1/captions/styled",
        { video_url: input.video_url, style: BACKEND_PREMIUM_PREFIX + preset, ...(language ? { language } : {}) },
        { timeoutMs: SYNC_TIMEOUT_MS },
      ),
    );
    return isToolResult(res) ? res : startedResult(res, BACKEND_PREMIUM_PREFIX + preset, toolArgs);
  },
});

/** The 202 from POST /captions/styled as a pending card that polls versely_get_caption_job. */
function startedResult(res: unknown, style: string, toolArgs: Record<string, unknown>): ToolResult {
  const r = body<{ job_id?: string; credits_charged?: number; duration_sec?: number }>(res);
  if (typeof r.job_id !== "string" || !r.job_id) return jsonResult(res);
  const charged = typeof r.credits_charged === "number" ? r.credits_charged : 0;
  const job: CaptionJob = { job_id: r.job_id, status: "queued", progress: 0, style, duration_sec: r.duration_sec };
  const label = lookLabel(style);
  return {
    content: [
      {
        type: "text",
        text:
          `Captioning started (job ${r.job_id}): ${label}, ${formatLength(r.duration_sec)} video, ` +
          (charged > 0 ? `${credits(charged)} charged (refunded if it fails). ` : "free, no credits. ") +
          `It usually takes a minute or two, longer for a long video, and the result is saved to the user's library. ` +
          `The card updates by itself; otherwise check versely_get_caption_job { job_id: "${r.job_id}" } in a minute. ` +
          `It is NOT finished yet; do not start it again.`,
      },
    ],
    structuredContent: jobCard(job, { toolName: "versely_caption_video", toolArgs }),
  };
}

const versely_get_caption_job = defineTool({
  name: "versely_get_caption_job",
  description:
    "Check a captions job started by versely_caption_video: its progress, then the captioned video's URL, or why it " +
    "failed (a paid job that fails is refunded). FREE. The card follows the job by itself, so call this only when you " +
    "need the result, about a minute apart. Jobs are kept for 24 hours; the finished video stays in the user's library " +
    "(versely_list_user_media).",
  // Visible to the app too: the caption card's poll loop calls this tool.
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({
    job_id: z.string().min(1).max(64).describe("The job id returned by versely_caption_video."),
  }),
  handler: async (input, ctx) => {
    let res: unknown;
    try {
      res = await ctx.client.get(`/api/v1/captions/styled/${encodeURIComponent(input.job_id)}`);
    } catch (err) {
      if (err instanceof VerselyApiError && err.status === 404) {
        const msg =
          `No captions job ${input.job_id} is tracked any more (jobs are kept for 24 hours). A finished video is in the ` +
          `user's library: versely_list_user_media.`;
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: { kind: "video", assets: [], status: "failed", task_id: input.job_id, error: msg },
          isError: true,
        };
      }
      throw err;
    }
    const job = body<CaptionJob>(res);
    if (!job.status) return jsonResult(res);
    if (!job.job_id) job.job_id = input.job_id;
    const failed = !IN_FLIGHT.has(String(job.status)) && !(job.status === "done" && job.video_url);
    return {
      content: [{ type: "text", text: jobText(job) }],
      structuredContent: jobCard(job, { look: publicLookId(job.style) }),
      ...(failed ? { isError: true } : {}),
    };
  },
});

export const styledCaptionTools: Tool[] = [versely_list_caption_looks, versely_caption_video, versely_get_caption_job];
