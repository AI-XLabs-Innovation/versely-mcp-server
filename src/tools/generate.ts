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
      .describe(
        "Filter by the catalog's `provider` value, matched exactly server-side. This is the model's brand/vendor as stored on the row (what versely_find_models reports as `provider`) — NOT the routing backend ('fal' / 'kie' / 'runpod'), which is chosen server-side and is not filterable. If unsure, omit this and filter the results yourself; a wrong value silently returns zero models.",
      ),
  }),
  handler: async (input, ctx) => {
    // 'all' used to hit /generate/models, which sits behind userCreditsMiddleware:
    // a zero-credit user got a 403 merely for LISTING models, and it burned the
    // cost-sensitive rate limit (30/min). /ai-models/ is the same catalog, public,
    // and on the generous public limiter.
    let path = "/api/v1/ai-models/";
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
  /** User-facing label. `name` stays the immutable dispatch key. */
  display_name?: string;
  provider?: string;
  content_type?: string;
  categories?: string[];
  /** Raw DB column — quoted at the APP rate. See creditNote() below. */
  credits?: number;
  is_featured?: boolean;
  is_premium?: boolean;
  requires_image?: boolean;
  released_at?: string;
  /** Reference-input support (reference_image_urls / _video_urls / _audio_urls). */
  reference_config?: Record<string, unknown> | null;
  max_reference?: number | null;
  /** Video/lipsync only — attached from constants/videoInputModels. */
  accepts_video_input?: boolean;
  requires_video_input?: boolean;
  video_input_field?: string | null;
  max_video_inputs?: number | null;
  /** Per-model discount (KIE per-model + blanket RunPod), resolved server-side. */
  is_discounted?: boolean;
  discount_percent?: number | null;
  discounted_credits?: number | null;
  /** Resolution/duration-tiered pricing, incl. minCredits/maxCredits. */
  price_matrix?: Record<string, unknown> | null;
  best_rank_overall?: number | null;
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
    "Discover AI models for image / video / audio / lipsync generation. ALWAYS call this before versely_generate_image / _video / _audio / _lipsync — guessing leads to 'Model not supported'.\n\n" +
    "Pass the returned `name` (or `slug`) to the generate tools. `display_name`, when present, is only a human label — the dispatcher does not accept it.\n\n" +
    "`credits` is indicative RELATIVE cost, not the amount you'll be charged — see credits_note in the response. Models with `min_credits`/`max_credits` are priced per resolution/duration.\n\n" +
    "Feature models (upscale, background removal, colorization) and unsupported-surface models (storyboard, inpainting) are excluded by default — they have dedicated tools (versely_upscale_image / versely_upscale_video / versely_remove_background / versely_colorize_photo) and would fail here. Set include_feature_models to see them.",
  inputSchema: z.object({
    type: z
      .enum(["image", "video", "audio", "lipsync"])
      .optional()
      .describe("Filter by media type. If omitted, searches across all four types."),
    include_feature_models: z
      .boolean()
      .optional()
      .describe(
        "Include upscale / background-removal / colorization / storyboard / inpaint models, which are hidden by default. They are not callable via the generate tools.",
      ),
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
        "Filter by category. Valid values per type: image → 'text-to-image', 'image-to-image', 'edit-image'; video → 'text-to-video', 'image-to-video', 'edit-video', 'reference-to-video', 'extend-video', 'motion-control', 'audio-to-video'; audio → 'text-to-audio', 'voice-clone', 'audio-to-audio', 'audio-to-text'; lipsync → 'text-to-lipsync', 'image-to-lipsync', 'audio-to-lipsync', 'video-to-lipsync'.",
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
        // image/video/lipsync have no dispatcher_only support, but ?pickable=true
        // drops the rows the generate dispatcher can't serve (upscale, bg-removal,
        // colorization, storyboard, inpaint) — each of which has its own tool.
        if (t !== "audio" && !input.include_feature_models) query.pickable = "true";
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
    const slim = filtered.slice(0, limit).map((m) => {
      const pm = (m.price_matrix ?? {}) as Record<string, unknown>;
      const minCredits = typeof pm.minCredits === "number" ? pm.minCredits : undefined;
      const maxCredits = typeof pm.maxCredits === "number" ? pm.maxCredits : undefined;
      const refCfg = m.reference_config ?? undefined;
      return {
        slug: m.slug,
        // `name` is the dispatch key — always pass THIS to the generate tools.
        name: m.name,
        // display_name is the human label; it can differ from name and is not
        // accepted by the dispatcher.
        ...(m.display_name && m.display_name !== m.name
          ? { display_name: m.display_name }
          : {}),
        type: m.content_type,
        provider: m.provider,
        categories: m.categories ?? [],
        credits: m.credits,
        ...(minCredits !== undefined ? { min_credits: minCredits } : {}),
        ...(maxCredits !== undefined ? { max_credits: maxCredits } : {}),
        ...(m.is_discounted
          ? {
              is_discounted: true,
              discount_percent: m.discount_percent ?? undefined,
              discounted_credits: m.discounted_credits ?? undefined,
            }
          : {}),
        is_featured: Boolean(m.is_featured),
        is_premium: Boolean(m.is_premium),
        requires_image: Boolean(m.requires_image),
        ...(m.released_at ? { released_at: m.released_at } : {}),
        ...(typeof m.best_rank_overall === "number"
          ? { rank: m.best_rank_overall }
          : {}),
        // Reference inputs: pass reference_image_urls / reference_video_urls /
        // reference_audio_urls to the generate tools when a model declares support.
        ...(refCfg ? { reference_config: refCfg } : {}),
        ...(typeof m.max_reference === "number" ? { max_reference: m.max_reference } : {}),
        ...(m.accepts_video_input
          ? {
              accepts_video_input: true,
              requires_video_input: Boolean(m.requires_video_input),
              video_input_field: m.video_input_field ?? undefined,
              max_video_inputs: m.max_video_inputs ?? undefined,
            }
          : {}),
      };
    });

    return jsonResult({
      total: filtered.length,
      returned: slim.length,
      truncated: filtered.length > slim.length,
      // The catalog's `credits` column is stored at the APP rate (20 credits/USD).
      // API-key callers — i.e. everyone reaching this MCP — are billed at
      // CREDITS_PER_USD_API (10/USD), because only routes wrapped in
      // setCreditContext price in the caller's context and the catalog endpoints
      // are not. So the numbers here are indicative ordering, not the amount that
      // will actually be deducted. Say so rather than quoting them as fact.
      credits_note:
        "`credits` / `min_credits` / `max_credits` come from the catalog and are quoted at the app rate. API-key usage is billed at a different rate, so treat these as RELATIVE cost only. For an exact quote, POST /api/v1/ai-models/calculate-credits, which prices in the caller's own credit context.",
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
      num_images: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Number of images to generate (default 1). Each image is charged separately."),
      n: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Deprecated alias for num_images — prefer num_images."),
      aspect_ratio: z
        .string()
        .optional()
        .describe("e.g. '1:1', '16:9', '9:16', '4:3'."),
      resolution: z
        .string()
        .optional()
        .describe(
          "Resolution tier for resolution-priced models (e.g. '1K', '2K', '4K' for GPT Image 2 / Nano Banana Pro). Higher tiers cost more credits. Note: '1:1' cannot use 4K, and aspect_ratio 'auto' is limited to 1K.",
        ),
      image_urls: z
        .array(z.string().url())
        .optional()
        .describe("Reference images for image-to-image / editing modes."),
      seed: z.number().int().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, n, ...body } = input;
    body.model = await resolveCanonicalModel(ctx, "image", body.model);
    // Backend counts images with `num_images` (chat.controller / general.controller);
    // a bare `n` is read nowhere and silently yielded exactly one image.
    if (body.num_images === undefined && n !== undefined) body.num_images = n;
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
      extra: {
        model: body.model,
        prompt: input.prompt,
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
        num_images: body.num_images,
      },
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
      image_urls: z
        .array(z.string().url())
        .optional()
        .describe(
          "Starting frame(s) for image-to-video. Equivalent to image_url; use either. Required by models whose name contains 'Image to Video'.",
        ),
      end_image_url: z
        .string()
        .url()
        .optional()
        .describe("End frame for frame-to-frame (first-last-frame) models."),
      duration_seconds: z
        .number()
        .positive()
        .optional()
        .describe("Clip length in seconds. Drives BOTH generation and credit cost — omit and you get (and pay for) the 5s default."),
      aspect_ratio: z.string().optional(),
      resolution: z.string().optional(),
      seed: z.number().int().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    body.model = await resolveCanonicalModel(ctx, "video", body.model);

    // The backend reads `duration` (chat.controller / runpod.controller) and prices
    // on it. `duration_seconds` is read nowhere: every request silently generated
    // AND billed at the 5s default. Send `duration` as the authoritative field.
    if (body.duration === undefined && body.duration_seconds !== undefined) {
      body.duration = body.duration_seconds;
    }

    // Image-to-video routing: generate.controller's model-requirement validation and
    // its per-model provider-head selection only inspect image_urls | images | image |
    // first_frame_url — never the singular image_url. Sending only image_url made an
    // I2V request look like T2V, so the I2V provider head was dropped from the chain
    // (silent wrong output) or the request 400'd on "Model requirements not met".
    // Send the array for routing; keep image_url, which FAL reads directly.
    const firstFrame =
      (Array.isArray(body.image_urls) && body.image_urls[0]) || body.image_url;
    if (firstFrame) {
      if (!Array.isArray(body.image_urls) || body.image_urls.length === 0) {
        body.image_urls = [firstFrame];
      }
      if (!body.image_url) body.image_url = firstFrame;
      if (!body.first_frame_url) body.first_frame_url = firstFrame;
    }
    // Frame-to-frame models read last_frame_url, not end_image_url.
    if (body.end_image_url && !body.last_frame_url) {
      body.last_frame_url = body.end_image_url;
    }

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

/** Suno model versions the backend accepts (VALID_MODELS in sunoApi.controller). */
const SunoModel = z.enum(["V3_5", "V4", "V4_5", "V4_5PLUS", "V4_5ALL", "V5", "V5_5"]);

const versely_generate_music = defineTool({
  name: "versely_generate_music",
  description:
    "Generate music with Suno. Returns a Suno taskId; default polls via the unified status endpoint.\n\n" +
    "Two modes:\n" +
    "• **Inspiration** (default, `custom_mode: false`) — `prompt` is a free-form description of the song; Suno writes the lyrics and picks the style.\n" +
    "• **Custom** (`custom_mode: true`) — `prompt` becomes the LITERAL LYRICS, and `style` + `title` are then required.\n\n" +
    "There is no separate lyrics field: to supply your own lyrics, set custom_mode:true and put them in `prompt`.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      prompt: z
        .string()
        .describe(
          "In default mode: a description of the song. In custom_mode: the literal lyrics to sing.",
        ),
      model: SunoModel.optional().describe(
        "Suno model version (default V5) — required by the backend. Underscored form (V4_5PLUS), not 'V4.5+'.",
      ),
      instrumental: z
        .boolean()
        .default(false)
        .describe("No vocals. Required by the backend and must be a boolean."),
      custom_mode: z
        .boolean()
        .optional()
        .describe("Treat `prompt` as literal lyrics. Requires `style` and `title`."),
      style: z
        .string()
        .optional()
        .describe("Musical style, e.g. 'pop, upbeat, electronic'. Required when custom_mode is true."),
      title: z.string().optional().describe("Track title. Required when custom_mode is true."),
      negative_tags: z.string().optional().describe("Styles to avoid."),
      vocal_gender: z.enum(["m", "f"]).optional(),
      style_weight: z.number().min(0).max(1).optional(),
      weirdness_constraint: z.number().min(0).max(1).optional(),
      audio_weight: z.number().min(0).max(1).optional(),
      persona_id: z.string().optional(),
      model_version: z
        .string()
        .optional()
        .describe("Deprecated alias for model (e.g. 'V4') — prefer model."),
      tags: z.string().optional().describe("Deprecated alias for style — prefer style."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const {
      mode,
      poll_timeout_ms,
      poll_interval_ms,
      model_version,
      tags,
      custom_mode,
      negative_tags,
      vocal_gender,
      style_weight,
      weirdness_constraint,
      audio_weight,
      persona_id,
      ...rest
    } = input;
    const body: Record<string, unknown> = { ...rest };

    // The controller reads customMode/model/style/personaId/negativeTags/vocalGender/
    // styleWeight/weirdnessConstraint/audioWeight — camelCase, and hard-400s unless
    // `model` is a VALID_MODELS member and `instrumental` is a real boolean.
    // The old model_version / lyrics / tags fields were read nowhere.
    // Precedence: explicit `model` > normalized legacy `model_version` > V5 default.
    if (body.model === undefined && model_version) {
      const normalized = model_version
        .trim()
        .toUpperCase()
        .replace(/\+/g, "PLUS")
        .replace(/[.\s-]/g, "_");
      if (SunoModel.safeParse(normalized).success) body.model = normalized;
    }
    if (body.model === undefined) body.model = "V5";
    if (body.style === undefined && tags !== undefined) body.style = tags;
    if (custom_mode !== undefined) body.customMode = custom_mode;
    if (negative_tags !== undefined) body.negativeTags = negative_tags;
    if (vocal_gender !== undefined) body.vocalGender = vocal_gender;
    if (style_weight !== undefined) body.styleWeight = style_weight;
    if (weirdness_constraint !== undefined) body.weirdnessConstraint = weirdness_constraint;
    if (audio_weight !== undefined) body.audioWeight = audio_weight;
    if (persona_id !== undefined) body.personaId = persona_id;

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
        model: `Suno ${String(body.model ?? "V5")}`,
        prompt: input.prompt,
        ...(body.title ? { title: body.title } : {}),
      },
    });
  },
});

const versely_extend_music = defineTool({
  name: "versely_extend_music",
  description:
    "Extend an existing Suno track from a given timestamp. Supplying prompt / style / title / continue_at_seconds automatically switches Suno into custom-parameter mode; omit them all to simply continue the source track with its original parameters.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      audio_id: z
        .string()
        .describe("Audio variant ID of the source track (NOT the task_id)."),
      model: SunoModel.default("V5").describe(
        "Suno model version — required by the backend.",
      ),
      continue_at_seconds: z
        .number()
        .nonnegative()
        .optional()
        .describe("Position in seconds to continue from."),
      prompt: z.string().optional(),
      style: z.string().optional(),
      title: z.string().optional(),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const {
      mode,
      poll_timeout_ms,
      poll_interval_ms,
      audio_id,
      continue_at_seconds,
      ...rest
    } = input;
    const body: Record<string, unknown> = { ...rest };
    // Controller reads audioId / continueAt (camelCase) and requires `model`.
    // The old audio_id / continue_at_seconds / task_id fields were read nowhere.
    body.audioId = audio_id;
    if (continue_at_seconds !== undefined) body.continueAt = continue_at_seconds;
    // Deliberately do NOT send defaultParamFlag: the backend now auto-enables
    // custom params when any of prompt/style/title/continueAt is present, and
    // passing false would silently revert to a plain re-extend.
    delete body.defaultParamFlag;
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
  description:
    "Generate a lipsync video from a still image and an audio clip. `model` is required — call versely_find_models with type='lipsync' to discover valid names.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      image_url: z
        .string()
        .url()
        .describe("Character still. Required by image-driven lipsync models (Infini Talk, Wan 2.2 Speech Turbo)."),
      audio_url: z.string().url(),
      model: z
        .string()
        .describe(
          "Lipsync model — required (the backend 400s without it). Pass the slug or canonical name; discover via versely_find_models with type='lipsync'.",
        ),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, ...body } = input;
    body.model = await resolveCanonicalModel(ctx, "lipsync", body.model);
    // Model-requirement validation reads image_urls | images only — a bare
    // image_url made image-driven lipsync models 400 with "Image required for lipsync".
    if (body.image_url && !Array.isArray(body.image_urls)) {
      body.image_urls = [body.image_url];
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

/**
 * /generate/background-removal hosts ONLY video background-removal models
 * (PROVIDER_MODELS.*.background_removal). There is no image background-removal
 * model in the dispatcher, so this tool is video-only despite its generic name.
 */
const BackgroundRemovalModel = z.enum([
  "Veed Video Background Removal",
  "Veed Video Background Removal Fast",
  "Veed Video Background Removal Green Screen",
  "BRIO Video Background Removal",
]);

const versely_remove_background = defineTool({
  name: "versely_remove_background",
  description:
    "Remove the background from a VIDEO, producing a transparent (VP9 alpha) matte for compositing. Video only — there is no image background-removal model behind this endpoint. Use 'Veed Video Background Removal Fast' for a quick pass, or the Green Screen variant for a chroma-key matte.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      video_url: z.string().url().describe("Source video to cut out."),
      model: BackgroundRemovalModel.default("Veed Video Background Removal").describe(
        "Background-removal model — required by the backend; defaults to the standard VEED matte.",
      ),
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
      kind: "video",
      toolName: "versely_remove_background",
      toolArgs: body,
    });
  },
});

