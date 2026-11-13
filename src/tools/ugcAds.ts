// UGC ads (backend /ugc/actors, /ugc/voices, /ugc/script, /ugc/ads*, web
// "UGC ads"): a presenter on camera reads the user's script, as a 9:16 video
// with optional word-by-word captions. Three formats: talking_head (straight
// to camera), product_in_hand (holding the user's product, from a product
// photo) and show_your_app (holding a phone showing the user's app, from a
// screenshot). One batch = the same script read by 1-4 presenters, one ad
// each, charged ONCE up front; an ad that fails is refunded its share.
//
//   GET  /ugc/actors        presenters (public; see "Contract notes")
//   GET  /ugc/voices        voices (public)
//   POST /ugc/script        three script options (free: credits_charged 0)
//   GET  /ugc/ads/quote     price of ONE ad for one presenter (free)
//   POST /ugc/ads           start a batch (PAID, 202 { batch_id, credits_charged, ads })
//   GET  /ugc/ads/:batch_id the batch's ads (status, video_url once completed)
//   GET  /ugc/ads           the user's recent ads (kept 14 days)
//
// Contract notes (backend main, 2026-11-14):
//   - POST /ugc/ads takes no confirm_credits. The paid tool re-prices the batch
//     with the quote endpoint right before it posts, and refuses when that
//     differs from the price the user approved.
//   - The quote prices one presenter (count multiplies it). Presenters can
//     differ in price (engine, default voice), so the batch is priced one
//     presenter at a time and summed.
//   - /ugc/actors and /ugc/voices run optionalAuth, which only reads app
//     (Supabase) sessions: an MCP OAuth token or vsk_ key is not seen there, so
//     the user's own avatars and cloned voices never come back from them. They
//     are read from /hooks/characters and /audio/elevenlabs-clones instead.
//   - A user's avatar (hook character) has no default voice unless one of the
//     user's cloned voices is linked to it; the backend then speaks in that
//     clone, else in the house default voice. The quote cannot see that link,
//     so the tool passes the linked clone to the quote explicitly.
//   - Stock presenters with ids `hg-*` render on an engine that can only make
//     talking_head ads; the backend's refusal names that engine, so the tools
//     refuse locally first.
// No provider or engine names in anything the model reads.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { metaForMediaCard } from "../ui/templates.js";

// --- Backend shapes ----------------------------------------------------------

const FORMATS = ["talking_head", "product_in_hand", "show_your_app"] as const;
type UgcFormat = (typeof FORMATS)[number];
const RESOLUTIONS = ["480p", "720p"] as const;
const CAPTION_STYLES = ["karaoke", "highlight", "pop", "typewriter", "none"] as const;
const TONES = ["casual", "excited", "calm", "expert", "funny"] as const;

const MAX_ADS = 4;
const SCRIPT_MIN = 10;
const SCRIPT_MAX = 1500;
const MAX_SPEECH_SECONDS = 60;
/** The backend's speech estimate: 15 characters a second, cues not counted. */
const CHARS_PER_SECOND = 15;

type AdStatus = "queued" | "voice" | "frame" | "video" | "captioning" | "completed" | "failed";

interface UgcActor {
  id: string;
  name: string;
  gender?: string;
  age_band?: string;
  setting?: string;
  style?: string;
  image_url?: string;
  preview_video_url?: string | null;
  default_voice_id?: string | null;
  source?: string;
}

interface UgcVoice {
  id: string;
  name: string;
  language?: string;
  accent?: string;
  gender?: string;
  tags?: string[];
  mine?: boolean;
}

interface ClonedVoice {
  id: string;
  voice_id: string;
  name: string;
  language?: string | null;
  character_id?: string | null;
  created_at?: string;
}

interface HookCharacter {
  id: string;
  name?: string;
  description?: string | null;
  status?: string;
  image_url?: string | null;
  reference_image_url?: string | null;
}

interface UgcAd {
  id: string;
  batch_id: string;
  actor_id: string;
  actor_name: string;
  format: string;
  status: AdStatus;
  script?: string;
  resolution?: string;
  video_url?: string | null;
  duration_s?: number | null;
  error?: string | null;
  created_at?: string;
}

interface AdQuote {
  credits_per_ad: number;
  total: number;
  breakdown?: { voice?: number; frame?: number; video?: number; captions?: number };
  est_seconds: number;
}

/** `{ success, data }` (the UGC ads controller), tolerating an unwrapped body. */
function dataOf<T>(res: unknown): T {
  const r = (res ?? {}) as Record<string, unknown>;
  return ((r.data && typeof r.data === "object" ? r.data : r) as T);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The backend's actor id check (catalog slugs or the user's avatar uuids). */
