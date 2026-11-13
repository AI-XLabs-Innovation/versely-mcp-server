// In-process stand-in for api.versely.studio, used by scripts/smoke-test.ts.
//
// Records every request (method, path, query, headers, parsed body, and
// whether its X-Versely-Proxy signature verifies), and serves canned — and
// deliberately awkward — answers: a plugin catalog that can be switched off
// (the "backend not deployed yet" 404), 402/403 credit refusals, plugin
// allowance refusals, 5xx on demand, and a merge that takes 70 seconds.
//
// Nothing here talks to the network beyond localhost, and nothing costs money.

import http from "node:http";
import { AddressInfo } from "node:net";
import { mcpProxyKeyFromSecret, signMcpProxy } from "../src/proxySignature.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
  /** Bytes the request body carried (an uploaded file is not JSON). */
  bytes: number;
  proxy: { present: boolean; valid: boolean; subject: string };
  at: number;
}

export interface FakeBackend {
  url: string;
  requests: RecordedRequest[];
  /** Serve (true) or 404 (false) the plugin catalog endpoints. */
  setPluginCatalog(enabled: boolean): void;
  /** The "slow" AI creator room set has finished (GET /rooms stops saying it is being made). */
  finishRooms(): void;
  count(pred: (r: RecordedRequest) => boolean): number;
  close(): Promise<void>;
}

// --- Canned data -------------------------------------------------------------

/** The plugin catalog: RunPod-served models only (contract 5). */
export const PLUGIN_MODELS = [
  {
    name: "Seedream 4 Text to Image",
    display_name: "Seedream 4",
    type: "image",
    modes: ["t2i"],
    requires_image: false,
    credits: 3,
    params: [
      { name: "aspect_ratio", type: "string", required: false, enum: ["1:1", "16:9", "9:16"], default: "1:1" },
      { name: "seed", type: "integer", required: false },
    ],
  },
  {
    name: "Wan 2.5 Preview",
    display_name: "Wan 2.5",
    type: "video",
    modes: ["t2v", "i2v"],
    requires_image: false,
    credits: 40,
    params: [
      { name: "duration", type: "integer", required: false, enum: [5, 10], default: 5 },
      { name: "resolution", type: "string", required: false, enum: ["480p", "720p", "1080p"] },
    ],
    params_by_mode: { i2v: [{ name: "image_url", type: "string", required: true }] },
  },
  {
    name: "Minimax Speech",
    display_name: "Minimax Speech",
    type: "audio",
    modes: ["tts"],
    requires_image: false,
    credits: 2,
    params: [{ name: "voice_id", type: "string", required: false }],
    voices: [
      { id: "Wise_Woman", name: "Wise Woman", language: "Universal", gender: "female" },
      { id: "English_Aussie_Bloke", name: "Aussie Bloke", language: "English", gender: "male" },
    ],
  },
];

/** The regular catalog: RunPod-served AND other models. */
const CATALOG: Record<string, Array<Record<string, unknown>>> = {
  images: [
    { slug: "seedream-4", name: "Seedream 4 Text to Image", display_name: "Seedream 4", content_type: "image", categories: ["text-to-image"], credits: 3, is_runpod_discounted: true },
    { slug: "flux-pro-ultra", name: "Flux Pro Ultra", content_type: "image", categories: ["text-to-image"], credits: 12, is_runpod_discounted: false },
  ],
  videos: [
    { slug: "wan-2-5", name: "Wan 2.5 Preview", display_name: "Wan 2.5", content_type: "video", categories: ["text-to-video", "image-to-video"], credits: 40, is_runpod_discounted: true },
    { slug: "sora-2", name: "Sora 2", content_type: "video", categories: ["text-to-video"], credits: 120, is_runpod_discounted: false },
  ],
  audio: [
    { slug: "minimax-speech", name: "Minimax Speech", content_type: "audio", categories: ["text-to-audio"], credits: 2, is_runpod_discounted: true },
    { slug: "eleven-labs-turbo", name: "Eleven Labs Speech Turbo", content_type: "audio", categories: ["text-to-audio"], credits: 4, is_runpod_discounted: false },
  ],
  lipsync: [
    {
      slug: "veed-avatars", name: "Veed Avatars", content_type: "lipsync", categories: ["text-to-lipsync"], credits: 3,
      is_runpod_discounted: false,
      price_matrix: { perSecond: true, unit: "second", billingType: "per_second", minCredits: 3, maxCredits: 56, options: [{ key: "default", full: 1, discounted: 1 }] },
    },
  ],
};

const GEMINI_38 = {
  slug: "gemini-3-8-flash-tts", name: "Gemini 3.8 Flash TTS", content_type: "audio",
  categories: ["text-to-audio"], credits: 3, is_runpod_discounted: false,
};

const PLUGIN_BLOCK_FREE = {
  free_account: true,
  free_credits_granted: 100,
  free_credits_remaining: 87,
  runpod_only: true,
};

/**
 * Credits per second and per shot by tier and resolution, as the backend
 * quotes a script (2026-11-04): Standard films every shot at 1080p, so it
 * pays per second and per shot; High quality pays per second only. The
 * episode is rounded up once: Standard 15 s of 5 shots = 150, 30 s of 10
 * shots = 299; High quality 480p 160 / 320, 720p 320 / 640 (15 s / 30 s).
 */
const DRAMA_RATES: Record<string, Record<string, { second: number; shot: number }>> = {
  standard: { "1080p": { second: 8.87574, shot: 3.25444 } },
  high: { "480p": { second: 10.65089, shot: 0 }, "720p": { second: 21.30178, shot: 0 } },
};

/** Like the backend: Standard is always 1080p; High quality is 480p | 720p (1080p -> 720p, anything else -> 480p). Default 720p. */
function dramaTier(quality: unknown, resolution: unknown): { quality: "standard" | "high"; resolution: string } {
  if (quality !== "high") return { quality: "standard", resolution: "1080p" };
  const r = resolution === undefined || resolution === null ? "720p" : String(resolution);
  return { quality: "high", resolution: r === "720p" || r === "1080p" ? "720p" : "480p" };
}

type DramaScriptShape = { clips?: Array<{ seconds?: number; shots?: unknown[] }> } | null | undefined;

/** The exact quote for a script at a tier, like the backend's: seconds and shots, rounded up once. */
function dramaCredits(tier: { quality: string; resolution: string }, script: DramaScriptShape): number | null {
  const rate = DRAMA_RATES[tier.quality]?.[tier.resolution];
  const clips = script?.clips ?? [];
  if (!rate || !clips.length) return null;
  const seconds = clips.reduce((a, c) => a + Math.round(c.seconds ?? 0), 0);
  const shots = clips.reduce((a, c) => a + Math.max(1, c.shots?.length ?? 0), 0);
  return Math.ceil(parseFloat((seconds * rate.second + shots * rate.shot).toFixed(6)));
}

/** A planned short drama as POST /drama/shows answers it: Episode 1 scripted and quoted. */
function makeDramaShow(idea: string, seconds: 15 | 30, tier: { quality: string; resolution: string }): Record<string, unknown> {
  // Episode 1: one 15 s clip, or two for a 30 s episode, three shots each.
  const clips = [
    { seconds: 15, location: "office", cast: ["dalton", "mara"], shots: [
      { camera: "wide on the open-plan office", action: "dalton drops a box on mara's desk", lines: [] },
      { camera: "close-up on dalton", action: "he points at the box", lines: [{ who: "dalton", line: "You're fired." }] },
      { camera: "close-up on mara", action: "she shrugs", lines: [{ who: "mara", line: "That's fine. I just bought the company." }] },
    ] },
    { seconds: 15, location: "office", cast: ["dalton", "mara"], shots: [
      { camera: "close-up on dalton's phone", action: "an email lands: new owner", lines: [] },
      { camera: "medium on dalton", action: "his face falls", lines: [{ who: "dalton", line: "Is this a joke?" }] },
      { camera: "close-up on mara", action: "she hands him the box", lines: [{ who: "mara", line: "You'll need this more than me." }] },
    ] },
  ].slice(0, seconds === 15 ? 1 : 2);
  const script = { clips };
  return {
    id: "drm_smoke000001",
    title: "Day One",
    logline: idea || "An intern buys the company on her first day.",
    genre: "comedy",
    format: "drama",
    language: "en",
    episode_seconds: seconds,
    quality: tier.quality,
    resolution: tier.resolution,
    bible: { premise: idea, tone: "light", world: "a glass office", continuity: [] },
    cast: [
      { key: "mara", name: "Mara", role: "lead", age: 24, look: "short dark bob, grey hoodie", voice: "bright, dry", personality: "Quiet new intern who owns more than she says.", portrait_url: "https://img.versely.studio/drama/mara.jpg", avatar_id: null },
      { key: "dalton", name: "Dalton", role: "lead", age: 45, look: "grey vest, loud tie", voice: "booming", personality: "Smug manager who fires first.", portrait_url: "https://img.versely.studio/drama/dalton.jpg", avatar_id: null },
    ],
    locations: [{ key: "office", name: "Glass office", look: "open plan, city view" }],
    episodes: [
      {
        n: 1, title: "Day One", goal: "", turn: "", cliffhanger: "", status: "scripted", credits: dramaCredits(tier, script),
        script,
        video_url: null, poster_url: null, user_video_id: null, error: null, started_at: null, finished_at: null,
      },
      { n: 2, title: "The Board", goal: "", turn: "", cliffhanger: "", status: "planned", script: null, credits: null, video_url: null, poster_url: null, user_video_id: null, error: null, started_at: null, finished_at: null },
      { n: 3, title: "Payback", goal: "", turn: "", cliffhanger: "", status: "planned", script: null, credits: null, video_url: null, poster_url: null, user_video_id: null, error: null, started_at: null, finished_at: null },
    ],
    created_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:00:00.000Z",
  };
}

