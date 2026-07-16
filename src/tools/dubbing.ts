import { z } from "zod";
import { defineTool, type Tool, type ToolResult } from "./_types.js";
import { jsonResult, pendingMediaResult } from "./_helpers.js";
import {
  metaForMediaCard,
  buildMediaCardPayload,
  type MediaKind,
} from "../ui/templates.js";

/**
 * Dubbing Studio — POST/GET/DELETE /dubbing (dubbing_projects).
 *
 * Deliberately NOT wired to versely_wait_for_task / versely_get_task_status:
 * those poll /api/v1/status/:request_id, which resolves against the user_*
 * generation tables. A dub lives in `dubbing_projects` and has no row there,
 * so a status poll on a project id 404s forever. versely_get_dub is the only
 * completion path — which is also why the pending card below overrides
 * pendingMediaResult's default summary (it names wait_for_task).
 */

// ISO-639-1/3 + optional region, matching LANG_RE in dubbingStudio.controller.ts.
const LangCode = z
  .string()
  .regex(
    /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/,
    "Must be an ISO-639 code like 'es', 'hi' or 'pt-BR'.",
  );

/**
 * Languages the HeyGen engine accepts, keyed by our ISO code. Mirrors
 * HEYGEN_LANGUAGE_MAP in dubbingStudio.controller.ts — the backend 400s on any
 * target_lang outside this set when engine='heygen'. Listed here so the model
 * can pick the right engine up front instead of discovering it via an error.
 */
const HEYGEN_LANGS = [
  "en", "es", "fr", "hi", "it", "de", "pl", "pt", "pt-br", "zh", "ja", "nl",
  "tr", "ko", "da", "ar", "ro", "fil", "sv", "id", "uk", "el", "cs", "bg",
  "ms", "sk", "hr", "ta", "fi", "ru", "th", "vi", "he", "hu", "no",
];

const TERMINAL_OK = "dubbed";
const TERMINAL_FAIL = "failed";

interface DubOutput {
  media_url?: string;
  srt_url?: string;
  content_type?: string;
}

interface DubProject {
  id: string;
  status?: string;
  media_type?: string;
  outputs?: Record<string, DubOutput> | null;
  target_langs?: string[] | null;
  error?: string | null;
}

function projectOf(data: unknown): DubProject | null {
  const obj = data as Record<string, unknown> | null;
  const p = obj?.project;
  return p && typeof p === "object" ? (p as DubProject) : null;
}

function kindOf(project: DubProject): MediaKind {
  return project.media_type === "video" ? "video" : "audio";
}

/** Dubbed media URLs across every target language, in target_langs order. */
function dubbedUrls(project: DubProject): string[] {
  const outputs = project.outputs || {};
  const langs = project.target_langs?.length
    ? project.target_langs
    : Object.keys(outputs);
  const urls: string[] = [];
  for (const lang of langs) {
    const url = outputs[lang]?.media_url;
    if (typeof url === "string" && url.trim()) urls.push(url.trim());
  }
  return urls;
}

/**
 * Render a project row as a media card. The poller writes per-language outputs
 * incrementally, so a row can be status='downloading' with some media_urls
 * already present — only 'dubbed' is treated as complete.
 */
function cardForProject(project: DubProject): ToolResult {
  const status = (project.status || "").toLowerCase();
  const kind = kindOf(project);

  if (status === TERMINAL_FAIL) {
    const err = project.error || "Dubbing failed.";
    return {
      content: [{ type: "text", text: `Dubbing project ${project.id} failed: ${err}` }],
      structuredContent: {
        status: "failed",
        task_id: project.id,
        error: String(err),
        raw: project,
      },
      isError: true,
    };
  }

  if (status === TERMINAL_OK) {
    const urls = dubbedUrls(project);
    if (urls.length > 0) {
      const structuredContent = buildMediaCardPayload(
        urls.length > 1 ? "gallery" : kind,
        urls.map((url) => ({ url })),
        { task_id: project.id, status: "completed", model: "Dubbing Studio" },
      );
      const srt = Object.values(project.outputs || {})
        .map((o) => o?.srt_url)
        .filter((u): u is string => typeof u === "string" && !!u.trim());
      return {
        content: [
          {
            type: "text",
            text:
              `Dubbing project ${project.id} completed — ${urls.length} dubbed ` +
              `${kind} track${urls.length === 1 ? "" : "s"}: ${urls.join(", ")}` +
              (srt.length ? `\nTranscripts (SRT): ${srt.join(", ")}` : ""),
          },
        ],
        ...(structuredContent ? { structuredContent } : {}),
      };
    }
  }

  // queued / preparing / dubbing / downloading — or 'dubbed' with no media yet.
  return {
    content: [
      {
        type: "text",
        text:
          `Dubbing project ${project.id} is still ${status || "processing"} and is NOT finished. ` +
          `Call versely_get_dub with project_id="${project.id}" again to check. ` +
          `Do not describe this as complete until it returns a result URL.`,
      },
    ],
    structuredContent: {
      status: "pending",
      task_id: project.id,
      raw: project,
    },
  };
}