const ACTOR_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Stock presenters that can only make talking_head ads. */
const talkingHeadOnly = (id: string) => /^hg-/i.test(id);

// The backend's spoken-text rules (ugcAds.core stripInlineCues / estimateSpeechSeconds).
const CUE_RE = /\[[^\]\n]{1,40}\]|<[a-z][a-z _-]{0,30}>/gi;
function stripCues(text: string): string {
  return text.replace(CUE_RE, " ").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}
function normalizeScript(script: string): string {
  return script.replace(/\r\n?/g, "\n").trim();
}
function speechSeconds(chars: number): number {
  return Math.max(1, Math.ceil(chars / CHARS_PER_SECOND));
}

function credits(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}

function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// --- The user's own avatars and cloned voices --------------------------------

const CHARACTERS_PATH = "/api/v1/hooks/characters";
const CLONES_PATH = "/api/v1/audio/elevenlabs-clones";

/** The user's avatars that have a face (what the backend accepts as a presenter). Empty on any error. */
async function ownAvatars(ctx: ToolContext): Promise<HookCharacter[]> {
  try {
    const res = await ctx.client.get<{ characters?: HookCharacter[] }>(CHARACTERS_PATH);
    const list = Array.isArray(res?.characters) ? res.characters : [];
    return list.filter((c) => c && typeof c.id === "string" && (c.image_url || c.reference_image_url));
  } catch {
    return [];
  }
}

/** The user's cloned voices (made in the Versely app). Empty on any error. */
async function ownClones(ctx: ToolContext): Promise<ClonedVoice[]> {
  try {
    const list = dataOf<{ clones?: ClonedVoice[] }>(await ctx.client.get(CLONES_PATH)).clones;
    return Array.isArray(list) ? list.filter((c) => c && typeof c.voice_id === "string") : [];
  } catch {
    return [];
  }
}

/** avatar id -> the newest cloned voice linked to it (the voice the backend speaks it in). */
function cloneByAvatar(clones: ClonedVoice[]): Map<string, string> {
  const out = new Map<string, string>();
  const oldestFirst = [...clones].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  for (const c of oldestFirst) if (c.character_id) out.set(c.character_id, c.voice_id);
  return out;
}

// --- Pricing -------------------------------------------------------------------

interface PriceInput {
  actor_ids: string[];
  voice_id?: string;
  format: UgcFormat;
  resolution?: string;
  captions?: boolean;
  /** The exact script (exact price) ... */
  script?: string;
  /** ... or a length in seconds (estimate). */
  seconds?: number;
}

interface Priced {
  total: number;
  per_ad: Array<{ actor_id: string; credits: number }>;
  est_seconds: number;
}

/**
 * The batch's price: one quote per distinct presenter (and voice), summed per
 * ad. Mirrors what POST /ugc/ads charges: each ad is priced for its presenter
 * and for the voice it will speak in (the chosen voice, else the presenter's
 * own, else, for the user's avatars, its linked cloned voice).
 */
async function priceAds(ctx: ToolContext, p: PriceInput): Promise<Priced> {
  const length: Record<string, number> = {};
  if (p.script !== undefined) {
    length.script_chars = stripCues(normalizeScript(p.script)).length;
  } else {
    length.est_seconds = Math.ceil(p.seconds ?? 30);
  }
  const needsLinks = !p.voice_id && p.actor_ids.some((id) => UUID_RE.test(id));
  const linked = needsLinks ? cloneByAvatar(await ownClones(ctx)) : new Map<string, string>();

  const cache = new Map<string, Promise<AdQuote>>();
  const quoteFor = (actorId: string): Promise<AdQuote> => {
    const voice = p.voice_id ?? linked.get(actorId);
    const key = `${actorId}|${voice ?? ""}`;
    let q = cache.get(key);
    if (!q) {
      q = ctx.client
        .get("/api/v1/ugc/ads/quote", {
          query: {
            actor_id: actorId,
            format: p.format,
            count: 1,
            ...(voice ? { voice_id: voice } : {}),
            ...(p.resolution ? { resolution: p.resolution } : {}),
            ...(p.captions !== undefined ? { captions: p.captions } : {}),
            ...length,
          },
        })
        .then((res) => dataOf<AdQuote>(res));
      cache.set(key, q);
    }
    return q;
  };

  const quotes = await Promise.all(p.actor_ids.map(quoteFor));
  const per_ad = quotes.map((q, i) => ({ actor_id: p.actor_ids[i]!, credits: Number(q.credits_per_ad) }));
  if (per_ad.some((a) => !Number.isFinite(a.credits))) throw new Error("The price could not be read. Try again.");
  return {
    total: per_ad.reduce((s, a) => s + a.credits, 0),
    per_ad,
    est_seconds: Number(quotes[0]?.est_seconds) || 0,
  };
}

