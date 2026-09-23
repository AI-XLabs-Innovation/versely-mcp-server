// Plugin model catalog (cross-repo contract 5).
//
// The ChatGPT plugin only ever shows models RunPod serves: the backend's
// GET /api/v1/ai-models/plugin-catalog lists exactly those (provider chain
// starts with runpod and the model is in RUNPOD_MODEL_MAP), each with the
// inputs our /generate/* body accepts for it — derived from RunPod's own
// request schemas, so ChatGPT can fill parameters instead of asking.
//
// Deploy order is backend → MCP, but the MCP must not break if it lands first:
// when the endpoint 404s we fall back to the regular catalog filtered to
// RunPod-discounted models (same model set, no parameter detail) and say so.

import type { ToolContext } from "./_types.js";
import { VerselyApiError } from "../errors.js";

export type PluginModelType = "image" | "video" | "audio";

export interface PluginParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: Array<string | number>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface PluginVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
}

export interface PluginModel {
  name: string;
  display_name: string;
  type: PluginModelType;
  modes: string[];
  requires_image: boolean;
  /** RunPod-discounted price: image per image, video per 5s at default resolution, audio per 1,000 chars. */
  credits: number;
  credits_note?: string;
  params: PluginParam[];
  params_by_mode?: Record<string, PluginParam[]>;
  voices?: PluginVoice[];
}

export const PLUGIN_MODEL_TYPES: readonly PluginModelType[] = ["image", "video", "audio"];

export const PLUGIN_CREDITS_NOTE =
  "`credits` is the price in Versely credits: per image for image models, per 5 seconds of video at the " +
  "default resolution for video models, per 1,000 characters for voiceover models.";

const CACHE_TTL_MS = 5 * 60_000;
/** A missing endpoint is re-checked sooner, so a backend deploy is picked up quickly. */
const UNAVAILABLE_TTL_MS = 60_000;

interface CacheEntry<T> {
  at: number;
  ttl: number;
  value: T;
}
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, load: () => Promise<{ value: T; ttl: number }>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const { value, ttl } = await load();
  cache.set(key, { at: Date.now(), ttl, value });
  return value;
}

function cacheKey(ctx: ToolContext, ...parts: string[]): string {
  // Priced data: vsk_ keys and OAuth connectors can be quoted differently.
  return [ctx.config.apiUrl, ctx.client.authKind(), ...parts].join("|");
}

function isNotFound(err: unknown): err is VerselyApiError {
  return err instanceof VerselyApiError && err.status === 404;
}

function asPluginModel(v: unknown): PluginModel | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name) return null;
  const type = m.type;
  if (type !== "image" && type !== "video" && type !== "audio") return null;
  return {
    name: m.name,
    display_name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.name,
    type,
    modes: Array.isArray(m.modes) ? m.modes.filter((x): x is string => typeof x === "string") : [],
    requires_image: Boolean(m.requires_image),
    credits: typeof m.credits === "number" ? m.credits : 0,
    ...(typeof m.credits_note === "string" ? { credits_note: m.credits_note } : {}),
    params: Array.isArray(m.params) ? (m.params as PluginParam[]) : [],
    ...(m.params_by_mode && typeof m.params_by_mode === "object"
      ? { params_by_mode: m.params_by_mode as Record<string, PluginParam[]> }
      : {}),
    ...(Array.isArray(m.voices) ? { voices: m.voices as PluginVoice[] } : {}),
  };
}

export type CatalogListing =
  | { available: true; models: PluginModel[] }
  | { available: false };

/** GET /plugin-catalog?type= — `available: false` when the backend doesn't serve it yet. */
export function loadPluginCatalog(ctx: ToolContext, type: PluginModelType): Promise<CatalogListing> {
  return cached<CatalogListing>(cacheKey(ctx, "plugin-list", type), async () => {
    try {
      const res = await ctx.client.get<{ data?: { models?: unknown[] } }>(
        "/api/v1/ai-models/plugin-catalog",
        { query: { type } },
      );
      const list = res?.data?.models;
      if (!Array.isArray(list)) return { value: { available: false }, ttl: UNAVAILABLE_TTL_MS };
      const models = list
        .map(asPluginModel)
        .filter((m): m is PluginModel => m !== null && m.type === type);
      return { value: { available: true, models }, ttl: CACHE_TTL_MS };
    } catch (err) {
      if (isNotFound(err)) return { value: { available: false }, ttl: UNAVAILABLE_TTL_MS };
      throw err;
    }
  });
}

export type ModelLookup =
  | { status: "found"; model: PluginModel }
  /** The backend answered: this model is not in the plugin catalog. */
  | { status: "not_in_catalog" }
  /** The endpoint itself isn't there (backend not deployed yet). */
  | { status: "unavailable" };

/** GET /plugin-catalog/:name */
export function loadPluginModel(ctx: ToolContext, name: string): Promise<ModelLookup> {
  return cached<ModelLookup>(cacheKey(ctx, "plugin-model", name.toLowerCase()), async () => {
    try {
      const res = await ctx.client.get<{ data?: unknown }>(
        `/api/v1/ai-models/plugin-catalog/${encodeURIComponent(name)}`,
      );
      const model = asPluginModel(res?.data);
      if (!model) return { value: { status: "unavailable" } as ModelLookup, ttl: UNAVAILABLE_TTL_MS };
      return { value: { status: "found", model } as ModelLookup, ttl: CACHE_TTL_MS };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const body = err.body as Record<string, unknown> | undefined;
      const code = body && typeof body === "object" ? body.error : undefined;
      return code === "model_not_in_plugin_catalog"
        ? { value: { status: "not_in_catalog" } as ModelLookup, ttl: CACHE_TTL_MS }
        : { value: { status: "unavailable" } as ModelLookup, ttl: UNAVAILABLE_TTL_MS };
    }
  });
}

