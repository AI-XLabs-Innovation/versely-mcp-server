// AI music video (backend /music-video, web /music): one song becomes a video
// of AI stills cut to the beat, with the song's timed lyrics on screen. The
// song is a track the user made in Versely (music_id + audio_id, read from
// versely_list_user_media type "music": the row's `id` and one of its
// `user_music_urls[].audio_id`) or the user's own song file on Versely storage
// (audio_url; anything else is a 400, and an upload has no timed lyrics).
//
//   POST /music-video/quote   price of the chosen segment (free, ~instant once the beats are cached)
//   POST /music-video         charge the quote, start the job: 202 { job_id, credits_charged }
//   GET  /music-video/:jobId  status, progress, video_url (jobs are kept for a day)
//
// The backend has no price guard on the create: it re-quotes server-side and
// charges that. So versely_create_music_video re-quotes first and refuses
// (nothing charged) when the price differs from the confirm_credits the user
// approved, then starts the job. The quote is deterministic for the same
// settings (the beat grid is cached per track), so the two cannot drift
// apart between the calls. confirm_credits is also sent along (the backend
// ignores unknown keys today), and a 409 is read as a price refusal should the
// backend ever add its own guard.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { VerselyApiError } from "../errors.js";
import { metaForMediaCard } from "../ui/templates.js";

// --- Backend shapes (services/musicVideo.service.ts, 2026-11-14) ---------------

const ASPECTS = ["9:16", "1:1", "16:9"] as const;
const QUALITIES = ["quality", "fast"] as const;
const MIN_SEGMENT_SEC = 15;
const MAX_SEGMENT_SEC = 240;

interface MusicVideoQuote {
  credits: number;
  breakdown?: { stills?: number; per_still?: number; render?: number };
  stills?: number;
  shots?: number;
  has_lyrics?: boolean;
  song_duration_sec?: number;
  start_sec?: number;
  duration_sec?: number;
  bpm?: number | null;
}

type JobStatus = "queued" | "planning" | "stills" | "rendering" | "done" | "failed";

interface MusicVideoJob {
  id: string;
  status: JobStatus | string;
  progress?: { stills_done?: number; stills_total?: number };
  video_url?: string;
  thumbnail_url?: string;
  error?: string;
  credits_charged?: number;
  refunded?: boolean;
  created_at?: string;
}

// --- Helpers -------------------------------------------------------------------

function clock(sec: number | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function credits(n: number | undefined): string {
  return typeof n === "number" ? `${n} credit${n === 1 ? "" : "s"}` : "an unknown number of credits";
}

function qualityLabel(q: string | undefined): string {
  return q === "fast" ? "Fast (beta)" : "Quality";
}

/** `{ success, quote }`; tolerate a `data` wrapper. */
function pickQuote(res: unknown): MusicVideoQuote | undefined {
  const r = (res ?? {}) as Record<string, unknown>;
  const q = (r.quote ?? (r.data as Record<string, unknown> | undefined)?.quote ?? r.data) as MusicVideoQuote | undefined;
  return q && typeof q.credits === "number" ? q : undefined;
}

/** `{ success, job }`; tolerate a `data` wrapper. */
function pickJob(res: unknown): MusicVideoJob | undefined {
  const r = (res ?? {}) as Record<string, unknown>;
  const j = (r.job ?? (r.data as Record<string, unknown> | undefined)?.job) as MusicVideoJob | undefined;
  return j && typeof j.id === "string" ? j : undefined;
}

// --- Inputs --------------------------------------------------------------------

const SONG_FIELDS = {
  music_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "A song the user made in Versely: the `id` of its row in versely_list_user_media (type 'music'). Pass with audio_id. " +
        "A song from versely_generate_music is listed there once it has finished (match it by request_id).",
    ),
  audio_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Which version of that song: one `user_music_urls[].audio_id` of the same row (each song comes in two versions)."),
  audio_url: z
    .string()
    .url()
    .max(2048)
    .optional()
    .describe(
      "Instead of music_id + audio_id: the user's own song file stored on Versely (the URL versely_upload_media returns). " +
        "Other links are refused. An uploaded song plays without on-screen lyrics.",
    ),
  start_sec: z
    .number()
    .min(0)
    .optional()
    .describe("Where in the song the video starts, in seconds. Default: a beat before the first sung line (0 for an instrumental)."),
  duration_sec: z
    .number()
    .min(MIN_SEGMENT_SEC)
    .max(MAX_SEGMENT_SEC)
    .optional()
    .describe("How long the video is, 15-240 seconds (default 60). Shortened to what is left of the song. Longer costs more."),
  aspect_ratio: z.enum(ASPECTS).optional().describe("'9:16' (default; TikTok, Reels, Shorts), '1:1' (square post) or '16:9' (YouTube)."),
  quality: z
    .enum(QUALITIES)
    .optional()
    .describe("'quality' (default): sharper, more detailed stills. 'fast' (beta): quicker and cheaper stills."),
  style: z
    .string()
    .max(500)
    .optional()
    .describe(
      "The look of the pictures in the user's words, e.g. 'grainy 90s film, neon city at night'. Optional (default: drawn from the song). " +
        "Does not change the price.",
    ),
  instrumental: z
    .boolean()
    .optional()
    .describe("true: no lyrics on screen, even when the song has timed lyrics (default false)."),
  keep_audio_untouched: z
    .boolean()
    .optional()
    .describe("true: the song plays exactly as it is, with no fade in or out (default false: short fades)."),
};

