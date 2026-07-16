// Slug → canonical-name resolver.
//
// The backend dispatcher's `PROVIDER_MODELS` map is keyed by canonical model
// name (e.g. "Flux Pro Ultra"), but the catalog endpoint exposes models by
// slug (e.g. "flux-pro-ultra"). When Claude follows the natural pattern
// "find_models → take slug → call generate", the dispatcher rejects the slug
// with HTTP 400 "Model not supported".
//
// Until the backend learns slugs, the MCP transparently resolves whichever
// identifier the caller supplied to the canonical name on the way out.

import type { ToolContext } from "./_types.js";

export type ResolvableType = "image" | "video" | "audio" | "lipsync";

const CATALOG_PATHS: Record<ResolvableType, string> = {
  image: "/api/v1/ai-models/images",
  video: "/api/v1/ai-models/videos",
  audio: "/api/v1/ai-models/audio",
  lipsync: "/api/v1/ai-models/lipsync",
};

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CatalogEntry {
  fetchedAt: number;
  bySlugLower: Map<string, string>;         // lowercased slug → canonical name
  byNameLower: Map<string, string>;         // lowercased name → canonical name
  byDisplayNameLower: Map<string, string>;  // lowercased display_name → canonical name
}

interface CatalogResponse {
  data?: { models?: Array<{ slug?: string; name?: string; display_name?: string }> };
}

const catalogCache = new Map<string, CatalogEntry>();

async function loadCatalog(ctx: ToolContext, type: ResolvableType): Promise<CatalogEntry> {
  const key = `${ctx.config.apiUrl}|${type}`;
  const existing = catalogCache.get(key);
  if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) return existing;

  const res = await ctx.client.get<CatalogResponse>(CATALOG_PATHS[type]);
  const models = res?.data?.models ?? [];
  const bySlugLower = new Map<string, string>();
  const byNameLower = new Map<string, string>();
  const byDisplayNameLower = new Map<string, string>();
  for (const m of models) {
    if (m.slug && m.name) bySlugLower.set(m.slug.toLowerCase(), m.name);
    if (m.name) byNameLower.set(m.name.toLowerCase(), m.name);
    // ai_models.name is the immutable dispatch key; display_name is the label a
    // human actually sees and can diverge from it (models are renamed via
    // display_name only). Someone passing the visible label would otherwise fall
    // through unresolved and hit "Model not supported".
    if (m.display_name && m.name) {
      byDisplayNameLower.set(m.display_name.toLowerCase(), m.name);
    }
  }
  const entry: CatalogEntry = {
    fetchedAt: Date.now(),
    bySlugLower,
    byNameLower,
    byDisplayNameLower,
  };
  catalogCache.set(key, entry);
  return entry;
}

/**
 * Translate a user-supplied model identifier (slug, canonical name, or any
 * casing thereof) to the exact canonical name the dispatcher expects.
 *
 * Returns the input unchanged when:
 *   - the input is empty or non-string
 *   - the catalog fetch fails (network / 5xx) — degrade gracefully so the
 *     backend's own "Model not supported" error still surfaces
 *   - the input matches neither a known slug nor a known name (lets the user
 *     try arbitrary values; backend will reject if invalid)
 */
export async function resolveCanonicalModel(
  ctx: ToolContext,
  type: ResolvableType,
  modelInput: string,
): Promise<string>;
export async function resolveCanonicalModel(
  ctx: ToolContext,
  type: ResolvableType,
  modelInput: string | undefined,
): Promise<string | undefined>;
export async function resolveCanonicalModel(
  ctx: ToolContext,
  type: ResolvableType,
  modelInput: string | undefined,
): Promise<string | undefined> {
  if (typeof modelInput !== "string" || !modelInput) return modelInput;
  try {
    const catalog = await loadCatalog(ctx, type);
    const lower = modelInput.toLowerCase();
    // Canonical name wins, then slug, then the human-facing display_name.
    const byName = catalog.byNameLower.get(lower);
    if (byName) return byName;
    const bySlug = catalog.bySlugLower.get(lower);
    if (bySlug) return bySlug;
    const byDisplay = catalog.byDisplayNameLower.get(lower);
    if (byDisplay) return byDisplay;
    return modelInput;
  } catch {
    return modelInput;
  }
}
