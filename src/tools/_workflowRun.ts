// Shared run-status translators for the two workflow surfaces:
//   - `/api/v1/workflows/runs/:taskId` (unified — scenes-mode OR steps-mode)
//   - `/api/v1/video-workflows/runs/:id` (scenes-mode only, native)
//
// Both surfaces ultimately fan into the `video_workflow_runs` table for scene
// runs and `background_tasks` for legacy step runs. The translator below
// normalizes any of these shapes into a MediaCardPayload that the iframe
// poll handler understands (status + assets + progress + task_id), mirroring
// the movie translator's design.
//
// Why a shared helper: the iframe state machine doesn't care which surface
// produced the card. As long as we emit the canonical shape, the same render
// path (renderPending + handlePollResponse + growing-assets merge) works for
// generic workflows, video-workflows, AND movies.

import type { ToolResult } from "./_types.js";
import { jsonResult } from "./_helpers.js";

// ─── Run shape DTOs ──────────────────────────────────────────────────────────

interface SceneRunScene {
  id: string;
  scene_order?: number;
  status?: string;
  video_url?: string | null;
  image_url?: string | null;
  error_message?: string | null;
  duration?: number;
  model?: string;
}

interface SceneRunRow {
  id?: string;
  user_id?: string;
  title?: string | null;
  status?: string;
  total_scenes?: number;
  current_scene_order?: number;
  final_video_url?: string | null;
  error_message?: string | null;
  scheduled_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  completed_at?: string | null;
  created_at?: string;
  scenes?: SceneRunScene[];
}

interface StepRunRow {
  id?: string;
  task_name?: string;
  status?: string;
  total_steps?: number;
  current_step_index?: number;
  steps?: unknown[];
  step_results?: unknown[];
  error_message?: string | null;
  created_at?: string;
  completed_at?: string | null;
  scheduled_at?: string | null;
  workflow_id?: string;
}

// Backend status enums vary across paths. Group them inclusively.
const SCENE_TERMINAL_OK = new Set(["completed", "complete", "succeeded", "success", "done"]);
const SCENE_TERMINAL_FAIL = new Set(["failed", "error", "errored"]);
const SCENE_CANCELLED = new Set(["cancelled", "canceled"]);

export interface WorkflowRunTranslateOpts {
  runId: string;
  /** Tool name echoed for the Recreate button on completed cards. */
  toolName?: string;
  /** Args echoed for Recreate. */
  toolArgs?: Record<string, unknown>;
  /** Which MCP tool the iframe should call to refresh state.
   *  Different for /workflows vs /video-workflows. */
  pollTool: "versely_get_workflow_run" | "versely_get_video_workflow_run";
  /** What argument shape that poll tool expects.
   *  `task_id` for versely_get_workflow_run, `run_id` for video. */
  pollArgKey: "run_id";
  /** Include the iframe poll instruction. Set true ONLY on the initial card
   *  emitted by a *run/start* call — poll responses don't need it (the iframe
   *  is already looping). */
  includePoll?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
}

const DEFAULT_INTERVAL_MS = 5000;
/** 30 min — multi-scene workflow runs with combine can run long. */
const DEFAULT_TIMEOUT_MS = 1_800_000;

// ─── Shape normalization ─────────────────────────────────────────────────────

interface NormalizedRun {
  mode: "scenes" | "steps";
  run: SceneRunRow | StepRunRow;
  scenes: SceneRunScene[];
}

/** Pull a normalized view from any of the three response shapes. */
function normalizeRun(payload: unknown): NormalizedRun | null {
  if (!payload || typeof payload !== "object") return null;
  const top = payload as Record<string, unknown>;

  // Unwrap a single layer of `{ success, ...rest }` if present.
  const root = (top.data && typeof top.data === "object" ? top.data : top) as Record<string, unknown>;

  // ── Shape A: unified detail wrapper { mode, run, scenes? }
  const mode = root.mode;
  if (mode === "scenes" || mode === "steps") {
    const run = (root.run as SceneRunRow | StepRunRow | undefined) ?? {};
    const scenes = Array.isArray(root.scenes) ? (root.scenes as SceneRunScene[]) : [];
    return { mode: mode as "scenes" | "steps", run, scenes };
  }

  // ── Shape B: native video-workflow run { run, scenes }
  if (root.run && typeof root.run === "object") {
    const run = root.run as SceneRunRow;
    const scenes = Array.isArray(root.scenes) ? (root.scenes as SceneRunScene[]) : [];
    return { mode: "scenes", run, scenes };
  }

  // ── Shape C: flat run object (the row itself, no wrapper)
  // Heuristic: if it has total_scenes or current_scene_order, it's a scene run;
  // if it has total_steps or current_step_index, it's a step run.
  if ("total_scenes" in root || "current_scene_order" in root || "final_video_url" in root) {
    return {
      mode: "scenes",
      run: root as SceneRunRow,
      scenes: Array.isArray(root.scenes) ? (root.scenes as SceneRunScene[]) : [],
    };
  }
  if ("total_steps" in root || "current_step_index" in root || "step_results" in root) {
    return { mode: "steps", run: root as StepRunRow, scenes: [] };
  }

  return null;
}

