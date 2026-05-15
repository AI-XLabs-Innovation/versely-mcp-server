import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { AsyncFields, handleAsync, type AsyncMode } from "./_async.js";
import { jsonResult } from "./_helpers.js";
import { metaForTemplate } from "../ui/templates.js";

const versely_extract_frames = defineTool({
  name: "versely_extract_frames",
  description: "Extract frames from a video at given timestamps or evenly spaced.",
  meta: metaForTemplate("image-viewer"),
  inputSchema: z
    .object({
      video_url: z.string().url(),
      timestamps_seconds: z.array(z.number().nonnegative()).optional(),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Evenly extract this many frames if timestamps are not given."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/features/extract-frames", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      template: "image-viewer",
    });
  },
});

const versely_merge_videos = defineTool({
  name: "versely_merge_videos",
  description: "Merge multiple videos into a single video (server-side FFmpeg).",
  meta: metaForTemplate("video-player"),
  inputSchema: z
    .object({
      video_urls: z.array(z.string().url()).min(2),
      transition: z
        .string()
        .optional()
        .describe("Optional transition (e.g. 'fade', 'crossfade')."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/features/merge-videos", body);
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

const versely_generate_prompt = defineTool({
  name: "versely_generate_prompt",
  description:
    "Use Gemini to expand a brief idea into a richer image / video / music generation prompt.",
  inputSchema: z
    .object({
      idea: z.string().describe("Short concept to expand into a full prompt."),
      target: z
        .enum(["image", "video", "music", "any"])
        .optional()
        .describe("Target media type for the prompt style."),
      style: z.string().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/features/generate-prompt", input);
    return jsonResult(data);
  },
});

const versely_colorize_photo = defineTool({
  name: "versely_colorize_photo",
  description: "Colorize a grayscale or faded photo.",
  meta: metaForTemplate("image-viewer"),
  inputSchema: z
    .object({
      image_url: z.string().url(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/features/colorize-photo", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      template: "image-viewer",
    });
  },
});

const versely_audio_isolation = defineTool({
  name: "versely_audio_isolation",
  description: "Isolate vocals (or remove background noise) from an audio clip.",
  meta: metaForTemplate("audio-player"),
  inputSchema: z
    .object({
      audio_url: z.string().url(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/features/audio-isolation", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      template: "audio-player",
    });
  },
});

export const featuresTools: Tool[] = [
  versely_extract_frames,
  versely_merge_videos,
  versely_generate_prompt,
  versely_colorize_photo,
  versely_audio_isolation,
];
