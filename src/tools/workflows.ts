// User workflows, workflow runs, and reusable workflow assets.
//
// Conventions:
//   - Updates use PATCH (not PUT). The undocumented contract on /workflows is
//     PATCH for partial updates; PUT routes don't exist.
//   - `steps` and `scenes` are mutually-supported execution modes on the same
//     workflow row; the backend revalidates either as a pair.
//   - Manual runs return a `run_id` immediately; per-run output is only visible
//     by polling versely_get_workflow_run — there's no REST stream.

import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";

const Empty = z.object({});

// Backend's ReferenceImage shape (controllers/workflowAsset.controller.ts:8):
//   { url: string; label?: string; created_at?: string }
// The MCP schema must match — passing a bare string array gets a 400.
const ReferenceImage = z.object({
  url: z.string().url().describe("Image URL."),
  label: z.string().optional().describe("Optional human label for this image."),
  created_at: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp; backend defaults to now if omitted."),
});

// Backend's media_assets shape (controllers/workflow.controller.ts:572):
//   array of { url: string; type: "image" | "video" }
const MediaAsset = z.object({
  url: z.string().url(),
  type: z.enum(["image", "video"]),
});

// --- Run-status taxonomy ------------------------------------------------------
// Backends use slightly different enum values across run tables, so we group
// inclusively by terminal vs non-terminal. "Active" = anything not yet finished.
const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "error", "errored"]);
const SUCCEEDED_STATUSES = new Set(["completed", "complete", "succeeded", "success", "done"]);

function classifyStatus(status: unknown): "active" | "failed" | "succeeded" | "unknown" {
  if (typeof status !== "string") return "unknown";
  const s = status.toLowerCase().trim();
  if (FAILED_STATUSES.has(s)) return "failed";
  if (SUCCEEDED_STATUSES.has(s)) return "succeeded";
  if (!s) return "unknown";
  return "active"; // pending, running, queued, generating, generating_image, etc.
}

// Match a run's status against a user-supplied filter. Accepts a single
// canonical bucket ("active" | "failed" | "succeeded") OR a literal status
// string (case-insensitive), OR an array of either.
function statusMatches(runStatus: unknown, filter: string | string[] | undefined): boolean {
  if (!filter) return true;
  const filters = Array.isArray(filter) ? filter : [filter];
  const cls = classifyStatus(runStatus);
  const literal = typeof runStatus === "string" ? runStatus.toLowerCase() : "";
  return filters.some((f) => {
    const fl = f.toLowerCase();
    if (fl === "active" || fl === "failed" || fl === "succeeded") return cls === fl;
    return literal === fl;
  });
}

function inDateRange(
  ts: unknown,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (!since && !until) return true;
  if (typeof ts !== "string") return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  if (since) {
    const s = Date.parse(since);
    if (!Number.isNaN(s) && t < s) return false;
  }
  if (until) {
    const u = Date.parse(until);
    if (!Number.isNaN(u) && t > u) return false;
  }
  return true;
}

interface WorkflowSummary {
  id: string;
  name?: string;
  schedule_active?: boolean;
  schedule_cron?: string | null;
  schedule_label?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  run_count?: number;
}

interface RunSummary {
  id: string;
  mode?: "steps" | "scenes";
  title?: string | null;
  status?: string;
  current_step?: number;
  current_scene_order?: number;
  total_steps?: number;
  total_scenes?: number;
  error_message?: string | null;
  scheduled_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  final_video_url?: string | null;
}

async function fetchWorkflows(
  ctx: import("./_types.js").ToolContext,
): Promise<WorkflowSummary[]> {
  const res = await ctx.client.get<{ workflows?: WorkflowSummary[] }>("/api/v1/workflows");
  return res?.workflows ?? [];
}

