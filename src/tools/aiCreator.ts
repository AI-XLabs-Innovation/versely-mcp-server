// AI creators (backend /automations/ai-creator/* on top of the generic
// /automations routes; services/aiCreator + services/automations/kinds/
// aiCreator.kind.ts): one avatar, one room and one voice that make a new
// short vertical video every day and post it to ONE connected account at ONE
// daily time. The flow a client follows (the web wizard does the same):
//
//   GET   /automations/ai-creator/options            choices (free)
//   GET   /automations/ai-creator/public             per-episode price table (free, no session)
//   POST  /automations/ai-creator/rooms              4 pictures of the avatar in a room (PAID: roomCredits)
//   POST  /automations { kind: "ai_creator" }        the creator (free; created paused, phase "setup")
//   PATCH /automations/:id                           edit (free; the config is replaced whole, so merge)
//   POST  /automations/ai-creator/:id/test-episode   episode 1, the test take (PAID: credits_per_run; never posted)
//   GET   /automations/ai-creator/:id/episodes       episodes, newest first
//   POST  /automations/ai-creator/:id/approve        go live: one episode a day, each PAID credits_per_run (+ its post)
//
// Nothing runs before approval (the kind's readyToRun refuses start / run
// now). After it, the generic automation tools drive it: pause, start (resume),
// run now (one extra episode), delete, list runs.
//
// No quote endpoint exists for rooms or a test take, and neither route takes a
// price: the paid tools here read the current price (GET /options roomCredits,
// the creator's credits_per_run) and refuse, nothing charged, when it differs
// from the confirm_credits the user approved. Voices are passed by NAME: the
// backend's voice ids carry the voice vendor in them, so they never reach the
// model.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { VerselyApiError, VerselyNetworkError } from "../errors.js";
import { metaForMediaCard } from "../ui/templates.js";
import { toProviderAccountIds } from "./social.js";

// --- Backend shapes (services/aiCreator/catalog.ts, 2026-11-13) --------------

const KIND = "ai_creator";
const BASE = "/api/v1/automations/ai-creator";

const FORMATS = [
  "kitchen_tips",
  "home_hacks",
  "food_facts",
  "fitness_basics",
  "wellness_tips",
  "product_demo",
  "custom",
] as const;
const SETTINGS = [
  "kitchen",
  "brick_kitchen",
  "bright_study",
  "living_room",
  "bathroom",
  "garage",
  "car",
  "gym",
  "custom",
] as const;
const LENGTHS = [15, 20, 30] as const;
const QUALITIES = ["720p", "1080p"] as const;
/** catalog.CAPTION_STYLE_IDS: word-by-word animated captions. */
const CAPTION_STYLES = [
  "word_pop",
  "snap_gold",
  "snap_cyan",
  "snap_lime",
  "snap_mono",
  "typewriter",
  "reveal_cyan",
  "reveal_pink",
  "reveal_lime",
  "reveal_mono",
] as const;
const DEFAULT_CAPTION_STYLE = "snap_gold";
const TOPIC_MAX = 200;
const ROOM_NOTE_MAX = 300;
/** episodes.MAKE_AHEAD_MS: a daily episode is made this long before it posts. */
const MAKE_AHEAD_HOURS = 3;

type EpisodeStatus = "making" | "ready" | "scheduled" | "posted" | "failed";

/** episodes.PublicEpisode */
interface Episode {
  id: string;
  status: EpisodeStatus;
  videoUrl?: string | null;
  posterUrl?: string | null;
  title?: string | null;
  script?: string | null;
  credits?: number | null;
  createdAt?: string | null;
  scheduledFor?: string | null;
  postedUrl?: string | null;
  error?: string | null;
}

/** automations.service AutomationView, with the kind's phase / approvedAt. */
interface CreatorView {
  id: string;
  kind: string;
  kind_label?: string;
  name: string;
  config?: Record<string, unknown>;
  summary?: string;
  credits_per_run?: number | null;
  credits_spent?: number;
  schedule?: { times?: string[]; timezone?: string } | null;
  next_post_at?: string | null;
  status?: string;
  paused_reason?: string | null;
  phase?: string;
  approvedAt?: string | null;
  running?: boolean;
  consecutive_failures?: number;
  last_error?: string | null;
}

/** service.optionsPayload */
interface CreatorOptions {
  formats?: Array<{ id: string; label: string; description?: string; needsProduct?: boolean }>;
  settings?: Array<{ id: string; label: string }>;
  voices?: Array<{ id: string; name: string; gender?: string | null; accent?: string | null }>;
  lengths?: number[];
  defaultLength?: number;
  qualities?: string[];
  defaultQuality?: string;
  roomOptions?: number;
  roomCredits?: number;
}

// --- Small helpers -------------------------------------------------------------

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** `{ success, data: {...} }` (automation routes) or a flat body (AI creator routes). */
function unwrap(res: unknown): Record<string, unknown> {
  const r = rec(res);
  return r.data && typeof r.data === "object" && !Array.isArray(r.data) ? rec(r.data) : r;
}

const enc = encodeURIComponent;

function credits(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `${n} credit${n === 1 ? "" : "s"}` : "an unknown number of credits";
}

function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

function scheduleText(s: CreatorView["schedule"]): string | null {
  const t = s?.times?.[0];
  return t && s?.timezone ? `${t} (${s.timezone} time)` : null;
}

function accountIdOf(v: CreatorView): string | null {
  const ids = v.config?.post_account_ids;
  return Array.isArray(ids) && typeof ids[0] === "string" && ids[0] ? ids[0] : null;
}

/** What the backend said, for the refusals a tool words itself (400 / 404 / 409). */
function refusal(err: unknown): { status: number; code: string | null; text: string } | null {
  if (!(err instanceof VerselyApiError) || ![400, 404, 409].includes(err.status)) return null;
  const b = rec(err.body);
  const text =
    typeof b.error === "string" && b.error ? b.error : typeof b.message === "string" && b.message ? b.message : err.message;
  return { status: err.status, code: typeof b.code === "string" ? b.code : null, text };
}

async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

async function getOptions(ctx: ToolContext): Promise<CreatorOptions> {
  return unwrap(await ctx.client.get(`${BASE}/options`)) as CreatorOptions;
}

