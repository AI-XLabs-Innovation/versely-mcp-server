import { z } from "zod";
import type { ToolContext, ToolResult } from "./_types.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import type { UiTemplate } from "../ui/templates.js";
import { pollStatus } from "../poller.js";

export type AsyncMode = "wait" | "submit";

export const ModeSchema = z
  .enum(["wait", "submit"])
  .default("wait")
  .describe(
    "'wait' (default) blocks and polls until completion; 'submit' returns the request_id immediately so the caller can poll later via versely_get_task_status.",
  );

export const AsyncFields = {
  mode: ModeSchema,
  poll_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override default poll timeout in ms (only used when mode='wait')."),
  poll_interval_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override default poll interval in ms (only used when mode='wait')."),
};

const REQUEST_ID_KEYS = [
  "requestId",
  "request_id",
  "taskId",
  "task_id",
  "jobId",
  "job_id",
  "recordId",
  "record_id",
  "id",
] as const;

// Containers that wrap the polling handle. Dispatchers vary wildly:
// fal → `data.taskId`, Kie/GPT-Image-2 → `data[0].taskId`, some adapters
// → `response.data.taskId`. Drill into all of them.
const REQUEST_ID_CONTAINERS = ["data", "response", "result"] as const;

/**
 * Walk a provider response shape looking for a polling handle. Returns the
 * first canonical-key match found in a depth-first walk through objects,
 * arrays, and the known wrapper containers.
 */
export function pickRequestId(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  const visit = (v: unknown): string | undefined => {
    if (v == null || typeof v !== "object") return undefined;
    if (seen.has(v as object)) return undefined;
    seen.add(v as object);

    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = visit(item);
        if (hit) return hit;
      }
      return undefined;
    }

    const obj = v as Record<string, unknown>;
    for (const key of REQUEST_ID_KEYS) {
      const candidate = obj[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
    for (const containerKey of REQUEST_ID_CONTAINERS) {
      const hit = visit(obj[containerKey]);
      if (hit) return hit;
    }
    return undefined;
  };
  return visit(value);
}

export async function handleAsync(args: {
  ctx: ToolContext;
  submitResponse: unknown;
  mode: AsyncMode;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * UI template to bind on the completed-result path. If omitted, mediaResult
   * infers one from the asset kinds. Submit-mode and failure paths emit plain
   * JSON regardless (no media yet).
   */
  template?: UiTemplate;
  /**
   * Extra fields to echo into the completed result's `structuredContent`
   * (e.g. `model`, `prompt`). Surfaces metadata that hosts and the LLM can
   * read on the next turn without re-parsing the raw provider payload.
   */
  extra?: Record<string, unknown>;
}): Promise<ToolResult> {
  const requestId = pickRequestId(args.submitResponse);

  if (args.mode === "submit" || !requestId) {
    return jsonResult({
      mode: args.mode,
      ...(requestId ? { request_id: requestId } : {}),
      submission: args.submitResponse,
      hint: requestId
        ? `Use versely_get_task_status (or versely_wait_for_task) with request_id "${requestId}" to check progress.`
        : "No request_id detected — operation may have completed synchronously, or uses a domain-specific status endpoint.",
    });
  }

  const outcome = await pollStatus(args.ctx.client, requestId, {
    timeoutMs: args.pollTimeoutMs ?? args.ctx.config.defaultPollTimeoutMs,
    intervalMs: args.pollIntervalMs ?? args.ctx.config.defaultPollIntervalMs,
    signal: args.ctx.signal,
  });

  const payload = {
    mode: "wait" as const,
    request_id: requestId,
    outcome: outcome.kind,
    ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
    data: outcome.data,
  };

  if (outcome.kind === "completed") {
    return mediaResult(payload, {
      template: args.template,
      extra: { ...(args.extra ?? {}), request_id: requestId },
    });
  }
  return jsonResult(payload);
}
