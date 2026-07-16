import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { AsyncFields, handleAsync, type AsyncMode } from "./_async.js";
import { jsonResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";

/** Seconds → "HH:MM:SS", the only time format /features/extract-frames accepts. */
function secondsToHms(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

const versely_extract_frames = defineTool({
  name: "versely_extract_frames",
  description:
    "Extract frames from a video, evenly spaced across a time range. Note: the backend extracts N frames across a [start, end] window — it cannot extract an arbitrary list of individual timestamps.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      video_url: z.string().url(),
      start_seconds: z
        .number()
        .nonnegative()
        .optional()
        .describe("Start of the extraction window, in seconds (default 0)."),
      end_seconds: z
        .number()
        .positive()
        .optional()
        .describe("End of the extraction window, in seconds. Defaults to 1s after start."),
      frame_count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How many frames to extract, evenly spaced across the window (default 1)."),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Deprecated alias for frame_count — prefer frame_count."),
      fps: z.number().positive().optional().describe("Sampling rate (default 1)."),
      output_format: z
        .enum(["png", "jpg", "jpeg", "webp"])
        .optional()
        .describe("Frame image format (default 'png')."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const {
      mode,
      poll_timeout_ms,
      poll_interval_ms,
      start_seconds,
      end_seconds,
      count,
      ...rest
    } = input;
    const body: Record<string, unknown> = { ...rest };

    // The backend reads start_time/end_time as "HH:MM:SS" and frame_count. The old
    // timestamps_seconds/count fields were read nowhere, so every call silently
    // returned exactly one frame from the first second of the video.
    if (body.frame_count === undefined && count !== undefined) body.frame_count = count;
    const start = start_seconds ?? 0;
    body.start_time = secondsToHms(start);
    body.end_time = secondsToHms(end_seconds ?? start + 1);

    const submission = await ctx.client.post("/api/v1/features/extract-frames", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "image",
      toolName: "versely_extract_frames",
      toolArgs: body,
    });
  },
});

const versely_merge_videos = defineTool({
  name: "versely_merge_videos",
  description: "Merge multiple videos into a single video (server-side FFmpeg).",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      video_urls: z.array(z.string().url()).min(1),
      transition_type: z
        .enum(["concat", "fade", "dissolve", "wipe"])
        .optional()
        .describe("Transition between clips (default 'concat' = hard cut)."),
      transition: z
        .string()
        .optional()
        .describe("Deprecated alias for transition_type — prefer transition_type."),
      transition_duration: z
        .number()
        .positive()
        .optional()
        .describe("Transition length in seconds (default 0.5). Ignored for 'concat'."),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      maintain_aspect_ratio: z.boolean().optional(),
      audio_handling: z.string().optional().describe("How to handle source audio (default 'merge')."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, transition, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    // Backend reads transition_type; a bare `transition` was read nowhere, so every
    // merge silently used the hard-cut default.
    if (body.transition_type === undefined && transition !== undefined) {
      body.transition_type = transition;
    }
    const submission = await ctx.client.post("/api/v1/features/merge-videos", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "video",
      toolName: "versely_merge_videos",
      toolArgs: body,
    });
  },
});

const versely_generate_prompt = defineTool({
  name: "versely_generate_prompt",
  description:
    "Use Gemini to expand a brief idea into a richer generation prompt. Free — starts no generation.\n\n" +
    "`content_type: 'speech'` switches to the spoken-delivery enhancer, which rewrites the text for TTS " +
    "(pacing, emphasis, pronunciation) and returns { enhanced_text, style_suggestion?, provider_scheme? }. " +
    "Pair it with target_provider/mood/language before calling versely_generate_audio.\n\n" +
    "Only 'image', 'video' and 'speech' are supported — there is no music prompt enhancer.",
  inputSchema: z
    .object({
      description: z
        .string()
        .optional()
        .describe("Short concept to expand into a full prompt. Required (or pass the legacy `idea`)."),
      content_type: z
        .enum(["image", "video", "speech"])
        .optional()
        .describe("What the prompt is for (default 'image'). 'speech' uses the TTS-delivery enhancer."),
      style: z.string().optional(),
      model: z.string().optional().describe("Target model, to tailor the prompt's phrasing."),
      aspect_ratio: z.string().optional(),
      creativity: z.enum(["low", "medium", "high"]).optional().describe("Default 'medium'."),
      include_negative: z.boolean().optional().describe("Also return a negative prompt."),
      target_provider: z
        .enum([
          "elevenlabs",
          "chatterbox",
          "grok",
          "inworld",
          "cartesia",
          "gemini",
          "qwen3",
          "minimax",
        ])
        .optional()
        .describe("speech only — tailors the output to that TTS provider's markup scheme."),
      mood: z.string().optional().describe("speech only — e.g. 'excited', 'somber'."),
      language: z.string().optional().describe("speech only — target language."),
      idea: z.string().optional().describe("Deprecated alias for description — prefer description."),
      target: z
        .enum(["image", "video", "music", "any"])
        .optional()
        .describe("Deprecated alias for content_type — prefer content_type."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { idea, target, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    // Backend requires `description` and reads `content_type`; the old idea/target
    // fields were read nowhere, so every call 400'd on "description is required".
    if (body.description === undefined && idea !== undefined) body.description = idea;
    if (body.content_type === undefined && target !== undefined && target !== "any" && target !== "music") {
      body.content_type = target;
    }
    if (typeof body.description !== "string" || !body.description.trim()) {
      throw new Error("`description` is required (the legacy `idea` field is accepted as an alias).");
    }
    const data = await ctx.client.post("/api/v1/features/generate-prompt", body);
    return jsonResult(data);
  },
});

const versely_colorize_photo = defineTool({
  name: "versely_colorize_photo",
  description: "Colorize a grayscale or faded photo.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      image_url: z.string().url(),
      saturation: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Colour intensity, 0–1. Must be a number if provided."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    // /features/* mounts authenticateUser but NOT enforceUserId (unlike /slideshow,
    // /ugc, /movie, /social), so nothing injects req.body.user_id and this endpoint
    // 400s without it. Supply it from the authenticated identity.
    body.user_id = await ctx.client.getCurrentUserId();
    const submission = await ctx.client.post("/api/v1/features/colorize-photo", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "image",
      toolName: "versely_colorize_photo",
      toolArgs: body,
    });
  },
});

const versely_audio_isolation = defineTool({
  name: "versely_audio_isolation",
  description: "Isolate vocals (or remove background noise) from an audio clip.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      audio_url: z.string().url(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    // See versely_colorize_photo: /features/* has no enforceUserId, so user_id
    // must be supplied explicitly or the endpoint 400s.
    body.user_id = await ctx.client.getCurrentUserId();
    const submission = await ctx.client.post("/api/v1/features/audio-isolation", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "audio",
      toolName: "versely_audio_isolation",
      toolArgs: body,
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
