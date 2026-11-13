// Automations (backend /api/v1/automations, services/automations): saved
// formats that make posts when asked. Two kinds come through here: "slideshow"
// (a new slideshow for a category or one of the user's brands - drawn by an
// image model or pulled from Pinterest) and "ai_creator" (created and approved
// with the tools in aiCreator.ts; the generic tools below drive it after).
//
// Since 2026-10 an automation never runs on an interval. It rests until
// "Create posts" (POST /automations/:id/posts) queues N posts: they are made
// one after another, each charged as it is made, and booked one a day at the
// automation's posting time (`schedule`: one "HH:MM" in an IANA zone). A dry
// run of that call is the quote. Start resumes what is queued, Stop drops it.
//
// The backend validates a WHOLE config on every create and edit, so an edit
// here reads the current config and merges the changes into it.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { VerselyApiError } from "../errors.js";
import { toProviderAccountIds } from "./social.js";
import { analyzeLink } from "./brands.js";

const SLIDESHOW_KIND = "slideshow";
const CONTENT_TYPES = ["reel", "story", "post", "portrait", "landscape"] as const;
/** services/automations/postTimes.ts MAX_BULK_POSTS: posts one Create posts call can queue. */
const MAX_POSTS = 30;

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

const scheduleFields = {
  post_time: z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour.")
    .optional()
    .describe("The daily posting time, 'HH:MM' 24-hour (e.g. '18:00'), in timezone: each queued post goes out on its own day at this time."),
  timezone: z
    .string()
    .min(3)
    .max(64)
    .optional()
    .describe("IANA time zone of post_time, e.g. 'Europe/London' or 'America/New_York'. Ask the user; do not guess."),
};

/** The `schedule` body field for a posting time, merged with the current one on an edit. */
function scheduleFrom(
  input: { post_time?: string; timezone?: string },
  current?: unknown,
): { times: string[]; timezone: string } | undefined {
  if (input.post_time === undefined && input.timezone === undefined) return undefined;
  const cur = current && typeof current === "object" ? (current as { times?: unknown; timezone?: unknown }) : {};
  const time = input.post_time ?? (Array.isArray(cur.times) && typeof cur.times[0] === "string" ? cur.times[0] : undefined);
  const zone = input.timezone ?? (typeof cur.timezone === "string" ? cur.timezone : undefined);
  if (!time || !zone) throw new Error("Pass post_time and timezone together (ask the user for their time zone).");
  return { times: [time], timezone: zone };
}

/** The backend's refusal text for a 400 / 404 / 409, or null. */
function refusalText(err: unknown): string | null {
  if (!(err instanceof VerselyApiError) || ![400, 404, 409].includes(err.status)) return null;
  const body = (err.body ?? {}) as Record<string, unknown>;
  return typeof body.error === "string" && body.error ? body.error : typeof body.message === "string" ? body.message : null;
}

