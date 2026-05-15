import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import { pollStatus } from "../poller.js";

const versely_get_task_status = defineTool({
  name: "versely_get_task_status",
  description:
    "Get the current status of an async generation task by request_id (single, non-blocking lookup).",
  inputSchema: z.object({
    request_id: z
      .string()
      .describe("The request_id / task_id returned by a generation tool."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/status/${encodeURIComponent(input.request_id)}`,
    );
    return jsonResult(data);
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
