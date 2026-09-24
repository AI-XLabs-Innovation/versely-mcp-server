// Music and sound effects. Every music model the backend serves - Suno,
// Lyria, MiniMax Music 3, ElevenLabs Music, Sonilo - sits behind its own route
// with its own body, so the tools take one `model` name and do the mapping.
// Contracts: controllers/audio/{sunoApi,lyria,sonilo,sound-effect}.controller.ts.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { AsyncFields, handleAsync, type AsyncMode } from "./_async.js";
import { mediaResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { metaForMediaCard } from "../ui/templates.js";

/**
 * Suno versions the backend still sells (sunoApi.controller VALID_MODELS).
 * Everything below V5 was retired 2026-09-11 and now 400s, so older names are
 * mapped to the default instead of being sent.
 */
export const SUNO_VERSIONS = ["V6", "V6_MINI", "V6_WILD", "V5_5", "V5"] as const;
type SunoVersion = (typeof SUNO_VERSIONS)[number];
const DEFAULT_SUNO: SunoVersion = "V6";

/** "V4.5+", "suno v6 wild", "V5_5" → a version the backend sells. */
function sunoVersion(raw: string | undefined): SunoVersion {
  if (!raw || !raw.trim()) return DEFAULT_SUNO;
  const wire = raw
    .trim()
    .toUpperCase()
    .replace(/^SUNO(\s+SOUNDS)?\s*/, "")
    .replace(/\+/g, "PLUS")
    .replace(/[.\s-]+/g, "_");
  return (SUNO_VERSIONS as readonly string[]).includes(wire) ? (wire as SunoVersion) : DEFAULT_SUNO;
}

const SUNO_LABEL: Record<SunoVersion, string> = {
  V6: "V6",
  V6_MINI: "V6 Mini",
  V6_WILD: "V6 Wild",
  V5_5: "V5.5",
  V5: "V5",
};

// --- Music -------------------------------------------------------------------

type MusicKind = "suno" | "lyria" | "minimax" | "elevenlabs" | "sonilo";

interface MusicModel {
  name: string;
  kind: MusicKind;
  suno?: SunoVersion;
  path?: string;
}

const MUSIC_MODELS: readonly MusicModel[] = [
  ...SUNO_VERSIONS.map((v) => ({ name: `Suno ${SUNO_LABEL[v]}`, kind: "suno" as const, suno: v })),
  { name: "Lyria 3.5", kind: "lyria", path: "/api/v1/lyria/generate-3-5" },
  { name: "Lyria 3 Pro", kind: "lyria", path: "/api/v1/lyria/generate-pro" },
  { name: "Lyria 3 Clip", kind: "lyria", path: "/api/v1/lyria/generate-clip" },
  { name: "MiniMax Music 3", kind: "minimax", path: "/api/v1/audio/minimax/music-3" },
  { name: "ElevenLabs Music V2.5", kind: "elevenlabs", path: "/api/v1/audio/elevenlabs/music-v2-5" },
  { name: "Sonilo Text to Music", kind: "sonilo", path: "/api/v1/audio/sonilo/text-to-music" },
];

export const MUSIC_MODEL_NAMES: readonly string[] = MUSIC_MODELS.map((m) => m.name);

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

function resolveMusicModel(raw: string | undefined): MusicModel {
  if (!raw || !raw.trim()) return MUSIC_MODELS[0]!;
  const wanted = norm(raw);
  const exact = MUSIC_MODELS.find((m) => norm(m.name) === wanted);
  if (exact) return exact;
  if (/^(suno\s*)?v\d/i.test(raw.trim())) {
    const v = sunoVersion(raw);
    return MUSIC_MODELS.find((m) => m.suno === v)!;
  }
  if (/lyria/i.test(raw)) {
    return MUSIC_MODELS.find((m) => m.name === (/clip/i.test(raw) ? "Lyria 3 Clip" : /pro/i.test(raw) ? "Lyria 3 Pro" : "Lyria 3.5"))!;
  }
  if (/minimax/i.test(raw)) return MUSIC_MODELS.find((m) => m.kind === "minimax")!;
  if (/eleven/i.test(raw)) return MUSIC_MODELS.find((m) => m.kind === "elevenlabs")!;
  if (/sonilo/i.test(raw)) return MUSIC_MODELS.find((m) => m.kind === "sonilo")!;
  if (/suno/i.test(raw)) return MUSIC_MODELS[0]!;
  throw new Error(`Unknown music model "${raw}". Use one of: ${MUSIC_MODEL_NAMES.join(", ")}.`);
}

/** True for a model name versely_generate_music serves (so generate_audio can point there). */
export function isMusicModelName(name: string): boolean {
  const n = norm(name);
  return MUSIC_MODELS.some((m) => norm(m.name) === n) || /^(lyria|minimax music|elevenlabs music|sonilo (text|video) to music)/i.test(name.trim());
}

/** Lyria answers in the request with the finished file; show it like any finished job. */
async function syncAudioResult(
  data: unknown,
  opts: { toolName: string; toolArgs: Record<string, unknown>; model: string; prompt?: string },
): Promise<ToolResult> {
  const result = await mediaResult(data, {
    kind: "audio",
    toolName: opts.toolName,
    toolArgs: opts.toolArgs,
    extra: { status: "completed", model: opts.model, ...(opts.prompt ? { prompt: opts.prompt } : {}) },
  });
  const lyrics = (data as { data?: { lyrics?: unknown } } | null)?.data?.lyrics;
  if (typeof lyrics === "string" && lyrics.trim()) {
    result.content = [...result.content, { type: "text", text: `Lyrics:\n${lyrics.trim()}` }];
  }
  return result;
}

const MUSIC_DESCRIPTION =
  "Generate a song, instrumental or backing track. Models (pass as `model`; default 'Suno V6'): " +
  `${MUSIC_MODEL_NAMES.join(", ")}. ` +
  "Suno: full songs; its vocals follow `prompt` (up to 500 characters) or your own `lyrics`. " +
  "Lyria 3.5 / 3 Pro: full songs with vocals or instrumental, can score an `image_url`; Lyria 3 Clip: 30 seconds. " +
  "MiniMax Music 3: needs `lyrics` ([verse] / [chorus] lines). ElevenLabs Music and Sonilo: set the length with " +
  "duration_seconds; Sonilo can also score a video (`video_url`). Spends the user's Versely credits; the inline card " +
  "updates itself when the track is ready (Lyria answers straight away).";

const versely_generate_music = defineTool({
  name: "versely_generate_music",
  description: MUSIC_DESCRIPTION,
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      prompt: z
        .string()
        .describe("What the music should be: genre, mood, instruments, vocals. With Suno custom_mode it is the literal lyrics."),
      model: z.string().optional().describe(`Music model (default 'Suno V6'): ${MUSIC_MODEL_NAMES.join(", ")}.`),
      lyrics: z
        .string()
        .optional()
        .describe("The words to sing. Required for MiniMax Music 3. With Suno it switches on custom mode (prompt then sets the style)."),
      instrumental: z.boolean().optional().describe("No vocals (default false)."),
      duration_seconds: z
        .number()
        .positive()
        .optional()
        .describe("Length for MiniMax (10-300 s), ElevenLabs (3-600 s) and Sonilo (5-600 s); default 60. Suno and Lyria choose their own."),
      title: z.string().max(80).optional().describe("Track title (Suno)."),
      style: z.string().max(1000).optional().describe("Suno custom mode: musical style, e.g. 'pop, upbeat, electronic'."),
      custom_mode: z
        .boolean()
        .optional()
        .describe("Suno: treat `prompt` as the literal lyrics (then `style` and `title` are required)."),
      negative_tags: z.string().optional().describe("Suno: styles to avoid."),
      vocal_gender: z.enum(["m", "f"]).optional().describe("Suno: singer's voice."),
      style_weight: z.number().min(0).max(1).optional(),
      weirdness_constraint: z.number().min(0).max(1).optional(),
      audio_weight: z.number().min(0).max(1).optional(),
      persona_id: z.string().optional(),
      image_url: z.string().url().optional().describe("Lyria: an image the music should fit."),
      video_url: z.string().url().optional().describe("Sonilo: a video to score (makes Sonilo Video to Music)."),
      model_version: z.string().optional().describe("Deprecated alias for model (e.g. 'V5') — prefer model."),
      tags: z.string().optional().describe("Deprecated alias for style — prefer style."),
      ...AsyncFields,
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms } = input;
    const chosen = resolveMusicModel(input.model ?? input.model_version);
    const run = (path: string, body: Record<string, unknown>, model: string) =>
      submitMusic(ctx, {
        path,
        body,
        mode: mode as AsyncMode,
        pollTimeoutMs: poll_timeout_ms,
        pollIntervalMs: poll_interval_ms,
        model,
        prompt: input.prompt,
      });
    const lyrics = typeof input.lyrics === "string" && input.lyrics.trim() ? input.lyrics.trim() : undefined;
    const withLyrics = (text: string) =>
      [text, lyrics ? `Lyrics:\n${lyrics}` : "", input.instrumental ? "Instrumental only, no vocals." : ""]
        .filter(Boolean)
        .join("\n\n");

    switch (chosen.kind) {
      case "suno": {
        // The controller reads camelCase and hard-400s unless `model` is a
        // version it sells and `instrumental` is a real boolean.
        const custom = input.custom_mode === true || lyrics !== undefined;
        const body: Record<string, unknown> = {
          model: chosen.suno,
          instrumental: input.instrumental === true,
          customMode: custom,
          prompt: lyrics ?? input.prompt,
        };
        const style = input.style ?? input.tags ?? (lyrics !== undefined ? input.prompt : undefined);
        if (style !== undefined) body.style = style.slice(0, 1000);
        if (input.title !== undefined) body.title = input.title;
        else if (custom) body.title = "Untitled";
        if (!custom && input.prompt.length > 500) {
          throw new Error(
            "Suno's song description is limited to 500 characters. Shorten `prompt`, or pass your own `lyrics` (up to 5000).",
          );
        }
        if (input.negative_tags !== undefined) body.negativeTags = input.negative_tags;
        if (input.vocal_gender !== undefined) body.vocalGender = input.vocal_gender;
        if (input.style_weight !== undefined) body.styleWeight = input.style_weight;
        if (input.weirdness_constraint !== undefined) body.weirdnessConstraint = input.weirdness_constraint;
        if (input.audio_weight !== undefined) body.audioWeight = input.audio_weight;
        if (input.persona_id !== undefined) body.personaId = input.persona_id;
        return run("/api/v1/suno/generate", body, chosen.name);
      }
      case "lyria": {
        const body: Record<string, unknown> = { prompt: withLyrics(input.prompt) };
        if (input.image_url) body.image_url = input.image_url;
        const data = await ctx.client.post(chosen.path!, body, { timeoutMs: SYNC_TIMEOUT_MS });
        return syncAudioResult(data, {
          toolName: "versely_generate_music",
          toolArgs: { model: chosen.name, ...body },
          model: chosen.name,
          prompt: input.prompt,
        });
      }
      case "minimax": {
        if (!lyrics) {
          throw new Error("MiniMax Music 3 needs `lyrics` (use [verse] and [chorus] on their own lines). `prompt` sets the style.");
        }
        return run(chosen.path!, { prompt: input.prompt, lyrics, duration: input.duration_seconds ?? 60 }, chosen.name);
      }
      case "elevenlabs":
        return run(
          chosen.path!,
          { prompt: withLyrics(input.prompt), duration: input.duration_seconds ?? 60, instrumental: input.instrumental === true },
          chosen.name,
        );
      case "sonilo":
        if (input.video_url) {
          return run(
            "/api/v1/audio/sonilo/video-to-music",
            { video_url: input.video_url, prompt: input.prompt, ...(input.duration_seconds ? { duration: input.duration_seconds } : {}) },
            "Sonilo Video to Music",
          );
        }
        return run(chosen.path!, { prompt: input.prompt, duration: input.duration_seconds ?? 60 }, chosen.name);
    }
  },
});

