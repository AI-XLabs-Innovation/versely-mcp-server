import type { z } from "zod";
import type { VerselyClient } from "../client.js";
import type { Config } from "../config.js";
import type { Profile } from "../profiles.js";

export interface ToolContext {
  client: VerselyClient;
  config: Config;
  signal?: AbortSignal;
  /** Tool profile this call is served under (see profiles.ts). */
  profile: Profile;
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
  /**
   * Per-MCP-Apps (SEP-1865): a JSON object hydrated into the linked
   * `ui://` resource via postMessage. claude.ai keeps it from the model;
   * ChatGPT shows it to BOTH the model and the card, which is why the openai
   * profile keeps it small and moves the bulk into `_meta` (server.ts).
   */
  structuredContent?: Record<string, unknown>;
  /**
   * Result-level `_meta`. Reaches the card but not the model on hosts that
   * separate the two (ChatGPT). The media card reads
   * `_meta["studio.versely/card"]` merged under structuredContent.
   */
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * How a tool looks and behaves in a non-default profile. Anything omitted
 * falls back to the base definition.
 */
export interface ProfileVariant {
  description?: string;
  /** Replaces the base schema (and must then come with its own handler). */
  inputSchema?: z.ZodTypeAny;
  handler?: (input: any, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Top-level inputs removed from this profile's schema AND stripped from
   * incoming arguments, so the backend default applies. Used for model pickers
   * that could only ever name models this profile must not show.
   */
  hide?: readonly string[];
  /**
   * Inputs kept although OPENAI_STRIPPED_INPUTS names them: a tool whose own
   * setting shares a name with the submit/wait switch (update_workflow_mode's
   * `mode` is manual | auto, and stripping it made the tool unusable).
   */
  keep?: readonly string[];
  /**
   * Replacement descriptions, keyed by property path in the input schema:
   * "model", or "scenes[].model" for a property of an array's items.
   */
  params?: Readonly<Record<string, string>>;
}

export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
  /**
   * Optional MCP `_meta`. For MCP Apps inline rendering, `ui.resourceUri`
   * points at a registered `ui://` resource (see metaForMediaCard).
   */
  meta?: Record<string, unknown>;
  handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
  /** The ChatGPT-plugin (openai profile) variant, when it differs. */
  openai?: ProfileVariant;
}

/**
 * Identity helper that preserves strong typing of the handler input at definition time
 * but returns the widened `Tool` (= `Tool<ZodTypeAny>`), so tools can be collected into
 * arrays without Zod's invariant generics getting in the way.
 */
export function defineTool<TSchema extends z.ZodTypeAny>(tool: Tool<TSchema>): Tool {
  return tool as unknown as Tool;
}

/** Same idea for a profile variant that brings its own schema + handler. */
export function defineVariant<TSchema extends z.ZodTypeAny>(variant: {
  description?: string;
  inputSchema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
  hide?: readonly string[];
  params?: Readonly<Record<string, string>>;
}): ProfileVariant {
  return variant as unknown as ProfileVariant;
}
