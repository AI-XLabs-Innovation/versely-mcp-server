import type { ToolContext, ToolResult } from "./_types.js";
import {
  VerselyApiError,
  VerselyConfigError,
  VerselyNetworkError,
  VerselyTimeoutError,
} from "../errors.js";

export function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function formatErr(err: unknown): string {
  if (
    err instanceof VerselyApiError ||
    err instanceof VerselyTimeoutError ||
    err instanceof VerselyNetworkError ||
    err instanceof VerselyConfigError
  ) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function resolveUserId(
  ctx: ToolContext,
  provided?: string,
): Promise<string> {
  if (provided) return provided;
  return ctx.client.getCurrentUserId();
}
