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
  "Versely makes videos, remixes (the user swapped into a clip), talking ads, captions, voiceovers, images, music, slideshows and dubs. " +
  "Creations run in the background and spend the user's Versely credits: call a creation tool once, never resubmit. " +
  "The card updates itself; results: versely_get_task_status (movies: versely_get_movie_status, dubs: versely_get_dub). " +
  "Pick models from versely_find_models (all models, ranked). On the free trial use only models marked free_trial. " +
  "Never suggest buying credits.";

export const OPENAI_INSTRUCTIONS_DETAIL =
  "Details. versely_find_models lists every Versely model with its leaderboard rank and score, so you can " +
  "recommend and compare models by quality and price. Pass a model's `name` as `model`, and any extra inputs " +
  "from versely_get_model_inputs as top-level arguments of the same call. Media inputs must be public https " +
  "URLs; Versely URLs from earlier results work. A photo, video or audio file the user attaches is stored with " +
  "versely_upload_media (free), and the URL it returns is used from then on. If a creation call errors with a timeout, the job may " +
  "still have started: check versely_list_user_media before calling again. When a result says it matches " +
  "an earlier request, that earlier job was reused and not charged again; pass confirm_repeat: true only " +
  "when the user clearly wants another copy. An account on the free trial (on_free_trial in " +
  "versely_find_models, free_account in versely_get_credits) spends free plugin credits and can generate " +
  "images, videos and voiceovers only with models marked free_trial; if the user asks for another model, " +
  "say it isn't included in the free trial and suggest the best free_trial one. Other features return a " +
  "message saying they are unavailable, and nothing is charged for them. That free trial is only the plugin's " +
  "free credits for an account that has never paid: a subscription trial (on_trial in versely_get_subscription) " +
  "is a different thing, is not always free, and has none of these limits. Do not offer or link to credit purchases. " +
  "Social posting: to connect an account, give the user the link from versely_get_social_auth_url; once they " +
  "say they connected, call versely_refresh_social_accounts, then versely_list_social_accounts for the account " +
  "ids. Confirm the caption, media and accounts with the user before versely_publish_post. " +
  "Recurring content: a slideshow automation (versely_create_slideshow_automation, free; options from " +
  "versely_list_slideshow_options) makes slideshows only when versely_create_automation_posts queues them, one post a " +
  "day at its posting time; quote them first with versely_quote_automation_posts and show the user the credits and the " +
  "days before queueing them with confirm_credits. Scheduled workflows: versely_update_workflow_mode. " +
  "When the user has to choose a slideshow style, an avatar, a voice, a template or one of their brands, open " +
  "versely_browse (a visual picker; their pick arrives as their next message) instead of listing options in text. " +
  "Brands: read one from its link with versely_analyze_brand, then versely_create_brand_slideshow or a slideshow " +
  "automation with its brand_kit_id. Ideas: show viral outliers with versely_browse (collection 'inspiration', " +
  "category = niche) and recreate the one the user picks with versely_recreate_inspiration; versely_analyze_post " +
  "explains why a post worked. Hook videos: show ready-made clips with versely_browse (collection 'hook_library') " +
  "and remake the picks with versely_reuse_hooks, or write new ones for a brand with versely_create_hook_pack; " +
  "quote the cost first with versely_quote_hooks. " +
  "Remix (\"put me in this video\", a face, outfit or product swap, \"make my avatar do this dance\"): show trending " +
  "clips with versely_browse (collection 'remix_trends'), or take the user's post link or their own stored video; " +
  "versely_prepare_remix_clip (free), then versely_quote_swap. Show the price and ask the user to confirm it, that " +
  "they own the clip or may use it, and that anyone whose photo goes in has agreed; only after their yes call " +
  "versely_swap_video with confirm_credits and rights_confirmed. Never put a public figure's face in, and nothing " +
  "sexual. " +
  "Talking ads (a presenter reads the user's script on camera): versely_list_ugc_actors, versely_write_ugc_script " +
  "(free), versely_quote_ugc_ads, then versely_create_ugc_ads with confirm_credits after the user's yes. Avatars are " +
  "the user's hook characters; versely_list_ready_made_avatars shows the ready-made cast and " +
  "versely_add_ready_made_avatar (free) adds one. Captions on a video with speech: versely_caption_video with a look " +
  "from versely_list_caption_looks (free looks start at once; a premium look returns its price first). Music video " +
  "for one of the user's songs: versely_quote_music_video, then versely_create_music_video. A new look for a photo: " +
  "versely_list_photo_looks (the price list), then versely_apply_photo_look. A script to film from a viral reel or " +
  "an idea: versely_write_script (returns its price first). AI creator (a virtual creator that posts a video every " +
  "day): versely_list_ai_creator_options, versely_make_ai_creator_rooms, versely_create_ai_creator, " +
  "versely_test_ai_creator_episode, then versely_approve_ai_creator; before each paid step state the exact credits, " +
  "and before approval the daily time, the account and the credits per day. Every paid tool that takes " +
  "confirm_credits is called only after the user saw that exact price and said yes. " +
  "Short dramas (a series, web series, micro drama, sitcom or \"a show\"): ask at most 2 short multiple-choice rounds, " +
  "including the quality: Standard (sharp 1080p, about 300 credits for 30 s) or High quality " +
  "(about 320 at 480p, 640 at 720p); " +
  "then plan for free with versely_plan_drama_show; show the cast, episode titles, Episode 1's lines and the exact " +
  "credits, and call versely_film_drama_episode with confirm_credits only after the user says yes. Characters are " +
  "fictional adults; no real people or brands.";

export function serverInstructions(profile: Profile): string | undefined {
  if (profile !== "openai") return undefined;
  return `${OPENAI_INSTRUCTIONS_LEAD}\n\n${OPENAI_INSTRUCTIONS_DETAIL}`;
}