async function getCreator(ctx: ToolContext, id: string): Promise<CreatorView> {
  const a = rec(unwrap(await ctx.client.get(`/api/v1/automations/${enc(id)}`)).automation);
  if (!a.id) throw new Error(`AI creator ${id} not found. Its id is in versely_list_automations.`);
  if (a.kind !== KIND) {
    throw new Error(`${id} is a ${String(a.kind_label ?? a.kind)} automation, not an AI creator; use the automation tools for it.`);
  }
  return a as unknown as CreatorView;
}

async function getEpisodes(ctx: ToolContext, id: string): Promise<Episode[]> {
  const list = unwrap(await ctx.client.get(`${BASE}/${enc(id)}/episodes`)).episodes;
  return Array.isArray(list) ? (list.filter((e) => typeof rec(e).id === "string") as Episode[]) : [];
}

/** What one post costs the user (GET /social/plan): 0 when their plan includes posting, null when unknown. */
async function postCredits(ctx: ToolContext): Promise<number | null> {
  const res = await settle(ctx.client.get(`/api/v1/social/plan`));
  const n = rec(rec(res).plan).credits_per_account;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** "tiktok @name" for a provider account id, or null. */
async function accountLabel(ctx: ToolContext, externalId: string | null): Promise<string | null> {
  if (!externalId) return null;
  const res = await settle(ctx.client.get<{ accounts?: unknown[] }>("/api/v1/social/accounts"));
  const a = (Array.isArray(res?.accounts) ? res.accounts : [])
    .map(rec)
    .find((x) => String(x.external_account_id) === externalId || String(x.id) === externalId);
  if (!a) return null;
  const who = typeof a.username === "string" && a.username ? ` @${a.username}` : "";
  return `${String(a.platform ?? "account")}${who}`;
}

function priceText(perEpisode: number | null | undefined, post: number | null): string {
  const each = `${credits(perEpisode)} per episode`;
  if (post === 0) return `${each} (posts cost nothing extra)`;
  if (typeof post === "number") return `${each}, plus ${credits(post)} for each post`;
  return each;
}

function stateText(v: CreatorView): string {
  if (v.phase !== "approved") return "in setup: not live, nothing is made or posted until a test take is approved";
  if (v.status === "active") return "live: makes and posts a new episode every day";
  if (v.paused_reason === "credits") return "paused: not enough credits for the next episode";
  if (v.paused_reason === "failures") {
    const n = v.consecutive_failures;
    return `paused after ${typeof n === "number" && n > 1 ? `${n} failed episodes in a row` : "a failed episode"}${v.last_error ? ` (${clip(v.last_error, 160)})` : ""}`;
  }
  return "paused by the user";
}

/** "Posts daily at 18:00 (Europe/London time) to tiktok @name", or what is still missing. */
function postingText(v: CreatorView, account: string | null): string {
  const when = scheduleText(v.schedule);
  const acct = accountIdOf(v);
  if (when && acct) return `Posts daily at ${when} to ${account ?? "the chosen account"}.`;
  const missing = [acct ? null : "the account it posts to", when ? null : "the daily posting time"].filter(Boolean).join(" and ");
  return `Not set yet: ${missing} (needed before approval; set with versely_update_ai_creator).`;
}

const isMade = (e: Episode) => typeof e.videoUrl === "string" && e.videoUrl.length > 0;

// --- Card ------------------------------------------------------------------------

const EPISODE_POLL = { interval_ms: 15_000, timeout_ms: 35 * 60_000 };
/** "Usually a few minutes" (web copy); the job gives up after 30. */
const TYPICAL_MAKE_MS = 6 * 60_000;
const CARD_VIDEOS = 6;

/**
 * The media card for a creator, focused on one episode: following it while it
 * is made (polling versely_list_ai_creator_episodes), its error if it failed,
 * else the episodes made so far (the focus first).
 */
function episodesCard(
  creator: { id: string; name: string },
  episodes: Episode[],
  focus: Episode | undefined,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  const echo = { title: creator.name, toolName, toolArgs };
  if (focus?.status === "making") {
    const started = focus.createdAt ? Date.parse(focus.createdAt) : NaN;
    const progress = Number.isFinite(started) ? Math.min(0.95, Math.max(0.02, (Date.now() - started) / TYPICAL_MAKE_MS)) : 0.02;
    return {
      kind: "video",
      assets: [],
      status: "pending",
      task_id: focus.id,
      progress,
      message: `Making an episode of ${creator.name}: usually a few minutes.`,
      poll: {
        tool_name: "versely_list_ai_creator_episodes",
        args: { creator_id: creator.id, episode_id: focus.id },
        ...EPISODE_POLL,
      },
      ...echo,
    };
  }
  if (focus?.status === "failed" && !isMade(focus)) {
    return {
      kind: "video",
      assets: [],
      status: "failed",
      task_id: focus.id,
      error: `${clip(focus.error, 300) || "This episode could not be made."} Its credits were refunded.`,
      ...echo,
    };
  }
  const made = episodes.filter(isMade);
  made.sort((a, b) => (a.id === focus?.id ? -1 : b.id === focus?.id ? 1 : 0));
  const assets = made.slice(0, CARD_VIDEOS).map((e) => ({ url: String(e.videoUrl), label: e.title || "Episode" }));
  if (assets.length > 0) {
    return {
      kind: assets.length > 1 ? "gallery" : "video",
      assets,
      status: "completed",
      task_id: focus?.id ?? creator.id,
      aspect_ratio: "9:16",
      ...echo,
    };
  }
  return { kind: "video", assets: [], status: "info", task_id: creator.id, message: `${creator.name}: no episodes yet.`, ...echo };
}

// --- Text: what the model shows the user -------------------------------------------

function nextStep(v: CreatorView, eps: Episode[], post: number | null): string {
  const id = JSON.stringify(v.id);
  const n = v.credits_per_run;
  const price = credits(n);
  const confirm = typeof n === "number" ? n : "<the price>";
  const latest = eps[0];
  if (typeof n !== "number") {
    return `This creator's settings need attention (${v.summary ?? "unreadable settings"}); fix them with versely_update_ai_creator.`;
  }
  if (v.phase !== "approved") {
    if (!latest) {
      return (
        `Make the test take (episode 1; it is never posted): tell the user it costs ${price}, then ` +
        `versely_test_ai_creator_episode { creator_id: ${id}, confirm_credits: ${confirm} }.`
      );
    }
    if (latest.status === "making") {
      return (
        "The newest test take is being made (usually a few minutes). The card updates by itself; otherwise check " +
        `versely_list_ai_creator_episodes { creator_id: ${id} } again in a minute or two. Do not start another take.`
      );
    }
    const earlierReady = eps.some((e) => e.status === "ready" && isMade(e));
    if (latest.status === "failed" && !isMade(latest)) {
      return (
        `The newest take failed${latest.error ? ` (${clip(latest.error, 160)})` : ""}; its credits were refunded. ` +
        (earlierReady ? "An earlier take is ready and can still be approved. " : "") +
        `Another take costs ${price}: versely_test_ai_creator_episode { creator_id: ${id}, confirm_credits: ${confirm} }.`
      );
    }
    const missing =
      !scheduleText(v.schedule) || !accountIdOf(v)
        ? " Before approval, set the account and the daily time with versely_update_ai_creator (post_account_id, post_time, timezone)."
        : "";
    return (
      "Show the user the test take and its lines. If they like it, tell them the schedule (one new episode every day, " +
      `posted at ${scheduleText(v.schedule) ?? "the daily time"}) and the cost (${priceText(n, post)}, charged as each ` +
      `episode is made), then call versely_approve_ai_creator { creator_id: ${id}, confirm_credits: ${confirm} } ` +
      `(post_test_episode: true also posts this take as the first video).${missing} If they want changes, use ` +
      `versely_update_ai_creator and make another take (${price} each).`
    );
  }
  return (
    `Pause it with versely_pause_automation { automation_id: ${id} }, resume with versely_start_automation, make one ` +
    `extra episode now with versely_run_automation_now (spends ${price}), change settings with versely_update_ai_creator, ` +
    "delete it with versely_delete_automation (videos already made stay in the user's library)."
  );
}

function episodeLine(e: Episode): string {
  const when =
    e.status === "posted"
      ? e.postedUrl
        ? `posted: ${e.postedUrl}`
        : "posted"
      : e.status === "scheduled" && e.scheduledFor
        ? `posts ${e.scheduledFor}`
        : e.status === "failed"
          ? `failed${e.error ? `: ${clip(e.error, 140)}` : ""}`
          : e.status;
  const cost = typeof e.credits === "number" && e.credits > 0 ? ` · ${credits(e.credits)}` : "";
  return `- ${e.title ? `"${clip(e.title, 80)}"` : "Untitled"} (${when}${cost}) · episode_id ${e.id}`;
}

function creatorText(
  v: CreatorView,
  eps: Episode[],
  focus: Episode | undefined,
  account: string | null,
  post: number | null,
  lead?: string,
): string {
  const lines: string[] = [];
  if (lead) lines.push(lead, "");
  lines.push(`"${v.name}" (creator_id ${v.id}): ${stateText(v)}.`);
  if (v.summary) lines.push(`Settings: ${v.summary}.`);
  lines.push(`Cost: ${priceText(v.credits_per_run, post)}, charged when each episode is made (refunded if it fails).`);
  lines.push(postingText(v, account));
  if (v.phase === "approved" && v.next_post_at) lines.push(`Next post: ${v.next_post_at}.`);
  if (eps.length) {
    lines.push("", `Episodes, newest first${v.phase !== "approved" ? " (test takes)" : ""}:`);
    for (const e of eps.slice(0, 10)) lines.push(episodeLine(e));
    if (eps.length > 10) lines.push(`(${eps.length - 10} older not shown)`);
  }
  if (focus && isMade(focus)) {
    lines.push("", `${focus.title ? `"${focus.title}"` : "Episode"}: ${focus.videoUrl}`);
    const script = (focus.script ?? "").split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
    if (script.length) lines.push("Lines:", ...script.map((l) => `  ${l}`));
  }
  lines.push("", `Next: ${nextStep(v, eps, post)}`);
  return lines.join("\n");
}

// --- Inputs ------------------------------------------------------------------------

const CreatorId = z
  .string()
  .uuid()
  .describe("The AI creator's id: creator_id from versely_create_ai_creator (its automation id in versely_list_automations).");

const ConfirmCredits = (what: string) =>
  z.number().int().positive().describe(`The exact ${what} the user approved. Refused, nothing charged, when it differs from the current price.`);

const configFields = {
  avatar_id: z
    .string()
    .min(2)
    .max(64)
    .describe(
      "Who stars: avatar_id of one of the user's own avatars or a ready-made one, from versely_list_ai_creator_options. " +
        "Rooms are drawn for one avatar: a new avatar needs a room made for it.",
    ),
  room_image_url: z
    .string()
    .url()
    .max(2048)
    .describe("The room picture the user picked: one of the URLs versely_make_ai_creator_rooms returned. Any other picture is refused."),
  voice: z
    .string()
    .min(2)
    .max(60)
    .describe("The voice's name from versely_list_ai_creator_options (e.g. 'Skylar'). The voice's language is the language of every episode."),
  format: z
    .enum(FORMATS)
    .describe(
      "What it posts: kitchen_tips, home_hacks, food_facts, fitness_basics, wellness_tips (no medical claims), " +
        "product_demo (needs product_url) or custom (needs a topic).",
    ),
  topic: z
    .string()
    .max(TOPIC_MAX)
    .describe("What it posts about, in a few words (required for custom, at least 3 characters; optional otherwise, narrows the format)."),
  product_url: z
    .string()
    .url()
    .max(2048)
    .describe("Product demo only: the product page. Episodes only state what the page says."),
  comment_word: z
    .string()
    .regex(/^[\p{L}\p{N}]{2,20}$/u, "One word of 2-20 letters or digits.")
    .describe("Optional last line 'Comment WORD ...' (one word, e.g. RECIPE; stored in capitals)."),
  length_seconds: z
    .union([z.literal(15), z.literal(20), z.literal(30)])
    .describe("Episode length in seconds: 15, 20 (default) or 30. Longer costs more."),
  quality: z.enum(QUALITIES).describe("'720p' (default) or '1080p' (costs more). Always vertical 9:16."),
  caption_style: z
    .enum(CAPTION_STYLES)
    .describe(`Word-by-word caption style (default ${DEFAULT_CAPTION_STYLE}).`),
  post_account_id: z
    .string()
    .min(1)
    .describe("The ONE social account it posts to: an id from versely_list_social_accounts. Another account needs a second creator."),
  post_time: z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour.")
    .describe("Daily posting time, 'HH:MM' 24-hour (e.g. '18:00'), in timezone. Each episode is made about 3 hours before it."),
  timezone: z
    .string()
    .min(3)
    .max(64)
    .describe("IANA time zone of post_time, e.g. 'Europe/London' or 'America/New_York'. Ask the user; do not guess."),
};

// --- Tools -------------------------------------------------------------------------

const FLOW =
  "The flow: 1. versely_list_ai_creator_options (free): show the choices. 2. versely_make_ai_creator_rooms (paid): four " +
  "pictures of the avatar in a room; the user picks one. 3. versely_create_ai_creator (free): nothing runs yet; it returns " +
  "the exact credits per episode. 4. versely_test_ai_creator_episode (paid, one episode): episode 1, never posted. " +
  "5. versely_list_ai_creator_episodes: show the take. 6. versely_approve_ai_creator: it goes live and spends one " +
  "episode's credits every day. Show the user every price and the daily schedule before the paid steps.";

const versely_list_ai_creator_options = defineTool({
  name: "versely_list_ai_creator_options",
  description:
    "The choices for an AI creator: a virtual creator (one avatar, one room, one voice) that makes a new short vertical " +
    "video every day and posts it to one of the user's connected social accounts at a daily time. FREE. Returns the " +
    "formats (what it posts), room settings and the price of a set of four rooms, voices (each with its language), " +
    "lengths and qualities with the credits per episode, caption styles, the user's own avatars and Versely's " +
    "ready-made avatars. To star the user's own face, make an avatar first with versely_upload_hook_character. " +
    FLOW,
  inputSchema: z.object({
    avatar_gender: z
      .enum(["female", "male", "nonbinary"])
      .optional()
      .describe("Only list ready-made avatars of this gender (the list is long)."),
  }),
  handler: async (input, ctx) => {
    const [opts, pub, mine, premade, ugcVoices] = await Promise.all([
      getOptions(ctx),
      settle(ctx.client.get(`${BASE}/public`)),
      settle(ctx.client.get(`/api/v1/hooks/characters`)),
      settle(ctx.client.get(`/api/v1/hooks/characters/premade`)),
      settle(ctx.client.get(`/api/v1/ugc/voices`)),
    ]);
    // The options' voices carry no language; the UGC voice list (same voices) does.
    const voiceInfo = unwrap(ugcVoices);
    const langLabel = new Map(
      (Array.isArray(voiceInfo.languages) ? voiceInfo.languages : []).map((l) => [String(rec(l).code), String(rec(l).label)]),
    );
    const voiceMeta = new Map(
      (Array.isArray(voiceInfo.voices) ? voiceInfo.voices : []).map((v) => {
        const r = rec(v);
        const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string" && t !== "multilingual") : [];
        return [String(r.id), { language: typeof r.language === "string" ? r.language : null, tags }] as const;
      }),
    );
    const own = (Array.isArray(rec(mine).characters) ? (rec(mine).characters as unknown[]) : []).map(rec).map((c) => {
      const portrait = (typeof c.image_url === "string" && c.image_url) || (typeof c.reference_image_url === "string" && c.reference_image_url) || null;
      const ready = !!portrait && c.status !== "generating" && c.status !== "failed";
      return {
        avatar_id: c.id,
        name: c.name,
        ready,
        ...(ready ? {} : { why_not: c.status === "generating" ? "still being drawn" : "no portrait chosen yet" }),
        portrait_url: portrait,
      };
    });
    const ready = (Array.isArray(rec(premade).avatars) ? (rec(premade).avatars as unknown[]) : [])
      .map(rec)
      .filter((a) => !input.avatar_gender || a.gender === input.avatar_gender)
      .map((a) => ({ avatar_id: a.id, name: a.name, gender: a.gender, age: a.age_band, style: a.style, portrait_url: a.image_url }));
    const table = rec(unwrap(pub).episodeCredits);
    return jsonResult({
      formats: (opts.formats ?? []).map((f) => ({
        format: f.id,
        label: f.label,
        description: f.description,
        ...(f.needsProduct ? { needs_product_url: true } : {}),
      })),
      room_settings: (opts.settings ?? []).map((s) => ({ setting: s.id, label: s.label })),
      rooms: {
        pictures_per_set: opts.roomOptions ?? 4,
        credits_per_set: opts.roomCredits ?? null,
        note: "'custom' needs a description of the room (note). Pictures that fail are refunded.",
      },
      voices: (opts.voices ?? []).map((v) => {
        const m = voiceMeta.get(v.id);
        return {
          voice: v.name,
          gender: v.gender ?? null,
          accent: v.accent && v.accent !== "Multilingual" ? v.accent : null,
          language: m?.language ? langLabel.get(m.language) ?? m.language : null,
          ...(m?.tags.length ? { tone: m.tags.join(", ") } : {}),
        };
      }),
      lengths_seconds: opts.lengths ?? [...LENGTHS],
      default_length_seconds: opts.defaultLength ?? 20,
      qualities: opts.qualities ?? [...QUALITIES],
      default_quality: opts.defaultQuality ?? "720p",
      ...(Object.keys(table).length
        ? {
            credits_per_episode: table,
            credits_per_episode_note:
              "By quality, then length in seconds, with a typical voice. The exact price depends on the voice too and is " +
              "returned by versely_create_ai_creator. Every episode is charged once when it is made, the test take included; " +
              "each post may cost a credit as well; versely_create_ai_creator returns the exact cost.",
          }
        : {}),
      caption_styles: [...CAPTION_STYLES],
      default_caption_style: DEFAULT_CAPTION_STYLE,
      your_avatars: own,
      ready_made_avatars: ready,
    });
  },
});

/**
 * How long versely_make_ai_creator_rooms waits for the four pictures. Hosts cut
 * a tool call at about a minute, so the wait ends before that with a pointer to
 * versely_get_ai_creator_rooms; the backend keeps drawing either way.
 */
const ROOMS_WAIT_MS = Number(process.env.VERSELY_ROOMS_WAIT_MS) > 0 ? Number(process.env.VERSELY_ROOMS_WAIT_MS) : 50_000;

/** Room pictures as a result: the text with the URLs, and a gallery card. */
function roomsResult(urls: string[], lead: string, taskId: string): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  return {
    content: [
      {
        type: "text",
        text:
          `${lead} Show them and let the user pick one; pass its URL as room_image_url to versely_create_ai_creator ` +
          "(or versely_update_ai_creator for an existing creator).\n" +
          urls.map((u, i) => `Room ${i + 1}: ${u}`).join("\n"),
      },
    ],
    structuredContent: {
      kind: "gallery",
      assets: urls.map((url, i) => ({ url, label: `Room ${i + 1}` })),
      status: "completed",
      task_id: taskId,
      aspect_ratio: "9:16",
    },
  };
}

