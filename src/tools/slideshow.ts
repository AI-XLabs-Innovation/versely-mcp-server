import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { metaForMediaCard } from "../ui/templates.js";

/**
 * The slideshow endpoints draw with their own model list (slideshowModelNames
 * server-side: seven hand-wired models plus every fal text-to-image endpoint
 * the payload builder can drive - 52 on 2026-09-24). It changes with the
 * catalog, so it is read live (versely_list_slideshow_options) rather than
 * frozen here: the frozen enum still offered the retired "Imagen 4 Ultra" and
 * refused the other 45. An unknown name is refused by the backend before any
 * charge, with the supported list.
 */
const SlideshowImageModel = z
  .string()
  .min(1)
  .describe(
    "Slideshow image model (default 'Flux Pro Ultra'): a name from versely_list_slideshow_options `models` (e.g. " +
      "'Nano Banana Pro', 'GPT Image 2', 'Seedream 5.0 Pro'). Slideshows have their own list: not every model from versely_find_models works here.",
  );

const versely_create_slideshow = defineTool({
  name: "versely_create_slideshow",
  description:
    "Create a slideshow by generating multiple AI images from a prompt (no automation, no overlays).",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      prompt: z.string(),
      model: SlideshowImageModel.optional(),
      num_images: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many images to generate (default 5). Each image is charged."),
      n: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Deprecated alias for num_images — prefer num_images."),
      aspect_ratio: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { n, ...body } = input;
    // Backend counts with num_images; a bare `n` was read nowhere, so every
    // slideshow silently generated (and charged for) the 5-image default.
    if (body.num_images === undefined && n !== undefined) body.num_images = n;
    const data = await ctx.client.post("/api/v1/slideshow/create", body, {
      timeoutMs: SYNC_TIMEOUT_MS,
    });
    return mediaResult(data, {
      kind: "gallery",
      toolName: "versely_create_slideshow",
      toolArgs: body,
      extra: { prompt: input.prompt, model: input.model, aspect_ratio: input.aspect_ratio },
    });
  },
});

const versely_create_automated_slideshow = defineTool({
  name: "versely_create_automated_slideshow",
  description:
    "Full automation: AI plans the slideshow (a fresh hook and slide captions for the topic), draws the slides and " +
    "puts the captions on them. The slides render in the background and the inline card fills in as they land " +
    "(or check with versely_get_slideshow). Pick a caption_style from versely_list_slideshow_options for a styled " +
    "look; otherwise classic white captions are used.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      prompt: z
        .string()
        .optional()
        .describe("Topic / theme for the slideshow. Required (or pass the legacy `topic`)."),
      num_images: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many slides to generate (default 5, max 20). Each is charged."),
      model: SlideshowImageModel.optional(),
      aspect_ratio: z.string().optional(),
      content_type: z.string().optional().describe("Output framing, e.g. 'reel' (default)."),
      style: z.string().optional(),
      theme: z.string().optional(),
      text_style: z
        .record(z.unknown())
        .optional()
        .describe("Styling for the burned-in overlay text (font, colour, background, …)."),
      caption_style: z
        .string()
        .optional()
        .describe("A caption style id from versely_list_slideshow_options (e.g. 'pink-pop'); replaces text_style."),
      topic: z.string().optional().describe("Deprecated alias for prompt — prefer prompt."),
      n_slides: z
        .number()
        .int()
        .min(2)
        .max(20)
        .optional()
        .describe("Deprecated alias for num_images — prefer num_images."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { topic, n_slides, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    // Backend reads prompt / num_images and 400s on "prompt is required"; the old
    // topic / n_slides names were read nowhere, so this tool never worked.
    if (body.prompt === undefined && topic !== undefined) body.prompt = topic;
    if (body.num_images === undefined && n_slides !== undefined) body.num_images = n_slides;
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      throw new Error("`prompt` is required (the legacy `topic` field is accepted as an alias).");
    }
    // Server-side captions: without bake_overlays the planned captions were
    // never put on the slides (the web studio bakes in the browser).
    body.bake_overlays = true;
    if (!body.caption_style && (!body.text_style || typeof body.text_style !== "object")) {
      body.text_style = STUDIO_TEXT_STYLE;
    }
    const data = await ctx.client.post("/api/v1/slideshow/create-automated", body, {
      timeoutMs: SYNC_TIMEOUT_MS,
    });
    return startedSlideshowResult(ctx, data, { toolName: "versely_create_automated_slideshow", toolArgs: body });
  },
});

