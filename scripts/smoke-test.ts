// Smoke test: spawn the built MCP server, run a JSON-RPC handshake over stdio,
// and assert basic correctness. No real backend calls — uses a placeholder API key.
// Exits non-zero on any failure. Run via `npm run smoke`.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const dist = resolve(process.cwd(), "dist", "index.js");

const proc = spawn(process.execPath, [dist], {
  env: {
    ...process.env,
    VERSELY_API_KEY: "vsk_smoke_test_placeholder",
    VERSELY_API_URL: "https://api.versely.studio",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
const messages: JsonRpcMessage[] = [];

proc.stdout.on("data", (chunk: Buffer) => {
  stdoutBuf += chunk.toString();
  let nl: number;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line) as JsonRpcMessage);
    } catch {
      /* ignore malformed lines */
    }
  }
});

let stderrBuf = "";
proc.stderr.on("data", (chunk: Buffer) => {
  stderrBuf += chunk.toString();
});

function send(msg: JsonRpcMessage): void {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((res, rej) => {
    const tick = () => {
      if (predicate()) return res();
      if (Date.now() > deadline) return rej(new Error("waitFor timeout"));
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
  await waitFor(() => stderrBuf.includes("ready"), 3000).catch(() => {
    throw new Error(`Server never printed "ready". stderr:\n${stderrBuf}`);
  });

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    },
  });
  await waitFor(() => messages.some((m) => m.id === 1));
  const init = messages.find((m) => m.id === 1)!;
  const initResult = init.result as { serverInfo?: { name: string; version: string } } | undefined;
  assert("initialize returns serverInfo", !!initResult?.serverInfo, JSON.stringify(init.error));
  assert(
    "server identifies as versely-mcp",
    initResult?.serverInfo?.name === "versely-mcp",
    `got "${initResult?.serverInfo?.name}"`,
  );

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await waitFor(() => messages.some((m) => m.id === 2));
  const list = messages.find((m) => m.id === 2)!;
  const tools = (list.result as { tools?: Array<{ name: string; inputSchema?: { type?: string } }> } | undefined)?.tools ?? [];
  assert("tools/list returns >= 50 tools", tools.length >= 50, `got ${tools.length}`);

  const names = tools.map((t) => t.name);
  const dups = names.filter((n, i) => names.indexOf(n) !== i);
  assert("tool names are unique", dups.length === 0, `duplicates: ${dups.join(", ")}`);

  const namePattern = /^versely_[a-z0-9_]+$/;
  const badNames = names.filter((n) => !namePattern.test(n));
  assert("tool names match versely_snake_case", badNames.length === 0, badNames.join(", "));

  const badSchemas = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object");
  assert("every tool has object inputSchema", badSchemas.length === 0, `${badSchemas.length} bad`);

  for (const required of [
    "versely_get_me",
    "versely_generate_image",
    "versely_create_movie",
    "versely_publish_post",
    "versely_get_task_status",
  ]) {
    assert(`tool present: ${required}`, names.includes(required));
  }

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "definitely_not_a_real_tool", arguments: {} },
  });
  await waitFor(() => messages.some((m) => m.id === 3));
  const errCall = messages.find((m) => m.id === 3)!;
  const errResult = errCall.result as { isError?: boolean } | undefined;
  assert("unknown tool returns isError", errResult?.isError === true, JSON.stringify(errCall));

  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "versely_generate_image", arguments: { model: 123 } },
  });
  await waitFor(() => messages.some((m) => m.id === 4));
  const validationCall = messages.find((m) => m.id === 4)!;
  const valRes = validationCall.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  assert(
    "invalid arguments return isError",
    valRes?.isError === true && (valRes.content?.[0]?.text ?? "").toLowerCase().includes("invalid"),
    JSON.stringify(validationCall),
  );
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
