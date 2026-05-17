import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { jsonResult, pendingMediaResult } from "./_helpers.js";
import { metaForMediaCard } from "../ui/templates.js";

// ─── Movie iframe wiring ─────────────────────────────────────────────────────
// Movies are multi-scene async generations: the LLM creates a movie, kicks off
// scene generation, and the backend dispatches each scene to a video provider
// (KIE/FAL/RunPod). Scene completion fires individual webhooks; once all
// scenes are terminal, the backend auto-triggers FFmpeg combine and finally
// sets `final_video_url`.
//
// To get a clean iframe experience the MCP returns a SINGLE pending card from
// `versely_generate_movie_scenes` keyed by `movie_id`. The iframe self-polls
// `versely_get_movie_status` every 5s. Each poll returns a translated
// MediaCardPayload reflecting current progress:
//   • status="pending"   → progress bar + sub-label, no asset render yet
//   • status="completed" → final_video_url + per-scene videos as a gallery
//   • status="failed"    → first failing scene's error
//
// The translator below is shared by:
//   - versely_get_movie_status (the iframe poll target)
//   - versely_get_movie       (LLM-driven manual lookup)
//   - versely_combine_movie   (manual re-combine; returns pending until done)

interface MovieSceneDTO {
  id: string;
  order?: number;
  scene_order?: number;
  status?: string;
  generation_type?: string;
  model?: string;
  video_url?: string | null;
  error?: string | null;
  duration?: number;
}

interface MovieStatusData {
  movie_id?: string;
  id?: string;
  status?: string;
  title?: string;
  final_video_url?: string | null;
  total_duration?: number;
  scenes_total?: number;
  scenes_pending?: number;
  scenes_generating?: number;
  scenes_completed?: number;
  scenes_failed?: number;
  scenes?: MovieSceneDTO[];
}

/** Pull a normalized {movie, scenes} view from either `/status` (flat) or
 *  `/get` ({ movie, scenes }) responses. Both shapes flow through here. */
function normalizeMovie(payload: unknown): { movie: MovieStatusData; scenes: MovieSceneDTO[] } | null {
  if (!payload || typeof payload !== "object") return null;
  const top = payload as { data?: unknown } & MovieStatusData;
  const data = top.data ?? top;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  // Shape A: { movie: {...}, scenes: [...] } (getMovie)
  if (d.movie && typeof d.movie === "object") {
    const movie = d.movie as MovieStatusData;
    const scenes = Array.isArray(d.scenes) ? (d.scenes as MovieSceneDTO[]) : [];
    return { movie, scenes };
  }

  // Shape B: flat status summary (getMovieStatus)
  return {
    movie: d as MovieStatusData,
    scenes: Array.isArray(d.scenes) ? (d.scenes as MovieSceneDTO[]) : [],
  };
}

