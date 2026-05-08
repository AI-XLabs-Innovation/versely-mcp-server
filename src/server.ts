import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SERVER_NAME, SERVER_VERSION, type Config } from "./config.js";
import type { VerselyClient } from "./client.js";
import { ToolRegistry } from "./tools/_registry.js";
import { allTools } from "./tools/index.js";
import { errorResult, formatErr } from "./tools/_helpers.js";
import type { ToolContext } from "./tools/_types.js";

const sharedRegistry = (() => {
  const r = new ToolRegistry();
  r.registerMany(allTools);
  return r;
})();

export function getRegisteredToolCount(): number {
  return sharedRegistry.size();
}

/**
 * Build a fresh MCP `Server` wired to a request-scoped Versely client.
 * Each HTTP request constructs its own server (cheap — just attaches handlers)
 * so the per-user `vsk_` API key stays scoped to that request.
 */
export function buildServer(config: Config, client: VerselyClient): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: sharedRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, {
        $refStrategy: "none",
        target: "jsonSchema7",
      }) as { type: "object"; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const tool = sharedRegistry.get(name);
    if (!tool) {
      return errorResult(`Unknown tool: ${name}`) as CallToolResult;
    }
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return errorResult(
        `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      ) as CallToolResult;
    }
    const ctx: ToolContext = { client, config };
    try {
      return (await tool.handler(parsed.data, ctx)) as CallToolResult;
    } catch (err) {
      return errorResult(formatErr(err)) as CallToolResult;
    }
  });

  return server;
}
