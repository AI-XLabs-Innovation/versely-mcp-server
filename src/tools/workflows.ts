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
import { jsonResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";
import { workflowRunToCardPayload } from "./_workflowRun.js";

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

// Backend's asset_map entry (controllers/workflow.controller.ts:20, validated 33-62):
//   Record<string, { asset_id: string; asset_type: string; name: string }>
// All three fields are required — backend rejects missing asset_type / name.
const AssetMapEntry = z.object({
  asset_id: z
    .string()
    .min(1)
    .describe("UUID of an existing workflow_asset (from versely_create_workflow_asset / versely_list_workflow_assets)."),
  asset_type: z
    .string()
    .min(1)
    .describe("Category of the asset (e.g. 'character', 'product', 'brand_kit'). Must match the asset's own asset_type."),
  name: z
    .string()
    .min(1)
    .describe("Human-readable label for this asset slot (e.g. 'Main character')."),
});

// Backend's VerselyScene (controllers/workflow.controller.ts:21, validated 64-120).
// Scene workflows (asset_map + scenes) are the modern path; backend chains them
// through Nano Banana 2 image gen → Vidu Q3 / VEO 3.1 Fast video gen.
const UserWorkflowScene = z
  .object({
    order: z
      .number()
      .int()
      .min(1)
      .describe("1-based position in the scene sequence. Must be unique across scenes."),
    name: z.string().optional().describe("Optional human label for the scene (e.g. 'Hook')."),
    img_prompt: z
      .string()
      .min(1)
      .describe("Prompt the image generator sees. style_preamble (if set on the workflow) is auto-prepended at run time."),
    video_prompt: z
      .string()
      .min(1)
      .describe("Prompt the image-to-video model sees. Sora / VEO / Seedance render dialogue from this prompt directly."),
    reference_image_keys: z
      .array(z.string())
      .optional()
      .describe(
        "List of asset_map keys to use as character / product references for this scene. Every entry MUST exist in asset_map or the backend rejects the save. If omitted on a workflow that has any assets, the backend auto-injects every asset_map key to keep character identity stable.",
      ),
    voiceover: z
      .string()
      .optional()
      .describe(
        "Spoken-line block. Appended to video_prompt as a 'Dialogue:' section at run time. voice_preamble (if set on the workflow) is prepended as 'Voice direction:' to lock narrator persona across scenes.",
      ),
    duration: z
      .number()
      .optional()
      .describe(
        "Per-scene clip duration in seconds. VEO 3.1 Fast I2V is locked to 8s server-side regardless; other models honor this if positive.",
      ),
    max_retries: z
      .number()
      .int()
      .optional()
      .describe("Override the default per-scene retry budget."),
    chain_from_previous: z
      .boolean()
      .optional()
      .describe(
        "Opt-in: when true on scene N (N>=2), the backend switches that scene to previous_scene_image_to_video for tight narrative continuation. Most multi-scene runs should leave this false and rely on asset_map for character consistency.",
      ),
  })
  .passthrough();

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

/** Server-side cap on GET /workflows (limit is Math.min(limit ?? 20, 50)). */
const WORKFLOW_PAGE_MAX = 50;

/**
 * Fetch EVERY workflow, paging until exhausted.
 *
 * GET /workflows defaults to limit=20 and hard-caps at 50, and returns a `total`.
 * This helper used to send no query at all, so the fan-out tools below silently
 * scanned only the 20 most-recently-updated workflows while reporting
 * `workflows_scanned` as though the sweep were complete.
 */
async function fetchWorkflows(
  ctx: import("./_types.js").ToolContext,
): Promise<WorkflowSummary[]> {
  const all: WorkflowSummary[] = [];
  let offset = 0;
  for (;;) {
    const res = await ctx.client.get<{ workflows?: WorkflowSummary[]; total?: number }>(
      "/api/v1/workflows",
      { query: { limit: WORKFLOW_PAGE_MAX, offset } },
    );
    const page = res?.workflows ?? [];
    all.push(...page);
    const total = typeof res?.total === "number" ? res.total : undefined;
    offset += page.length;
    if (page.length < WORKFLOW_PAGE_MAX) break;
    if (total !== undefined && all.length >= total) break;
    if (page.length === 0) break;
  }
  return all;
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
    "Create a new user workflow. Provide either `steps` (legacy multi-step mode) or `scenes` (newer scene-graph mode) — at least one must be populated.\n\n**Scene-graph prerequisite chain:**\n1. Create reusable assets first with `versely_create_workflow_asset` (one per character / product / brand kit). OR call `versely_prepare_workflow_assets` to do steps 1 + 2 in a single call.\n2. Reference them in `asset_map` as `{ \"<key>\": { asset_id, asset_type, name } }` — the key is the slot name scenes will use.\n3. In each scene, list the slot keys you want in `reference_image_keys`. Every key MUST exist in `asset_map` (backend rejects unknown keys with a 400). If omitted, the backend auto-injects ALL asset_map keys for that scene so character identity stays stable.\n\nFor multi-scene runs, also set `style_preamble` + `voice_preamble` so visual style and narrator persona stay consistent across independently-rendered scenes.",
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
          "Legacy mode: ordered array of step objects (each with action/inputs). Mutually exclusive with `scenes` in practice.",
        ),
      asset_map: z
        .record(AssetMapEntry)
        .optional()
        .describe(
          "Scene-graph mode: map of asset slot key → { asset_id, asset_type, name }. The key is what scenes reference in `reference_image_keys`. All three fields are required per entry (backend rejects missing asset_type / name with a 400). Example: { \"main_character\": { asset_id: \"...uuid...\", asset_type: \"character\", name: \"Main character\" } }.",
        ),
      scenes: z
        .array(UserWorkflowScene)
        .optional()
        .describe(
          "Scene-graph mode: ordered scenes. Each scene needs `order` (1-based, unique), `img_prompt`, `video_prompt`. Optional: `reference_image_keys` (must all exist in asset_map), `voiceover`, `duration`, `chain_from_previous`. Scenes auto-sort by `order` on save.",
        ),
      aspect_ratio: z
        .string()
        .optional()
        .describe("e.g. '9:16' (default), '1:1', '16:9'."),
      style_preamble: z
        .string()
        .optional()
        .describe(
          "Prepended to every scene's image prompt at run time. Use to lock visual style across the whole workflow (e.g. 'warm 35mm film grain, soft natural light, shallow depth of field'). Cheap insurance against scene-to-scene style drift when scenes are rendered independently.",
        ),
      voice_preamble: z
        .string()
        .optional()
        .describe(
          "Prepended to every scene's voiceover as a 'Voice direction:' header at run time. Use to lock narrator persona / tone / pacing across scenes (e.g. 'calm female narrator, mid-30s, conversational pacing, slight smile'). Only applies to scenes that have a `voiceover` field — has no effect otherwise.",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/workflows", input);
    return jsonResult(data);
  },
});

