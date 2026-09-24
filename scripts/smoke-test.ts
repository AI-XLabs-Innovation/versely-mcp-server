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
  "versely_get_post", "versely_update_post", "versely_delete_post",
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
  "versely_generate_sound_effect",
];

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
  assert("openai-apps-challenge 404 while the token is empty", challenge.status === 404);
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
  for (const target of ["versely_get_movie_status", "versely_get_dub", "versely_get_workflow_run", "versely_get_video_workflow_run"]) {
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
  for (const target of ["versely_get_task_status", "versely_get_movie_status", "versely_get_dub"]) {
    const m = (byName(oTools, target) as { _meta?: Record<string, unknown> } | undefined)?._meta ?? {};
    assert(`openai ${target} is widgetAccessible for the card`, m["openai/widgetAccessible"] === true);
  }
  for (const target of ["versely_get_movie_status", "versely_get_dub"]) {
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

  const oResources = await openai.listResources();
  const oCard = await openai.readResource({ uri: "ui://versely/media-card" });
  const oMeta = (oCard.contents[0]?._meta ?? {}) as { ui?: Record<string, unknown> };
  const oListMeta = ((oResources.resources[0]?._meta ?? {}) as { ui?: Record<string, unknown> }).ui ?? {};
  assert("openai resource has ui.domain", oMeta.ui?.domain === "https://mcp.versely.studio" && oListMeta.domain === "https://mcp.versely.studio");
  assert("openai resource sets prefersBorder explicitly", oMeta.ui?.prefersBorder === false);
  assert("openai profile serves the v2 card", String((oCard.contents[0] as { text?: string }).text ?? "").includes("version: '2.0.0'"));

  const outOfProfile = await call(openai, "versely_list_api_key_scopes", {});
  assert("out-of-profile call is refused", outOfProfile.isError === true && textOf(outOfProfile).includes("Unknown tool"));

  // Social posting: the connect link is in the text, publish hands back
  // Versely's own post id, and a re-sent publish never posts twice.
  const link = await call(openai, "versely_get_social_auth_url", { platform: "twitter" });
  assert("get_social_auth_url puts the connect link in the text", textOf(link).includes("https://connect.postforme.test/x?state=abc") && !link.isError, textOf(link));
  assert("openai hides get_social_auth_url.redirect_url", !("redirect_url" in (byName(oTools, "versely_get_social_auth_url")?.inputSchema.properties ?? {})));
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
    name: "Daily fitness", every_minutes: 1440, category: "fitness", model: "Flux Pro Ultra", post_account_ids: ["acct-db-1"],
  }))) as { id?: string; config?: Record<string, unknown>; interval_seconds?: number; status?: string };
  assert("create_slideshow_automation maps account ids to provider ids", JSON.stringify(auto.config?.post_account_ids) === '["spc_ext_1"]' && auto.config?.source === "ai", JSON.stringify(auto));
  assert("create_slideshow_automation sends the schedule in seconds and starts paused", auto.interval_seconds === 86400 && auto.status === "paused", JSON.stringify(auto));
  const edited = JSON.parse(textOf(await call(openai, "versely_update_automation", { automation_id: String(auto.id), num_images: 8 }))) as { config?: Record<string, unknown> };
  assert("update_automation merges into the stored settings", edited.config?.num_images === 8 && edited.config?.category === "fitness" && JSON.stringify(edited.config?.post_account_ids) === '["spc_ext_1"]', JSON.stringify(edited));
  const badAcct = await call(openai, "versely_create_slideshow_automation", { name: "x", every_minutes: 60, category: "fitness", model: "Flux Pro Ultra", post_account_ids: ["nope"] });
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
  assert("update_workflow_mode maps auto_post_account_ids to provider ids", JSON.stringify(wfAuto.workflow?.auto_post_account_ids) === '["spc_ext_1"]', JSON.stringify(wfAuto));

  // Every model, ranked; free_trial marks exactly the plugin-catalog (RunPod) ones.
  const fm = JSON.parse(textOf(await call(openai, "versely_find_models", {}))) as {
    on_free_trial: boolean; models: Array<{ name: string; free_trial: boolean }>; free_trial_models?: Array<{ name: string }>;
  };
  const catalogNames = new Set(PLUGIN_MODELS.map((m) => m.name));
  const fmNames = fm.models.map((m) => m.name).sort().join(",");
  assert("find_models (openai) lists every catalog model", fmNames === "Eleven Labs Speech Turbo,Flux Pro Ultra,Gemini 3.8 Flash TTS,Minimax Speech,Seedream 4 Text to Image,Sora 2,Wan 2.5 Preview", fmNames);
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
  assert("a ck:\"openai\" JWT gets the openai profile even with ?profile=full", cTools.length === OPENAI_TOOLS.length && !cTools.some((t) => t.name === "versely_list_api_key_scopes"), `${cTools.length} tools`);
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
    fallback.models.length === 7 &&
      fallback.models.filter((m) => m.free_trial).map((m) => m.name).sort().join(",") === "Minimax Speech,Seedream 4 Text to Image,Wan 2.5 Preview",
    JSON.stringify(fallback.models),
  );
  backend.setPluginCatalog(true);
  const plainJwt = await connect(MCP_URL, mintJwt(backend.url, {}));
  assert("an OAuth JWT without ck gets the full profile", ((await plainJwt.listTools()).tools as AnyTool[]).length === fullTools.length);

  await Promise.all([full.close(), openai.close(), chatgpt.close(), plainJwt.close()]);
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