const versely_get_ai_creator_rooms = defineTool({
  name: "versely_get_ai_creator_rooms",
  description:
    "The newest set of room pictures the user made for an AI creator (kept for a week), and whether a set is being " +
    "drawn right now. FREE. Use it when versely_make_ai_creator_rooms said the rooms were still being drawn, or to " +
    "find rooms made earlier, instead of paying for a new set.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    made_after: z
      .string()
      .optional()
      .describe("Only accept a set made after this time (ISO 8601), as given by versely_make_ai_creator_rooms."),
  }),
  handler: async (input, ctx) => {
    const out = unwrap(await ctx.client.get(`${BASE}/rooms`));
    const set = rec(out.rooms);
    const urls = (Array.isArray(set.images) ? set.images : [])
      .map((i) => rec(i).url)
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    const madeAt = typeof set.made_at === "string" ? set.made_at : "";
    const after = input.made_after ? Date.parse(input.made_after) : NaN;
    const fresh = urls.length > 0 && (!Number.isFinite(after) || Date.parse(madeAt) >= after);
    if (out.making === true && !fresh) {
      return { content: [{ type: "text", text: "The rooms are still being drawn. Check again in about a minute; do not make a new set." }], structuredContent: { kind: "gallery", assets: [], status: "info", message: "The rooms are still being drawn." } };
    }
    if (!fresh) {
      const text = urls.length
        ? "No new set of rooms was made: the pictures could not be drawn and their credits were refunded. The last set made earlier is still available (call again without made_after)."
        : "There is no set of rooms yet. Make one with versely_make_ai_creator_rooms.";
      return { content: [{ type: "text", text }], structuredContent: { kind: "gallery", assets: [], status: "info", message: text } };
    }
    const charged = typeof set.credits === "number" ? ` (${credits(set.credits)} charged)` : "";
    return roomsResult(urls, `${urls.length} room${urls.length === 1 ? "" : "s"} made${charged}.`, `rooms-${String(set.avatar_id ?? "")}`);
  },
});