type SongInput = {
  music_id?: string;
  audio_id?: string;
  audio_url?: string;
  start_sec?: number;
  duration_sec?: number;
  aspect_ratio?: (typeof ASPECTS)[number];
  quality?: (typeof QUALITIES)[number];
  style?: string;
  instrumental?: boolean;
  keep_audio_untouched?: boolean;
};

/** The backend body for quote and create, or the reason the song is not named properly. */
function songBody(input: SongInput): { body: Record<string, unknown> } | { error: string } {
  const url = input.audio_url?.trim();
  const musicId = input.music_id?.trim();
  const audioId = input.audio_id?.trim();
  if (url && (musicId || audioId)) {
    return { error: "Pass either music_id + audio_id (a song made in Versely) or audio_url (the user's own song file), not both. Nothing was charged." };
  }
  if (!url && !(musicId && audioId)) {
    return {
      error:
        "Name the song: music_id and audio_id of a song the user made in Versely (from versely_list_user_media with type 'music': the row's id " +
        "and one user_music_urls[].audio_id), or audio_url for the user's own song file stored with versely_upload_media. Nothing was charged.",
    };
  }
  const body: Record<string, unknown> = url ? { audio_url: url } : { music_id: musicId, audio_id: audioId };
  if (input.start_sec !== undefined) body.start_sec = input.start_sec;
  if (input.duration_sec !== undefined) body.duration_sec = input.duration_sec;
  if (input.aspect_ratio) body.aspect_ratio = input.aspect_ratio;
  if (input.quality) body.quality = input.quality;
  if (input.style !== undefined && input.style.trim()) body.style = input.style.trim();
  if (input.instrumental !== undefined) body.instrumental = input.instrumental;
  if (input.keep_audio_untouched !== undefined) body.keep_audio_untouched = input.keep_audio_untouched;
  return { body };
}

/** POST /music-video/quote; a 404 (not the user's track) gets a pointer to where the ids come from. */
async function fetchQuote(ctx: ToolContext, body: Record<string, unknown>): Promise<{ quote?: MusicVideoQuote; raw: unknown } | { error: string }> {
  try {
    const raw = await ctx.client.post("/api/v1/music-video/quote", body, { timeoutMs: SYNC_TIMEOUT_MS });
    return { quote: pickQuote(raw), raw };
  } catch (err) {
    if (err instanceof VerselyApiError && err.status === 404) {
      return {
        error:
          "That song was not found in the user's Versely music. Check music_id and audio_id with versely_list_user_media (type 'music'): " +
          "music_id is the row's id and audio_id one of its user_music_urls[].audio_id. Nothing was charged.",
      };
    }
    throw err;
  }
}