/** Input checks the backend makes too, worded for the assistant (and without engine names). */
function checkRequest(p: {
  actor_ids: string[];
  format: UgcFormat;
  script?: string;
  product_image_url?: string;
  app_screenshot_url?: string;
  forCreate: boolean;
}): string | null {
  const bad = p.actor_ids.filter((id) => !ACTOR_ID_RE.test(id));
  if (bad.length) return `Not a presenter id: ${bad.join(", ")}. Use ids from versely_list_ugc_actors.`;
  if (p.format !== "talking_head") {
    const thOnly = p.actor_ids.filter(talkingHeadOnly);
    if (thOnly.length) {
      return (
        `${thOnly.join(", ")} can only make talking_head ads, not ${p.format}. Pick other presenters ` +
        `(versely_list_ugc_actors with format: "${p.format}" lists the ones that can) or use talking_head.`
      );
    }
  }
  if (p.script !== undefined) {
    const spoken = stripCues(normalizeScript(p.script));
    if (spoken.length < SCRIPT_MIN) return "The script has nothing to say once the [cues] are removed.";
    const secs = speechSeconds(spoken.length);
    if (secs > MAX_SPEECH_SECONDS) {
      return `The script is about ${secs} s of speech; an ad can be at most ${MAX_SPEECH_SECONDS} s (about 150 words). Shorten it.`;
    }
  }
  if (p.forCreate) {
    if (p.format === "product_in_hand" && !p.product_image_url) {
      return "product_in_hand needs product_image_url: a public https link to a photo of the product.";
    }
    if (p.format === "show_your_app" && !p.app_screenshot_url) {
      return "show_your_app needs app_screenshot_url: a public https link to a screenshot of the app.";
    }
  }
  return null;
}

function settingsLine(p: { count: number; format: string; resolution?: string; captions?: boolean; est_seconds: number }): string {
  return [
    `${p.count} ad${p.count === 1 ? "" : "s"}`,
    p.format,
    p.resolution ?? "720p",
    p.captions === false ? "no captions" : "captions on",
    p.est_seconds ? `about ${p.est_seconds} s each` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

// --- Card ------------------------------------------------------------------------

const ADS_POLL = { interval_ms: 10_000, timeout_ms: 45 * 60_000 };
const STAGE_PROGRESS: Record<AdStatus, number> = {
  queued: 0.05,
  voice: 0.15,
  frame: 0.3,
  video: 0.55,
  captioning: 0.9,
  completed: 1,
  failed: 1,
};
const STAGE_WORDS: Record<AdStatus, string> = {
  queued: "waiting to start",
  voice: "recording the voice",
  frame: "preparing the first frame",
  video: "filming",
  captioning: "adding captions",
  completed: "ready",
  failed: "failed",
};
const isDone = (s: AdStatus) => s === "completed" || s === "failed";

/**
 * A batch as text + media-card state: pending (polling versely_get_ugc_ads)
 * until every ad has settled, then the finished videos, or failed when none
 * could be made.
 */
function batchResult(
  batchId: string,
  ads: UgcAd[],
  opts: { toolName: string; toolArgs: Record<string, unknown>; lead?: string },
): ToolResult {
  const ready = ads.filter((a) => a.status === "completed" && a.video_url);
  const failed = ads.filter((a) => a.status === "failed");
  const pending = ads.length === 0 || ads.some((a) => !isDone(a.status));
  const cardStatus = pending ? "pending" : ready.length ? "completed" : "failed";
  const many = ads.length > 1;
  const assets = ready.map((a) => ({ url: String(a.video_url), label: many ? `${a.actor_name} · ad ${ads.indexOf(a) + 1}` : a.actor_name }));
  const progress = ads.length ? ads.reduce((s, a) => s + (STAGE_PROGRESS[a.status] ?? 0), 0) / ads.length : 0.02;

  const lines: string[] = [];
  if (opts.lead) lines.push(opts.lead, "");
  lines.push(`UGC ads batch ${batchId}: ${ready.length} of ${ads.length || "?"} ready${failed.length ? `, ${failed.length} failed` : ""}.`);
  ads.forEach((a, i) => {
    const what =
      a.status === "completed"
        ? `${a.video_url}${a.duration_s ? ` (${Math.round(a.duration_s)} s)` : ""}`
        : a.status === "failed"
          ? `failed${a.error ? ` (${clip(a.error, 160)})` : ""}; its share of the credits was refunded`
          : STAGE_WORDS[a.status] ?? a.status;
    lines.push(`${i + 1}. ${a.actor_name} (${a.format}): ${what}`);
  });
  if (pending) {
    lines.push(
      "",
      `Not finished yet: ads take a few minutes (longer scripts take longer). If a preview card is shown it updates on its own; ` +
        `otherwise check versely_get_ugc_ads with batch_id="${batchId}" again in a minute or two. Do not create these ads again.`,
    );
  }

  const failedText = failed.map((a) => `${a.actor_name}: ${clip(a.error, 160) || "failed"}`).join("; ");
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: assets.length > 1 || (pending && many) ? "gallery" : "video",
      assets,
      status: cardStatus,
      task_id: batchId,
      aspect_ratio: "9:16",
      title: "UGC ads",
      ...(pending
        ? {
            progress: Math.min(0.95, Math.max(0.02, progress)),
            message: `Making ${ads.length > 1 ? `${ads.length} UGC ads` : "your UGC ad"}: a few minutes.`,
            poll: { tool_name: "versely_get_ugc_ads", args: { batch_id: batchId }, ...ADS_POLL },
          }
        : {}),
      ...(cardStatus === "failed" ? { error: `No ad could be made (${failedText || "unknown error"}). The credits were refunded.` } : {}),
      toolName: opts.toolName,
      toolArgs: opts.toolArgs,
    },
  };
}