const ImageUpscaleModel = z.enum([
  "Topaz Upscale Image",
  "SeedVR Upscale",
  "Clarity Crystal Upscaler",
  "PrunaAI P-Image-Upscale",
]);

const versely_upscale_image = defineTool({
  name: "versely_upscale_image",
  description: "Upscale an image to a higher resolution.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      image_url: z.string().url(),
      model: ImageUpscaleModel.default("Topaz Upscale Image").describe(
        "Upscale model — required by the backend; defaults to Topaz.",
      ),
      scale: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Upscale multiplier (e.g. 2 or 4). Default 2."),
      scale_factor: z
        .number()
        .positive()
        .optional()
        .describe("Deprecated alias for scale — prefer scale."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms, scale_factor, ...rest } = input;
    const body: Record<string, unknown> = { ...rest };
    // Backend reads `scale`; scale_factor was read nowhere → always 2x.
    if (body.scale === undefined && scale_factor !== undefined) {
      body.scale = Math.round(scale_factor);
    }
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

const VideoUpscaleModel = z.enum([
  "Topaz Upscale Video",
  "Bytedance Upscaler Video",
  "Video Enhancer Pro",
  "Runway Upscale V1",
]);

const versely_upscale_video = defineTool({
  name: "versely_upscale_video",
  description: "Upscale a video to a higher resolution.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      video_url: z.string().url(),
      model: VideoUpscaleModel.default("Topaz Upscale Video").describe(
        "Upscale model — required by the backend; defaults to Topaz.",
      ),
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
