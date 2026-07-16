// Video workflow RUN control.
//
// The video_workflow_templates surface is deliberately NOT exposed over MCP —
// template CRUD and starting a run from a template live in the app only.
//
// These run tools stay, and are not redundant: /workflows and /video-workflows
// are two blueprint stores feeding ONE run engine. A scenes-mode user workflow
// started with versely_run_workflow instantiates a `video_workflow_runs` row,
// exactly like a template-started run does — and cancel / combine / retry-scene
// exist ONLY on this surface. Drop them and a scene run started from
// /workflows becomes impossible to cancel, recombine or repair.
//
// Reads are a superset on the other side (versely_get_workflow_run falls back
// to background_tasks for legacy steps-mode runs); these two readers are the
// video-run-native path and back the iframe poll loop.

import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";
import { workflowRunToCardPayload } from "./_workflowRun.js";

const versely_list_video_workflow_runs = defineTool({
  name: "versely_list_video_workflow_runs",
  description:
    "List the authenticated user's video-workflow runs. `status` is forwarded to the backend (server-side filter). `since`/`until` filter MCP-side on created_at after the page is fetched.",
  inputSchema: z.object({
    status: z
      .string()
      .optional()
      .describe(
        "Literal backend status (e.g. 'queued', 'running', 'completed', 'failed', 'cancelled'). Forwarded to the backend's ?status= filter.",
      ),
    since: z
      .string()
      .optional()
      .describe("ISO-8601 timestamp. Only return runs created at or after this time."),
    until: z
      .string()
      .optional()
      .describe("ISO-8601 timestamp. Only return runs created at or before this time."),
    // Backend caps at 50 (Math.min(limit, 50)); advertising 100 meant a caller
    // asking for 100 silently got 50 — and the since/until filters below then ran
    // over that truncated page, quietly under-reporting.
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Page size (default 20, server caps at 50)."),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<{
      runs?: Array<Record<string, unknown>>;
      total?: number;
    }>("/api/v1/video-workflows/runs", {
      query: { limit: input.limit, offset: input.offset, status: input.status },
    });
    const runs = res?.runs ?? [];
    let filtered = runs;
    if (input.since || input.until) {
      filtered = runs.filter((r) => {
        const created = (r as { created_at?: string }).created_at;
        if (typeof created !== "string") return false;
        const t = Date.parse(created);
        if (Number.isNaN(t)) return false;
        if (input.since) {
          const s = Date.parse(input.since);
          if (!Number.isNaN(s) && t < s) return false;
        }
        if (input.until) {
          const u = Date.parse(input.until);
          if (!Number.isNaN(u) && t > u) return false;
        }
        return true;
      });
    }
    return jsonResult({
      total: res?.total ?? runs.length,
      total_returned: filtered.length,
      // since/until are applied client-side to the fetched page only. Say so, and
      // say how much was actually scanned, so a partial answer never reads as complete.
      ...(input.since || input.until
        ? {
            filtered_client_side: {
              scanned: runs.length,
              matched: filtered.length,
              note: "since/until were applied to this page only — page further with offset to scan older runs.",
            },
          }
        : {}),
      runs: filtered,
    });
  },
});