const versely_make_ai_creator_rooms = defineTool({
  name: "versely_make_ai_creator_rooms",
  description:
    "Draw four vertical pictures of an AI creator's avatar in a kind of room (kitchen, study, gym... or a room the user " +
    "describes); the user picks one and it becomes the room of every episode. PAID: spends the price of a set of rooms " +
    "(credits_per_set in versely_list_ai_creator_options) once; pictures that fail are refunded. Call it only after the " +
    "user agreed to that price, passing it as confirm_credits. Takes about a minute. Show the pictures, then pass the " +
    "chosen URL as room_image_url to versely_create_ai_creator. Another set costs the same again.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    avatar_id: configFields.avatar_id,
    setting: z.enum(SETTINGS).describe("The kind of room, from versely_list_ai_creator_options; 'custom' takes the room from note."),
    note: z
      .string()
      .max(ROOM_NOTE_MAX)
      .optional()
      .describe("A few words on the room ('white tiles, lots of plants'). Required for 'custom'; added to every picture otherwise."),
    confirm_credits: ConfirmCredits("price of a set of rooms"),
  }),
  handler: async (input, ctx) => {
    if (input.setting === "custom" && (input.note ?? "").trim().length < 3) {
      return errorResult("Nothing made, nothing charged: a custom room needs a description in note.");
    }
    const opts = await getOptions(ctx);
    const price = opts.roomCredits;
    if (typeof price === "number" && price !== input.confirm_credits) {
      return errorResult(
        `Not made, nothing charged: a set of rooms now costs ${credits(price)} (you passed ${input.confirm_credits}). ` +
          `Show the user the new price and ask again; if they agree, call versely_make_ai_creator_rooms with confirm_credits: ${price}.`,
      );
    }
    const startedAt = new Date().toISOString();
    let res: unknown;
    try {
      res = await ctx.client.post(
        `${BASE}/rooms`,
        { avatarId: input.avatar_id, setting: input.setting, ...(input.note?.trim() ? { note: input.note.trim() } : {}) },
        { timeoutMs: ROOMS_WAIT_MS },
      );
    } catch (err) {
      const r = refusal(err);
      if (r?.status === 409) {
        return errorResult(`Not made, nothing charged: ${r.text} One set is made at a time; try again in a minute.`);
      }
      if (r) return errorResult(`Not made, nothing charged: ${r.text}`);
      if (err instanceof VerselyNetworkError) {
        // Not an error: the set is still being drawn and is kept for a week.
        return {
          content: [
            {
              type: "text",
              text:
                `The rooms are still being drawn (${credits(input.confirm_credits)} charged; pictures that fail are refunded). ` +
                `Do NOT call this again: check versely_get_ai_creator_rooms in about a minute with made_after: "${startedAt}". ` +
                "It returns the four pictures once they are done.",
            },
          ],
        };
      }
      throw err;
    }
    const out = unwrap(res);
    const urls = (Array.isArray(out.images) ? out.images : [])
      .map((i) => (typeof i === "string" ? i : rec(i).url))
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    const charged = typeof out.credits === "number" ? out.credits : input.confirm_credits;
    const short = urls.length < (opts.roomOptions ?? 4) ? ` ${(opts.roomOptions ?? 4) - urls.length} did not come back and were refunded.` : "";
    return {
      content: [
        {
          type: "text",
          text:
            `${urls.length} room${urls.length === 1 ? "" : "s"} made (${credits(charged)} charged).${short} Show them and let ` +
            "the user pick one; pass its URL as room_image_url to versely_create_ai_creator (or versely_update_ai_creator for " +
            "an existing creator).\n" +
            urls.map((u, i) => `Room ${i + 1}: ${u}`).join("\n"),
        },
      ],
      structuredContent: {
        kind: "gallery",
        assets: urls.map((url, i) => ({ url, label: `Room ${i + 1}` })),
        status: "completed",
        task_id: `rooms-${input.avatar_id}`,
        aspect_ratio: "9:16",
        toolName: "versely_make_ai_creator_rooms",
        toolArgs: input,
      },
    };
  },
});

