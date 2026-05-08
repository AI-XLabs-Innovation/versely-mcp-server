// Smoke test: spawn the built MCP server in HTTP mode, run a JSON-RPC handshake
// over Streamable HTTP, and assert basic correctness. No real backend calls — uses
// a placeholder vsk_ token (only validation paths exercise the auth gate).
// Exits non-zero on any failure. Run via `npm run smoke`.

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fetch } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const dist = resolve(process.cwd(), "dist", "index.js");
const PORT = String(20000 + Math.floor(Math.random() * 10000));
const HOST = "127.0.0.1";
const TOKEN = "vsk_smoke_test_placeholder_value";
const BASE_URL = `http://${HOST}:${PORT}`;
const MCP_URL = `${BASE_URL}/mcp`;

const proc: ChildProcess = spawn(process.execPath, [dist], {
  env: {
    ...process.env,
    MCP_HTTP_PORT: PORT,
    MCP_HTTP_HOST: HOST,
    VERSELY_API_URL: "https://api.versely.studio",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderrBuf = "";
proc.stderr?.on("data", (chunk: Buffer) => {
  stderrBuf += chunk.toString();
});

proc.on("exit", (code) => {
  if (code !== null && code !== 0) {
    process.stderr.write(`server exited unexpectedly with code ${code}\n${stderrBuf}\n`);
  }
});

function waitForListening(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((res, rej) => {
    const tick = () => {
      if (stderrBuf.includes('"http_listening"')) return res();
      if (Date.now() > deadline) return rej(new Error("server never started listening"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

async function run(): Promise<void> {
  await waitForListening();

  // -------- health endpoint --------
  const healthRes = await fetch(`${BASE_URL}/healthz`);
  const health = (await healthRes.json()) as Record<string, unknown>;
  assert("GET /healthz returns 200", healthRes.status === 200);
  assert("health reports server name", health.server === "versely-mcp");
  assert(
    "health reports tools count",
    typeof health.tools === "number" && (health.tools as number) >= 50,
  );

  // -------- root landing --------
  const rootRes = await fetch(`${BASE_URL}/`);
  assert("GET / returns 200", rootRes.status === 200);

  // -------- auth gate failures --------
  const noAuth = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert("POST /mcp without auth → 401", noAuth.status === 401);

  const badAuth = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Token abc123" },
    body: "{}",
  });
  assert("POST /mcp with non-Bearer auth → 401", badAuth.status === 401);

  const badToken = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer not_a_vsk_key" },
    body: "{}",
  });
  assert("POST /mcp with malformed vsk_ → 401", badToken.status === 401);

  const wrongMethod = await fetch(MCP_URL, { method: "GET" });
  assert("GET /mcp → 405", wrongMethod.status === 405);

  // -------- MCP handshake via SDK client --------
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  assert("SDK client connects (initialize succeeds)", true);

  const tools = await client.listTools();
  assert("tools/list returns >= 50 tools", tools.tools.length >= 50, `got ${tools.tools.length}`);

  const names = tools.tools.map((t) => t.name);
  const dups = names.filter((n, i) => names.indexOf(n) !== i);
  assert("tool names are unique", dups.length === 0, dups.join(", "));

  const namePattern = /^versely_[a-z0-9_]+$/;
  const badNames = names.filter((n) => !namePattern.test(n));
  assert("tool names match versely_snake_case", badNames.length === 0, badNames.join(", "));

  const badSchemas = tools.tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object");
  assert("every tool has object inputSchema", badSchemas.length === 0, `${badSchemas.length} bad`);

  for (const required of [
    "versely_get_me",
    "versely_find_models",
    "versely_list_models",
    "versely_generate_image",
    "versely_create_movie",
    "versely_publish_post",
    "versely_get_task_status",
  ]) {
    assert(`tool present: ${required}`, names.includes(required));
  }

  // -------- find_models schema sanity --------
  const findModels = tools.tools.find((t) => t.name === "versely_find_models");
  if (findModels) {
    const props = (findModels.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const expectedFields = ["type", "q", "provider", "category", "is_featured", "is_premium", "limit"];
    const missing = expectedFields.filter((f) => !(f in props));
    assert(
      "versely_find_models exposes expected fields",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : undefined,
    );
  }

  // -------- tools/call: unknown name --------
  const unknown = await client.callTool({ name: "definitely_not_a_real_tool", arguments: {} });
  assert("unknown tool returns isError", unknown.isError === true);

  // -------- tools/call: invalid args --------
  const invalidArgs = await client.callTool({
    name: "versely_generate_image",
    arguments: { model: 123 },
  });
  const firstContent = Array.isArray(invalidArgs.content) ? invalidArgs.content[0] : undefined;
  const firstText =
    firstContent && typeof firstContent === "object" && "text" in firstContent
      ? String((firstContent as { text: unknown }).text ?? "")
      : "";
  assert(
    "invalid arguments return isError",
    invalidArgs.isError === true && firstText.toLowerCase().includes("invalid"),
  );

  await client.close();
}

run()
  .then(() => {
    proc.kill();
    if (failures.length > 0) {
      process.stdout.write(`\n${failures.length} failure(s):\n  - ${failures.join("\n  - ")}\n`);
      process.exit(1);
    }
    process.stdout.write(`\nAll smoke tests passed.\n`);
    process.exit(0);
  })
  .catch((err) => {
    proc.kill();
    process.stderr.write(`Smoke test crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`server stderr:\n${stderrBuf}\n`);
    process.exit(1);
  });
