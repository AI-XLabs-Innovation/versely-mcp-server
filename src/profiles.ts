// Tool profiles: which slice of the catalog a caller is served.
//
//   full   - everything (claude.ai, Claude Code, Cursor, vsk_ API-key users).
//   openai - the curated ChatGPT-plugin set: creation tools that write to the
//            user's private Versely library, social posting to the accounts
//            the user connects, and read-only account details
//            (see tools/_policy.ts). Free-trial accounts are limited to
//            RunPod-served models by the backend.
//
// ChatGPT is identified by the signed `ck: "openai"` claim the backend puts in
// the OAuth access tokens it issues to ChatGPT. That claim is sticky: a
// ChatGPT token gets the openai profile whatever the request asks for. Any
// other caller may RESTRICT itself to openai (?profile=openai or the
// X-Versely-Profile header), which is how the plugin surface is tested with a
// vsk_ key. Nothing can widen a profile.

export type Profile = "full" | "openai";

export const ALL_PROFILES: readonly Profile[] = ["full", "openai"];

export function isProfile(value: unknown): value is Profile {
  return value === "full" || value === "openai";
}

/**
 * @param ck        the verified JWT's `ck` claim, when the bearer is one of
 *                  our OAuth tokens (never read from a header).
 * @param requested whatever the request asked for (query / header). Only ever
 *                  honoured to NARROW to "openai".
 */
export function resolveProfile(args: {
  ck?: string | null;
  requested?: string | readonly string[] | null;
}): Profile {
  if (args.ck === "openai") return "openai";
  const asked = Array.isArray(args.requested)
    ? args.requested
    : typeof args.requested === "string"
      ? [args.requested]
      : [];
  if (asked.some((v) => typeof v === "string" && v.trim().toLowerCase() === "openai")) {
    return "openai";
  }
  return "full";
}

/**
 * Parse a comma-separated profile list from an env var. Unset means the code
 * default; an empty value (or "none") switches the feature off everywhere,
 * which is the rollback lever for MCP_DEDUPE_PROFILES / MCP_CARD_V2_PROFILES.
 */
export function parseProfileList(
  raw: string | undefined,
  fallback: readonly Profile[],
): ReadonlySet<Profile> {
  if (raw === undefined) return new Set(fallback);
  const out = new Set<Profile>();
  for (const part of raw.split(",")) {
    const p = part.trim().toLowerCase();
    if (isProfile(p)) out.add(p);
  }
  return out;
}

// --- Server instructions -------------------------------------------------------
// ChatGPT reads the server's `instructions`, and the first 512 characters carry
// the most weight, so the lead paragraph holds every rule that protects the
// user's credits. Factual only: OpenAI's guidelines forbid promotional copy and
// any nudge towards buying. claude.ai (full profile) gets none — its tool
// descriptions already carry this guidance and it was never asked for.

// Kept at or under 512 characters (the smoke test enforces it). Every tool name
// here must exist in the openai profile.
export const OPENAI_INSTRUCTIONS_LEAD =
  "Versely makes videos, UGC-style ads, voiceovers, images, music, slideshows and dubbed videos. " +
  "Creations run in the background and spend the user's Versely credits: call a creation tool once, never resubmit. " +
  "The card updates itself; results: versely_get_task_status (movies: versely_get_movie_status, dubs: versely_get_dub). " +
  "Pick models from versely_find_models (all models, ranked). On the free trial use only models marked free_trial. " +
  "Never suggest buying credits.";

export const OPENAI_INSTRUCTIONS_DETAIL =
  "Details. versely_find_models lists every Versely model with its leaderboard rank and score, so you can " +
  "recommend and compare models by quality and price. Pass a model's `name` as `model`, and any extra inputs " +
  "from versely_get_model_inputs as top-level arguments of the same call. Media inputs must be public https " +
  "URLs; Versely URLs from earlier results work. If a creation call errors with a timeout, the job may " +
  "still have started: check versely_list_user_media before calling again. When a result says it matches " +
  "an earlier request, that earlier job was reused and not charged again; pass confirm_repeat: true only " +
  "when the user clearly wants another copy. An account on the free trial (on_free_trial in " +
  "versely_find_models, free_account in versely_get_credits) spends free plugin credits and can generate " +
  "images, videos and voiceovers only with models marked free_trial; if the user asks for another model, " +
  "say it isn't included in the free trial and suggest the best free_trial one. Other features return a " +
  "message saying they are unavailable, and nothing is charged for them. Do not offer or link to credit purchases. " +
  "Social posting: to connect an account, give the user the link from versely_get_social_auth_url; once they " +
  "say they connected, call versely_refresh_social_accounts, then versely_list_social_accounts for the account " +
  "ids. Confirm the caption, media and accounts with the user before versely_publish_post.";

export function serverInstructions(profile: Profile): string | undefined {
  if (profile !== "openai") return undefined;
  return `${OPENAI_INSTRUCTIONS_LEAD}\n\n${OPENAI_INSTRUCTIONS_DETAIL}`;
}