const versely_create_dub = defineTool({
  name: "versely_create_dub",
  description:
    "Dub a Versely-hosted video or audio file into another language (Dubbing Studio). " +
    "Two engines: 'elevenlabs' (default) clones the speaker's voice, handles audio OR video, " +
    "supports trimming and background separation, up to 30 minutes; 'heygen' additionally " +
    "LIP-SYNCS the speaker to the new language but is video-only, has no trimming, is limited " +
    "to 8 minutes, and costs ~3x more. Returns a project_id — poll it with versely_get_dub " +
    "(NOT versely_wait_for_task, which cannot see dubbing projects).",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      source_url: z
        .string()
        .url()
        .describe(
          "The media to dub. Must be Versely-hosted (a *.versely.studio URL, e.g. output " +
            "from a generation tool or versely_list_user_media). External links such as " +
            "YouTube are rejected — the duration probe that prices the job needs our own file.",
        ),
      target_lang: LangCode.describe(
        "Language to dub INTO, e.g. 'es', 'hi', 'pt-BR'. Required.",
      ),
      source_lang: z
        .string()
        .optional()
        .describe("Language of the source. Defaults to 'auto' (detected)."),
      engine: z
        .enum(["elevenlabs", "heygen"])
        .optional()
        .describe(
          `Dubbing engine. Default 'elevenlabs'. 'heygen' adds lip-sync but requires a VIDEO source, ` +
            `rejects start_time/end_time, caps at 8 minutes, and only supports these target_lang values: ${HEYGEN_LANGS.join(", ")}.`,
        ),
      name: z.string().optional().describe("Project name. Defaults to 'Dub → <target_lang>'."),
      num_speakers: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of distinct speakers. 0 (default) auto-detects."),
      start_time: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Trim start, in SECONDS. Billing is based on the selected window, so trimming a long " +
            "source is how you control cost. Not supported by the heygen engine.",
        ),
      end_time: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Trim end, in SECONDS. Must be greater than start_time. Not supported by the heygen engine."),
      drop_background_audio: z
        .boolean()
        .optional()
        .describe("elevenlabs only: strip background audio, keeping dubbed speech alone."),
      highest_resolution: z
        .boolean()
        .optional()
        .describe("elevenlabs only: render the dubbed video at the highest available resolution."),
      watermark: z.boolean().optional().describe("elevenlabs only: watermark the output."),
      translate_audio_only: z
        .boolean()
        .optional()
        .describe("heygen only: translate the audio without altering the speaker's lips."),
      enable_dynamic_duration: z
        .boolean()
        .optional()
        .describe(
          "heygen only: let the output length drift so translated speech fits naturally. Defaults to true.",
        ),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const submission = await ctx.client.post<Record<string, unknown>>("/api/v1/dubbing", input);
    const project = projectOf(submission);
    if (!project?.id) return jsonResult(submission);

    return pendingMediaResult({
      kind: kindOf(project),
      taskId: project.id,
      pollTool: "versely_get_dub",
      pollArgs: { project_id: project.id },
      toolName: "versely_create_dub",
      toolArgs: input as Record<string, unknown>,
      // pendingMediaResult's default summary points the model at
      // versely_wait_for_task, which polls /api/v1/status and would 404 on a
      // dubbing project id forever. Name the right tool instead.
      summary:
        `Dubbing started — project ${project.id} is processing and is NOT finished yet. ` +
        `If an inline preview is shown it will update on its own. Otherwise call ` +
        `versely_get_dub with project_id="${project.id}" to check progress. ` +
        `Dubbing is slow (often several minutes for a long clip). ` +
        `Do not describe this as complete until a poll returns a result URL.`,
      intervalMs: 10_000,
      timeoutMs: 1_800_000,
      extra: {
        project_id: project.id,
        target_lang: input.target_lang,
        engine: input.engine ?? "elevenlabs",
      },
    });
  },
});

const versely_get_dub = defineTool({
  name: "versely_get_dub",
  description:
    "Get a dubbing project by id — the polling target for versely_create_dub. " +
    "When the dub has finished, hydrates the inline media card with the dubbed track(s).",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    project_id: z.string().describe("The project id returned by versely_create_dub."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get<Record<string, unknown>>(
      `/api/v1/dubbing/${encodeURIComponent(input.project_id)}`,
    );
    const project = projectOf(data);
    if (!project) return jsonResult(data);
    return cardForProject(project);
  },
});

const versely_list_dubs = defineTool({
  name: "versely_list_dubs",
  description: "List the user's dubbing projects, newest first.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe("Max projects to return (default 50, max 100)."),
    before: z
      .string()
      .optional()
      .describe("Pagination cursor — an ISO timestamp; returns projects created before it."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/dubbing", {
      query: { limit: input.limit, before: input.before },
    });
    return jsonResult(data);
  },
});

const versely_delete_dub = defineTool({
  name: "versely_delete_dub",
  description:
    "Delete a dubbing project. If it is still generating it is cancelled and the credits are refunded. " +
    "Already-rendered output files are kept in storage.",
  inputSchema: z.object({
    project_id: z.string().describe("The project id to delete."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/dubbing/${encodeURIComponent(input.project_id)}`,
    );
    return jsonResult(data);
  },
});

export const dubbingTools: Tool[] = [
  versely_create_dub,
  versely_get_dub,
  versely_list_dubs,
  versely_delete_dub,
];