function lyricsLine(q: MusicVideoQuote, body: Record<string, unknown>): string {
  if (q.has_lyrics) return "the song's lyrics timed on screen";
  if (body.audio_url) return "no lyrics on screen (an uploaded song has no timed lyrics)";
  if (body.instrumental) return "no lyrics on screen (instrumental)";
  return "no lyrics on screen (this version of the song has no timed lyrics)";
}

/** "0:12-1:12 of the song (60 s; the song is 3:05 long)". */
function segmentLine(q: MusicVideoQuote): string {
  const start = q.start_sec ?? 0;
  const dur = q.duration_sec ?? 0;
  const whole = typeof q.song_duration_sec === "number" ? `; the song is ${clock(q.song_duration_sec)} long` : "";
  return `${clock(start)}-${clock(start + dur)} of the song (${Math.round(dur)} s${whole})`;
}

function quoteSummary(q: MusicVideoQuote, body: Record<string, unknown>): string {
  const b = q.breakdown ?? {};
  const stills =
    typeof q.stills === "number"
      ? `${q.stills} stills${typeof b.per_still === "number" ? ` at ${credits(b.per_still)} each` : ""}` +
        `${typeof q.shots === "number" ? `, cut to the beat across ${q.shots} shots` : ""}` +
        `${typeof b.render === "number" ? `, plus ${credits(b.render)} to render` : ""}`
      : null;
  const settings = `${String(body.aspect_ratio ?? "9:16")}, ${qualityLabel(body.quality as string | undefined)}`;
  const tempo = typeof q.bpm === "number" && q.bpm > 0 ? ` Tempo about ${Math.round(q.bpm)} BPM.` : "";
  const lyrics = lyricsLine(q, body);
  return [
    `${credits(q.credits)} for ${segmentLine(q)}.`,
    stills ? `${stills}.` : null,
    `${lyrics.charAt(0).toUpperCase()}${lyrics.slice(1)}; ${settings}.${tempo}`,
  ]
    .filter(Boolean)
    .join(" ");
}

// --- Card ----------------------------------------------------------------------

const POLL = { interval_ms: 10_000, timeout_ms: 50 * 60_000 };
const IN_FLIGHT = new Set(["queued", "planning", "stills", "rendering"]);

/** The web's progress labels and bar (versely-web lib/musicVideo.ts jobStage). */
function stageOf(job: MusicVideoJob): { label: string; fraction: number } {
  const done = Math.max(0, job.progress?.stills_done ?? 0);
  const total = Math.max(0, job.progress?.stills_total ?? 0);
  switch (job.status) {
    case "queued":
      return { label: "waiting to start", fraction: 0.02 };
    case "planning":
      return { label: "planning the look", fraction: 0.06 };
    case "stills": {
      const share = total > 0 ? Math.min(1, done / total) : 0;
      return { label: total > 0 ? `drawing stills, ${Math.min(done, total)} of ${total}` : "drawing stills", fraction: 0.1 + 0.75 * share };
    }
    case "rendering":
      return { label: "cutting it to the beat", fraction: 0.9 };
    default:
      return { label: "working", fraction: 0.02 };
  }
}

function getHint(id: string): string {
  return `versely_get_music_video { job_id: ${JSON.stringify(id)} }`;
}