/** The voice id for a voice name (accents and case ignored). */
function resolveVoice(opts: CreatorOptions, voice: string): string {
  const list = opts.voices ?? [];
  const exact = list.find((v) => v.id === voice.trim());
  if (exact) return exact.id;
  const hits = list.filter((v) => fold(v.name) === fold(voice));
  if (hits.length === 1) return hits[0]!.id;
  throw new Error(
    hits.length > 1
      ? `More than one voice is called "${voice}"; ask the user which one.`
      : `No voice called "${voice}". Use a voice name from versely_list_ai_creator_options.`,
  );
}

const versely_create_ai_creator = defineTool({
  name: "versely_create_ai_creator",
  description:
    "Create an AI creator from the user's choices. FREE: nothing is made, charged or posted yet; it waits in setup until " +
    "a test take is approved. Returns creator_id and the exact credits per episode (the test take and every daily episode " +
    "cost this). Needs a room from versely_make_ai_creator_rooms. The posting account and daily time can be set now or " +
    "later with versely_update_ai_creator, but both are needed before approval. Next: tell the user the price per episode, " +
    "then versely_test_ai_creator_episode.",
  inputSchema: z.object({
    name: z.string().min(1).max(80).optional().describe("A name for it (default: 'AI creator · <what it posts>')."),
    avatar_id: configFields.avatar_id,
    room_image_url: configFields.room_image_url,
    voice: configFields.voice,
    format: configFields.format,
    topic: configFields.topic.optional(),
    product_url: configFields.product_url.optional(),
    comment_word: configFields.comment_word.optional(),
    length_seconds: configFields.length_seconds.optional(),
    quality: configFields.quality.optional(),
    caption_style: configFields.caption_style.optional(),
    post_account_id: configFields.post_account_id.optional(),
    post_time: configFields.post_time.optional(),
    timezone: configFields.timezone.optional(),
  }),
  handler: async (input, ctx) => {
    if (input.format === "custom" && (input.topic ?? "").trim().length < 3) {
      return errorResult("Not created: a custom creator needs a topic (at least 3 characters).");
    }
    if (input.format === "product_demo" && !input.product_url) {
      return errorResult("Not created: a product demo needs product_url (the product page).");
    }
    if ((input.post_time === undefined) !== (input.timezone === undefined)) {
      return errorResult("Not created: pass post_time and timezone together (ask the user for their time zone).");
    }
    const opts = await getOptions(ctx);
    const voiceId = resolveVoice(opts, input.voice);
    const accounts = input.post_account_id ? await toProviderAccountIds(ctx, [input.post_account_id]) : [];
    const label = opts.formats?.find((f) => f.id === input.format)?.label ?? input.format;
    const what = input.format === "custom" ? clip(input.topic, 48) : label;
    const config: Record<string, unknown> = {
      avatarId: input.avatar_id,
      roomImageUrl: input.room_image_url,
      voiceId,
      format: input.format,
      topic: (input.topic ?? "").trim(),
      ...(input.product_url ? { productUrl: input.product_url } : {}),
      ...(input.comment_word ? { commentWord: input.comment_word.toUpperCase() } : {}),
      lengthSeconds: input.length_seconds ?? opts.defaultLength ?? 20,
      quality: input.quality ?? opts.defaultQuality ?? "720p",
      ...(input.caption_style ? { captionStyle: input.caption_style } : {}),
      post_account_ids: accounts.slice(0, 1),
    };
    let res: unknown;
    try {
      res = await ctx.client.post("/api/v1/automations", {
        kind: KIND,
        name: input.name ?? `AI creator · ${what}`.slice(0, 80),
        config,
        ...(input.post_time ? { schedule: { times: [input.post_time], timezone: input.timezone } } : {}),
      });
    } catch (err) {
      const r = refusal(err);
      if (r) return errorResult(`Not created: ${r.text}`);
      throw err;
    }
    const v = rec(unwrap(res).automation) as unknown as CreatorView;
    if (!v?.id) return jsonResult(res);
    const [account, post] = await Promise.all([accountLabel(ctx, accountIdOf(v)), postCredits(ctx)]);
    return {
      content: [{ type: "text", text: creatorText(v, [], undefined, account, post, "Created (free, nothing charged or posted).") }],
    };
  },
});