/** "Under Posting" is the app's screen; say which settings a tool call sets instead. */
function postingHint(text: string): string {
  return /posting time|account to post to/i.test(text)
    ? " Set them with versely_update_automation (post_time and timezone, post_account_ids)."
    : "";
}

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
    "subject categories, the user's brands and the credits per slide of an avatar slideshow. Read it before creating " +
    "a slideshow automation.",
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
      settle(
        ctx.client.get<{ data?: { models?: string[]; content_types?: string[]; avatar_model?: { credits_per_slide?: number } } }>(
          "/api/v1/slideshow/models",
        ),
      ),
      settle(ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/slideshow/caption-styles")),
      settle(ctx.client.get<{ categories?: Array<{ id: string; label: string }> }>("/api/v1/public-slideshows/categories")),
      settle(ctx.client.get<{ brand_kits?: Array<Record<string, unknown>> }>("/api/v1/agentic/brand-kit")),
    ]);
    return jsonResult({
      models: models?.data?.models ?? null,
      content_types: models?.data?.content_types ?? [...CONTENT_TYPES],
      // A slideshow made with one of the user's avatars (character_id) uses one fixed model at this price per slide.
      avatar_slide_credits: models?.data?.avatar_model?.credits_per_slide ?? null,
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
    "Credits one post of a slideshow automation would cost with these settings (the slideshow, plus the post for " +
    "each account it posts to), without saving anything. FREE. For an existing automation, " +
    "versely_quote_automation_posts gives the exact total for N posts.",
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
    "Save a slideshow automation: a slideshow format (a category or one of the user's brands, the picture model, " +
    "slides and captions), the accounts it posts to and a daily posting time. FREE: saving it makes, posts and " +
    "spends nothing. Slideshows are made only when versely_create_automation_posts queues them (a fresh topic each, " +
    "one post a day at the posting time), each charged as it is made. Options: versely_list_slideshow_options; " +
    "credits per post: versely_estimate_slideshow_automation.",
  inputSchema: z.object({
    name: z.string().min(1).max(80).describe("A name for the automation."),
    ...scheduleFields,
    brand_url: z
      .string()
      .url()
      .optional()
      .describe("A brand's link, when the brand isn't saved yet: it is read and saved (like versely_analyze_brand) and used as brand_kit_id."),
    ...slideshowConfigFields,
  }),
  handler: async (input, ctx) => {
    const schedule = scheduleFrom(input);
    if (input.brand_url && !input.brand_kit_id) {
      const read = await analyzeLink(ctx, input.brand_url);
      if (!read.kit) throw new Error("The brand link was read but could not be saved; try versely_analyze_brand.");
      (input as Record<string, unknown>).brand_kit_id = String(read.kit.id);
    }
    const config = await configFrom(ctx, input as Record<string, unknown>);
    let res: AutomationEnvelope;
    try {
      res = await ctx.client.post<AutomationEnvelope>("/api/v1/automations", {
        kind: SLIDESHOW_KIND,
        name: input.name,
        config: { source: "ai", ...config },
        ...(schedule ? { schedule } : {}),
      });
    } catch (err) {
      const text = refusalText(err);
      if (text) return errorResult(`Not saved: ${text}`);
      throw err;
    }
    const automation = res?.data?.automation;
    if (!automation) return jsonResult(res);
    return jsonResult({
      ...automation,
      next:
        "Saved; nothing is made yet. Quote posts with versely_quote_automation_posts, show the user the price and the " +
        "days, then queue them with versely_create_automation_posts.",
    });
  },
});

const versely_list_automations = defineTool({
  name: "versely_list_automations",
  description:
    "List the user's automations (slideshow automations and AI creators) with their status (active or paused, and " +
    "why), posting time, queued posts, next post, credits per post and spent so far, and the last run's result.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const res = await ctx.client.get<{ data?: { automations?: unknown[] } }>("/api/v1/automations");
    return jsonResult({ automations: res?.data?.automations ?? [] });
  },
});

const versely_get_automation = defineTool({
  name: "versely_get_automation",
  description: "Get one of the user's automations: its settings, status, posting time, queued posts and last run.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => jsonResult(await getAutomation(ctx, input.automation_id)),
});

const versely_update_automation = defineTool({
  name: "versely_update_automation",
  description:
    "Change a slideshow automation's name, posting time or settings. FREE. Only the fields given change; the rest " +
    "are kept. A new setting applies to posts made from now on; a new posting time to posts queued after the change. " +
    "For an AI creator use versely_update_ai_creator.",
  inputSchema: z.object({
    automation_id: z.string().describe("Id from versely_list_automations."),
    name: z.string().min(1).max(80).optional(),
    ...scheduleFields,
    ...slideshowConfigFields,
  }),
  handler: async (input, ctx) => {
    const { automation_id, name } = input;
    const changes = await configFrom(ctx, input as Record<string, unknown>);
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    const wantsSchedule = input.post_time !== undefined || input.timezone !== undefined;
    if (Object.keys(changes).length > 0 || wantsSchedule) {
      const current = await getAutomation(ctx, automation_id);
      if (Object.keys(changes).length > 0) {
        if (current.kind === "ai_creator") {
          throw new Error("That is an AI creator: change its settings with versely_update_ai_creator.");
        }
        const currentConfig =
          current.config && typeof current.config === "object" ? (current.config as Record<string, unknown>) : {};
        body.config = { ...currentConfig, ...changes };
      }
      if (wantsSchedule) body.schedule = scheduleFrom(input, current.schedule);
    }
    if (Object.keys(body).length === 0) throw new Error("Nothing to change: pass name, post_time and timezone, or a setting.");
    let res: AutomationEnvelope;
    try {
      res = await ctx.client.patch<AutomationEnvelope>(`/api/v1/automations/${encodeURIComponent(automation_id)}`, body);
    } catch (err) {
      const text = refusalText(err);
      if (text) return errorResult(`Not changed: ${text}`);
      throw err;
    }
    return jsonResult(res?.data?.automation ?? res);
  },
});

