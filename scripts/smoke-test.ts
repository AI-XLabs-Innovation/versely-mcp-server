// Smoke test: spawn the built MCP server in HTTP mode against an in-process
// fake backend (scripts/fake-backend.ts), drive it over Streamable HTTP with
// the SDK client, and assert the transport, auth, profile, policy, billing-
// safety and card contracts. No real backend, no paid calls, no production
// traffic. Exits non-zero on any failure. Run via `npm run smoke`.
//
// Takes ~75s: one case holds a backend call open for 70s on purpose (a
// ChatGPT-style re-call must JOIN it rather than start a second paid job). It
// runs concurrently with the rest.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fetch } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeBackend, PLUGIN_MODELS, type FakeBackend } from "./fake-backend.js";
import { mcpProxyKeyFromSecret, signMcpProxy } from "../src/proxySignature.js";
import { isPublicAddress, unsafeUrlReason } from "../src/tools/_fetchGuard.js";
import { describeUpload } from "../src/tools/media.js";

const dist = resolve(process.cwd(), "dist", "index.js");
const PORT = String(20000 + Math.floor(Math.random() * 10000));
const HOST = "127.0.0.1";
const TOKEN = "vsk_smoke_test_placeholder_value";
const BASE_URL = `http://${HOST}:${PORT}`;
const MCP_URL = `${BASE_URL}/mcp`;
const SECRET = "smoke-test-oauth-secret-at-least-32-characters-long";
const ADMIN_TOKEN = "smoke-admin-token-0123456789abcdef-0123456789";
const RESOURCE_URL = "https://mcp.versely.studio/mcp";

/**
 * sha256 of the v1 media-card HTML as served before the ChatGPT-plugin work.
 * claude.ai keeps getting v1 byte-for-byte until v2 has shipped a release;
 * if this fails, the full profile's card changed.
 */
const V1_CARD_SHA256 = "c0a959250f935e7557e773500c0ea6fad635f5ee5fd7a7e818ec79c2243b893f";

/** Exactly the ChatGPT-plugin tool set (tools/_policy.ts). */
const OPENAI_TOOLS = [
  "versely_find_models", "versely_get_model_inputs", "versely_list_voices", "versely_get_task_status",
  "versely_get_credits",
  "versely_generate_image", "versely_generate_video", "versely_generate_audio", "versely_generate_music",
  "versely_extend_music", "versely_remove_background", "versely_upscale_image", "versely_upscale_video",
  "versely_colorize_photo",
  "versely_add_video_overlay", "versely_add_captions", "versely_add_timestamped_captions",
  "versely_add_auto_captions", "versely_compose_with_overlay", "versely_merge_videos", "versely_extract_frames",
  "versely_audio_isolation", "versely_get_ugc",
  "versely_create_slideshow", "versely_create_automated_slideshow", "versely_get_slideshow",
  "versely_list_slideshows", "versely_delete_slideshow", "versely_add_slideshow_images",
  "versely_add_text_overlay", "versely_slideshow_to_video",
  "versely_create_movie", "versely_list_movies", "versely_get_movie", "versely_delete_movie",
  "versely_get_movie_status", "versely_generate_movie_scenes", "versely_combine_movie",
  "versely_add_movie_scene", "versely_update_movie_scene", "versely_regenerate_scene", "versely_cancel_movie",
  "versely_create_dub", "versely_get_dub", "versely_list_dubs", "versely_delete_dub",
  "versely_list_user_media", "versely_delete_generation", "versely_generate_lipsync",
  "versely_get_social_auth_url", "versely_list_social_accounts", "versely_refresh_social_accounts",
  "versely_disconnect_social_account", "versely_preview_post", "versely_publish_post", "versely_list_posts",
  "versely_get_post", "versely_update_post", "versely_delete_post", "versely_get_posting_plan",
  "versely_create_workflow", "versely_list_workflows", "versely_get_workflow", "versely_update_workflow",
  "versely_delete_workflow", "versely_duplicate_workflow", "versely_export_workflow", "versely_update_workflow_mode",
  "versely_update_workflow_schedule", "versely_update_workflow_dates", "versely_update_workflow_assets",
  "versely_run_workflow", "versely_list_workflow_runs", "versely_get_workflow_run", "versely_list_active_workflow_runs",
  "versely_list_failed_workflow_runs", "versely_summarize_workflow", "versely_list_scheduled_workflows",
  "versely_create_workflow_asset", "versely_list_workflow_assets", "versely_get_workflow_asset",
  "versely_update_workflow_asset", "versely_add_workflow_asset_images", "versely_delete_workflow_asset",
  "versely_prepare_workflow_assets",
  "versely_list_video_workflow_runs", "versely_get_video_workflow_run", "versely_cancel_video_workflow_run",
  "versely_combine_video_workflow_run", "versely_retry_video_workflow_scene",
  "versely_list_slideshow_options", "versely_estimate_slideshow_automation", "versely_create_slideshow_automation",
  "versely_list_automations", "versely_get_automation", "versely_update_automation", "versely_start_automation",
  "versely_pause_automation", "versely_run_automation_now", "versely_delete_automation", "versely_list_automation_runs",
  "versely_quote_automation_posts", "versely_create_automation_posts", "versely_stop_automation",
  "versely_generate_sound_effect",
  "versely_get_me", "versely_list_purchases", "versely_get_subscription", "versely_list_credit_history",
  "versely_list_avatars",
  "versely_analyze_brand", "versely_list_brands", "versely_get_brand", "versely_update_brand",
  "versely_set_default_brand", "versely_archive_brand", "versely_create_brand_slideshow",
  "versely_browse", "versely_run_ai_template", "versely_get_ai_template_run", "versely_use_workflow_template",
  "versely_use_slideshow_template", "versely_apply_caption_style",
  "versely_list_inspiration_niches", "versely_find_inspiration", "versely_get_inspiration_post",
  "versely_list_trending_sounds", "versely_recreate_inspiration", "versely_create_hooks", "versely_get_hooks",
  "versely_list_hook_models", "versely_analyze_post", "versely_get_post_analysis", "versely_list_post_analyses",
  "versely_search_social_posts", "versely_get_social_post_info", "versely_import_social_video",
  "versely_list_hook_library", "versely_save_hook", "versely_list_saved_hooks", "versely_unsave_hook",
  "versely_list_music_beds", "versely_quote_hooks", "versely_reuse_hooks", "versely_create_hook_pack",
  "versely_create_character_hook_pack", "versely_get_hook_collection", "versely_list_hook_collections",
  "versely_cancel_hook_collection", "versely_schedule_hook_collection", "versely_list_hook_characters",
  "versely_create_hook_character", "versely_upload_hook_character", "versely_get_hook_character",
  "versely_pick_character_portrait", "versely_delete_hook_character", "versely_get_social_analytics_overview",
  "versely_get_post_analytics", "versely_refresh_post_analytics", "versely_get_post_analytics_history",
  "versely_plan_drama_show", "versely_update_drama_show", "versely_write_drama_episode", "versely_get_drama_quote",
  "versely_film_drama_episode", "versely_get_drama_show", "versely_list_drama_shows", "versely_delete_drama_show",
  "versely_upload_media",
  "versely_quote_music_video", "versely_create_music_video", "versely_get_music_video",
  "versely_list_photo_looks", "versely_apply_photo_look", "versely_get_photo_look",
  "versely_list_caption_looks", "versely_caption_video", "versely_get_caption_job",
  "versely_write_script", "versely_get_script", "versely_list_scripts", "versely_update_script", "versely_delete_script", "versely_get_voice_profile", "versely_build_voice_profile", "versely_delete_voice_profile",
  "versely_list_ugc_actors", "versely_list_ugc_voices", "versely_write_ugc_script", "versely_quote_ugc_ads", "versely_create_ugc_ads", "versely_get_ugc_ads", "versely_list_ugc_ads",
  "versely_list_ready_made_avatars", "versely_add_ready_made_avatar", "versely_list_avatar_creations",
  "versely_list_ai_creator_options", "versely_make_ai_creator_rooms", "versely_get_ai_creator_rooms", "versely_create_ai_creator", "versely_update_ai_creator", "versely_test_ai_creator_episode", "versely_list_ai_creator_episodes", "versely_approve_ai_creator",
  "versely_list_remix_trends", "versely_prepare_remix_clip", "versely_quote_swap", "versely_swap_video", "versely_get_swap",
];

// What ChatGPT itself is served: the directory catalog (src/tools/_directory.ts),
// a compactly worded subset of the openai profile. OpenAI's tool scan fails
// once the definitions pass a size ceiling, so this list is pinned here and
// held to a budget below. Adding a tool is a deliberate, reviewed change.
const CHATGPT_TOOLS = [
  "versely_get_credits",
  "versely_list_user_media",
  "versely_upload_media",
  "versely_find_models",
  "versely_get_model_inputs",
  "versely_generate_image",
  "versely_generate_video",
  "versely_generate_audio",
  "versely_list_voices",
  "versely_generate_music",
  "versely_generate_sound_effect",
  "versely_generate_lipsync",
  "versely_list_avatars",
  "versely_get_task_status",
  "versely_list_remix_trends",
  "versely_prepare_remix_clip",
  "versely_quote_swap",
  "versely_swap_video",
  "versely_get_swap",
  "versely_list_ready_made_avatars",
  "versely_add_ready_made_avatar",
  "versely_list_hook_characters",
  "versely_create_hooks",
  "versely_get_hooks",
  "versely_list_ugc_actors",
  "versely_list_ugc_voices",
  "versely_write_ugc_script",
  "versely_quote_ugc_ads",
  "versely_create_ugc_ads",
  "versely_get_ugc_ads",
  "versely_list_caption_looks",
  "versely_caption_video",
  "versely_get_caption_job",
  "versely_create_automated_slideshow",
  "versely_get_slideshow",
  "versely_slideshow_to_video",
  "versely_find_inspiration",
  "versely_recreate_inspiration",
  "versely_list_trending_sounds",
  "versely_browse",
  "versely_analyze_brand",
  "versely_list_brands",
  "versely_update_brand",
  "versely_create_brand_slideshow",
  "versely_list_social_accounts",
  "versely_get_social_auth_url",
  "versely_refresh_social_accounts",
  "versely_preview_post",
  "versely_publish_post",
  "versely_list_posts",
  "versely_get_social_analytics_overview",
  "versely_get_post_analytics",
  "versely_create_dub",
  "versely_get_dub",
  "versely_quote_music_video",
  "versely_create_music_video",
  "versely_get_music_video",
  "versely_list_photo_looks",
  "versely_apply_photo_look",
  "versely_get_photo_look",
  "versely_write_script",
  "versely_get_script",
  "versely_plan_drama_show",
  "versely_write_drama_episode",
  "versely_film_drama_episode",
  "versely_get_drama_show",
  "versely_list_drama_shows",
  "versely_create_movie",
  "versely_generate_movie_scenes",
  "versely_get_movie_status",
  "versely_list_ai_creator_options",
  "versely_make_ai_creator_rooms",
  "versely_get_ai_creator_rooms",
  "versely_create_ai_creator",
  "versely_test_ai_creator_episode",
  "versely_list_ai_creator_episodes",
  "versely_approve_ai_creator",
  "versely_list_automations",
  "versely_stop_automation",
  "versely_start_automation",
];
// name + description + inputSchema of every directory tool, as JSON. 13.8k
// tokens passed OpenAI's scan and 56k did not; their stated ceiling is 16k.
// 58,000 characters is about 14.5k tokens.
const CHATGPT_CATALOG_MAX_CHARS = 58_000;

const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

type AnyTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};
type AnyResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
};

function textOf(r: AnyResult): string {
  return (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function b64url(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

/** HS256 access token as the backend would sign it (content-creation-backend/src/lib/oauthJwt.ts). */
function mintJwt(issuer: string, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({
    iss: issuer,
    sub: "user-jwt-smoke",
    aud: RESOURCE_URL,
    azp: "chatgpt-client",
    scope: "generate read",
    iat: now,
    exp: now + 3600,
    jti: randomUUID(),
    token_use: "access",
    ...claims,
  });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function connect(url: string, bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  opts: { meta?: Record<string, unknown>; timeoutMs?: number } = {},
): Promise<AnyResult> {
  return (await client.callTool(
    { name, arguments: args, ...(opts.meta ? { _meta: opts.meta } : {}) },
    undefined,
    { timeout: opts.timeoutMs ?? 30_000 },
  )) as AnyResult;
}

/** Every description string in a tool (its own + every nested property's). */
function descriptionsOf(tool: AnyTool): string[] {
  const out: string[] = [tool.description ?? ""];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const o = node as Record<string, unknown>;
    if (typeof o.description === "string") out.push(o.description);
    if (Array.isArray(o.enum)) out.push(o.enum.map(String).join(" "));
    for (const v of Object.values(o)) walk(v);
  };
  walk(tool.inputSchema);
  return out;
}

function hasDeprecatedProperty(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasDeprecatedProperty);
  const o = node as Record<string, unknown>;
  const props = o.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const v of Object.values(props)) {
      if (typeof v?.description === "string" && /^deprecated\b/i.test(v.description.trim())) return true;
    }
  }
  return Object.values(o).some(hasDeprecatedProperty);
}