async function submitMusic(
  ctx: ToolContext,
  opts: {
    path: string;
    body: Record<string, unknown>;
    mode: AsyncMode;
    pollTimeoutMs?: number;
    pollIntervalMs?: number;
    model: string;
    prompt?: string;
    toolName?: string;
  },
): Promise<ToolResult> {
  const submission = await ctx.client.post(opts.path, opts.body);
  return handleAsync({
    ctx,
    submitResponse: submission,
    mode: opts.mode,
    pollTimeoutMs: opts.pollTimeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
    kind: "audio",
    toolName: opts.toolName ?? "versely_generate_music",
    toolArgs: { model: opts.model, ...opts.body },
    extra: { model: opts.model, ...(opts.prompt ? { prompt: opts.prompt } : {}) },
  });
}

const versely_extend_music = defineTool({
  name: "versely_extend_music",
  description:
    "Extend a Suno track (made with versely_generate_music on a Suno model) from a given timestamp. Supplying " +
    "prompt / style / title / continue_at_seconds steers the continuation; omit them all to simply continue the " +
    "track as it was. Spends the user's Versely credits; the inline card updates itself when it finishes.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      audio_id: z
        .string()
        .describe("Audio variant ID of the source track (NOT the task_id)."),
      model: z
        .string()
        .optional()
        .describe("Suno version: V6 (default), V6_MINI, V6_WILD, V5_5 or V5. Use the source track's version when known."),
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
    const { mode, poll_timeout_ms, poll_interval_ms, audio_id, continue_at_seconds, model, ...rest } = input;
    const body: Record<string, unknown> = { ...rest, model: sunoVersion(model) };
    // Controller reads audioId / continueAt (camelCase) and requires `model`.
    body.audioId = audio_id;
    if (continue_at_seconds !== undefined) body.continueAt = continue_at_seconds;
    // Deliberately do NOT send defaultParamFlag: the backend auto-enables
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
      extra: { model: `Suno ${SUNO_LABEL[body.model as SunoVersion]}` },
    });
  },
});