const versely_start_automation = defineTool({
  name: "versely_start_automation",
  description:
    "Resume an automation: the posts already queued with versely_create_automation_posts are made again, the next " +
    "one now, and a pause for low credits or repeated failures is lifted. An AI creator resumes its daily episodes " +
    "(each made about 3 hours before its daily time). Each post spends credits as it is made and publishes when the " +
    "automation posts to accounts. Refused when nothing is queued: queue posts with versely_create_automation_posts.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    let res: AutomationEnvelope;
    try {
      res = await ctx.client.post<AutomationEnvelope>(
        `/api/v1/automations/${encodeURIComponent(input.automation_id)}/start`,
        {},
      );
    } catch (err) {
      const text = refusalText(err);
      if (text && /nothing is waiting/i.test(text)) {
        return errorResult(
          "Not started: nothing is queued, so there is nothing to resume. Quote posts with versely_quote_automation_posts, " +
            "then queue them with versely_create_automation_posts.",
        );
      }
      if (text) return errorResult(`Not started: ${text}`);
      throw err;
    }
    return jsonResult(res?.data?.automation ?? res);
  },
});

const versely_pause_automation = defineTool({
  name: "versely_pause_automation",
  description:
    "Pause an automation: its queued posts wait (they are kept) until it is resumed with versely_start_automation. " +
    "A post already being made finishes.",
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
    "Queue one extra post now: it is made right away and booked on the next free day at the posting time (kept in " +
    "the library only when the automation has no account or posting time). Spends that post's credits " +
    "(versely_quote_automation_posts with count 1 shows them). For several posts use versely_create_automation_posts. " +
    "Follow it with versely_list_automation_runs.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<AutomationEnvelope>(
      `/api/v1/automations/${encodeURIComponent(input.automation_id)}/run-now`,
      {},
    );
    return jsonResult(res?.data?.automation ?? res);
  },
});

const PostsFields = {
  automation_id: z.string().describe("Id from versely_list_automations."),
  count: z.number().int().min(1).max(MAX_POSTS).describe(`How many posts, 1-${MAX_POSTS}: one a day at the posting time.`),
  schedule_posts: z
    .boolean()
    .optional()
    .describe("Book each post on the next free day at the posting time (default true). false keeps them in the library only."),
};

interface PostsPlan {
  post_at?: Array<string | null>;
  credits_total?: number | null;
  automation?: Record<string, unknown>;
}

async function postsCall(
  ctx: ToolContext,
  input: { automation_id: string; count: number; schedule_posts?: boolean },
  dryRun: boolean,
): Promise<PostsPlan> {
  const res = await ctx.client.post<{ data?: PostsPlan }>(
    `/api/v1/automations/${encodeURIComponent(input.automation_id)}/posts`,
    {
      count: input.count,
      ...(input.schedule_posts !== undefined ? { schedule_posts: input.schedule_posts } : {}),
      ...(dryRun ? { dry_run: true } : {}),
    },
  );
  return res?.data ?? {};
}

/** "2026-11-15T18:00:00.000Z, 2026-11-16T18:00:00.000Z" or "library only". */
function daysText(postAt: Array<string | null> | undefined): string {
  const days = (postAt ?? []).filter((d): d is string => typeof d === "string");
  if (!days.length) return "kept in the library only (not posted)";
  return days.length > 6 ? `${days.slice(0, 6).join(", ")} and ${days.length - 6} more` : days.join(", ");
}

const versely_quote_automation_posts = defineTool({
  name: "versely_quote_automation_posts",
  description:
    "The exact credits and the days for N posts of an automation, without queueing anything. FREE. Show the user both, " +
    "then pass credits_total as confirm_credits to versely_create_automation_posts.",
  inputSchema: z.object(PostsFields),
  handler: async (input, ctx) => {
    let plan: PostsPlan;
    try {
      plan = await postsCall(ctx, input, true);
    } catch (err) {
      const text = refusalText(err);
      if (text) return errorResult(`No quote: ${text}${postingHint(text)}`);
      throw err;
    }
    const total = plan.credits_total;
    return {
      content: [
        {
          type: "text",
          text:
            `${input.count} post${input.count === 1 ? "" : "s"}: ` +
            (typeof total === "number" ? `${total} credit${total === 1 ? "" : "s"} in all, charged as each is made` : "the price can't be worked out for these settings") +
            `. Days: ${daysText(plan.post_at)}.` +
            (typeof total === "number"
              ? ` Queue them only after the user says yes: versely_create_automation_posts { automation_id: ${JSON.stringify(input.automation_id)}, count: ${input.count}, confirm_credits: ${total} }.`
              : " Check the automation's picture model with versely_update_automation."),
        },
      ],
    };
  },
});

