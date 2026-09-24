// Templates the user starts from: AI templates (one-tap effects - Finger Snap,
// Mugshot, Pet Hip Hop...), public workflow templates (copied into the user's
// workflows), public slideshow templates (made again with their own prompt
// and settings), and restyling a slideshow with one of the caption styles.
// versely_browse shows each of these visually for the user to pick.

import { z } from "zod";
import { defineTool, type Tool, type ToolResult } from "./_types.js";
import { jsonResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { metaForMediaCard } from "../ui/templates.js";
import { STUDIO_TEXT_STYLE, slideshowResult, startedSlideshowResult } from "./slideshow.js";

/** AI template runs: queued / running / waiting_webhook while they work. */
const TEMPLATE_RUN_POLL = { interval_ms: 5000, timeout_ms: 15 * 60_000 };

function templateRunCard(run: Record<string, any> | null | undefined, runId: string): ToolResult {
  const status = String(run?.status ?? "queued");
  const done = status === "completed";
  const failed = status === "failed";
  const url = typeof run?.final_asset_url === "string" ? run.final_asset_url : "";
  const kind = /\.(png|jpe?g|webp)(\?|$)/i.test(url) ? "image" : "video";
  const cardStatus = done ? "completed" : failed ? "failed" : "pending";
  const text = done
    ? `AI template run ${runId} is done: ${url}`
    : failed
      ? `AI template run ${runId} failed: ${String(run?.error_message ?? "it could not be finished")}.`
      : `AI template run ${runId} is ${status.replace(/_/g, " ")}. If an inline preview is shown it updates on its own; ` +
        `otherwise call versely_get_ai_template_run with run_id="${runId}". Do not call it finished before it says so.`;
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      kind,
      status: cardStatus,
      task_id: runId,
      assets: done && url ? [{ url }] : [],
      ...(run?.template_id ? { model: String(run.template_id).replace(/_/g, " ") } : {}),
      ...(failed ? { error: String(run?.error_message ?? "The template run failed.") } : {}),
      ...(cardStatus === "pending"
        ? { poll: { tool_name: "versely_get_ai_template_run", args: { run_id: runId }, ...TEMPLATE_RUN_POLL } }
        : {}),
    },
  };
}

const versely_run_ai_template = defineTool({
  name: "versely_run_ai_template",
  description:
    "Run one of Versely's AI templates - one-tap trending effects like Finger Snap, Mugshot, Pet Hip Hop or Tiger Hug - " +
    "on the user's own photo or video. Show the choice with versely_browse (ai_templates); a pick says which inputs " +
    "the template needs (e.g. user_image_url). Spends the user's Versely credits (the estimate is on the template); " +
    "the inline card updates itself when it is done.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    template_id: z.string().describe("The template id, e.g. 'finger_snap' (versely_browse ai_templates)."),
    inputs: z
      .record(z.string())
      .describe("The template's inputs by field name, e.g. { \"user_image_url\": \"https://...\" }. Media must be public https URLs."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<{ data?: { runId?: string } }>("/api/v1/templates/runs", {
      templateId: input.template_id,
      inputs: input.inputs,
    });
    const runId = res?.data?.runId;
    if (typeof runId !== "string" || !runId) return jsonResult(res);
    const card = templateRunCard({ status: "queued", template_id: input.template_id }, runId);
    return {
      ...card,
      structuredContent: { ...card.structuredContent, toolName: "versely_run_ai_template", toolArgs: input },
    };
  },
});

const versely_get_ai_template_run = defineTool({
  name: "versely_get_ai_template_run",
  description: "Check an AI template run started with versely_run_ai_template: working, done (with the result) or failed.",
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({ run_id: z.string() }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<{ data?: Record<string, any> }>(`/api/v1/templates/runs/${encodeURIComponent(input.run_id)}`);
    return templateRunCard(res?.data, input.run_id);
  },
});