// --- Regular catalog (fallback + full-profile lookups) -------------------------

export interface CatalogModel {
  slug?: string;
  name?: string;
  display_name?: string;
  provider?: string;
  content_type?: string;
  categories?: string[];
  credits?: number;
  requires_image?: boolean;
  is_runpod_discounted?: boolean;
  reference_config?: Record<string, unknown> | null;
  max_reference?: number | null;
  accepts_video_input?: boolean;
  requires_video_input?: boolean;
  released_at?: string;
  /** Best rank across the model's leaderboard categories (1 = best), and its score (ELO). */
  best_rank_overall?: number | null;
  best_score_overall?: number | null;
  /** Rank per category (e.g. {"text-to-video": 3}). */
  best_rank_by_category?: Record<string, number> | null;
  price_matrix?: Record<string, unknown> | null;
  supports_aspect_ratios?: unknown;
  supports_durations?: unknown;
  supports_qualities?: unknown;
  supports_styles?: unknown;
}

export type CatalogType = PluginModelType | "lipsync";

const CATALOG_PATHS: Record<CatalogType, string> = {
  image: "/api/v1/ai-models/images",
  video: "/api/v1/ai-models/videos",
  audio: "/api/v1/ai-models/audio",
  lipsync: "/api/v1/ai-models/lipsync",
};

export function loadCatalogModels(ctx: ToolContext, type: CatalogType): Promise<CatalogModel[]> {
  return cached<CatalogModel[]>(cacheKey(ctx, "catalog", type), async () => {
    const query: Record<string, string> = type === "audio" ? { dispatcher_only: "true" } : { pickable: "true" };
    const res = await ctx.client.get<{ data?: { models?: CatalogModel[] } }>(CATALOG_PATHS[type], { query });
    const models = Array.isArray(res?.data?.models) ? res.data!.models! : [];
    return { value: models, ttl: CACHE_TTL_MS };
  });
}

const CATEGORY_MODES: Record<string, string> = {
  "text-to-image": "t2i",
  "image-to-image": "i2i",
  "edit-image": "i2i",
  "text-to-video": "t2v",
  "image-to-video": "i2v",
  "text-to-audio": "tts",
};

export function modesFromCategories(categories: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const c of categories ?? []) {
    const m = CATEGORY_MODES[c];
    if (m) out.add(m);
  }
  return [...out];
}

/** Fallback listing: the regular catalog restricted to RunPod-served models. */
export async function runpodFallbackModels(ctx: ToolContext, type: PluginModelType): Promise<PluginModel[]> {
  const models = await loadCatalogModels(ctx, type);
  return models
    .filter((m) => m.is_runpod_discounted === true && typeof m.name === "string" && m.name)
    .map((m) => ({
      name: m.name!,
      display_name: m.display_name || m.name!,
      type,
      modes: modesFromCategories(m.categories),
      requires_image: Boolean(m.requires_image),
      credits: typeof m.credits === "number" ? m.credits : 0,
      params: [],
    }));
}

export function findCatalogModel(models: readonly CatalogModel[], wanted: string): CatalogModel | undefined {
  const w = wanted.trim().toLowerCase();
  return (
    models.find((m) => m.name?.toLowerCase() === w) ??
    models.find((m) => m.slug?.toLowerCase() === w) ??
    models.find((m) => m.display_name?.toLowerCase() === w)
  );
}

// --- Presentation ---------------------------------------------------------------

/** Inputs every generate call already has; not worth repeating per model. */
const SUMMARY_SKIP = new Set(["prompt", "model", "text"]);

/** One short line of a model's extra inputs, for find_models listings. */
export function summarizeParams(params: readonly PluginParam[], maxLen = 220): string {
  const parts: string[] = [];
  for (const p of params) {
    if (!p || typeof p.name !== "string" || SUMMARY_SKIP.has(p.name)) continue;
    let s = p.name;
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      const shown = p.enum.slice(0, 5).map(String).join("|");
      s += ` (${shown}${p.enum.length > 5 ? "|..." : ""})`;
    } else if (typeof p.minimum === "number" || typeof p.maximum === "number") {
      s += ` (${p.minimum ?? ""}-${p.maximum ?? ""})`;
    }
    if (p.required) s += " required";
    parts.push(s);
  }
  if (parts.length === 0) return "no extra inputs";
  const line = parts.join(", ");
  return line.length <= maxLen ? line : `${line.slice(0, maxLen - 3)}...`;
}

export function compactModel(m: PluginModel, opts: { withParams: boolean }): Record<string, unknown> {
  return {
    name: m.name,
    ...(m.display_name && m.display_name !== m.name ? { display_name: m.display_name } : {}),
    type: m.type,
    modes: m.modes,
    requires_image: m.requires_image,
    credits: m.credits,
    ...(m.credits_note ? { credits_note: m.credits_note } : {}),
    params: opts.withParams ? summarizeParams(m.params) : "unavailable right now",
  };
}
