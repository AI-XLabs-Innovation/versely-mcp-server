// Automations: recurring jobs the user sets up (backend /api/v1/automations,
// services/automations). Today the one kind is "slideshow": every run makes a
// new slideshow for a category or one of the user's brands - drawn by an image
// model or pulled from Pinterest - and can post it to connected accounts.
//
// The backend validates a WHOLE config on every create and edit, so an edit
// here reads the current config and merges the changes into it.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./_types.js";
import { jsonResult } from "./_helpers.js";
import { toProviderAccountIds } from "./social.js";
import { analyzeLink } from "./brands.js";

const SLIDESHOW_KIND = "slideshow";
const CONTENT_TYPES = ["reel", "story", "post", "portrait", "landscape"] as const;
/** Backend LIMITS: every 5 minutes at the most, at least once a week. */
const MIN_EVERY_MINUTES = 5;
const MAX_EVERY_MINUTES = 7 * 24 * 60;

/** The config fields a slideshow automation takes (services/automations/kinds/slideshow.kind.ts). */
const slideshowConfigFields = {
  source: z
    .enum(["ai", "pinterest"])
    .optional()
    .describe("'ai' draws new pictures with an image model (default); 'pinterest' uses matching Pinterest pictures."),
  category: z
    .string()
    .optional()
    .describe("Subject area id from versely_list_slideshow_options (e.g. 'fitness'). Needed unless brand_kit_id is set."),
  brand_kit_id: z
    .string()
    .optional()
    .describe("Make every slideshow for one of the user's brands (brand_id from versely_list_brands / versely_analyze_brand)."),
  model: z
    .string()
    .optional()
    .describe("Image model for source 'ai', from versely_list_slideshow_options (e.g. 'Flux Pro Ultra'). Required for 'ai'."),
  num_images: z.number().int().min(1).max(20).optional().describe("Slides per slideshow, 1-20 (default 5)."),
  content_type: z.enum(CONTENT_TYPES).optional().describe("Shape of the slides (default 'reel', 9:16)."),
  captions: z.boolean().optional().describe("Plan and burn captions onto the slides (default true)."),
  caption_style: z
    .string()
    .optional()
    .describe("Caption style id from versely_list_slideshow_options; omit for classic captions."),
  post_account_ids: z
    .array(z.string())
    .max(10)
    .optional()
    .describe("Post each slideshow to these accounts (ids from versely_list_social_accounts; up to 10). Omit to only save them to the library."),
  post_caption_prompt: z.string().max(500).optional().describe("Guidance for the auto-written post caption."),
};

type ConfigInput = { [K in keyof typeof slideshowConfigFields]?: z.infer<(typeof slideshowConfigFields)[K]> };
const CONFIG_KEYS = Object.keys(slideshowConfigFields) as Array<keyof ConfigInput>;

/** The config fields present on a tool input, with account ids mapped to the provider ids the backend matches on. */
async function configFrom(ctx: ToolContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};
  for (const k of CONFIG_KEYS) if (input[k] !== undefined) config[k] = input[k];
  if (Array.isArray(config.post_account_ids)) {
    config.post_account_ids = await toProviderAccountIds(ctx, config.post_account_ids as string[]);
  }
  return config;
}

function everySeconds(minutes: number | undefined): number | undefined {
  return minutes === undefined ? undefined : Math.round(minutes * 60);
}

const every_minutes = z
  .number()
  .int()
  .min(MIN_EVERY_MINUTES)
  .max(MAX_EVERY_MINUTES)
  .describe("How often it runs, in minutes: 5 to 10080 (a week). 60 = hourly, 1440 = daily.");

type AutomationEnvelope = { data?: { automation?: Record<string, unknown> } };

async function getAutomation(ctx: ToolContext, id: string): Promise<Record<string, unknown>> {
  const res = await ctx.client.get<AutomationEnvelope>(`/api/v1/automations/${encodeURIComponent(id)}`);
  const automation = res?.data?.automation;
  if (!automation) throw new Error(`Automation ${id} not found.`);
  return automation;
}