const versely_use_workflow_template = defineTool({
  name: "versely_use_workflow_template",
  description:
    "Copy one of Versely's public workflow templates (versely_browse workflow_templates) into the user's own " +
    "workflows, ready to run with versely_run_workflow or to schedule with versely_update_workflow_mode. Copying " +
    "spends nothing; runs do.",
  inputSchema: z.object({
    template: z.string().describe("The template's slug or id (from versely_browse workflow_templates)."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post<{ workflow_id?: string; name?: string }>(
      `/api/v1/public-workflows/${encodeURIComponent(input.template)}/clone`,
      {},
    );
    return jsonResult({
      workflow_id: res?.workflow_id,
      name: res?.name,
      next: res?.workflow_id
        ? `Run it with versely_run_workflow (workflow_id "${res.workflow_id}"), or schedule it with versely_update_workflow_mode.`
        : undefined,
    });
  },
});

const versely_use_slideshow_template = defineTool({
  name: "versely_use_slideshow_template",
  description:
    "Make one of Versely's public slideshow templates (versely_browse slideshow_templates) for the user: the " +
    "template's own prompt, slide count, shape and model, with captions. `topic` swaps in the user's own subject. " +
    "Spends the user's Versely credits; the inline card fills in as the slides land.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    template: z.string().describe("The template's slug or id (from versely_browse slideshow_templates)."),
    topic: z.string().max(300).optional().describe("The user's own subject, in place of the template's."),
    caption_style: z.string().optional().describe("A slideshow style id (versely_browse slideshow_styles); default classic captions."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<{ template?: Record<string, any>; data?: Record<string, any> } & Record<string, any>>(
      `/api/v1/public-slideshows/${encodeURIComponent(input.template)}`,
    );
    const t = (res?.template ?? res?.data ?? res) as Record<string, any>;
    const prompt = input.topic?.trim() || String(t?.recreate_prompt ?? t?.title ?? "").trim();
    if (!prompt) throw new Error(`Template ${input.template} has no prompt to make it from.`);
    const body: Record<string, unknown> = {
      prompt,
      num_images: typeof t?.num_images === "number" ? t.num_images : 5,
      content_type: typeof t?.content_type === "string" ? t.content_type : "reel",
      ...(typeof t?.model === "string" && t.model ? { model: t.model } : {}),
      bake_overlays: true,
      ...(input.caption_style ? { caption_style: input.caption_style } : { text_style: STUDIO_TEXT_STYLE }),
    };
    const started = await ctx.client.post("/api/v1/slideshow/create-automated", body, { timeoutMs: SYNC_TIMEOUT_MS });
    // The template's "made again" count (a vanity metric; never blocks).
    void ctx.client.post(`/api/v1/public-slideshows/${encodeURIComponent(input.template)}/recreate`, {}).catch(() => {});
    return startedSlideshowResult(ctx, started, { toolName: "versely_use_slideshow_template", toolArgs: input });
  },
});

const versely_apply_caption_style = defineTool({
  name: "versely_apply_caption_style",
  description:
    "Restyle one of the user's slideshows: re-bake its captions in a slideshow style (versely_browse " +
    "slideshow_styles shows them with example slides). The slide pictures stay; only the caption look changes.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    slideshow_id: z.string(),
    caption_style: z.string().describe("A style id, e.g. 'pink-pop' (versely_browse slideshow_styles)."),
  }),
  handler: async (input, ctx) => {
    await ctx.client.post(
      `/api/v1/slideshow/${encodeURIComponent(input.slideshow_id)}/caption-style`,
      { caption_style: input.caption_style },
      { timeoutMs: SYNC_TIMEOUT_MS },
    );
    const row = await ctx.client.get(`/api/v1/slideshow/${encodeURIComponent(input.slideshow_id)}`);
    return slideshowResult(row, { toolName: "versely_apply_caption_style", toolArgs: input });
  },
});

export const templateTools: Tool[] = [
  versely_run_ai_template,
  versely_get_ai_template_run,
  versely_use_workflow_template,
  versely_use_slideshow_template,
  versely_apply_caption_style,
];