/**
 * The studio's caption look (automations' withStudioCaptionDefaults). With
 * bake_overlays the finaliser stamps the planned captions on in this style;
 * without it the slides came back bare, because the web studio bakes in the
 * browser and a server-driven caller has no browser.
 */
export const STUDIO_TEXT_STYLE = {
  font_family: "tiktoksans",
  stroke_width: 2,
  stroke_color: "#000000",
  text_color: "#FFFFFF",
  background: "none",
};

/** How often, and for how long, a slideshow card follows its slides. */
const SLIDESHOW_POLL = { interval_ms: 5000, timeout_ms: 15 * 60_000 };

/**
 * A slideshow as media-card state: pending while its slides render (with the
 * ones already done), then every slide - the captioned copy when there is one.
 * The finaliser bakes captions BEFORE it marks the slideshow done, so
 * "completed" always means captioned.
 */
export function slideshowCardState(payload: unknown): Record<string, unknown> | null {
  const d = ((payload as { data?: unknown } | null)?.data ?? payload) as Record<string, any> | null;
  if (!d || typeof d !== "object" || !d.id) return null;
  const images = (Array.isArray(d.images) ? [...d.images] : []).sort(
    (a: any, b: any) => (Number(a?.order_index) || 0) - (Number(b?.order_index) || 0),
  );
  const assets = images
    .map((img: any, i: number) => ({ url: img?.edited_image_url || img?.image_url, label: `Slide ${i + 1}` }))
    .filter((a) => typeof a.url === "string" && a.url);
  const generating = d.is_generating === true || d.status === "generating";
  const status = generating ? "pending" : d.status === "failed" ? "failed" : "completed";
  const total = typeof d.num_images === "number" && d.num_images > 0 ? d.num_images : images.length;
  return {
    kind: "gallery",
    status,
    task_id: d.id,
    slideshow_id: d.id,
    assets,
    ...(status === "pending" && total ? { progress: Math.min(1, assets.length / total) } : {}),
    ...(typeof d.prompt === "string" && d.prompt ? { prompt: d.prompt.slice(0, 200) } : {}),
    ...(d.model ? { model: d.model } : {}),
    ...(status === "failed" ? { error: "The slideshow could not be generated; its credits are refunded." } : {}),
    ...(d.status === "partial" ? { message: "Some slides could not be generated and were refunded." } : {}),
  };
}

/** The media-card result for a slideshow: self-polling while it renders. */
export function slideshowResult(payload: unknown, opts: { toolName?: string; toolArgs?: Record<string, unknown> } = {}): ToolResult {
  const sc = slideshowCardState(payload);
  if (!sc) return jsonResult(payload);
  const id = String(sc.slideshow_id);
  const assets = sc.assets as Array<{ url: string }>;
  const pending = sc.status === "pending";
  const text = pending
    ? `Slideshow ${id} is generating (${assets.length} slide${assets.length === 1 ? "" : "s"} ready so far). ` +
      `If an inline preview is shown it updates on its own; otherwise call versely_get_slideshow with ` +
      `slideshow_id="${id}" to check it. Do not describe it as finished until it says completed.`
    : sc.status === "failed"
      ? `Slideshow ${id} failed: ${String(sc.error)}`
      : `Slideshow ${id} is ready: ${assets.length} slide${assets.length === 1 ? "" : "s"}.\n` +
        assets.map((a, i) => `${i + 1}. ${a.url}`).join("\n") +
        (sc.message ? `\n${String(sc.message)}` : "");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      ...sc,
      ...(pending ? { poll: { tool_name: "versely_get_slideshow", args: { slideshow_id: id }, ...SLIDESHOW_POLL } } : {}),
      ...(opts.toolName ? { toolName: opts.toolName } : {}),
      ...(opts.toolArgs ? { toolArgs: opts.toolArgs } : {}),
    },
  };
}

/**
 * POST /slideshow/create-automated answers straight away with the slideshow
 * id and no slides (they render in the background). Read it back so the card
 * starts from the real row and follows it.
 */