const versely_list_slideshow_options = defineTool({
  name: "versely_list_slideshow_options",
  description:
    "What slideshows and slideshow automations can use: image models, slide shapes, caption styles, " +
    "subject categories and the user's brands. Read it before creating a slideshow automation.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const settle = async <T>(p: Promise<T>): Promise<T | null> => {
      try {
        return await p;
      } catch {
        return null;
      }
    };
    const [models, styles, categories, brands] = await Promise.all([
      settle(ctx.client.get<{ data?: { models?: string[]; content_types?: string[] } }>("/api/v1/slideshow/models")),
      settle(ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/slideshow/caption-styles")),
      settle(ctx.client.get<{ categories?: Array<{ id: string; label: string }> }>("/api/v1/public-slideshows/categories")),
      settle(ctx.client.get<{ brand_kits?: Array<Record<string, unknown>> }>("/api/v1/agentic/brand-kit")),
    ]);
    return jsonResult({
      models: models?.data?.models ?? null,
      content_types: models?.data?.content_types ?? [...CONTENT_TYPES],
      caption_styles: Array.isArray(styles?.data)
        ? styles.data.map((s) => ({ id: s.id, label: s.label, blurb: s.blurb }))
        : null,
      categories: Array.isArray(categories?.categories)
        ? categories.categories.map((c) => ({ id: c.id, label: c.label }))
        : null,
      brands: Array.isArray(brands?.brand_kits)
        ? brands.brand_kits.map((b) => ({ id: b.id, name: b.name, is_default: b.is_default === true }))
        : null,
    });
  },
});

const versely_estimate_slideshow_automation = defineTool({
  name: "versely_estimate_slideshow_automation",
  description:
    "Credits one run of a slideshow automation would charge, for the given settings, without creating anything. " +
    "Tell the user this (and how often it runs) before creating or starting one.",
  inputSchema: z.object({ ...slideshowConfigFields }),
  handler: async (input, ctx) => {
    const config = await configFrom(ctx, input as Record<string, unknown>);
    const res = await ctx.client.post<{ data?: unknown }>("/api/v1/automations/estimate", {
      kind: SLIDESHOW_KIND,
      config: { source: "ai", ...config },
    });
    return jsonResult(res?.data ?? res);
  },
});

const versely_create_slideshow_automation = defineTool({
  name: "versely_create_slideshow_automation",
  description:
    "Set up a recurring slideshow automation: every run makes a new slideshow (fresh topic each time) for a " +
    "category or one of the user's brands, and can post it to connected social accounts. Each run spends " +
    "credits (credits_per_run in the result). It is created paused unless start is true; confirm the settings, " +
    "the schedule and the cost with the user first. Options: versely_list_slideshow_options.",
  inputSchema: z.object({
    name: z.string().min(1).max(80).describe("A name for the automation."),
    every_minutes,
    start: z.boolean().optional().describe("Start now (the first run happens right away). Default false: created paused."),
    brand_url: z
      .string()
      .url()
      .optional()
      .describe("A brand's link, when the brand isn't saved yet: it is read and saved (like versely_analyze_brand) and used as brand_kit_id."),
    ...slideshowConfigFields,
  }),
  handler: async (input, ctx) => {
    if (input.brand_url && !input.brand_kit_id) {
      const read = await analyzeLink(ctx, input.brand_url);
      if (!read.kit) throw new Error("The brand link was read but could not be saved; try versely_analyze_brand.");
      (input as Record<string, unknown>).brand_kit_id = String(read.kit.id);
    }
    const config = await configFrom(ctx, input as Record<string, unknown>);
    const res = await ctx.client.post<AutomationEnvelope>("/api/v1/automations", {
      kind: SLIDESHOW_KIND,
      name: input.name,
      config: { source: "ai", ...config },
      interval_seconds: everySeconds(input.every_minutes),
      start: input.start === true,
    });
    return jsonResult(res?.data?.automation ?? res);
  },
});

const versely_list_automations = defineTool({
  name: "versely_list_automations",
  description:
    "List the user's automations with their status (active or paused, and why), schedule, next run, " +
    "credits per run and spent so far, and the last run's result.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const res = await ctx.client.get<{ data?: { automations?: unknown[] } }>("/api/v1/automations");
    return jsonResult({ automations: res?.data?.automations ?? [] });
  },
});

