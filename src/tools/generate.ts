import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { AsyncFields, handleAsync, type AsyncMode } from "./_async.js";
import { jsonResult } from "./_helpers.js";

const versely_list_models = defineTool({
  name: "versely_list_models",
  description:
    "List supported AI models. Optionally filter by media type (image / video / audio / lipsync) or provider.",
  inputSchema: z.object({
    type: z
      .enum(["image", "video", "audio", "lipsync", "all"])
      .optional()
      .describe("Filter by media type. Defaults to all."),
    provider: z
      .string()
      .optional()
      .describe("Filter by provider slug (e.g. 'fal', 'kie', 'runpod', 'replicate', 'suno')."),
  }),
  handler: async (input, ctx) => {
    let path = "/api/v1/generate/models";
    switch (input.type) {
      case "image":
        path = "/api/v1/ai-models/images";
        break;
      case "video":
        path = "/api/v1/ai-models/videos";
        break;
      case "audio":
        path = "/api/v1/ai-models/audio";
        break;
      case "lipsync":
        path = "/api/v1/ai-models/lipsync";
        break;
    }
    const data = await ctx.client.get(path, {
      query: { provider: input.provider },
    });
    return jsonResult(data);
  },
});

const versely_generate_image = defineTool({
  name: "versely_generate_image",
  description:
    "Generate one or more images (text-to-image, image-to-image, editing) using a chosen model. Default polls until done.",
  inputSchema: z
    .object({
      model: z
        .string()
        .describe(
          "Model slug (e.g. 'flux-2', 'imagen-4', 'nano-banana-2', 'midjourney-v7', 'gpt-image-2', 'recraft-4').",
        ),
      prompt: z.string().describe("Text prompt describing the desired image."),
      negative_prompt: z.string().optional(),
      n: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Number of images to generate."),
      aspect_ratio: z
        .string()
        .optional()
        .describe("e.g. '1:1', '16:9', '9:16', '4:3'."),
      size: z.string().optional().describe("Explicit dimensions, e.g. '1024x1024'."),
      image_urls: z
        .array(z.string().url())
        .optional()
        .describe("Reference images for image-to-image / editing modes."),
      seed: z.number().int().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/generate/image", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_generate_video = defineTool({
  name: "versely_generate_video",
  description:
    "Generate a video (text-to-video, image-to-video, frame-to-frame) using a chosen model. Default polls until done.",
  inputSchema: z
    .object({
      model: z
        .string()
        .describe(
          "Model slug (e.g. 'sora-2', 'veo-3.1', 'kling-2.5', 'hailuo-2.3', 'seedance-2.0', 'ltx-2.3').",
        ),
      prompt: z.string().describe("Text prompt for the video."),
      image_url: z
        .string()
        .url()
        .optional()
        .describe("Starting frame for image-to-video."),
      end_image_url: z
        .string()
        .url()
        .optional()
        .describe("End frame for frame-to-frame."),
      duration_seconds: z.number().positive().optional(),
      aspect_ratio: z.string().optional(),
      resolution: z.string().optional(),
      seed: z.number().int().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/generate/video", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_generate_audio = defineTool({
  name: "versely_generate_audio",
  description: "Generate speech / audio via TTS. Default polls until done.",
  inputSchema: z
    .object({
      model: z
        .string()
        .describe("TTS model slug (e.g. 'eleven-labs-multilingual-v2', 'cartesia-sonic')."),
      text: z.string(),
      voice: z.string().optional(),
      voice_id: z.string().optional(),
      language: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/generate/audio", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_generate_music = defineTool({
  name: "versely_generate_music",
  description:
    "Generate music with Suno (V3.5–V5.5). Returns a Suno taskId; default polls via the unified status endpoint.",
  inputSchema: z
    .object({
      prompt: z.string().describe("Style / mood / theme prompt."),
      lyrics: z
        .string()
        .optional()
        .describe("Custom lyrics (omit for instrumental or auto-lyrics)."),
      title: z.string().optional(),
      tags: z
        .string()
        .optional()
        .describe("Comma-separated style tags (e.g. 'pop, upbeat, electronic')."),
      instrumental: z.boolean().optional(),
      model_version: z.string().optional().describe("e.g. 'V4', 'V5'."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/suno/generate", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_extend_music = defineTool({
  name: "versely_extend_music",
  description: "Extend an existing Suno track from a given timestamp.",
  inputSchema: z
    .object({
      task_id: z.string().describe("Suno task_id of the source track."),
      audio_id: z.string().describe("Specific audio variant ID within the task."),
      continue_at_seconds: z
        .number()
        .nonnegative()
        .describe("Position in seconds to continue from."),
      prompt: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/suno/extend", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_generate_lipsync = defineTool({
  name: "versely_generate_lipsync",
  description: "Generate a lipsync video from a still image and an audio clip.",
  inputSchema: z
    .object({
      image_url: z.string().url(),
      audio_url: z.string().url(),
      model: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/generate/lipsync", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_remove_background = defineTool({
  name: "versely_remove_background",
  description: "Remove the background from an image.",
  inputSchema: z
    .object({
      image_url: z.string().url(),
      model: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post(
      "/api/v1/generate/background-removal",
      body,
    );
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_upscale_image = defineTool({
  name: "versely_upscale_image",
  description: "Upscale an image to higher resolution.",
  inputSchema: z
    .object({
      image_url: z.string().url(),
      model: z.string().optional(),
      scale_factor: z.number().positive().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/generate/image-upscale", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

const versely_upscale_video = defineTool({
  name: "versely_upscale_video",
  description: "Upscale a video to higher resolution.",
  inputSchema: z
    .object({
      video_url: z.string().url(),
      model: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    const submission = await ctx.client.post("/api/v1/generate/video-upscale", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
    });
  },
});

export const generateTools: Tool[] = [
  versely_list_models,
  versely_generate_image,
  versely_generate_video,
  versely_generate_audio,
  versely_generate_music,
  versely_extend_music,
  versely_generate_lipsync,
  versely_remove_background,
  versely_upscale_image,
  versely_upscale_video,
];