const versely_update_ai_creator = defineTool({
  name: "versely_update_ai_creator",
  description:
    "Change an AI creator: its name, avatar, room, voice, what it posts, length, quality, captions, the account it posts " +
    "to or its daily time. FREE. Only the fields given change. A new length, quality or voice changes the price per " +
    "episode: the result shows it, tell the user. In setup, make a new test take to see the change; a live creator stays " +
    "live and uses the change from its next episode, without a new test take. A new avatar needs a room made for it " +
    "(versely_make_ai_creator_rooms).",
  inputSchema: z.object({
    creator_id: CreatorId,
    name: z.string().min(1).max(80).optional(),
    avatar_id: configFields.avatar_id.optional(),
    room_image_url: configFields.room_image_url.optional(),
    voice: configFields.voice.optional(),
    format: configFields.format.optional(),
    topic: configFields.topic.optional().describe("What it posts about. Pass an empty string to clear it (not for custom)."),
    product_url: z.string().max(2048).optional().describe("Product demo's product page; an empty string removes it."),
    comment_word: z
      .string()
      .regex(/^([\p{L}\p{N}]{2,20})?$/u, "One word of 2-20 letters or digits, or empty.")
      .optional()
      .describe("Optional last line 'Comment WORD ...'; an empty string removes it."),
    length_seconds: configFields.length_seconds.optional(),
    quality: configFields.quality.optional(),
    caption_style: configFields.caption_style.optional(),
    post_account_id: configFields.post_account_id.optional(),
    post_time: configFields.post_time.optional(),
    timezone: configFields.timezone.optional(),
  }),
  handler: async (input, ctx) => {
    const current = await getCreator(ctx, input.creator_id);
    const changes: Record<string, unknown> = {};
    const drop: string[] = [];
    if (input.avatar_id !== undefined) changes.avatarId = input.avatar_id;
    if (input.room_image_url !== undefined) changes.roomImageUrl = input.room_image_url;
    if (input.voice !== undefined) changes.voiceId = resolveVoice(await getOptions(ctx), input.voice);
    if (input.format !== undefined) changes.format = input.format;
    if (input.topic !== undefined) changes.topic = input.topic.trim();
    if (input.product_url !== undefined) {
      if (input.product_url.trim()) changes.productUrl = input.product_url.trim();
      else drop.push("productUrl", "product_url");
    }
    if (input.comment_word !== undefined) {
      if (input.comment_word) changes.commentWord = input.comment_word.toUpperCase();
      else drop.push("commentWord", "comment_word");
    }
    if (input.length_seconds !== undefined) changes.lengthSeconds = input.length_seconds;
    if (input.quality !== undefined) changes.quality = input.quality;
    if (input.caption_style !== undefined) changes.captionStyle = input.caption_style;
    if (input.post_account_id !== undefined) {
      changes.post_account_ids = await toProviderAccountIds(ctx, [input.post_account_id]);
    }

    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (Object.keys(changes).length > 0 || drop.length > 0) {
      // PATCH replaces the whole config: carry everything else over.
      const merged: Record<string, unknown> = { ...(current.config ?? {}), ...changes };
      for (const k of drop) delete merged[k];
      body.config = merged;
    }
    if (input.post_time !== undefined || input.timezone !== undefined) {
      const time = input.post_time ?? current.schedule?.times?.[0];
      const zone = input.timezone ?? current.schedule?.timezone;
      if (!time || !zone) return errorResult("Not changed: pass both post_time and timezone (no daily time is set yet).");
      body.schedule = { times: [time], timezone: zone };
    }
    if (Object.keys(body).length === 0) return errorResult("Nothing to change: pass at least one setting.");

    let res: unknown;
    try {
      res = await ctx.client.patch(`/api/v1/automations/${enc(input.creator_id)}`, body);
    } catch (err) {
      const r = refusal(err);
      if (r) return errorResult(`Not changed: ${r.text}`);
      throw err;
    }
    const v = rec(unwrap(res).automation) as unknown as CreatorView;
    if (!v?.id) return jsonResult(res);
    const before = current.credits_per_run;
    const after = v.credits_per_run;
    const moved =
      typeof before === "number" && typeof after === "number" && before !== after
        ? ` The price per episode is now ${credits(after)} (was ${before}); tell the user.`
        : "";
    const when =
      v.phase === "approved"
        ? " It stays live; the change applies from its next episode."
        : " Nothing is made until the next test take.";
    const timeNote =
      body.schedule && v.phase === "approved" ? " An episode already booked keeps its time; the ones after it use the new time." : "";
    const [account, post] = await Promise.all([accountLabel(ctx, accountIdOf(v)), postCredits(ctx)]);
    const eps = await settle(getEpisodes(ctx, v.id));
    return {
      content: [{ type: "text", text: creatorText(v, eps ?? [], undefined, account, post, `Updated (free).${moved}${when}${timeNote}`) }],
    };
  },
});

