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

export function pickRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of [
    "requestId",
    "request_id",
    "taskId",
    "task_id",
    "jobId",
    "job_id",
    "id",
  ]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const data = obj["data"];
  if (data && typeof data === "object") return pickRequestId(data);
  return undefined;
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
    return mediaResult(payload, { template: args.template });
  }
  return jsonResult(payload);
}