// --- Inputs ------------------------------------------------------------------------

const ActorIds = z
  .array(z.string().min(2).max(64))
  .min(1)
  .max(MAX_ADS)
  .describe(
    "1-4 presenter ids from versely_list_ugc_actors, one ad each; every presenter reads the same script. " +
      "The user's own avatars (character ids from versely_list_hook_characters or versely_add_ready_made_avatar) work too.",
  );
const VoiceId = z
  .string()
  .min(3)
  .max(80)
  .optional()
  .describe(
    "One voice id from versely_list_ugc_voices, used for every ad. Leave it out and each Versely presenter speaks in " +
      "their own matching voice. The user's own avatars have no voice of their own unless one of the user's cloned " +
      "voices is linked to them; otherwise the default voice (a woman's) is used, so pick a voice that fits them.",
  );
const Format = z
  .enum(FORMATS)
  .optional()
  .describe(
    "'talking_head' (default): the presenter talks straight to camera. 'product_in_hand': they hold the user's " +
      "product (needs product_image_url). 'show_your_app': they hold a phone showing the user's app (needs " +
      "app_screenshot_url). The two product formats cost a little more per ad.",
  );
const Resolution = z.enum(RESOLUTIONS).optional().describe("'720p' (default) or '480p' (costs less).");
const Captions = z.boolean().optional().describe("Burn word-by-word captions on (default true; a few credits per ad).");
const Script = z
  .string()
  .min(SCRIPT_MIN)
  .max(SCRIPT_MAX)
  .describe(
    "Exactly what the presenter says: 10-1500 characters and at most about 60 seconds of speech (~150 words). " +
      "Short cues in square brackets such as [laughs] are performed by most voices and never read out.",
  );

const PAID_FLOW =
  "Flow: pick presenters (versely_list_ugc_actors) and optionally a voice (versely_list_ugc_voices); write or " +
  "polish the script (versely_write_ugc_script is free); price it with versely_quote_ugc_ads; show the user the " +
  "script, the presenters and the exact price; only after they say yes call versely_create_ugc_ads with the same " +
  "settings and confirm_credits.";

// --- Tools -------------------------------------------------------------------------