async function fetchRunsForWorkflow(
  ctx: import("./_types.js").ToolContext,
  workflowId: string,
  limit: number,
): Promise<RunSummary[]> {
  const res = await ctx.client.get<{ runs?: RunSummary[] }>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`,
    { query: { limit } },
  );
  return res?.runs ?? [];
}

// --- Workflows: CRUD ---------------------------------------------------------

const versely_create_workflow = defineTool({
  name: "versely_create_workflow",
  description:
    "Create a new user workflow. Provide either `steps` (legacy multi-step mode) or `scenes` (newer scene-graph mode) — at least one must be populated.",
  inputSchema: z
    .object({
      name: z.string().min(1).describe("Display name (required)."),
      description: z.string().optional(),
      icon: z
        .string()
        .optional()
        .describe("Icon name; defaults to 'git-branch-outline'."),
      prompt: z.string().optional().describe("Free-form instruction for the workflow."),
      steps: z
        .array(z.unknown())
        .optional()
        .describe(
          "Legacy mode: ordered array of step objects (each with action/inputs).",
        ),
      asset_map: z
        .record(z.unknown())
        .optional()
        .describe(
          "Map of asset key → asset reference, used by `scenes[].reference_image_keys`.",
        ),
      scenes: z
        .array(z.unknown())
        .optional()
        .describe(
          "Scene-graph mode: array of scenes with prompts, model selections, references.",
        ),
      aspect_ratio: z
        .string()
        .optional()
        .describe("e.g. '9:16' (default), '1:1', '16:9'."),
      style_preamble: z.string().optional(),
      voice_preamble: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/workflows", input);
    return jsonResult(data);
  },
});

const versely_list_workflows = defineTool({
  name: "versely_list_workflows",
  description: "List all workflows owned by the authenticated user.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.get("/api/v1/workflows");
    return jsonResult(data);
  },
});

const versely_get_workflow = defineTool({
  name: "versely_get_workflow",
  description: "Fetch a single workflow by ID.",
  inputSchema: z.object({
    workflow_id: z.string().describe("Workflow UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/workflows/${encodeURIComponent(input.workflow_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_update_workflow = defineTool({
  name: "versely_update_workflow",
  description:
    "Patch core workflow fields (name, description, icon, prompt, steps, scenes, asset_map, aspect_ratio, preambles). Only fields you provide are updated. If you touch scenes or asset_map, the backend revalidates them as a pair against the current row.",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      name: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
      prompt: z.string().optional(),
      steps: z.array(z.unknown()).optional(),
      asset_map: z.record(z.unknown()).optional(),
      scenes: z.array(z.unknown()).optional(),
      aspect_ratio: z.string().optional(),
      style_preamble: z.string().optional(),
      voice_preamble: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { workflow_id, ...body } = input;
    const data = await ctx.client.patch(
      `/api/v1/workflows/${encodeURIComponent(workflow_id)}`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_delete_workflow = defineTool({
  name: "versely_delete_workflow",
  description: "Delete a workflow by ID.",
  inputSchema: z.object({
    workflow_id: z.string().describe("Workflow UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/workflows/${encodeURIComponent(input.workflow_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_duplicate_workflow = defineTool({
  name: "versely_duplicate_workflow",
  description: "Clone an existing workflow into a new one owned by the same user.",
  inputSchema: z.object({
    workflow_id: z.string().describe("Source workflow UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post(
      `/api/v1/workflows/${encodeURIComponent(input.workflow_id)}/duplicate`,
    );
    return jsonResult(data);
  },
});

const versely_export_workflow = defineTool({
  name: "versely_export_workflow",
  description: "Export a workflow as a portable JSON payload (for backup or import elsewhere).",
  inputSchema: z.object({
    workflow_id: z.string().describe("Workflow UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/workflows/${encodeURIComponent(input.workflow_id)}/export`,
    );
    return jsonResult(data);
  },
});