export async function startedSlideshowResult(
  ctx: ToolContext,
  submission: unknown,
  opts: { toolName: string; toolArgs: Record<string, unknown> },
): Promise<ToolResult> {
  const id = (submission as { data?: { slideshow_id?: unknown } } | null)?.data?.slideshow_id;
  if (typeof id !== "string" || !id) return mediaResult(submission, { kind: "gallery", ...opts });
  try {
    const row = await ctx.client.get(`/api/v1/slideshow/${encodeURIComponent(id)}`);
    const result = slideshowResult(row, opts);
    if (result.structuredContent) return result;
  } catch {
    /* fall back to the pending card below */
  }
  return slideshowResult({ data: { id, status: "generating", is_generating: true, images: [] } }, opts);
}

const versely_get_slideshow = defineTool({
  name: "versely_get_slideshow",
  description:
    "Get one of the user's slideshows: whether it is still generating, and its slides (the captioned versions once " +
    "they are baked). Also what the slideshow card calls to follow one that is generating.",
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({ slideshow_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/slideshow/${encodeURIComponent(input.slideshow_id)}`,
    );
    return slideshowResult(data);
  },
});

const versely_list_slideshows = defineTool({
  name: "versely_list_slideshows",
  description: "List the authenticated user's slideshows (paginated, newest first).",
  inputSchema: z
    .object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Page size (default 20)."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("How many to skip (default 0). Use for paging, not `page`."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    // Pagination is read from the QUERY STRING server-side; sending it in the body
    // (as this tool used to) was silently ignored → always the first 20.
    const { limit, offset } = input;
    const data = await ctx.client.post("/api/v1/slideshow/user/list", {}, {
      query: { limit, offset },
    });
    return jsonResult(data);
  },
});

const versely_delete_slideshow = defineTool({
  name: "versely_delete_slideshow",
  description: "Delete a slideshow and all its images.",
  inputSchema: z.object({ slideshow_id: z.string() }),
  handler: async (input, ctx) => {
    // deleteSlideshow does `const { user_id } = req.body`, and under Express 5 a
    // bodyless DELETE leaves req.body === undefined → TypeError → 500. Sending an
    // empty JSON body gives body-parser something to parse, which lets the route's
    // enforceUserId middleware inject user_id from the token (it guards on
    // `req.body && typeof req.body === "object"`). Ownership is then enforced properly.
    const data = await ctx.client.request(
      "DELETE",
      `/api/v1/slideshow/${encodeURIComponent(input.slideshow_id)}`,
      { body: {} },
    );
    return jsonResult(data);
  },
});

const versely_add_slideshow_images = defineTool({
  name: "versely_add_slideshow_images",
  description: "Generate and append more AI images to an existing slideshow.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      slideshow_id: z.string(),
      prompt: z.string(),
      num_images: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many images to append (default 3). Each image is charged."),
      n: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Deprecated alias for num_images — prefer num_images."),
      model: SlideshowImageModel.optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { slideshow_id, n, ...body } = input;
    // Backend counts with num_images; `n` was read nowhere → always the 3-image default.
    if (body.num_images === undefined && n !== undefined) body.num_images = n;
    const data = await ctx.client.post(
      `/api/v1/slideshow/${encodeURIComponent(slideshow_id)}/images`,
      body,
      { timeoutMs: SYNC_TIMEOUT_MS },
    );
    return mediaResult(data, {
      kind: "gallery",
      toolName: "versely_add_slideshow_images",
      toolArgs: body,
      extra: { prompt: input.prompt, model: input.model },
    });
  },
});

const versely_add_text_overlay = defineTool({
  name: "versely_add_text_overlay",
  description:
    "Burn text overlays onto a slideshow's images. Pass an array of overlays (one per slide or shared).",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      slideshow_id: z.string(),
      overlays: z
        .array(
          z
            .object({
              image_id: z
                .string()
                .optional()
                .describe("Slideshow image ID (preferred). Either this or image_url is required."),
              image_url: z.string().url().optional().describe("Direct image URL (fallback)."),
              text: z.string().describe("Overlay text. Required and non-empty."),
              position: z
                .enum(["top", "center", "bottom", "middle"])
                .optional()
                .describe(
                  "Vertical placement (default 'bottom'). The server's value is 'center' — 'middle' is accepted here and converted (the API rejects it outright).",
                ),
              x: z.number().min(0).max(100).optional().describe("X as % from left; overrides position."),
              y: z.number().min(0).max(100).optional().describe("Y as % from top; overrides position."),
              font_size: z
                .number()
                .positive()
                .optional()
                .describe("<1 is treated as a fraction of height (0.04 = 4%); >=1 as pixels."),
              font_family: z.string().optional().describe("e.g. 'Arial', 'Impact'."),
              text_color: z.string().optional().describe("Hex, e.g. '#FFFFFF'."),
              background: z
                .string()
                .optional()
                .describe("'none' | 'solid' | 'gradient', or a CSS colour for a custom solid backdrop."),
              background_color: z.string().optional().describe("Used when background is 'solid'."),
              font: z.string().optional().describe("Deprecated alias for font_family."),
              color: z.string().optional().describe("Deprecated alias for text_color."),
            })
            .passthrough(),
        )
        .min(1),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { slideshow_id, overlays, ...rest } = input;
    // The server validates position against ["top","center","bottom"] and REJECTS
    // "middle" with a 400 — it does not coerce. It also reads font_family/text_color,
    // never font/color.
    const mapped = (overlays as Array<Record<string, unknown>>).map((o) => {
      const { font, color, position, ...keep } = o;
      const out: Record<string, unknown> = { ...keep };
      if (position !== undefined) out.position = position === "middle" ? "center" : position;
      if (out.font_family === undefined && font !== undefined) out.font_family = font;
      if (out.text_color === undefined && color !== undefined) out.text_color = color;
      return out;
    });
    const body = { ...rest, overlays: mapped };
    const data = await ctx.client.post(
      `/api/v1/slideshow/${encodeURIComponent(slideshow_id)}/text-overlay`,
      body,
      { timeoutMs: SYNC_TIMEOUT_MS },
    );
    return mediaResult(data, {
      kind: "gallery",
      toolName: "versely_add_text_overlay",
      toolArgs: body,
    });
  },
});

const versely_slideshow_to_video = defineTool({
  name: "versely_slideshow_to_video",
  description:
    "Compile a slideshow's images (and optional audio) into an MP4 video with transitions (server-side FFmpeg).",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      slideshow_id: z.string(),
      duration_per_image: z
        .number()
        .positive()
        .optional()
        .describe("Seconds each image is held on screen (default 3)."),
      duration_per_slide_seconds: z
        .number()
        .positive()
        .optional()
        .describe("Deprecated alias for duration_per_image — prefer duration_per_image."),
      transition: z.string().optional().describe("Transition between slides (default 'none')."),
      audio_url: z.string().url().optional(),
      voiceover_url: z.string().url().optional(),
      music_url: z.string().url().optional(),
      output_resolution: z.enum(["720p", "1080p", "4k"]).optional().describe("Default '1080p'."),
      aspect_ratio: z
        .enum(["reel", "story", "post", "landscape", "portrait"])
        .optional()
        .describe(
          "Named preset (default 'reel'). NOT a ratio string — '9:16' etc. will not match.",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { slideshow_id, duration_per_slide_seconds, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    // Backend reads duration_per_image; duration_per_slide_seconds was read nowhere,
    // so every slide silently used the 3s default.
    if (body.duration_per_image === undefined && duration_per_slide_seconds !== undefined) {
      body.duration_per_image = duration_per_slide_seconds;
    }
    const data = await ctx.client.post(
      `/api/v1/slideshow/${encodeURIComponent(slideshow_id)}/video`,
      body,
      { timeoutMs: SYNC_TIMEOUT_MS },
    );
    return mediaResult(data, {
      kind: "video",
      toolName: "versely_slideshow_to_video",
      toolArgs: input,
      // No duration chip: the per-slide hold time shown as "3s" read as the video's length.
      extra: { aspect_ratio: input.aspect_ratio },
    });
  },
});

export const slideshowTools: Tool[] = [
  versely_create_slideshow,
  versely_create_automated_slideshow,
  versely_get_slideshow,
  versely_list_slideshows,
  versely_delete_slideshow,
  versely_add_slideshow_images,
  versely_add_text_overlay,
  versely_slideshow_to_video,
];