interface MovieTranslateOpts {
  /** Tool name to echo on the card for the Recreate button. */
  toolName?: string;
  /** Args to echo for Recreate. */
  toolArgs?: Record<string, unknown>;
  /** Include the iframe poll instruction in the returned pending payload.
   *  Set true on the initial card; set false on poll responses (the iframe
   *  already has the poll loop running and doesn't need it re-registered). */
  includePoll?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

const DEFAULT_MOVIE_POLL_INTERVAL_MS = 5000;
/** 30 min — big movies (8+ scenes × ~60s each + combine) can run long. */
const DEFAULT_MOVIE_POLL_TIMEOUT_MS = 1_800_000;

function sceneOrder(s: MovieSceneDTO): number {
  return s.scene_order ?? s.order ?? 0;
}

function movieResultFromPayload(
  payload: unknown,
  movieId: string,
  opts: MovieTranslateOpts = {},
): ToolResult {
  const norm = normalizeMovie(payload);
  if (!norm) return jsonResult(payload);
  const { movie, scenes } = norm;

  const status = String(movie.status ?? "pending").toLowerCase();
  const title = movie.title || `Movie ${movieId}`;
  const total = movie.scenes_total ?? scenes.length;
  const completed = movie.scenes_completed ?? scenes.filter((s) => !!s.video_url).length;
  const failed = movie.scenes_failed ?? scenes.filter((s) => String(s.status ?? "").toLowerCase() === "failed").length;
  const generating = movie.scenes_generating ?? scenes.filter((s) => String(s.status ?? "").toLowerCase() === "generating").length;
  const pending = movie.scenes_pending ?? Math.max(0, total - completed - failed - generating);
  const finalUrl = movie.final_video_url ?? null;

  // Backend assigns scene_order starting at 1 (see movie.service.ts: `i + 1`),
  // so we use scene_order directly as the human-readable label. Falls back to
  // the array position (1-based) if scene_order is missing.
  const orderedScenes = [...scenes].sort((a, b) => sceneOrder(a) - sceneOrder(b));
  const sceneAssets = orderedScenes
    .filter((s) => !!s.video_url)
    .map((s, idx) => ({
      url: s.video_url as string,
      label: `Scene ${sceneOrder(s) || idx + 1}`,
    }));

  const baseEcho: Record<string, unknown> = {
    title,
    scenes_total: total,
    scenes_completed: completed,
    scenes_failed: failed,
    scenes_generating: generating,
    scenes_pending: pending,
    ...(opts.toolName ? { toolName: opts.toolName } : {}),
    ...(opts.toolArgs ? { toolArgs: opts.toolArgs } : {}),
  };

  // ── Completed: final video stitched and movie marked completed ──
  if (status === "completed" && finalUrl) {
    return {
      content: [
        {
          type: "text",
          text: `${title} ready — ${total} scene${total === 1 ? "" : "s"}.\n${finalUrl}`,
        },
      ],
      structuredContent: {
        kind: "video" as const,
        assets: [{ url: finalUrl, label: "Final movie" }, ...sceneAssets],
        status: "completed" as const,
        task_id: movieId,
        final_video_url: finalUrl,
        ...baseEcho,
      },
    };
  }

  // ── Cancelled: user cancelled mid-generation; render as terminal so the
  //    iframe stops polling, but use a softer message. Any scenes that
  //    completed before the cancel stay accessible as assets.
  if (status === "cancelled") {
    return {
      content: [
        {
          type: "text",
          text: `${title} was cancelled. ${completed} of ${total} scene${total === 1 ? "" : "s"} were kept.`,
        },
      ],
      structuredContent: {
        kind: "gallery" as const,
        assets: sceneAssets,
        // Render via the failure body so the iframe stops polling; the
        // "error" text makes it clear it was a cancellation, not a crash.
        status: "failed" as const,
        task_id: movieId,
        error: "Movie was cancelled by the user.",
        cancelled: true,
        ...baseEcho,
      },
    };
  }

  // ── Failed: explicit fail status or all scenes terminal with no successes ──
  const allTerminal = pending === 0 && generating === 0;
  if (status === "failed" || (allTerminal && failed > 0 && completed === 0)) {
    const firstError =
      orderedScenes.find((s) => s.error)?.error?.toString() ||
      `Movie generation failed (${failed} of ${total} scene${total === 1 ? "" : "s"} failed).`;
    return {
      content: [{ type: "text", text: `${title} failed: ${firstError}` }],
      structuredContent: {
        kind: "gallery" as const,
        assets: sceneAssets,
        status: "failed" as const,
        task_id: movieId,
        error: firstError,
        ...baseEcho,
      },
      isError: true,
    };
  }

  // ── Pending: scenes still generating, or combine in flight ──
  const progress = total > 0 ? completed / total : 0;
  const phaseLabel =
    status === "combining"
      ? "combining final video"
      : failed > 0
        ? `generating (${failed} scene${failed === 1 ? "" : "s"} failed so far)`
        : "generating scenes";
  const summary = `${title} — ${completed} of ${total} scene${total === 1 ? "" : "s"} ready, ${phaseLabel}…`;

  const structuredContent: Record<string, unknown> = {
    kind: "gallery" as const,
    assets: sceneAssets,
    status: "pending" as const,
    task_id: movieId,
    progress,
    phase: status,
    ...baseEcho,
  };
  if (opts.includePoll) {
    structuredContent.poll = {
      tool_name: "versely_get_movie_status",
      args: { movie_id: movieId },
      interval_ms: opts.pollIntervalMs ?? DEFAULT_MOVIE_POLL_INTERVAL_MS,
      timeout_ms: opts.pollTimeoutMs ?? DEFAULT_MOVIE_POLL_TIMEOUT_MS,
    };
  }

  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const SceneInputSchema = z
  .object({
    prompt: z.string().describe("Scene prompt (will be expanded if expand_scene is true)."),
    type: z
      .enum(["text-to-video", "image-to-video", "frame-to-frame"])
      .optional(),
    image_url: z.string().url().optional(),
    end_image_url: z.string().url().optional(),
    duration_seconds: z.number().positive().optional(),
    model: z.string().optional(),
    chain_from_previous: z
      .boolean()
      .optional()
      .describe("If true, use the previous scene's last frame as this scene's image_url."),
  })
  .passthrough();

const versely_create_movie = defineTool({
  name: "versely_create_movie",
  description:
    "Create a multi-scene movie project. Scenes are stored but NOT generated yet — call versely_generate_movie_scenes to start. Returns a blueprint card so the user can preview the plan before generation.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      title: z.string(),
      description: z.string().optional(),
      aspect_ratio: z.string().optional(),
      default_model: z.string().optional(),
      scenes: z.array(SceneInputSchema).min(1),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post<{ data?: { movie?: { id?: string; title?: string }; scenes?: MovieSceneDTO[] } }>(
      "/api/v1/movie/create",
      input,
    );
    const movieId =
      (data?.data?.movie?.id as string | undefined) ??
      ((data as unknown as { id?: string }).id ?? "");

    // Blueprint card: surface the plan so the user sees something visual
    // immediately even though no scenes are generated yet. Phase="planning"
    // signals "this is just a plan, hit Generate next".
    if (!movieId) return jsonResult(data);

    const sceneCount = input.scenes?.length ?? 0;
    return {
      content: [
        {
          type: "text",
          text: `Created movie "${input.title}" with ${sceneCount} scene${sceneCount === 1 ? "" : "s"}. Call versely_generate_movie_scenes with movie_id="${movieId}" to start generation.`,
        },
      ],
      structuredContent: {
        kind: "gallery" as const,
        assets: [],
        status: "pending" as const,
        task_id: movieId,
        phase: "planning",
        title: input.title,
        scenes_total: sceneCount,
        scenes_completed: 0,
        scenes_failed: 0,
        scenes_generating: 0,
        scenes_pending: sceneCount,
        progress: 0,
        // Intentionally no `poll` — the iframe should NOT poll a movie that
        // hasn't been kicked off yet (it would just keep showing planning).
        toolName: "versely_create_movie",
        toolArgs: input,
      },
    };
  },
});

const versely_list_movies = defineTool({
  name: "versely_list_movies",
  description: "List the authenticated user's movies (paginated).",
  inputSchema: z.object({
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/movie/list", {
      query: { page: input.page, limit: input.limit },
    });
    return jsonResult(data);
  },
});