const versely_list_workflows = defineTool({
  name: "versely_list_workflows",
  description:
    "List workflows owned by the authenticated user, newest-updated first. Returns `total` alongside the page — page with `limit`/`offset` if `total` exceeds what you received.",
  inputSchema: z
    .object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(WORKFLOW_PAGE_MAX)
        .optional()
        .describe(`Page size (default 20, server caps at ${WORKFLOW_PAGE_MAX}).`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("How many to skip (default 0)."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    // Previously sent no query, so the backend's limit=20 default silently truncated
    // a list this tool described as "all workflows".
    const data = await ctx.client.get("/api/v1/workflows", {
      query: { limit: input.limit, offset: input.offset },
    });
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
    "Patch core workflow fields (name, description, icon, prompt, steps, scenes, asset_map, aspect_ratio, preambles). Only fields you provide are updated. **If you touch scenes or asset_map, send them as a pair** — the backend revalidates `scenes[].reference_image_keys` against `asset_map`, so updating only one side can fail if keys drift.",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      name: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
      prompt: z.string().optional(),
      steps: z.array(z.unknown()).optional(),
      asset_map: z
        .record(AssetMapEntry)
        .optional()
        .describe(
          "Same shape as versely_create_workflow: Record<slot_key, { asset_id, asset_type, name }>. Send alongside `scenes` if you're changing referenced keys.",
        ),
      scenes: z
        .array(UserWorkflowScene)
        .optional()
        .describe(
          "Same shape as versely_create_workflow scenes. Send alongside `asset_map` if you're changing referenced keys.",
        ),
      aspect_ratio: z.string().optional(),
      style_preamble: z
        .string()
        .optional()
        .describe(
          "Prepended to every scene's image prompt at run time. Use to lock visual style across the workflow.",
        ),
      voice_preamble: z
        .string()
        .optional()
        .describe(
          "Prepended to every scene's voiceover as a 'Voice direction:' header. Locks narrator persona; only applies when scenes have a `voiceover` field.",
        ),
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
        .array(
          z.union([
            z
              .object({
                date: z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
                  .describe("Calendar day, YYYY-MM-DD."),
                time: z
                  .string()
                  .regex(/^\d{2}:\d{2}$/, "time must be HH:MM")
                  .optional()
                  .describe("Time of day, HH:MM (24h)."),
                event_label: z.string().optional().describe("Optional label for the run."),
              })
              .passthrough(),
            z
              .string()
              .describe("Deprecated: a bare date/ISO string — split into { date, time } for you."),
          ]),
        )
        .describe(
          "Entries are OBJECTS: { date: 'YYYY-MM-DD', time?: 'HH:MM', event_label?: string }. A bare string is accepted and converted.",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { workflow_id, scheduled_dates, ...rest } = input;
    // The backend reads `entry.date` per item and regex-checks it, so an array of
    // plain strings yielded `undefined` → 400 "Invalid date format". Normalise any
    // legacy string entries (ISO timestamps or bare dates) into the object shape.
    const normalized = (scheduled_dates as Array<unknown>).map((entry) => {
      if (typeof entry !== "string") return entry;
      const m = entry.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
      if (!m) {
        throw new Error(
          `scheduled_dates entry ${JSON.stringify(entry)} is not a recognisable date. Use { date: "YYYY-MM-DD", time?: "HH:MM" }.`,
        );
      }
      return m[2] ? { date: m[1], time: m[2] } : { date: m[1] };
    });
    const body = { ...rest, scheduled_dates: normalized };
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
    "Execute a workflow now (or schedule for `scheduled_at`). Returns a pending media card immediately and the iframe self-polls versely_get_workflow_run every 5s — scenes pop into the card as they complete, the backend auto-combines when all are done, and the final video appears in place.\n\nFor scheduled runs (`scheduled_at` set), the card is still pending but won't make progress until the scheduled time.",
  meta: metaForMediaCard(),
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
    const submission = await ctx.client.post<{
      success?: boolean;
      mode?: "scenes" | "steps";
      run_id?: string;
      task_id?: string;
      total_scenes?: number;
      poll_url?: string;
    }>(`/api/v1/workflows/${encodeURIComponent(workflow_id)}/run`, body);

    const runId =
      submission?.run_id ??
      submission?.task_id ??
      // Last-ditch: walk the response for any *_id.
      (typeof submission === "object" && submission
        ? Object.values(submission).find((v) => typeof v === "string" && v.length > 8)
        : undefined);

    if (typeof runId !== "string" || !runId) {
      // Submit succeeded structurally but we couldn't find a poll handle.
      // Surface the raw response so the LLM has something to act on.
      return jsonResult({ ...submission, hint: "Run submitted but no run_id surfaced from the response. Inspect manually." });
    }

    // Fetch fresh status so the initial card reflects whatever state the run
    // is in (queued, already running, or — for scheduled runs — pending).
    let initialStatus: unknown = null;
    try {
      initialStatus = await ctx.client.get(`/api/v1/workflows/runs/${encodeURIComponent(runId)}`);
    } catch {
      /* fall through to minimal pending card */
    }

    return workflowRunToCardPayload(initialStatus ?? { mode: submission?.mode ?? "scenes", run: {} }, {
      runId,
      toolName: "versely_run_workflow",
      toolArgs: { workflow_id, ...(body.scheduled_at ? { scheduled_at: body.scheduled_at } : {}) },
      pollTool: "versely_get_workflow_run",
      pollArgKey: "run_id",
      includePoll: true,
    });
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
    "Fetch a single workflow run by its run/task ID. Unified across scenes-mode and steps-mode runs. Response is translated into a MediaCardPayload (pending / completed / failed) so the iframe poll loop can update the card in place — this is the tool the iframe self-polls during a run.",
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
    // No `includePoll` — by the time the iframe calls this, it's already in
    // its polling loop. Re-emitting the poll instruction is redundant.
    return workflowRunToCardPayload(data, {
      runId: input.run_id,
      toolName: "versely_get_workflow_run",
      toolArgs: { run_id: input.run_id },
      pollTool: "versely_get_workflow_run",
      pollArgKey: "run_id",
    });
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

// --- Convenience: prepare assets + asset_map in one call ---------------------
// One-shot helper that creates a batch of workflow_assets and returns an
// `asset_map` ready to drop into versely_create_workflow / versely_update_workflow.
// Replaces the boilerplate of: N x versely_create_workflow_asset + manually
// stitching {asset_id, asset_type, name} into a Record by hand.

const PrepareAssetSpec = z.object({
  key: z
    .string()
    .min(1)
    .describe("Slot key the scenes will reference in `reference_image_keys` (e.g. 'main_character', 'product')."),
  name: z.string().min(1).describe("Display name for the asset (e.g. 'Main character — Sarah')."),
  asset_type: z
    .string()
    .min(1)
    .describe("Category: 'character' | 'product' | 'brand_kit' | etc. Used by the backend to group assets in the asset gallery."),
  image_urls: z
    .array(z.string().url())
    .min(1)
    .describe("Reference image URLs. At least one required — Nano Banana 2 uses these to lock identity across scenes."),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const versely_prepare_workflow_assets = defineTool({
  name: "versely_prepare_workflow_assets",
  description:
    "Batch-create reusable workflow assets and return a ready-to-use `asset_map`. Saves you the N round-trips of calling versely_create_workflow_asset once per asset, plus the manual stitching of {asset_id, asset_type, name} into a Record.\n\nUsage:\n1. Call this with one entry per asset slot you want (each entry needs `key`, `name`, `asset_type`, `image_urls`).\n2. Take the returned `asset_map` and pass it verbatim to versely_create_workflow / versely_update_workflow.\n3. Reference the keys you chose in `scenes[].reference_image_keys`.\n\nFail-fast: if any asset fails to create, the call stops and returns the assets it has already created so far in `created` plus the error in `failed_at_index`. The successful assets are real — they exist in the user's library and can be deleted or reused via versely_list_workflow_assets if needed.",
  inputSchema: z
    .object({
      assets: z
        .array(PrepareAssetSpec)
        .min(1)
        .describe("One entry per asset slot. Order is preserved in the response."),
      workflow_id: z
        .string()
        .optional()
        .describe(
          "Optional: bind all created assets to a specific workflow. Omit to make them user-global (reusable across workflows).",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    type CreatedAsset = {
      key: string;
      asset_id: string;
      asset_type: string;
      name: string;
    };
    const created: CreatedAsset[] = [];
    const assetMap: Record<string, { asset_id: string; asset_type: string; name: string }> = {};

    // Detect duplicate keys before any HTTP calls so we don't half-create assets.
    const seenKeys = new Set<string>();
    for (const spec of input.assets) {
      if (seenKeys.has(spec.key)) {
        return jsonResult({
          success: false,
          error: `Duplicate asset key "${spec.key}". Each slot key must be unique within asset_map.`,
          created: [],
          asset_map: {},
        });
      }
      seenKeys.add(spec.key);
    }

    for (let i = 0; i < input.assets.length; i++) {
      const spec = input.assets[i]!;
      const body: Record<string, unknown> = {
        asset_type: spec.asset_type,
        name: spec.name,
        reference_images: spec.image_urls.map((url) => ({ url })),
      };
      if (spec.description) body.description = spec.description;
      if (spec.metadata) body.metadata = spec.metadata;
      if (input.workflow_id) body.workflow_id = input.workflow_id;

      try {
        const res = await ctx.client.post<{ success?: boolean; asset?: { id: string } }>(
          "/api/v1/workflow-assets",
          body,
        );
        const assetId = res?.asset?.id;
        if (typeof assetId !== "string" || !assetId) {
          return jsonResult({
            success: false,
            error: `Asset at index ${i} (key="${spec.key}") was created without an id.`,
            failed_at_index: i,
            created,
            asset_map: assetMap,
          });
        }
        const entry = { asset_id: assetId, asset_type: spec.asset_type, name: spec.name };
        assetMap[spec.key] = entry;
        created.push({ key: spec.key, ...entry });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          failed_at_index: i,
          failed_key: spec.key,
          created,
          asset_map: assetMap,
        });
      }
    }

    return jsonResult({
      success: true,
      created,
      asset_map: assetMap,
      hint: "Pass `asset_map` directly to versely_create_workflow. Reference these keys in scenes[].reference_image_keys.",
    });
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
  versely_prepare_workflow_assets,
];