const versely_test_ai_creator_episode = defineTool({
  name: "versely_test_ai_creator_episode",
  description:
    "Make a test take of an AI creator: episode 1, a full episode that is shown to the user and never posted. PAID: " +
    "spends the creator's price per episode once (refunded if it fails). Call it only after the user has agreed to that " +
    "price, passing it as confirm_credits (from versely_create_ai_creator or versely_list_ai_creator_episodes); a changed " +
    "price is refused with the new one, nothing charged. It takes a few minutes in the background; the card follows it, " +
    "otherwise check versely_list_ai_creator_episodes. Another take costs the same again: start one only when the user " +
    "asks. Approve a take with versely_approve_ai_creator.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    creator_id: CreatorId,
    confirm_credits: ConfirmCredits("price per episode"),
  }),
  handler: async (input, ctx) => {
    const v = await getCreator(ctx, input.creator_id);
    const price = v.credits_per_run;
    if (typeof price !== "number") {
      return errorResult(
        `Not made, nothing charged: this creator's settings need attention (${v.summary ?? "unreadable settings"}). ` +
          "Fix them with versely_update_ai_creator.",
      );
    }
    if (price !== input.confirm_credits) {
      return errorResult(
        `Not made, nothing charged: an episode of this creator now costs ${credits(price)} (you passed ${input.confirm_credits}). ` +
          `Show the user the new price and ask again; if they agree, call versely_test_ai_creator_episode with confirm_credits: ${price}.`,
      );
    }
    let res: unknown;
    try {
      res = await ctx.client.post(`${BASE}/${enc(input.creator_id)}/test-episode`, {});
    } catch (err) {
      const r = refusal(err);
      if (r?.status === 409) {
        return errorResult(
          `Not started, nothing charged: ${r.text} Follow it with versely_list_ai_creator_episodes { creator_id: ${JSON.stringify(input.creator_id)} }.`,
        );
      }
      if (r) return errorResult(`Not started, nothing charged: ${r.text}`);
      throw err;
    }
    const ep = rec(unwrap(res).episode);
    const episode: Episode = {
      id: typeof ep.id === "string" ? ep.id : `take-${input.creator_id}`,
      status: "making",
      createdAt: new Date().toISOString(),
    };
    return {
      content: [
        {
          type: "text",
          text:
            `Test take of "${v.name}" started (episode_id ${episode.id}): ${credits(price)}, charged once its script is ` +
            "written and refunded if it fails. It usually takes a few minutes and is not posted. The card updates by itself; " +
            `otherwise check versely_list_ai_creator_episodes { creator_id: ${JSON.stringify(v.id)}, episode_id: ${JSON.stringify(episode.id)} } ` +
            "in a few minutes. It is NOT finished yet; do not start another take.",
        },
      ],
      structuredContent: episodesCard(v, [episode], episode, "versely_test_ai_creator_episode", input),
    };
  },
});