const versely_list_ugc_actors = defineTool({
  name: "versely_list_ugc_actors",
  description:
    "The presenters for UGC ads (versely_create_ugc_ads): Versely's cast of people filmed in everyday settings " +
    "(selfie, car, kitchen, gym, office...) and the user's own avatars (source 'yours'). Each has a portrait and, " +
    "for many Versely presenters, a short preview video. Some stock presenters can only make talking_head ads " +
    "(talking_head_only); pass format to list only the ones that can make that format. FREE. Show the user a few " +
    "that fit their product and audience, then pass the chosen ids as actor_ids to versely_quote_ugc_ads. The " +
    "user's avatars are managed with versely_list_hook_characters; ready-made people can be added as avatars with " +
    "versely_add_ready_made_avatar.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    gender: z.enum(["female", "male", "nonbinary"]).optional(),
    age_band: z.enum(["18-24", "25-34", "35-44", "45-54", "55+"]).optional(),
    setting: z.string().max(30).optional().describe("Where they are filmed, e.g. selfie, car, kitchen, bedroom, gym, street, office, cafe, outdoors, podcast, studio."),
    source: z.enum(["versely", "yours"]).optional().describe("'versely': Versely's presenters only. 'yours': only the user's own avatars."),
    format: z.enum(FORMATS).optional().describe("Only presenters that can make this format."),
    q: z.string().max(60).optional().describe("Only presenters whose name or style contains this."),
    limit: z.number().int().min(1).max(100).optional().describe("Default 24."),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (input, ctx) => {
    const [catalogRes, avatars, clones] = await Promise.all([
      ctx.client.get("/api/v1/ugc/actors"),
      ownAvatars(ctx),
      ownClones(ctx),
    ]);
    const catalog = dataOf<{ actors?: UgcActor[] }>(catalogRes).actors ?? [];
    const linked = cloneByAvatar(clones);
    type Row = Record<string, unknown> & { id: string; name: string };
    const rows: Row[] = [];
    const seen = new Set<string>();
    for (const a of catalog) {
      if (!a?.id || seen.has(a.id)) continue;
      seen.add(a.id);
      const yours = a.source === "custom";
      rows.push({
        id: a.id,
        name: a.name,
        source: yours ? "yours" : "versely",
        gender: a.gender,
        age_band: a.age_band,
        setting: a.setting,
        style: a.style,
        portrait_url: a.image_url,
        ...(a.preview_video_url ? { preview_video_url: a.preview_video_url } : {}),
        ...(talkingHeadOnly(a.id) ? { talking_head_only: true } : {}),
        ...(yours ? { voice: linked.has(a.id) || a.default_voice_id ? "the user's cloned voice" : "none of its own: pick one" } : {}),
      });
    }
    for (const c of avatars) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      rows.push({
        id: c.id,
        name: c.name || "My avatar",
        source: "yours",
        style: clip(c.description, 120) || "The user's avatar",
        portrait_url: c.image_url || c.reference_image_url,
        voice: linked.has(c.id) ? "the user's cloned voice" : "none of its own: pick one",
      });
    }

    const q = input.q?.trim().toLowerCase();
    const setting = input.setting?.trim().toLowerCase().replace(/\s+/g, "_");
    const matches = rows.filter(
      (r) =>
        (!input.source || r.source === input.source) &&
        (!input.gender || r.gender === input.gender) &&
        (!input.age_band || r.age_band === input.age_band) &&
        (!setting || r.setting === setting) &&
        (!input.format || input.format === "talking_head" || !r.talking_head_only) &&
        (!q || `${r.name} ${r.style ?? ""}`.toLowerCase().includes(q)),
    );
    const offset = input.offset ?? 0;
    const page = matches.slice(offset, offset + (input.limit ?? 24));
    const facet = (key: string) => [...new Set(rows.map((r) => r[key]).filter((v): v is string => typeof v === "string"))];
    const result = jsonResult({
      total: matches.length,
      shown: page.length,
      offset,
      actors: page,
      settings: facet("setting"),
      next:
        "Pass the chosen ids as actor_ids (1-4, one ad each) to versely_quote_ugc_ads, then versely_create_ugc_ads." +
        (matches.length > offset + page.length ? ` More with offset: ${offset + page.length}.` : ""),
    });
    const assets = page
      .filter((r) => typeof r.portrait_url === "string" && r.portrait_url)
      .map((r) => ({ url: String(r.portrait_url), label: `${r.name} (${r.id})` }));
    return assets.length
      ? { ...result, structuredContent: { kind: "gallery", status: "completed", assets, title: "UGC ad presenters" } }
      : result;
  },
});