const versely_update_workflow_mode = defineTool({
  name: "versely_update_workflow_mode",
  description:
    "Switch a workflow between manual and auto modes. Auto mode requires a 5-field cron expression and at least one scene; auto_post fields enable automatic publishing on each run.",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      mode: z
        .enum(["manual", "auto"])
        .describe("'manual' disables scheduling; 'auto' enables it."),
      schedule_cron: z
        .string()
        .optional()
        .describe("Required when mode='auto'. 5-field cron (minute hour dom month dow)."),
      schedule_label: z.string().optional(),
      series_premise: z.string().optional(),
      auto_post: z.boolean().optional(),
      auto_post_platforms: z
        .array(z.string())
        .optional()
        .describe("Platform slugs (instagram, tiktok, youtube, twitter, etc.)."),
      auto_post_account_ids: z.array(z.string()).optional(),
      auto_post_caption_prompt: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { workflow_id, ...body } = input;
    const data = await ctx.client.patch(
      `/api/v1/workflows/${encodeURIComponent(workflow_id)}/mode`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_update_workflow_schedule = defineTool({
  name: "versely_update_workflow_schedule",
  description:
    "Update the recurring schedule (cron) of an auto-mode workflow without flipping mode. Use versely_update_workflow_mode to toggle manual ↔ auto.",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      schedule_cron: z.string().describe("5-field cron expression."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { workflow_id, ...body } = input;
    const data = await ctx.client.patch(
      `/api/v1/workflows/${encodeURIComponent(workflow_id)}/schedule`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_update_workflow_dates = defineTool({
  name: "versely_update_workflow_dates",
  description:
    "Update the explicit list of one-off scheduled run dates for a workflow (separate from the recurring cron schedule).",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      scheduled_dates: z
        .array(z.string())
        .describe("ISO-8601 timestamps for each scheduled run."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { workflow_id, ...body } = input;
    const data = await ctx.client.patch(
      `/api/v1/workflows/${encodeURIComponent(workflow_id)}/dates`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_update_workflow_assets = defineTool({
  name: "versely_update_workflow_assets",
  description:
    "Set the media_assets array on a step-mode workflow (legacy). Each item is { url, type: 'image' | 'video' }. NOT for scene workflows — those use the workflow_assets table; the backend rejects this call on scene workflows with error 'scene_workflow_uses_workflow_assets'. To attach images to a scene workflow, use versely_create_workflow_asset / versely_add_workflow_asset_images.",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      media_assets: z
        .array(MediaAsset)
        .describe(
          "Array of { url, type } objects. type must be 'image' or 'video'. Pass [] to clear.",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { workflow_id, ...body } = input;
    const data = await ctx.client.patch(
      `/api/v1/workflows/${encodeURIComponent(workflow_id)}/assets`,
      body,
    );
    return jsonResult(data);
  },
});

// --- Workflow runs -----------------------------------------------------------

const versely_run_workflow = defineTool({
  name: "versely_run_workflow",
  description:
    "Execute a workflow now (or schedule for `scheduled_at`). Returns a run_id immediately; poll versely_get_workflow_run to track progress — manual runs do not stream output via REST.",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      scheduled_at: z
        .string()
        .optional()
        .describe(
          "ISO-8601 timestamp. If supplied, the run is queued for that future time instead of starting immediately.",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { workflow_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/workflows/${encodeURIComponent(workflow_id)}/run`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_list_workflow_runs = defineTool({
  name: "versely_list_workflow_runs",
  description:
    "List runs (history) for a given workflow. Optional filters are applied MCP-side after the backend returns up to `limit` rows: status (canonical bucket 'active' | 'failed' | 'succeeded' or a literal value like 'running'), and since/until date range on created_at.",
  inputSchema: z.object({
    workflow_id: z.string().describe("Workflow UUID."),
    status: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Filter by status. Use 'active'/'failed'/'succeeded' for a canonical bucket, or a literal value (e.g. 'running', 'generating_image'). Pass an array to OR multiple values.",
      ),
    since: z
      .string()
      .optional()
      .describe("ISO-8601 timestamp. Only return runs created at or after this time."),
    until: z
      .string()
      .optional()
      .describe("ISO-8601 timestamp. Only return runs created at or before this time."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Backend max is 50. Increase if filters are likely to drop most rows from a smaller window.",
      ),
  }),
  handler: async (input, ctx) => {
    const runs = await fetchRunsForWorkflow(
      ctx,
      input.workflow_id,
      input.limit ?? 50,
    );
    const filtered = runs.filter(
      (r) =>
        statusMatches(r.status, input.status) &&
        inDateRange(r.created_at, input.since, input.until),
    );
    return jsonResult({
      total_returned: filtered.length,
      total_before_filter: runs.length,
      runs: filtered,
    });
  },
});

const versely_get_workflow_run = defineTool({
  name: "versely_get_workflow_run",
  description:
    "Fetch a single workflow run by its run/task ID. Unified across scenes-mode and steps-mode runs.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    run_id: z
      .string()
      .describe("Run/task ID returned from versely_run_workflow (also called task_id)."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/workflows/runs/${encodeURIComponent(input.run_id)}`,
    );
    return mediaResult(data, { kind: "gallery" });
  },
});

// --- Cross-workflow monitoring (MCP-side fan-out) ----------------------------
// These compose existing endpoints because the backend exposes no global feed.

const versely_list_active_workflow_runs = defineTool({
  name: "versely_list_active_workflow_runs",
  description:
    "Fan-out monitoring: lists every non-terminal run across ALL of the user's workflows. Useful for 'what's running right now?'. Internally lists workflows and queries each workflow's runs; cost is O(N) backend hits where N = number of workflows.",
  inputSchema: z.object({
    limit_per_workflow: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "How many recent runs to inspect per workflow (default 10). Increase if some workflows have many recent terminal runs masking active ones.",
      ),
  }),
  handler: async (input, ctx) => {
    const perWorkflow = input.limit_per_workflow ?? 10;
    const workflows = await fetchWorkflows(ctx);
    const results = await Promise.all(
      workflows.map(async (w) => {
        const runs = await fetchRunsForWorkflow(ctx, w.id, perWorkflow).catch(
          () => [] as RunSummary[],
        );
        return runs
          .filter((r) => classifyStatus(r.status) === "active")
          .map((r) => ({ workflow_id: w.id, workflow_name: w.name, ...r }));
      }),
    );
    const flat = results.flat().sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
    return jsonResult({
      workflows_scanned: workflows.length,
      active_runs: flat.length,
      runs: flat,
    });
  },
});

const versely_list_failed_workflow_runs = defineTool({
  name: "versely_list_failed_workflow_runs",
  description:
    "Fan-out monitoring: lists failed/cancelled runs across ALL of the user's workflows, optionally restricted to a recent time window. Useful for 'what broke?'.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe(
        "ISO-8601 timestamp. Defaults to 7 days ago. Set to '1970-01-01T00:00:00Z' for unlimited history.",
      ),
    until: z.string().optional().describe("ISO-8601 timestamp. Defaults to now."),
    limit_per_workflow: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many recent runs to inspect per workflow (default 20)."),
  }),
  handler: async (input, ctx) => {
    const perWorkflow = input.limit_per_workflow ?? 20;
    const since =
      input.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const workflows = await fetchWorkflows(ctx);
    const results = await Promise.all(
      workflows.map(async (w) => {
        const runs = await fetchRunsForWorkflow(ctx, w.id, perWorkflow).catch(
          () => [] as RunSummary[],
        );
        return runs
          .filter(
            (r) =>
              classifyStatus(r.status) === "failed" &&
              inDateRange(r.created_at, since, input.until),
          )
          .map((r) => ({ workflow_id: w.id, workflow_name: w.name, ...r }));
      }),
    );
    const flat = results.flat().sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );
    return jsonResult({
      workflows_scanned: workflows.length,
      since,
      until: input.until ?? null,
      failed_runs: flat.length,
      runs: flat,
    });
  },
});

const versely_summarize_workflow = defineTool({
  name: "versely_summarize_workflow",
  description:
    "Per-workflow health summary: aggregates runs into {total, succeeded, failed, active, last_run_at, last_status, avg_duration_ms} plus the workflow's current schedule state. Cheap (one /workflows/:id and one /workflows/:id/runs call).",
  inputSchema: z.object({
    workflow_id: z.string().describe("Workflow UUID."),
    since: z
      .string()
      .optional()
      .describe("ISO-8601 timestamp. Only count runs created on or after this time."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many recent runs to consider (default 50, the backend max)."),
  }),
  handler: async (input, ctx) => {
    const [workflowRes, runs] = await Promise.all([
      ctx.client.get<{ workflow?: WorkflowSummary & { mode?: string } }>(
        `/api/v1/workflows/${encodeURIComponent(input.workflow_id)}`,
      ),
      fetchRunsForWorkflow(ctx, input.workflow_id, input.limit ?? 50),
    ]);
    const workflow = workflowRes?.workflow ?? ({} as WorkflowSummary);
    const filtered = input.since
      ? runs.filter((r) => inDateRange(r.created_at, input.since, undefined))
      : runs;

    let succeeded = 0;
    let failed = 0;
    let active = 0;
    const durations: number[] = [];
    for (const r of filtered) {
      const cls = classifyStatus(r.status);
      if (cls === "succeeded") succeeded++;
      else if (cls === "failed") failed++;
      else if (cls === "active") active++;
      // Compute duration only when both endpoints are available.
      const start = r.started_at ?? r.created_at;
      const end = r.finished_at ?? r.completed_at;
      if (start && end) {
        const ms = Date.parse(end) - Date.parse(start);
        if (Number.isFinite(ms) && ms >= 0) durations.push(ms);
      }
    }
    const avg =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null;
    const last = filtered[0];

    return jsonResult({
      workflow_id: input.workflow_id,
      name: workflow.name ?? null,
      schedule: {
        mode:
          (workflow as { mode?: string }).mode ??
          (workflow.schedule_active ? "auto" : "manual"),
        schedule_active: workflow.schedule_active ?? false,
        schedule_cron: workflow.schedule_cron ?? null,
        schedule_label: workflow.schedule_label ?? null,
        next_run_at: workflow.next_run_at ?? null,
      },
      runs: {
        total: filtered.length,
        succeeded,
        failed,
        active,
        last_status: last?.status ?? null,
        last_run_at: workflow.last_run_at ?? last?.created_at ?? null,
        avg_duration_ms: avg,
      },
      since: input.since ?? null,
    });
  },
});

const versely_list_scheduled_workflows = defineTool({
  name: "versely_list_scheduled_workflows",
  description:
    "List workflows in auto mode (schedule_active=true), sorted by next_run_at ascending so the soonest-firing comes first. Useful for confirming that a workflow you set to auto is actually armed.",
  inputSchema: z.object({
    include_inactive: z
      .boolean()
      .optional()
      .describe(
        "If true, also include workflows with a schedule_cron set but schedule_active=false. Default false.",
      ),
  }),
  handler: async (input, ctx) => {
    const workflows = await fetchWorkflows(ctx);
    const filtered = workflows.filter((w) =>
      input.include_inactive
        ? Boolean(w.schedule_cron)
        : Boolean(w.schedule_active),
    );
    filtered.sort((a, b) =>
      (a.next_run_at ?? "9999").localeCompare(b.next_run_at ?? "9999"),
    );
    const slim = filtered.map((w) => ({
      id: w.id,
      name: w.name,
      schedule_cron: w.schedule_cron ?? null,
      schedule_label: w.schedule_label ?? null,
      schedule_active: w.schedule_active ?? false,
      next_run_at: w.next_run_at ?? null,
      last_run_at: w.last_run_at ?? null,
      run_count: w.run_count ?? 0,
    }));
    return jsonResult({
      total: slim.length,
      include_inactive: !!input.include_inactive,
      workflows: slim,
    });
  },
});

// --- Workflow assets ---------------------------------------------------------

const versely_create_workflow_asset = defineTool({
  name: "versely_create_workflow_asset",
  description:
    "Create a reusable workflow asset (e.g. character reference, brand kit, product imagery). Can be bound to a specific workflow or left global to the user.",
  inputSchema: z
    .object({
      asset_type: z
        .string()
        .describe("Asset category (e.g. 'character', 'product', 'brand_kit')."),
      name: z.string().describe("Display name."),
      description: z.string().optional(),
      reference_images: z
        .array(ReferenceImage)
        .optional()
        .describe(
          "Reference images as objects: [{ url, label?, created_at? }]. NOT bare URL strings.",
        ),
      metadata: z.record(z.unknown()).optional(),
      workflow_id: z
        .string()
        .optional()
        .describe("Bind to a specific workflow; omit for a user-global asset."),
      slideshow_schedule_id: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/workflow-assets", input);
    return jsonResult(data);
  },
});

const versely_list_workflow_assets = defineTool({
  name: "versely_list_workflow_assets",
  description:
    "List the user's workflow assets, optionally filtered by asset_type or scoped to a workflow / slideshow schedule.",
  inputSchema: z.object({
    asset_type: z.string().optional(),
    workflow_id: z
      .string()
      .optional()
      .describe(
        "Pass 'none' to filter to user-global assets only; an ID returns assets bound to that workflow plus user-globals.",
      ),
    slideshow_schedule_id: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().describe("Default 50."),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/workflow-assets", { query: input });
    return jsonResult(data);
  },
});

const versely_get_workflow_asset = defineTool({
  name: "versely_get_workflow_asset",
  description: "Fetch a single workflow asset by ID.",
  inputSchema: z.object({
    asset_id: z.string().describe("Workflow asset UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/workflow-assets/${encodeURIComponent(input.asset_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_update_workflow_asset = defineTool({
  name: "versely_update_workflow_asset",
  description:
    "Patch a workflow asset's mutable fields (asset_type, name, description, reference_images, metadata).",
  inputSchema: z
    .object({
      asset_id: z.string().describe("Workflow asset UUID."),
      asset_type: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      reference_images: z
        .array(ReferenceImage)
        .optional()
        .describe(
          "Replaces the asset's full reference_images list. Objects: [{ url, label?, created_at? }].",
        ),
      metadata: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { asset_id, ...body } = input;
    const data = await ctx.client.patch(
      `/api/v1/workflow-assets/${encodeURIComponent(asset_id)}`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_add_workflow_asset_images = defineTool({
  name: "versely_add_workflow_asset_images",
  description:
    "Append additional reference images to an existing workflow asset (preserves existing images).",
  inputSchema: z
    .object({
      asset_id: z.string().describe("Workflow asset UUID."),
      reference_images: z
        .array(ReferenceImage)
        .describe(
          "Images to append as objects: [{ url, label?, created_at? }]. NOT bare URL strings.",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { asset_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/workflow-assets/${encodeURIComponent(asset_id)}/images`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_delete_workflow_asset = defineTool({
  name: "versely_delete_workflow_asset",
  description: "Delete a workflow asset by ID.",
  inputSchema: z.object({
    asset_id: z.string().describe("Workflow asset UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/workflow-assets/${encodeURIComponent(input.asset_id)}`,
    );
    return jsonResult(data);
  },
});

export const workflowTools: Tool[] = [
  versely_create_workflow,
  versely_list_workflows,
  versely_get_workflow,
  versely_update_workflow,
  versely_delete_workflow,
  versely_duplicate_workflow,
  versely_export_workflow,
  versely_update_workflow_mode,
  versely_update_workflow_schedule,
  versely_update_workflow_dates,
  versely_update_workflow_assets,
  versely_run_workflow,
  versely_list_workflow_runs,
  versely_get_workflow_run,
  versely_list_active_workflow_runs,
  versely_list_failed_workflow_runs,
  versely_summarize_workflow,
  versely_list_scheduled_workflows,
  versely_create_workflow_asset,
  versely_list_workflow_assets,
  versely_get_workflow_asset,
  versely_update_workflow_asset,
  versely_add_workflow_asset_images,
  versely_delete_workflow_asset,
];
