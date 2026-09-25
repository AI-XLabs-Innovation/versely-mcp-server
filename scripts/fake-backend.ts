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
  proxy: { present: boolean; valid: boolean; subject: string };
  at: number;
}

export interface FakeBackend {
  url: string;
  requests: RecordedRequest[];
  /** Serve (true) or 404 (false) the plugin catalog endpoints. */
  setPluginCatalog(enabled: boolean): void;
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
        proxy: verifyProxy(req.headers),
        at: Date.now(),
      };
      requests.push(rec);
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
    const status = /^\/api\/v1\/status\/(.+)$/.exec(path);
    if (method === "GET" && status) {
      const id = decodeURIComponent(status[1]!);
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
    if (method === "GET" && dub) {
      return send(res, 200, { project: { id: dub[1], status: "dubbing", media_type: "video", target_langs: ["es"] } });
    }

    // --- social posting (the real contract: publish answers with Post for Me's id) ---
    if (method === "GET" && path === "/api/v1/social/auth-url") {
      const platform = rec.query.platform ?? "";
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
      return send(res, 403, { success: false, error: "Post analytics comes with a subscription, and with the free trial while it runs." });
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
    if (method === "POST" && path === "/api/v1/billing/checkout") {
      if (b.plan_key === "pack_small") return send(res, 403, { success: false, code: "subscription_required", message: "Credit packs need an active subscription." });
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
      const row = {
        id: `auto-${seq}`, kind: b.kind, name: b.name, config: b.config,
        interval_seconds: b.interval_seconds ?? 300, status: b.start === true ? "active" : "paused",
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
      }
      return send(res, 200, { success: true, data: { automation: row } });
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