const versely_list_ai_creator_episodes = defineTool({
  name: "versely_list_ai_creator_episodes",
  description:
    "Get an AI creator and its episodes, newest first: whether it is in setup, live or paused, the price per episode, " +
    "the daily time and account, and each episode's status (making, ready, scheduled, posted, failed), title, video and " +
    "lines, with the next step. FREE. The card follows an episode being made by itself, so don't call this in a loop; " +
    "check again every few minutes only when you need the result. Find creators with versely_list_automations.",
  // Visible to the app too: the episode card's poll loop calls this tool.
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({
    creator_id: CreatorId,
    episode_id: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("The episode to focus on (default: the one being made, else the newest)."),
  }),
  handler: async (input, ctx) => {
    const [v, eps] = await Promise.all([getCreator(ctx, input.creator_id), getEpisodes(ctx, input.creator_id)]);
    const focus =
      (input.episode_id ? eps.find((e) => e.id === input.episode_id) : undefined) ??
      eps.find((e) => e.status === "making") ??
      eps[0];
    // While the card polls an episode being made, skip the account and plan reads: two calls fewer per poll.
    const [account, post] =
      focus?.status === "making" ? [null, null] : await Promise.all([accountLabel(ctx, accountIdOf(v)), postCredits(ctx)]);
    return {
      content: [{ type: "text", text: creatorText(v, eps, focus, account, post) }],
      structuredContent: episodesCard(v, eps, focus, "versely_list_ai_creator_episodes", input),
    };
  },
});

const versely_approve_ai_creator = defineTool({
  name: "versely_approve_ai_creator",
  description:
    "Approve an AI creator's test take and make it live: from then on it makes a new episode every day, about 3 hours " +
    "before its daily time, and posts it to its account without asking again. PAID on a schedule: every episode spends " +
    "the price per episode when it is made, and each post may cost a credit as well (versely_list_ai_creator_episodes shows the exact cost). " +
    "Call it only after the user has watched the newest take and agreed to the daily schedule and the price, passing " +
    "that price as confirm_credits; a changed price is refused, nothing started. post_test_episode: true also posts the " +
    "approved take as the first video. It pauses by itself when credits run short or after 3 failed episodes in a row. " +
    "Afterwards: versely_pause_automation, versely_start_automation, versely_run_automation_now, versely_delete_automation.",
  inputSchema: z.object({
    creator_id: CreatorId,
    confirm_credits: ConfirmCredits("price per episode"),
    post_test_episode: z
      .boolean()
      .optional()
      .describe("Also post the approved test take, on the first free day at the daily time (default false)."),
  }),
  handler: async (input, ctx) => {
    const [v, eps] = await Promise.all([getCreator(ctx, input.creator_id), getEpisodes(ctx, input.creator_id)]);
    const id = JSON.stringify(v.id);
    if (v.phase === "approved") {
      return errorResult(
        `Nothing changed: "${v.name}" is already approved (${stateText(v)}). Resume a paused one with versely_start_automation { automation_id: ${id} }.`,
      );
    }
    const price = v.credits_per_run;
    if (typeof price !== "number") {
      return errorResult(`Not approved: this creator's settings need attention (${v.summary ?? "unreadable settings"}). Fix them with versely_update_ai_creator.`);
    }
    if (price !== input.confirm_credits) {
      return errorResult(
        `Not approved, nothing started: each episode now costs ${credits(price)} (you passed ${input.confirm_credits}). ` +
          `Show the user the new price and the schedule and ask again; if they agree, call versely_approve_ai_creator with confirm_credits: ${price}.`,
      );
    }
    if (!scheduleText(v.schedule) || !accountIdOf(v)) {
      return errorResult(
        "Not approved: set the account it posts to and its daily time first, with versely_update_ai_creator " +
          "(post_account_id, post_time, timezone), and tell the user.",
      );
    }
    if (eps[0]?.status === "making") {
      return errorResult(
        `Not approved: the newest test take is still being made. Wait for it, show it to the user, then approve. Check with versely_list_ai_creator_episodes { creator_id: ${id} }.`,
      );
    }
    const take = eps.find((e) => e.status === "ready" && isMade(e));
    if (!take) {
      return errorResult(
        `Not approved: there is no finished test take. Make one first with versely_test_ai_creator_episode { creator_id: ${id}, confirm_credits: ${price} }.`,
      );
    }
    let res: unknown;
    try {
      res = await ctx.client.post(`${BASE}/${enc(input.creator_id)}/approve`, { postTestEpisode: input.post_test_episode === true });
    } catch (err) {
      const r = refusal(err);
      if (r) return errorResult(`Not approved: ${r.text}`);
      throw err;
    }
    const live = (rec(unwrap(res).automation).id ? rec(unwrap(res).automation) : v) as unknown as CreatorView;
    const [account, post] = await Promise.all([accountLabel(ctx, accountIdOf(live)), postCredits(ctx)]);
    const when = scheduleText(live.schedule) ?? scheduleText(v.schedule);
    const first = live.next_post_at ? ` The first post is booked for ${live.next_post_at}.` : "";
    const testPost = input.post_test_episode
      ? ` The approved take "${take.title ?? "episode 1"}" is booked as the first post${typeof post === "number" && post > 0 ? ` (${credits(post)})` : ""}.`
      : "";
    const paused = live.status !== "active" ? ` It is not running yet (${stateText(live)}); resume it with versely_start_automation { automation_id: ${id} }.` : "";
    return {
      content: [
        {
          type: "text",
          text:
            `Approved: "${live.name}" is live. Every day it makes a new episode about ${MAKE_AHEAD_HOURS} hours before ${when ?? "its daily time"} ` +
            `and posts it to ${account ?? "its account"}. Cost: ${priceText(price, post)}, charged as each episode is made ` +
            `(refunded if it fails).${first}${testPost}${paused} It pauses by itself when credits run short or after 3 failed ` +
            `episodes in a row. Pause it with versely_pause_automation { automation_id: ${id} }, resume with ` +
            "versely_start_automation, follow its episodes with versely_list_ai_creator_episodes.",
        },
      ],
    };
  },
});

export const aiCreatorTools: Tool[] = [
  versely_list_ai_creator_options,
  versely_make_ai_creator_rooms,
  versely_get_ai_creator_rooms,
  versely_create_ai_creator,
  versely_update_ai_creator,
  versely_test_ai_creator_episode,
  versely_list_ai_creator_episodes,
  versely_approve_ai_creator,
];