const versely_get_movie = defineTool({
  name: "versely_get_movie",
  description:
    "Get a movie with all its scenes and metadata. Returns a media card reflecting current status (pending / completed / failed) — same translation as versely_get_movie_status, but with the full scene metadata available to the LLM via structuredContent.",
  meta: metaForMediaCard(),
  inputSchema: z.object({ movie_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}`,
    );
    return movieResultFromPayload(data, input.movie_id, {
      toolName: "versely_get_movie",
      toolArgs: { movie_id: input.movie_id },
    });
  },
});

const versely_delete_movie = defineTool({
  name: "versely_delete_movie",
  description: "Delete a movie and all its scenes.",
  inputSchema: z.object({ movie_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_get_movie_status = defineTool({
  name: "versely_get_movie_status",
  description:
    "Get real-time generation status for a movie and each of its scenes. This is the tool the iframe self-polls every ~5s during movie generation — the response is normalized into a MediaCardPayload (pending/completed/failed) so the iframe can update the card in place.",
  meta: metaForMediaCard(),
  inputSchema: z.object({ movie_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}/status`,
    );
    // No `includePoll` here — by the time the iframe is calling this, it's
    // already in its polling loop. Re-emitting the poll instruction would
    // be redundant. The original pending card from versely_generate_movie_scenes
    // is what set up the loop.
    return movieResultFromPayload(data, input.movie_id, {
      toolName: "versely_get_movie",
      toolArgs: { movie_id: input.movie_id },
    });
  },
});