/** Card state + text for a job: pending (polling versely_get_music_video), the finished video, or the failure. */
function jobResult(
  job: MusicVideoJob,
  toolName: string,
  toolArgs: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ToolResult {
  const echo = { title: "Music video", toolName, toolArgs, ...extra };
  if (job.status === "done" && job.video_url) {
    const lines = [`The music video is ready: ${job.video_url}`];
    if (job.thumbnail_url) lines.push(`Poster image: ${job.thumbnail_url}`);
    lines.push("It is saved in the user's Versely videos (versely_list_user_media, type 'videos').");
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        kind: "video",
        assets: [{ url: job.video_url, label: "Music video" }],
        status: "completed",
        task_id: job.id,
        ...echo,
      },
    };
  }
  if (job.status === "failed" || job.status === "done") {
    const refunded =
      job.refunded === true ? " The credits were refunded." : job.refunded === false ? " The credits may not have come back; the user can contact Versely support." : "";
    const error = job.error ? job.error : `The music video did not finish.${refunded}`;
    return {
      content: [{ type: "text", text: `Music video ${job.id} failed: ${error}` }],
      structuredContent: { kind: "video", assets: [], status: "failed", task_id: job.id, error, ...echo },
    };
  }
  const stage = stageOf(job);
  const pct = Math.round(stage.fraction * 100);
  return {
    content: [
      {
        type: "text",
        text:
          `Music video ${job.id} is ${IN_FLIGHT.has(String(job.status)) ? stage.label : String(job.status)} (about ${pct}%). ` +
          `It takes a few minutes in all. The card updates by itself; otherwise check ${getHint(job.id)} again in a minute or two. ` +
          `It is NOT finished yet; do not start it again.`,
      },
    ],
    structuredContent: {
      kind: "video",
      assets: [],
      status: "pending",
      task_id: job.id,
      progress: stage.fraction,
      message: `Music video: ${stage.label}.`,
      poll: { tool_name: "versely_get_music_video", args: { job_id: job.id }, ...POLL },
      ...echo,
    },
  };
}

// --- Tools ---------------------------------------------------------------------

const ABOUT =
  "A Versely music video: AI stills cut to the beat of one song, with the song's timed lyrics on screen. " +
  "The song is either a song the user made in Versely (music_id + audio_id from versely_list_user_media with type 'music': " +
  "the row's id and one user_music_urls[].audio_id) or the user's own song file stored with versely_upload_media (audio_url; " +
  "no on-screen lyrics). ";

const versely_quote_music_video = defineTool({
  name: "versely_quote_music_video",
  description:
    ABOUT +
    "This tool is FREE: it returns the exact credits for the chosen part of the song and settings, which part of the song " +
    "the video covers, how many stills it draws and whether lyrics will show. Use it first, with the settings the user picked " +
    "(length, start, aspect ratio, quality, style), show them the price, and call versely_create_music_video with the same " +
    "settings and that price as confirm_credits only after they say yes.",
  inputSchema: z.object(SONG_FIELDS),
  handler: async (input, ctx) => {
    const built = songBody(input);
    if ("error" in built) return errorResult(built.error);
    const got = await fetchQuote(ctx, built.body);
    if ("error" in got) return errorResult(got.error);
    if (!got.quote) return jsonResult(got.raw);
    const q = got.quote;
    const styleNote = built.body.style ? "" : " No style given: the pictures follow the song; a style (it does not change the price) can be added.";
    return {
      content: [
        {
          type: "text",
          text:
            `Music video quote (free, nothing charged): ${quoteSummary(q, built.body)}${styleNote}\n` +
            `Show the user this price. Only after they say yes, call versely_create_music_video with the same settings and confirm_credits: ${q.credits}.`,
        },
      ],
    };
  },
});

