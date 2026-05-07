import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult } from "./_helpers.js";

const versely_create_slideshow = defineTool({
  name: "versely_create_slideshow",
  description:
    "Create a slideshow by generating multiple AI images from a prompt (no automation, no overlays).",
  inputSchema: z
    .object({
      prompt: z.string(),
      model: z.string().optional(),
      n: z.number().int().min(1).max(20).optional(),
      aspect_ratio: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/slideshow/create", input);
    return jsonResult(data);
  },
});

const versely_create_automated_slideshow = defineTool({
  name: "versely_create_automated_slideshow",
  description:
    "Full automation: AI plans the slideshow, generates the images, and burns text overlays in one request.",
  inputSchema: z
    .object({
      topic: z.string().describe("Topic / theme for the slideshow."),
      n_slides: z.number().int().min(2).max(20).optional(),
      style: z.string().optional(),
      aspect_ratio: z.string().optional(),
      model: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/slideshow/create-automated", input);
    return jsonResult(data);
  },
});

const versely_get_slideshow = defineTool({
  name: "versely_get_slideshow",
  description: "Get a slideshow by ID, including its images.",
  inputSchema: z.object({ slideshow_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/slideshow/${encodeURIComponent(input.slideshow_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_list_slideshows = defineTool({
  name: "versely_list_slideshows",
  description: "List the authenticated user's slideshows (paginated).",
  inputSchema: z
    .object({
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/slideshow/user/list", input);
    return jsonResult(data);
  },
});

const versely_delete_slideshow = defineTool({
  name: "versely_delete_slideshow",
  description: "Delete a slideshow and all its images.",
  inputSchema: z.object({ slideshow_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/slideshow/${encodeURIComponent(input.slideshow_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_add_slideshow_images = defineTool({
  name: "versely_add_slideshow_images",
  description: "Generate and append more AI images to an existing slideshow.",
  inputSchema: z
    .object({
      slideshow_id: z.string(),
      prompt: z.string(),
      n: z.number().int().min(1).max(10).optional(),
      model: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { slideshow_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/slideshow/${encodeURIComponent(slideshow_id)}/images`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_add_text_overlay = defineTool({
  name: "versely_add_text_overlay",
  description:
    "Burn text overlays onto a slideshow's images. Pass an array of overlays (one per slide or shared).",
  inputSchema: z
    .object({
      slideshow_id: z.string(),
      overlays: z
        .array(
          z
            .object({
              image_id: z.string().optional(),
              text: z.string(),
              position: z.enum(["top", "middle", "bottom"]).optional(),
              font: z.string().optional(),
              color: z.string().optional(),
            })
            .passthrough(),
        )
        .min(1),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { slideshow_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/slideshow/${encodeURIComponent(slideshow_id)}/text-overlay`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_slideshow_to_video = defineTool({
  name: "versely_slideshow_to_video",
  description:
    "Compile a slideshow's images (and optional audio) into an MP4 video with transitions (server-side FFmpeg).",
  inputSchema: z
    .object({
      slideshow_id: z.string(),
      duration_per_slide_seconds: z.number().positive().optional(),
      transition: z.string().optional().describe("e.g. 'fade', 'slide', 'crossfade'."),
      audio_url: z.string().url().optional(),
      aspect_ratio: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { slideshow_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/slideshow/${encodeURIComponent(slideshow_id)}/video`,
      body,
    );
    return jsonResult(data);
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
