import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { AsyncFields, handleAsync, type AsyncMode } from "./_async.js";
import { jsonResult } from "./_helpers.js";
import { resolveCanonicalModel } from "./_modelResolver.js";
import { metaForMediaCard } from "../ui/templates.js";

const versely_list_models = defineTool({
  name: "versely_list_models",
  description:
    "List supported AI models with full metadata (rankings, descriptions, etc.). Response is large — prefer versely_find_models for discovery; use this only when full metadata is genuinely needed. Optionally filter by media type or provider.",
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

interface BackendModel {
  slug?: string;
  name?: string;
  provider?: string;
  content_type?: string;
  categories?: string[];
  credits?: number;
  is_featured?: boolean;
  is_premium?: boolean;
  requires_image?: boolean;
}

interface ModelsListResponse {
  data?: { models?: BackendModel[]; total?: number };
}

const FIND_MODELS_PATHS: Record<"image" | "video" | "audio" | "lipsync", string> = {
  image: "/api/v1/ai-models/images",
  video: "/api/v1/ai-models/videos",
  audio: "/api/v1/ai-models/audio",
  lipsync: "/api/v1/ai-models/lipsync",
};

const versely_find_models = defineTool({
  name: "versely_find_models",
  description:
    "Discover AI model slugs for image / video / audio / lipsync generation. Returns a slim shape (slug, name, provider, categories, credits, featured/premium flags). ALWAYS call this first to find the exact slug before invoking versely_generate_image / versely_generate_video / versely_generate_audio / versely_generate_lipsync — model slugs change frequently and guessing leads to 'Model not supported' errors. Filter by name substring (q), media type, provider, category, or featured/premium flags.",
  inputSchema: z.object({
    type: z
      .enum(["image", "video", "audio", "lipsync"])
      .optional()
      .describe("Filter by media type. If omitted, searches across all four types."),
    q: z
      .string()
      .optional()
      .describe(
        "Case-insensitive substring match on model slug + name (e.g. 'flux ultra', 'kling', 'sora').",
      ),
    provider: z
      .string()
      .optional()
      .describe(
        "Filter by provider name (e.g. 'Flux', 'OpenAI', 'Google', 'ByteDance'). Case-insensitive.",
      ),
    category: z
      .string()
      .optional()
      .describe(
        "Filter by category. Valid values per type: image → 'text-to-image', 'image-to-image', 'edit-image'; video → 'text-to-video', 'image-to-video', 'edit-video'; audio → 'text-to-audio', 'voice-clone', 'audio-to-audio', 'audio-to-text'; lipsync → 'text-to-lipsync', 'image-to-lipsync', 'audio-to-lipsync', 'video-to-lipsync'.",
      ),
    is_featured: z.boolean().optional().describe("Only return featured models."),
    is_premium: z
      .boolean()
      .optional()
      .describe("If true, only premium models; if false, only non-premium."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results returned. Default 30."),
  }),
  handler: async (input, ctx) => {
    const types = input.type
      ? [input.type]
      : (["image", "video", "audio", "lipsync"] as const);

    const baseQuery: Record<string, string | boolean | undefined> = {};
    if (input.category) baseQuery.category = input.category;
    if (input.is_featured !== undefined) baseQuery.is_featured = input.is_featured;

    // For audio, restrict to models the unified /api/v1/generate/audio
    // dispatcher actually serves — the catalog also lists per-provider
    // entries (Cartesia/Inworld/Suno Sounds) that only work through
    // dedicated routes used by the web app, not through MCP's submit path.
    // Image/video/lipsync don't have this split, so they get the base query.
    const responses = await Promise.all(
      types.map((t) => {
        const query: Record<string, string | boolean | undefined> = { ...baseQuery };
        if (t === "audio") query.dispatcher_only = "true";
        return ctx.client.get<ModelsListResponse>(FIND_MODELS_PATHS[t], { query });
      }),
    );

    const merged: BackendModel[] = [];
    for (const r of responses) {
      const list = r?.data?.models;
      if (Array.isArray(list)) merged.push(...list);
    }

    // Tokenize q: split on whitespace, require every token to appear in the haystack.
    // Hyphens in slugs are normalized to spaces so 'flux pro ultra' matches 'flux-pro-ultra'.
    const qTokens = input.q
      ? input.q.toLowerCase().trim().split(/\s+/).filter(Boolean)
      : [];
    const provLower = input.provider?.toLowerCase().trim();

    const filtered = merged.filter((m) => {
      if (qTokens.length > 0) {
        const hay = `${m.slug ?? ""} ${m.name ?? ""}`.toLowerCase().replace(/-/g, " ");
        if (!qTokens.every((tok) => hay.includes(tok))) return false;
      }
      if (provLower) {
        const p = String(m.provider ?? "").toLowerCase();
        if (p !== provLower && !p.includes(provLower)) return false;
      }
      if (input.is_premium !== undefined && Boolean(m.is_premium) !== input.is_premium) {
        return false;
      }
      return true;
    });

    const limit = input.limit ?? 30;
    const slim = filtered.slice(0, limit).map((m) => ({
      slug: m.slug,
      name: m.name,
      type: m.content_type,
      provider: m.provider,
      categories: m.categories ?? [],
      credits: m.credits,
      is_featured: Boolean(m.is_featured),
      is_premium: Boolean(m.is_premium),
      requires_image: Boolean(m.requires_image),
    }));

    return jsonResult({
      total: filtered.length,
      returned: slim.length,
      truncated: filtered.length > slim.length,
      models: slim,
    });
  },
});

const versely_generate_image = defineTool({
  name: "versely_generate_image",
  description:
    "Generate one or more images (text-to-image, image-to-image, editing) using a chosen model. Default polls until done.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      model: z
        .string()
        .describe(
          "Image model — pass either the slug (e.g. 'flux-pro-ultra') or the canonical name (e.g. 'Flux Pro Ultra'). The MCP resolves either form to the dispatcher's expected name. Call versely_find_models with type='image' first to discover valid identifiers.",
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
    body.model = await resolveCanonicalModel(ctx, "image", body.model);
    const submission = await ctx.client.post("/api/v1/generate/image", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "image",
      toolName: "versely_generate_image",
      toolArgs: body,
      extra: { model: body.model, prompt: input.prompt, aspect_ratio: input.aspect_ratio, size: input.size },
    });
  },
});

const versely_generate_video = defineTool({
  name: "versely_generate_video",
  description:
    "Generate a video (text-to-video, image-to-video, frame-to-frame) using a chosen model. Default polls until done.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      model: z
        .string()
        .describe(
          "Video model — pass either the slug or the canonical name. Call versely_find_models with type='video' first to discover valid identifiers.",
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
    body.model = await resolveCanonicalModel(ctx, "video", body.model);
    const submission = await ctx.client.post("/api/v1/generate/video", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "video",
      toolName: "versely_generate_video",
      toolArgs: body,
      extra: {
        model: body.model,
        prompt: input.prompt,
        aspect_ratio: input.aspect_ratio,
        duration_seconds: input.duration_seconds,
      },
    });
  },
});

// Per-model default voice. Many TTS providers (FAL/RunPod/KIE) reject the
// submission outright when no voice is supplied (Qwen FAL: "Either 'voice'
// or 'speaker_voice_embedding_file_url' must be provided"). Filling a
// sensible default lets the LLM call versely_generate_audio with just
// model + text. Lowercased canonical name → voice id, sourced from the
// frontend's hardcoded voice catalogs (ai-speech.tsx).
const AUDIO_VOICE_DEFAULTS: Record<string, string> = {
  "qwen 3 tts 1.7b": "Vivian",
  "qwen 3 tts 0.6b": "Vivian",
  "grok tts": "eve",
  "minimax speech": "Wise_Woman",
  "chatterbox tts": "Aaron",
  "chatterbox tts turbo": "Aaron",
};

const versely_generate_audio = defineTool({
  name: "versely_generate_audio",
  description:
    "Generate speech / audio via TTS. Default polls until done. Most providers require a voice; if omitted, a sensible default is applied (e.g. 'Vivian' for Qwen, 'eve' for Grok, 'Wise_Woman' for Minimax). Pass voice explicitly to override.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      model: z
        .string()
        .describe(
          "TTS / audio model — pass either the slug or the canonical name. Call versely_find_models with type='audio' first to discover valid identifiers.",
        ),
      text: z.string(),
      voice: z
        .string()
        .optional()
        .describe(
          "Voice id for the chosen model. Defaults applied when omitted: Qwen→'Vivian', Grok→'eve', Minimax→'Wise_Woman', Chatterbox→'Aaron'. ElevenLabs / KIE models require a user-supplied valid voice id (no safe default).",
        ),
      voice_id: z.string().optional(),
      language: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    body.model = await resolveCanonicalModel(ctx, "audio", body.model);
    // Fill in the default voice when LLM didn't pass one. Only kicks in
    // for models we have a known-good default for; others (ElevenLabs etc.)
    // surface the provider's own validation error so the LLM/user can
    // supply a valid voice on retry.
    if (!body.voice && !body.voice_id) {
      const fallback = AUDIO_VOICE_DEFAULTS[body.model.toLowerCase()];
      if (fallback) body.voice = fallback;
    }
    const submission = await ctx.client.post("/api/v1/generate/audio", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "audio",
      toolName: "versely_generate_audio",
      toolArgs: body,
      extra: { model: body.model, prompt: input.text },
    });
  },
});