// ─── Scenes-mode rendering ───────────────────────────────────────────────────

function renderScenesRun(
  norm: NormalizedRun & { mode: "scenes" },
  opts: WorkflowRunTranslateOpts,
): ToolResult {
  const run = norm.run as SceneRunRow;
  const scenes = norm.scenes;
  const status = String(run.status ?? "pending").toLowerCase();
  const title = run.title || `Workflow run ${opts.runId}`;
  const totalScenes = run.total_scenes ?? scenes.length;
  const orderedScenes = [...scenes].sort(
    (a, b) => (a.scene_order ?? 0) - (b.scene_order ?? 0),
  );
  const completedScenes = orderedScenes.filter(
    (s) => SCENE_TERMINAL_OK.has(String(s.status ?? "").toLowerCase()) && s.video_url,
  );
  const failedScenes = orderedScenes.filter((s) =>
    SCENE_TERMINAL_FAIL.has(String(s.status ?? "").toLowerCase()),
  );

  const sceneAssets = completedScenes.map((s, idx) => ({
    url: s.video_url as string,
    label: `Scene ${s.scene_order ?? idx + 1}`,
  }));
  const finalUrl = run.final_video_url ?? null;

  const baseEcho: Record<string, unknown> = {
    title,
    mode: "scenes",
    scenes_total: totalScenes,
    scenes_completed: completedScenes.length,
    scenes_failed: failedScenes.length,
    current_scene_order: run.current_scene_order,
    ...(opts.toolName ? { toolName: opts.toolName } : {}),
    ...(opts.toolArgs ? { toolArgs: opts.toolArgs } : {}),
  };

  // ── Completed ──
  if ((status === "completed" || SCENE_TERMINAL_OK.has(status)) && finalUrl) {
    return {
      content: [
        {
          type: "text",
          text: `${title} ready — ${completedScenes.length} of ${totalScenes} scene${totalScenes === 1 ? "" : "s"}.\n${finalUrl}`,
        },
      ],
      structuredContent: {
        kind: "video" as const,
        assets: [{ url: finalUrl, label: "Final video" }, ...sceneAssets],
        status: "completed" as const,
        task_id: opts.runId,
        final_video_url: finalUrl,
        ...baseEcho,
      },
    };
  }

  // ── Cancelled (terminal but soft) ──
  if (SCENE_CANCELLED.has(status)) {
    return {
      content: [
        {
          type: "text",
          text: `${title} was cancelled. ${completedScenes.length} of ${totalScenes} scene${totalScenes === 1 ? "" : "s"} kept.`,
        },
      ],
      structuredContent: {
        kind: "gallery" as const,
        assets: sceneAssets,
        status: "failed" as const, // tells iframe to stop polling
        task_id: opts.runId,
        error: "Run was cancelled by the user.",
        cancelled: true,
        ...baseEcho,
      },
    };
  }

  // ── Failed ──
  const allTerminal = orderedScenes.every((s) => {
    const st = String(s.status ?? "").toLowerCase();
    return SCENE_TERMINAL_OK.has(st) || SCENE_TERMINAL_FAIL.has(st) || SCENE_CANCELLED.has(st);
  });
  if (SCENE_TERMINAL_FAIL.has(status) || (allTerminal && failedScenes.length > 0 && completedScenes.length === 0)) {
    const firstError =
      run.error_message ||
      orderedScenes.find((s) => s.error_message)?.error_message ||
      `Run failed (${failedScenes.length} of ${totalScenes} scene${totalScenes === 1 ? "" : "s"} failed).`;
    return {
      content: [{ type: "text", text: `${title} failed: ${firstError}` }],
      structuredContent: {
        kind: "gallery" as const,
        assets: sceneAssets,
        status: "failed" as const,
        task_id: opts.runId,
        error: firstError,
        ...baseEcho,
      },
      isError: true,
    };
  }

  // ── Pending ──
  const progress = totalScenes > 0 ? completedScenes.length / totalScenes : 0;
  const phaseLabel =
    status === "combining"
      ? "combining final video"
      : status === "queued"
        ? "queued"
        : failedScenes.length > 0
          ? `running (${failedScenes.length} scene${failedScenes.length === 1 ? "" : "s"} failed so far)`
          : "running";
  const summary = `${title} — ${completedScenes.length} of ${totalScenes} scene${totalScenes === 1 ? "" : "s"} ready, ${phaseLabel}…`;

  const structuredContent: Record<string, unknown> = {
    kind: "gallery" as const,
    assets: sceneAssets,
    status: "pending" as const,
    task_id: opts.runId,
    progress,
    phase: status,
    ...baseEcho,
  };
  if (opts.includePoll) {
    structuredContent.poll = {
      tool_name: opts.pollTool,
      args: { [opts.pollArgKey]: opts.runId },
      interval_ms: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
      timeout_ms: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

// ─── Steps-mode rendering (legacy background_tasks runs) ─────────────────────

function renderStepsRun(
  norm: NormalizedRun & { mode: "steps" },
  opts: WorkflowRunTranslateOpts,
): ToolResult {
  const run = norm.run as StepRunRow;
  const status = String(run.status ?? "pending").toLowerCase();
  const title = run.task_name || `Workflow run ${opts.runId}`;
  const totalSteps = run.total_steps ?? (Array.isArray(run.steps) ? run.steps.length : 0);
  const currentStep = run.current_step_index ?? 0;

  // Step runs don't have asset URLs in a uniform place. We walk step_results
  // for any obvious media URLs so completed cards still render something.
  const stepResults = Array.isArray(run.step_results) ? run.step_results : [];
  const URL_RX = /\bhttps?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|m4a)\b/i;
  const collectedAssets: { url: string; label: string }[] = [];
  for (let i = 0; i < stepResults.length; i++) {
    const r = stepResults[i];
    const text = typeof r === "string" ? r : JSON.stringify(r);
    const match = text.match(URL_RX);
    if (match) collectedAssets.push({ url: match[0], label: `Step ${i + 1}` });
  }

  const baseEcho: Record<string, unknown> = {
    title,
    mode: "steps",
    total_steps: totalSteps,
    current_step_index: currentStep,
    ...(opts.toolName ? { toolName: opts.toolName } : {}),
    ...(opts.toolArgs ? { toolArgs: opts.toolArgs } : {}),
  };

  // ── Completed ──
  if (SCENE_TERMINAL_OK.has(status)) {
    return {
      content: [
        {
          type: "text",
          text: collectedAssets.length > 0
            ? `${title} finished (${totalSteps} step${totalSteps === 1 ? "" : "s"}).`
            : `${title} finished — no media assets in step results.`,
        },
      ],
      structuredContent: {
        kind: collectedAssets.length === 1 ? ("video" as const) : ("gallery" as const),
        assets: collectedAssets,
        status: "completed" as const,
        task_id: opts.runId,
        ...baseEcho,
      },
    };
  }

  // ── Cancelled ──
  if (SCENE_CANCELLED.has(status)) {
    return {
      content: [{ type: "text", text: `${title} was cancelled.` }],
      structuredContent: {
        kind: "gallery" as const,
        assets: collectedAssets,
        status: "failed" as const,
        task_id: opts.runId,
        error: "Run was cancelled.",
        cancelled: true,
        ...baseEcho,
      },
    };
  }

  // ── Failed ──
  if (SCENE_TERMINAL_FAIL.has(status)) {
    const err = run.error_message || `Run failed at step ${currentStep + 1} of ${totalSteps}.`;
    return {
      content: [{ type: "text", text: `${title} failed: ${err}` }],
      structuredContent: {
        kind: "gallery" as const,
        assets: collectedAssets,
        status: "failed" as const,
        task_id: opts.runId,
        error: err,
        ...baseEcho,
      },
      isError: true,
    };
  }

  // ── Pending ──
  const progress = totalSteps > 0 ? currentStep / totalSteps : 0;
  const summary = `${title} — step ${currentStep + 1} of ${totalSteps || "?"}…`;
  const structuredContent: Record<string, unknown> = {
    kind: "gallery" as const,
    assets: collectedAssets,
    status: "pending" as const,
    task_id: opts.runId,
    progress,
    phase: status,
    // Bridge field so renderPending picks the movie/workflow-aware headline
    // path (it keys off `scenes_total > 0`). For step runs we surface step
    // counts under the same field so the LLM/iframe stays consistent.
    scenes_total: totalSteps,
    scenes_completed: currentStep,
    ...baseEcho,
  };
  if (opts.includePoll) {
    structuredContent.poll = {
      tool_name: opts.pollTool,
      args: { [opts.pollArgKey]: opts.runId },
      interval_ms: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
      timeout_ms: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Translate any of the three backend run-detail shapes into a MediaCardPayload
 * the iframe poll handler can render. Falls back to plain jsonResult if the
 * shape is unrecognized so the tool never silently drops data.
 */
export function workflowRunToCardPayload(
  payload: unknown,
  opts: WorkflowRunTranslateOpts,
): ToolResult {
  const norm = normalizeRun(payload);
  if (!norm) return jsonResult(payload);
  if (norm.mode === "scenes") return renderScenesRun(norm as NormalizedRun & { mode: "scenes" }, opts);
  return renderStepsRun(norm as NormalizedRun & { mode: "steps" }, opts);
}