const versely_generate_movie_scenes = defineTool({
  name: "versely_generate_movie_scenes",
  description:
    "Kick off generation for all pending scenes in a movie. Returns a pending media card immediately; the iframe self-polls versely_get_movie_status to update progress. Once all scenes are generated the backend auto-combines them into a final video and the card resolves to the playable result. The LLM does NOT need to call versely_combine_movie unless the user wants a manual re-combine with different settings.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    movie_id: z.string(),
  }),
  handler: async (input, ctx) => {
    // Submit the generation request.
    const submission = await ctx.client.post<{
      data?: { movie_id?: string; scenes_dispatched?: number; scenes_queued?: number };
    }>(`/api/v1/movie/${encodeURIComponent(input.movie_id)}/generate`, {});

    // Fetch the latest status so the initial card reflects any scenes that
    // already completed before we got here (idempotent retries, mixed
    // partial-generates, etc.). If that fails we fall back to a minimal
    // pending card.
    let initialStatus: unknown = null;
    try {
      initialStatus = await ctx.client.get(
        `/api/v1/movie/${encodeURIComponent(input.movie_id)}/status`,
      );
    } catch {
      /* ignore — pending card still works without it */
    }

    if (initialStatus) {
      return movieResultFromPayload(initialStatus, input.movie_id, {
        toolName: "versely_generate_movie_scenes",
        toolArgs: { movie_id: input.movie_id },
        includePoll: true,
      });
    }

    // Fallback: backend status fetch failed but submission succeeded.
    const dispatched = submission?.data?.scenes_dispatched ?? 0;
    const queued = submission?.data?.scenes_queued ?? 0;
    const total = dispatched + queued;
    return pendingMediaResult({
      kind: "gallery",
      taskId: input.movie_id,
      pollTool: "versely_get_movie_status",
      pollArgs: { movie_id: input.movie_id },
      intervalMs: DEFAULT_MOVIE_POLL_INTERVAL_MS,
      timeoutMs: DEFAULT_MOVIE_POLL_TIMEOUT_MS,
      toolName: "versely_generate_movie_scenes",
      toolArgs: { movie_id: input.movie_id },
      summary: `Movie generation started — ${total} scene${total === 1 ? "" : "s"} dispatched. The inline preview will update as scenes complete.`,
      extra: {
        scenes_total: total,
        scenes_pending: total,
        scenes_completed: 0,
        scenes_failed: 0,
        progress: 0,
      },
    });
  },
});

