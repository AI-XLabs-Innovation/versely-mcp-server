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

// Per-model voice catalog — each canonical TTS model declares which body
// field it expects voices on (`voice` vs `voice_id`), a sensible default
// for when the LLM omits it, the strict set of valid options for pre-submit
// validation, and whether to enforce the validation. Sourced from the
// frontend's hardcoded voice catalogs (content-creation-frontend/app/
// (main)/ai-speech.tsx). Three jobs at once:
//   (1) Description embeds the lists so the LLM picks the right voice
//       for each model and stops cross-pollinating IDs between providers.
//   (2) Default is filled in when no voice is supplied, so a bare
//       {model, text} call still works for FAL/RunPod models that reject
//       voice-less submissions.
//   (3) Validation rejects unknown voices at the MCP layer with an
//       informative error listing the valid ones — no wasted credits or
//       opaque "Task failed." downstream.
interface AudioModelProfile {
  voiceField: "voice" | "voice_id";
  defaultVoice: string;
  validVoices: readonly string[];
  /** When true, an unknown voice errors at the MCP layer. When false,
   *  the voice is passed through to the backend (used for providers like
   *  Minimax that accept hundreds of voice IDs we can't fully enumerate). */
  strict: boolean;
}

const AUDIO_MODEL_PROFILES: Record<string, AudioModelProfile> = {
  "qwen 3 tts 1.7b": {
    voiceField: "voice",
    defaultVoice: "Vivian",
    validVoices: ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"],
    strict: true,
  },
  "qwen 3 tts 0.6b": {
    voiceField: "voice",
    defaultVoice: "Vivian",
    validVoices: ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"],
    strict: true,
  },
  "grok tts": {
    voiceField: "voice",
    defaultVoice: "eve",
    validVoices: ["eve", "ara", "rex", "sal", "leo"],
    strict: true,
  },
  "chatterbox tts": {
    voiceField: "voice",
    defaultVoice: "Aaron",
    validVoices: [
      "Aaron", "Abigail", "Anaya", "Andy", "Archer", "Brian", "Chloe", "Dylan",
      "Emmanuel", "Ethan", "Evelyn", "Gavin", "Gordon", "Ivan", "Laura", "Lucy",
      "Madison", "Marisol", "Meera", "Walter",
    ],
    strict: true,
  },
  "chatterbox tts turbo": {
    voiceField: "voice",
    defaultVoice: "Aaron",
    validVoices: [
      "Aaron", "Abigail", "Anaya", "Andy", "Archer", "Brian", "Chloe", "Dylan",
      "Emmanuel", "Ethan", "Evelyn", "Gavin", "Gordon", "Ivan", "Laura", "Lucy",
      "Madison", "Marisol", "Meera", "Walter",
    ],
    strict: true,
  },
  "minimax speech": {
    voiceField: "voice_id",
    defaultVoice: "Wise_Woman",
    // Minimax has 100+ voice IDs (universal + per-language). We only
    // enumerate the universal ones for the LLM hint, but pass anything
    // through unvalidated so language-specific voices like
    // "English_Aussie_Bloke" still work.
    validVoices: [
      "Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man",
      "Calm_Woman", "Casual_Guy", "Lively_Girl", "Patient_Man", "Young_Knight",
      "Determined_Man", "Lovely_Girl", "Decent_Boy", "Imposing_Manner",
      "Elegant_Man", "Abbess", "Sweet_Girl_2", "Exuberant_Girl",
    ],
    strict: false,
  },
};

function lookupAudioProfile(modelName: string): AudioModelProfile | undefined {
  return AUDIO_MODEL_PROFILES[modelName.toLowerCase()];
}

function resolveValidVoice(profile: AudioModelProfile, supplied: string): string | undefined {
  const lower = supplied.toLowerCase();
  return profile.validVoices.find((v) => v.toLowerCase() === lower);
}

function buildAudioToolDescription(): string {
  const lines: string[] = [
    "Generate speech / audio via TTS. Default polls until done.",
    "",
    "Each model requires a voice id from its own catalog — cross-pollinating",
    "voices between providers (e.g. 'Adam' on Qwen, 'Ethan' on ElevenLabs) is",
    "the most common cause of failed jobs. When voice is omitted, a safe",
    "default is filled in for models that ship one. Invalid voices are",
    "rejected at the MCP layer with a list of valid options.",
    "",
    "If you need a voice ID for ANY model — especially ElevenLabs, Cartesia,",
    "Inworld, or a non-default Minimax voice — call **versely_list_voices**",
    "first instead of asking the user. It exposes every backend catalog with",
    "filters (query, language, gender, accent, tags) and tells you exactly",
    "which body field (`voice` vs `voice_id`) to pass here.",
    "",
    "Built-in defaults / quick reference (use exactly as written, case-sensitive):",
  ];
  for (const [model, profile] of Object.entries(AUDIO_MODEL_PROFILES)) {
    const display = model.replace(/\b\w/g, (c) => c.toUpperCase());
    const field = profile.voiceField === "voice_id" ? "voice_id" : "voice";
    const list = profile.validVoices.join(", ");
    const tail = profile.strict ? "" : " (also supports many language-specific voice IDs not listed — use versely_list_voices)";
    lines.push(`• ${display} → ${field}: ${list}${tail}`);
  }
  lines.push("");
  lines.push(
    "Eleven Labs Speech Turbo / Multilingual / Voice Change: voice is required and has no default. Call versely_list_voices(provider='elevenlabs', query=...) to pick one — do NOT ask the user.",
  );
  lines.push(
    "Cartesia and Inworld TTS: same — fetch IDs via versely_list_voices.",
  );
  return lines.join("\n");
}

const versely_generate_audio = defineTool({
  name: "versely_generate_audio",
  description: buildAudioToolDescription(),
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
          "Voice id for the chosen model. Per-model catalog is in the tool description; passing a voice from a different model's list (e.g. 'Ethan' on Qwen) errors at the MCP layer. Omit to use the model's default.",
        ),
      voice_id: z
        .string()
        .optional()
        .describe(
          "Alternative voice field for models that use voice_id (e.g. Minimax Speech). Treated as equivalent to `voice` by the MCP — pass whichever feels natural.",
        ),
      language: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    body.model = await resolveCanonicalModel(ctx, "audio", body.model);

    const profile = lookupAudioProfile(body.model);
    if (profile) {
      // Normalize: callers can pass either `voice` or `voice_id`; we route
      // the final value into the field name the backend expects for this
      // model and clear the other one so the dispatcher doesn't see both.
      const supplied =
        (typeof body.voice === "string" && body.voice.trim()) ||
        (typeof body.voice_id === "string" && body.voice_id.trim()) ||
        "";

      let finalVoice: string;
      if (!supplied) {
        finalVoice = profile.defaultVoice;
      } else if (profile.strict) {
        const matched = resolveValidVoice(profile, supplied);
        if (!matched) {
          throw new Error(
            `Voice "${supplied}" is not valid for ${body.model}. ` +
              `Valid voices: ${profile.validVoices.join(", ")}. ` +
              `Omit voice to use the default ("${profile.defaultVoice}").`,
          );
        }
        finalVoice = matched;
      } else {
        // Non-strict (e.g. Minimax): pass through as-is so language-specific
        // voice IDs not in our enumerated list still work.
        finalVoice = supplied;
      }

      if (profile.voiceField === "voice_id") {
        body.voice_id = finalVoice;
        delete body.voice;
      } else {
        body.voice = finalVoice;
        delete body.voice_id;
      }
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