const versely_get_video_workflow_run = defineTool({
  name: "versely_get_video_workflow_run",
  description:
    "Fetch a video-workflow run's status, including per-scene progress. Response is translated into a MediaCardPayload (pending / completed / failed) so the iframe poll loop can update the card in place — this is the tool the iframe self-polls during a run.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    run_id: z.string().describe("Run UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}`,
    );
    return workflowRunToCardPayload(data, {
      runId: input.run_id,
      toolName: "versely_get_video_workflow_run",
      toolArgs: { run_id: input.run_id },
      pollTool: "versely_get_video_workflow_run",
      pollArgKey: "run_id",
    });
  },
});

const versely_cancel_video_workflow_run = defineTool({
  name: "versely_cancel_video_workflow_run",
  description:
    "Cancel an in-progress video-workflow run. Marks the run as 'cancelled' so the iframe poll loop stops; keeps any scenes that already completed.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      run_id: z.string().describe("Run UUID."),
      reason: z.string().optional().describe("Optional reason recorded with the cancellation."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { run_id, ...body } = input;
    await ctx.client.post(
      `/api/v1/video-workflows/runs/${encodeURIComponent(run_id)}/cancel`,
      body,
    );
    // Cancel endpoint returns only `{success, message}` — fetch the fresh
    // run so the iframe sees a `status: cancelled` translated to a terminal
    // failed-style card and stops polling.
    let fresh: unknown = null;
    try {
      fresh = await ctx.client.get(
        `/api/v1/video-workflows/runs/${encodeURIComponent(run_id)}`,
      );
    } catch {
      /* if the fetch fails, fall back to a minimal cancelled card */
    }
    return workflowRunToCardPayload(
      fresh ?? { run: { status: "cancelled" } },
      {
        runId: run_id,
        toolName: "versely_cancel_video_workflow_run",
        toolArgs: input,
        pollTool: "versely_get_video_workflow_run",
        pollArgKey: "run_id",
      },
    );
  },
});

const versely_combine_video_workflow_run = defineTool({
  name: "versely_combine_video_workflow_run",
  description:
    "Manually (re)combine a video-workflow run's rendered scenes into a final video. **You usually don't need to call this** — the backend auto-combines when all scenes complete. Use this only when (a) auto-combine errored, (b) you want a different transition or audio, or (c) some scenes failed and you want to combine just the successful ones.\n\nReturns a pending media card; combine runs server-side and the iframe poll loop picks up the final_video_url when it lands.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    run_id: z.string().describe("Run UUID (all scenes must be complete)."),
  }),
  handler: async (input, ctx) => {
    // Default to fire-and-forget (no `wait=true`) so big FFmpeg merges don't
    // trip claude.ai's per-tool execution timeout. Iframe polls until the
    // backend sets final_video_url.
    //
    // A run that's already combining returns 409. That's the single likeliest
    // case for calling this twice, and an unwrapped POST turned it into a raw
    // error instead of the pending card the caller wanted — the merge IS running,
    // so falling through to poll is the correct outcome. Other errors still throw.
    try {
      await ctx.client.post(
        `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}/combine`,
      );
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 409) throw err;
    }
    let fresh: unknown = null;
    try {
      fresh = await ctx.client.get(
        `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}`,
      );
    } catch {
      /* fall through to minimal pending card */
    }
    return workflowRunToCardPayload(
      fresh ?? { run: { status: "combining" } },
      {
        runId: input.run_id,
        toolName: "versely_combine_video_workflow_run",
        toolArgs: { run_id: input.run_id },
        pollTool: "versely_get_video_workflow_run",
        pollArgKey: "run_id",
        includePoll: true,
      },
    );
  },
});

const versely_retry_video_workflow_scene = defineTool({
  name: "versely_retry_video_workflow_scene",
  description:
    "Retry a single failed scene within a video-workflow run, identified by its scene order. The backend resets that scene plus any downstream scenes that depended on it and re-dispatches them. Returns a pending media card; the iframe polls until the retried scenes finish (and auto-combine fires).",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    run_id: z.string().describe("Run UUID."),
    scene_order: z
      .number()
      .int()
      .min(1)
      .describe("1-based scene index within the run (matches scene_order from versely_get_video_workflow_run)."),
  }),
  handler: async (input, ctx) => {
    await ctx.client.post(
      `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}/scenes/${input.scene_order}/retry`,
    );
    let fresh: unknown = null;
    try {
      fresh = await ctx.client.get(
        `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}`,
      );
    } catch {
      /* fall through */
    }
    return workflowRunToCardPayload(
      fresh ?? { run: { status: "running" } },
      {
        runId: input.run_id,
        toolName: "versely_retry_video_workflow_scene",
        toolArgs: input,
        pollTool: "versely_get_video_workflow_run",
        pollArgKey: "run_id",
        includePoll: true,
      },
    );
  },
});

export const videoWorkflowTools: Tool[] = [
  versely_list_video_workflow_runs,
  versely_get_video_workflow_run,
  versely_cancel_video_workflow_run,
  versely_combine_video_workflow_run,
  versely_retry_video_workflow_scene,
];