const versely_list_ugc_voices = defineTool({
  name: "versely_list_ugc_voices",
  description:
    "The voices a UGC ad can be spoken in, by language, accent, gender and style, with the user's own cloned " +
    "voices first (yours: true; they are made in the Versely app, cloning is not offered here). Voices tagged " +
    "'multilingual' speak any listed language. FREE. Pass a voice's id as voice_id to versely_quote_ugc_ads and " +
    "versely_create_ugc_ads; without one, each Versely presenter uses their own matching voice.",
  inputSchema: z.object({
    language: z.string().min(2).max(12).optional().describe("A language code such as 'en', 'es', 'hi'; multilingual voices are included."),
    gender: z.enum(["female", "male"]).optional(),
    q: z.string().max(60).optional().describe("Only voices whose name, accent or style contains this (e.g. 'British', 'warm')."),
    limit: z.number().int().min(1).max(100).optional().describe("Default 50."),
  }),
  handler: async (input, ctx) => {
    const [catalogRes, clones] = await Promise.all([ctx.client.get("/api/v1/ugc/voices"), ownClones(ctx)]);
    const payload = dataOf<{ voices?: UgcVoice[]; languages?: Array<{ code: string; label: string }> }>(catalogRes);
    const rows: Array<Record<string, unknown> & { id: string }> = [];
    const seen = new Set<string>();
    const push = (v: UgcVoice, yours: boolean) => {
      if (!v?.id || seen.has(v.id)) return;
      seen.add(v.id);
      rows.push({
        id: v.id,
        name: v.name,
        language: v.language,
        ...(v.accent ? { accent: v.accent } : {}),
        ...(v.gender ? { gender: v.gender } : {}),
        ...(v.tags?.length ? { tags: v.tags } : {}),
        ...(yours ? { yours: true } : {}),
      });
    };
    for (const c of clones) push({ id: c.voice_id, name: c.name, language: c.language || "en", tags: ["your voice", "multilingual"] }, true);
    for (const v of payload.voices ?? []) push(v, v.mine === true);

    const lang = input.language?.trim().toLowerCase().split("-")[0];
    const q = input.q?.trim().toLowerCase();
    const tagsOf = (r: Record<string, unknown>) => (Array.isArray(r.tags) ? (r.tags as string[]) : []);
    const matches = rows.filter(
      (r) =>
        (!lang || r.language === lang || tagsOf(r).includes("multilingual")) &&
        (!input.gender || r.gender === input.gender || r.yours === true) &&
        (!q || [r.name, r.accent, ...tagsOf(r)].some((f) => typeof f === "string" && f.toLowerCase().includes(q))),
    );
    return jsonResult({
      total: matches.length,
      voices: matches.slice(0, input.limit ?? 50),
      languages: payload.languages ?? [],
      next: "Pass the chosen id as voice_id to versely_quote_ugc_ads and versely_create_ugc_ads.",
    });
  },
});

const versely_write_ugc_script = defineTool({
  name: "versely_write_ugc_script",
  description:
    "Write three UGC ad script options (hook, body, call to action) from a short brief, a product page link or one " +
    "of the user's brands, for a format, tone and length. FREE, no credits; takes up to ~30 s. Claims the source " +
    "does not support are left out. Show the options to the user; they can pick, mix or edit one. Then price the " +
    "chosen text with versely_quote_ugc_ads (as script) before versely_create_ugc_ads.",
  inputSchema: z.object({
    brief: z.string().max(800).optional().describe("What is being sold and to whom, in the user's words."),
    url: z.string().url().max(2048).optional().describe("A public product or app page to read the facts from."),
    brand_id: z.string().optional().describe("One of the user's brands (versely_list_brands)."),
    format: Format,
    tone: z.enum(TONES).optional().describe("Default 'casual'."),
    length_s: z
      .union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)])
      .optional()
      .describe("Target length in seconds: 15, 30 (default), 45 or 60."),
    language: z.string().min(2).max(12).optional().describe("Language code of the script, e.g. 'en' (default), 'es'."),
  }),
  handler: async (input, ctx) => {
    if (!input.brief?.trim() && !input.url && !input.brand_id) {
      return errorResult("Pass a brief, a url or a brand_id: the script needs something to sell.");
    }
    const body = {
      ...(input.brief?.trim() ? { brief: input.brief.trim() } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.brand_id ? { brand_kit_id: input.brand_id } : {}),
      format: input.format ?? "talking_head",
      ...(input.tone ? { tone: input.tone } : {}),
      ...(input.length_s ? { length_s: input.length_s } : {}),
      ...(input.language ? { language: input.language } : {}),
    };
    const res = await ctx.client.post("/api/v1/ugc/script", body, { timeoutMs: SYNC_TIMEOUT_MS });
    const scripts = dataOf<{ scripts?: Array<{ hook?: string; body?: string; cta?: string; text?: string; est_seconds?: number }> }>(res).scripts;
    if (!Array.isArray(scripts) || scripts.length === 0) return jsonResult(res);
    const lines = [`${scripts.length} script option${scripts.length === 1 ? "" : "s"} (${body.format}; free, nothing charged):`];
    scripts.forEach((s, i) => {
      lines.push("", `${i + 1}. (about ${s.est_seconds ?? "?"} s) ${s.text ?? [s.hook, s.body, s.cta].filter(Boolean).join(" ")}`);
    });
    lines.push(
      "",
      "Show these to the user; they can pick, mix or edit one (10-1500 characters, at most about 60 s). Then price the " +
        "final text with versely_quote_ugc_ads { script, actor_ids, ... }.",
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
});

