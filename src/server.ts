import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SERVER_NAME, SERVER_VERSION, type Config } from "./config.js";
import { VerselyClient } from "./client.js";
import { ToolRegistry } from "./tools/_registry.js";
import { allTools } from "./tools/index.js";
import { errorResult, formatErr } from "./tools/_helpers.js";
import type { ToolContext } from "./tools/_types.js";

export async function startServer(config: Config): Promise<void> {
  const client = new VerselyClient(config);
  const registry = new ToolRegistry();
  registry.registerMany(allTools);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, {
        $refStrategy: "none",
        target: "openApi3",
      }) as { type: "object"; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const tool = registry.get(name);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[${SERVER_NAME}] ready (v${SERVER_VERSION}, api=${config.apiUrl}, tools=${registry.size()})\n`,
  );
}
