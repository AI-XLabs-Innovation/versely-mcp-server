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

const Empty = z.object({});

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
    "Update the media_assets binding on a workflow (which workflow_assets back which scene reference keys).",
  inputSchema: z
    .object({
      workflow_id: z.string().describe("Workflow UUID."),
      media_assets: z
        .record(z.unknown())
        .describe("Map of asset key → workflow_asset binding."),
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
  description: "List all runs (history) for a given workflow.",
  inputSchema: z.object({
    workflow_id: z.string().describe("Workflow UUID."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/workflows/${encodeURIComponent(input.workflow_id)}/runs`,
    );
    return jsonResult(data);
  },
});

const versely_get_workflow_run = defineTool({
  name: "versely_get_workflow_run",
  description:
    "Fetch a single workflow run by its run/task ID. Unified across scenes-mode and steps-mode runs.",
  inputSchema: z.object({
    run_id: z
      .string()
      .describe("Run/task ID returned from versely_run_workflow (also called task_id)."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/workflows/runs/${encodeURIComponent(input.run_id)}`,
    );
    return jsonResult(data);
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
        .array(z.string())
        .optional()
        .describe("URLs of reference images attached to this asset."),
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
      reference_images: z.array(z.string()).optional(),
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
      reference_images: z.array(z.string()).describe("URLs of images to append."),
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
  versely_create_workflow_asset,
  versely_list_workflow_assets,
  versely_get_workflow_asset,
  versely_update_workflow_asset,
  versely_add_workflow_asset_images,
  versely_delete_workflow_asset,
];