// --- Sound effects -------------------------------------------------------------

type SfxKind = "elevenlabs" | "suno" | "sonilo";

interface SfxModel {
  name: string;
  kind: SfxKind;
  suno?: SunoVersion;
}

const SFX_MODELS: readonly SfxModel[] = [
  { name: "ElevenLabs Sound Effects", kind: "elevenlabs" },
  ...SUNO_VERSIONS.map((v) => ({ name: `Suno Sounds ${SUNO_LABEL[v]}`, kind: "suno" as const, suno: v })),
  { name: "Sonilo Video to SFX", kind: "sonilo" },
];

export const SFX_MODEL_NAMES: readonly string[] = SFX_MODELS.map((m) => m.name);

/** True for a model name versely_generate_sound_effect serves. */
export function isSoundEffectModelName(name: string): boolean {
  const n = norm(name);
  return SFX_MODELS.some((m) => norm(m.name) === n) || /^(suno sounds|elevenlabs sound|sonilo video to sfx)/i.test(name.trim());
}

function resolveSfxModel(raw: string | undefined, hasVideo: boolean): SfxModel {
  if (!raw || !raw.trim()) return hasVideo ? SFX_MODELS[SFX_MODELS.length - 1]! : SFX_MODELS[0]!;
  const wanted = norm(raw);
  const exact = SFX_MODELS.find((m) => norm(m.name) === wanted);
  if (exact) return exact;
  if (/sonilo|video/i.test(raw)) return SFX_MODELS[SFX_MODELS.length - 1]!;
  if (/suno/i.test(raw)) {
    const v = sunoVersion(raw);
    return SFX_MODELS.find((m) => m.suno === v)!;
  }
  if (/eleven/i.test(raw)) return SFX_MODELS[0]!;
  throw new Error(`Unknown sound-effect model "${raw}". Use one of: ${SFX_MODEL_NAMES.join(", ")}.`);
}

