// Video workflow templates and runs.
//
// Distinct from the generic /workflows resource — this is a scene-graph-based
// multi-step video pipeline with its own template + run state machine.

import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";
import { workflowRunToCardPayload } from "./_workflowRun.js";

// --- Templates ---------------------------------------------------------------

const versely_create_video_workflow_template = defineTool({
  name: "versely_create_video_workflow_template",
  description:
    "Create a new video-workflow template (multi-scene video blueprint). Slug + name are required; scenes is validated by the backend.",
  inputSchema: z
    .object({
      slug: z.string().describe("Unique template slug (kebab-case)."),
      name: z.string().describe("Display name."),
      version: z.number().int().min(1).optional().describe("Defaults to 1."),
      description: z.string().optional(),
      icon: z.string().optional().describe("Icon name; defaults to 'film-outline'."),
      aspect_ratio: z.string().optional().describe("e.g. '9:16' (default), '1:1', '16:9'."),
      style_preamble: z
        .string()
        .optional()
        .describe(
          "Prepended to every scene's prompt at run time. Use to lock visual style across the whole template (e.g. 'warm 35mm film grain, soft natural light, shallow depth of field'). Note: video_workflow_templates do not store a `voice_preamble` — that field is exclusive to user_workflows (the generic /workflows surface).",
        ),
      characters: z
        .record(z.unknown())
        .optional()
        .describe("Map of character key → character definition."),
      default_params: z
        .record(z.unknown())
        .optional()
        .describe("Default values for params at run time."),
      scenes: z
        .array(z.unknown())
        .describe("Ordered scenes (prompts, model selections, references)."),
      is_public: z
        .boolean()
        .optional()
        .describe("Make this template visible to other users (defaults to false)."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/video-workflows/templates", input);
    return jsonResult(data);
  },
});

const versely_list_video_workflow_templates = defineTool({
  name: "versely_list_video_workflow_templates",
  description:
    "List video-workflow templates. By default returns public templates plus the user's own; pass mine=true to filter to user-owned only.",
  inputSchema: z.object({
    mine: z.boolean().optional().describe("Only return templates created by the current user."),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20, max 50."),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/video-workflows/templates", {
      query: {
        mine: input.mine === true ? "true" : undefined,
        limit: input.limit,
        offset: input.offset,
      },
    });
    return jsonResult(data);
  },
});

const versely_get_video_workflow_template = defineTool({
  name: "versely_get_video_workflow_template",
  description: "Fetch a single video-workflow template by ID.",
  inputSchema: z.object({
    template_id: z.string().describe("Template UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/video-workflows/templates/${encodeURIComponent(input.template_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_update_video_workflow_template = defineTool({
  name: "versely_update_video_workflow_template",
  description:
    "Patch a video-workflow template's mutable fields. Only fields you provide are updated.",
  inputSchema: z
    .object({
      template_id: z.string().describe("Template UUID."),
      name: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
      aspect_ratio: z.string().optional(),
      style_preamble: z
        .string()
        .optional()
        .describe(
          "Prepended to every scene's prompt at run time. Use to lock visual style across the template.",
        ),
      characters: z.record(z.unknown()).optional(),
      default_params: z.record(z.unknown()).optional(),
      scenes: z.array(z.unknown()).optional(),
      is_public: z.boolean().optional(),
      // `version` was declared here but the controller never destructures it, so
      // it was accepted and silently dropped. Removed rather than left as a lie —
      // template versioning isn't settable through this endpoint.
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { template_id, ...body } = input;
    const data = await ctx.client.patch(
      `/api/v1/video-workflows/templates/${encodeURIComponent(template_id)}`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_delete_video_workflow_template = defineTool({
  name: "versely_delete_video_workflow_template",
  description: "Delete a video-workflow template by ID.",
  inputSchema: z.object({
    template_id: z.string().describe("Template UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/video-workflows/templates/${encodeURIComponent(input.template_id)}`,
    );
    return jsonResult(data);
  },
});

// --- Runs --------------------------------------------------------------------

const versely_start_video_workflow_run = defineTool({
  name: "versely_start_video_workflow_run",
  description:
    "Start a new video-workflow run from a template. Returns a pending media card immediately and the iframe self-polls versely_get_video_workflow_run every 5s — scenes pop into the card as they complete, the backend auto-combines them when all are done, and the final video appears in place. No manual combine call needed in the happy path.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      template_id: z.string().describe("Source template UUID."),
      title: z.string().optional().describe("Display title for the run."),
      params: z
        .record(z.unknown())
        .optional()
        .describe("Per-run param values that override the template's default_params."),
      aspect_ratio: z
        .string()
        .optional()
        .describe("Override the template's aspect_ratio for this run."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const submission = await ctx.client.post<{
      success?: boolean;
      run_id?: string;
      total_scenes?: number;
      first_scene?: unknown;
    }>("/api/v1/video-workflows/runs", input);

    const runId = submission?.run_id;
    if (typeof runId !== "string" || !runId) {
      return jsonResult({ ...submission, hint: "Run submitted but no run_id surfaced." });
    }

    // Fetch fresh state so the initial card matches reality (the backend may
    // have already dispatched scene 1 before we hit the status endpoint).
    let initialStatus: unknown = null;
    try {
      initialStatus = await ctx.client.get(
        `/api/v1/video-workflows/runs/${encodeURIComponent(runId)}`,
      );
    } catch {
      /* fall through to minimal pending card */
    }

    return workflowRunToCardPayload(
      initialStatus ?? { run: { total_scenes: submission?.total_scenes, status: "queued" } },
      {
        runId,
        toolName: "versely_start_video_workflow_run",
        toolArgs: input,
        pollTool: "versely_get_video_workflow_run",
        pollArgKey: "run_id",
        includePoll: true,
      },
    );
  },
});

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
  versely_create_video_workflow_template,
  versely_list_video_workflow_templates,
  versely_get_video_workflow_template,
  versely_update_video_workflow_template,
  versely_delete_video_workflow_template,
  versely_start_video_workflow_run,
  versely_list_video_workflow_runs,
  versely_get_video_workflow_run,
  versely_cancel_video_workflow_run,
  versely_combine_video_workflow_run,
  versely_retry_video_workflow_scene,
];