const versely_quote_ugc_ads = defineTool({
  name: "versely_quote_ugc_ads",
  description:
    "The exact credits a batch of UGC ads would cost: one ad per presenter, for this script, format, voice, " +
    "resolution and captions. FREE, nothing is made or charged. Pass the final script for the exact price (or " +
    "seconds for an early estimate). " +
    PAID_FLOW,
  inputSchema: z.object({
    actor_ids: ActorIds,
    script: Script.optional(),
    seconds: z.number().int().min(1).max(MAX_SPEECH_SECONDS).optional().describe("Without a script: an estimate for this many seconds of speech."),
    voice_id: VoiceId,
    format: Format,
    resolution: Resolution,
    captions: Captions,
  }),
  handler: async (input, ctx) => {
    if (input.script === undefined && input.seconds === undefined) {
      return errorResult("Pass the script for the exact price, or seconds for an estimate.");
    }
    const format = input.format ?? "talking_head";
    const problem = checkRequest({ actor_ids: input.actor_ids, format, script: input.script, forCreate: false });
    if (problem) return errorResult(problem);
    const priced = await priceAds(ctx, { ...input, format });
    const exact = input.script !== undefined;
    const perAd = new Set(priced.per_ad.map((a) => a.credits)).size === 1
      ? `${credits(priced.per_ad[0]!.credits)} per ad`
      : priced.per_ad.map((a) => `${a.actor_id} ${a.credits}`).join(", ");
    const head = `${settingsLine({ count: input.actor_ids.length, format, resolution: input.resolution, captions: input.captions, est_seconds: priced.est_seconds })}: ` +
      `${credits(priced.total)} in total (${perAd}).`;
    const next = exact
      ? ` Free quote, nothing charged. Show the user the script, the presenters and this price; only after they say yes call ` +
        `versely_create_ugc_ads with the same settings and confirm_credits: ${priced.total}.`
      : ` This is an estimate for about ${priced.est_seconds} s; quote again with the final script before creating, ` +
        `because confirm_credits must match the price for that script.`;
    return { content: [{ type: "text", text: (exact ? "" : "Estimate: ") + head + next }] };
  },
});

const versely_create_ugc_ads = defineTool({
  name: "versely_create_ugc_ads",
  description:
    "Make UGC ads: each presenter reads the script on camera in a vertical 9:16 video, optionally holding the " +
    "user's product or showing their app, with word-by-word captions. PAID: spends the quoted credits once for the " +
    "whole batch; an ad that fails is refunded its share. Call it only after the user has seen the script, the " +
    "presenters and the exact price from versely_quote_ugc_ads and said yes, and pass that price as confirm_credits; " +
    "if the price has changed the call is refused with the new one and nothing is charged. The ads take a few " +
    "minutes; the card follows them, otherwise check versely_get_ugc_ads. Never start the same ads twice. Product " +
    "and app images are public https links: results of earlier Versely tools or files stored with " +
    "versely_upload_media.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    script: Script,
    actor_ids: ActorIds,
    voice_id: VoiceId,
    format: Format,
    product_image_url: z.string().url().max(2048).optional().describe("product_in_hand: a clear photo of the product (https)."),
    app_screenshot_url: z.string().url().max(2048).optional().describe("show_your_app: a screenshot of the app (https)."),
    resolution: Resolution,
    captions: Captions,
    caption_style: z
      .enum(CAPTION_STYLES)
      .optional()
      .describe("Caption animation: 'karaoke' (default), 'highlight', 'pop', 'typewriter' or 'none' (plain)."),
    language: z.string().min(2).max(12).optional().describe("Language code of the script, e.g. 'en', 'es' (helps the voice and the captions)."),
    confirm_credits: z.number().int().positive().describe("The exact price the user approved, from versely_quote_ugc_ads for this script and these settings."),
  }),
  handler: async (input, ctx) => {
    const format = input.format ?? "talking_head";
    const problem = checkRequest({
      actor_ids: input.actor_ids,
      format,
      script: input.script,
      product_image_url: input.product_image_url,
      app_screenshot_url: input.app_screenshot_url,
      forCreate: true,
    });
    if (problem) return errorResult(`Not started, nothing charged: ${problem}`);

    // The backend takes no confirm_credits: re-price right before posting.
    const priced = await priceAds(ctx, { ...input, format });
    if (priced.total !== input.confirm_credits) {
      return errorResult(
        `Not started, nothing charged: these ads now cost ${credits(priced.total)} (you passed ${input.confirm_credits}). ` +
          `Show the user the new price and ask again; if they agree, call versely_create_ugc_ads with confirm_credits: ${priced.total}.`,
      );
    }

    const body = {
      script: normalizeScript(input.script),
      actor_ids: input.actor_ids,
      format,
      ...(input.voice_id ? { voice_id: input.voice_id } : {}),
      ...(format === "product_in_hand" ? { product_image_url: input.product_image_url } : {}),
      ...(format === "show_your_app" ? { app_screenshot_url: input.app_screenshot_url } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.captions !== undefined ? { captions: input.captions } : {}),
      ...(input.caption_style ? { caption_style: input.caption_style } : {}),
      ...(input.language ? { language: input.language } : {}),
    };
    const res = await ctx.client.post("/api/v1/ugc/ads", body);
    const data = dataOf<{ batch_id?: string; credits_charged?: number; ads?: UgcAd[] }>(res);
    if (typeof data.batch_id !== "string" || !data.batch_id) return jsonResult(res);
    const charged = typeof data.credits_charged === "number" ? data.credits_charged : input.confirm_credits;
    const n = data.ads?.length ?? input.actor_ids.length;
    const lead =
      `Started ${n} UGC ad${n === 1 ? "" : "s"}: ${credits(charged)} charged` +
      (charged !== input.confirm_credits ? ` (the quote was ${input.confirm_credits})` : "") +
      `; an ad that fails is refunded its share. The user can leave; the ads keep going.`;
    return batchResult(data.batch_id, data.ads ?? [], { toolName: "versely_create_ugc_ads", toolArgs: input, lead });
  },
});

