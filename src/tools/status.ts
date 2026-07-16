import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult, mediaResult, extractMediaAssets } from "./_helpers.js";
import { pollStatus } from "../poller.js";
import {
  metaForMediaCard,
  buildMediaCardPayload,
  type MediaKind,
} from "../ui/templates.js";
import type { ToolResult } from "./_types.js";

/**
 * The status endpoint reports which generation table the record came from as
 * `type` ("images" | "videos" | "audios" | "music"). That is authoritative —
 * far better than re-deriving the kind from asset URLs, which guesses off a
 * file extension and silently mis-renders when a URL is extensionless, signed,
 * or accompanied by a poster thumbnail (a video + its thumbnail infers as a
 * mixed "gallery" and lands in the image grid, where a video renders as a
 * broken <img>).
 */
function kindFromStatusType(data: unknown): MediaKind | undefined {
  const t = (data as Record<string, unknown> | null)?.type;
  if (typeof t !== "string") return undefined;
  switch (t.toLowerCase()) {
    case "images":
    case "image":
      return "image";
    case "videos":
    case "video":
      return "video";
    case "audios":
    case "audio":
    case "music":
      return "audio";
    default:
      return undefined;
  }
}

/**
 * Build a completed card straight from the status payload.
 *
 * mediaResult classifies assets by URL EXTENSION and returns plain JSON when it
 * recognises none — which, in submit mode, leaves the iframe polling a card that
 * can never resolve (it waits for `assets`/`status` that never arrive). That has
 * bitten before: TTS outputs re-hosted with an `audio/mpeg` content-type produced
 * `.mpeg` URLs that weren't in the extension set, and the card hung despite the
 * file being fully generated.
 *
 * The status endpoint already tells us both things authoritatively — `type` (the
 * source table) and `result_urls` — so when extension-sniffing comes up empty we
 * can still render the right card. Scoped deliberately to result_urls: applying a
 * kind hint to a blind payload walk would misclassify non-media URLs.
 */
function cardFromStatusPayload(
  data: unknown,
  requestId: string,
): ToolResult | null {
  const kind = kindFromStatusType(data);
  if (!kind) return null;
  const obj = (data ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(obj.result_urls)
    ? obj.result_urls
    : typeof obj.result_url === "string"
      ? [obj.result_url]
      : [];
  const urls = raw.filter((u): u is string => typeof u === "string" && !!u.trim());
  if (urls.length === 0) return null;

  const structuredContent = buildMediaCardPayload(
    kind,
    urls.map((url) => ({ url })),
    {
      task_id: requestId,
      status: "completed",
      ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    },
  );
  if (!structuredContent) return null;
  return {
    content: [
      {
        type: "text",
        text: `Task ${requestId} completed — ${urls.length} ${kind} asset${urls.length === 1 ? "" : "s"}: ${urls.join(", ")}`,
      },
    ],
    structuredContent,
  };
}

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
      // mediaResult walks for asset URLs and builds the completed payload; the
      // iframe poll loop merges this back over the original card state, so the
      // kind we set here is the one the finished card renders with. Take it from
      // the backend's `type` rather than letting mediaResult infer from URLs.
      const kind = kindFromStatusType(data);
      const res = await mediaResult(
        { request_id: input.request_id, outcome: "completed", data },
        {
          ...(kind ? { kind } : {}),
          extra: { task_id: input.request_id, status: "completed" },
        },
      );
      // No structuredContent means mediaResult recognised no assets by extension
      // and fell back to plain JSON — which would leave the iframe polling
      // forever. Rebuild from the status payload's own type + result_urls.
      return res.structuredContent
        ? res
        : (cardFromStatusPayload(data, input.request_id) ?? res);
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
    "Block and poll a request_id until it finishes — but for at most ~70 seconds, " +
    "regardless of what poll_timeout_ms says. If the job is still running when that " +
    "budget runs out this returns status 'still_running' (NOT an error, and the job is " +
    "unaffected). For anything slower than about a minute — video especially — prefer " +
    "calling versely_get_task_status a few times instead of blocking here.",
  inputSchema: z.object({
    request_id: z.string().describe("The request_id / task_id to wait on."),
    poll_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Requested poll timeout in ms. CLAMPED to ~70s — a longer block is severed by " +
          "the proxy in front of this server and surfaces as 'unable to reach the server', " +
          "so a bigger number here buys nothing.",
      ),
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
    // Budget exhausted with the job still going. Hand back the request_id and a
    // clear next step instead of an error — the generation is alive and paid for.
    if (outcome.kind === "timeout") {
      return {
        content: [
          {
            type: "text",
            text:
              `Task ${input.request_id} is STILL RUNNING after ${Math.round(outcome.waitedMs / 1000)}s ` +
              `(status: "${outcome.lastState ?? "pending"}") — this is not a failure and the job was not ` +
              `cancelled. Waiting longer in one call is not possible. Call versely_get_task_status with ` +
              `request_id="${input.request_id}" again in a little while to collect the result. ` +
              `Do not resubmit — that would charge for a second generation.`,
          },
        ],
        structuredContent: {
          status: "pending",
          task_id: input.request_id,
          waited_ms: outcome.waitedMs,
        },
      };
    }

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
    if (outcome.kind !== "completed") return jsonResult(payload);
    // Same as get_task_status: prefer the backend's authoritative `type` over
    // inferring the render path from asset URLs. This is the tool submit-mode
    // callers land on, so it decides what the finished card looks like.
    const kind = kindFromStatusType(outcome.data);
    const res = await mediaResult(payload, {
      ...(kind ? { kind } : {}),
      extra: { task_id: input.request_id, status: "completed" },
    });
    return res.structuredContent
      ? res
      : (cardFromStatusPayload(outcome.data, input.request_id) ?? res);
  },
});

export const statusTools: Tool[] = [versely_get_task_status, versely_wait_for_task];