const versely_get_automation = defineTool({
  name: "versely_get_automation",
  description: "Get one of the user's automations: its settings, status, schedule and last run.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => jsonResult(await getAutomation(ctx, input.automation_id)),
});

const versely_update_automation = defineTool({
  name: "versely_update_automation",
  description:
    "Change an automation's name, schedule or settings. Only the fields given change; the rest are kept. " +
    "A changed setting applies from the next run.",
  inputSchema: z.object({
    automation_id: z.string().describe("Id from versely_list_automations."),
    name: z.string().min(1).max(80).optional(),
    every_minutes: every_minutes.optional(),
    ...slideshowConfigFields,
  }),
  handler: async (input, ctx) => {
    const { automation_id, name, every_minutes: minutes } = input;
    const changes = await configFrom(ctx, input as Record<string, unknown>);
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (minutes !== undefined) body.interval_seconds = everySeconds(minutes);
    if (Object.keys(changes).length > 0) {
      const current = await getAutomation(ctx, automation_id);
      const currentConfig =
        current.config && typeof current.config === "object" ? (current.config as Record<string, unknown>) : {};
      body.config = { ...currentConfig, ...changes };
    }
    if (Object.keys(body).length === 0) throw new Error("Nothing to change: pass name, every_minutes or a setting.");
    const res = await ctx.client.patch<AutomationEnvelope>(
      `/api/v1/automations/${encodeURIComponent(automation_id)}`,
      body,
    );
    return jsonResult(res?.data?.automation ?? res);
  },
});

const versely_start_automation = defineTool({
  name: "versely_start_automation",
  description:
    "Start (or resume) an automation. The next run happens right away, then on its schedule; each run spends " +
    "credits and posts when it is set to. Also resumes one paused for low credits or repeated failures.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<AutomationEnvelope>(
      `/api/v1/automations/${encodeURIComponent(input.automation_id)}/start`,
      {},
    );
    return jsonResult(res?.data?.automation ?? res);
  },
});

const versely_pause_automation = defineTool({
  name: "versely_pause_automation",
  description: "Pause an automation: no more runs until it is started again. A run already in progress finishes.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<AutomationEnvelope>(
      `/api/v1/automations/${encodeURIComponent(input.automation_id)}/pause`,
      {},
    );
    return jsonResult(res?.data?.automation ?? res);
  },
});

const versely_run_automation_now = defineTool({
  name: "versely_run_automation_now",
  description:
    "Make an active automation's next run happen now instead of waiting for its schedule. Spends that run's " +
    "credits (and posts, when it is set to). Follow it with versely_list_automation_runs.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<AutomationEnvelope>(
      `/api/v1/automations/${encodeURIComponent(input.automation_id)}/run-now`,
      {},
    );
    return jsonResult(res?.data?.automation ?? res);
  },
});

const versely_delete_automation = defineTool({
  name: "versely_delete_automation",
  description:
    "Delete an automation. No more runs; the slideshows it already made stay in the user's library.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.delete(`/api/v1/automations/${encodeURIComponent(input.automation_id)}`);
    return jsonResult(res);
  },
});

const versely_list_automation_runs = defineTool({
  name: "versely_list_automation_runs",
  description:
    "An automation's runs, newest first: status, credits charged, a one-line summary, what it made " +
    "(the slideshow id - open it with versely_get_slideshow) and any error.",
  inputSchema: z.object({
    automation_id: z.string().describe("Id from versely_list_automations."),
    limit: z.number().int().min(1).max(50).optional().describe("How many runs (default 20)."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<{ data?: { runs?: unknown[] } }>(
      `/api/v1/automations/${encodeURIComponent(input.automation_id)}/runs`,
      { query: { limit: input.limit } },
    );
    return jsonResult({ runs: res?.data?.runs ?? [] });
  },
});

export const automationTools: Tool[] = [
  versely_list_slideshow_options,
  versely_estimate_slideshow_automation,
  versely_create_slideshow_automation,
  versely_list_automations,
  versely_get_automation,
  versely_update_automation,
  versely_start_automation,
  versely_pause_automation,
  versely_run_automation_now,
  versely_delete_automation,
  versely_list_automation_runs,
];