async function run(backend: FakeBackend, proc: ChildProcess, stderr: () => string): Promise<void> {
  await waitForListening(stderr);

  // ─── HTTP surface ─────────────────────────────────────────────────────────
  const healthRes = await fetch(`${BASE_URL}/healthz`);
  const health = (await healthRes.json()) as Record<string, unknown>;
  assert("GET /healthz returns 200", healthRes.status === 200);
  assert("health reports server name", health.server === "versely-mcp");
  assert("health reports tools count", typeof health.tools === "number" && (health.tools as number) >= 50);
  assert("health reports the openai tool count", health.tools_openai === OPENAI_TOOLS.length, `got ${String(health.tools_openai)}`);
  assert("health reports the ChatGPT directory tool count", health.tools_chatgpt === CHATGPT_TOOLS.length, `got ${String(health.tools_chatgpt)}`);

  const rootRes = await fetch(`${BASE_URL}/`);
  const root = (await rootRes.json()) as Record<string, unknown>;
  assert("GET / returns 200", rootRes.status === 200);
  assert("GET / links the public repo", root.docs === "https://github.com/AI-XLabs-Innovation/versely-mcp-server");

  const prm = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource`);
  const prmAlias = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`);
  const prmJson = (await prm.json()) as Record<string, unknown>;
  const prmAliasJson = (await prmAlias.json()) as Record<string, unknown>;
  assert("protected-resource metadata served", prm.status === 200 && prmJson.resource === RESOURCE_URL);
  assert("protected-resource /mcp alias serves the same metadata", prmAlias.status === 200 && JSON.stringify(prmAliasJson) === JSON.stringify(prmJson));
  assert(
    "resource_documentation points at the public repo",
    prmJson.resource_documentation === "https://github.com/AI-XLabs-Innovation/versely-mcp-server",
  );

  const challenge = await fetch(`${BASE_URL}/.well-known/openai-apps-challenge`);
  const challengeBody = await challenge.text();
  assert("openai-apps-challenge serves the token and nothing else", challenge.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(challengeBody));
  assert("openai-apps-challenge is plain text, no-store", (challenge.headers.get("content-type") ?? "").startsWith("text/plain") && challenge.headers.get("cache-control") === "no-store");

  const dbgNone = await fetch(`${BASE_URL}/debug/recent-calls`);
  const dbgVsk = await fetch(`${BASE_URL}/debug/recent-calls`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const dbgAdmin = await fetch(`${BASE_URL}/debug/recent-calls`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert("/debug/recent-calls 404 without a token", dbgNone.status === 404);
  assert("/debug/recent-calls 404 for a user's vsk_ key", dbgVsk.status === 404);
  assert("/debug/recent-calls 200 for MCP_ADMIN_TOKEN", dbgAdmin.status === 200);

  const preflight = await fetch(MCP_URL, { method: "OPTIONS", headers: { Origin: "https://chatgpt.com" } });
  assert(
    "CORS allows the X-Versely-Profile header",
    (preflight.headers.get("access-control-allow-headers") ?? "").includes("X-Versely-Profile"),
  );

  // ─── auth gate ────────────────────────────────────────────────────────────
  const noAuth = await fetch(MCP_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert("POST /mcp without auth → 401", noAuth.status === 401);
  const badAuth = await fetch(MCP_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Token abc123" }, body: "{}" });
  assert("POST /mcp with non-Bearer auth → 401", badAuth.status === 401);
  const badToken = await fetch(MCP_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer not_a_vsk_key" }, body: "{}" });
  assert("POST /mcp with malformed vsk_ → 401", badToken.status === 401);

  // GET /mcp is the streamable-http standalone SSE stream. claude.ai treats a
  // 405 here as a fatal capability failure (anthropics/claude-code#78193), so
  // the server serves a keepalive stream instead.
  const getNoAuth = await fetch(MCP_URL, { method: "GET" });
  assert("GET /mcp without auth → 401", getNoAuth.status === 401);
  const sseAbort = new AbortController();
  const getSse = await fetch(MCP_URL, { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` }, signal: sseAbort.signal });
  assert("GET /mcp with auth → 200 SSE stream", getSse.status === 200);
  assert("GET /mcp content-type is text/event-stream", (getSse.headers.get("content-type") ?? "").startsWith("text/event-stream"));
  sseAbort.abort();

  const wrongMethod = await fetch(MCP_URL, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
  assert("DELETE /mcp → 405", wrongMethod.status === 405);

  // ─── full profile (claude.ai and everyone else) ───────────────────────────
  const full = await connect(MCP_URL, TOKEN);
  assert("SDK client connects (initialize succeeds)", true);
  assert("server title is Versely", full.getServerVersion()?.title === "Versely");
  assert("full profile has no server instructions", !full.getInstructions());

  const fullTools = (await full.listTools()).tools as AnyTool[];
  const names = fullTools.map((t) => t.name);
  assert("tools/list returns >= 50 tools", fullTools.length >= 50, `got ${fullTools.length}`);
  assert("tool names are unique", new Set(names).size === names.length);
  assert("tool names match versely_snake_case", names.every((n) => /^versely_[a-z0-9_]+$/.test(n)));
  assert("every tool has object inputSchema", fullTools.every((t) => t.inputSchema?.type === "object"));

  for (const required of [
    "versely_get_me", "versely_find_models", "versely_get_model_inputs", "versely_list_models",
    "versely_generate_image", "versely_create_movie", "versely_publish_post", "versely_get_task_status",
    "versely_create_workflow", "versely_run_workflow", "versely_get_workflow_run",
    "versely_list_active_workflow_runs", "versely_list_failed_workflow_runs", "versely_summarize_workflow",
    "versely_list_scheduled_workflows", "versely_create_workflow_asset", "versely_add_workflow_asset_images",
    // Dubbing Studio. get_dub is the polling target — create_dub's card points
    // at it, and nothing else can see a dubbing project.
    "versely_create_dub", "versely_get_dub",
    // Caption Studio — the only caption tool that transcribes on its own.
    "versely_add_auto_captions",
    // Video-workflow RUN control stays exposed even though the template surface
    // isn't: /workflows and /video-workflows feed ONE run engine.
    "versely_get_video_workflow_run", "versely_cancel_video_workflow_run",
    "versely_combine_video_workflow_run", "versely_retry_video_workflow_scene",
  ]) {
    assert(`tool present: ${required}`, names.includes(required));
  }
  for (const removed of [
    // Template authoring is deliberately app-only.
    "versely_create_video_workflow_template", "versely_list_video_workflow_templates",
    "versely_get_video_workflow_template", "versely_update_video_workflow_template",
    "versely_delete_video_workflow_template", "versely_start_video_workflow_run",
    // Debug tool: only with MCP_ENABLE_DEBUG_TOOLS=1.
    "versely_render_test_card",
  ]) {
    assert(`tool NOT exposed: ${removed}`, !names.includes(removed));
  }

  const hintsOk = (t: AnyTool) =>
    typeof t.title === "string" && t.title.length > 0 &&
    ["readOnlyHint", "destructiveHint", "openWorldHint"].every((h) => typeof t.annotations?.[h] === "boolean");
  assert("every full-profile tool has a title and the 3 hints", fullTools.every(hintsOk), fullTools.filter((t) => !hintsOk(t)).map((t) => t.name).join(", "));
  assert("full profile carries no ChatGPT invocation strings", fullTools.every((t) => !t._meta || !("openai/toolInvocation/invoking" in t._meta)));

  const byName = (list: AnyTool[], n: string) => list.find((t) => t.name === n);
  const visibility = (t: AnyTool | undefined) => ((t?._meta?.ui as Record<string, unknown> | undefined)?.visibility ?? []) as string[];
  for (const target of ["versely_get_movie_status", "versely_get_dub", "versely_get_workflow_run", "versely_get_video_workflow_run", "versely_get_drama_show"]) {
    assert(`poll target ${target} is visible to the app`, visibility(byName(fullTools, target)).includes("app"));
  }
  const findModels = byName(fullTools, "versely_find_models");
  const fmProps = findModels?.inputSchema.properties ?? {};
  const fmMissing = ["type", "q", "provider", "category", "is_featured", "is_premium", "limit"].filter((f) => !(f in fmProps));
  assert("versely_find_models exposes expected fields", fmMissing.length === 0, fmMissing.join(", "));
  assert("claude.ai tool _meta.ui stays { resourceUri, visibility }", fullTools.every((t) => {
    const ui = t._meta?.ui as Record<string, unknown> | undefined;
    return !ui || Object.keys(ui).every((k) => k === "resourceUri" || k === "visibility");
  }));

  const fullResources = await full.listResources();
  const fullCard = await full.readResource({ uri: "ui://versely/media-card" });
  const fullMeta = (fullCard.contents[0]?._meta ?? {}) as { ui?: Record<string, unknown> };
  const fullHtml = String((fullCard.contents[0] as { text?: string }).text ?? "");
  assert("full resource has no ui.domain", !("domain" in (fullMeta.ui ?? {})) && !("domain" in (((fullResources.resources[0]?._meta ?? {}) as { ui?: object }).ui ?? {})));
  assert(
    "full profile serves the v1 card byte-for-byte",
    createHash("sha256").update(fullHtml.replace(/\r\n/g, "\n")).digest("hex") === V1_CARD_SHA256,
  );

  // Unknown tool / bad args.
  const unknown = await call(full, "definitely_not_a_real_tool", {});
  assert("unknown tool returns isError", unknown.isError === true);
  const invalidArgs = await call(full, "versely_generate_image", { model: 123 });
  assert("invalid arguments return isError", invalidArgs.isError === true && textOf(invalidArgs).toLowerCase().includes("invalid"));

  // Safety keys never reach the backend — top level or nested.
  await call(full, "versely_generate_image", {
    model: "Seedream 4 Text to Image",
    prompt: "safety-strip",
    enable_safety_checker: false,
    safety_tolerance: 6,
    extra_options: { moderation: "low", person_generation: "allow_all", keep: 1 },
  });
  const safetyReq = backend.requests.find((r) => r.path === "/api/v1/generate/image" && (r.body as Record<string, unknown>)?.prompt === "safety-strip");
  const safetyBody = JSON.stringify(safetyReq?.body ?? {});
  assert("generation reached the backend", !!safetyReq);
  assert(
    "safety keys never reach the backend",
    !!safetyReq && !/enable_safety_checker|safety_tolerance|moderation|person_generation/.test(safetyBody) && safetyBody.includes('"keep":1'),
    safetyBody,
  );

  // Retries: a POST that 500s is sent ONCE; a GET that 500s is retried.
  const post500 = await call(full, "versely_generate_image", { model: "Seedream 4 Text to Image", prompt: "fail-500" });
  assert("POST 500 surfaces as an error", post500.isError === true);
  assert("POST 500 is sent once", backend.count((r) => r.method === "POST" && (r.body as Record<string, unknown>)?.prompt === "fail-500") === 1);
  const get500 = await call(full, "versely_get_task_status", { request_id: "status-500" });
  assert("GET 500 surfaces as an error", get500.isError === true);
  assert("GET 500 is retried", backend.count((r) => r.method === "GET" && r.path === "/api/v1/status/status-500") === 2);

  // Proxy signature on every backend request (contract 2).
  assert("every backend request carries a valid X-Versely-Proxy", backend.requests.length > 0 && backend.requests.every((r) => r.proxy.valid), `${backend.requests.filter((r) => !r.proxy.valid).length} invalid`);
  assert("every backend request says which profile sent it", backend.requests.every((r) => r.headers["x-versely-client-profile"] === "full" || r.headers["x-versely-client-profile"] === "openai"));
  const vector = signMcpProxy(mcpProxyKeyFromSecret("test-secret-that-is-at-least-32-characters-long"), 1790000000, "user-123");
  assert("proxy signature matches the contract test vector", vector === "v1.1790000000.59736b83d701b50cad119626f6a71c5368a53bb9141c6570735666890644a000", vector);
  assert("POSTs carry an Idempotency-Key", backend.requests.filter((r) => r.method === "POST").every((r) => /^[0-9a-f-]{36}$/.test(r.headers["idempotency-key"] ?? "")));

  // Credit errors: plain, no upsell, no URL.
  const credit402 = await call(full, "versely_generate_image", { model: "Seedream 4 Text to Image", prompt: "need-credits" });
  const credit403 = await call(full, "versely_generate_image", { model: "Seedream 4 Text to Image", prompt: "forbidden-credits" });
  const creditUpsell = await call(full, "versely_generate_image", { model: "Seedream 4 Text to Image", prompt: "top-up-upsell" });
  for (const [label, r] of [["402", credit402], ["403", credit403], ["402 with a URL in the body", creditUpsell]] as const) {
    const t = textOf(r);
    assert(`${label} credit error is plain`, r.isError === true && t.includes("Not enough Versely credits") && t.includes("versely_get_credits"), t);
    assert(`${label} credit error has no "top up" and no URL`, !/top.?up/i.test(t) && !/https?:\/\//i.test(t) && !/scope/i.test(t), t);
  }
  assert("402 credit error says how many credits were needed", textOf(credit402).includes("needs 12"));

  // Sync endpoints finish with a completed card.
  const overlay = await call(full, "versely_add_video_overlay", {
    slideshow_video_url: "https://videos.versely.studio/in/base.mp4",
    overlay_video_url: "https://videos.versely.studio/in/overlay.mp4",
    position: "bottom-right",
  });
  const ovSc = overlay.structuredContent ?? {};
  assert("add_video_overlay returns a completed card", ovSc.status === "completed" && (ovSc.assets as Array<{ url: string }>)?.[0]?.url === "https://videos.versely.studio/ugc/overlay-1.mp4", JSON.stringify(ovSc));

  const ugc = await call(full, "versely_get_ugc", { ugc_id: "ugc-1" });
  const ugcAssets = (ugc.structuredContent?.assets ?? []) as Array<{ url: string }>;
  assert("get_ugc builds its card from final_video_url only", ugcAssets.length === 1 && ugcAssets[0]?.url === "https://videos.versely.studio/out/final.mp4", JSON.stringify(ugcAssets));

  const fullCredits = await call(full, "versely_get_credits", {});
  assert("full get_credits trims trial_offer", !textOf(fullCredits).includes("trial_offer") && textOf(fullCredits).includes("250"));

  // Model-initiated movie/dub checks carry the poll instruction (no frozen cards).
  const movieStatus = await call(full, "versely_get_movie_status", { movie_id: "movie-1" });
  const dubStatus = await call(full, "versely_get_dub", { project_id: "dub-1" });
  assert("pending get_movie_status carries the poll instruction", (movieStatus.structuredContent?.poll as Record<string, unknown>)?.tool_name === "versely_get_movie_status");
  assert("pending get_dub carries the poll instruction", (dubStatus.structuredContent?.poll as Record<string, unknown>)?.tool_name === "versely_get_dub" && dubStatus.structuredContent?.kind === "video");

  // ─── openai profile via ?profile=openai (vsk_ key) ────────────────────────
  const openai = await connect(`${MCP_URL}?profile=openai`, TOKEN);
  const instructions = openai.getInstructions() ?? "";
  const lead = instructions.split("\n\n")[0] ?? "";
  assert("openai profile has server instructions", instructions.length > 0);
  assert("instructions lead is <= 512 chars", lead.length > 0 && lead.length <= 512, `${lead.length} chars`);

  const oTools = (await openai.listTools()).tools as AnyTool[];
  const oNames = oTools.map((t) => t.name).sort();
  const expected = [...OPENAI_TOOLS].sort();
  assert(
    `openai lists exactly the ${OPENAI_TOOLS.length} plugin tools`,
    JSON.stringify(oNames) === JSON.stringify(expected),
    `extra: ${oNames.filter((n) => !expected.includes(n)).join(", ")} missing: ${expected.filter((n) => !oNames.includes(n)).join(", ")}`,
  );
  assert("every openai tool has a title and the 3 hints", oTools.every(hintsOk));
  const inv = oTools.filter((t) => {
    const a = t._meta?.["openai/toolInvocation/invoking"];
    const b = t._meta?.["openai/toolInvocation/invoked"];
    return !(typeof a === "string" && typeof b === "string" && a.length > 0 && a.length <= 64 && b.length > 0 && b.length <= 64);
  });
  assert("every openai tool has invocation strings <= 64 chars", inv.length === 0, inv.map((t) => t.name).join(", "));
  for (const target of ["versely_get_task_status", "versely_get_movie_status", "versely_get_dub", "versely_get_drama_show", "versely_get_swap"]) {
    const m = (byName(oTools, target) as { _meta?: Record<string, unknown> } | undefined)?._meta ?? {};
    assert(`openai ${target} is widgetAccessible for the card`, m["openai/widgetAccessible"] === true);
  }
  for (const target of ["versely_get_movie_status", "versely_get_dub", "versely_get_slideshow"]) {
    assert(`openai poll target ${target} is visible to the app`, visibility(byName(oTools, target)).includes("app"));
  }

  // update_workflow_mode keeps `mode`: there it is manual | auto, not the submit/wait switch.
  const hiddenLeaks = oTools.filter((t) =>
    ["mode", "poll_timeout_ms", "poll_interval_ms", "user_id"].some(
      (k) => k in (t.inputSchema.properties ?? {}) && !(k === "mode" && t.name === "versely_update_workflow_mode"),
    ),
  );
  assert("openai schemas hide mode / poll_* / user_id", hiddenLeaks.length === 0, hiddenLeaks.map((t) => t.name).join(", "));
  const deprecatedLeaks = oTools.filter((t) => hasDeprecatedProperty(t.inputSchema));
  assert("openai schemas hide deprecated aliases", deprecatedLeaks.length === 0, deprecatedLeaks.map((t) => t.name).join(", "));
  for (const [tool, prop] of [
    ["versely_create_slideshow", "model"], ["versely_add_slideshow_images", "model"], ["versely_generate_music", "model"],
    ["versely_extend_music", "model"], ["versely_upscale_image", "model"], ["versely_upscale_video", "model"],
    ["versely_remove_background", "model"],
  ] as const) {
    assert(`openai shows ${tool}.${prop} (every model is visible)`, prop in (byName(oTools, tool)?.inputSchema.properties ?? {}));
  }
  assert("openai hides versely_create_dub.engine", !("engine" in (byName(oTools, "versely_create_dub")?.inputSchema.properties ?? {})));
  const noConfirm = oTools.filter((t) => t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false && t.annotations?.openWorldHint === false && t.annotations?.idempotentHint === false && !("confirm_repeat" in (t.inputSchema.properties ?? {})));
  assert("openai creation tools accept confirm_repeat", noConfirm.length === 0, noConfirm.map((t) => t.name).join(", "));

  const allowed = new Set(OPENAI_TOOLS);
  const strays: string[] = [];
  for (const t of oTools) {
    for (const d of descriptionsOf(t)) {
      for (const m of d.match(/versely_[a-z0-9_]+/g) ?? []) if (!allowed.has(m)) strays.push(`${t.name} → ${m}`);
    }
  }
  for (const m of instructions.match(/versely_[a-z0-9_]+/g) ?? []) if (!allowed.has(m)) strays.push(`instructions → ${m}`);
  assert("no openai description names a tool outside the profile", strays.length === 0, strays.join("; "));
  assert("openai instructions carry the free-trial model rule", instructions.includes("free_trial"));
  assert("openai instructions tell the plugin's free credits apart from a subscription trial", /plugin's free credits[^.]*: a subscription trial \(on_trial in versely_get_subscription\)/.test(instructions));

  const oResources = await openai.listResources();
  const oCard = await openai.readResource({ uri: "ui://versely/media-card" });
  const oMeta = (oCard.contents[0]?._meta ?? {}) as { ui?: Record<string, unknown> };
  const oListMeta = ((oResources.resources[0]?._meta ?? {}) as { ui?: Record<string, unknown> }).ui ?? {};
  assert("openai resource has ui.domain", oMeta.ui?.domain === "https://mcp.versely.studio" && oListMeta.domain === "https://mcp.versely.studio");
  assert("openai resource sets prefersBorder explicitly", oMeta.ui?.prefersBorder === false);
  assert("openai profile serves the v2 card", String((oCard.contents[0] as { text?: string }).text ?? "").includes("version: '2.0.0'"));
  // OpenAI's review wants the exact domains the UI fetches from: no host that
  // doesn't exist or that nothing loads, and no frame or connect domains.
  const cspOfUri = async (uri: string) =>
    (((await openai.readResource({ uri })).contents[0]?._meta ?? {}) as { ui?: { csp?: { resourceDomains?: string[]; connectDomains?: string[]; frameDomains?: string[] } } }).ui?.csp;
  const cardCsp = await cspOfUri("ui://versely/media-card");
  const pickerCsp = await cspOfUri("ui://versely/picker");
  const cardHosts = ["img", "videos", "audio", "user-files", "slideshow-images", "slideshowvideos", "avatars"].map((h) => `https://${h}.versely.studio`);
  assert("the card allows exactly the Versely media hosts", JSON.stringify(cardCsp?.resourceDomains) === JSON.stringify(cardHosts) && cardCsp?.connectDomains?.length === 0 && cardCsp?.frameDomains?.length === 0, JSON.stringify(cardCsp));
  assert("the picker adds only HeyGen previews and brand.dev logos", JSON.stringify(pickerCsp?.resourceDomains) === JSON.stringify([...cardHosts, "https://media.brand.dev", "https://files2.heygen.ai", "https://resource.heygen.ai", "https://static.heygen.ai"]) && pickerCsp?.frameDomains?.length === 0, JSON.stringify(pickerCsp));

  const outOfProfile = await call(openai, "versely_list_api_key_scopes", {});
  assert("out-of-profile call is refused", outOfProfile.isError === true && textOf(outOfProfile).includes("Unknown tool"));

  // Social posting: the connect link is in the text, publish hands back
  // Versely's own post id, and a re-sent publish never posts twice.
  // OpenAI rejects results that carry internal account ids, bookkeeping
  // timestamps or debug detail; ChatGPT gets them cleaned, Claude unchanged.
  const oMe = JSON.parse(textOf(await call(openai, "versely_get_me", {}))) as { user?: Record<string, unknown> };
  const fMe = JSON.parse(textOf(await call(full, "versely_get_me", {}))) as { user?: Record<string, unknown> };
  assert("ChatGPT never sees the internal user id; Claude still does", oMe.user?.id === undefined && oMe.user?.email === "smoke@example.com" && fMe.user?.id === "user-smoke", JSON.stringify({ oMe, fMe }));
  const oAccts = JSON.parse(textOf(await call(openai, "versely_list_social_accounts", {}))) as { accounts?: Array<Record<string, unknown>> };
  const acct = oAccts.accounts?.[0] ?? {};
  assert("ChatGPT results drop user_id, provider routing and bookkeeping timestamps", !("user_id" in acct) && !("connected_at" in acct) && !("updated_at" in acct) && !("served_provider" in acct), JSON.stringify(acct));
  assert("ChatGPT results keep the ids tools take back and when a thing was made", acct.id === "acct-db-1" && acct.external_account_id === "spc_ext_1" && acct.created_at === "2026-09-01T10:00:00Z", JSON.stringify(acct));
  const oErr = await call(openai, "versely_get_social_analytics_overview", {});
  const fErr = await call(full, "versely_get_social_analytics_overview", {});
  assert("ChatGPT errors carry no backend method, path or HTTP code", oErr.isError === true && !/\/api\/v1|HTTP \d{3}|^GET /.test(textOf(oErr)) && /^[A-Z]/.test(textOf(oErr)) && /\/api\/v1/.test(textOf(fErr)), `${textOf(oErr)} || ${textOf(fErr)}`);

  const link = await call(openai, "versely_get_social_auth_url", { platform: "twitter" });
  assert("get_social_auth_url puts the connect link in the text", textOf(link).includes("https://connect.postforme.test/x?state=abc") && !link.isError, textOf(link));
  // Post for Me ignores a redirect on Versely's project, so no profile offers one.
  assert("get_social_auth_url offers no redirect_url (Post for Me ignores it)", !("redirect_url" in (byName(oTools, "versely_get_social_auth_url")?.inputSchema.properties ?? {})) && !("redirect_url" in (byName(fullTools, "versely_get_social_auth_url")?.inputSchema.properties ?? {})) && backend.requests.filter((r) => r.path === "/api/v1/social/auth-url").every((r) => r.query.redirect_url === undefined));
  const linkFull = await call(full, "versely_get_social_auth_url", { platform: "instagram" });
  const linkSc = linkFull.structuredContent as { url?: string; next?: string } | undefined;
  assert("the connect link result carries the next step for clients that show only structured data", typeof linkSc?.url === "string" && String(linkSc?.next).includes("versely_refresh_social_accounts") && textOf(linkFull).includes("Business or Creator"), JSON.stringify(linkSc));
  const pubArgs = { caption: "smoke post", account_ids: ["acct-db-1"], media_urls: ["https://videos.versely.studio/out/a.mp4"] };
  const pub1 = JSON.parse(textOf(await call(openai, "versely_publish_post", pubArgs))) as { post_id?: string; post?: { id?: string; external_post_id?: string } };
  assert("publish_post returns Versely's post id", typeof pub1.post_id === "string" && pub1.post_id.startsWith("post-db-") && pub1.post?.id === pub1.post_id && String(pub1.post?.external_post_id).startsWith("sp_ext_"), JSON.stringify(pub1));
  const before = backend.count((r) => r.method === "POST" && r.path === "/api/v1/social/posts");
  const pub2 = await call(openai, "versely_publish_post", pubArgs);
  const after = backend.count((r) => r.method === "POST" && r.path === "/api/v1/social/posts");
  assert("a re-sent publish_post is not posted twice", after === before && textOf(pub2).includes("confirm_repeat"), `posts ${before} -> ${after}`);
  const del = JSON.parse(textOf(await call(openai, "versely_delete_post", { post_id: String(pub1.post_id) }))) as { refunded?: number };
  assert("delete_post reaches the post by Versely's id", del.refunded === 1, JSON.stringify(del));

  // Automations and workflow auto-post take Versely's account ids and send the
  // provider ids the backend matches on; an edit keeps the settings not named.
  const auto = JSON.parse(textOf(await call(openai, "versely_create_slideshow_automation", {
    name: "Daily fitness", post_time: "09:00", timezone: "Europe/London", category: "fitness", model: "Flux Pro Ultra", post_account_ids: ["acct-db-1"],
  }))) as { id?: string; config?: Record<string, unknown>; schedule?: { times?: string[]; timezone?: string }; status?: string; next?: string };
  const autoCreateBody = (backend.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/automations").at(-1)?.body ?? {}) as Record<string, unknown>;
  assert("create_slideshow_automation maps account ids to provider ids", JSON.stringify(auto.config?.post_account_ids) === '["spc_ext_1"]' && auto.config?.source === "ai", JSON.stringify(auto));
  assert("create_slideshow_automation sends the daily posting time (no interval, no start) and says nothing is made yet", JSON.stringify(autoCreateBody.schedule) === '{"times":["09:00"],"timezone":"Europe/London"}' && !("interval_seconds" in autoCreateBody) && !("start" in autoCreateBody) && auto.status === "paused" && String(auto.next).includes("versely_create_automation_posts"), JSON.stringify({ autoCreateBody, auto }));
  const autoProps = byName(oTools, "versely_create_slideshow_automation")?.inputSchema.properties ?? {};
  assert("create_slideshow_automation offers post_time + timezone and no longer every_minutes / start", "post_time" in autoProps && "timezone" in autoProps && !("every_minutes" in autoProps) && !("start" in autoProps), Object.keys(autoProps).join(","));
  const edited = JSON.parse(textOf(await call(openai, "versely_update_automation", { automation_id: String(auto.id), num_images: 8 }))) as { config?: Record<string, unknown> };
  assert("update_automation merges into the stored settings", edited.config?.num_images === 8 && edited.config?.category === "fitness" && JSON.stringify(edited.config?.post_account_ids) === '["spc_ext_1"]', JSON.stringify(edited));
  const badAcct = await call(openai, "versely_create_slideshow_automation", { name: "x", category: "fitness", model: "Flux Pro Ultra", post_account_ids: ["nope"] });
  assert("an unknown account id is refused before anything is created", badAcct.isError === true && textOf(badAcct).includes("versely_list_social_accounts"), textOf(badAcct));
  const wfAuto = JSON.parse(textOf(await call(openai, "versely_update_workflow_mode", {
    workflow_id: "wf-1", mode: "auto", schedule_cron: "0 9 * * *", auto_post: true, auto_post_account_ids: ["acct-db-1"],
  }))) as { workflow?: { auto_post_account_ids?: string[] } };
  assert("openai keeps update_workflow_mode.mode (manual | auto)", "mode" in (byName(oTools, "versely_update_workflow_mode")?.inputSchema.properties ?? {}));
  // Music, sound effects, voices, lip-sync: each model reaches the route that serves it.
  const lastBody = (p: string) => (backend.requests.filter((r) => r.method === "POST" && r.path === p).at(-1)?.body ?? {}) as Record<string, unknown>;
  const song = await call(openai, "versely_generate_music", { prompt: "an upbeat synth-pop song about summer" });
  const sunoBody = lastBody("/api/v1/suno/generate");
  assert("generate_music defaults to Suno V6 (a version the backend sells)", sunoBody.model === "V6" && sunoBody.instrumental === false && sunoBody.customMode === false && !song.isError, JSON.stringify(sunoBody));
  await call(openai, "versely_generate_music", { prompt: "a slow blues", model: "V4_5PLUS" });
  assert("a retired Suno version is sent as V6", lastBody("/api/v1/suno/generate").model === "V6");
  await call(openai, "versely_generate_music", { prompt: "indie folk, warm", lyrics: "[verse] hello sun", model: "Suno V6 Wild" });
  const custom = lastBody("/api/v1/suno/generate");
  assert("Suno with lyrics uses custom mode (lyrics as prompt, prompt as style)", custom.customMode === true && custom.prompt === "[verse] hello sun" && custom.style === "indie folk, warm" && custom.title === "Untitled" && custom.model === "V6_WILD", JSON.stringify(custom));
  const lyria = await call(openai, "versely_generate_music", { prompt: "cinematic orchestral build", model: "Lyria 3.5" });
  assert("Lyria answers with a finished track and its lyrics", JSON.stringify(lyria).includes("https://audio.versely.studio/lyria/track-") && textOf(lyria).includes("la la la") && !lyria.isError, textOf(lyria));
  const beforeMinimax = backend.count((r) => r.path === "/api/v1/audio/minimax/music-3");
  const noLyrics = await call(openai, "versely_generate_music", { prompt: "rock ballad", model: "MiniMax Music 3" });
  assert("MiniMax Music 3 without lyrics is refused before any charge", noLyrics.isError === true && textOf(noLyrics).includes("lyrics") && backend.count((r) => r.path === "/api/v1/audio/minimax/music-3") === beforeMinimax, textOf(noLyrics));
  const sfx = await call(openai, "versely_generate_sound_effect", { prompt: "glass shattering on a tile floor" });
  const sfxBody = lastBody("/api/v1/audio/sound-effect");
  assert("generate_sound_effect defaults to ElevenLabs for 10 s and returns a pending card", sfxBody.duration_seconds === 10 && JSON.stringify(sfx).includes("sfx-"), JSON.stringify(sfxBody));
  await call(openai, "versely_generate_sound_effect", { prompt: "lofi drum loop", model: "Suno Sounds V6 Wild", bpm: 90, loop: true });
  const sounds = lastBody("/api/v1/suno/generate-sounds");
  assert("Suno Sounds get their version, tempo and loop", sounds.model === "V6_WILD" && sounds.soundTempo === 90 && sounds.soundLoop === true, JSON.stringify(sounds));
  const gemini = await call(openai, "versely_generate_audio", { model: "Gemini 3.8 Flash TTS", text: "Welcome back!", style_prompt: "warm" });
  const gBody = lastBody("/api/v1/audio/tts-gemini");
  assert("Gemini 3.8 TTS goes to /audio/tts-gemini with the default voice and a finished card", gBody.voice === "Kore" && gBody.style_prompt === "warm" && JSON.stringify(gemini).includes("https://audio.versely.studio/gemini/speech-") && !gemini.isError, JSON.stringify(gBody));
  const badVoice = await call(openai, "versely_generate_audio", { model: "Gemini 3.8 Flash TTS", text: "hi", voice: "Adam" });
  assert("a non-Gemini voice is refused with the valid list", badVoice.isError === true && textOf(badVoice).includes("Kore"), textOf(badVoice));
  const musicAsSpeech = await call(openai, "versely_generate_audio", { model: "MiniMax Music 3", text: "la" });
  assert("a music model on generate_audio points to generate_music", musicAsSpeech.isError === true && textOf(musicAsSpeech).includes("versely_generate_music"), textOf(musicAsSpeech));
  await call(openai, "versely_generate_lipsync", { model: "Kling Avatar Pro", image_url: "https://img.versely.studio/in/face.png", audio_url: "https://audio.versely.studio/in/line.mp3" });
  const lip = lastBody("/api/v1/generate/video");
  assert("generate_lipsync goes through /generate/video with the photo every way the app sends it", lip.model === "Kling Avatar Pro" && Array.isArray(lip.image_urls) && lip.img_url === "https://img.versely.studio/in/face.png" && backend.count((r) => r.path === "/api/v1/generate/lipsync") === 0, JSON.stringify(lip));
  // Avatars: the list offers exactly the ids fal accepts (previews where the
  // bucket has one), and an avatar model without its avatar is refused before
  // any charge (fal used to take it, queue it and 422 it: 2026-09-24).
  const veed = JSON.parse(textOf(await call(openai, "versely_list_avatars", { model: "Veed Avatars" }))) as { total: number; avatars: Array<{ id: string; preview_video_url?: string; preview_image_url?: string }> };
  const emily = veed.avatars.find((a) => a.id === "emily_vertical_primary");
  assert("list_avatars (Veed) offers the 28 ids fal accepts, with video previews labelled as video", veed.total === 28 && emily?.preview_video_url === "https://avatars.versely.studio/veed-avatars-2/emily_vertical_primary.mp4" && !("preview_image_url" in (emily ?? {})), JSON.stringify(veed).slice(0, 300));
  const hey = JSON.parse(textOf(await call(openai, "versely_list_avatars", { model: "HeyGen Avatar V5" }))) as { avatars: unknown[]; voices: unknown[] };
  assert("list_avatars (HeyGen) returns avatars and voices", hey.avatars.length === 1 && hey.voices.length === 1, JSON.stringify(hey));
  const videoPosts = () => backend.count((r) => r.method === "POST" && r.path === "/api/v1/generate/video");
  const postsBefore = videoPosts();
  const noAvatar = await call(openai, "versely_generate_lipsync", { model: "Veed Avatars", script: "Hello there, this is a test script." });
  assert("Veed Avatars without avatar_id is refused before any charge", noAvatar.isError === true && textOf(noAvatar).includes("versely_list_avatars") && videoPosts() === postsBefore, textOf(noAvatar));
  const badAvatar = await call(openai, "versely_generate_lipsync", { model: "Veed Avatars", script: "Hello there, again.", avatar_id: "default" });
  assert("an unknown Veed avatar is refused", badAvatar.isError === true && textOf(badAvatar).includes("is not a Veed avatar") && videoPosts() === postsBefore, textOf(badAvatar));
  await call(openai, "versely_generate_lipsync", { model: "Veed Avatars", script: "Hello there, a real one.", avatar_id: "emily_vertical_primary" });
  const veedBody = lastBody("/api/v1/generate/video");
  assert("a complete Veed Avatars request sends avatar_id and the script as prompt", veedBody.avatar_id === "emily_vertical_primary" && veedBody.prompt === "Hello there, a real one.", JSON.stringify(veedBody));
  const fmLip = JSON.parse(textOf(await call(openai, "versely_find_models", { type: "lipsync" }))) as { models: Array<{ name: string; credits_per_second?: number }> };
  assert("find_models shows the per-second price", fmLip.models.find((m) => m.name === "Veed Avatars")?.credits_per_second === 1, JSON.stringify(fmLip.models));
  // A finished job's status is fetched from the backend once; repeats (a
  // looping card) are answered from memory. Pending ones always go through.
  const statusCalls = (id: string) => backend.count((r) => r.path === `/api/v1/status/${id}`);
  await call(openai, "versely_get_task_status", { request_id: "done-cache-1" });
  await call(openai, "versely_get_task_status", { request_id: "done-cache-1" });
  const again = await call(openai, "versely_get_task_status", { request_id: "done-cache-1" });
  assert("a finished status is fetched once, then served from memory", statusCalls("done-cache-1") === 1 && JSON.stringify(again).includes("done-cache-1.png"), `backend calls: ${statusCalls("done-cache-1")}`);
  await call(openai, "versely_get_task_status", { request_id: "pending-cache-1" });
  await call(openai, "versely_get_task_status", { request_id: "pending-cache-1" });
  assert("a pending status is always asked again", statusCalls("pending-cache-1") === 2, `backend calls: ${statusCalls("pending-cache-1")}`);
  // Slideshows render in the background: the tool asks for server-side
  // captions and returns a card that follows the slideshow to its captioned slides.
  const autoShow = await call(openai, "versely_create_automated_slideshow", { prompt: "5 easy breakfast ideas" });
  const autoBody = lastBody("/api/v1/slideshow/create-automated");
  const autoSc = autoShow.structuredContent as Record<string, any> | undefined;
  assert("automated slideshow asks for server-side captions (classic style by default)", autoBody.bake_overlays === true && (autoBody.text_style as Record<string, unknown>)?.font_family === "tiktoksans", JSON.stringify(autoBody));
  assert("automated slideshow returns a card that follows it", autoSc?.status === "pending" && autoSc?.poll?.tool_name === "versely_get_slideshow" && typeof autoSc?.poll?.args?.slideshow_id === "string", JSON.stringify(autoSc));
  const done = (await call(openai, "versely_get_slideshow", { slideshow_id: String(autoSc?.poll?.args?.slideshow_id) })).structuredContent as Record<string, any> | undefined;
  assert("get_slideshow shows the captioned slides once done", done?.status === "completed" && done?.assets?.length === 3 && String(done?.assets?.[0]?.url).endsWith("1-captioned.png"), JSON.stringify(done));

  // Brands: read from a link, then a slideshow and an automation for it.
  const analyzed = JSON.parse(textOf(await call(openai, "versely_analyze_brand", { url: "https://acme-coffee.test" }))) as { brand_id?: string; brand?: { name?: string }; uncertain?: string[] };
  assert("analyze_brand saves the brand and returns its brand_id", analyzed.brand_id === "brand-1" && analyzed.brand?.name === "Acme Coffee" && analyzed.uncertain?.[0] === "pricing", JSON.stringify(analyzed));
  const fromLink = await call(openai, "versely_create_brand_slideshow", { url: "https://acme-coffee.test", num_images: 3 });
  const brandBody = lastBody("/api/v1/slideshow/create-automated");
  assert("brand slideshow from a link: brand facts to the planner, first content angle as the topic", String(brandBody.brand_context).includes("Name: Acme Coffee") && brandBody.prompt === "pour-over basics at home" && brandBody.bake_overlays === true && (fromLink.structuredContent as Record<string, any>)?.status === "pending", JSON.stringify(brandBody));
  const pin = await call(openai, "versely_create_brand_slideshow", { brand_id: "brand-1", source: "pinterest", topic: "cozy coffee corners" });
  const pinBody = lastBody("/api/v1/slideshow/create-pinterest-auto");
  assert("brand slideshow from Pinterest comes back finished", (pin.structuredContent as Record<string, any>)?.status === "completed" && pinBody.prompt === "cozy coffee corners" && (pinBody.text_style as Record<string, unknown>)?.stroke_width === 6, JSON.stringify(pinBody));
  const brandAuto = JSON.parse(textOf(await call(openai, "versely_create_slideshow_automation", {
    name: "Acme weekly", brand_url: "https://acme-coffee.test", model: "Flux Pro Ultra",
  }))) as { config?: Record<string, unknown> };
  assert("a brand automation can start from the brand's link", typeof brandAuto.config?.brand_kit_id === "string" && String(brandAuto.config?.brand_kit_id).startsWith("brand-"), JSON.stringify(brandAuto));
  const brandEdited = JSON.parse(textOf(await call(openai, "versely_update_brand", { brand_id: "brand-1", voice_tone: "playful" }))) as { brand?: { brand_id?: string } };
  assert("update_brand edits one brand and answers with it", brandEdited.brand?.brand_id === "brand-1", JSON.stringify(brandEdited));
  // The visual picker: versely_browse opens it (and the card calls it again
  // for Show more); a pick is worded with the id to use.
  const browseTool = byName(oTools, "versely_browse");
  const browseUi = (browseTool?._meta?.ui ?? {}) as { resourceUri?: string; visibility?: string[] };
  assert("versely_browse opens the picker, which may call it back", String(browseUi.resourceUri).startsWith("ui://versely/picker-") && (browseUi.visibility ?? []).includes("app") && browseTool?._meta?.["openai/widgetAccessible"] === true, JSON.stringify(browseTool?._meta));
  const pickerListed = (await openai.listResources()).resources.map((r) => r.uri);
  assert("resources/list serves the picker", pickerListed.includes(String(browseUi.resourceUri)), JSON.stringify(pickerListed));
  const oldPicker = await openai.readResource({ uri: "ui://versely/picker" });
  assert("an older picker URI still gets the current picker", String((oldPicker.contents[0] as { text?: string }).text ?? "").includes("Versely Picker"));
  const styles = await call(openai, "versely_browse", { collection: "slideshow_styles" });
  const stylePicker = ((styles._meta ?? {})["studio.versely/picker"] ?? {}) as { items?: Array<{ id: string; pick: string; images?: string[] }> };
  assert("browse slideshow_styles: items with example slides and a pick naming the caption_style", stylePicker.items?.length === 3 && stylePicker.items?.[0]?.pick.includes("(caption_style: pink-pop)") && stylePicker.items?.[0]?.images?.length === 5, JSON.stringify(stylePicker).slice(0, 300));
  assert("browse tells the model not to list the options", textOf(styles).includes("Don't list these") && textOf(styles).includes("pink-pop = Pink Pop"), textOf(styles));
  const paged = await call(openai, "versely_browse", { collection: "veed_avatars", limit: 10 });
  const pagedPicker = ((paged._meta ?? {})["studio.versely/picker"] ?? {}) as { items?: unknown[]; more?: boolean; total?: number };
  assert("browse pages a big collection (Show more)", pagedPicker.items?.length === 10 && pagedPicker.more === true && pagedPicker.total === 28, JSON.stringify({ n: pagedPicker.items?.length, more: pagedPicker.more, total: pagedPicker.total }));
  const tpl = await call(openai, "versely_browse", { collection: "ai_templates" });
  assert("an AI template pick says which inputs it needs", textOf(tpl).includes("finger_snap = Finger Snap") && JSON.stringify(tpl._meta).includes("It needs: Your photo (user_image_url)"), JSON.stringify(tpl._meta).slice(0, 300));

  // Templates and styles act on a pick.
  const runStarted = await call(openai, "versely_run_ai_template", { template_id: "finger_snap", inputs: { user_image_url: "https://img.versely.studio/in/me.png" } });
  const runSc = runStarted.structuredContent as Record<string, any> | undefined;
  assert("run_ai_template starts the run and returns a card that follows it", lastBody("/api/v1/templates/runs").templateId === "finger_snap" && runSc?.poll?.tool_name === "versely_get_ai_template_run", JSON.stringify(runSc));
  await call(openai, "versely_get_ai_template_run", { run_id: "run-1" });
  const runDone = (await call(openai, "versely_get_ai_template_run", { run_id: "run-1" })).structuredContent as Record<string, any> | undefined;
  assert("an AI template run ends with its video", runDone?.status === "completed" && runDone?.assets?.[0]?.url === "https://videos.versely.studio/templates/run-1.mp4", JSON.stringify(runDone));
  const cloned = JSON.parse(textOf(await call(openai, "versely_use_workflow_template", { template: "ugc-hook" }))) as { workflow_id?: string };
  assert("use_workflow_template copies it into the user's workflows", cloned.workflow_id === "wf-9", JSON.stringify(cloned));
  const fromTpl = await call(openai, "versely_use_slideshow_template", { template: "morning-routine", caption_style: "pink-pop" });
  const tplBody = lastBody("/api/v1/slideshow/create-automated");
  assert("use_slideshow_template makes it with the template's own prompt and settings", tplBody.prompt === "5 morning habits that changed my life" && tplBody.num_images === 4 && tplBody.content_type === "story" && tplBody.model === "Nano Banana Pro" && tplBody.caption_style === "pink-pop" && (fromTpl.structuredContent as Record<string, any>)?.status === "pending", JSON.stringify(tplBody));
  const restyled = await call(openai, "versely_apply_caption_style", { slideshow_id: "ss-restyle-1", caption_style: "keyline-plate" });
  assert("apply_caption_style re-bakes the captions in the chosen style", lastBody("/api/v1/slideshow/ss-restyle-1/caption-style").caption_style === "keyline-plate", textOf(restyled));
  // Inspiration: outliers first by default, shown in the picker with their
  // "65x" chip; a slideshow post is recreated as a slideshow, a video post as hooks.
  const found = JSON.parse(textOf(await call(openai, "versely_find_inspiration", { niche: "fitness" }))) as { posts?: Array<Record<string, any>>; next_cursor?: string };
  const lastInspoQuery = backend.requests.filter((r) => r.path === "/api/v1/inspiration/posts").at(-1)?.query ?? {};
  assert("find_inspiration asks for outliers by default and labels them", lastInspoQuery.outliers === "1" && found.posts?.[0]?.outlier === "65× more views than followers" && found.next_cursor === "c2", JSON.stringify({ lastInspoQuery, first: found.posts?.[0] }));
  const inspoPick = ((await call(openai, "versely_browse", { collection: "inspiration", category: "fitness" }))._meta ?? {})["studio.versely/picker"] as { items?: Array<{ badge?: string; pick: string; image?: string }> } | undefined;
  assert("browse inspiration shows covers with the outlier chip and a recreate pick", inspoPick?.items?.[0]?.badge === "65×" && inspoPick?.items?.[0]?.pick.includes("post_id: insp-s1") && String(inspoPick?.items?.[0]?.image).includes("img.versely.studio"), JSON.stringify(inspoPick?.items?.[0]));
  const soundPick = ((await call(openai, "versely_browse", { collection: "trending_sounds" }))._meta ?? {})["studio.versely/picker"] as { items?: Array<{ audio?: string; pick: string }> } | undefined;
  assert("browse trending_sounds plays the royalty-free bed", String(soundPick?.items?.[0]?.audio).endsWith("september.mp3") && soundPick?.items?.[0]?.pick.includes("royalty-free"), JSON.stringify(soundPick?.items?.[0]));
  const recS = await call(openai, "versely_recreate_inspiration", { post_id: "insp-s1", brand_id: "brand-1", twist: "for busy parents" });
  const recBody = lastBody("/api/v1/slideshow/create-automated");
  assert("recreating a slideshow post keeps its hook and slides, for the brand", String(recBody.prompt).startsWith("5 habits that changed my mornings") && String(recBody.prompt).includes("1. Wake at 6") && String(recBody.prompt).includes("for busy parents") && recBody.num_images === 3 && String(recBody.brand_context).includes("Acme Coffee") && (recS.structuredContent as Record<string, any>)?.status === "pending", JSON.stringify(recBody));
  const recV = await call(openai, "versely_recreate_inspiration", { post_id: "insp-v1", count: 2 });
  const hookBody = lastBody("/api/v1/hooks/quick");
  const recVSc = recV.structuredContent as Record<string, any> | undefined;
  assert("recreating a video post makes hook videos from its hook", String(hookBody.brief).startsWith("girls you need this camera app") && hookBody.count === 2 && recVSc?.poll?.tool_name === "versely_get_hooks", JSON.stringify({ hookBody, poll: recVSc?.poll }));
  const hooksMid = (await call(openai, "versely_get_hooks", { batch_id: "qb-1" })).structuredContent as Record<string, any> | undefined;
  assert("get_hooks reports a batch still rendering as pending", hooksMid?.status === "pending" && hooksMid?.poll?.tool_name === "versely_get_hooks", JSON.stringify(hooksMid));
  const hooksDone = (await call(openai, "versely_get_hooks", { batch_id: "qb-1" })).structuredContent as Record<string, any> | undefined;
  assert("get_hooks ends with the hook videos", hooksDone?.status === "completed" && hooksDone?.assets?.[0]?.url === "https://videos.versely.studio/hooks/h1.mp4", JSON.stringify(hooksDone));
  const analyzed2 = JSON.parse(textOf(await call(openai, "versely_analyze_post", { url: "https://www.tiktok.com/@b/video/2" }))) as { status?: string; analysis?: Record<string, unknown> };
  assert("analyze_post waits for and returns the breakdown", analyzed2.status === "completed" && !!analyzed2.analysis, JSON.stringify(analyzed2));
  const imported = await call(openai, "versely_import_social_video", { url: "https://www.tiktok.com/@b/video/2" });
  assert("import_social_video lands the video in the library with a card", JSON.stringify(imported).includes("imported-1.mp4") && !imported.isError, textOf(imported));
  // Hooks studio: pick library clips in the picker, reuse them with the
  // brand's lines, follow the collection to its videos, schedule it.
  const clipPicker = ((await call(openai, "versely_browse", { collection: "hook_library", category: "cafe" }))._meta ?? {})["studio.versely/picker"] as { items?: Array<{ video?: string; pick: string }> } | undefined;
  assert("browse hook_library previews the clips and picks by hook_id", String(clipPicker?.items?.[0]?.video).endsWith("plate-1.mp4") && clipPicker?.items?.[0]?.pick.includes("hook_id: plate-1"), JSON.stringify(clipPicker?.items?.[0]));
  const reuse = await call(openai, "versely_reuse_hooks", { hook_ids: ["plate-1"], brand_id: "brand-1", lines: { "plate-1": "My line" } });
  const reuseBody = lastBody("/api/v1/hooks/collections");
  const reuseSc = reuse.structuredContent as Record<string, any> | undefined;
  assert("reuse_hooks sends the clips, lines and brand, and follows the collection", reuseBody.kind === "reuse" && JSON.stringify(reuseBody.hook_ids) === '["plate-1"]' && reuseBody.brand_kit_id === "brand-1" && reuseBody.brand_context === undefined && reuseSc?.poll?.tool_name === "versely_get_hook_collection", JSON.stringify({ reuseBody, sc: reuseSc }));
  // The deck wants a brief of 10+ characters and serves 50 clips at most, with exact scene names.
  const deckQuery = () => (backend.requests.filter((r) => r.path === "/api/v1/hooks/deck").at(-1)?.query ?? {}) as Record<string, string>;
  const shortSearch = await call(openai, "versely_browse", { collection: "hook_library", q: "gym" });
  assert("a short hook search becomes a valid brief", !shortSearch.isError && deckQuery().brief === "Hooks about: gym", `${deckQuery().brief} / ${textOf(shortSearch).slice(0, 200)}`);
  const allClips = textOf(await call(openai, "versely_browse", { collection: "hook_library" }));
  assert("the hook picker says how many clips fit and how to narrow them", allClips.includes("1 of the 155 clips") && allClips.includes("scene: cafe"), allClips.slice(0, 400));
  const noScene = await call(openai, "versely_browse", { collection: "hook_library", category: "Beach Day" });
  assert("an unknown scene is normalized and answered with the scenes there are", deckQuery().vibe === undefined && textOf(noScene).includes('scene "beach-day"') && textOf(noScene).includes("Scenes: cafe"), textOf(noScene));
  // ChatGPT: the picker reads _meta (the model reads the text). Claude: structuredContent carries it too.
  const noScenePicker = (noScene._meta ?? {})["studio.versely/picker"] as { note?: string } | undefined;
  const claudeNoScene = ((await call(full, "versely_browse", { collection: "hook_library", category: "Beach Day" })).structuredContent as { picker?: { note?: string; hint?: string } } | undefined)?.picker;
  assert("the picker data carries the note and how to use a pick", String(noScenePicker?.note).includes("Scenes: cafe") && String(claudeNoScene?.note).includes("Scenes: cafe") && String(claudeNoScene?.hint).includes("versely_reuse_hooks"), JSON.stringify({ noScenePicker, claudeNoScene }));
  const brandPack = await call(openai, "versely_create_hook_pack", { brand_id: "brand-1", count: 3 });
  const brandPackBody = lastBody("/api/v1/hooks/collections");
  assert("a brand hook pack sends the brand as brand_kit_id with a valid ask", !brandPack.isError && brandPackBody.brand_kit_id === "brand-1" && typeof brandPackBody.brand_context === "string" && brandPackBody.brand_context.length >= 10 && brandPackBody.brand_context.length <= 500 && !String(brandPackBody.brand_context).includes("Acme"), JSON.stringify(brandPackBody));
  await call(openai, "versely_create_hook_pack", { brief: "gym", count: 3 });
  assert("a short pack brief is padded to the planner's minimum", lastBody("/api/v1/hooks/collections").brand_context === "Hooks about: gym", JSON.stringify(lastBody("/api/v1/hooks/collections")));
  const packVibes = (oTools.find((t) => t.name === "versely_create_hook_pack")?.inputSchema as any)?.properties?.vibes?.items?.enum;
  assert("pack settings are the planner's five presets", JSON.stringify(packVibes) === '["cafe","morning","kitchen","outdoor","selfie"]', JSON.stringify(packVibes));
  await call(openai, "versely_get_hook_collection", { collection_id: "col-1" });
  const colDone = (await call(openai, "versely_get_hook_collection", { collection_id: "col-1" })).structuredContent as Record<string, any> | undefined;
  assert("a hook collection ends with its videos", colDone?.status === "completed" && colDone?.assets?.[0]?.url === "https://videos.versely.studio/hooks/col-1-1.mp4", JSON.stringify(colDone));
  const collectionsBefore = backend.count((r) => r.method === "POST" && r.path === "/api/v1/hooks/collections");
  const noBrief = await call(openai, "versely_create_hook_pack", { count: 3 });
  assert("a hook pack needs a brand or a brief (refused before any call)", noBrief.isError === true && backend.count((r) => r.method === "POST" && r.path === "/api/v1/hooks/collections") === collectionsBefore, textOf(noBrief));
  await call(openai, "versely_create_character_hook_pack", { character_id: "char-1", brief: "a budgeting app for students", count: 5 });
  const charBody = lastBody("/api/v1/hooks/collections");
  assert("create_character_hook_pack asks for a character pack", charBody.kind === "character_pack" && charBody.character_id === "char-1" && charBody.brand_context === "a budgeting app for students", JSON.stringify(charBody));
  const sched = JSON.parse(textOf(await call(openai, "versely_schedule_hook_collection", { collection_id: "col-1", account_ids: ["acct-db-1"], every_hours: 12 }))) as { scheduled?: number };
  assert("schedule_hook_collection schedules the posts", sched.scheduled === 1 && lastBody("/api/v1/hooks/collections/col-1/schedule").every_hours === 12, JSON.stringify(sched));
  const beds = ((await call(openai, "versely_browse", { collection: "music_beds" }))._meta ?? {})["studio.versely/picker"] as { items?: Array<{ audio?: string; pick: string }> } | undefined;
  assert("browse music_beds plays each bed", String(beds?.items?.[0]?.audio).endsWith("sunny.mp3") && beds?.items?.[0]?.pick.includes("music_bed_id: bed-9"), JSON.stringify(beds?.items?.[0]));
  const chars = ((await call(openai, "versely_browse", { collection: "hook_characters" }))._meta ?? {})["studio.versely/picker"] as { items?: Array<{ image?: string; pick: string }> } | undefined;
  assert("browse hook_characters shows their portraits", String(chars?.items?.[0]?.image).endsWith("mia.png") && chars?.items?.[0]?.pick.includes("character_id: char-1"), JSON.stringify(chars?.items?.[0]));
  const statsRead = JSON.parse(textOf(await call(openai, "versely_get_post_analytics", { post_id: "post-db-9" }))) as { stats?: Record<string, unknown> };
  assert("get_post_analytics only reads (no collection job)", statsRead.stats?.views === 1200 && backend.count((r) => r.path === "/api/v1/social-analytics/post-db-9/collect") === 0, JSON.stringify(statsRead));
  const stats = JSON.parse(textOf(await call(openai, "versely_refresh_post_analytics", { post_id: "post-db-9" }))) as { stats?: Record<string, unknown> };
  assert("refresh_post_analytics collects then reads the stats", stats.stats?.views === 1200 && backend.count((r) => r.path === "/api/v1/social-analytics/post-db-9/collect") === 1, JSON.stringify(stats));
  // ─── Uploads: a file from the chat lands in the user's own library ────────
  const upTool = byName(oTools, "versely_upload_media");
  const fileProp = (upTool?.inputSchema.properties as Record<string, any> | undefined)?.file;
  assert(
    "upload_media declares ChatGPT's file input the way the portal checks it",
    JSON.stringify(upTool?._meta?.["openai/fileParams"]) === '["file"]' &&
      JSON.stringify(fileProp?.required) === '["download_url","file_id"]' &&
      ["download_url", "file_id", "mime_type", "file_name"].every((k) => k in (fileProp?.properties ?? {})) &&
      fileProp?.additionalProperties === false,
    JSON.stringify(fileProp),
  );
  const fullUp = byName(fullTools, "versely_upload_media");
  assert("the full profile's upload_media takes a link and declares no file input", "url" in (fullUp?.inputSchema.properties ?? {}) && !("file" in (fullUp?.inputSchema.properties ?? {})) && !("openai/fileParams" in (fullUp?._meta ?? {})));
  const up = await call(openai, "versely_upload_media", { file: { download_url: `${backend.url}/__files/clip.mp4`, file_id: "file_1", file_name: "My Clip (1).mp4" } });
  const presign = lastBody("/api/v1/bucket/presign");
  const put = backend.requests.filter((r) => r.method === "PUT").at(-1);
  assert("upload_media presigns with the file's real size and type", presign.content_type === "video/mp4" && presign.size === 2048 && presign.file_name === "My_Clip_1.mp4", JSON.stringify(presign));
  assert("upload_media PUTs the bytes with the signed length and type", put?.bytes === 2048 && put?.headers["content-type"] === "video/mp4" && put?.headers["content-length"] === "2048" && put?.path === "/__r2/videos/usr/user-smoke/My_Clip_1.mp4", JSON.stringify([put?.path, put?.bytes, put?.headers["content-type"]]));
  assert("upload_media returns the stored URL and says it was free", !up.isError && textOf(up).includes("https://videos.versely.studio/usr/user-smoke/My_Clip_1.mp4") && textOf(up).includes("Nothing was charged") && textOf(up).includes("versely_prepare_remix_clip"), textOf(up));
  await call(openai, "versely_upload_media", { file: { download_url: `${backend.url}/__files/photo.bin`, file_id: "file_2", mime_type: "image/png" } });
  assert("an untyped download takes the type the host declared", lastBody("/api/v1/bucket/presign").content_type === "image/png" && lastBody("/api/v1/bucket/presign").file_name === "photo.png", JSON.stringify(lastBody("/api/v1/bucket/presign")));
  const presignsBefore = backend.count((r) => r.path === "/api/v1/bucket/presign");
  const pdf = await call(openai, "versely_upload_media", { file: { download_url: `${backend.url}/__files/doc.pdf`, file_id: "file_3", file_name: "doc.pdf" } });
  const huge = await call(openai, "versely_upload_media", { file: { download_url: `${backend.url}/__files/huge.png`, file_id: "file_4" } });
  const gone = await call(openai, "versely_upload_media", { file: { download_url: `${backend.url}/__files/missing.mp4`, file_id: "file_5" } });
  assert("upload_media refuses a document, an oversized photo and a dead link before storing anything",
    pdf.isError === true && textOf(pdf).includes("can't be stored") && huge.isError === true && textOf(huge).includes("over 30 MB") && gone.isError === true && textOf(gone).includes("answered 404") &&
      backend.count((r) => r.path === "/api/v1/bucket/presign") === presignsBefore,
    [textOf(pdf), textOf(huge), textOf(gone)].join(" | "));
  const viaLink = await call(full, "versely_upload_media", { url: `${backend.url}/__files/clip2.mp4` });
  assert("the full profile stores a file from a link", !viaLink.isError && textOf(viaLink).includes("/usr/user-smoke/clip2.mp4"), textOf(viaLink));
  // The address guard, in this process (the spawned server runs with it off to reach the fake backend).
  assert("the fetch guard refuses private, loopback, link-local and metadata addresses",
    ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "224.0.0.1"].every((ip) => !isPublicAddress(ip)) &&
      ["8.8.8.8", "104.18.2.3", "2606:4700::6810:203", "::ffff:8.8.8.8"].every((ip) => isPublicAddress(ip)));
  assert("the fetch guard refuses http, credentials, odd ports, IP literals and internal names",
    [
      "http://example.com/a.mp4", "https://user:pw@example.com/a.mp4", "https://example.com:8443/a.mp4", "https://127.0.0.1/a.mp4",
      "https://[::1]/a.mp4", "https://169.254.169.254/latest", "https://localhost/a.mp4", "https://storage.internal/a.mp4", "https://intranet/a.mp4", "ftp://example.com/a.mp4", "not a url",
    ].every((u) => unsafeUrlReason(u) !== null) && unsafeUrlReason("https://files.example.com/a.mp4") === null && unsafeUrlReason("https://8.8.8.8/a.mp4") === null);
  assert("describeUpload trusts the server's type first, then the host's, then the name",
    describeUpload({ headerMime: "video/quicktime; charset=binary", name: "x.mp4" })?.fileName === "x.mov" &&
      describeUpload({ headerMime: "application/octet-stream", declaredMime: "audio/x-m4a", name: "voice" })?.contentType === "audio/mp4" &&
      describeUpload({ headerMime: "binary/octet-stream", name: "IMG_0001.HEIC" })?.kind === "image" &&
      describeUpload({ headerMime: "text/html", name: "page.html" }) === null);

  // ─── Remix: trends, a clip, the price, the swap ───────────────────────────
  const trends = JSON.parse(textOf(await call(openai, "versely_list_remix_trends", {}))) as Record<string, any>;
  assert("list_remix_trends returns tidy trend cards and the tabs", trends.available === true && trends.items?.[0]?.trend_id === "insp-dance-1" && trends.items[0].title === "POV: the hallway dance" && trends.items[0].creator === "@dancer.one" && trends.items[0].suggested === "swap" && trends.items[1].creator === "@duo" && trends.tabs?.[0]?.tab === "trending", JSON.stringify(trends));
  const movesTab = JSON.parse(textOf(await call(openai, "versely_list_remix_trends", { tab: "versely" }))) as Record<string, any>;
  assert("the versely tab lists ready-made moves by move_id", movesTab.items?.[0]?.move_id === "groove-two-step" && movesTab.items[0].suggested === "moves" && !("trend_id" in movesTab.items[0]), JSON.stringify(movesTab.items));
  const trendPicker = ((await call(openai, "versely_browse", { collection: "remix_trends", category: "dance" }))._meta ?? {})["studio.versely/picker"] as { items?: Array<{ image?: string; badge?: string; pick: string }> } | undefined;
  assert("browse remix_trends shows covers and a pick that carries the trend_id", String(trendPicker?.items?.[0]?.image).endsWith("t1.jpg") && trendPicker?.items?.[0]?.badge === "Swap" && trendPicker?.items?.[0]?.pick.includes("trend_id: insp-dance-1"), JSON.stringify(trendPicker?.items?.[0]));
  const clip = await call(openai, "versely_prepare_remix_clip", { trend_id: "insp-dance-1" });
  const clipSc = clip.structuredContent as Record<string, any> | undefined;
  const clipId = /clip_id: ([0-9a-f-]{36})/.exec(textOf(clip))?.[1] ?? "";
  assert("prepare_remix_clip previews the trend and cuts the suggested window", lastBody("/api/v1/remix/sources/preview").inspiration_id === "insp-dance-1" && lastBody("/api/v1/remix/sources").preview_id === "0a0a0a0a-0000-4000-8000-000000000001" && lastBody("/api/v1/remix/sources").start === 3 && lastBody("/api/v1/remix/sources").end === 11, JSON.stringify(lastBody("/api/v1/remix/sources")));
  assert("prepare_remix_clip returns the clip_id, its length and a card of the clip", clipId.length === 36 && textOf(clip).includes("8 s") && textOf(clip).includes("Nothing was charged") && clipSc?.status === "completed" && String(clipSc?.assets?.[0]?.url).includes("/tmp/swap-sources/"), textOf(clip));
  const previewsBefore = backend.count((r) => r.path === "/api/v1/remix/sources/preview");
  const twoInputs = await call(openai, "versely_prepare_remix_clip", { trend_id: "insp-dance-1", link: "https://www.tiktok.com/@a/video/1" });
  const badRange = await call(openai, "versely_prepare_remix_clip", { link: "https://www.tiktok.com/@a/video/1", start: 0, end: 30 });
  assert("prepare_remix_clip refuses two inputs and a 30 s range before any call", twoInputs.isError === true && badRange.isError === true && textOf(badRange).includes("4 to 15 seconds") && backend.count((r) => r.path === "/api/v1/remix/sources/preview") === previewsBefore, textOf(badRange));
  const notMine = await call(openai, "versely_prepare_remix_clip", { video_url: "https://cdn.example.com/clip.mp4" });
  assert("a video that is not in the user's library points at upload_media", notMine.isError === true && textOf(notMine).includes("Upload the video to Versely first") && textOf(notMine).includes("versely_upload_media") && textOf(notMine).includes("Nothing was charged"), textOf(notMine));
  const privatePost = await call(openai, "versely_prepare_remix_clip", { link: "https://www.instagram.com/reel/private123/" });
  assert("a post that can't be fetched is said in the backend's words, with no API detail", privatePost.isError === true && textOf(privatePost).startsWith("We couldn't download that post.") && !textOf(privatePost).includes("/api/v1"), textOf(privatePost));
  const myClip = await call(openai, "versely_prepare_remix_clip", { video_url: "https://videos.versely.studio/usr/user-smoke/My_Clip_1.mp4", start: 2, end: 8 });
  assert("the user's own stored video is cut to the range they picked", !myClip.isError && lastBody("/api/v1/remix/sources").start === 2 && lastBody("/api/v1/remix/sources").end === 8 && textOf(myClip).includes("6 s"), textOf(myClip));

  const swapQuote = textOf(await call(openai, "versely_quote_swap", { clip_id: clipId }));
  const quoteBody = lastBody("/api/v1/remix/swap/quote");
  assert("quote_swap prices the clip at 720p lite and sends the balance", quoteBody.source_id === clipId && quoteBody.mode === "swap" && quoteBody.resolution === "720p" && quoteBody.quality === "lite" && quoteBody.variants === 1 && quoteBody.fit_credits === 250, JSON.stringify(quoteBody));
  assert("quote_swap states the price, the balance and the confirm value", swapQuote.includes("96 credits for 8 s at 720p") && swapQuote.includes("Balance: 250 credits") && swapQuote.includes("confirm_credits: 96"), swapQuote);
  const shortQuote = textOf(await call(openai, "versely_quote_swap", { clip_id: clipId, resolution: "1080p", quality: "plus", versions: 2 }));
  assert("a quote over the balance offers what the balance covers, and no way to start it", lastBody("/api/v1/remix/swap/quote").quality === "pro" && shortQuote.includes("768 credits (384 credits each for 2 versions)") && shortQuote.includes("1080p, Plus") && shortQuote.includes("8 s at 480p for 96 credits") && !shortQuote.includes("confirm_credits") && !/buy|purchase|top up|upgrade/i.test(shortQuote), shortQuote);
  await call(openai, "versely_quote_swap", { clip_id: clipId, type: "moves" });
  assert("type moves is sent as the motion mode", lastBody("/api/v1/remix/swap/quote").mode === "motion");

  const me = "https://img.versely.studio/usr/user-smoke/me.png";
  const swapsBefore = backend.count((r) => r.path === "/api/v1/remix/swap");
  const staleSwap = await call(openai, "versely_swap_video", { clip_id: clipId, swaps: [{ replaces: "person", image_url: me }], confirm_credits: 50, rights_confirmed: true });
  assert("swap_video with a stale price is refused with the new one and charges nothing", staleSwap.isError === true && textOf(staleSwap).includes("now 96 credits") && textOf(staleSwap).includes("nothing charged") && textOf(staleSwap).includes("confirm_credits: 96") && backend.count((r) => r.path === "/api/v1/remix/swap") === swapsBefore, textOf(staleSwap));
  const noRights = await call(openai, "versely_swap_video", { clip_id: clipId, swaps: [{ replaces: "person", image_url: me }], confirm_credits: 96, rights_confirmed: false });
  const twoSources = await call(openai, "versely_swap_video", { clip_id: clipId, swaps: [{ replaces: "person", image_url: me, avatar_id: "char-1" }], confirm_credits: 96, rights_confirmed: true });
  assert("swap_video needs the rights confirmation and one photo source per swap", noRights.isError === true && twoSources.isError === true && textOf(twoSources).includes("exactly one of image_url or avatar_id") && backend.count((r) => r.path === "/api/v1/remix/swap") === swapsBefore, textOf(noRights));
  const swapped = await call(openai, "versely_swap_video", { clip_id: clipId, swaps: [{ replaces: "person", target: " the dancer ", image_url: me }], note: "keep the hoodie", confirm_credits: 96, rights_confirmed: true });
  const swapBody = lastBody("/api/v1/remix/swap");
  const swapSc = swapped.structuredContent as Record<string, any> | undefined;
  const swapJobs = (swapSc?.poll?.args?.job_ids ?? []) as string[];
  assert("swap_video sends the slots, the rights tick and one batch id", swapBody.source_id === clipId && swapBody.mode === "swap" && JSON.stringify(swapBody.slots) === JSON.stringify([{ role: "person", target: "the dancer", image_url: me }]) && swapBody.note === "keep the hoodie" && swapBody.rights_confirmed === true && swapBody.keep_audio === true && swapBody.variants === 1 && swapBody.quality === "lite" && swapBody.resolution === "720p" && typeof swapBody.batch_id === "string", JSON.stringify(swapBody));
  assert("swap_video's card follows the job through versely_get_swap", swapSc?.status === "pending" && swapSc?.poll?.tool_name === "versely_get_swap" && swapJobs.length === 1 && textOf(swapped).includes("96 credits held") && textOf(swapped).includes("NOT finished"), JSON.stringify(swapSc));
  const swapPending = await call(openai, "versely_get_swap", { job_ids: swapJobs });
  const swapDone = await call(openai, "versely_get_swap", { job_ids: swapJobs });
  const swapDoneSc = swapDone.structuredContent as Record<string, any> | undefined;
  assert("get_swap is pending, then ends with the remixed video (not its thumbnail)", (swapPending.structuredContent as any)?.status === "pending" && (swapPending.structuredContent as any)?.poll?.tool_name === "versely_get_swap" && swapDoneSc?.status === "completed" && swapDoneSc?.kind === "video" && swapDoneSc?.assets?.length === 1 && String(swapDoneSc?.assets?.[0]?.url).endsWith(".mp4"), JSON.stringify(swapDoneSc));
  const nude = await call(openai, "versely_swap_video", { clip_id: clipId, swaps: [{ replaces: "person", image_url: "https://img.versely.studio/usr/user-smoke/nude.png" }], confirm_credits: 96, rights_confirmed: true });
  assert("a picture refusal is relayed once, in the backend's words", nude.isError === true && textOf(nude).includes("nudity") && (textOf(nude).match(/Nothing was charged/g) ?? []).length === 1, textOf(nude));
  const failing = await call(openai, "versely_swap_video", { clip_id: clipId, swaps: [{ replaces: "outfit", target: "fails", image_url: me }], confirm_credits: 96, rights_confirmed: true });
  const failed = await call(openai, "versely_get_swap", { job_ids: (failing.structuredContent as any)?.poll?.args?.job_ids ?? [] });
  assert("a swap the engine turns down ends failed and says the credits come back", failed.isError === true && (failed.structuredContent as any)?.status === "failed" && textOf(failed).includes("turned this clip down") && textOf(failed).includes("credits held for it are returned"), textOf(failed));
  const two = await call(openai, "versely_swap_video", { clip_id: clipId, type: "moves", swaps: [{ replaces: "person", avatar_id: "char-1" }], versions: 2, confirm_credits: 192, rights_confirmed: true });
  const twoJobs = ((two.structuredContent as any)?.poll?.args?.job_ids ?? []) as string[];
  await call(openai, "versely_get_swap", { job_ids: twoJobs });
  const twoDone = (await call(openai, "versely_get_swap", { job_ids: twoJobs })).structuredContent as Record<string, any> | undefined;
  assert("two versions of Copy the moves end as a gallery of both", lastBody("/api/v1/remix/swap").mode === "motion" && JSON.stringify(lastBody("/api/v1/remix/swap").slots) === '[{"role":"person","avatar_id":"char-1"}]' && twoJobs.length === 2 && twoDone?.status === "completed" && twoDone?.kind === "gallery" && twoDone?.assets?.[1]?.label === "Version 2", JSON.stringify(twoDone));
  const remixDescs = oTools.filter((t) => /remix|swap/.test(t.name)).map((t) => JSON.stringify([t.description, t.inputSchema])).join(" ");
  assert("no remix tool names an engine or a vendor", !/\b(fal|kie|runpod|engine by|powered by)\b/i.test(remixDescs));

  // ─── musicVideo (agent notes) ───
  {
  // AI music video: quote free, create only with the approved price (a stale one is refused before
  // anything is sent), follow the job to the video or the failure.
  const MV_JOB = "5f0c6a2e-8d1b-4c3a-9e7f-1a2b3c4d5e6f";
  const mvQ = await call(openai, "versely_quote_music_video", { music_id: "mus-smoke-1", audio_id: "aud_smoke_1", style: "grainy 90s film" });
  const mvQText = textOf(mvQ);
  const mvQBody = lastBody("/api/v1/music-video/quote");
  assert("quote_music_video sends the song and style and shows the price", mvQBody.music_id === "mus-smoke-1" && mvQBody.audio_id === "aud_smoke_1" && mvQBody.style === "grainy 90s film" && mvQText.includes("66 credits") && mvQText.includes("0:12-1:12") && mvQText.includes("lyrics timed on screen") && mvQText.includes("confirm_credits: 66") && !mvQ.isError, mvQText);
  const mvNoSong = await call(openai, "versely_quote_music_video", { music_id: "mus-smoke-1" });
  assert("quote_music_video asks for audio_id and points at list_user_media", mvNoSong.isError === true && textOf(mvNoSong).includes("versely_list_user_media"), textOf(mvNoSong));
  const mvMissing = await call(openai, "versely_quote_music_video", { music_id: "mus-missing", audio_id: "aud_x" });
  assert("quote_music_video explains a song that is not the user's", mvMissing.isError === true && textOf(mvMissing).includes("not found") && textOf(mvMissing).includes("Nothing was charged"), textOf(mvMissing));
  const mvUp = textOf(await call(openai, "versely_quote_music_video", { audio_url: "https://user-files.versely.studio/user-jwt-smoke/song.mp3", duration_sec: 30, keep_audio_untouched: true, quality: "fast" }));
  const mvUpBody = lastBody("/api/v1/music-video/quote");
  assert("quote_music_video takes an uploaded song and the options", mvUpBody.audio_url === "https://user-files.versely.studio/user-jwt-smoke/song.mp3" && !("music_id" in mvUpBody) && mvUpBody.keep_audio_untouched === true && mvUpBody.duration_sec === 30 && mvUpBody.quality === "fast" && mvUp.includes("39 credits") && /no lyrics on screen/i.test(mvUp) && mvUp.includes("Fast (beta)"), mvUp);
  const mvPosts = () => backend.count((r) => r.method === "POST" && r.path === "/api/v1/music-video");
  const mvPostsBefore = mvPosts();
  const mvStale = await call(openai, "versely_create_music_video", { music_id: "mus-smoke-1", audio_id: "aud_smoke_1", confirm_credits: 40 });
  assert("create_music_video with a stale price is refused with the new one, nothing started", mvStale.isError === true && textOf(mvStale).includes("costs 66 credits now") && textOf(mvStale).includes("nothing charged") && textOf(mvStale).includes("confirm_credits: 66") && mvPosts() === mvPostsBefore, textOf(mvStale));
  const mvGo = await call(openai, "versely_create_music_video", { music_id: "mus-smoke-1", audio_id: "aud_smoke_1", style: "grainy 90s film", aspect_ratio: "1:1", confirm_credits: 66 });
  const mvGoSc = mvGo.structuredContent as Record<string, any> | undefined;
  const mvGoBody = lastBody("/api/v1/music-video");
  assert("create_music_video re-quotes, starts the job and the card follows it", mvPosts() === mvPostsBefore + 1 && mvGoBody.music_id === "mus-smoke-1" && mvGoBody.aspect_ratio === "1:1" && mvGoBody.style === "grainy 90s film" && textOf(mvGo).includes("66 credits charged") && textOf(mvGo).includes("NOT finished") && mvGoSc?.status === "pending" && mvGoSc?.kind === "video" && mvGoSc?.poll?.tool_name === "versely_get_music_video" && mvGoSc?.poll?.args?.job_id === MV_JOB, JSON.stringify(mvGoSc));
  const mvMid = await call(openai, "versely_get_music_video", { job_id: MV_JOB });
  const mvMidSc = mvMid.structuredContent as Record<string, any> | undefined;
  assert("get_music_video shows progress while the stills are drawn", mvMidSc?.status === "pending" && typeof mvMidSc?.progress === "number" && mvMidSc.progress > 0.4 && mvMidSc?.poll?.tool_name === "versely_get_music_video" && textOf(mvMid).includes("9 of 18"), JSON.stringify(mvMidSc));
  const mvDone = await call(openai, "versely_get_music_video", { job_id: MV_JOB });
  const mvDoneSc = mvDone.structuredContent as Record<string, any> | undefined;
  assert("get_music_video ends with the finished video", mvDoneSc?.status === "completed" && mvDoneSc?.assets?.[0]?.url === "https://videos.versely.studio/music-video/5f0c6a2e.mp4" && textOf(mvDone).includes("ready"), JSON.stringify(mvDoneSc));
  const mvFail = await call(openai, "versely_create_music_video", { music_id: "mus-fails", audio_id: "aud_smoke_1", confirm_credits: 66 });
  const mvFailId = ((mvFail.structuredContent as Record<string, any> | undefined)?.poll?.args?.job_id ?? "") as string;
  const mvFailed = await call(openai, "versely_get_music_video", { job_id: mvFailId });
  const mvFailedSc = mvFailed.structuredContent as Record<string, any> | undefined;
  assert("get_music_video shows a failed job and its refund", mvFailedSc?.status === "failed" && String(mvFailedSc?.error).includes("refunded") && textOf(mvFailed).includes("failed"), JSON.stringify(mvFailedSc));
  const mvGone = await call(openai, "versely_get_music_video", { job_id: "00000000-0000-4000-8000-000000000000" });
  assert("get_music_video turns an unknown job into a failed card", (mvGone.structuredContent as Record<string, any> | undefined)?.status === "failed" && textOf(mvGone).includes("kept for a day"), textOf(mvGone));
  }

  // ─── aiLooks (agent notes) ───
  {
  // AI looks: the list is the price list (never the model), apply only with the approved price,
  // follow the job to the photo or the failure.
  const LOOK_JOB = "019a7f3c-5e00-7000-8000-00000000a1b2";
  const looks = await call(openai, "versely_list_photo_looks", {});
  const looksText = textOf(looks);
  assert("list_photo_looks lists looks by group with prices and never the model", !looks.isError && looksText.includes("golden-hour") && looksText.includes("Golden hour & sunset") && looksText.includes("2 credits (3 held") && looksText.includes("night-flash") && looksText.includes("9 credits") && looksText.includes("versely_apply_photo_look") && !/nano banana|pruna/i.test(looksText), looksText);
  const goldenOnly = textOf(await call(openai, "versely_list_photo_looks", { group: "golden" }));
  assert("list_photo_looks filters by group", goldenOnly.includes("golden-hour") && !goldenOnly.includes("night-flash"), goldenOnly);
  const lookPosts = () => backend.count((r) => r.method === "POST" && r.path === "/api/v1/ai-looks");
  const lookPostsBefore = lookPosts();
  const lookStale = await call(openai, "versely_apply_photo_look", { image_url: "https://img.versely.studio/me.jpg", look: "night-flash", confirm_credits: 4 });
  assert("apply_photo_look with a stale price is refused, nothing started", lookStale.isError === true && textOf(lookStale).includes("costs 9 credits now") && textOf(lookStale).includes("nothing charged") && textOf(lookStale).includes("confirm_credits: 9") && lookPosts() === lookPostsBefore, textOf(lookStale));
  const lookUnknown = await call(openai, "versely_apply_photo_look", { image_url: "https://img.versely.studio/me.jpg", look: "sepia-dream", confirm_credits: 9 });
  assert("apply_photo_look names the looks for an unknown one", lookUnknown.isError === true && textOf(lookUnknown).includes("golden-hour") && lookPosts() === lookPostsBefore, textOf(lookUnknown));
  const applied = await call(openai, "versely_apply_photo_look", { image_url: "https://img.versely.studio/me.jpg", look: "Golden hour", strength: "bold", confirm_credits: 2 });
  const appliedSc = applied.structuredContent as Record<string, any> | undefined;
  const lookBody = lastBody("/api/v1/ai-looks");
  assert("apply_photo_look sends the look id and strength; the image card follows the job", lookBody.preset === "golden-hour" && lookBody.strength === 0.85 && lookBody.image_url === "https://img.versely.studio/me.jpg" && textOf(applied).includes("2 credits") && textOf(applied).includes("NOT finished") && appliedSc?.status === "pending" && appliedSc?.kind === "image" && appliedSc?.poll?.tool_name === "versely_get_photo_look" && appliedSc?.poll?.args?.job_id === LOOK_JOB && !/pruna|nano banana/i.test(JSON.stringify(applied)), JSON.stringify(appliedSc));
  const lookMid = (await call(openai, "versely_get_photo_look", { job_id: LOOK_JOB })).structuredContent as Record<string, any> | undefined;
  assert("get_photo_look stays pending while the look is made", lookMid?.status === "pending" && lookMid?.poll?.tool_name === "versely_get_photo_look", JSON.stringify(lookMid));
  const lookDone = await call(openai, "versely_get_photo_look", { job_id: LOOK_JOB });
  const lookDoneSc = lookDone.structuredContent as Record<string, any> | undefined;
  assert("get_photo_look ends with the photo", lookDoneSc?.status === "completed" && lookDoneSc?.assets?.[0]?.url === "https://img.versely.studio/gen/ai-looks/look-a1b2.png" && textOf(lookDone).includes("Golden hour") && !/pruna/i.test(textOf(lookDone)), JSON.stringify(lookDoneSc));
  const lookFail = await call(openai, "versely_apply_photo_look", { image_url: "https://img.versely.studio/fails.jpg", look: "golden-hour", confirm_credits: 3 });
  const lookFailId = ((lookFail.structuredContent as Record<string, any> | undefined)?.poll?.args?.job_id ?? "") as string;
  await call(openai, "versely_get_photo_look", { job_id: lookFailId });
  const lookFailedSc = (await call(openai, "versely_get_photo_look", { job_id: lookFailId })).structuredContent as Record<string, any> | undefined;
  assert("apply_photo_look accepts the held amount as the approved price; a failed look shows its refund", lookFailId.endsWith("f0f0") && lookFailedSc?.status === "failed" && String(lookFailedSc?.error).includes("refunded"), JSON.stringify(lookFailedSc));
  const lookGone = await call(openai, "versely_get_photo_look", { job_id: "not-a-look" });
  assert("get_photo_look turns an unknown job into a failed card", (lookGone.structuredContent as Record<string, any> | undefined)?.status === "failed", textOf(lookGone));
  }

  // ─── styledCaptions (agent notes) ───
  {
  // Captions studio: a free look starts at once; a premium look quotes first
  // (nothing charged) and starts only with the exact price.
  const capLooks = textOf(await call(openai, "versely_list_caption_looks", {}));
  assert("list_caption_looks lists free looks and priced premium looks, never the vendor", capLooks.includes("- bold-pop: Bold pop.") && capLooks.includes("- premium-glass: Glass, 16 credits a minute") && capLooks.includes("Not available yet: backdrop") && !/veed/i.test(capLooks), capLooks);
  const capFree = await call(openai, "versely_caption_video", { video_url: "https://videos.versely.studio/gen/talk.mp4", look: "bold-pop", position: "middle" });
  const capFreeBody = lastBody("/api/v1/captions/styled");
  const capFreeSc = capFree.structuredContent as Record<string, any> | undefined;
  assert("caption_video sends a free look straight to the render", capFreeBody.style === "bold-pop" && capFreeBody.position === "middle" && capFreeBody.video_url === "https://videos.versely.studio/gen/talk.mp4" && textOf(capFree).includes("free, no credits"), JSON.stringify(capFreeBody));
  assert("caption_video's card follows the job", capFreeSc?.status === "pending" && capFreeSc?.poll?.tool_name === "versely_get_caption_job" && typeof capFreeSc?.poll?.args?.job_id === "string", JSON.stringify(capFreeSc));
  const capJobId = String(capFreeSc?.poll?.args?.job_id);
  const capPending = await call(openai, "versely_get_caption_job", { job_id: capJobId });
  assert("get_caption_job is pending while it renders", (capPending.structuredContent as any)?.status === "pending" && (capPending.structuredContent as any)?.poll?.tool_name === "versely_get_caption_job" && textOf(capPending).includes("NOT finished"), textOf(capPending));
  const capDone = await call(openai, "versely_get_caption_job", { job_id: capJobId });
  assert("get_caption_job ends with the captioned video", (capDone.structuredContent as any)?.status === "completed" && (capDone.structuredContent as any)?.assets?.[0]?.url === `https://videos.versely.studio/gen/styled-captions/${capJobId}/captioned.mp4` && textOf(capDone).includes("Captions done"), JSON.stringify(capDone.structuredContent));
  const capRenders = () => backend.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/captions/styled").length;
  const capMeasures = () => backend.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/captions/transcribe").length;
  const capR0 = capRenders();
  const capM0 = capMeasures();
  const capQuote = await call(openai, "versely_caption_video", { video_url: "https://videos.versely.studio/gen/long-talk.mp4", look: "premium-glass" });
  assert("caption_video quotes a premium look (16/min x 3 started minutes) without starting it", capRenders() === capR0 && !capQuote.isError && textOf(capQuote).includes("48 credits (3 started minutes x 16)") && textOf(capQuote).includes("confirm_credits: 48") && textOf(capQuote).includes("nothing charged") && (capQuote.structuredContent as any)?.status === "info" && lastBody("/api/v1/captions/transcribe").video_url === "https://videos.versely.studio/gen/long-talk.mp4", textOf(capQuote));
  const capStale = await call(openai, "versely_caption_video", { video_url: "https://videos.versely.studio/gen/long-talk.mp4", look: "premium-glass", confirm_credits: 32 });
  assert("caption_video refuses a premium look at a stale price", capStale.isError === true && textOf(capStale).includes("nothing charged") && textOf(capStale).includes("confirm_credits: 48") && capRenders() === capR0, textOf(capStale));
  const capPaid = await call(openai, "versely_caption_video", { video_url: "https://videos.versely.studio/gen/long-talk.mp4", look: "premium-glass", confirm_credits: 48 });
  assert("caption_video starts a premium look at the approved price, under the backend's id", lastBody("/api/v1/captions/styled").style === "veed-glass" && textOf(capPaid).includes("48 credits charged") && (capPaid.structuredContent as any)?.status === "pending" && !/veed/i.test(textOf(capPaid)), textOf(capPaid));
  assert("the confirming calls reuse the measured length (one transcribe)", capMeasures() === capM0 + 1, String(capMeasures() - capM0));
  const capMatte = await call(openai, "versely_caption_video", { video_url: "https://videos.versely.studio/gen/talk2.mp4", look: "backdrop" });
  assert("caption_video passes the service's refusal on, nothing charged", capMatte.isError === true && textOf(capMatte).includes("Not started, nothing charged") && textOf(capMatte).includes("coming soon"), textOf(capMatte));
  const capTooLong = await call(openai, "versely_caption_video", { video_url: "https://videos.versely.studio/gen/toolong.mp4", look: "premium-simple" });
  assert("a premium quote on a too-long video is refused before any charge", capTooLong.isError === true && textOf(capTooLong).includes("up to 10 minutes") && textOf(capTooLong).includes("nothing charged"), textOf(capTooLong));
  const capGone = await call(openai, "versely_get_caption_job", { job_id: "00000000-0000-4000-8000-000000000000" });
  assert("get_caption_job explains a job past its 24 hours", capGone.isError === true && textOf(capGone).includes("24 hours") && (capGone.structuredContent as any)?.status === "failed", textOf(capGone));
  const capDescs = oTools.filter((t) => ["versely_list_caption_looks", "versely_caption_video", "versely_get_caption_job"].includes(t.name)).map((t) => JSON.stringify([t.description, t.inputSchema])).join(" ");
  assert("caption studio descriptions name no vendor", capDescs.length > 0 && !/veed|\bfal\b|cartesia/i.test(capDescs), capDescs.slice(0, 200));
  }

  // ─── scripts (agent notes) ───
  {
  // Scripts: the price first (nothing charged), the paid write only with that
  // exact price, then free reads and edits; voice profile free from the user's own handle.
  const scrGens = () => backend.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/scripts/generate").length;
  const scrG0 = scrGens();
  const scrQuote = await call(openai, "versely_write_script", { source_url: "https://www.instagram.com/reel/ABC123/", length_seconds: 30 });
  assert("write_script quotes a link (script + watching the reel) without charging", scrGens() === scrG0 && !scrQuote.isError && textOf(scrQuote).includes("costs 3 credits (1 for the script + 2 to watch the reel") && textOf(scrQuote).includes("confirm_credits: 3") && textOf(scrQuote).includes("nothing charged"), textOf(scrQuote));
  const scrStale = await call(openai, "versely_write_script", { source_url: "https://www.instagram.com/reel/ABC123/", length_seconds: 30, confirm_credits: 1 });
  assert("write_script refuses a stale price", scrStale.isError === true && textOf(scrStale).includes("nothing charged") && textOf(scrStale).includes("confirm_credits: 3") && scrGens() === scrG0, textOf(scrStale));
  const scrWritten = textOf(await call(openai, "versely_write_script", { source_url: "https://www.instagram.com/reel/ABC123/", length_seconds: 30, language: "hinglish", confirm_credits: 3 }));
  const scrBody = lastBody("/api/v1/scripts/generate");
  assert("write_script sends the link, language and length (not the price)", scrBody.source_url === "https://www.instagram.com/reel/ABC123/" && scrBody.language === "hinglish" && scrBody.length_seconds === 30 && !("confirm_credits" in scrBody), JSON.stringify(scrBody));
  assert("write_script waits for and returns the finished script", scrWritten.includes("Script ready (3 credits charged)") && scrWritten.includes("1. Your salary isn't small. Your plan is. [bold claim] (chosen)") && scrWritten.includes("0-3s  Say: \"Your salary isn't small.") && scrWritten.includes("Remixed from: https://www.instagram.com/reel/ABC123/ (@moneywithmaya)"), scrWritten);
  const scrId = /script_id ([0-9a-f-]{36})/.exec(scrWritten)?.[1] ?? "";
  const scrIdeaQuote = textOf(await call(openai, "versely_write_script", { idea: "Morning routine for night-shift nurses" }));
  assert("write_script prices an idea at the script alone", scrIdeaQuote.includes("costs 1 credit (1 for the script)") && scrIdeaQuote.includes("confirm_credits: 1"), scrIdeaQuote);
  const scrTwo = await call(openai, "versely_write_script", { idea: "a b c", source_url: "https://www.tiktok.com/@a/video/1", confirm_credits: 3 });
  assert("write_script takes exactly one source, nothing charged", scrTwo.isError === true && textOf(scrTwo).includes("exactly one") && scrGens() === scrG0 + 1, textOf(scrTwo));
  const scrGot = textOf(await call(openai, "versely_get_script", { script_id: scrId }));
  assert("get_script shows the beats, caption and hashtags", scrGot.includes("Say: \"Split it the day it lands") && scrGot.includes("On screen: 50 / 30 / 20") && scrGot.includes("Hashtags: #money #salary #personalfinance"), scrGot);
  const scrListed = textOf(await call(openai, "versely_list_scripts", {}));
  assert("list_scripts lists the script with where it came from", scrListed.includes(scrId) && scrListed.includes("remix of https://www.instagram.com/reel/ABC123/") && scrListed.includes("Hinglish"), scrListed);
  const scrPatch = () => (backend.requests.filter((r) => r.method === "PATCH" && r.path === `/api/v1/scripts/${scrId}`).at(-1)?.body ?? {}) as Record<string, any>;
  const scrUpd = textOf(await call(openai, "versely_update_script", { script_id: scrId, chosen_hook: 2, cta: "Save this for payday.", scheduled_for: "2026-11-20" }));
  assert("update_script merges the edit into the full script (hook numbers are 1-based)", scrPatch().script?.chosen_hook === 1 && scrPatch().script?.cta === "Save this for payday." && scrPatch().script?.hooks?.length === 3 && scrPatch().script?.beats?.length === 3 && scrPatch().scheduled_for === "2026-11-20", JSON.stringify(scrPatch()));
  assert("update_script shows the edited script", scrUpd.includes("2. Where did $400 go in 7 days? [question] (chosen)") && scrUpd.includes("Call to action: Save this for payday.") && scrUpd.includes("to film on 2026-11-20"), scrUpd);
  await call(openai, "versely_update_script", { script_id: scrId, scheduled_for: "none", filmed: true });
  assert("update_script clears the day and marks it filmed, without resending the script", scrPatch().scheduled_for === null && scrPatch().filmed === true && !("script" in scrPatch()), JSON.stringify(scrPatch()));
  const scrDel = textOf(await call(openai, "versely_delete_script", { script_id: scrId }));
  assert("delete_script deletes", scrDel.includes("Deleted script") && backend.requests.some((r) => r.method === "DELETE" && r.path === `/api/v1/scripts/${scrId}`), scrDel);

  const scrNoVoice = textOf(await call(openai, "versely_get_voice_profile", {}));
  assert("get_voice_profile says when there is none", scrNoVoice.includes("no voice profile yet") && scrNoVoice.includes("versely_build_voice_profile"), scrNoVoice);
  const scrBuilt = await call(openai, "versely_build_voice_profile", { platform: "instagram", handle: "@MoneyWithMaya" });
  const scrBuildBody = lastBody("/api/v1/scripts/voice-profile/build");
  assert("build_voice_profile sends the handle and waits for the profile", scrBuildBody.platform === "instagram" && scrBuildBody.handle === "@MoneyWithMaya" && textOf(scrBuilt).includes("Voice profile ready (free)") && textOf(scrBuilt).includes("Language: Hinglish") && textOf(scrBuilt).includes("@moneywithmaya"), textOf(scrBuilt));
  await call(openai, "versely_write_script", { idea: "Morning routine for night-shift nurses", confirm_credits: 1 });
  assert("write_script defaults to the voice profile's language", lastBody("/api/v1/scripts/generate").language === "hinglish" && lastBody("/api/v1/scripts/generate").length_seconds === 30, JSON.stringify(lastBody("/api/v1/scripts/generate")));
  const scrVoiceGone = textOf(await call(openai, "versely_delete_voice_profile", {}));
  assert("delete_voice_profile deletes", scrVoiceGone.includes("deleted") && backend.requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/scripts/voice-profile"), scrVoiceGone);
  }

  // ─── ugcAds (agent notes) ───
  {
  // UGC ads: presenters (Versely's + the user's avatars), voices (clones first),
  // free scripts, a per-presenter quote, create only with the quoted price
  // (re-priced inside the tool: the backend takes no confirm_credits), then the
  // batch card follows the ads.
  const ugcReqs = (p: string) => backend.requests.filter((r) => r.path === p);
  const UGC_BATCH = "ua_7d3f9a2e-1c4b-4e8a-9b6d-2f5e8c1a7b30";
  const UGC_SCRIPT = "Okay so I tried this serum for two weeks [laughs] and honestly my skin has never looked this good. Link is below!";

  const actorsRes = await call(openai, "versely_list_ugc_actors", {});
  const actorsText = textOf(actorsRes);
  const actorsSc = actorsRes.structuredContent as Record<string, any> | undefined;
  assert("list_ugc_actors merges Versely presenters with the user's own avatars", actorsText.includes("maya-selfie") && actorsText.includes("\"source\": \"yours\"") && actorsText.includes("Mia") && actorsText.includes("none of its own: pick one"), actorsText);
  assert("list_ugc_actors flags talking-head-only presenters and names no engine or voice vendor", actorsText.includes("\"talking_head_only\": true") && !/heygen|cartesia/i.test(actorsText), actorsText);
  assert("list_ugc_actors shows the portraits as a gallery card", actorsSc?.kind === "gallery" && (actorsSc?.assets ?? []).some((a: any) => a.url === "https://img.versely.studio/ugc/actors/maya-selfie.jpg"), JSON.stringify(actorsSc));
  const productActors = textOf(await call(openai, "versely_list_ugc_actors", { format: "product_in_hand" }));
  assert("list_ugc_actors with a product format drops talking-head-only presenters", productActors.includes("maya-selfie") && !productActors.includes("hg-anna-home"), productActors);

  const voicesText = textOf(await call(openai, "versely_list_ugc_voices", { language: "es" }));
  assert("list_ugc_voices puts the user's cloned voice first and filters by language (multilingual kept)", voicesText.includes("\"yours\": true") && voicesText.indexOf("clone:6f1c2d3e") > -1 && voicesText.indexOf("clone:6f1c2d3e") < voicesText.indexOf("Fernanda") && voicesText.includes("Liam") && !voicesText.includes("Skylar"), voicesText);
  assert("list_ugc_voices drops provider names and vendor-hosted previews", !voicesText.includes("\"provider\"") && !voicesText.includes("preview_url") && !voicesText.includes("storage.googleapis"), voicesText);

  const scriptsText = textOf(await call(openai, "versely_write_ugc_script", { brief: "A calming face serum for sensitive skin", brand_id: "8a1f0c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b", length_s: 15 }));
  const scriptBody = lastBody("/api/v1/ugc/script");
  assert("write_ugc_script sends brand_kit_id and the default format, and says it is free", scriptBody.brand_kit_id === "8a1f0c2e-3b4d-4e5f-9a6b-7c8d9e0f1a2b" && scriptBody.format === "talking_head" && scriptBody.length_s === 15 && scriptsText.includes("free, nothing charged") && scriptsText.includes("I almost gave up on my skin."), scriptsText);
  const scriptPosts = ugcReqs("/api/v1/ugc/script").length;
  const noBrief = await call(openai, "versely_write_ugc_script", { tone: "funny" });
  assert("write_ugc_script with nothing to sell is refused before any request", noBrief.isError === true && textOf(noBrief).includes("brief") && ugcReqs("/api/v1/ugc/script").length === scriptPosts, textOf(noBrief));

  const ugcQuote = textOf(await call(openai, "versely_quote_ugc_ads", { actor_ids: ["maya-selfie", "leo-car"], script: UGC_SCRIPT }));
  const quoteQs = ugcReqs("/api/v1/ugc/ads/quote").slice(-2).map((r) => r.query);
  assert("quote_ugc_ads prices each presenter on the cue-free script length", quoteQs.length === 2 && quoteQs.every((q) => q.script_chars === "104" && q.count === "1" && q.format === "talking_head" && q.voice_id === undefined) && quoteQs.map((q) => q.actor_id).sort().join(",") === "leo-car,maya-selfie", JSON.stringify(quoteQs));
  assert("quote_ugc_ads gives the total and the confirm_credits to use", ugcQuote.includes("68 credits in total") && ugcQuote.includes("34 credits per ad") && ugcQuote.includes("confirm_credits: 68") && ugcQuote.includes("nothing charged"), ugcQuote);
  const cloneQuote = textOf(await call(openai, "versely_quote_ugc_ads", { actor_ids: ["0b6d6c7e-6f0a-4c1e-9a52-3f1d2e4b5a69"], script: UGC_SCRIPT }));
  assert("quote_ugc_ads prices the user's avatar in its linked cloned voice", ugcReqs("/api/v1/ugc/ads/quote").at(-1)?.query.voice_id === "clone:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f" && cloneQuote.includes("36 credits in total"), cloneQuote);
  const quotesBefore = ugcReqs("/api/v1/ugc/ads/quote").length;
  const thOnly = await call(openai, "versely_quote_ugc_ads", { actor_ids: ["hg-anna-home"], script: UGC_SCRIPT, format: "product_in_hand" });
  assert("quote_ugc_ads refuses a talking-head-only presenter for a product format, without naming its engine", thOnly.isError === true && textOf(thOnly).includes("can only make talking_head ads") && !/heygen/i.test(textOf(thOnly)) && ugcReqs("/api/v1/ugc/ads/quote").length === quotesBefore, textOf(thOnly));
  const tooLong = await call(openai, "versely_quote_ugc_ads", { actor_ids: ["maya-selfie"], script: "word ".repeat(200) });
  assert("quote_ugc_ads refuses a script over 60 s of speech", tooLong.isError === true && textOf(tooLong).includes("about 67 s"), textOf(tooLong));

  const adPosts = () => backend.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/ugc/ads").length;
  const postsBefore = adPosts();
  const ugcStale = await call(openai, "versely_create_ugc_ads", { actor_ids: ["maya-selfie", "leo-car"], script: UGC_SCRIPT, confirm_credits: 60 });
  assert("create_ugc_ads with a stale price is refused with the new one, nothing posted", ugcStale.isError === true && textOf(ugcStale).includes("now cost 68 credits") && textOf(ugcStale).includes("nothing charged") && adPosts() === postsBefore, textOf(ugcStale));
  const noPhoto = await call(openai, "versely_create_ugc_ads", { actor_ids: ["maya-selfie"], script: UGC_SCRIPT, format: "product_in_hand", confirm_credits: 38 });
  assert("create_ugc_ads product_in_hand without a product photo is refused, nothing charged", noPhoto.isError === true && textOf(noPhoto).includes("product_image_url") && textOf(noPhoto).includes("nothing charged") && adPosts() === postsBefore, textOf(noPhoto));
  const ugcStarted = await call(openai, "versely_create_ugc_ads", { actor_ids: ["maya-selfie", "leo-car"], script: UGC_SCRIPT, confirm_credits: 68 });
  const ugcBody = lastBody("/api/v1/ugc/ads");
  const ugcSc = ugcStarted.structuredContent as Record<string, any> | undefined;
  assert("create_ugc_ads posts the script and presenters, without confirm_credits, a voice or images", ugcBody.script === UGC_SCRIPT && JSON.stringify(ugcBody.actor_ids) === JSON.stringify(["maya-selfie", "leo-car"]) && ugcBody.format === "talking_head" && !("confirm_credits" in ugcBody) && !("voice_id" in ugcBody) && !("product_image_url" in ugcBody), JSON.stringify(ugcBody));
  assert("create_ugc_ads returns a pending card that polls versely_get_ugc_ads", ugcSc?.status === "pending" && ugcSc?.poll?.tool_name === "versely_get_ugc_ads" && ugcSc?.poll?.args?.batch_id === UGC_BATCH && textOf(ugcStarted).includes("68 credits charged") && textOf(ugcStarted).includes("Do not create these ads again"), JSON.stringify(ugcSc));
  const ugcPoll1 = (await call(openai, "versely_get_ugc_ads", { batch_id: UGC_BATCH })).structuredContent as Record<string, any> | undefined;
  assert("get_ugc_ads stays pending while the ads are filming", ugcPoll1?.status === "pending" && ugcPoll1?.assets?.length === 0 && typeof ugcPoll1?.progress === "number" && ugcPoll1?.poll?.tool_name === "versely_get_ugc_ads", JSON.stringify(ugcPoll1));
  const ugcDoneRes = await call(openai, "versely_get_ugc_ads", { batch_id: UGC_BATCH });
  const ugcDone = ugcDoneRes.structuredContent as Record<string, any> | undefined;
  assert("get_ugc_ads ends with the finished ad and reports the failed one as refunded", ugcDone?.status === "completed" && ugcDone?.assets?.length === 1 && String(ugcDone?.assets?.[0]?.url).endsWith("_1.mp4") && !ugcDone?.poll && textOf(ugcDoneRes).includes("The video didn't render.") && textOf(ugcDoneRes).includes("refunded"), JSON.stringify(ugcDone));
  const ugcList = textOf(await call(openai, "versely_list_ugc_ads", { limit: 10 }));
  assert("list_ugc_ads groups the ads by batch", ugcList.includes(UGC_BATCH) && ugcList.includes("\"actor_name\": \"Maya\"") && backend.requests.filter((r) => r.method === "GET" && r.path === "/api/v1/ugc/ads").at(-1)?.query.limit === "10", ugcList);
  }

  // ─── avatarStudio (agent notes) ───
  {
  // Avatar Studio: the ready-made cast (type filter, portrait + full body),
  // adding one returns a character id, the 12-avatar limit, creations.
  const castRes = await call(openai, "versely_list_ready_made_avatars", { type: "creature" });
  const castSc = castRes.structuredContent as Record<string, any> | undefined;
  assert("list_ready_made_avatars filters by type and gives portrait and full-body links", textOf(castRes).includes("char-ziggy") && !textOf(castRes).includes("char-tessa") && textOf(castRes).includes("https://img.versely.studio/avatars/char-ziggy-full.jpg") && castSc?.kind === "gallery" && castSc?.assets?.[0]?.url === "https://img.versely.studio/avatars/char-ziggy.jpg", textOf(castRes));
  const averageCast = textOf(await call(openai, "versely_list_ready_made_avatars", { type: "average" }));
  assert("list_ready_made_avatars reads an untyped presenter as 'average'", averageCast.includes("char-tessa") && averageCast.includes("maya-selfie") && !averageCast.includes("char-ziggy"), averageCast);
  const addedAvatar = await call(openai, "versely_add_ready_made_avatar", { avatar_id: "char-tessa" });
  assert("add_ready_made_avatar sends actor_id and returns the character id and where it works", lastBody("/api/v1/hooks/characters/premade").actor_id === "char-tessa" && textOf(addedAvatar).includes("character_id 5b2f3c1e-8d4a-4f6b-9c7e-1a2b3c4d5e6f") && textOf(addedAvatar).includes("versely_swap_video") && textOf(addedAvatar).includes("char-tessa-full.jpg"), textOf(addedAvatar));
  const avatarLimit = await call(openai, "versely_add_ready_made_avatar", { avatar_id: "char-limit" });
  assert("add_ready_made_avatar at the 12-avatar limit says how to make room", avatarLimit.isError === true && textOf(avatarLimit).includes("12 avatars") && textOf(avatarLimit).includes("versely_delete_hook_character"), textOf(avatarLimit));
  const unknownAvatar = await call(openai, "versely_add_ready_made_avatar", { avatar_id: "char-nobody" });
  assert("add_ready_made_avatar with an unknown id points at the list", unknownAvatar.isError === true && textOf(unknownAvatar).includes("versely_list_ready_made_avatars"), textOf(unknownAvatar));
  const madeWith = textOf(await call(openai, "versely_list_avatar_creations", { character_id: "5b2f3c1e-8d4a-4f6b-9c7e-1a2b3c4d5e6f" }));
  assert("list_avatar_creations lists what the avatar was used in and where to open each", madeWith.includes("\"hook_pack\": 1") && madeWith.includes("versely_get_hook_collection") && madeWith.includes("versely_get_slideshow") && madeWith.includes("Serum hooks"), madeWith);
  const creationReads = () => backend.requests.filter((r) => r.path.endsWith("/creations")).length;
  const creationsBefore = creationReads();
  const premadeHistory = await call(openai, "versely_list_avatar_creations", { character_id: "char-tessa" });
  assert("list_avatar_creations refuses a ready-made id without calling the backend", premadeHistory.isError === true && textOf(premadeHistory).includes("versely_add_ready_made_avatar") && creationReads() === creationsBefore, textOf(premadeHistory));
  }

  // ─── aiCreator (agent notes) ───
  {
  // AI creators: options free, rooms and a test take paid with confirm_credits, create/edit free with the exact
  // price, the card follows the take, approval states the schedule and the daily cost. No voice vendor ever shows.
  const VENDOR = /cartesia|elevenlabs|gemini/i;
  const aicOpts = textOf(await call(openai, "versely_list_ai_creator_options", {}));
  assert("list_ai_creator_options lists voices by name with their language, no vendor ids", aicOpts.includes("\"voice\": \"Fernanda\"") && aicOpts.includes("\"language\": \"Spanish\"") && !VENDOR.test(aicOpts), aicOpts);
  assert("list_ai_creator_options carries the room price, the episode price table and ready-made avatars", aicOpts.includes("\"credits_per_set\": 8") && aicOpts.includes("\"20\": 138") && aicOpts.includes("maya-kitchen") && aicOpts.includes("\"your_avatars\""), aicOpts);
  const aicOptsMale = textOf(await call(openai, "versely_list_ai_creator_options", { avatar_gender: "male" }));
  assert("list_ai_creator_options filters ready-made avatars by gender", aicOptsMale.includes("leo-studio") && !aicOptsMale.includes("maya-kitchen"), aicOptsMale);

  const roomsStale = await call(openai, "versely_make_ai_creator_rooms", { avatar_id: "maya-kitchen", setting: "kitchen", confirm_credits: 4 });
  assert("make_ai_creator_rooms with a stale price is refused with the new one", roomsStale.isError === true && textOf(roomsStale).includes("now costs 8 credits") && textOf(roomsStale).includes("nothing charged"), textOf(roomsStale));
  const roomsCustom = await call(openai, "versely_make_ai_creator_rooms", { avatar_id: "maya-kitchen", setting: "custom", confirm_credits: 8 });
  assert("make_ai_creator_rooms refuses a custom room without a note", roomsCustom.isError === true && textOf(roomsCustom).includes("nothing charged"), textOf(roomsCustom));
  const rooms = await call(openai, "versely_make_ai_creator_rooms", { avatar_id: "maya-kitchen", setting: "kitchen", note: "lots of plants", confirm_credits: 8 });
  const roomsSc = rooms.structuredContent as Record<string, any> | undefined;
  const roomsBody = lastBody("/api/v1/automations/ai-creator/rooms") as Record<string, any>;
  assert("make_ai_creator_rooms sends avatarId, setting and note and shows four rooms", roomsBody.avatarId === "maya-kitchen" && roomsBody.setting === "kitchen" && roomsBody.note === "lots of plants" && roomsBody.confirm_credits === undefined && roomsSc?.status === "completed" && roomsSc?.assets?.length === 4 && textOf(rooms).includes("8 credits charged"), JSON.stringify(roomsSc));
  const room = String(roomsSc?.assets?.[0]?.url ?? "");
  const roomsPostsBefore = backend.count((r) => r.method === "POST" && r.path === "/api/v1/automations/ai-creator/rooms");
  const slowRooms = await call(openai, "versely_make_ai_creator_rooms", { avatar_id: "maya-kitchen", setting: "gym", note: "slow one", confirm_credits: 8 });
  const madeAfter = /made_after: "([^"]+)"/.exec(textOf(slowRooms))?.[1] ?? "";
  assert("a room set that outlasts the wait is not an error and points at get_ai_creator_rooms", slowRooms.isError !== true && textOf(slowRooms).includes("still being drawn") && textOf(slowRooms).includes("versely_get_ai_creator_rooms") && textOf(slowRooms).includes("Do NOT call this again") && madeAfter.length > 10 && backend.count((r) => r.method === "POST" && r.path === "/api/v1/automations/ai-creator/rooms") === roomsPostsBefore + 1, textOf(slowRooms));
  const roomsMaking = await call(openai, "versely_get_ai_creator_rooms", { made_after: madeAfter });
  assert("get_ai_creator_rooms says a set is still being drawn, not the older set", textOf(roomsMaking).includes("still being drawn") && (roomsMaking.structuredContent as any)?.assets?.length === 0, textOf(roomsMaking));
  backend.finishRooms();
  const roomsBack = await call(openai, "versely_get_ai_creator_rooms", { made_after: madeAfter });
  assert("get_ai_creator_rooms returns the four pictures once they are done", textOf(roomsBack).includes("4 rooms made (8 credits charged)") && String((roomsBack.structuredContent as any)?.assets?.[3]?.url).includes("/gym-") && textOf(roomsBack).includes("room_image_url"), textOf(roomsBack));
  const roomsNone = await call(openai, "versely_get_ai_creator_rooms", { made_after: "2099-01-01T00:00:00.000Z" });
  assert("a set that never arrived is said plainly", textOf(roomsNone).includes("No new set of rooms was made") && textOf(roomsNone).includes("refunded"), textOf(roomsNone));

  const created = textOf(await call(openai, "versely_create_ai_creator", {
    avatar_id: "maya-kitchen", room_image_url: room, voice: "fernanda", format: "kitchen_tips", length_seconds: 20,
    post_account_id: "acct-db-1", post_time: "18:00", timezone: "Europe/London",
  }));
  const createBody = lastBody("/api/v1/automations") as Record<string, any>;
  assert("create_ai_creator sends the ai_creator config: voice id from the name, provider account id, schedule", createBody.kind === "ai_creator" && createBody.config?.voiceId === "cartesia:b4b8e2af-6139-466e-a93a-30c20d2e1fc5" && createBody.config?.avatarId === "maya-kitchen" && createBody.config?.roomImageUrl === room && createBody.config?.post_account_ids?.[0] === "spc_ext_1" && createBody.schedule?.times?.[0] === "18:00" && createBody.schedule?.timezone === "Europe/London", JSON.stringify(createBody));
  assert("create_ai_creator returns the id, the exact price and the paid next step, nothing charged", created.includes("nothing charged") && created.includes("138 credits per episode, plus 1 credit for each post") && created.includes("18:00 (Europe/London time) to tiktok @smoke") && created.includes("confirm_credits: 138") && !VENDOR.test(created), created);
  const creatorId = /creator_id ([0-9a-f-]{36})/.exec(created)?.[1] ?? "";
  const badVoice = await call(openai, "versely_create_ai_creator", { avatar_id: "maya-kitchen", room_image_url: room, voice: "Nobody", format: "kitchen_tips" });
  assert("create_ai_creator refuses an unknown voice name", badVoice.isError === true && textOf(badVoice).includes("versely_list_ai_creator_options"), textOf(badVoice));

  const takeStale = await call(openai, "versely_test_ai_creator_episode", { creator_id: creatorId, confirm_credits: 100 });
  assert("test_ai_creator_episode with a stale price is refused with the new one", takeStale.isError === true && textOf(takeStale).includes("now costs 138 credits") && textOf(takeStale).includes("nothing charged"), textOf(takeStale));
  const take = await call(openai, "versely_test_ai_creator_episode", { creator_id: creatorId, confirm_credits: 138 });
  const takeSc = take.structuredContent as Record<string, any> | undefined;
  assert("test_ai_creator_episode starts the take and the card follows it", takeSc?.status === "pending" && takeSc?.poll?.tool_name === "versely_list_ai_creator_episodes" && takeSc?.poll?.args?.creator_id === creatorId && typeof takeSc?.poll?.args?.episode_id === "string" && textOf(take).includes("is not posted") && textOf(take).includes("NOT finished"), JSON.stringify(takeSc));
  const takeAgain = await call(openai, "versely_test_ai_creator_episode", { creator_id: creatorId, confirm_credits: 138, confirm_repeat: true });
  assert("a second take while one is being made is refused, nothing charged", takeAgain.isError === true && textOf(takeAgain).includes("already being made") && textOf(takeAgain).includes("nothing charged"), textOf(takeAgain));

  const early = await call(openai, "versely_approve_ai_creator", { creator_id: creatorId, confirm_credits: 138 });
  assert("approve_ai_creator waits for the newest take", early.isError === true && textOf(early).includes("still being made"), textOf(early));
  const listed = await call(openai, "versely_list_ai_creator_episodes", { creator_id: creatorId });
  const listSc = listed.structuredContent as Record<string, any> | undefined;
  const listText = textOf(listed);
  assert("list_ai_creator_episodes ends with the take's video, its lines and the approve step", listSc?.status === "completed" && String(listSc?.assets?.[0]?.url ?? "").endsWith("episode.mp4") && listText.includes("Lines:") && listText.includes("Wrap them in a damp paper towel.") && listText.includes("versely_approve_ai_creator") && listText.includes("in setup") && !VENDOR.test(listText), listText);

  const approveStale = await call(openai, "versely_approve_ai_creator", { creator_id: creatorId, confirm_credits: 120 });
  assert("approve_ai_creator with a stale price is refused, nothing started", approveStale.isError === true && textOf(approveStale).includes("now costs 138 credits") && textOf(approveStale).includes("nothing started"), textOf(approveStale));
  const approved = await call(openai, "versely_approve_ai_creator", { creator_id: creatorId, confirm_credits: 138, post_test_episode: true });
  const approveText = textOf(approved);
  assert("approve_ai_creator sends postTestEpisode and states the schedule, account and daily cost", (lastBody(`/api/v1/automations/ai-creator/${creatorId}/approve`) as Record<string, any>).postTestEpisode === true && approveText.includes("is live") && approveText.includes("18:00 (Europe/London time)") && approveText.includes("tiktok @smoke") && approveText.includes("138 credits per episode") && approveText.includes("versely_pause_automation"), approveText);
  const approveTwice = await call(openai, "versely_approve_ai_creator", { creator_id: creatorId, confirm_credits: 138, confirm_repeat: true });
  assert("approving a live creator again changes nothing", approveTwice.isError === true && textOf(approveTwice).includes("already approved"), textOf(approveTwice));

  const upd = textOf(await call(openai, "versely_update_ai_creator", { creator_id: creatorId, quality: "1080p", post_time: "09:30" }));
  assert("update_ai_creator merges the config (the fake refuses a partial one), re-prices and keeps it live", upd.includes("now 198 credits (was 138)") && upd.includes("stays live") && upd.includes("09:30 (Europe/London time)"), upd);
  const updNothing = await call(openai, "versely_update_ai_creator", { creator_id: creatorId });
  assert("update_ai_creator with nothing to change is refused", updNothing.isError === true, textOf(updNothing));
  }

  // Short dramas: plan free, show cast + lines + price, film only with the
  // approved price (a stale one is refused, nothing charged), follow it to the video.
  const planned = await call(openai, "versely_plan_drama_show", { idea: "An intern buys the company on day one", episode_seconds: 30, resolution: "720p" });
  const planText = textOf(planned);
  const planSc = planned.structuredContent as Record<string, any> | undefined;
  assert("plan_drama_show forwards the idea and shows cast, Episode 1 lines and price", lastBody("/api/v1/drama/shows").idea === "An intern buys the company on day one" && planText.includes("Mara") && planText.includes("Dalton: \"You're fired.\"") && planText.includes("286 credits") && planText.includes("confirm_credits: 286"), planText);
  assert("plan_drama_show shows the tier (Standard by default, always 1080p)", lastBody("/api/v1/drama/shows").resolution === "720p" && planText.includes("Standard 1080p") && !planText.includes("High quality"), planText);
  assert("plan_drama_show's card shows the cast portraits", planSc?.status === "completed" && planSc?.assets?.[0]?.url === "https://img.versely.studio/drama/mara.jpg", JSON.stringify(planSc));
  const stale = await call(openai, "versely_film_drama_episode", { show_id: "drm_smoke000001", n: 1, confirm_credits: 150 });
  assert("film_drama_episode with a stale price is refused with the new one", stale.isError === true && textOf(stale).includes("now 286 credits") && textOf(stale).includes("nothing charged"), textOf(stale));
  const filming = await call(openai, "versely_film_drama_episode", { show_id: "drm_smoke000001", n: 1, confirm_credits: 286 });
  const filmSc = filming.structuredContent as Record<string, any> | undefined;
  assert("film_drama_episode sends confirm_credits and follows the episode", lastBody("/api/v1/drama/shows/drm_smoke000001/episodes/1/film").confirm_credits === 286 && filmSc?.status === "pending" && filmSc?.poll?.tool_name === "versely_get_drama_show" && filmSc?.poll?.args?.n === 1 && textOf(filming).includes("about 10 minutes"), JSON.stringify(filmSc));
  const filmAgain = await call(openai, "versely_film_drama_episode", { show_id: "drm_smoke000001", n: 1, confirm_credits: 286, confirm_repeat: true });
  assert("filming the same episode again is refused", filmAgain.isError === true && textOf(filmAgain).includes("already filming"), textOf(filmAgain));
  const epDone = (await call(openai, "versely_get_drama_show", { show_id: "drm_smoke000001", n: 1 })).structuredContent as Record<string, any> | undefined;
  assert("get_drama_show ends with the filmed episode", epDone?.status === "completed" && epDone?.assets?.[0]?.url === "https://videos.versely.studio/drama/drm_smoke000001-1.mp4", JSON.stringify(epDone));
  const ep2 = textOf(await call(openai, "versely_write_drama_episode", { show_id: "drm_smoke000001", n: 2, notes: "more comedy" }));
  assert("write_drama_episode returns the lines and the price", lastBody("/api/v1/drama/shows/drm_smoke000001/episodes/2/script").notes === "more comedy" && ep2.includes("Mara: \"Notes: more comedy\"") && ep2.includes("137 credits"), ep2);
  const dramaQuote = textOf(await call(openai, "versely_get_drama_quote", { show_id: "drm_smoke000001", n: 2 }));
  assert("get_drama_quote gives the exact price and balance", dramaQuote.includes("137 credits") && dramaQuote.includes("confirm_credits: 137") && dramaQuote.includes("Balance: 250"), dramaQuote);
  // Quality tiers: switching to High quality re-prices the scripted episode
  // (15 s at 480p = 160); the legacy 540p reads as 480p, 1080p as 720p, and
  // Standard is 1080p whatever is sent.
  const lastPatch = () => (backend.requests.filter((r) => r.method === "PATCH" && r.path === "/api/v1/drama/shows/drm_smoke000001").at(-1)?.body ?? {}) as Record<string, unknown>;
  const hq = textOf(await call(openai, "versely_update_drama_show", { show_id: "drm_smoke000001", quality: "high", resolution: "540p" }));
  const patchBody = lastPatch();
  assert("update_drama_show forwards quality and shows the new tier and price", patchBody.quality === "high" && patchBody.resolution === "540p" && hq.includes("High quality 480p") && hq.includes("160 credits") && hq.includes("confirm_credits: 160"), hq);
  const hqQuote = textOf(await call(openai, "versely_get_drama_quote", { show_id: "drm_smoke000001", n: 2 }));
  assert("get_drama_quote passes the quality through", hqQuote.includes("160 credits") && hqQuote.includes("High quality 480p") && hqQuote.includes("confirm_credits: 160"), hqQuote);
  const hq1080 = textOf(await call(openai, "versely_update_drama_show", { show_id: "drm_smoke000001", resolution: "1080p" }));
  assert("High quality reads 1080p as 720p and re-prices", lastPatch().resolution === "1080p" && hq1080.includes("High quality 720p") && hq1080.includes("320 credits"), hq1080);
  const backToStd = textOf(await call(openai, "versely_update_drama_show", { show_id: "drm_smoke000001", quality: "standard", resolution: "540p" }));
  assert("Standard is always 1080p (a sent 540p too) and re-prices from the script", backToStd.includes("Standard 1080p") && backToStd.includes("137 credits") && !backToStd.includes("540p"), backToStd);
  const tierEnum = (n: string, p: string) => JSON.stringify(((byName(oTools, n)?.inputSchema.properties ?? {}) as Record<string, { enum?: unknown }>)[p]?.enum);
  assert("plan and update take quality and the four resolutions (540p still accepted)", ["versely_plan_drama_show", "versely_update_drama_show"].every((n) => tierEnum(n, "quality") === '["standard","high"]' && tierEnum(n, "resolution") === '["480p","540p","720p","1080p"]'));
  for (const n of ["versely_plan_drama_show", "versely_update_drama_show"]) {
    const d = byName(oTools, n)?.description ?? "";
    assert(`${n} offers both tiers with their prices`, ["Standard", "High quality", "always 1080p", "about 150 for 15 s", "about 300 for 30 s", "160 / 320", "320 / 640", "only matters for High quality"].every((s) => d.includes(s)), d);
    assert(`${n} carries none of the old Standard figures`, !/\b(68|70|135|142|284|285)\b|540p/.test(d), d);
  }
  const dramaDescs = oTools.filter((t) => t.name.includes("drama")).map((t) => JSON.stringify([t.description, t.inputSchema])).join(" ");
  assert("drama tools name no provider", !/vidu|runpod|higgsfield|sume|seedance|nano.?banana|z-image|gpt.?image|openai|\bfal\b/i.test(dramaDescs));
  assert("only filming a drama episode spends credits", (byName(oTools, "versely_film_drama_episode")?.inputSchema.required ?? []).includes("confirm_credits") && (byName(oTools, "versely_get_drama_quote")?.annotations as Record<string, unknown> | undefined)?.readOnlyHint === true);

  // ── Audit fixes (2026-11-14): each proves the changed request or text ─────────
  const hintsOfTool = (n: string) => (byName(oTools, n)?.annotations ?? {}) as Record<string, unknown>;
  // D1: a new episode length drops every unfilmed script (back to planned); the description says so.
  const shorter = textOf(await call(openai, "versely_update_drama_show", { show_id: "drm_smoke000001", episode_seconds: 15 }));
  assert("a new episode length drops the unfilmed scripts, and update_drama_show says to write them again", lastPatch().episode_seconds === 15 && shorter.includes("2. The Board (planned)") && shorter.includes("not written yet") && (byName(oTools, "versely_update_drama_show")?.description ?? "").includes("its script is dropped"), shorter);
  // D2: delete a show.
  const dramaGone = await call(openai, "versely_delete_drama_show", { show_id: "drm_smoke000001" });
  assert("delete_drama_show deletes the show", !dramaGone.isError && textOf(dramaGone).includes("Deleted") && backend.requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/drama/shows/drm_smoke000001") && (byName(oTools, "versely_delete_drama_show")?.annotations as Record<string, unknown> | undefined)?.destructiveHint === true, textOf(dramaGone));

  // H1-H4: hook lines are capped at the 90 characters the backend burns; the models tool promises no vibes; reveal is sent.
  const reuseProps = (byName(oTools, "versely_reuse_hooks")?.inputSchema.properties ?? {}) as Record<string, any>;
  const saveProps = (byName(oTools, "versely_save_hook")?.inputSchema.properties ?? {}) as Record<string, any>;
  assert("reuse_hooks and save_hook cap lines at 90 characters", reuseProps.lines?.additionalProperties?.maxLength === 90 && saveProps.hook_line?.maxLength === 90, JSON.stringify({ lines: reuseProps.lines, hook_line: saveProps.hook_line }));
  const hookModelsDesc = byName(oTools, "versely_list_hook_models")?.description ?? "";
  assert("list_hook_models no longer promises the vibes", !hookModelsDesc.includes("settings (vibes)") && hookModelsDesc.includes("vibe") && hookModelsDesc.includes("free"), hookModelsDesc);
  await call(openai, "versely_reuse_hooks", { hook_ids: ["plate-1"], lines: { "plate-1": "Watch this" }, reveal: { url: "https://img.versely.studio/p/product.jpg", seconds: 2.5 } });
  assert("reuse_hooks sends the reveal", JSON.stringify(lastBody("/api/v1/hooks/collections").reveal) === '{"url":"https://img.versely.studio/p/product.jpg","seconds":2.5}', JSON.stringify(lastBody("/api/v1/hooks/collections")));

  // S1-S4: videos use the captioned slides; avatar and brand slideshows; the avatar price per slide.
  const vid = await call(openai, "versely_slideshow_to_video", { slideshow_id: "ss-1" });
  assert("slideshow_to_video asks for the captioned slides by default", lastBody("/api/v1/slideshow/ss-1/video").use_edited_images === true && JSON.stringify(vid).includes("ss-1.mp4"), JSON.stringify(lastBody("/api/v1/slideshow/ss-1/video")));
  await call(openai, "versely_slideshow_to_video", { slideshow_id: "ss-1", use_edited_images: false, transition: "fade" });
  assert("slideshow_to_video can still use the bare slides", lastBody("/api/v1/slideshow/ss-1/video").use_edited_images === false);
  await call(openai, "versely_create_automated_slideshow", { prompt: "morning routine tips", num_images: 3, brand_id: "brand-1", character_id: "11111111-2222-4333-8444-555555555555" });
  const avatarBody = lastBody("/api/v1/slideshow/create-automated");
  assert("create_automated_slideshow sends the avatar and the brand's facts (not its id)", avatarBody.character_id === "11111111-2222-4333-8444-555555555555" && String(avatarBody.brand_context).includes("Name: Acme Coffee") && !("brand_id" in avatarBody), JSON.stringify(avatarBody));
  const slideOpts = textOf(await call(openai, "versely_list_slideshow_options", {}));
  assert("list_slideshow_options gives the avatar slideshow's credits per slide, not its model", slideOpts.includes('"avatar_slide_credits": 4') && !/nano banana/i.test(slideOpts), slideOpts.slice(0, 300));

  // SO1-SO6: no Bluesky link; the account limit without the upsell; the cost text; a short balance; tagging; the posting cost.
  const authTool = byName(oTools, "versely_get_social_auth_url");
  assert("get_social_auth_url no longer offers Bluesky and says how it connects", !JSON.stringify((authTool?.inputSchema.properties as Record<string, any> | undefined)?.platform?.enum).includes("bluesky") && (authTool?.description ?? "").includes("app password"), JSON.stringify((authTool?.inputSchema.properties as Record<string, any> | undefined)?.platform));
  const limitHit = await call(openai, "versely_get_social_auth_url", { platform: "pinterest" });
  assert("a full account limit is worded without the plan upsell", limitHit.isError === true && textOf(limitHit).includes("10 connected accounts") && textOf(limitHit).includes("versely_disconnect_social_account") && !/Pro includes|plan/i.test(textOf(limitHit)), textOf(limitHit));
  const pubDesc = byName(oTools, "versely_publish_post")?.description ?? "";
  assert("publish_post no longer promises 1 credit per account and points at the posting cost", !pubDesc.includes("currently 1 each") && pubDesc.includes("versely_get_posting_plan") && !/\b(plan|trial)\b/i.test(pubDesc), pubDesc);
  const shortBalance = await call(openai, "versely_publish_post", { caption: "short balance", account_ids: ["acct-db-1"], media_urls: ["https://videos.versely.studio/out/a.mp4"] });
  assert("a short balance on publish reads as credits, not as missing access", shortBalance.isError === true && textOf(shortBalance).includes("Not enough Versely credits") && !/access/i.test(textOf(shortBalance)), textOf(shortBalance));
  await call(openai, "versely_publish_post", { caption: "tagged post", account_ids: ["acct-db-1"], media_urls: ["https://videos.versely.studio/out/a.mp4"], tagging: { instagram_people: ["@friend"], youtube_tags: ["coffee"] } });
  assert("publish_post forwards tagging, and preview_post takes it too", JSON.stringify(lastBody("/api/v1/social/posts").tagging) === '{"instagram_people":["@friend"],"youtube_tags":["coffee"]}' && "tagging" in (byName(oTools, "versely_preview_post")?.inputSchema.properties ?? {}), JSON.stringify(lastBody("/api/v1/social/posts")));
  const postingPlan = JSON.parse(textOf(await call(openai, "versely_get_posting_plan", {}))) as Record<string, unknown>;
  assert("get_posting_plan gives the credits per post and the account limit, with no plan names", postingPlan.credits_per_post_per_account === 1 && postingPlan.can_connect_another === true && postingPlan.posting_costs_nothing === false && !/tier|label|standard/i.test(JSON.stringify(postingPlan)), JSON.stringify(postingPlan));

  // A1-A3: start refuses an empty queue with the next step; posts are quoted (dry run), then queued with confirm_credits; stop.
  const autoId = String(auto.id);
  const postsPath = `/api/v1/automations/${autoId}/posts`;
  const startEmpty = await call(openai, "versely_start_automation", { automation_id: autoId });
  assert("start_automation with nothing queued points at queueing posts", startEmpty.isError === true && textOf(startEmpty).includes("nothing is queued") && textOf(startEmpty).includes("versely_create_automation_posts"), textOf(startEmpty));
  const postsQuote = textOf(await call(openai, "versely_quote_automation_posts", { automation_id: autoId, count: 3 }));
  const postsQuoteBody = lastBody(postsPath);
  assert("quote_automation_posts is a dry run with the total and the days", postsQuoteBody.dry_run === true && postsQuoteBody.count === 3 && postsQuote.includes("60 credits") && postsQuote.includes("2026-11-15T09:00:00.000Z") && postsQuote.includes("confirm_credits: 60"), postsQuote);
  const realPosts = () => backend.count((r) => r.method === "POST" && r.path === postsPath && (r.body as Record<string, unknown> | undefined)?.dry_run !== true);
  const realBefore = realPosts();
  const postsStale = await call(openai, "versely_create_automation_posts", { automation_id: autoId, count: 3, confirm_credits: 40 });
  assert("create_automation_posts with a stale total is refused, nothing queued", postsStale.isError === true && textOf(postsStale).includes("now cost 60 credits") && textOf(postsStale).includes("nothing charged") && realPosts() === realBefore, textOf(postsStale));
  const postsQueued = await call(openai, "versely_create_automation_posts", { automation_id: autoId, count: 3, confirm_credits: 60 });
  const postsQueuedBody = lastBody(postsPath);
  assert("create_automation_posts queues them after the quote matches", realPosts() === realBefore + 1 && postsQueuedBody.count === 3 && postsQueuedBody.dry_run === undefined && textOf(postsQueued).includes("Queued 3 posts") && textOf(postsQueued).includes("versely_stop_automation"), textOf(postsQueued));
  assert("create_automation_posts is a confirmed, public-posting call", (byName(oTools, "versely_create_automation_posts")?.inputSchema.required ?? []).includes("confirm_credits") && hintsOfTool("versely_create_automation_posts").openWorldHint === true && hintsOfTool("versely_quote_automation_posts").readOnlyHint === true);
  const resumed = await call(openai, "versely_start_automation", { automation_id: autoId });
  assert("with posts queued, start_automation resumes them", !resumed.isError && textOf(resumed).includes("\"status\": \"active\""), textOf(resumed));
  const stopped = await call(openai, "versely_stop_automation", { automation_id: autoId });
  assert("stop_automation drops the queued posts", !stopped.isError && textOf(stopped).includes("Stopped") && backend.requests.some((r) => r.method === "POST" && r.path === `/api/v1/automations/${autoId}/stop`), textOf(stopped));
  const libraryOnly = textOf(await call(openai, "versely_quote_automation_posts", { automation_id: autoId, count: 2, schedule_posts: false }));
  assert("posts kept in the library are quoted without posting", lastBody(postsPath).schedule_posts === false && libraryOnly.includes("38 credits") && libraryOnly.includes("library only"), libraryOnly);
  await call(openai, "versely_update_automation", { automation_id: autoId, post_time: "18:30" });
  const autoPatch = (backend.requests.filter((r) => r.method === "PATCH" && r.path === `/api/v1/automations/${autoId}`).at(-1)?.body ?? {}) as Record<string, unknown>;
  assert("update_automation changes the posting time and keeps the zone", JSON.stringify(autoPatch.schedule) === '{"times":["18:30"],"timezone":"Europe/London"}' && !("config" in autoPatch), JSON.stringify(autoPatch));

  // Dubbing: the engine's name and job id stay out of what the model reads.
  const dubList = textOf(await call(openai, "versely_list_dubs", {}));
  assert("list_dubs leaves out the dubbing engine's name and job id", dubList.includes("dub-1") && !/elevenlabs|dubbing_id|el_job/i.test(dubList), dubList);
  const dubRaw = await call(full, "versely_get_dub", { project_id: "dub-2" });
  assert("get_dub's card data carries no engine name", !/elevenlabs|el_job|options/i.test(JSON.stringify(dubRaw.structuredContent)) && (dubRaw.structuredContent?.raw as Record<string, unknown> | undefined)?.id === "dub-2", JSON.stringify(dubRaw.structuredContent));
  assert("openai instructions queue slideshow posts with the quote first", instructions.includes("versely_create_automation_posts") && instructions.includes("versely_quote_automation_posts") && !instructions.includes("cost per run"), instructions.slice(0, 200));
  const hintsOf = (n: string) => (byName(oTools, n)?.annotations ?? {}) as Record<string, unknown>;
  assert("the stats reader is read-only and the refresher is not", hintsOf("versely_get_post_analytics").readOnlyHint === true && hintsOf("versely_refresh_post_analytics").readOnlyHint === false && hintsOf("versely_refresh_post_analytics").openWorldHint === true);
  assert("skip_trial (charges a card today) is destructive", (byName(fullTools, "versely_skip_trial")?.annotations as Record<string, unknown> | undefined)?.destructiveHint === true);
  assert("tools that can post publicly are destructive (ChatGPT confirms first)", ["versely_publish_post", "versely_schedule_hook_collection", "versely_run_automation_now", "versely_run_workflow", "versely_start_automation", "versely_create_slideshow_automation"].every((n) => hintsOf(n).destructiveHint === true && hintsOf(n).openWorldHint === true), JSON.stringify(["versely_publish_post", "versely_start_automation"].map(hintsOf)));
  // ChatGPT caches widget templates by URI, so its tools point at the hashed
  // card URI; claude.ai keeps the plain one.
  const uriOf = (t: AnyTool) => (t._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;
  const isCardUri = (u: string | undefined) => !!u && u.startsWith("ui://versely/media-card");
  const openaiUris = [...new Set(oTools.map(uriOf).filter(isCardUri))];
  const listedUris = (await openai.listResources()).resources.map((r) => r.uri);
  assert("ChatGPT tools point at the hashed card URI that resources/list serves", openaiUris.length === 1 && openaiUris[0]!.startsWith("ui://versely/media-card-") && listedUris.includes(openaiUris[0]!), JSON.stringify({ openaiUris, listedUris }));
  const fullUris = [...new Set(fullTools.map(uriOf).filter(isCardUri))];
  assert("claude.ai tools keep the plain card URI", fullUris.length === 1 && fullUris[0] === "ui://versely/media-card", JSON.stringify(fullUris));
  // Account: ChatGPT reads status and history; plans, checkout and the
  // subscription lifecycle are Claude-only (OpenAI's commerce rules).
  const openaiNames = new Set(oTools.map((t) => t.name));
  assert("ChatGPT gets no commerce tools", ["versely_list_plans", "versely_create_checkout_link", "versely_cancel_subscription", "versely_pause_subscription", "versely_change_plan", "versely_skip_trial"].every((n) => !openaiNames.has(n)));
  const subView = JSON.parse(textOf(await call(openai, "versely_get_subscription", {}))) as Record<string, unknown>;
  assert("get_subscription answers in plain terms", subView.plan === "Pro Monthly" && subView.status === "active" && subView.renews_at === "2026-10-24T00:00:00.000Z" && subView.billed_through === "web" && !("dodo_subscription_id" in subView), JSON.stringify(subView));
  const checkout = await call(full, "versely_create_checkout_link", { plan_key: "pro_monthly" });
  assert("create_checkout_link puts the Dodo link in the text", textOf(checkout).includes("https://checkout.dodopayments.test/session/pro_monthly") && !checkout.isError, textOf(checkout));
  // The web trial is the Weekly plan's first week for $3 (2026-11-12): nothing an
  // assistant reads may call it free, and a trial link carries what is charged.
  assert("get_subscription says on_trial, and keeps on_free_trial as the same value", subView.on_trial === false && subView.on_free_trial === false, JSON.stringify(subView));
  const WEB_TRIAL_TOOLS = ["versely_get_subscription", "versely_list_plans", "versely_create_checkout_link", "versely_skip_trial"];
  const calledFree = WEB_TRIAL_TOOLS.filter((n) => {
    const t = byName(fullTools, n);
    // "not a free trial" / "is not free" are the only places the word may sit next to the web trial.
    return !t || /free.trial/i.test([t.title ?? "", ...descriptionsOf(t)].join(" ").replace(/not a free trial/gi, "").replace(/`(on_)?free_trial`/g, ""));
  });
  assert("no billing tool calls the web trial free", calledFree.length === 0, calledFree.join(", "));
  assert("skip_trial is titled End trial now", byName(fullTools, "versely_skip_trial")?.title === "End trial now" && /^End the user's trial now and start the paid plan/.test(byName(fullTools, "versely_skip_trial")?.description ?? ""));
  const checkoutDescs = descriptionsOf(byName(fullTools, "versely_create_checkout_link")!).join(" ");
  assert(
    "create_checkout_link tells the assistant what to confirm before a trial link",
    /the first week for \$3 \(Weekly plan only\)/.test(checkoutDescs) && /confirm with the user/i.test(checkoutDescs) && /\$3 \(plus tax where it applies\) is charged at checkout and is not refunded/.test(checkoutDescs) && /and that \$9 a week follows after 7 days unless they cancel first/.test(checkoutDescs),
    checkoutDescs,
  );
  const plans = JSON.parse(textOf(await call(full, "versely_list_plans", {}))) as { subscriptions: Array<{ key: string }>; credit_packs: unknown[]; trial_offer?: Record<string, unknown>; free_trial?: Record<string, unknown> };
  assert(
    "list_plans carries the trial offer as trial_offer (and under its old name)",
    plans.subscriptions.length === 2 && plans.credit_packs.length === 1 && (plans.trial_offer?.fee as { label?: string } | undefined)?.label === "$3" && plans.trial_offer?.days === 7 &&
      JSON.stringify(plans.trial_offer?.plan_keys) === '["weekly"]' && !("success" in (plans.trial_offer ?? {})) && JSON.stringify(plans.free_trial) === JSON.stringify(plans.trial_offer),
    JSON.stringify(plans),
  );
  const trialLink = await call(full, "versely_create_checkout_link", { plan_key: "weekly", trial: true });
  const trialBody = backend.requests.filter((r) => r.path === "/api/v1/billing/checkout").at(-1)?.body as Record<string, unknown> | undefined;
  assert(
    "a trial checkout link says what is charged now and what follows",
    !trialLink.isError && trialBody?.trial === true && textOf(trialLink).includes("https://checkout.dodopayments.test/session/weekly") && /first week for \$3/.test(textOf(trialLink)) &&
      /is not refunded/.test(textOf(trialLink)) && /\$9 a week follows after 7 days/.test(textOf(trialLink)) && trialLink.structuredContent?.trial === true && !/free/i.test(textOf(trialLink)),
    textOf(trialLink),
  );
  const plainBody = backend.requests.find((r) => r.path === "/api/v1/billing/checkout" && (r.body as Record<string, unknown> | undefined)?.plan_key === "pro_monthly")?.body as Record<string, unknown> | undefined;
  assert("a plain checkout link sends no trial flag and no trial terms", !!plainBody && !("trial" in plainBody) && !/first week/.test(textOf(checkout)), JSON.stringify(plainBody));
  const trialMonthly = await call(full, "versely_create_checkout_link", { plan_key: "monthly", trial: true });
  assert("a trial on another plan is refused with the backend's reason", trialMonthly.isError === true && textOf(trialMonthly).includes("Only the Weekly plan starts with the $3 first week."), textOf(trialMonthly));
  const pack = await call(full, "versely_create_checkout_link", { plan_key: "pack_small" });
  assert("a credit pack without a subscription is refused with the reason", pack.isError === true && /subscription/i.test(textOf(pack)), textOf(pack));
  const cancelsBefore = backend.count((r) => r.path === "/api/v1/billing/subscription/cancel");
  const noSurvey = await call(full, "versely_cancel_subscription", {});
  assert("cancel_subscription needs the three survey answers", noSurvey.isError === true && backend.count((r) => r.path === "/api/v1/billing/subscription/cancel") === cancelsBefore, textOf(noSurvey));
  const cancelled = JSON.parse(textOf(await call(full, "versely_cancel_subscription", { reason: "too_expensive", improvement: "lower_price", return_intent: "maybe_later" }))) as Record<string, unknown>;
  assert("cancel_subscription reports when access ends", cancelled.access_until === "2026-10-24T00:00:00.000Z" && (cancelled.subscription as Record<string, unknown>)?.cancels_at_period_end === true, JSON.stringify(cancelled));
  assert("update_workflow_mode maps auto_post_account_ids to provider ids", JSON.stringify(wfAuto.workflow?.auto_post_account_ids) === '["spc_ext_1"]', JSON.stringify(wfAuto));

  // Every model, ranked; free_trial marks exactly the plugin-catalog (RunPod) ones.
  const fm = JSON.parse(textOf(await call(openai, "versely_find_models", {}))) as {
    on_free_trial: boolean; models: Array<{ name: string; free_trial: boolean }>; free_trial_models?: Array<{ name: string }>;
  };
  const catalogNames = new Set(PLUGIN_MODELS.map((m) => m.name));
  const fmNames = fm.models.map((m) => m.name).sort().join(",");
  assert("find_models (openai) lists every catalog model", fmNames === "Eleven Labs Speech Turbo,Flux Pro Ultra,Gemini 3.8 Flash TTS,Minimax Speech,Seedream 4 Text to Image,Sora 2,Veed Avatars,Wan 2.5 Preview", fmNames);
  assert("find_models (openai) marks free_trial exactly for the plugin-catalog models", fm.models.every((m) => m.free_trial === catalogNames.has(m.name)), JSON.stringify(fm.models));
  assert("find_models (openai) with an API key is not on the free trial", fm.on_free_trial === false && fm.free_trial_models === undefined);
  const inputs = JSON.parse(textOf(await call(openai, "versely_get_model_inputs", { model: "Wan 2.5 Preview" }))) as Record<string, unknown>;
  assert("get_model_inputs returns full params + params_by_mode", Array.isArray(inputs.params) && !!inputs.params_by_mode);
  const sora = JSON.parse(textOf(await call(openai, "versely_get_model_inputs", { model: "Sora 2" }))) as Record<string, unknown>;
  assert("get_model_inputs (openai) describes a non-trial model and marks it free_trial:false", sora.found !== false && sora.model === "Sora 2" && sora.free_trial === false, JSON.stringify(sora));
  assert("get_model_inputs (openai) marks a plugin-catalog model free_trial:true", inputs.free_trial === true);
  const voices = JSON.parse(textOf(await call(openai, "versely_list_voices", { provider: "minimax" }))) as { voices?: Array<{ id: string }> };
  assert("list_voices (openai) lists voices per provider (full catalog)", Array.isArray(voices.voices) && voices.voices.length > 0);

  // mode / poll_* / user_id stripped at call time; results shaped for ChatGPT.
  const gen = await call(openai, "versely_generate_image", { model: "Seedream 4 Text to Image", prompt: "shape-test", mode: "wait", poll_timeout_ms: 60000, user_id: "someone-else" });
  const genReq = backend.requests.find((r) => r.path === "/api/v1/generate/image" && (r.body as Record<string, unknown>)?.prompt === "shape-test");
  assert("openai forces submit mode (no wait)", gen.structuredContent?.status === "pending");
  assert("openai strips user_id / mode at call time", !!genReq && !JSON.stringify(genReq.body).includes("someone-else") && !JSON.stringify(genReq.body).includes('"mode"'));
  assert("openai sends X-Versely-Client-Profile: openai", genReq?.headers["x-versely-client-profile"] === "openai");
  assert("openai keeps toolArgs out of structuredContent", !("toolArgs" in (gen.structuredContent ?? {})) && !!(gen._meta?.["studio.versely/card"] as Record<string, unknown>)?.toolArgs);

  const pending = await call(openai, "versely_get_task_status", { request_id: "pending-1" });
  assert("raw lands in _meta for openai", !("raw" in (pending.structuredContent ?? {})) && !!(pending._meta?.["studio.versely/card"] as Record<string, unknown>)?.raw);

  // Duplicate-call guard.
  const dupArgs = { model: "Seedream 4 Text to Image", prompt: "dedupe-test" };
  const first = await call(openai, "versely_generate_image", dupArgs);
  const second = await call(openai, "versely_generate_image", dupArgs);
  const dupCount = () => backend.count((r) => r.path === "/api/v1/generate/image" && (r.body as Record<string, unknown>)?.prompt === "dedupe-test");
  assert("two identical generations reach the backend once", dupCount() === 1, `${dupCount()} requests`);
  assert("the repeat says it reused the earlier job", textOf(second).startsWith("This matches a request made") && second.structuredContent?.task_id === first.structuredContent?.task_id);
  await call(openai, "versely_generate_image", { ...dupArgs, confirm_repeat: true });
  assert("confirm_repeat: true makes a second one", dupCount() === 2, `${dupCount()} requests`);

  // Plugin-allowance refusal: backend message, remaining balance, no URL.
  const blocked = await call(openai, "versely_generate_image", { model: "Seedream 4 Text to Image", prompt: "plugin-blocked" });
  const bt = textOf(blocked);
  assert("plugin refusal relays the backend message + balance", blocked.isError === true && bt.includes("Free plugin credits don't cover this") && bt.includes("remaining: 87"), bt);
  assert("plugin refusal carries no URL and no purchase wording", !/https?:\/\//.test(bt) && !/top.?up|buy|purchase|upgrade/i.test(bt), bt);

  // Subject forwarding.
  await call(openai, "versely_get_task_status", { request_id: "subject-check" }, { meta: { "openai/subject": "chatgpt-user-abc" } });
  const subjReq = backend.requests.find((r) => r.path === "/api/v1/status/subject-check");
  assert("openai/subject is forwarded, signed", subjReq?.headers["x-versely-openai-subject"] === "chatgpt-user-abc" && subjReq.proxy.valid && subjReq.proxy.subject === "chatgpt-user-abc");
  const noSubj = backend.requests.find((r) => r.path === "/api/v1/status/pending-1");
  assert("no subject header without openai/subject", !!noSubj && noSubj.headers["x-versely-openai-subject"] === undefined);

  // ─── per-tool auth (ChatGPT plugin auth spec) ─────────────────────────────
  // The SDK client drops unknown tool keys, so securitySchemes is checked on
  // the raw tools/list; the _meta mirror survives the SDK and is checked on
  // every full-profile tool.
  const SCOPES = new Set(["generate", "post", "manage_accounts", "slideshow", "ugc", "workflows", "analytics", "read"]);
  type RawTool = { name: string; securitySchemes?: Array<{ type: string; scopes: string[] }>; _meta?: Record<string, unknown> };
  const schemeOk = (s: unknown): boolean => {
    const a = s as Array<{ type?: string; scopes?: string[] }> | undefined;
    return Array.isArray(a) && a.length === 1 && a[0].type === "oauth2" && Array.isArray(a[0].scopes) && a[0].scopes.length === 1 && SCOPES.has(a[0].scopes[0]);
  };
  const fullMetaSchemes = (fullTools as Array<{ name: string; _meta?: Record<string, unknown> }>).filter((t) => !schemeOk(t._meta?.securitySchemes));
  assert("every full-profile tool mirrors oauth2 securitySchemes in _meta", fullMetaSchemes.length === 0, fullMetaSchemes.map((t) => t.name).join(","));
  const metaScope = (n: string) => ((fullTools as Array<{ name: string; _meta?: Record<string, unknown> }>).find((t) => t.name === n)?._meta?.securitySchemes as Array<{ scopes: string[] }> | undefined)?.[0]?.scopes[0];
  const scopeCases: Record<string, string> = {
    versely_publish_post: "post", versely_generate_image: "generate", versely_get_me: "read", versely_get_post_analytics: "analytics",
    versely_create_slideshow: "slideshow", versely_run_workflow: "workflows", versely_disconnect_social_account: "manage_accounts",
    versely_list_social_accounts: "read", versely_list_slideshows: "read", versely_add_captions: "ugc",
  };
  const wrongScopes = Object.entries(scopeCases).filter(([n, s]) => metaScope(n) !== s).map(([n, s]) => `${n}=${String(metaScope(n))} (want ${s})`);
  assert("each tool names the scope that describes it", wrongScopes.length === 0, wrongScopes.join("; "));

  const rawInit = await fetch(`${MCP_URL}?profile=openai`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }),
  });
  const rawSid = rawInit.headers.get("mcp-session-id") ?? "";
  const rawList = await fetch(`${MCP_URL}?profile=openai`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": rawSid, "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const rawText = await rawList.text();
  const rawLine = rawText.trimStart().startsWith("{") ? rawText : (rawText.split("\n").find((l) => l.startsWith("data:")) ?? "data: {}").slice(5);
  const rawTools = ((JSON.parse(rawLine) as { result?: { tools?: RawTool[] } }).result?.tools ?? []);
  const rawBad = rawTools.filter((t) => !schemeOk(t.securitySchemes) || JSON.stringify(t.securitySchemes) !== JSON.stringify(t._meta?.securitySchemes));
  assert(
    `every openai tool declares securitySchemes on the wire, mirrored in _meta (${rawTools.length})`,
    rawTools.length === OPENAI_TOOLS.length && rawBad.length === 0,
    `status=${rawList.status} bad=${rawBad.map((t) => t.name).join(",")}`,
  );

  // A token the backend refuses mid-session: the result carries the OAuth
  // challenge that makes ChatGPT offer "sign in again".
  const revoked = await connect(MCP_URL, "vsk_revoked_smoke_token_value");
  const refused = (await revoked.callTool({ name: "versely_get_credits", arguments: {} })) as { isError?: boolean; _meta?: Record<string, unknown> };
  const authChallenge = refused._meta?.["mcp/www_authenticate"] as string[] | undefined;
  assert(
    "a refused token comes back with an mcp/www_authenticate challenge",
    refused.isError === true && Array.isArray(authChallenge) && /^Bearer resource_metadata="https:\/\/mcp\.versely\.studio\/\.well-known\/oauth-protected-resource", error="invalid_token", error_description="[^"]+"$/.test(authChallenge[0] ?? ""),
    JSON.stringify(refused._meta),
  );
  const okCall = (await full.callTool({ name: "versely_get_credits", arguments: {} })) as { _meta?: Record<string, unknown> };
  assert("a successful call carries no challenge", !okCall._meta?.["mcp/www_authenticate"]);
  await revoked.close();

  // ─── the plugin endpoint (/mcp/openai) ─────────────────────────────────────
  // The directory plugin's URL. ChatGPT and Codex share the directory and
  // Codex's token carries no `ck` claim, so the path itself picks the profile:
  // a plain vsk_ key here must see the plugin's tools and nothing else.
  const PLUGIN_URL = `${BASE_URL}/mcp/openai`;
  const pluginPrm = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp/openai`);
  const pluginPrmJson = (await pluginPrm.json()) as Record<string, unknown>;
  assert(
    "the plugin endpoint has its own protected-resource metadata",
    pluginPrm.status === 200 && pluginPrmJson.resource === `${RESOURCE_URL}/openai` &&
      JSON.stringify(pluginPrmJson.authorization_servers) === JSON.stringify(prmJson.authorization_servers),
    JSON.stringify(pluginPrmJson),
  );
  const pluginNoAuth = await fetch(PLUGIN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert(
    "POST /mcp/openai without auth → 401 naming the plugin endpoint's metadata",
    pluginNoAuth.status === 401 &&
      (pluginNoAuth.headers.get("www-authenticate") ?? "").includes('resource_metadata="https://mcp.versely.studio/.well-known/oauth-protected-resource/mcp/openai"'),
    pluginNoAuth.headers.get("www-authenticate") ?? "",
  );
  assert(
    "POST /mcp without auth still names the canonical metadata",
    (noAuth.headers.get("www-authenticate") ?? "").includes('resource_metadata="https://mcp.versely.studio/.well-known/oauth-protected-resource"'),
    noAuth.headers.get("www-authenticate") ?? "",
  );
  const plugin = await connect(PLUGIN_URL, TOKEN);
  const pluginTools = (await plugin.listTools()).tools as AnyTool[];
  const pluginNames = pluginTools.map((t) => t.name).sort();
  assert(
    `/mcp/openai serves exactly the ${CHATGPT_TOOLS.length} directory tools to any caller`,
    JSON.stringify(pluginNames) === JSON.stringify([...CHATGPT_TOOLS].sort()),
    `extra: ${pluginNames.filter((n) => !CHATGPT_TOOLS.includes(n)).join(", ")} missing: ${CHATGPT_TOOLS.filter((n) => !pluginNames.includes(n)).join(", ")}`,
  );
  assert("every directory tool is in the openai profile", CHATGPT_TOOLS.every((n) => OPENAI_TOOLS.includes(n)));
  const pluginInstructions = plugin.getInstructions() ?? "";
  assert("/mcp/openai carries the plugin's server instructions", pluginInstructions.length > 0);
  const directoryLead = pluginInstructions.split("\n\n")[0] ?? "";
  assert("the directory's instructions lead is <= 512 chars", directoryLead.length > 0 && directoryLead.length <= 512, `${directoryLead.length} chars`);
  const catalogChars = pluginTools.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length, 0);
  assert(
    `the directory catalog fits OpenAI's scan (<= ${CHATGPT_CATALOG_MAX_CHARS} chars)`,
    catalogChars <= CHATGPT_CATALOG_MAX_CHARS,
    `${catalogChars} chars`,
  );
  const strayNames = new Set<string>();
  for (const text of [pluginInstructions, ...pluginTools.map((t) => JSON.stringify(t))]) {
    for (const m of text.matchAll(/versely_[a-z_]+/g)) if (!CHATGPT_TOOLS.includes(m[0])) strayNames.add(m[0]);
  }
  assert("the directory names no tool outside itself", strayNames.size === 0, [...strayNames].join(", "));
  assert("every directory tool has a title and the 3 hints", pluginTools.every(hintsOk));
  assert(
    "directory schemas carry no $schema and keep required inputs",
    pluginTools.every((t) => !("$schema" in t.inputSchema)) &&
      ["clip_id", "swaps", "confirm_credits", "rights_confirmed"].every((k) => (byName(pluginTools, "versely_swap_video")?.inputSchema.required ?? []).includes(k)),
  );
  const pluginFile = byName(pluginTools, "versely_upload_media");
  const pluginFileProps = (pluginFile?.inputSchema.properties ?? {}) as Record<string, { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown }>;
  assert(
    "the directory's upload tool keeps ChatGPT's file input shape",
    JSON.stringify(pluginFile?._meta?.["openai/fileParams"]) === JSON.stringify(["file"]) &&
      ["download_url", "file_id", "mime_type", "file_name"].every((k) => k in (pluginFileProps.file?.properties ?? {})) &&
      JSON.stringify(pluginFileProps.file?.required) === JSON.stringify(["download_url", "file_id"]) &&
      pluginFileProps.file?.additionalProperties === false,
    JSON.stringify(pluginFileProps.file),
  );
  assert(
    "link-taking directory tools are open-world; pure reads are not",
    ["versely_generate_image", "versely_generate_video", "versely_generate_lipsync", "versely_prepare_remix_clip", "versely_swap_video", "versely_generate_music", "versely_slideshow_to_video"].every((n) => byName(pluginTools, n)?.annotations?.openWorldHint === true) &&
      byName(pluginTools, "versely_get_credits")?.annotations?.openWorldHint === false,
  );
  const outsideDirectory = await call(plugin, "versely_create_workflow", { name: "x" });
  assert(
    "a tool outside the directory cannot be called on /mcp/openai",
    outsideDirectory.isError === true && textOf(outsideDirectory).includes("Unknown tool"),
    textOf(outsideDirectory),
  );
  const pluginSlash = await connect(`${PLUGIN_URL}/`, TOKEN);
  assert(
    "a trailing slash on /mcp/openai/ does not widen the catalog",
    ((await pluginSlash.listTools()).tools as AnyTool[]).length === CHATGPT_TOOLS.length,
  );
  await pluginSlash.close();
  const pluginCredits = await call(plugin, "versely_get_credits", {});
  assert("a tool call works on /mcp/openai", pluginCredits.isError !== true);
  await plugin.close();
  const pluginRevoked = await connect(PLUGIN_URL, "vsk_revoked_smoke_token_value");
  const pluginRefused = (await pluginRevoked.callTool({ name: "versely_get_credits", arguments: {} })) as { isError?: boolean; _meta?: Record<string, unknown> };
  const pluginChallenge = pluginRefused._meta?.["mcp/www_authenticate"] as string[] | undefined;
  assert(
    "a refused token on /mcp/openai names the plugin endpoint's metadata",
    pluginRefused.isError === true && (pluginChallenge?.[0] ?? "").startsWith('Bearer resource_metadata="https://mcp.versely.studio/.well-known/oauth-protected-resource/mcp/openai", error="invalid_token"'),
    JSON.stringify(pluginRefused._meta),
  );
  await pluginRevoked.close();
  const pluginWrongMethod = await fetch(PLUGIN_URL, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` } });
  assert("PUT /mcp/openai → 405", pluginWrongMethod.status === 405);

  // ─── session/profile binding ───────────────────────────────────────────────
  const init = await fetch(`${MCP_URL}?profile=openai`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }),
  });
  const sid = init.headers.get("mcp-session-id") ?? "";
  const mismatch = await fetch(MCP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sid, "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert("an openai session refuses a request without the profile (403)", !!sid && mismatch.status === 403, `sid=${sid} status=${mismatch.status}`);

  // ─── ChatGPT OAuth token: ck:"openai" is sticky ───────────────────────────
  // The plugin catalog is switched off first so this client (cached under the
  // oauth key) exercises the "backend not deployed yet" fallback.
  backend.setPluginCatalog(false);
  const jwt = mintJwt(backend.url, { ck: "openai" });
  const chatgpt = await connect(`${MCP_URL}?profile=full`, jwt);
  const cTools = (await chatgpt.listTools()).tools as AnyTool[];
  assert("a ck:\"openai\" JWT gets the directory catalog even with ?profile=full", cTools.length === CHATGPT_TOOLS.length && cTools.every((t) => CHATGPT_TOOLS.includes(t.name)), `${cTools.length} tools`);
  const credits = JSON.parse(textOf(await call(chatgpt, "versely_get_credits", {}))) as Record<string, unknown>;
  assert("get_credits (openai) reports the plugin block", credits.free_account === true && credits.plugin_free_credits === 87 && credits.credits === 0, JSON.stringify(credits));
  assert("get_credits (openai) never shows trial / trial_offer", !("trial" in credits) && !("trial_offer" in credits));
  const fallback = JSON.parse(textOf(await call(chatgpt, "versely_find_models", {}))) as { on_free_trial: boolean; models: Array<{ name: string; free_trial: boolean }> };
  assert(
    "find_models for a free-trial ChatGPT user lists the free_trial models first",
    fallback.on_free_trial === true && fallback.models.slice(0, 3).every((m) => m.free_trial) && fallback.models.slice(3).every((m) => !m.free_trial),
    JSON.stringify(fallback.models),
  );
  assert(
    "find_models marks free_trial from the catalog RunPod flag when the plugin catalog 404s",
    fallback.models.length === 8 &&
      fallback.models.filter((m) => m.free_trial).map((m) => m.name).sort().join(",") === "Minimax Speech,Seedream 4 Text to Image,Wan 2.5 Preview",
    JSON.stringify(fallback.models),
  );
  backend.setPluginCatalog(true);
  const plainJwt = await connect(MCP_URL, mintJwt(backend.url, {}));
  assert("an OAuth JWT without ck gets the full profile", ((await plainJwt.listTools()).tools as AnyTool[]).length === fullTools.length);

  // Codex installs the same directory plugin but signs in from the user's
  // machine, so its token has no ck: on the plugin endpoint it still gets the
  // plugin's tools, and a canonical-audience token is accepted there.
  const codexJwt = await connect(`${BASE_URL}/mcp/openai`, mintJwt(backend.url, {}));
  const codexNames = ((await codexJwt.listTools()).tools as AnyTool[]).map((t) => t.name);
  assert(
    "an OAuth JWT without ck gets the directory catalog on /mcp/openai",
    codexNames.length === CHATGPT_TOOLS.length && codexNames.every((n) => CHATGPT_TOOLS.includes(n)),
    `got ${codexNames.length}`,
  );

  await Promise.all([full.close(), openai.close(), chatgpt.close(), plainJwt.close(), codexJwt.close()]);
  void proc;
}

/** The slow case: ChatGPT cuts a call at ~60s and calls again; the retry must JOIN. */
async function slowJoinCase(backend: FakeBackend, stderr: () => string): Promise<void> {
  await waitForListening(stderr);
  const client = await connect(`${MCP_URL}?profile=openai`, TOKEN);
  const args = { video_urls: ["https://videos.versely.studio/in/slow-a.mp4", "https://videos.versely.studio/in/b.mp4"] };
  const firstCall = call(client, "versely_merge_videos", args, { timeoutMs: 120_000 });
  await new Promise((r) => setTimeout(r, 2_000));
  const secondCall = call(client, "versely_merge_videos", args, { timeoutMs: 120_000 });
  const [a, b] = await Promise.all([firstCall, secondCall]);
  const merges = backend.count((r) => r.path === "/api/v1/features/merge-videos");
  assert("a 70s delayed response is joined, not re-run", merges === 1, `${merges} merge requests`);
  assert("both callers get the finished video", a.structuredContent?.status === "completed" && JSON.stringify(a.structuredContent?.assets) === JSON.stringify(b.structuredContent?.assets));
  assert("the joined call says it reused the running job", textOf(b).startsWith("This matches a request made"));
  await client.close();
}

function waitForListening(stderr: () => string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((res, rej) => {
    const tick = () => {
      if (stderr().includes('"http_listening"')) return res();
      if (Date.now() > deadline) return rej(new Error("server never started listening"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main(): Promise<void> {
  const backend = await startFakeBackend({ secret: SECRET });
  const proc: ChildProcess = spawn(process.execPath, [dist], {
    env: {
      ...process.env,
      MCP_HTTP_PORT: PORT,
      MCP_HTTP_HOST: HOST,
      VERSELY_API_URL: backend.url,
      OAUTH_JWT_SECRET: SECRET,
      MCP_RESOURCE_URL: RESOURCE_URL,
      MCP_ADMIN_TOKEN: ADMIN_TOKEN,
      // Keep the server from fetching preview bytes from the real CDN.
      VERSELY_INLINE_IMAGE_PREVIEW: "false",
      MCP_ENABLE_DEBUG_TOOLS: "",
      MCP_DEDUPE_PROFILES: "openai",
      MCP_CARD_V2_PROFILES: "openai",
      // The upload tool fetches from the fake backend on 127.0.0.1; its
      // address guard is checked in-process instead (see "Uploads").
      MCP_UPLOAD_FETCH_GUARD: "off-for-smoke-test",
      // One room set in the fake backend never answers: the tool gives up waiting quickly here.
      VERSELY_ROOMS_WAIT_MS: "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });
  proc.on("exit", (code) => {
    if (code !== null && code !== 0) process.stderr.write(`server exited unexpectedly with code ${code}\n${stderrBuf}\n`);
  });

  const finish = async (err?: unknown) => {
    proc.kill();
    await backend.close();
    if (err) {
      process.stderr.write(`Smoke test crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.stderr.write(`server stderr:\n${stderrBuf}\n`);
      process.exit(1);
    }
    if (failures.length > 0) {
      process.stdout.write(`\n${failures.length} failure(s):\n  - ${failures.join("\n  - ")}\n`);
      process.exit(1);
    }
    process.stdout.write(`\nAll smoke tests passed.\n`);
    process.exit(0);
  };

  try {
    const slow = slowJoinCase(backend, () => stderrBuf);
    await run(backend, proc, () => stderrBuf);
    await slow;
    await finish();
  } catch (err) {
    await finish(err);
  }
}

void main();
