// Video workflow templates and runs.
//
// Distinct from the generic /workflows resource — this is a scene-graph-based
// multi-step video pipeline with its own template + run state machine.

import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";

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
      style_preamble: z.string().optional(),
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
      style_preamble: z.string().optional(),
      characters: z.record(z.unknown()).optional(),
      default_params: z.record(z.unknown()).optional(),
      scenes: z.array(z.unknown()).optional(),
      is_public: z.boolean().optional(),
      version: z.number().int().min(1).optional(),
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
    "Start a new video-workflow run from a template. Returns {run_id, total_scenes, first_scene}; poll versely_get_video_workflow_run to track per-scene progress.",
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
    const data = await ctx.client.post("/api/v1/video-workflows/runs", input);
    return jsonResult(data);
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
    limit: z.number().int().min(1).max(100).optional(),
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
      runs: filtered,
    });
  },
});

const versely_get_video_workflow_run = defineTool({
  name: "versely_get_video_workflow_run",
  description: "Fetch a video-workflow run's status, including per-scene progress.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    run_id: z.string().describe("Run UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}`,
    );
    return mediaResult(data, { kind: "gallery" });
  },
});

const versely_cancel_video_workflow_run = defineTool({
  name: "versely_cancel_video_workflow_run",
  description: "Cancel an in-progress video-workflow run.",
  inputSchema: z
    .object({
      run_id: z.string().describe("Run UUID."),
      reason: z.string().optional().describe("Optional reason recorded with the cancellation."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { run_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/video-workflows/runs/${encodeURIComponent(run_id)}/cancel`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_combine_video_workflow_run = defineTool({
  name: "versely_combine_video_workflow_run",
  description:
    "Finalize a completed video-workflow run by combining its rendered scenes into a single output video.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    run_id: z.string().describe("Run UUID (all scenes must be complete)."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post(
      `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}/combine`,
    );
    return mediaResult(data, {
      kind: "video",
      toolName: "versely_combine_video_workflow_run",
      toolArgs: { run_id: input.run_id },
    });
  },
});

const versely_retry_video_workflow_scene = defineTool({
  name: "versely_retry_video_workflow_scene",
  description: "Retry a single failed scene within a video-workflow run, identified by its scene order.",
  inputSchema: z.object({
    run_id: z.string().describe("Run UUID."),
    scene_order: z
      .number()
      .int()
      .min(0)
      .describe("Zero-based scene index within the run."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post(
      `/api/v1/video-workflows/runs/${encodeURIComponent(input.run_id)}/scenes/${input.scene_order}/retry`,
    );
    return jsonResult(data);
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
