import type { z } from "zod";
import type { VerselyClient } from "../client.js";
import type { Config } from "../config.js";

export interface ToolContext {
  client: VerselyClient;
  config: Config;
  signal?: AbortSignal;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; text: string };
    };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Identity helper that preserves strong typing of the handler input at definition time
 * but returns the widened `Tool` (= `Tool<ZodTypeAny>`), so tools can be collected into
 * arrays without Zod's invariant generics getting in the way.
 */
export function defineTool<TSchema extends z.ZodTypeAny>(tool: Tool<TSchema>): Tool {
  return tool as unknown as Tool;
}