const versely_generate_sound_effect = defineTool({
  name: "versely_generate_sound_effect",
  description:
    "Generate a sound effect (whoosh, footsteps, rain, crowd, UI click, ambience...) from a description, or " +
    "sound effects that match a video. Models (pass as `model`): " +
    `${SFX_MODEL_NAMES.join(", ")}. ` +
    "Default: 'ElevenLabs Sound Effects' (0.5-22 s, set duration_seconds; can loop). Suno Sounds take a tempo " +
    "(bpm) and musical key and can loop. 'Sonilo Video to SFX' scores a `video_url` (used automatically when one " +
    "is given). Spends the user's Versely credits; the inline card updates itself when it is ready.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    prompt: z
      .string()
      .max(500)
      .optional()
      .describe("What it should sound like. Required unless video_url is given."),
    model: z.string().optional().describe(`Sound-effect model: ${SFX_MODEL_NAMES.join(", ")}.`),
    duration_seconds: z
      .number()
      .min(0.5)
      .max(22)
      .optional()
      .describe("ElevenLabs only: length in seconds, 0.5-22 (default 10)."),
    loop: z.boolean().optional().describe("Make it loop seamlessly (ElevenLabs, Suno Sounds)."),
    prompt_influence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("ElevenLabs only: how closely to follow the prompt, 0-1 (default 0.3)."),
    bpm: z.number().int().min(1).max(300).optional().describe("Suno Sounds only: tempo."),
    key: z.string().max(12).optional().describe("Suno Sounds only: musical key, e.g. 'C minor'."),
    video_url: z.string().url().optional().describe("A video to make matching sound effects for (Sonilo Video to SFX)."),
    ...AsyncFields,
  }),
  handler: async (input, ctx) => {
    const { mode, poll_timeout_ms, poll_interval_ms } = input;
    const chosen = resolveSfxModel(input.model, Boolean(input.video_url));
    const prompt = input.prompt?.trim();
    let path: string;
    let body: Record<string, unknown>;
    switch (chosen.kind) {
      case "elevenlabs":
        if (!prompt) throw new Error("`prompt` is required: describe the sound.");
        path = "/api/v1/audio/sound-effect";
        body = {
          prompt,
          duration_seconds: input.duration_seconds ?? 10,
          ...(input.loop !== undefined ? { loop: input.loop } : {}),
          ...(input.prompt_influence !== undefined ? { prompt_influence: input.prompt_influence } : {}),
        };
        break;
      case "suno":
        if (!prompt) throw new Error("`prompt` is required: describe the sound.");
        path = "/api/v1/suno/generate-sounds";
        body = {
          prompt,
          model: chosen.suno,
          ...(input.loop !== undefined ? { soundLoop: input.loop } : {}),
          ...(input.bpm !== undefined ? { soundTempo: input.bpm } : {}),
          ...(input.key ? { soundKey: input.key } : {}),
        };
        break;
      case "sonilo":
        if (!input.video_url) throw new Error("'Sonilo Video to SFX' needs `video_url`: the video to make sound effects for.");
        path = "/api/v1/audio/sonilo/video-to-sound-effects";
        body = { video_url: input.video_url, ...(prompt ? { prompt } : {}) };
        break;
    }
    const submission = await ctx.client.post(path, body);
    return handleAsync({
      ctx,
      submitResponse: submission,
      mode: mode as AsyncMode,
      pollTimeoutMs: poll_timeout_ms,
      pollIntervalMs: poll_interval_ms,
      kind: "audio",
      toolName: "versely_generate_sound_effect",
      toolArgs: { model: chosen.name, ...body },
      extra: { model: chosen.name, ...(prompt ? { prompt } : {}) },
    });
  },
});

export const audioTools: Tool[] = [versely_generate_music, versely_extend_music, versely_generate_sound_effect];