const versely_create_music_video = defineTool({
  name: "versely_create_music_video",
  description:
    ABOUT +
    "PAID: spends the quoted credits once (refunded if the video fails). Call it only after versely_quote_music_video and the " +
    "user's yes to that exact price, with the same settings and the price as confirm_credits. If the price is different now, " +
    "the call is refused with the new price and nothing is charged: show it and ask again. The video is made in the background " +
    "in a few minutes; the card follows it, otherwise check versely_get_music_video. Never start the same video twice.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    ...SONG_FIELDS,
    confirm_credits: z
      .number()
      .positive()
      .describe("The exact price from versely_quote_music_video that the user approved. Must equal the current quote."),
  }),
  handler: async (input, ctx) => {
    const { confirm_credits, ...song } = input;
    const built = songBody(song);
    if ("error" in built) return errorResult(built.error);
    const got = await fetchQuote(ctx, built.body);
    if ("error" in got) return errorResult(got.error);
    if (!got.quote) return errorResult("Could not price this music video right now, so nothing was started or charged. Try versely_quote_music_video again.");
    const q = got.quote;
    if (q.credits !== confirm_credits) {
      return errorResult(
        `Not started, nothing charged: this music video costs ${credits(q.credits)} now (you passed ${confirm_credits}). ` +
          `${quoteSummary(q, built.body)} Show the user the new price and ask again; if they agree, call versely_create_music_video ` +
          `with the same settings and confirm_credits: ${q.credits}.`,
      );
    }

    let res: Record<string, unknown>;
    try {
      res = await ctx.client.post<Record<string, unknown>>(
        "/api/v1/music-video",
        { ...built.body, confirm_credits },
        { timeoutMs: SYNC_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof VerselyApiError && err.status === 409) return createConflict(err, confirm_credits);
      throw err;
    }
    const data = ((res?.data as Record<string, unknown> | undefined) ?? res ?? {}) as Record<string, unknown>;
    const jobId = typeof data.job_id === "string" ? data.job_id : typeof res?.job_id === "string" ? (res.job_id as string) : undefined;
    if (!jobId) return jsonResult(res);
    const charged = typeof data.credits_charged === "number" ? data.credits_charged : q.credits;

    const card = jobResult({ id: jobId, status: "queued", progress: { stills_done: 0, stills_total: q.stills ?? 0 } }, "versely_create_music_video", input, {
      aspect_ratio: String(built.body.aspect_ratio ?? "9:16"),
    });
    return {
      ...card,
      content: [
        {
          type: "text",
          text:
            `Music video started (job_id ${jobId}): ${credits(charged)} charged, refunded if it fails. It covers ${segmentLine(q)}. ` +
            `It takes a few minutes: planning the look, drawing ${typeof q.stills === "number" ? `${q.stills} stills` : "the stills"}, then the render. ` +
            `The card updates by itself; otherwise check ${getHint(jobId)} in a minute or two. ` +
            `It is NOT finished yet; do not start it again.`,
        },
      ],
    };
  },
});

/** 409: only if the backend ever guards the price itself. The body may carry the fresh quote. */
function createConflict(err: VerselyApiError, offered: number): ToolResult {
  const body = (err.body ?? {}) as Record<string, unknown>;
  for (const src of [body, body.quote, body.data, (body.data as Record<string, unknown> | undefined)?.quote]) {
    const v = (src as Record<string, unknown> | undefined)?.credits;
    if (typeof v === "number" && Number.isFinite(v) && v !== offered) {
      return errorResult(
        `Not started, nothing charged: this music video costs ${credits(v)} now (you passed ${offered}). ` +
          `Show the user the new price and ask again; if they agree, call versely_create_music_video with confirm_credits: ${v}.`,
      );
    }
  }
  const said = typeof body.error === "string" ? ` ${body.error}` : typeof body.message === "string" ? ` ${body.message}` : "";
  return errorResult(`Not started, nothing charged.${said} Get a fresh price with versely_quote_music_video.`);
}

const versely_get_music_video = defineTool({
  name: "versely_get_music_video",
  description:
    "Check a music video started with versely_create_music_video: its stage (planning, drawing stills, rendering), the " +
    "finished video's URL, or why it failed (the credits are refunded then). FREE. The card follows the job by itself, so " +
    "don't call this in a loop; check every minute or two only when you need the result. Jobs are kept for a day; " +
    "finished videos stay in the user's Versely videos.",
  // Visible to the app too: the create card's poll loop calls this tool.
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({
    job_id: z.string().min(1).max(64).describe("The job_id versely_create_music_video returned."),
  }),
  handler: async (input, ctx) => {
    let res: unknown;
    try {
      res = await ctx.client.get(`/api/v1/music-video/${encodeURIComponent(input.job_id)}`);
    } catch (err) {
      if (err instanceof VerselyApiError && err.status === 404) {
        const error =
          "No music video with that job_id. Jobs are kept for a day; finished videos stay in the user's Versely videos " +
          "(versely_list_user_media, type 'videos').";
        return {
          content: [{ type: "text", text: error }],
          structuredContent: { kind: "video", assets: [], status: "failed", task_id: input.job_id, error, toolName: "versely_get_music_video", toolArgs: input },
        };
      }
      throw err;
    }
    const job = pickJob(res);
    if (!job) return jsonResult(res);
    return jobResult(job, "versely_get_music_video", input);
  },
});

export const musicVideoTools: Tool[] = [versely_quote_music_video, versely_create_music_video, versely_get_music_video];