// --- Server ------------------------------------------------------------------

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function startFakeBackend(opts: {
  /** OAUTH_JWT_SECRET shared with the MCP under test (proxy-signature key). */
  secret: string;
  /** How long POST /features/merge-videos stalls when a URL contains "slow". */
  slowMergeMs?: number;
}): Promise<FakeBackend> {
  const key = mcpProxyKeyFromSecret(opts.secret);
  const requests: RecordedRequest[] = [];
  let pluginCatalog = true;
  let seq = 0;
  const socialPosts: Array<Record<string, unknown>> = [];
  const automations = new Map<string, Record<string, unknown>>();
  const brands = new Map<string, Record<string, unknown>>();
  const slideshowReads = new Map<string, number>();
  const templateRunReads = new Map<string, number>();
  const quickReads = new Map<string, number>();
  const collectionReads = new Map<string, number>();
  let drama: Record<string, unknown> | null = null;
  let dramaReads = 0;
  const swapSources = new Map<string, { seconds: number }>();
  const swapReads = new Map<string, number>();
  let swapSeq = 0;
  let aicLastRooms: Record<string, unknown> | null = null;
  let aicRoomsMaking = false;
  let aicPendingRooms: Record<string, unknown> | null = null;
  const aicEpisodes = new Map<string, Array<Record<string, unknown>>>();
  const aicReads = new Map<string, number>();
  // Voice ids carry their vendor like the real list; the tools must never show them.
  const AIC_VOICES = [
    { id: "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", name: "Skylar", gender: "female", accent: "American", previewUrl: null, language: "en", tags: ["friendly", "warm"] },
    { id: "cartesia:b4b8e2af-6139-466e-a93a-30c20d2e1fc5", name: "Fernanda", gender: "female", accent: "Mexican", previewUrl: null, language: "es", tags: ["friendly"] },
    { id: "gemini:Kore", name: "Kore", gender: "female", accent: "Multilingual", previewUrl: null, language: "en", tags: ["multilingual", "firm"] },
  ];
  const AIC_TABLE: Record<string, Record<string, number>> = {
    "720p": { "15": 104, "20": 138, "30": 196 },
    "1080p": { "15": 150, "20": 198, "30": 282 },
  };
  const AIC_FORMAT_LABELS: Record<string, string> = { kitchen_tips: "Kitchen tips", product_demo: "Product demo", custom: "Custom topic" };
  const aicPrice = (c: Record<string, unknown>): number | null => AIC_TABLE[String(c.quality ?? "720p")]?.[String(c.lengthSeconds ?? 20)] ?? null;
  /** Like normalizeAiCreatorConfig + validateCreatorConfig: every create and edit carries the whole config. */
  const aicConfigError = (c: Record<string, unknown>): string | null => {
    if (!c.avatarId) return "Pick an avatar.";
    if (typeof c.roomImageUrl !== "string" || !c.roomImageUrl.startsWith("https://img.versely.studio/gen/ai-creator-rooms/user-smoke/")) return "Pick one of the rooms made for this creator.";
    if (!AIC_VOICES.some((v) => v.id === c.voiceId)) return "That voice is not available. Pick another one.";
    if (!c.format) return "Pick what it posts.";
    if (c.format === "custom" && String(c.topic ?? "").trim().length < 3) return "Describe the topic it posts about.";
    if (Array.isArray(c.post_account_ids) && c.post_account_ids.length > 1) return "Pick one account. To post the same creator to another account, make a second AI creator.";
    return null;
  };
  const aicSummary = (c: Record<string, unknown>): string =>
    [AIC_FORMAT_LABELS[String(c.format)] ?? String(c.format), c.topic ? String(c.topic) : null, "Maya", `${c.lengthSeconds ?? 20} s`, String(c.quality ?? "720p"),
      Array.isArray(c.post_account_ids) && c.post_account_ids.length ? "posts to 1 account" : "not posting yet"].filter(Boolean).join(" · ");
  const PREMADE_AVATARS: Array<{ id: string; name: string; image_url: string; full_body_url?: string; type?: string; [k: string]: string | undefined }> = [
    { id: "char-tessa", name: "Tessa", type: "average", gender: "female", age_band: "25-34", style: "Sunny everyday lifestyle creator", setting: "studio", image_url: "https://img.versely.studio/avatars/char-tessa.jpg", full_body_url: "https://img.versely.studio/avatars/char-tessa-full.jpg" },
    { id: "char-ziggy", name: "Ziggy", type: "creature", gender: "male", age_band: "25-34", style: "Fox-eared street-style skater", setting: "studio", image_url: "https://img.versely.studio/avatars/char-ziggy.jpg", full_body_url: "https://img.versely.studio/avatars/char-ziggy-full.jpg" },
    // A UGC presenter: portrait only, no type (read as 'average').
    { id: "maya-selfie", name: "Maya", gender: "female", age_band: "25-34", style: "Bubbly skincare fan", setting: "selfie", image_url: "https://img.versely.studio/ugc/actors/maya-selfie.jpg" },
    // The two the AI creator assertions pick from.
    { id: "maya-kitchen", name: "Maya", gender: "female", age_band: "25-34", style: "Warm home cook", setting: "kitchen", image_url: "https://img.versely.studio/ugc-actors/maya-kitchen.jpg" },
    { id: "leo-studio", name: "Leo", gender: "male", age_band: "25-34", style: "Bright Australian presenter", setting: "studio", image_url: "https://img.versely.studio/ugc-actors/leo-studio.jpg" },
  ];
  let ugcBatch: { batch_id: string; ads: Array<Record<string, unknown>> } | null = null;
  let ugcBatchReads = 0;
  const UGC_AVATAR_WITH_CLONE = "0b6d6c7e-6f0a-4c1e-9a52-3f1d2e4b5a69";
  const UGC_CLONE_ID = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  /** Fake per-ad price: voice 1 (a cloned voice 3) + product frame 4 + video 4/s at 720p (2/s at 480p, 1/s for hg-*) + captions 5. */
  const ugcAdPrice = (q: Record<string, string | undefined>) => {
    const chars = q.script_chars ? Number(q.script_chars) : null;
    const est = chars ? Math.max(1, Math.ceil(chars / 15)) : Math.ceil(Number(q.est_seconds ?? 30));
    const voice = String(q.voice_id ?? "").startsWith("clone:") ? 3 : 1;
    const frame = q.format && q.format !== "talking_head" ? 4 : 0;
    const video = est * (String(q.actor_id ?? "").startsWith("hg-") ? 1 : q.resolution === "480p" ? 2 : 4);
    const captions = q.captions === "false" ? 0 : 5;
    return { credits_per_ad: voice + frame + video + captions, breakdown: { voice, frame, video, captions }, est_seconds: est };
  };
  /** The backend's spoken length: cues like [laughs] removed. */
  const ugcSpokenChars = (script: string) =>
    script.replace(/\r\n?/g, "\n").trim().replace(/\[[^\]\n]{1,40}\]|<[a-z][a-z _-]{0,30}>/gi, " ")
      .replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim().length;
  const scriptRows = new Map<string, Record<string, unknown>>();
  let scriptSeq = 0;
  let voiceRow: Record<string, unknown> | null = null;
  const captionJobs = new Map<string, { job: Record<string, unknown>; reads: number }>();
  let captionSeq = 0;
  const lookReads = new Map<string, number>();
  const LOOK_JOB_OK = "019a7f3c-5e00-7000-8000-00000000a1b2";
  const LOOK_JOB_FAIL = "019a7f3c-5e00-7000-8000-00000000f0f0";
  let musicVideoReads = 0;
  const MV_JOB_OK = "5f0c6a2e-8d1b-4c3a-9e7f-1a2b3c4d5e6f";
  const MV_JOB_FAIL = "6a1d7b3f-9e2c-4d4b-8f80-2b3c4d5e6f70";

  function verifyProxy(headers: http.IncomingHttpHeaders): RecordedRequest["proxy"] {
    const raw = headers["x-versely-proxy"];
    const subject = (headers["x-versely-openai-subject"] as string | undefined) ?? "";
    if (typeof raw !== "string") return { present: false, valid: false, subject };
    const m = /^v1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(raw);
    if (!m) return { present: true, valid: false, subject };
    const ts = Number(m[1]);
    const fresh = Math.abs(Math.floor(Date.now() / 1000) - ts) <= 300;
    return { present: true, valid: fresh && signMcpProxy(key, ts, subject) === raw, subject };
  }

  /** Contract 3: a plugin request = ck:"openai" token + a valid proxy signature. */
  function isPluginRequest(rec: RecordedRequest): boolean {
    const bearer = /^Bearer\s+(.+)$/i.exec(rec.headers.authorization ?? "")?.[1] ?? "";
    return decodeJwtPayload(bearer)?.ck === "openai" && rec.proxy.valid;
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      let body: unknown = undefined;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : v;
      const rec: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        body,
        bytes: Buffer.concat(chunks).length,
        proxy: verifyProxy(req.headers),
        at: Date.now(),
      };
      requests.push(rec);
      // A key the backend no longer accepts (expired / revoked sign-in).
      if ((rec.headers.authorization ?? "") === "Bearer vsk_revoked_smoke_token_value") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or revoked API key" }));
        return;
      }
      void route(rec, res).catch((err) => send(res, 500, { error: String(err) }));
    });
  });

  function send(res: http.ServerResponse, status: number, payload: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  async function route(rec: RecordedRequest, res: http.ServerResponse): Promise<void> {
    const { method, path } = rec;
    const b = (rec.body ?? {}) as Record<string, unknown>;
    const plugin = isPluginRequest(rec);

    // --- account ---
    if (method === "GET" && path === "/api/v1/user/me") {
      return send(res, 200, {
        success: true,
        user: { id: "user-smoke", email: "smoke@example.com", credits: plugin ? 0 : 250 },
        ...(plugin ? { plugin: PLUGIN_BLOCK_FREE } : {}),
      });
    }
    const credits = /^\/api\/v1\/user\/([^/]+)\/credits$/.exec(path);
    if (method === "GET" && credits) {
      if (plugin) return send(res, 200, { credits: 0, plugin: PLUGIN_BLOCK_FREE });
      return send(res, 200, {
        credits: 250,
        trial: { active: false },
        trial_offer: { eligible: true, spots_left: 12, url: "https://versely.studio/trial" },
      });
    }

    // --- catalogs ---
    if (method === "GET" && path === "/api/v1/ai-models/plugin-catalog") {
      // Before the backend deploy this path falls into /:slug → 404.
      if (!pluginCatalog) return send(res, 404, { success: false, error: "Model not found" });
      const type = rec.query.type;
      return send(res, 200, { success: true, data: { models: PLUGIN_MODELS.filter((m) => !type || m.type === type) } });
    }
    const pm = /^\/api\/v1\/ai-models\/plugin-catalog\/(.+)$/.exec(path);
    if (method === "GET" && pm) {
      if (!pluginCatalog) return send(res, 404, { success: false, error: "Not found" });
      const name = decodeURIComponent(pm[1]!);
      const model = PLUGIN_MODELS.find((m) => m.name === name);
      if (!model) return send(res, 404, { success: false, error: "model_not_in_plugin_catalog" });
      return send(res, 200, { success: true, data: model });
    }
    const cat = /^\/api\/v1\/ai-models\/(images|videos|audio|lipsync)$/.exec(path);
    if (method === "GET" && cat) {
      // Like the real catalog: Gemini 3.8 TTS is active but not a dispatcher
      // model, so ?dispatcher_only=true leaves it out.
      const extra = cat[1] === "audio" && rec.query.dispatcher_only !== "true" ? [GEMINI_38] : [];
      return send(res, 200, { success: true, data: { models: [...(CATALOG[cat[1]!] ?? []), ...extra] } });
    }

    // --- generation ---
    const gen = /^\/api\/v1\/generate\/(image|video|audio)$/.exec(path);
    if (method === "POST" && gen) {
      const prompt = String(b.prompt ?? b.text ?? "");
      if (prompt === "fail-500") return send(res, 500, { success: false, error: "boom" });
      if (prompt === "need-credits") {
        return send(res, 402, { success: false, error: "Insufficient credits", credits_required: 12 });
      }
      if (prompt === "forbidden-credits") return send(res, 403, { success: false, error: "Insufficient credits" });
      if (prompt === "top-up-upsell") {
        return send(res, 402, { success: false, error: "Insufficient credits. Top up at https://versely.studio/pricing" });
      }
      if (prompt === "plugin-blocked") {
        return send(res, 403, {
          success: false,
          error: "plugin_free_feature_blocked",
          message: "Free plugin credits don't cover this. See https://versely.studio for details.",
          plugin: PLUGIN_BLOCK_FREE,
        });
      }
      seq += 1;
      return send(res, 200, { success: true, data: { requestId: `req-${gen[1]}-${seq}` } });
    }
    // ─── musicVideo (agent notes) ───
    // --- AI music video: free quote, paid create (202 + job_id), job status ---
    // Mirrors services/musicVideo.service.ts: stills x per-still + render (2 per shot, 5..30).
    const mvQuote = (q: Record<string, unknown>) => {
      const song = 185.2;
      const start = q.start_sec !== undefined ? Number(q.start_sec) : q.audio_url ? 0 : 12.48;
      const dur = Math.min(Number(q.duration_sec ?? 60), song - start, 240);
      const stills = Math.round(dur * 0.3);
      const shots = Math.round(dur * 0.5);
      const perStill = q.quality === "fast" ? 1 : 2;
      const render = Math.max(5, Math.min(30, 2 * shots));
      return {
        credits: stills * perStill + render,
        breakdown: { stills: stills * perStill, per_still: perStill, render },
        stills, shots,
        has_lyrics: !q.audio_url && q.instrumental !== true,
        song_duration_sec: song, start_sec: start, duration_sec: dur, bpm: 119.7,
      };
    };
    const mvSongError = (q: Record<string, unknown>): [number, string] | null => {
      if (q.audio_url && q.music_id) return [400, "Send either music_id (a Versely track) or audio_url (an uploaded song), not both"];
      if (q.audio_url) return String(q.audio_url).startsWith("https://user-files.versely.studio/") ? null : [400, "audio_url is not one of your uploads"];
      if (!q.music_id) return [400, "music_id is required"];
      if (!q.audio_id) return [400, "audio_id is required"];
      if (q.music_id === "mus-missing") return [404, "Track not found"];
      return null;
    };
    if (method === "POST" && path === "/api/v1/music-video/quote") {
      const bad = mvSongError(b);
      if (bad) return send(res, bad[0], { success: false, error: bad[1] });
      return send(res, 200, { success: true, quote: mvQuote(b) });
    }
    if (method === "POST" && path === "/api/v1/music-video") {
      const bad = mvSongError(b);
      if (bad) return send(res, bad[0], { success: false, error: bad[1] });
      musicVideoReads = 0;
      return send(res, 202, { success: true, job_id: b.music_id === "mus-fails" ? MV_JOB_FAIL : MV_JOB_OK, credits_charged: mvQuote(b).credits });
    }
    const mvJob = /^\/api\/v1\/music-video\/([^/]+)$/.exec(path);
    if (method === "GET" && mvJob) {
      const id = decodeURIComponent(mvJob[1]!);
      const base = { id, credits_charged: 66, created_at: "2026-11-14T10:00:00.000Z" };
      if (id === MV_JOB_FAIL) {
        return send(res, 200, { success: true, job: { ...base, status: "failed", progress: { stills_done: 3, stills_total: 18 }, refunded: true, error: "We couldn't create the pictures for your video. Your credits were refunded. Try again." } });
      }
      if (id !== MV_JOB_OK) return send(res, 404, { success: false, error: "No such music video job" });
      musicVideoReads++;
      if (musicVideoReads < 2) return send(res, 200, { success: true, job: { ...base, status: "stills", progress: { stills_done: 9, stills_total: 18 } } });
      return send(res, 200, { success: true, job: { ...base, status: "done", progress: { stills_done: 18, stills_total: 18 }, video_url: "https://videos.versely.studio/music-video/5f0c6a2e.mp4", thumbnail_url: "https://img.versely.studio/music-video/5f0c6a2e.jpg" } });
    }

    // ─── aiLooks (agent notes) ───
    // --- AI looks: presets (with prices), start (202 + job), job status ---
    // Shapes from services/aiLooks/core.ts presetCatalog / service.ts startAiLook / collapseAiLookRows.
    // `model` is in the real payload; the tools must never show it.
    const LOOK_PRESETS = [
      { id: "night-flash", name: "Night flash", group: "flash", description: "Direct flash after dark: lit subject, near-black background, crisp shadow.", thumbnail: "https://app-assets.versely.studio/ai-looks/night-flash.jpg?v=20261022", thumbnail_before: "https://app-assets.versely.studio/ai-looks/night-flash-before.jpg?v=20261022", model: "Nano Banana 2 Edit", credits: 9, credits_held: 9 },
      { id: "golden-hour", name: "Golden hour", group: "golden", description: "Low warm sun: golden rim light and glowing skin.", thumbnail: "https://app-assets.versely.studio/ai-looks/golden-hour.jpg?v=20261022", thumbnail_before: "https://app-assets.versely.studio/ai-looks/golden-hour-before.jpg?v=20261022", model: "Pruna Image Edit", credits: 2, credits_held: 3 },
      { id: "photo-strip", name: "Photo strip", group: "photobooth", description: "Vintage photobooth strip: four flash frames on one paper strip.", thumbnail: "https://app-assets.versely.studio/ai-looks/photo-strip.jpg?v=20261022", thumbnail_before: "https://app-assets.versely.studio/ai-looks/photo-strip-before.jpg?v=20261022", model: "Nano Banana 2 Edit", credits: 9, credits_held: 9 },
    ];
    if (method === "GET" && path === "/api/v1/ai-looks/presets") {
      return send(res, 200, {
        success: true,
        presets: LOOK_PRESETS,
        groups: [
          { id: "digicam", label: "Digicam" }, { id: "flash", label: "Flash" }, { id: "film", label: "Film" },
          { id: "golden", label: "Golden hour & sunset" }, { id: "night", label: "Night" },
          { id: "photobooth", label: "Photobooth" }, { id: "editorial", label: "Editorial" },
        ],
        credits_per_image: 9, credits_per_image_min: 2, default_strength: 0.5,
      });
    }
    if (method === "POST" && path === "/api/v1/ai-looks") {
      if (typeof b.image_url !== "string" || !b.image_url) return send(res, 400, { success: false, error: "image_url is required" });
      const p = LOOK_PRESETS.find((x) => x.id === b.preset);
      if (!p) return send(res, 400, { success: false, error: `Unknown preset "${String(b.preset)}"` });
      const strength = typeof b.strength === "number" ? b.strength : 0.5;
      const id = String(b.image_url).includes("fails") ? LOOK_JOB_FAIL : LOOK_JOB_OK;
      lookReads.set(id, 0);
      return send(res, 202, {
        success: true,
        job: { id, status: "processing", preset: p.id, tier: strength < 0.34 ? "subtle" : strength > 0.66 ? "bold" : "balanced", strength, image_url: null, request_id: "rp-look-1", image_id: "img-look-1", model: p.model, error: null, credits: p.credits, credits_held: p.credits_held },
        poll_url: `/api/v1/ai-looks/jobs/${id}`,
      });
    }
    const lookJob = /^\/api\/v1\/ai-looks\/jobs\/([^/]+)$/.exec(path);
    if (method === "GET" && lookJob) {
      const id = decodeURIComponent(lookJob[1]!);
      if (id !== LOOK_JOB_OK && id !== LOOK_JOB_FAIL) return send(res, 404, { success: false, error: "Look not found" });
      const n = (lookReads.get(id) ?? 0) + 1;
      lookReads.set(id, n);
      const base = { id, preset: "golden-hour", tier: "bold", request_id: "rp-look-1", image_id: "img-look-1", model: "Pruna Image Edit" };
      if (n < 2) return send(res, 200, { success: true, job: { ...base, status: "processing", image_url: null, error: null } });
      if (id === LOOK_JOB_FAIL) return send(res, 200, { success: true, job: { ...base, status: "failed", image_url: null, error: "This look failed. Your credits were refunded." } });
      return send(res, 200, { success: true, job: { ...base, status: "succeeded", image_url: "https://img.versely.studio/gen/ai-looks/look-a1b2.png", error: null } });
    }

    // ─── styledCaptions (agent notes) ───
    // --- captions studio: styles, transcribe (prices premium), styled render + job ---
    const captionLen = (u: unknown) => (String(u ?? "").includes("long") ? 125.4 : 42.5);
    if (method === "GET" && path === "/api/v1/captions/styles") {
      return send(res, 200, {
        success: true,
        styles: [
          { id: "bold-pop", name: "Bold pop", summary: "Heavy white caps, black outline, the spoken word pops in yellow.", group: "loud", backdrop: false, needsMatte: false, accent: "#FFD400" },
          { id: "clean", name: "Clean", summary: "Sentence case, soft shadow, words light up as they are spoken.", group: "calm", backdrop: false, needsMatte: false, accent: "#FFFFFF" },
          { id: "boxed", name: "Boxed", summary: "White words on a rounded black card. Reads on any background.", group: "boxed", backdrop: true, needsMatte: false, accent: "#FFFFFF" },
          { id: "backdrop", name: "Backdrop", summary: "Small serif captions, a huge serif word behind you.", group: "calm", backdrop: false, needsMatte: true, accent: "#FFFFFF" },
        ],
        demo: { words: [{ text: "Hello", start: 0, end: 0.4 }], video_url: "https://app-assets.versely.studio/examples/captions/demo.mp4" },
        premium: [
          { id: "veed-glass", preset: "glass", name: "Glass", tier: "dynamic", credits_per_minute: 16, thumb_url: "https://app-assets.versely.studio/caption-styles/veed-glass.jpg", sample_url: "https://app-assets.versely.studio/examples/captions/glass.mp4" },
          { id: "veed-simple", preset: "simple", name: "Simple", tier: "basic", credits_per_minute: 8, thumb_url: "https://app-assets.versely.studio/caption-styles/veed-simple.jpg", sample_url: "https://app-assets.versely.studio/examples/captions/simple.mp4" },
        ],
      });
    }
    if (method === "POST" && path === "/api/v1/captions/transcribe") {
      if (String(b.video_url ?? "").includes("toolong")) {
        return send(res, 400, { success: false, error: "This video is 12 min 03 s long; captions take videos up to 10 minutes. Trim it and try again.", code: "too_long" });
      }
      return send(res, 200, { success: true, words: [{ text: "Hello", start: 0, end: 0.4 }, { text: "everyone", start: 0.4, end: 0.9 }], duration: captionLen(b.video_url), language: "en" });
    }
    if (method === "POST" && path === "/api/v1/captions/styled") {
      const style = String(b.style ?? "");
      if (style === "backdrop") {
        return send(res, 422, { success: false, error: "\"Backdrop\" puts the words behind the person, which needs background removal. It is coming soon; pick another style for now.", code: "needs_matte" });
      }
      const perMinute: Record<string, number> = { "veed-glass": 16, "veed-simple": 8 };
      if (!["bold-pop", "clean", "boxed"].includes(style) && !(style in perMinute)) {
        return send(res, 400, { success: false, error: `Unknown caption style "${style}" (see GET /captions/styles)` });
      }
      const seconds = captionLen(b.video_url);
      const charged = style in perMinute ? perMinute[style]! * Math.max(1, Math.ceil(seconds / 60)) : 0;
      const jobId = `c0ffee00-0000-4000-8000-${String(++captionSeq).padStart(12, "0")}`;
      captionJobs.set(jobId, {
        reads: 0,
        job: { job_id: jobId, status: "rendering", progress: 0.4, credits_charged: charged, style, duration_sec: seconds, created_at: "2026-11-14T10:00:00.000Z" },
      });
      return send(res, 202, { success: true, job_id: jobId, credits_charged: charged, duration_sec: seconds });
    }
    const captionJob = /^\/api\/v1\/captions\/styled\/([^/]+)$/.exec(path);
    if (method === "GET" && captionJob) {
      const entry = captionJobs.get(captionJob[1]!);
      if (!entry) return send(res, 404, { success: false, error: "No such captions job" });
      // Rendering on the first read, done on the second.
      if (++entry.reads > 1) {
        entry.job = { ...entry.job, status: "done", progress: 1, video_url: `https://videos.versely.studio/gen/styled-captions/${captionJob[1]}/captioned.mp4`, thumbnail_url: `https://img.versely.studio/gen/styled-captions/${captionJob[1]}.jpg` };
      }
      return send(res, 200, { success: true, ...entry.job });
    }

    // ─── scripts (agent notes) ───
    // --- scripts: pricing, generate (async: ready on the first read), read, edit, delete; voice profile ---
    const makeScriptBody = (row: Record<string, unknown>) => ({
      idea: "Why your first salary disappears in a week",
      why_it_works: "Opens on a money fear everyone has, then pays it off with one concrete fix.",
      hooks: [
        { text: "Your salary isn't small. Your plan is.", style: "bold claim" },
        { text: "Where did $400 go in 7 days?", style: "question" },
        { text: "I tracked every dollar for a month.", style: "story" },
      ],
      chosen_hook: 0,
      beats: [
        { t: "0-3s", line: "Your salary isn't small. Your plan is.", on_screen_text: "SALARY IS NOT A PLAN", shot: "Close-up, phone in hand" },
        { t: "3-20s", line: "Split it the day it lands: needs, wants, future.", on_screen_text: "50 / 30 / 20", shot: "Whiteboard, quick cuts" },
        { t: "20-30s", line: "Try it this month and tell me what changed.", on_screen_text: "Try it", shot: "Back to camera" },
      ],
      caption: "The 3-bucket rule that fixed my month.",
      hashtags: ["money", "salary", "personalfinance"],
      cta: "Follow for part 2.",
      source: row.source_url ? { url: row.source_url, platform: "instagram", author: "moneywithmaya" } : null,
    });
    const scriptId = /^\/api\/v1\/scripts\/([0-9a-f-]{36})$/.exec(path);
    if (method === "GET" && path === "/api/v1/scripts/pricing") {
      return send(res, 200, { success: true, script_credits: 1, analysis_credits: 2 });
    }
    if (method === "GET" && path === "/api/v1/scripts/voice-profile") {
      // A build finishes by the first read after it starts.
      if (voiceRow?.status === "building") {
        voiceRow = {
          ...voiceRow,
          status: "ready",
          profile: {
            summary: "Fast, warm money explainers for people in their first job.",
            tone: ["warm", "direct"],
            hook_patterns: ["Direct question - 'Where did your salary go?'"],
            topics: ["salary", "budgeting"],
            catchphrases: ["paisa plan"],
            language_mix: { primary: "hinglish", notes: "Hindi sentence frames, English money terms" },
            pacing: "Short, punchy lines",
            cta_style: "Ends on a question",
            do: ["use real numbers"],
            dont: ["lecture"],
            sample_lines: ["Salary aayi, plan kahan hai?"],
          },
          source_posts: [{ url: "https://www.instagram.com/reel/A1/" }, { url: "https://www.instagram.com/reel/A2/" }],
          updated_at: "2026-11-14T10:01:00.000Z",
        };
      }
      return send(res, 200, { success: true, profile: voiceRow });
    }
    if (method === "POST" && path === "/api/v1/scripts/voice-profile/build") {
      if (b.platform !== "instagram" && b.platform !== "tiktok") return send(res, 400, { success: false, error: "platform must be 'instagram' or 'tiktok'" });
      const handle = String(b.handle ?? "").replace(/^@+/, "").toLowerCase();
      if (!/^[a-z0-9._]{1,40}$/.test(handle)) return send(res, 400, { success: false, error: "Enter a valid handle, like @yourname" });
      voiceRow = { id: "vp_smoke1", platform: b.platform, handle, status: "building", error: null, profile: voiceRow?.profile ?? null, source_posts: null, created_at: "2026-11-14T10:00:00.000Z", updated_at: "2026-11-14T10:00:00.000Z" };
      return send(res, 202, { success: true, profile: voiceRow });
    }
    if (method === "DELETE" && path === "/api/v1/scripts/voice-profile") {
      voiceRow = null;
      return send(res, 200, { success: true });
    }
    if (method === "POST" && path === "/api/v1/scripts/generate") {
      const given = ["source_url", "analysis_id", "idea"].filter((k) => typeof b[k] === "string" && String(b[k]).trim());
      if (given.length !== 1) return send(res, 400, { success: false, error: "Send exactly one of source_url, analysis_id or idea" });
      if (![15, 30, 45, 60].includes(Number(b.length_seconds))) return send(res, 400, { success: false, error: "length_seconds must be 15, 30, 45 or 60" });
      const id = `5c0ffee0-0000-4000-8000-${String(++scriptSeq).padStart(12, "0")}`;
      const credits = 1 + (b.source_url ? 2 : 0);
      const at = `2026-11-14T10:0${scriptSeq % 10}:00.000Z`;
      const row: Record<string, unknown> = {
        id, user_id: "u_smoke", source_url: b.source_url ?? null, source_platform: b.source_url ? "instagram" : null,
        analysis_id: b.analysis_id ?? null, idea_text: b.idea ?? null, language: b.language, length_seconds: Number(b.length_seconds),
        status: "generating", error: null, title: null, script: null, scheduled_for: null, filmed_at: null,
        credits_charged: credits, created_at: at, updated_at: at,
      };
      scriptRows.set(id, row);
      return send(res, 202, { success: true, script: row, credits });
    }
    if (method === "GET" && path === "/api/v1/scripts") {
      const rows = [...scriptRows.values()].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      return send(res, 200, { success: true, scripts: rows.slice(0, Number(rec.query.limit) || 30) });
    }
    if (scriptId) {
      const row = scriptRows.get(scriptId[1]!);
      if (method === "DELETE") {
        scriptRows.delete(scriptId[1]!);
        return send(res, 200, { success: true });
      }
      if (!row) return send(res, 404, { success: false, error: "Script not found" });
      if (method === "GET") {
        if (row.status === "generating") {
          const failed = String(row.idea_text ?? "").includes("fail");
          Object.assign(row, failed
            ? { status: "failed", error: "We could not write a good script this time. Your credits were refunded - please try again." }
            : { status: "ready", title: "Why your first salary disappears", script: makeScriptBody(row) });
        }
        return send(res, 200, { success: true, script: row });
      }
      if (method === "PATCH") {
        if ("script" in b && row.status !== "ready") return send(res, 409, { success: false, error: "Only a finished script can be edited" });
        if (typeof b.title === "string") row.title = b.title;
        if ("script" in b) row.script = { ...(b.script as Record<string, unknown>), source: (row.script as Record<string, unknown> | null)?.source ?? null };
        if ("scheduled_for" in b) row.scheduled_for = b.scheduled_for;
        if ("filmed" in b) row.filmed_at = b.filmed ? "2026-11-14T12:00:00.000Z" : null;
        return send(res, 200, { success: true, script: row });
      }
    }

    // ─── ugcAds (agent notes) ───
    // --- UGC ads (ugcAds.ts): actors, voices, clones, script, quote, create, batch, list ---
    if (method === "GET" && path === "/api/v1/ugc/actors") {
      return send(res, 200, {
        success: true,
        data: {
          actors: [
            { id: "maya-selfie", name: "Maya", gender: "female", age_band: "25-34", setting: "selfie", style: "Bubbly skincare fan", image_url: "https://img.versely.studio/ugc/actors/maya-selfie.jpg", preview_video_url: "https://videos.versely.studio/ugc/actors/maya-selfie.mp4", default_voice_id: "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", source: "versely" },
            { id: "leo-car", name: "Leo", gender: "male", age_band: "25-34", setting: "car", style: "Laid-back commuter", image_url: "https://img.versely.studio/ugc/actors/leo-car.jpg", preview_video_url: null, default_voice_id: "cartesia:a5136bf9-224c-4d76-b823-52bd5efcffcc", source: "versely" },
            { id: "hg-anna-home", name: "Anna", gender: "female", age_band: "35-44", setting: "living_room", style: "Warm mom at home", image_url: "https://img.versely.studio/ugc/actors/hg-anna-home.jpg", preview_video_url: null, default_voice_id: "cartesia:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", source: "heygen" },
          ],
          facets: { settings: ["selfie", "car", "living_room"], genders: ["female", "male"], age_bands: ["25-34", "35-44"] },
        },
      });
    }
    if (method === "GET" && path === "/api/v1/ugc/voices") {
      return send(res, 200, {
        success: true,
        data: {
          voices: [
            { id: "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", name: "Skylar", provider: "cartesia", language: "en", gender: "female", accent: "American", preview_url: null, tags: ["friendly", "warm"] },
            { id: "elevenlabs:TX3LPaxmHKxFdv7VOQHJ", name: "Liam", provider: "elevenlabs", language: "en", gender: "male", accent: "American", preview_url: "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076.mp3", tags: ["energetic", "creator", "multilingual"] },
            { id: "cartesia:b4b8e2af-6139-466e-a93a-30c20d2e1fc5", name: "Fernanda", provider: "cartesia", language: "es", gender: "female", accent: "Mexican", preview_url: null, tags: ["friendly"] },
          ],
          languages: [{ code: "en", label: "English" }, { code: "es", label: "Spanish" }],
        },
      });
    }
    if (method === "GET" && path === "/api/v1/audio/elevenlabs-clones") {
      return send(res, 200, {
        success: true,
        data: { clones: [{ id: UGC_CLONE_ID, voice_id: `clone:${UGC_CLONE_ID}`, name: "My voice", language: "en", character_id: UGC_AVATAR_WITH_CLONE, sample_seconds: 41.5, created_at: "2026-11-10T09:00:00.000Z" }] },
      });
    }
    if (method === "POST" && path === "/api/v1/ugc/script") {
      if (!b.brief && !b.url && !b.brand_kit_id) return send(res, 400, { success: false, error: "Tell us what you're selling: a brief, a url or a brand kit" });
      if (!["talking_head", "product_in_hand", "show_your_app"].includes(String(b.format))) {
        return send(res, 400, { success: false, error: "format must be one of: talking_head, product_in_hand, show_your_app" });
      }
      return send(res, 200, {
        success: true,
        data: {
          credits_charged: 0,
          scripts: [
            { hook: "I almost gave up on my skin.", body: "Two weeks with this serum and the redness is gone.", cta: "Link is below.", text: "I almost gave up on my skin. Two weeks with this serum and the redness is gone. Link is below.", est_seconds: 6 },
            { hook: "Okay, this actually works.", body: "One drop at night, and my skin looks rested every morning.", cta: "Try it yourself.", text: "Okay, this actually works. One drop at night, and my skin looks rested every morning. Try it yourself.", est_seconds: 7 },
            { hook: "My dermatologist asked what changed.", body: "This serum. That's it.", cta: "Grab yours below.", text: "My dermatologist asked what changed. This serum. That's it. Grab yours below.", est_seconds: 5 },
          ],
        },
      });
    }
    if (method === "GET" && path === "/api/v1/ugc/ads/quote") {
      if (!rec.query.script_chars && !rec.query.est_seconds) return send(res, 400, { success: false, error: "script_chars or est_seconds is required" });
      const p = ugcAdPrice(rec.query);
      return send(res, 200, { success: true, data: { ...p, total: p.credits_per_ad * Number(rec.query.count ?? 1) } });
    }
    if (method === "POST" && path === "/api/v1/ugc/ads") {
      const actorIds = Array.isArray(b.actor_ids) ? (b.actor_ids as string[]) : [];
      const script = typeof b.script === "string" ? b.script : "";
      if (actorIds.length < 1 || actorIds.length > 4) return send(res, 400, { success: false, error: "actor_ids must list 1–4 actors" });
      if (script.trim().length < 10) return send(res, 400, { success: false, error: "script must be 10–1500 characters" });
      const names: Record<string, string> = { "maya-selfie": "Maya", "leo-car": "Leo", "hg-anna-home": "Anna" };
      const now = new Date().toISOString();
      const batch_id = "ua_7d3f9a2e-1c4b-4e8a-9b6d-2f5e8c1a7b30";
      let total = 0;
      const ads = actorIds.map((actorId, i) => {
        const voice = typeof b.voice_id === "string" ? b.voice_id : actorId === UGC_AVATAR_WITH_CLONE ? `clone:${UGC_CLONE_ID}` : undefined;
        total += ugcAdPrice({
          actor_id: actorId, voice_id: voice, format: String(b.format), resolution: b.resolution as string | undefined,
          captions: b.captions === false ? "false" : "true", script_chars: String(ugcSpokenChars(script)),
        }).credits_per_ad;
        return {
          id: `${batch_id}_${i + 1}`, batch_id, actor_id: actorId, actor_name: names[actorId] ?? "My avatar", format: b.format, status: "queued",
          script, voice_id: voice ?? "cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", resolution: b.resolution ?? "720p",
          audio_url: null, frame_url: null, video_url: null, raw_video_url: null, duration_s: null, error: null, created_at: now,
        };
      });
      ugcBatch = { batch_id, ads };
      ugcBatchReads = 0;
      return send(res, 202, { success: true, data: { batch_id, credits_charged: total, ads } });
    }
    const ugcBatchPath = /^\/api\/v1\/ugc\/ads\/(ua_[^/]+)$/.exec(path);
    if (method === "GET" && ugcBatchPath) {
      if (!ugcBatch || ugcBatch.batch_id !== ugcBatchPath[1]) return send(res, 404, { success: false, error: "batch not found" });
      ugcBatchReads += 1;
      // First read: still filming. Later reads: ad 1 finished, ad 2 failed (refunded).
      ugcBatch.ads = ugcBatch.ads.map((a, i) =>
        ugcBatchReads === 1
          ? { ...a, status: i === 0 ? "captioning" : "video" }
          : i === 0
            ? { ...a, status: "completed", video_url: `https://videos.versely.studio/ugc-ads/${String(a.id)}.mp4`, raw_video_url: `https://videos.versely.studio/ugc-ads/${String(a.id)}-raw.mp4`, duration_s: 7.4 }
            : { ...a, status: "failed", error: "The video didn't render." },
      );
      return send(res, 200, { success: true, data: { batch_id: ugcBatch.batch_id, ads: ugcBatch.ads } });
    }
    if (method === "GET" && path === "/api/v1/ugc/ads") {
      return send(res, 200, { success: true, data: { ads: ugcBatch ? ugcBatch.ads.slice(0, Number(rec.query.limit ?? 20)) : [] } });
    }

    // ─── avatarStudio (agent notes) ───
    // --- Avatar Studio (avatarStudio.ts): ready-made cast, add one, creations ---
    if (method === "GET" && path === "/api/v1/hooks/characters/premade") {
      return send(res, 200, { success: true, avatars: PREMADE_AVATARS });
    }
    if (method === "POST" && path === "/api/v1/hooks/characters/premade") {
      if (b.actor_id === "char-limit") return send(res, 409, { success: false, message: "You already have 12 avatars. Remove one to add another." });
      const a = PREMADE_AVATARS.find((p) => p.id === b.actor_id);
      if (!a) return send(res, 404, { success: false, message: "ready-made avatar not found" });
      return send(res, 201, {
        success: true,
        character: {
          id: "5b2f3c1e-8d4a-4f6b-9c7e-1a2b3c4d5e6f", brand_kit_id: null, name: a.name,
          description: "a woman in her late twenties with honey-blonde loose waves and a warm open smile", source: "uploaded", status: "ready",
          image_url: a.image_url,
          images: [{ url: a.image_url, request_id: null }, ...(a.full_body_url ? [{ url: a.full_body_url, request_id: null, kind: "full_body" }] : [])],
          image_requests: null, reference_image_url: null, image_model: null, error: null,
          created_at: "2026-11-14T10:00:00.000Z", updated_at: "2026-11-14T10:00:00.000Z",
        },
      });
    }
    const avatarCreations = /^\/api\/v1\/hooks\/characters\/([^/]+)\/creations$/.exec(path);
    if (method === "GET" && avatarCreations) {
      if (!/^[0-9a-f-]{36}$/i.test(avatarCreations[1])) return send(res, 404, { success: false, message: "character not found" });
      return send(res, 200, {
        success: true,
        creations: [
          { kind: "ugc_ad", id: "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f", title: "Okay so I tried this serum for two weeks…", thumbnail_url: null, status: "completed", created_at: "2026-11-13T18:00:00.000Z" },
          { kind: "hook_pack", id: "col_8f2a", title: "Serum hooks", thumbnail_url: "https://img.versely.studio/hooks/col_8f2a-1.jpg", status: "completed", created_at: "2026-11-12T12:00:00.000Z" },
          { kind: "slideshow", id: "ss_51b0", title: "5 steps to calm skin", thumbnail_url: "https://img.versely.studio/slides/ss_51b0-0.jpg", status: "completed", created_at: "2026-11-11T09:00:00.000Z" },
        ],
      });
    }

    // ─── aiCreator (agent notes) ───
    // --- AI creators: options, rooms (paid), create/edit via /automations, test take (paid), episodes, approve ---
    if (method === "GET" && path === "/api/v1/automations/ai-creator/options") {
      return send(res, 200, {
        success: true,
        formats: [
          { id: "kitchen_tips", label: "Kitchen tips", description: "Quick tricks for cooking, storing and prepping food.", needsProduct: false },
          { id: "product_demo", label: "Product demo", description: "Shows one product in use, using only what its product page says.", needsProduct: true },
          { id: "custom", label: "Custom topic", description: "Anything you describe in the topic.", needsProduct: false },
        ],
        settings: [{ id: "kitchen", label: "Kitchen" }, { id: "gym", label: "Gym" }, { id: "custom", label: "Custom" }],
        voices: AIC_VOICES.map(({ id, name, gender, accent, previewUrl }) => ({ id, name, gender, accent, previewUrl })),
        lengths: [15, 20, 30], defaultLength: 20, qualities: ["720p", "1080p"], defaultQuality: "720p",
        roomOptions: 4, roomCredits: 8,
      });
    }
    if (method === "GET" && path === "/api/v1/automations/ai-creator/public") {
      return send(res, 200, { success: true, lengths: [15, 20, 30], defaultLength: 20, qualities: ["720p", "1080p"], defaultQuality: "720p", episodeCredits: AIC_TABLE, roomCredits: 8 });
    }
    if (method === "GET" && path === "/api/v1/ugc/voices") {
      const provider = (id: string) => id.split(":")[0];
      return send(res, 200, {
        success: true,
        data: {
          voices: AIC_VOICES.map((v) => ({ id: v.id, name: v.name, provider: provider(v.id), language: v.language, accent: v.accent, gender: v.gender, preview_url: null, tags: v.tags })),
          languages: [{ code: "en", label: "English" }, { code: "es", label: "Spanish" }],
        },
      });
    }
    if (method === "GET" && path === "/api/v1/social/plan") {
      // An account without a posting plan: every post costs 1 credit per account.
      return send(res, 200, { success: true, plan: { tier: null, label: "No plan", max_accounts: null, connected: 1, unlimited_posts: false, posts_free: false, credits_per_account: 1, daily_post_limit: null, fair_use_posts_per_account_per_day: 5 } });
    }
    if (method === "GET" && path === "/api/v1/automations/ai-creator/rooms") {
      return send(res, 200, { success: true, making: aicRoomsMaking, rooms: aicLastRooms });
    }
    if (method === "POST" && path === "/api/v1/automations/ai-creator/rooms") {
      if (!b.avatarId) return send(res, 400, { success: false, code: "invalid_config", error: "Pick an avatar." });
      if (b.setting === "custom" && String(b.note ?? "").trim().length < 3) return send(res, 400, { success: false, code: "invalid_config", error: "Describe the room for a custom setting." });
      const images = [0, 1, 2, 3].map((i) => ({ url: `https://img.versely.studio/gen/ai-creator-rooms/user-smoke/${String(b.setting)}-00000000-0000-4000-8000-00000000000${i}.jpg` }));
      const set = { images, credits: 8, avatar_id: String(b.avatarId), setting: String(b.setting) };
      // A note of "slow" stands for a set that outlasts the tool's wait: it never answers here, and reads back later.
      if (String(b.note ?? "").includes("slow")) {
        aicRoomsMaking = true;
        aicPendingRooms = set;
        return;
      }
      aicLastRooms = { ...set, made_at: new Date().toISOString() };
      return send(res, 200, { success: true, images, credits: 8 });
    }
    if (method === "POST" && path === "/api/v1/automations" && b.kind === "ai_creator") {
      const config = (b.config ?? {}) as Record<string, unknown>;
      const bad = aicConfigError(config);
      if (bad) return send(res, 400, { success: false, error: bad });
      seq += 1;
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
      const row: Record<string, unknown> = {
        phase: "setup", approvedAt: null,
        id, kind: "ai_creator", kind_label: "AI creator", name: b.name, config: { ...config, avatarName: "Maya" },
        summary: aicSummary(config), credits_per_run: aicPrice(config), credits_spent: 0, preview: [],
        interval_seconds: 300, schedule: b.schedule ?? null, queue: [], upcoming: [], next_post_at: null,
        status: "paused", paused_reason: "user", running: false, next_run_at: null, last_run_at: null,
        run_count: 0, success_count: 0, failure_count: 0, consecutive_failures: 0, last_error: null, last_run: null,
        created_at: "2026-11-14T10:00:00.000Z", updated_at: "2026-11-14T10:00:00.000Z",
      };
      automations.set(id, row);
      aicEpisodes.set(id, []);
      return send(res, 201, { success: true, data: { automation: row }, message: "Automation created" });
    }
    const aicRow = /^\/api\/v1\/automations\/([^/]+)$/.exec(path);
    if (method === "PATCH" && aicRow && automations.get(decodeURIComponent(aicRow[1]!))?.kind === "ai_creator") {
      const row = automations.get(decodeURIComponent(aicRow[1]!))!;
      if (b.config !== undefined) {
        // PATCH replaces the whole config, so a tool that sends only the changed keys is refused here like on the real backend.
        const config = b.config as Record<string, unknown>;
        const bad = aicConfigError(config);
        if (bad) return send(res, 400, { success: false, error: bad });
        Object.assign(row, { config, summary: aicSummary(config), credits_per_run: aicPrice(config) });
      }
      if (b.name !== undefined) row.name = b.name;
      if (b.schedule !== undefined) row.schedule = b.schedule;
      return send(res, 200, { success: true, data: { automation: row } });
    }
    const aicKind = /^\/api\/v1\/automations\/ai-creator\/([^/]+)\/(test-episode|episodes|approve)$/.exec(path);
    if (aicKind) {
      const id = decodeURIComponent(aicKind[1]!);
      const row = automations.get(id);
      if (!row || row.kind !== "ai_creator") return send(res, 404, { success: false, code: "not_found", error: "AI creator not found" });
      const eps = aicEpisodes.get(id) ?? [];
      aicEpisodes.set(id, eps);
      if (method === "POST" && aicKind[2] === "test-episode") {
        if (eps.some((e) => e.status === "making")) return send(res, 409, { success: false, code: "not_ready", error: "A test take is already being made." });
        seq += 1;
        const epId = `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`;
        eps.unshift({ id: epId, status: "making", videoUrl: null, posterUrl: null, title: null, script: null, credits: 0, createdAt: new Date().toISOString(), scheduledFor: null, postedUrl: null, error: null });
        aicReads.set(id, 0);
        return send(res, 200, { success: true, episode: { id: epId, status: "making" } });
      }
      if (method === "GET" && aicKind[2] === "episodes") {
        // A take is ready on the second read after it started.
        const reads = (aicReads.get(id) ?? 0) + 1;
        aicReads.set(id, reads);
        const making = eps.find((e) => e.status === "making");
        if (making && reads > 1) {
          Object.assign(making, {
            status: "ready",
            videoUrl: `https://videos.versely.studio/gen/ai-creator/user-smoke/${String(making.id)}/episode.mp4`,
            posterUrl: `https://img.versely.studio/gen/ai-creator/user-smoke/${String(making.id)}/poster.jpg`,
            title: "The 10-second herb trick",
            script: "Your herbs die in two days?\nWrap them in a damp paper towel.\nThey last a full week.",
            credits: row.credits_per_run,
          });
        }
        return send(res, 200, { success: true, episodes: eps });
      }
      if (method === "POST" && aicKind[2] === "approve") {
        const cfg = (row.config ?? {}) as Record<string, unknown>;
        if (!row.schedule || !Array.isArray(cfg.post_account_ids) || cfg.post_account_ids.length === 0) {
          return send(res, 400, { success: false, code: "invalid_config", error: "Pick the account it posts to and its daily time first." });
        }
        const ready = eps.find((e) => e.status === "ready");
        if (!ready) return send(res, 409, { success: false, code: "not_ready", error: eps.some((e) => e.status === "making") ? "The test take is still being made." : "Make a test take first." });
        const firstPost = "2026-11-15T18:00:00.000Z";
        if (b.postTestEpisode === true) Object.assign(ready, { status: "scheduled", scheduledFor: firstPost });
        const nextDaily = b.postTestEpisode === true ? "2026-11-16T18:00:00.000Z" : firstPost;
        Object.assign(row, {
          phase: "approved", approvedAt: new Date().toISOString(), status: "active", paused_reason: null,
          queue: [{ id: "aic-q-1", post_at: nextDaily, run_at: nextDaily.replace("T18:", "T15:") }], next_post_at: firstPost,
        });
        return send(res, 200, { success: true, automation: row });
      }
    }

    // --- uploads: a file the user gave, fetched by the MCP server, PUT to "storage" ---
    if (method === "GET" && path.startsWith("/__files/")) {
      const name = path.slice("/__files/".length);
      if (name === "missing.mp4") return send(res, 404, { error: "not found" });
      const type = name.endsWith(".png") ? "image/png" : name.endsWith(".bin") ? "application/octet-stream" : name.endsWith(".pdf") ? "application/pdf" : "video/mp4";
      const size = name.startsWith("huge") ? 40 * 1024 * 1024 : 2048;
      res.writeHead(200, { "content-type": type, "content-length": String(size) });
      res.end(Buffer.alloc(size, 7));
      return;
    }
    if (method === "POST" && path === "/api/v1/bucket/presign") {
      const name = String(b.file_name ?? "");
      const type = String(b.content_type ?? "");
      if (!name || !type || !Number.isInteger(b.size) || Number(b.size) <= 0) return send(res, 400, { error: "file_name, content_type and size are required" });
      const video = type.startsWith("video/");
      const image = type.startsWith("image/");
      const bucket = video ? "videos" : image ? "images" : "user-files";
      const key = video || image ? `usr/user-smoke/${name}` : `user-smoke/1_${name}`;
      const host = video ? "videos.versely.studio" : image ? "img.versely.studio" : "user-files.versely.studio";
      return send(res, 200, {
        success: true,
        upload_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__r2/${bucket}/${key}`,
        key,
        bucket,
        url: `https://${host}/${key}`,
        expires_in: 900,
        headers: { "Content-Type": type },
      });
    }
    if (method === "PUT" && path.startsWith("/__r2/")) {
      res.writeHead(200);
      res.end();
      return;
    }
    if (method === "POST" && path === "/api/v1/bucket/presign/complete") {
      const key = String(b.key ?? "");
      const bucket = String(b.bucket ?? "");
      const host = bucket === "videos" ? "videos.versely.studio" : bucket === "images" ? "img.versely.studio" : "user-files.versely.studio";
      const put = requests.filter((r) => r.method === "PUT" && r.path === `/__r2/${bucket}/${key}`).at(-1);
      if (!put) return send(res, 404, { success: false, error: "The file never landed in storage. Upload it again." });
      return send(res, 200, { success: true, files: [{ name: b.name, url: `https://${host}/${key}`, key, size: put.bytes, mimeType: put.headers["content-type"] ?? "" }] });
    }

    // --- Remix: trend library, clip, quote, swap ---
    const swapFail = (status: number, code: string, message: string) => send(res, status, { success: false, error: { code, message }, code, message });
    if (method === "GET" && path === "/api/v1/remix/library") {
      const tab = rec.query.tab || "trending";
      const tabs = [
        { id: "trending", label: "Trending", count: 2 }, { id: "dance", label: "Dance", count: 1 }, { id: "versely", label: "Versely moves", count: 1 },
      ];
      const items =
        tab === "versely"
          ? [{ id: "versely-groove-two-step", kind: "versely", motion_id: "groove-two-step", cover_url: "https://avatars.versely.studio/remix-motions/groove-two-step.jpg", duration: 6, caption: "Two-step groove", category: "versely", suggested_mode: "motion", people: 1 }]
          : [
              { id: "t1", kind: "trend", inspiration_id: "insp-dance-1", platform: "tiktok", cover_url: "https://img.versely.studio/remix/t1.jpg", duration: 14.2, views: 12400000, author_handle: "dancer.one", caption: "POV: the  hallway   dance", category: "dance", suggested_mode: "swap", people: 1 },
              { id: "t2", kind: "trend", inspiration_id: "insp-duo-2", platform: "instagram", cover_url: "https://img.versely.studio/remix/t2.jpg", duration: 9, views: 3100000, author_handle: "@duo", caption: "Couple transition", category: "couples", suggested_mode: "swap", people: 2 },
            ];
      return send(res, 200, { success: true, available: true, modes: { swap: true, motion: true }, tabs, tab, items, next_cursor: null });
    }
    if (method === "POST" && path === "/api/v1/remix/sources/preview") {
      const given = ["inspiration_id", "link", "video_url", "motion_id"].filter((k) => typeof b[k] === "string" && b[k]);
      if (given.length !== 1) return swapFail(400, "invalid_request", "Send exactly one of inspiration_id, link, video_url or motion_id.");
      if (typeof b.link === "string" && b.link.includes("private")) return swapFail(422, "download_failed", "We couldn't download that post. It may be private.");
      if (typeof b.video_url === "string" && !b.video_url.startsWith("https://videos.versely.studio/usr/user-smoke/")) {
        return swapFail(400, "not_your_upload", "Upload the video to Versely first, then swap it.");
      }
      return send(res, 200, {
        success: true, preview_id: "0a0a0a0a-0000-4000-8000-000000000001", video_url: "https://videos.versely.studio/tmp/remix-previews/user-smoke/p1.mp4?sig=1",
        poster_url: null, duration: 22, width: 720, height: 1280, has_audio: true, suggested: { start: 3, end: 11 }, min_window: 4, max_window: 15,
        original_duration: 22, expires_at: "2026-11-20T10:00:00.000Z",
      });
    }
    if (method === "POST" && path === "/api/v1/remix/sources") {
      const start = Number(b.start ?? 0);
      const end = Number(b.end ?? 15);
      if (!b.preview_id) return swapFail(400, "invalid_request", "Send exactly one of preview_id, link, video_url or inspiration_id.");
      swapSeq += 1;
      const id = `5b5b5b5b-0000-4000-8000-${String(swapSeq).padStart(12, "0")}`;
      swapSources.set(id, { seconds: end - start });
      return send(res, 200, {
        success: true, source_id: id, video_url: `https://videos.versely.studio/tmp/swap-sources/user-smoke/${id}.mp4?sig=1`,
        poster_url: `https://img.versely.studio/tmp/swap-sources/user-smoke/${id}.jpg?sig=1`, duration: end - start, width: 720, height: 1280,
        has_audio: true, original_duration: 22, start, expires_at: "2026-11-20T10:00:00.000Z",
      });
    }
    const swapPer = (seconds: number, resolution: unknown, quality: unknown) =>
      Math.ceil(seconds) * (resolution === "1080p" ? 24 : resolution === "720p" ? 12 : 6) * (quality === "pro" ? 2 : 1);
    if (method === "POST" && path === "/api/v1/remix/swap/quote") {
      const src = swapSources.get(String(b.source_id));
      if (!src) return swapFail(404, "source_not_found", "That clip has expired. Add it again to swap it.");
      const variants = Number(b.variants ?? 1);
      const per = swapPer(src.seconds, b.resolution, b.quality);
      const quote: Record<string, unknown> = {
        mode: b.mode ?? "swap", credits: per * variants, per_variant: per, seconds: Math.ceil(src.seconds), variants,
        resolution: b.resolution, quality: b.quality ?? "lite", model: b.mode === "motion" ? "Versely Remix Moves" : "Versely Swap",
      };
      const balance = Number(b.fit_credits);
      if (Number.isFinite(balance) && per * variants > balance) {
        quote.fits = [{ resolution: "480p", seconds: Math.ceil(src.seconds), credits: swapPer(src.seconds, "480p", b.quality) }];
        quote.minimum = { resolution: "480p", seconds: 4, credits: 24 };
      }
      return send(res, 200, { success: true, ...quote });
    }
    if (method === "POST" && path === "/api/v1/remix/swap") {
      const src = swapSources.get(String(b.source_id));
      if (!src) return swapFail(404, "source_not_found", "That clip has expired. Add it again to swap it.");
      if (b.rights_confirmed !== true) return swapFail(400, "rights_required", "Confirm you own this clip or have permission to use it.");
      const slots = Array.isArray(b.slots) ? (b.slots as Array<Record<string, unknown>>) : [];
      if (slots.some((sl) => String(sl.image_url ?? "").includes("nude"))) {
        return swapFail(400, "content_policy", "The photo shows nudity or sexual content, which Swap can't use. Change the photo. Nothing was charged.");
      }
      const variants = Number(b.variants ?? 1);
      const per = swapPer(src.seconds, b.resolution, b.quality);
      const failing = slots.some((sl) => String(sl.target ?? "").includes("fails"));
      const jobIds = Array.from({ length: variants }, (_, i) => `${failing ? "swap-fail" : "swap-job"}-${++swapSeq}-${i + 1}`);
      return send(res, 200, {
        success: true, mode: b.mode ?? "swap", job_ids: jobIds, credits_held: per * variants, prompt: "Replace the person with the person in image 1.",
        per_variant: per, variants, variants_failed: 0, credits_refunded: 0, batch_id: b.batch_id, model: "Versely Swap", resolution: b.resolution, seconds: Math.ceil(src.seconds),
      });
    }

    const status = /^\/api\/v1\/status\/(.+)$/.exec(path);
    if (method === "GET" && status) {
      const id = decodeURIComponent(status[1]!);
      if (id.startsWith("swap-fail-")) return send(res, 200, { status: "failed", type: "videos", error: "The engine turned this clip down." });
      if (id.startsWith("swap-job-")) {
        const n = (swapReads.get(id) ?? 0) + 1;
        swapReads.set(id, n);
        if (n < 2) return send(res, 200, { status: "processing", type: "videos" });
        return send(res, 200, { status: "completed", type: "videos", model: "Versely Swap", result_urls: [`https://videos.versely.studio/gen/remix/${id}.mp4`], thumbnail_url: `https://img.versely.studio/gen/remix/${id}.jpg` });
      }
      if (id === "status-500") return send(res, 500, { error: "status store down" });
      if (id.startsWith("pending-")) {
        return send(res, 200, { status: "processing", progress: 40, type: "videos", provider_trace: "trace-123" });
      }
      return send(res, 200, {
        status: "completed",
        type: "images",
        result_urls: [`https://img.versely.studio/out/${id}.png`],
      });
    }

    // --- UGC / features (synchronous) ---
    if (method === "POST" && path === "/api/v1/ugc/add-video-overlay") {
      return send(res, 200, {
        success: true,
        message: "Video overlay added successfully",
        data: { ugc_video_id: "ugc-1", video_url: "https://videos.versely.studio/ugc/overlay-1.mp4", credits_used: 5 },
      });
    }
    const ugc = /^\/api\/v1\/ugc\/([^/]+)$/.exec(path);
    if (method === "GET" && ugc) {
      return send(res, 200, {
        success: true,
        data: {
          id: ugc[1],
          status: "completed",
          slideshow_video_url: "https://videos.versely.studio/in/base.mp4",
          overlay_video_url: "https://videos.versely.studio/in/overlay.mp4",
          final_video_url: "https://videos.versely.studio/out/final.mp4",
        },
      });
    }
    if (method === "POST" && path === "/api/v1/features/merge-videos") {
      const urls = Array.isArray(b.video_urls) ? (b.video_urls as string[]) : [];
      if (urls.some((u) => u.includes("slow"))) {
        await new Promise((r) => setTimeout(r, opts.slowMergeMs ?? 70_000));
      }
      seq += 1;
      return send(res, 200, {
        success: true,
        message: "Videos merged successfully",
        data: { video_url: `https://videos.versely.studio/merged/merge-${seq}.mp4` },
      });
    }

    // --- movie / dubbing status (card poll targets) ---
    const movie = /^\/api\/v1\/movie\/([^/]+)\/status$/.exec(path);
    if (method === "GET" && movie) {
      return send(res, 200, {
        success: true,
        data: { movie_id: movie[1], status: "generating", title: "Smoke movie", scenes_total: 2, scenes_completed: 0, scenes: [] },
      });
    }
    const dub = /^\/api\/v1\/dubbing\/([^/]+)$/.exec(path);
    // The real row also names the engine (options.engine, served_provider) and carries its job id.
    const dubRow = (id: string) => ({ id, name: "Dub → es", status: "dubbing", media_type: "video", target_langs: ["es"], dubbing_id: "el_job_123", options: { engine: "elevenlabs", num_speakers: 0 }, served_provider: "elevenlabs", created_at: "2026-11-14T10:00:00.000Z" });
    if (method === "GET" && dub) {
      return send(res, 200, { success: true, project: dubRow(dub[1]!) });
    }
    if (method === "GET" && path === "/api/v1/dubbing") {
      return send(res, 200, { success: true, projects: [dubRow("dub-1")], has_more: false, next_cursor: "2026-11-14T10:00:00.000Z" });
    }

    // --- social posting (the real contract: publish answers with Post for Me's id) ---
    if (method === "GET" && path === "/api/v1/social/auth-url") {
      const platform = rec.query.platform ?? "";
      // Like services/social.service.ts: Bluesky has no connect page (handle + app password only).
      if (platform === "bluesky") return send(res, 500, { success: false, error: "Bluesky needs your handle and an app password" });
      // Pinterest stands in for a plan whose account limit is full (lib/postingPlan accountLimitBody).
      if (platform === "pinterest") {
        return send(res, 409, {
          success: false, code: "account_limit",
          error: "Your Standard plan includes up to 10 connected accounts and you have 10. Disconnect one to add another. Pro includes up to 100.",
          plan: { tier: "standard", label: "Standard", max_accounts: 10, unlimited_posts: true, connected: 10, posts_free: true, can_connect: false },
        });
      }
      return send(res, 200, { success: true, url: `https://connect.postforme.test/${platform}?state=abc` });
    }
    if (method === "GET" && path === "/api/v1/social/accounts") {
      return send(res, 200, {
        success: true,
        // Row bookkeeping as the real table returns it: ChatGPT must not see user_id or connected_at.
        accounts: [{ id: "acct-db-1", external_account_id: "spc_ext_1", platform: "tiktok", username: "smoke", is_active: true, user_id: "user-smoke", connected_at: "2026-09-01T10:00:00Z", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-20T10:00:00Z", served_provider: "postforme" }],
      });
    }
    if (method === "POST" && path === "/api/v1/social/posts") {
      if (b.caption === "short balance") return send(res, 403, { success: false, error: "Failed to deduct credits" });
      seq += 1;
      const ext = `sp_ext_${seq}`;
      socialPosts.unshift({ id: `post-db-${seq}`, external_post_id: ext, text: b.caption, status: "processing", platforms: ["tiktok"] });
      return send(res, 200, {
        success: true,
        post: { id: ext, caption: b.caption, status: "processing", platforms: ["tiktok"] },
        credits_charged: 1,
      });
    }
    if (method === "GET" && path === "/api/v1/social/posts") {
      return send(res, 200, { success: true, posts: socialPosts.slice(0, Number(rec.query.limit ?? 20)) });
    }
    const socialPost = /^\/api\/v1\/social\/posts\/([^/]+)$/.exec(path);
    if (socialPost && (method === "PATCH" || method === "DELETE" || method === "GET")) {
      const row = socialPosts.find((p) => p.id === decodeURIComponent(socialPost[1]!));
      if (!row) return send(res, 404, { success: false, error: "Post not found" });
      if (method === "DELETE") return send(res, 200, { success: true, refunded: 1 });
      if (method === "PATCH") return send(res, 200, { success: true, post: { ...row, ...b } });
      return send(res, 200, { success: true, post: row, results: [] });
    }

    // --- short dramas: plan, edit, write, quote, film (409 on a stale price), follow ---
    const dramaShow = /^\/api\/v1\/drama\/shows\/([^/]+)$/.exec(path);
    const dramaEp = /^\/api\/v1\/drama\/shows\/([^/]+)\/episodes\/(\d+)\/(script|quote|film)$/.exec(path);
    if (method === "POST" && path === "/api/v1/drama/shows") {
      drama = makeDramaShow(String(b.idea ?? ""), b.episode_seconds === 15 ? 15 : 30, dramaTier(b.quality, b.resolution));
      dramaReads = 0;
      return send(res, 200, { success: true, show: drama });
    }
    if (method === "GET" && path === "/api/v1/drama/shows") {
      return send(res, 200, { success: true, shows: drama ? [{ id: drama.id, title: drama.title, logline: drama.logline, genre: drama.genre, episodes: { ready: 0, planned: 2, scripted: 1 }, cover_url: null, updated_at: "2026-11-04T10:00:00.000Z" }] : [] });
    }
    if (dramaShow && drama && dramaShow[1] === drama.id) {
      const eps = drama.episodes as Array<Record<string, unknown>>;
      if (method === "GET") {
        // A filming episode is ready on the second read after the film call.
        if (eps[0]!.status === "filming" && ++dramaReads > 1) {
          eps[0] = { ...eps[0], status: "ready", video_url: `https://videos.versely.studio/drama/${drama.id}-1.mp4`, poster_url: `https://videos.versely.studio/drama/${drama.id}-1.jpg` };
        }
        return send(res, 200, { success: true, show: drama });
      }
      if (method === "DELETE") {
        if (eps.some((e) => e.status === "filming")) return send(res, 409, { success: false, error: "Episode 1 is filming. Delete the show once it's done.", code: "filming" });
        drama = null;
        return send(res, 200, { success: true });
      }
      if (method === "PATCH") {
        // Like the backend (services/drama/service.ts resetScripts): a new length or language drops every
        // unfilmed script, back to planned; a new quality or resolution keeps the scripts and re-prices them.
        const reset = (b.language !== undefined && b.language !== drama.language) || (b.episode_seconds !== undefined && b.episode_seconds !== drama.episode_seconds);
        for (const k of ["title", "logline", "language", "episode_seconds"]) if (b[k] !== undefined) drama[k] = b[k];
        if (reset) {
          for (const ep of eps) if (ep.status === "scripted" || ep.status === "failed") Object.assign(ep, { status: "planned", script: null, credits: null, error: null });
        }
        // Like the backend, a new quality keeps the resolution tier (Standard's 1080p becomes High quality 720p).
        if (b.quality !== undefined || b.resolution !== undefined) {
          const tier = dramaTier(b.quality ?? drama.quality, b.resolution ?? drama.resolution);
          Object.assign(drama, tier);
          for (const ep of eps) if (ep.status === "scripted") ep.credits = dramaCredits(tier, ep.script as DramaScriptShape);
        }
        return send(res, 200, { success: true, show: drama });
      }
    }
    if (dramaEp && drama && dramaEp[1] === drama.id) {
      const eps = drama.episodes as Array<Record<string, unknown>>;
      const ep = eps[Number(dramaEp[2]) - 1];
      if (!ep) return send(res, 404, { success: false, error: "Episode not found" });
      if (method === "POST" && dramaEp[3] === "script") {
        const script = { clips: [{ seconds: 15, location: "office", cast: ["mara"], shots: [{ camera: "close-up on mara", action: "she smiles", lines: [{ who: "mara", line: `Notes: ${String(b.notes ?? "none")}` }] }] }] };
        Object.assign(ep, { status: "scripted", credits: dramaCredits({ quality: String(drama.quality), resolution: String(drama.resolution) }, script), script });
        return send(res, 200, { success: true, show: drama, episode: ep });
      }
      if (method === "GET" && dramaEp[3] === "quote") {
        return send(res, 200, { success: true, credits: ep.credits, seconds: drama.episode_seconds, resolution: drama.resolution, quality: drama.quality, balance: 250 });
      }
      if (method === "POST" && dramaEp[3] === "film") {
        if (ep.status === "filming" || ep.status === "ready") return send(res, 409, { success: false, error: "already_filming", message: "This episode is already filming." });
        if (b.confirm_credits !== ep.credits) return send(res, 409, { success: false, error: "price_changed", message: "The price changed.", credits: ep.credits });
        Object.assign(ep, { status: "filming", started_at: new Date().toISOString() });
        dramaReads = 0;
        return send(res, 202, { success: true, episode: ep });
      }
    }

    // --- hooks studio: library deck, collections, characters, beds; analytics ---
    // Like the real deck: at most 50 a call, a brief of 10+ characters, an exact scene match.
    if (method === "GET" && path === "/api/v1/hooks/deck") {
      const brief = rec.query.brief;
      if (brief !== undefined && brief.trim().length < 10) return send(res, 400, { success: false, error: "Tell us a little more - at least 10 characters" });
      const plate = { id: "plate-1", title: "Cafe reaction", video_url: "https://videos.versely.studio/hooks/plate-1.mp4", preview_url: "https://videos.versely.studio/hooks/plate-1.mp4", thumbnail_url: "https://img.versely.studio/hooks/plate-1.jpg", vibe: "cafe", emotion: "surprised", line: "You won't believe this app", duration_sec: 4 };
      const hooks = !rec.query.vibe || rec.query.vibe === "cafe" ? [plate] : [];
      return send(res, 200, { success: true, hooks, remaining: rec.query.vibe ? hooks.length : 155, total_active: 155 });
    }
    if (method === "POST" && path === "/api/v1/hooks/collections") {
      // Like the real packs: the ask (brand_context) must be 10-500 characters.
      if (b.kind !== "reuse" && (typeof b.brand_context !== "string" || b.brand_context.trim().length < 10 || b.brand_context.trim().length > 500)) {
        return send(res, 400, { success: false, error: "brand_context must be 10–500 characters" });
      }
      collectionReads.set("col-1", 0);
      return send(res, 202, { success: true, collection: { id: "col-1", kind: b.kind, status: "queued", title: b.title ?? null }, items: [] });
    }
    const hcol = /^\/api\/v1\/hooks\/collections\/([^/]+)$/.exec(path);
    if (method === "GET" && hcol) {
      const reads = (collectionReads.get(hcol[1]!) ?? 0) + 1;
      collectionReads.set(hcol[1]!, reads);
      const done = reads > 2;
      return send(res, 200, {
        success: true,
        collection: { id: hcol[1], kind: "reuse", status: done ? "completed" : "processing", count: 1 },
        items: [{ id: "it-1", sort: 0, status: done ? "completed" : "processing", hook_line: "You won't believe this app", video_url: done ? "https://videos.versely.studio/hooks/col-1-1.mp4" : null }],
      });
    }
    const hsched = /^\/api\/v1\/hooks\/collections\/([^/]+)\/schedule$/.exec(path);
    if (method === "POST" && hsched) return send(res, 200, { success: true, scheduled: 1, first_at: b.start_at ?? null });
    if (method === "GET" && path === "/api/v1/hooks/music-beds") {
      return send(res, 200, { success: true, beds: [{ id: "bed-9", title: "Sunny", url: "https://audio.versely.studio/beds/sunny.mp3", mood: "happy", energy: "mid", bpm: 110 }] });
    }
    if (method === "GET" && path === "/api/v1/hooks/characters") {
      return send(res, 200, { success: true, characters: [{ id: "char-1", name: "Mia", status: "ready", image_url: "https://img.versely.studio/c/mia.png" }] });
    }
    // The real answer for an account without a subscription.
    if (method === "GET" && path === "/api/v1/social-analytics/overview") {
      return send(res, 403, { success: false, error: "Post analytics comes with a subscription, and with the trial while it runs." });
    }
    const analyticsCollect = /^\/api\/v1\/social-analytics\/([^/]+)\/collect$/.exec(path);
    if (method === "POST" && analyticsCollect) return send(res, 200, { success: true });
    const analyticsPost = /^\/api\/v1\/social-analytics\/([^/]+)$/.exec(path);
    if (method === "GET" && analyticsPost && analyticsPost[1] !== "overview") {
      return send(res, 200, { success: true, post_id: analyticsPost[1], stats: { views: 1200, likes: 90 } });
    }

    // --- inspiration library, trending sounds, quick hooks, trend analysis, feed ---
    const INSPO: Record<string, Record<string, unknown>> = {
      "insp-s1": {
        id: "insp-s1", content_type: "slideshow", platform: "tiktok", url: "https://www.tiktok.com/@a/photo/1",
        author_handle: "a", author_followers: 1000, plays: 65000, is_outlier: true, outlier_score: 65, niche: "fitness",
        hook_text: "5 habits that changed my mornings", slide_texts: ["Wake at 6", "No phone", "Walk"], caption: "try these",
        cover_url: "https://img.versely.studio/ref/inspiration/1/cover.jpg",
      },
      "insp-v1": {
        id: "insp-v1", content_type: "video", platform: "tiktok", url: "https://www.tiktok.com/@b/video/2",
        author_handle: "b", author_followers: 2000, plays: 900000, is_outlier: true, outlier_score: 450, niche: "tech",
        hook_text: "girls you need this camera app", caption: "link in bio", cover_url: "https://img.versely.studio/ref/inspiration/2/cover.jpg",
      },
    };
    if (method === "GET" && path === "/api/v1/inspiration/niches") {
      return send(res, 200, { success: true, niches: [{ slug: "fitness", label: "Fitness", count: 120, outlier_count: 40 }], mediums: [{ medium: "mobile_app", count: 30 }], total: 500 });
    }
    if (method === "GET" && path === "/api/v1/inspiration/posts") {
      return send(res, 200, { success: true, posts: Object.values(INSPO), next_cursor: "c2", total: 2 });
    }
    const inspo = /^\/api\/v1\/inspiration\/posts\/([^/]+)$/.exec(path);
    if (method === "GET" && inspo) {
      const p = INSPO[decodeURIComponent(inspo[1]!)];
      return p ? send(res, 200, { success: true, post: p }) : send(res, 404, { success: false, error: "not found" });
    }
    if (method === "GET" && path === "/api/v1/inspiration/sounds") {
      return send(res, 200, { success: true, sounds: [{ id: "snd-1", rank: 1, title: "September", author: "EWF", outlier_uses: 2, vibe: { mood: "joyful" }, bed: { id: "bed-1", title: "September (Versely bed)", url: "https://audio.versely.studio/hooks/beds/trending/september.mp3" } }] });
    }
    if (method === "POST" && path === "/api/v1/hooks/quick") {
      quickReads.set("qb-1", 0);
      return send(res, 202, { success: true, data: { batch_id: "qb-1", credits_charged: 40, hooks: [{ id: "h1", batch_id: "qb-1", status: "queued" }] } });
    }
    if (method === "GET" && path === "/api/v1/hooks/quick/models") {
      return send(res, 200, { success: true, data: { models: [{ name: "VEO 3.1 Fast", durations: [4, 6, 8] }] } });
    }
    const qb = /^\/api\/v1\/hooks\/quick\/([^/]+)$/.exec(path);
    if (method === "GET" && qb) {
      const reads = (quickReads.get(qb[1]!) ?? 0) + 1;
      quickReads.set(qb[1]!, reads);
      const hook = reads > 1
        ? { id: "h1", batch_id: qb[1], status: "completed", hook_line: "You need this app", video_url: "https://videos.versely.studio/hooks/h1.mp4" }
        : { id: "h1", batch_id: qb[1], status: "video", hook_line: "You need this app", video_url: null };
      return send(res, 200, { success: true, data: { batch_id: qb[1], hooks: [hook] } });
    }
    if (method === "POST" && path === "/api/v1/trend-analysis/analyze") {
      return send(res, 202, { success: true, id: "ta-1", status: "scraping", credits_used: 1 });
    }
    if (method === "GET" && path === "/api/v1/trend-analysis/ta-1") {
      return send(res, 200, { success: true, id: "ta-1", status: "completed", platform: "tiktok", originalUrl: "https://www.tiktok.com/@b/video/2", analysis: { hook: { text: "girls you need this", technique: "direct address" } }, stats: { plays: 900000 } });
    }
    if (method === "POST" && path === "/api/v1/trending-feed/import") {
      return send(res, 200, { success: true, credits_used: 1, video: { url: "https://videos.versely.studio/usr/imported-1.mp4", title: "Imported", platform: "tiktok" } });
    }

    // --- picker sources: caption styles, AI / workflow / slideshow templates ---
    if (method === "GET" && path === "/api/v1/slideshow/caption-styles") {
      return send(res, 200, {
        success: true,
        data: ["pink-pop", "keyline-plate", "butter-notes"].map((id) => ({
          id, label: id.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" "), blurb: `The ${id} look`,
          example: { topic: "x", slides: [1, 2, 3, 4, 5].map((n) => `https://img.versely.studio/ref/slideshow-styles/${id}-${n}.webp`) },
        })),
      });
    }
    if (method === "GET" && path === "/api/v1/templates") {
      return send(res, 200, {
        success: true,
        data: [{
          id: "finger_snap", name: "Finger Snap", description: "Snap into a character", category: "Trending",
          thumbnailUrl: "https://videos.versely.studio/finger-snap/input-character.png",
          previewVideoUrl: "https://videos.versely.studio/finger-snap/finger-snap.mp4", estimatedCreditCost: 68,
          inputs: [{ field: "user_image_url", type: "image_url", label: "Your photo", required: true }],
        }],
      });
    }
    if (method === "POST" && path === "/api/v1/templates/runs") {
      templateRunReads.set("run-1", 0);
      return send(res, 200, { success: true, data: { runId: "run-1" } });
    }
    const tRun = /^\/api\/v1\/templates\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && tRun) {
      const reads = (templateRunReads.get(tRun[1]!) ?? 0) + 1;
      templateRunReads.set(tRun[1]!, reads);
      return send(res, 200, {
        success: true,
        data: reads > 1
          ? { id: tRun[1], template_id: "finger_snap", status: "completed", final_asset_url: "https://videos.versely.studio/templates/run-1.mp4" }
          : { id: tRun[1], template_id: "finger_snap", status: "running" },
      });
    }
    if (method === "GET" && path === "/api/v1/public-workflows") {
      return send(res, 200, { success: true, templates: [{ id: "wt-1", slug: "ugc-hook", title: "UGC hook", description: "A hook, a demo, a CTA", thumbnail_url: "https://img.versely.studio/t/ugc.png", estimated_credit_cost: 120 }] });
    }
    const wClone = /^\/api\/v1\/public-workflows\/([^/]+)\/clone$/.exec(path);
    if (method === "POST" && wClone) return send(res, 201, { success: true, workflow_id: "wf-9", name: "UGC hook" });
    if (method === "GET" && path === "/api/v1/public-slideshows") {
      return send(res, 200, { success: true, templates: [{ id: "st-1", slug: "morning-routine", title: "Morning routine", thumbnail_url: "https://img.versely.studio/t/morning.png", num_images: 4, estimated_credit_cost: 20 }] });
    }
    const sTpl = /^\/api\/v1\/public-slideshows\/([^/]+)$/.exec(path);
    if (method === "GET" && sTpl && sTpl[1] !== "categories") {
      return send(res, 200, { success: true, template: { slug: sTpl[1], title: "Morning routine", recreate_prompt: "5 morning habits that changed my life", num_images: 4, content_type: "story", model: "Nano Banana Pro" } });
    }
    const sRecreate = /^\/api\/v1\/public-slideshows\/([^/]+)\/recreate$/.exec(path);
    if (method === "POST" && sRecreate) return send(res, 200, { success: true });
    const restyle = /^\/api\/v1\/slideshow\/([^/]+)\/caption-style$/.exec(path);
    if (method === "POST" && restyle) return send(res, 200, { success: true, data: { slideshow_id: restyle[1], caption_style: b.caption_style } });

    // --- brand kits (agenticContext.controller) ---
    if (method === "POST" && path === "/api/v1/agentic/brand-kit/analyze") {
      const kit = {
        id: `brand-${brands.size + 1}`, name: "Acme Coffee", tagline: "Slow mornings, great coffee", brand_type: "coffee roaster",
        description: "Small-batch coffee roaster.", audience: "home baristas", voice_tone: "warm, unhurried",
        products: [{ name: "Morning Blend", price: "$18" }], content_angles: ["pour-over basics at home", "choosing beans"],
        website_url: String(b.url ?? ""), is_default: brands.size === 0,
      };
      brands.set(kit.id, kit);
      const { id: _id, is_default: _d, ...brand } = kit;
      return send(res, 200, { success: true, saved: true, brand, uncertain: ["pricing"] });
    }
    if (method === "GET" && path === "/api/v1/agentic/brand-kit") {
      const kits = [...brands.values()];
      const requested = rec.query.brand_id ? kits.find((k) => k.id === rec.query.brand_id) : undefined;
      return send(res, 200, { success: true, brand_kit: requested ?? kits[0] ?? null, brand_kits: kits });
    }
    if (method === "PUT" && path === "/api/v1/agentic/brand-kit") {
      const kit = brands.get(String(b.brand_id ?? ""));
      if (!kit) return send(res, 404, { success: false, error: "That brand was not found." });
      const { brand_id: _b, ...fields } = b;
      Object.assign(kit, fields);
      return send(res, 200, { success: true });
    }

    // --- slideshows: models (with the avatar slideshow's price), video render ---
    if (method === "GET" && path === "/api/v1/slideshow/models") {
      return send(res, 200, { success: true, data: { models: ["Flux Pro Ultra", "Seedream 5.0 Pro"], aspect_ratios: { reel: "9:16" }, content_types: ["reel", "story", "post", "portrait", "landscape"], avatar_model: { name: "Nano Banana 2 Edit", credits_per_slide: 4 } } });
    }
    const showVideo = /^\/api\/v1\/slideshow\/([^/]+)\/video$/.exec(path);
    if (method === "POST" && showVideo) {
      return send(res, 200, { success: true, data: { video_url: `https://videos.versely.studio/slideshows/${showVideo[1]}.mp4`, duration: 9 } });
    }

    // --- slideshows: create-automated answers at once; the row fills in later ---
    if (method === "POST" && path === "/api/v1/slideshow/create-automated") {
      seq += 1;
      const id = `ss-${seq}`;
      slideshowReads.set(id, 0);
      return send(res, 200, { success: true, data: { slideshow_id: id, status: "generating", credits_charged: 25, images: [{ id: "i1", order: 1, url: null }] } });
    }
    if (method === "POST" && path === "/api/v1/slideshow/create-pinterest-auto") {
      seq += 1;
      const id = `pin-${seq}`;
      slideshowReads.set(id, 99);
      return send(res, 200, { success: true, data: { slideshow_id: id, status: "completed", images: [] } });
    }
    const showRow = /^\/api\/v1\/slideshow\/((?:ss|pin)-\d+)$/.exec(path);
    if (method === "GET" && showRow) {
      const id = showRow[1]!;
      const reads = (slideshowReads.get(id) ?? 0) + 1;
      slideshowReads.set(id, reads);
      // First read: still generating with one slide done; after that: done, captioned.
      const done = reads > 1;
      const images = [1, 2, 3].map((n) => ({
        id: `${id}-img-${n}`, order_index: n,
        image_url: done || n === 1 ? `https://slideshow-images.versely.studio/${id}/${n}.png` : null,
        ...(done ? { edited_image_url: `https://slideshow-images.versely.studio/${id}/${n}-captioned.png` } : {}),
      }));
      return send(res, 200, {
        success: true,
        data: { id, prompt: "a topic", model: "Flux Pro Ultra", num_images: 3, status: done ? "completed" : "generating", is_generating: !done, images },
      });
    }

    // --- stock avatars (avatar.controller: VEED = preview URLs named by id) ---
    if (method === "GET" && path === "/api/v1/avatar") {
      return send(res, 200, {
        success: true,
        data: [
          "https://avatars.versely.studio/veed-avatars-2/emily_vertical_primary.mp4",
          "https://avatars.versely.studio/veed-avatars-2/marcus_primary.png",
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/avatar/heygen") {
      return send(res, 200, { success: true, data: [{ avatar_id: "abigail_1", name: "Abigail", gender: "female", preview_image_url: null }] });
    }
    if (method === "GET" && path === "/api/v1/avatar/heygen/voices") {
      return send(res, 200, { success: true, data: [{ voice_id: "sara_1", name: "Sara", language: "English", gender: "female" }] });
    }

    // --- billing (billing.controller's reply shapes) ---
    const SUB = { status: "active", plan_label: "Pro Monthly", plan_key: "pro_monthly", provider: "dodo", current_period_end: "2026-10-24T00:00:00.000Z", is_trial: false, cancel_at_period_end: false };
    if (method === "GET" && path === "/api/v1/billing/subscription") return send(res, 200, { success: true, subscription: SUB });
    // The plan list and the web trial offer, as GET /billing/plans and GET
    // /billing/trial answer since 2026-11-12 (the first week for $3, Weekly only).
    if (method === "GET" && path === "/api/v1/billing/plans") {
      return send(res, 200, {
        success: true,
        configured: true,
        addonRequiresSubscription: true,
        plans: [
          { key: "weekly", label: "Weekly", kind: "subscription", priceUsd: 9, credits: 240, addon: false },
          { key: "monthly", label: "Monthly", kind: "subscription", priceUsd: 29, credits: 774, addon: false },
          { key: "credits_100", label: "134 credits", kind: "one_time", priceUsd: 5, credits: 134, addon: true },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/billing/trial") {
      return send(res, 200, {
        success: true, cap: 100, taken: 86, left: 14, open: true, days: 7,
        fee: { cents: 300, label: "$3" },
        includes: { credits: 100, bonus_credits: 20, slideshows: 0, posts: 999, posts_unlimited: true, analytics: true, automations: true },
        plan_keys: ["weekly"],
        first_purchase_gift: null,
      });
    }
    if (method === "POST" && path === "/api/v1/billing/checkout") {
      if (b.plan_key === "pack_small") return send(res, 403, { success: false, code: "subscription_required", message: "Credit packs need an active subscription." });
      // createCheckout: the trial is the Weekly plan's first week, and no other plan's.
      if (b.trial === true && b.plan_key !== "weekly") {
        return send(res, 400, { success: false, code: "trial_unavailable", message: "Only the Weekly plan starts with the $3 first week." });
      }
      return send(res, 200, { success: true, url: `https://checkout.dodopayments.test/session/${String(b.plan_key)}` });
    }
    if (method === "POST" && path === "/api/v1/billing/subscription/cancel") {
      return send(res, 200, { success: true, action: "cancel", access_until: SUB.current_period_end, subscription: { ...SUB, cancel_at_period_end: true } });
    }

    // --- music, sound effects, Gemini TTS (each controller's real reply shape) ---
    if (method === "POST" && (path === "/api/v1/suno/generate" || path === "/api/v1/suno/generate-sounds")) {
      seq += 1;
      return send(res, 200, { success: true, data: { taskId: `suno-${seq}`, dbRecordId: `rec-${seq}` } });
    }
    if (method === "POST" && /^\/api\/v1\/lyria\/generate-(3-5|pro|clip)$/.test(path)) {
      seq += 1;
      return send(res, 200, {
        success: true,
        data: { file_url: `https://audio.versely.studio/lyria/track-${seq}.mp3`, lyrics: "la la la", model: "Lyria 3.5", request_id: `lyria-${seq}`, record_id: `r-${seq}`, credits_used: 8 },
      });
    }
    if (method === "POST" && (path === "/api/v1/audio/minimax/music-3" || path === "/api/v1/audio/elevenlabs/music-v2-5" || path.startsWith("/api/v1/audio/sonilo/"))) {
      seq += 1;
      return send(res, 200, { success: true, message: "Music generation started", data: { taskId: `fal-music-${seq}` } });
    }
    if (method === "POST" && path === "/api/v1/audio/sound-effect") {
      seq += 1;
      return send(res, 200, { message: "Sound effect generation started", taskId: `sfx-${seq}`, data: { id: `row-${seq}` } });
    }
    if (method === "POST" && path === "/api/v1/audio/tts-gemini") {
      seq += 1;
      return send(res, 200, { success: true, file_url: `https://audio.versely.studio/gemini/speech-${seq}.wav`, model: b.model, voice: b.voice, credits_used: 2 });
    }

    // --- automations (the real envelope: { success, data: { automation } }) ---
    if (method === "POST" && path === "/api/v1/automations/estimate") {
      return send(res, 200, { success: true, data: { summary: "AI Generate · Fitness", credits_per_run: 20 } });
    }
    if (method === "POST" && path === "/api/v1/automations") {
      seq += 1;
      // Like automations.service createAutomation: always created paused with nothing queued; `start` is ignored.
      const row: Record<string, unknown> = {
        id: `auto-${seq}`, kind: b.kind, name: b.name, config: b.config, schedule: b.schedule ?? null,
        interval_seconds: b.interval_seconds ?? 300, status: "paused", paused_reason: "user", queue: [],
      };
      automations.set(row.id, row);
      return send(res, 201, { success: true, data: { automation: row } });
    }
    if (method === "GET" && path === "/api/v1/automations") {
      return send(res, 200, { success: true, data: { automations: [...automations.values()] } });
    }
    const auto = /^\/api\/v1\/automations\/([^/]+)$/.exec(path);
    if (auto && (method === "GET" || method === "PATCH")) {
      const row = automations.get(decodeURIComponent(auto[1]!));
      if (!row) return send(res, 404, { success: false, error: "Automation not found" });
      if (method === "PATCH") {
        if (b.config !== undefined) row.config = b.config;
        if (b.name !== undefined) row.name = b.name;
        if (b.interval_seconds !== undefined) row.interval_seconds = b.interval_seconds;
        if (b.schedule !== undefined) row.schedule = b.schedule;
      }
      return send(res, 200, { success: true, data: { automation: row } });
    }
    const autoAct = /^\/api\/v1\/automations\/([^/]+)\/(start|posts|stop)$/.exec(path);
    if (method === "POST" && autoAct) {
      const row = automations.get(decodeURIComponent(autoAct[1]!));
      if (!row) return send(res, 404, { success: false, error: "Automation not found" });
      const queue = Array.isArray(row.queue) ? (row.queue as Array<Record<string, unknown>>) : [];
      if (autoAct[2] === "start") {
        if (queue.length === 0) return send(res, 400, { success: false, error: "Nothing is waiting to be made. Use Create posts." });
        Object.assign(row, { status: "active", paused_reason: null });
        return send(res, 200, { success: true, data: { automation: row }, message: "Automation started" });
      }
      if (autoAct[2] === "stop") {
        Object.assign(row, { queue: [], status: "paused", paused_reason: "user" });
        return send(res, 200, { success: true, data: { automation: row }, message: "Stopped" });
      }
      // Create posts (automations.service createPosts): 1-30, booked a day apart at the posting time; dry_run only plans.
      const count = Number(b.count);
      if (!Number.isInteger(count) || count < 1 || count > 30) return send(res, 400, { success: false, error: "Create between 1 and 30 posts at a time." });
      const schedulePosts = b.schedule_posts !== false;
      const cfg = (row.config ?? {}) as Record<string, unknown>;
      const accounts = Array.isArray(cfg.post_account_ids) ? cfg.post_account_ids : [];
      const sched = row.schedule as { times?: string[] } | null;
      if (schedulePosts && accounts.length === 0) return send(res, 400, { success: false, error: "Pick the account to post to first, under Posting." });
      if (schedulePosts && !sched?.times?.[0]) return send(res, 400, { success: false, error: "Set a posting time first, under Posting." });
      const postAt = Array.from({ length: count }, (_v, i) => (schedulePosts ? `2026-11-${String(15 + i).padStart(2, "0")}T${sched!.times![0]}:00.000Z` : null));
      // The estimate route's 20 credits a post with posting, 19 for the library only.
      const creditsTotal = (schedulePosts ? 20 : 19) * count;
      if (b.dry_run === true) return send(res, 200, { success: true, data: { post_at: postAt, credits_total: creditsTotal } });
      row.queue = [...queue, ...postAt.map((at, i) => ({ id: `q-${seq}-${i}`, post_at: at }))];
      Object.assign(row, { status: "active", paused_reason: null });
      return send(res, 200, { success: true, data: { post_at: postAt, credits_total: creditsTotal, automation: row } });
    }

    // --- workflows: auto mode echoes what it stored ---
    const wfMode = /^\/api\/v1\/workflows\/([^/]+)\/mode$/.exec(path);
    if (method === "PATCH" && wfMode) {
      return send(res, 200, { success: true, workflow: { id: wfMode[1], mode: b.mode, auto_post_account_ids: b.auto_post_account_ids ?? null } });
    }

    return send(res, 404, { success: false, error: `fake backend: no route for ${method} ${path}` });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setPluginCatalog(enabled: boolean) {
      pluginCatalog = enabled;
    },
    finishRooms() {
      aicRoomsMaking = false;
      if (aicPendingRooms) aicLastRooms = { ...aicPendingRooms, made_at: new Date().toISOString() };
      aicPendingRooms = null;
    },
    count(pred) {
      return requests.filter(pred).length;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