const versely_get_ugc_ads = defineTool({
  name: "versely_get_ugc_ads",
  description:
    "Check a batch of UGC ads from versely_create_ugc_ads: each ad's progress, and its video once ready. The card " +
    "follows a running batch by itself, so don't call this in a loop: check again every minute or two only when you " +
    "need the result. FREE.",
  // Visible to the app too: the create card's poll loop calls this tool.
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({
    batch_id: z.string().min(4).max(80).describe("The batch id (ua_...) from versely_create_ugc_ads or versely_list_ugc_ads."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get(`/api/v1/ugc/ads/${encodeURIComponent(input.batch_id)}`);
    const data = dataOf<{ batch_id?: string; ads?: UgcAd[] }>(res);
    if (!Array.isArray(data.ads)) return jsonResult(res);
    return batchResult(data.batch_id ?? input.batch_id, data.ads, { toolName: "versely_get_ugc_ads", toolArgs: input });
  },
});

const versely_list_ugc_ads = defineTool({
  name: "versely_list_ugc_ads",
  description:
    "The user's recent UGC ads (the last 14 days), newest first, grouped by batch: presenter, format, status and " +
    "the video once ready. FREE. Open a batch with versely_get_ugc_ads; finished videos also stay in the user's " +
    "Versely library (versely_list_user_media, type videos).",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("How many ads (default 20)."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get("/api/v1/ugc/ads", { query: { limit: input.limit ?? 20 } });
    const ads = dataOf<{ ads?: UgcAd[] }>(res).ads;
    if (!Array.isArray(ads)) return jsonResult(res);
    const batches = new Map<string, { batch_id: string; created_at?: string; script: string; ads: Array<Record<string, unknown>> }>();
    for (const a of ads) {
      let b = batches.get(a.batch_id);
      if (!b) {
        b = { batch_id: a.batch_id, created_at: a.created_at, script: clip(a.script, 140), ads: [] };
        batches.set(a.batch_id, b);
      }
      b.ads.push({
        actor_name: a.actor_name,
        format: a.format,
        status: a.status,
        ...(a.video_url ? { video_url: a.video_url } : {}),
        ...(a.status === "failed" && a.error ? { error: a.error } : {}),
      });
    }
    return jsonResult({
      batches: [...batches.values()],
      ...(batches.size === 0 ? { note: "No UGC ads in the last 14 days. Start with versely_list_ugc_actors." } : {}),
    });
  },
});

export const ugcAdTools: Tool[] = [
  versely_list_ugc_actors,
  versely_list_ugc_voices,
  versely_write_ugc_script,
  versely_quote_ugc_ads,
  versely_create_ugc_ads,
  versely_get_ugc_ads,
  versely_list_ugc_ads,
];