const versely_combine_movie = defineTool({
  name: "versely_combine_movie",
  description:
    "Manually (re)combine a movie's scene videos into a final video with server-side FFmpeg. **You usually don't need to call this** — the backend auto-combines when all scenes complete. Use this only when (a) auto-combine failed, (b) you want a different transition or audio track, or (c) some scenes failed and you want to combine just the successful ones.",
  meta: metaForMediaCard(),
  inputSchema: z
    .object({
      movie_id: z.string(),
      transition: z.string().optional().describe("e.g. 'concat', 'crossfade'"),
      audio_url: z.string().url().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { movie_id, ...body } = input;
    // Combine is synchronous on the backend (FFmpeg merge), so we don't get
    // a pending shape back — just the final result. Translate via the same
    // helper so the response is a real video card if it succeeded.
    const data = await ctx.client.post(
      `/api/v1/movie/${encodeURIComponent(movie_id)}/combine`,
      body,
    );
    return movieResultFromPayload(data, movie_id, {
      toolName: "versely_combine_movie",
      toolArgs: input,
    });
  },
});

// ─── v2 tools: scene-level operations ────────────────────────────────────────

const versely_add_movie_scene = defineTool({
  name: "versely_add_movie_scene",
  description:
    "Add a new scene to an existing movie (appended at the end by default). The scene starts as 'pending' and won't generate until you call versely_generate_movie_scenes again — calling generate will pick up only scenes that haven't been generated yet.",
  inputSchema: z
    .object({
      movie_id: z.string(),
      prompt: z.string(),
      type: z
        .enum(["text-to-video", "image-to-video", "frame-to-frame"])
        .optional(),
      image_url: z.string().url().optional(),
      end_image_url: z.string().url().optional(),
      duration_seconds: z.number().positive().optional(),
      model: z.string().optional(),
      chain_from_previous: z.boolean().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { movie_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/movie/${encodeURIComponent(movie_id)}/scene`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_update_movie_scene = defineTool({
  name: "versely_update_movie_scene",
  description:
    "Update a single scene's prompt / model / type / image_url / etc. Allowed only before the scene has been generated, or after a failure (use this to fix the prompt and then re-generate). Pass only the fields you want to change.",
  inputSchema: z
    .object({
      scene_id: z.string(),
      prompt: z.string().optional(),
      type: z
        .enum(["text-to-video", "image-to-video", "frame-to-frame"])
        .optional(),
      image_url: z.string().url().optional(),
      end_image_url: z.string().url().optional(),
      duration_seconds: z.number().positive().optional(),
      model: z.string().optional(),
      scene_order: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { scene_id, ...body } = input;
    const data = await ctx.client.put(
      `/api/v1/movie/scene/${encodeURIComponent(scene_id)}`,
      body,
    );
    return jsonResult(data);
  },
});

const versely_regenerate_scene = defineTool({
  name: "versely_regenerate_scene",
  description:
    "Regenerate a single scene without redoing the whole movie. Use this when one scene failed or the user wants to retry just that scene with a tweaked prompt. The movie's auto-combine will fire when all scenes (including this re-run) are terminal. Returns a per-scene submission; poll versely_get_movie_status to track overall movie progress.",
  inputSchema: z.object({
    movie_id: z.string(),
    scene_id: z.string(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}/generate-scene/${encodeURIComponent(input.scene_id)}`,
      {},
    );
    return jsonResult(data);
  },
});

const versely_cancel_movie = defineTool({
  name: "versely_cancel_movie",
  description:
    "Cancel a movie that's still generating. Marks the movie and any non-terminal scenes as 'cancelled', preserves any scenes that already completed, and refunds credits for the scenes that didn't run. Use this instead of versely_delete_movie when the user wants to keep the partial output. No-op (200) if the movie is already in a terminal status.",
  inputSchema: z.object({ movie_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}/cancel`,
      {},
    );
    return jsonResult(data);
  },
});

export const movieTools: Tool[] = [
  versely_create_movie,
  versely_list_movies,
  versely_get_movie,
  versely_delete_movie,
  versely_get_movie_status,
  versely_generate_movie_scenes,
  versely_combine_movie,
  versely_add_movie_scene,
  versely_update_movie_scene,
  versely_regenerate_scene,
  versely_cancel_movie,
];