const versely_create_automation_posts = defineTool({
  name: "versely_create_automation_posts",
  description:
    "Queue N posts of an automation: they are made one after another starting now and go out one a day at its posting " +
    "time, to the accounts it posts to. PAID: each post spends its credits as it is made. Call it only after the user " +
    "saw the total and the days from versely_quote_automation_posts and said yes, passing that total as " +
    "confirm_credits; a changed price is refused, nothing queued. Stop the posts not made yet with " +
    "versely_stop_automation; follow them with versely_list_automation_runs.",
  inputSchema: z.object({
    ...PostsFields,
    confirm_credits: z
      .number()
      .min(0)
      .describe("The exact credits_total from versely_quote_automation_posts that the user approved."),
  }),
  handler: async (input, ctx) => {
    let quote: PostsPlan;
    try {
      quote = await postsCall(ctx, input, true);
    } catch (err) {
      const text = refusalText(err);
      if (text) return errorResult(`Not queued, nothing charged: ${text}${postingHint(text)}`);
      throw err;
    }
    if (typeof quote.credits_total !== "number") {
      return errorResult(
        "Not queued, nothing charged: the price can't be worked out for these settings. Check the automation's picture " +
          "model with versely_update_automation.",
      );
    }
    if (quote.credits_total !== input.confirm_credits) {
      return errorResult(
        `Not queued, nothing charged: ${input.count} post${input.count === 1 ? "" : "s"} now cost ${quote.credits_total} ` +
          `credits (you passed ${input.confirm_credits}). Show the user the new total and ask again; if they agree, call ` +
          `versely_create_automation_posts with confirm_credits: ${quote.credits_total}.`,
      );
    }
    let done: PostsPlan;
    try {
      done = await postsCall(ctx, input, false);
    } catch (err) {
      const text = refusalText(err);
      if (text) return errorResult(`Not queued, nothing charged: ${text}${postingHint(text)}`);
      throw err;
    }
    const name = typeof done.automation?.name === "string" ? `"${done.automation.name}"` : "the automation";
    return {
      content: [
        {
          type: "text",
          text:
            `Queued ${input.count} post${input.count === 1 ? "" : "s"} for ${name}: the first is being made now. Days: ` +
            `${daysText(done.post_at)}. About ${done.credits_total ?? quote.credits_total} credits in all, charged as each ` +
            "is made (a slideshow that fails is refunded). Follow them with versely_list_automation_runs; stop the ones " +
            "not made yet with versely_stop_automation.",
        },
      ],
    };
  },
});

const versely_stop_automation = defineTool({
  name: "versely_stop_automation",
  description:
    "Stop an automation: the posts queued but not made yet are dropped (never charged) and it is paused. Posts " +
    "already made and booked stay booked; cancel one with versely_delete_post. FREE. To make posts again, queue them " +
    "with versely_create_automation_posts (an AI creator resumes with versely_start_automation).",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<AutomationEnvelope>(
      `/api/v1/automations/${encodeURIComponent(input.automation_id)}/stop`,
      {},
    );
    const a = res?.data?.automation;
    if (!a) return jsonResult(res);
    return {
      content: [
        {
          type: "text",
          text:
            `Stopped "${String(a.name ?? input.automation_id)}": nothing else is queued and it is paused. Posts already ` +
            "made keep their booked times.",
        },
      ],
    };
  },
});

const versely_delete_automation = defineTool({
  name: "versely_delete_automation",
  description:
    "Delete an automation. Nothing more is made; what it already made stays in the user's library.",
  inputSchema: z.object({ automation_id: z.string().describe("Id from versely_list_automations.") }),
  handler: async (input, ctx) => {
    const res = await ctx.client.delete(`/api/v1/automations/${encodeURIComponent(input.automation_id)}`);
    return jsonResult(res);
  },
});

const versely_list_automation_runs = defineTool({
  name: "versely_list_automation_runs",
  description:
    "An automation's runs (one per post or episode made), newest first: status, credits charged, a one-line summary, " +
    "what it made (a slideshow id - open it with versely_get_slideshow) and any error.",
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
  versely_quote_automation_posts,
  versely_create_automation_posts,
  versely_stop_automation,
  versely_delete_automation,
  versely_list_automation_runs,
];