const versely_generate_music = defineTool({
  name: "versely_generate_music",
  description:
    "Generate music with Suno (V3.5–V5.5). Returns a Suno taskId; default polls via the unified status endpoint.",
  meta: metaForMediaCard(),
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
      kind: "audio",
      toolName: "versely_generate_music",
      toolArgs: body,
      extra: {
        model: input.model_version ? `Suno ${input.model_version}` : "Suno",
        prompt: input.prompt,
        ...(input.lyrics ? { lyrics: input.lyrics } : {}),
        ...(input.title ? { title: input.title } : {}),
      },
    });
  },
});

const versely_extend_music = defineTool({
  name: "versely_extend_music",
  description: "Extend an existing Suno track from a given timestamp.",
  meta: metaForMediaCard(),
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
      kind: "audio",
      toolName: "versely_extend_music",
      toolArgs: body,
    });
  },
});

const versely_generate_lipsync = defineTool({
  name: "versely_generate_lipsync",
  description: "Generate a lipsync video from a still image and an audio clip.",
  meta: metaForMediaCard(),
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
    if (body.model !== undefined) {
      body.model = await resolveCanonicalModel(ctx, "lipsync", body.model);
    }
    const submission = await ctx.client.post("/api/v1/generate/lipsync", body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "video",
      toolName: "versely_generate_lipsync",
      toolArgs: body,
      extra: body.model ? { model: body.model } : {},
    });
  },
});

const versely_remove_background = defineTool({
  name: "versely_remove_background",
  description: "Remove the background from an image.",
  meta: metaForMediaCard(),
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
      kind: "image",
      toolName: "versely_remove_background",
      toolArgs: body,
    });
  },
});

const versely_upscale_image = defineTool({
  name: "versely_upscale_image",
  description: "Upscale an image to higher resolution.",
  meta: metaForMediaCard(),
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
      kind: "image",
      toolName: "versely_upscale_image",
      toolArgs: body,
    });
  },
});

const versely_upscale_video = defineTool({
  name: "versely_upscale_video",
  description: "Upscale a video to higher resolution.",
  meta: metaForMediaCard(),
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
      kind: "video",
      toolName: "versely_upscale_video",
      toolArgs: body,
    });
  },
});

export const generateTools: Tool[] = [
  versely_find_models,
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
