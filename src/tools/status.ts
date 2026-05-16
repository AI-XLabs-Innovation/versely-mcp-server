import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult, mediaResult, extractMediaAssets } from "./_helpers.js";
import { pollStatus } from "../poller.js";
import { metaForMediaCard } from "../ui/templates.js";

/**
 * Coerce a backend status payload to a discrete state. The backend's status
 * endpoint returns a variety of shapes across providers; we map them to
 * `pending` / `completed` / `failed` so the iframe poll loop can decide
 * whether to stop or keep going.
 */
function classifyStatus(data: unknown): "pending" | "completed" | "failed" {
  if (!data || typeof data !== "object") return "pending";
  const obj = data as Record<string, unknown>;
  const status =
    (typeof obj.status === "string" ? obj.status : undefined) ??
    (typeof obj.state === "string" ? obj.state : undefined);
  if (typeof status === "string") {
    const s = status.toLowerCase();
    if (s === "completed" || s === "complete" || s === "success" || s === "succeeded" || s === "done") {
      return "completed";
    }
    if (s === "failed" || s === "failure" || s === "error" || s === "cancelled" || s === "canceled") {
      return "failed";
    }
  }
  // No explicit status — infer from presence of asset URLs.
  if (extractMediaAssets(data).length > 0) return "completed";
  return "pending";
}

const versely_get_task_status = defineTool({
  name: "versely_get_task_status",
  description:
    "Get the current status of an async generation task by request_id (single, non-blocking lookup). When the task is complete and has produced media, the result also hydrates the inline media card.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    request_id: z
      .string()
      .describe("The request_id / task_id returned by a generation tool."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/status/${encodeURIComponent(input.request_id)}`,
    );
    const state = classifyStatus(data);

    if (state === "completed") {
      // mediaResult will walk for asset URLs and build the completed payload.
      // The iframe poll loop merges this back into the original card state.
      return mediaResult(
        { request_id: input.request_id, outcome: "completed", data },
        { extra: { task_id: input.request_id, status: "completed" } },
      );
    }

    if (state === "failed") {
      const errMsg =
        (data && typeof data === "object" && (data as Record<string, unknown>).error) ||
        "Task failed.";
      return {
        content: [{ type: "text", text: `Task ${input.request_id} failed: ${String(errMsg)}` }],
        structuredContent: {
          status: "failed",
          task_id: input.request_id,
          error: String(errMsg),
          raw: data,
        },
        isError: true,
      };
    }

    // Still pending — surface progress so the iframe can update its UI in
    // place without re-rendering the whole card.
    const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const progress =
      typeof obj.progress === "number"
        ? obj.progress
        : typeof obj.percent === "number"
          ? obj.percent
          : undefined;
    return {
      content: [{ type: "text", text: `Task ${input.request_id} still pending.` }],
      structuredContent: {
        status: "pending",
        task_id: input.request_id,
        ...(progress !== undefined ? { progress } : {}),
        raw: data,
      },
    };
  },
});

const versely_wait_for_task = defineTool({
  name: "versely_wait_for_task",
  description:
    "Block and poll a request_id until it reaches a terminal state (completed/failed) or the timeout elapses.",
  inputSchema: z.object({
    request_id: z.string().describe("The request_id / task_id to wait on."),
    poll_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Override default poll timeout in ms."),
    poll_interval_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Override default poll interval in ms."),
  }),
  handler: async (input, ctx) => {
    const outcome = await pollStatus(ctx.client, input.request_id, {
      timeoutMs: input.poll_timeout_ms ?? ctx.config.defaultPollTimeoutMs,
      intervalMs: input.poll_interval_ms ?? ctx.config.defaultPollIntervalMs,
      signal: ctx.signal,
    });
    const payload = {
      request_id: input.request_id,
      outcome: outcome.kind,
      ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
      data: outcome.data,
    };
    // Route completed results through mediaResult so the response shape is
    // normalized (slim text + structuredContent) regardless of which provider
    // serviced the underlying generation. Failed / aborted outcomes stay as
    // raw JSON since there's no asset to render.
    return outcome.kind === "completed" ? mediaResult(payload) : jsonResult(payload);
  },
});

export const statusTools: Tool[] = [versely_get_task_status, versely_wait_for_task];
