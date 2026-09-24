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
  lipsync: [],
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
      return send(res, 200, { success: true, data: { models: CATALOG[cat[1]!] ?? [] } });
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
        accounts: [{ id: "acct-db-1", external_account_id: "spc_ext_1", platform: "tiktok", username: "smoke", is_active: true }],
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
