import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SERVER_NAME, SERVER_VERSION, type Config } from "./config.js";
import type { VerselyClient } from "./client.js";
import { ToolRegistry } from "./tools/_registry.js";
import { allTools } from "./tools/index.js";
import { errorResult, formatErr } from "./tools/_helpers.js";
import type { ToolContext } from "./tools/_types.js";
import { UI_MIME_TYPE, UI_RESOURCES, getUiResource } from "./ui/templates.js";

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
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: sharedRegistry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, {
        $refStrategy: "none",
        target: "jsonSchema7",
      }) as { type: "object"; [k: string]: unknown },
      // MCP Apps (SEP-1865): if the tool declares a UI template, surface its
      // `_meta` so the host can fetch the linked `ui://` resource and render
      // it inline. Hosts without MCP Apps support ignore this field.
      ...(t.meta ? { _meta: t.meta } : {}),
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
      // ToolResult.structuredContent flows through unchanged — the SDK's
      // CallToolResult schema accepts it natively, and MCP Apps-capable
      // hosts hydrate the linked ui:// iframe with that payload.
      return (await tool.handler(parsed.data, ctx)) as CallToolResult;
    } catch (err) {
      return errorResult(formatErr(err)) as CallToolResult;
    }
  });

  // MCP Apps: expose `ui://` resources as a discoverable list. Hosts call
  // resources/list during initialization, then resources/read on the URI
  // declared in a tool's `_meta.ui.resourceUri`. The resource's own _meta
  // carries `ui.csp` (and `ui.permissions` if needed) per spec.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: UI_RESOURCES.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: UI_MIME_TYPE,
      _meta: r.meta,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const resource = getUiResource(uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: UI_MIME_TYPE,
          text: resource.html,
          _meta: resource.meta,
        },
      ],
    };
  });

  return server;
}
