import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { AsyncFields, handleAsync, type AsyncMode } from "./_async.js";
import { jsonResult, mediaResult } from "./_helpers.js";
import { metaForTemplate } from "../ui/templates.js";

const CaptionPosition = z.enum(["top", "middle", "bottom"]);

const versely_add_video_overlay = defineTool({
  name: "versely_add_video_overlay",
  description:
    "Overlay a foreground video (e.g. talking head) on top of a base video, positioned in a corner.",
  meta: metaForTemplate("video-player"),
  inputSchema: z
    .object({
      base_video_url: z.string().url(),
      overlay_video_url: z.string().url(),
      position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
        .optional(),
      scale: z
        .number()
        .positive()
        .max(1)
        .optional()
        .describe("Overlay size as a fraction of base video width (0-1)."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/ugc/add-video-overlay", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      template: "video-player",
    });
  },
});

const versely_add_captions = defineTool({
  name: "versely_add_captions",
  description: "Add a single static caption to a video at top / middle / bottom.",
  meta: metaForTemplate("video-player"),
  inputSchema: z
    .object({
      video_url: z.string().url(),
      caption_text: z.string(),
      position: CaptionPosition.optional(),
      font: z.string().optional(),
      font_size: z.number().int().positive().optional(),
      color: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/ugc/add-captions", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      template: "video-player",
    });
  },
});

const versely_add_timestamped_captions = defineTool({
  name: "versely_add_timestamped_captions",
  description:
    "Auto-transcribe a video's audio and burn timestamped captions onto it (Reels-style).",
  meta: metaForTemplate("video-player"),
  inputSchema: z
    .object({
      video_url: z.string().url(),
      style: z.string().optional().describe("Caption style preset."),
      position: CaptionPosition.optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post(
      "/api/v1/ugc/add-timestamped-captions",
      body,
    );
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      template: "video-player",
    });
  },
});

const versely_compose_with_overlay = defineTool({
  name: "versely_compose_with_overlay",
  description:
    "Stitch a sequence of images/videos into a base composition and optionally overlay another video on top.",
  meta: metaForTemplate("video-player"),
  inputSchema: z
    .object({
      media_urls: z.array(z.string().url()).min(1).describe("Images or video clips to stitch."),
      overlay_video_url: z.string().url().optional(),
      overlay_position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
        .optional(),
      audio_url: z.string().url().optional(),
      duration_per_item_seconds: z.number().positive().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post(
      "/api/v1/ugc/compose-with-overlay",
      body,
    );
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      template: "video-player",
    });
  },
});

const versely_get_ugc = defineTool({
  name: "versely_get_ugc",
  description: "Get a UGC video by ID.",
  meta: metaForTemplate("video-player"),
  inputSchema: z.object({
    ugc_id: z.string(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/ugc/${encodeURIComponent(input.ugc_id)}`,
    );
    return mediaResult(data, { template: "video-player" });
  },
});

export const ugcTools: Tool[] = [
  versely_add_video_overlay,
  versely_add_captions,
  versely_add_timestamped_captions,
  versely_compose_with_overlay,
  versely_get_ugc,
];
