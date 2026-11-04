// Short dramas (backend /drama/*, web /dramas): a vertical 9:16 series made
// from one idea. The planner writes the season, casts 2 leads + up to 4
// supporting characters (with portraits; the user's own avatars first, then
// Versely's ready-made characters, a new character only when none fits),
// builds the locations and writes Episode 1, all free. Each episode is then
// filmed after the user approves its script and one credit price (~10 min in
// the background), with the same cast every episode. Two quality tiers,
// "Standard" and "High quality", set per show (quality + resolution) and
// changeable for free until filming; they set the price. The REST API is
// wrapped 1:1:
//
//   POST   /drama/shows                          plan (free, sync, <= ~40 s)
//   GET    /drama/shows                          list
//   GET    /drama/shows/:id                      get
//   PATCH  /drama/shows/:id                      edit (free; refused while filming)
//   POST   /drama/shows/:id/episodes/:n/script   write / rewrite (free)
//   GET    /drama/shows/:id/episodes/:n/quote    price
//   POST   /drama/shows/:id/episodes/:n/film     film (PAID; confirm_credits must equal the quote, 409 otherwise)
//
// The film result is a pending media card that follows the episode through
// versely_get_drama_show (a card poll target, server.ts). Text results carry
// the cast, the season and the episode's lines, so the model can show the
// user exactly what they approve. No provider or model names anywhere.

import { z } from "zod";
import { defineTool, type Tool, type ToolResult } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { VerselyApiError } from "../errors.js";
import { metaForMediaCard } from "../ui/templates.js";

// --- Backend shapes (the build contract, 2026-11-04) -------------------------

const GENRES = [
  "revenge",
  "romance",
  "contract-marriage",
  "ceo-romance",
  "hidden-identity",
  "comedy",
  "mystery",
  "family",
  "thriller",
  "other",
] as const;

const QUALITIES = ["standard", "high"] as const;
/** Standard films at 540p or 720p, High quality at 480p or 720p; the backend moves a mismatch to the tier's lower one. */
const RESOLUTIONS = ["480p", "540p", "720p"] as const;

type EpisodeStatus = "planned" | "scripted" | "filming" | "ready" | "failed";

interface DramaCharacter {
  key: string;
  name: string;
  role: "lead" | "supporting";
  age?: number;
  look?: string;
  voice?: string;
  personality?: string;
  portrait_url?: string | null;
  full_url?: string | null;
  avatar_id?: string | null;
}

interface DramaLine {
  who: string;
  line: string;
}

interface DramaClip {
  seconds?: number;
  location?: string;
  shots?: Array<{ lines?: DramaLine[] }>;
}

interface DramaEpisode {
  n: number;
  title: string;
  status: EpisodeStatus;
  script?: { clips?: DramaClip[] } | null;
  credits?: number | null;
  video_url?: string | null;
  poster_url?: string | null;
  error?: string | null;
  started_at?: string | null;
}

interface DramaShow {
  id: string;
  title: string;
  logline?: string;
  genre?: string;
  format?: string;
  language?: string;
  episode_seconds?: number;
  /** Shows planned before the tiers read as "standard". */
  quality?: string;
  resolution?: string;
  cast?: DramaCharacter[];
  locations?: Array<{ key: string; name: string }>;
  episodes?: DramaEpisode[];
}

/** The backend answers `{ success, show, ... }`; tolerate a `data` wrapper too. */
function pick<T>(res: unknown, key: string): T | undefined {
  const r = (res ?? {}) as Record<string, unknown>;
  const v = r[key] ?? (r.data as Record<string, unknown> | undefined)?.[key];
  return v && typeof v === "object" ? (v as T) : undefined;
}

function episodesOf(show: DramaShow): DramaEpisode[] {
  return [...(show.episodes ?? [])].sort((a, b) => a.n - b.n);
}

/** The episode awaiting approval or filming: the first one not yet ready. */
function nextEpisode(show: DramaShow): DramaEpisode | undefined {
  return episodesOf(show).find((e) => e.status !== "ready");
}

function credits(n: number | null | undefined): string {
  return typeof n === "number" ? `${n} credit${n === 1 ? "" : "s"}` : "price not quoted yet";
}

/** The user-facing tier name: exactly "Standard" or "High quality". */
function qualityLabel(q: unknown): string {
  return q === "high" ? "High quality" : "Standard";
}

/** "High quality 720p", "Standard 540p". */
function tierOf(show: Pick<DramaShow, "quality" | "resolution">): string {
  return [qualityLabel(show.quality), show.resolution].filter(Boolean).join(" ");
}

function clip(s: string | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Minutes since an ISO timestamp, or null. */
function minutesSince(iso: string | null | undefined): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : null;
}

// --- Text: what the model shows the user -------------------------------------

function scriptLines(show: DramaShow, ep: DramaEpisode): string[] {
  const names = new Map((show.cast ?? []).map((c) => [c.key, c.name]));
  const places = new Map((show.locations ?? []).map((l) => [l.key, l.name]));
  const out: string[] = [];
  (ep.script?.clips ?? []).forEach((c, i) => {
    const where = c.location ? places.get(c.location) ?? c.location : null;
    out.push(`  [Clip ${i + 1}${c.seconds ? ` · ${c.seconds} s` : ""}${where ? ` · ${where}` : ""}]`);
    for (const shot of c.shots ?? []) {
      for (const l of shot.lines ?? []) out.push(`  ${names.get(l.who) ?? l.who}: "${l.line}"`);
    }
  });
  return out;
}

/** The one step to take next for an episode, naming the exact call. */
function nextStep(show: DramaShow, ep: DramaEpisode | undefined): string {
  if (!ep) return "Every episode of the season is filmed.";
  const id = JSON.stringify(show.id);
  switch (ep.status) {
    case "planned":
      return `Episode ${ep.n} is not written yet. Write it (free) with versely_write_drama_episode { show_id: ${id}, n: ${ep.n} }.`;
    case "filming": {
      const mins = minutesSince(ep.started_at);
      return (
        `Episode ${ep.n} is filming${mins !== null ? ` (started ${mins} min ago)` : ""}; it takes about 10 minutes and the user gets a notification. ` +
        `The card updates by itself; otherwise check versely_get_drama_show { show_id: ${id}, n: ${ep.n} } again in a few minutes. Do not film it again.`
      );
    }
    case "ready":
      return `Episode ${ep.n} is ready: ${ep.video_url ?? "(no video URL)"}`;
    case "failed":
    case "scripted": {
      const failed = ep.status === "failed"
        ? `Filming episode ${ep.n} failed${ep.error ? ` (${clip(ep.error, 200)})` : ""}; its credits were refunded. `
        : "";
      return (
        failed +
        `Show the user Episode ${ep.n}'s lines and the exact price (${credits(ep.credits)}, ${tierOf(show)}). Film it only after they say yes: ` +
        `versely_film_drama_episode { show_id: ${id}, n: ${ep.n}, confirm_credits: ${typeof ep.credits === "number" ? ep.credits : "<the quoted price>"} }.`
      );
    }
  }
}

function showText(show: DramaShow, focus: DramaEpisode | undefined, lead?: string): string {
  const eps = episodesOf(show);
  const head = [
    show.genre ? `${show.genre.replace(/-/g, " ")} ${show.format === "sitcom" ? "sitcom" : "drama"}` : null,
    eps.length ? `${eps.length} episodes` : null,
    show.episode_seconds ? `${show.episode_seconds} s each` : null,
    tierOf(show),
    show.language ? `dialogue: ${show.language}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines: string[] = [];
  if (lead) lines.push(lead, "");
  lines.push(`"${show.title}" (show_id ${show.id})${head ? ` · ${head}` : ""}`);
  if (show.logline) lines.push(`Logline: ${show.logline}`);

  const cast = show.cast ?? [];
  if (cast.length) {
    lines.push("", "Cast (the same actors in every episode; all fictional adults):");
    for (const c of cast) {
      const who = [c.role, typeof c.age === "number" ? String(c.age) : null].filter(Boolean).join(", ");
      const about = clip(c.personality || c.look, 140);
      lines.push(`- ${c.name}${who ? ` (${who})` : ""}${about ? `: ${about}` : ""}`);
    }
  }
  const places = show.locations ?? [];
  if (places.length) lines.push(`Locations: ${places.map((l) => l.name).join(", ")}`);

  if (eps.length) {
    lines.push("", "Season:");
    for (const e of eps) {
      const state =
        e.status === "ready"
          ? `ready${e.video_url ? `: ${e.video_url}` : ""}`
          : e.status === "scripted" || e.status === "failed"
            ? `${e.status} · ${credits(e.credits)}`
            : e.status;
      lines.push(`${e.n}. ${e.title} (${state})`);
    }
  }

  if (focus && focus.script?.clips?.length) {
    lines.push("", `Episode ${focus.n} "${focus.title}" script (${credits(focus.credits)} to film):`, ...scriptLines(show, focus));
  }
  lines.push("", `Next: ${nextStep(show, focus)}`);
  return lines.join("\n");
}

// --- Card ------------------------------------------------------------------------

const FILM_POLL = { interval_ms: 15_000, timeout_ms: 30 * 60_000 };
/** A typical episode films in 10-12 minutes; the bar tops out short of done. */
const TYPICAL_FILM_MS = 11 * 60_000;

/**
 * The media card for a show, focused on one episode: following it while it
 * films (polling versely_get_drama_show), its error if filming failed, the
 * finished episodes (the focus first), or the cast portraits before anything
 * is filmed.
 */
function showCard(
  show: DramaShow,
  focus: DramaEpisode | undefined,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  const eps = episodesOf(show);
  const ready = eps.filter((e) => e.status === "ready" && e.video_url);
  ready.sort((a, b) => (a.n === focus?.n ? -1 : b.n === focus?.n ? 1 : a.n - b.n));
  const episodeAssets = ready.map((e) => ({ url: String(e.video_url), label: `Episode ${e.n} · ${e.title}` }));
  // toolName labels the card footer; toolArgs is the echoed input (payload contract).
  const echo = { title: show.title, toolName, toolArgs };

  if (focus?.status === "filming") {
    const started = focus.started_at ? Date.parse(focus.started_at) : NaN;
    const progress = Number.isFinite(started) ? Math.min(0.95, Math.max(0.02, (Date.now() - started) / TYPICAL_FILM_MS)) : 0.02;
    return {
      kind: "video",
      assets: [],
      status: "pending",
      task_id: `${show.id}:${focus.n}`,
      progress,
      message: `Filming episode ${focus.n} of ${show.title}: about 10 minutes.`,
      poll: { tool_name: "versely_get_drama_show", args: { show_id: show.id, n: focus.n }, ...FILM_POLL },
      ...echo,
    };
  }
  if (focus?.status === "failed") {
    return {
      kind: "gallery",
      assets: episodeAssets,
      status: "failed",
      task_id: `${show.id}:${focus.n}`,
      error: `Filming episode ${focus.n} failed${focus.error ? `: ${clip(focus.error, 300)}` : ""}. Its credits were refunded.`,
      ...echo,
    };
  }
  if (episodeAssets.length > 0) {
    return {
      kind: episodeAssets.length > 1 ? "gallery" : "video",
      assets: episodeAssets,
      status: "completed",
      task_id: show.id,
      aspect_ratio: "9:16",
      ...echo,
    };
  }
  const portraits = (show.cast ?? [])
    .filter((c) => typeof c.portrait_url === "string" && c.portrait_url)
    .map((c) => ({ url: String(c.portrait_url), label: `${c.name} (${c.role})` }));
  if (portraits.length > 0) {
    return { kind: "gallery", assets: portraits, status: "completed", task_id: show.id, ...echo };
  }
  return {
    kind: "gallery",
    assets: [],
    status: "info",
    task_id: show.id,
    message: `${show.title}: nothing filmed yet.`,
    ...echo,
  };
}

function showResult(
  show: DramaShow,
  focus: DramaEpisode | undefined,
  toolName: string,
  toolArgs: Record<string, unknown>,
  lead?: string,
): ToolResult {
  return {
    content: [{ type: "text", text: showText(show, focus, lead) }],
    structuredContent: showCard(show, focus, toolName, toolArgs),
  };
}

// --- Inputs ------------------------------------------------------------------------

const ShowId = z.string().min(1).max(64).describe("The show's id (drm_...), from versely_plan_drama_show or versely_list_drama_shows.");
const EpisodeN = z.number().int().min(1).max(10).describe("Episode number, 1-based.");

const RULES =
  "Rules: every character is a fictional adult (18+). Never cast minors, real people, celebrities or brands, " +
  "and turn down ideas built on them. Never name the services that film the episodes.";

/** The two tiers and their prices (owner table, 2026-11-04); the episode's quote is always the exact figure. */
const TIERS =
  "Quality, set per show: offer both tiers by these names with their prices (credits per episode, 15 s / 30 s). " +
  "Standard (good quality, lowest price): 540p 68 / 135, 720p 142 / 284. " +
  "High quality (most realistic: faces, outfits and motion stay true to each character's photo): 480p 160 / 320, " +
  "720p 320 / 640. These are guides; the episode's quote is the exact price.";

const QUALITY_TEXT = "'standard': Standard, good quality, lowest price. 'high': High quality, the most realistic, costs more.";
const RESOLUTION_TEXT =
  "Standard films at 540p or 720p, High quality at 480p or 720p (a mismatch moves to the tier's lower one: " +
  "Standard 480p becomes 540p, High quality 540p becomes 480p). The lower one costs about half.";

// --- Tools -------------------------------------------------------------------------

const versely_plan_drama_show = defineTool({
  name: "versely_plan_drama_show",
  description:
    "Plan a short drama series (vertical 9:16 episodes of 15 or 30 s, the same AI cast in every episode) from one idea. " +
    "FREE, no credits; takes up to ~40 s. Use it when the user asks for a drama, series, web series, micro drama, " +
    "short drama, sitcom or \"a show\". The flow:\n" +
    "1. Interview briefly first: at most 2 rounds of short multiple-choice questions, recommended answer first " +
    "(story or genre, episode length, the two leads, and quality: Standard ~135 credits for 30 s at 540p / ~284 at " +
    "720p, or High quality ~320 at 480p / ~640 at 720p). With no idea yet, pitch 3 one-line premises to pick from.\n" +
    "2. Call this once. It writes the season (episode titles), casts 2 leads and up to 4 supporting actors with " +
    "portraits (the user's own characters from cast_avatar_ids first, then Versely's ready-made characters; a new " +
    "face only when none fits), builds the locations and writes Episode 1.\n" +
    "3. Show the user the cast (names, one line each), the episode titles, Episode 1's lines and its exact price in " +
    "credits with its tier. Their yes is the approval.\n" +
    "4. Only then call versely_film_drama_episode (n: 1, confirm_credits: that price). Filming takes about 10 " +
    "minutes; say so, then check with versely_get_drama_show.\n" +
    "5. Each later episode: versely_write_drama_episode, show its lines and price, yes, versely_film_drama_episode.\n" +
    "Edit names, looks, voices, quality or other settings for free with versely_update_drama_show. " +
    TIERS +
    " " +
    RULES,
  meta: metaForMediaCard(),
  inputSchema: z.object({
    idea: z
      .string()
      .min(3)
      .max(2000)
      .describe("The premise in the user's words plus what the interview settled (tone, leads, setting, twist). One line is enough."),
    genre: z.enum(GENRES).optional().describe("Default: picked from the idea."),
    format: z.enum(["drama", "sitcom"]).optional().describe("Default 'drama'."),
    language: z.string().min(2).max(35).optional().describe("Dialogue language as a BCP-47 code: 'en' (default), 'hi', 'es'..."),
    episodes: z.number().int().min(3).max(10).optional().describe("Season length, 3-10 (default 10). Only filmed episodes cost credits."),
    episode_seconds: z
      .union([z.literal(15), z.literal(30)])
      .optional()
      .describe("Episode length: 30 (default, two clips) or 15 (one clip, about half the price)."),
    quality: z.enum(QUALITIES).optional().describe(`Default 'standard'. ${QUALITY_TEXT}`),
    resolution: z.enum(RESOLUTIONS).optional().describe(`Default '720p'. ${RESOLUTION_TEXT}`),
    cast_avatar_ids: z
      .array(z.string().min(1))
      .max(6)
      .optional()
      .describe(
        "Cast the user's own characters (ids from versely_list_hook_characters); their portraits are reused. " +
          "The rest of the cast comes from Versely's ready-made characters.",
      ),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post("/api/v1/drama/shows", input, { timeoutMs: SYNC_TIMEOUT_MS });
    const show = pick<DramaShow>(res, "show");
    if (!show?.id) return jsonResult(res);
    const ep1 = episodesOf(show).find((e) => e.n === 1) ?? nextEpisode(show);
    return showResult(show, ep1, "versely_plan_drama_show", input, "Planned (free, nothing charged).");
  },
});

const versely_update_drama_show = defineTool({
  name: "versely_update_drama_show",
  description:
    "Edit a short drama: title, logline, dialogue language, episode length (15 or 30 s), quality (Standard or High " +
    "quality), resolution, or a cast member's name, look, voice or personality (regenerate_portrait: true draws a new " +
    "portrait). FREE. Refused while an episode is filming. A new length, quality or resolution re-prices every " +
    "scripted episode and keeps its script: show the new price (in the result, or from versely_get_drama_quote) " +
    "before filming. Edits apply to the episodes filmed from now on. " +
    TIERS +
    " " +
    RULES,
  inputSchema: z.object({
    show_id: ShowId,
    title: z.string().min(1).max(120).optional(),
    logline: z.string().min(1).max(500).optional(),
    language: z.string().min(2).max(35).optional().describe("Dialogue language, BCP-47 ('en', 'hi', 'es'...)."),
    episode_seconds: z.union([z.literal(15), z.literal(30)]).optional(),
    quality: z.enum(QUALITIES).optional().describe(QUALITY_TEXT),
    resolution: z.enum(RESOLUTIONS).optional().describe(RESOLUTION_TEXT),
    cast: z
      .array(
        z.object({
          key: z.string().min(1).describe("The character's key from the show (e.g. 'lily')."),
          name: z.string().min(1).max(60).optional(),
          look: z.string().min(1).max(600).optional().describe("Face, hair, build and signature outfit."),
          voice: z.string().min(1).max(200).optional(),
          personality: z.string().min(1).max(400).optional(),
          avatar_id: z.string().min(1).optional().describe("Recast with one of the user's characters (versely_list_hook_characters)."),
          regenerate_portrait: z.boolean().optional().describe("Draw a new portrait from the (new) look."),
        }),
      )
      .max(6)
      .optional()
      .describe("Only the characters to change, by key, with only the fields to change."),
  }),
  handler: async (input, ctx) => {
    const { show_id, ...body } = input;
    const res = await ctx.client.patch(`/api/v1/drama/shows/${encodeURIComponent(show_id)}`, body, {
      timeoutMs: SYNC_TIMEOUT_MS,
    });
    const show = pick<DramaShow>(res, "show");
    if (!show?.id) return jsonResult(res);
    return { content: [{ type: "text", text: showText(show, nextEpisode(show), "Updated (free).") }] };
  },
});

const versely_write_drama_episode = defineTool({
  name: "versely_write_drama_episode",
  description:
    "Write, or rewrite, the script of episode n of a short drama. FREE. It follows the season plan, keeps the same " +
    "cast and what earlier episodes established; `notes` steer it ('more comedy', 'end on the slap'). Returns the " +
    "lines and the exact credits to film it. Show the user the lines and the price, then call " +
    "versely_film_drama_episode only after they say yes. Episode 1 is written by versely_plan_drama_show already. " +
    RULES,
  inputSchema: z.object({
    show_id: ShowId,
    n: EpisodeN,
    notes: z.string().max(1000).optional().describe("What the user wants in or changed in this episode."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post(
      `/api/v1/drama/shows/${encodeURIComponent(input.show_id)}/episodes/${input.n}/script`,
      input.notes ? { notes: input.notes } : {},
      { timeoutMs: SYNC_TIMEOUT_MS },
    );
    const show = pick<DramaShow>(res, "show");
    if (!show?.id) return jsonResult(res);
    const ep = pick<DramaEpisode>(res, "episode") ?? episodesOf(show).find((e) => e.n === input.n);
    return { content: [{ type: "text", text: showText(show, ep, `Episode ${input.n} written (free).`) }] };
  },
});

const versely_get_drama_quote = defineTool({
  name: "versely_get_drama_quote",
  description:
    "The exact credits to film episode n of a short drama as it is scripted now, with its length, quality (Standard " +
    "or High quality), resolution and the user's balance. FREE. Use it to re-check the price before asking the user " +
    "to approve filming, and pass it as confirm_credits to versely_film_drama_episode.",
  inputSchema: z.object({ show_id: ShowId, n: EpisodeN }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<Record<string, unknown>>(
      `/api/v1/drama/shows/${encodeURIComponent(input.show_id)}/episodes/${input.n}/quote`,
    );
    const q = ((res?.data as Record<string, unknown> | undefined) ?? res ?? {}) as Record<string, unknown>;
    if (typeof q.credits !== "number") return jsonResult(res);
    const parts = [
      `Episode ${input.n}: ${credits(q.credits)} to film`,
      typeof q.seconds === "number" ? `${q.seconds} s` : null,
      typeof q.quality === "string" || typeof q.resolution === "string"
        ? tierOf({ quality: q.quality as string | undefined, resolution: q.resolution as string | undefined })
        : null,
    ].filter(Boolean);
    const balance = typeof q.balance === "number" ? ` Balance: ${q.balance} credits.` : "";
    return {
      content: [
        {
          type: "text",
          text:
            `${parts.join(", ")}.${balance} Film only after the user says yes, with confirm_credits: ${q.credits}.` +
            (typeof q.balance === "number" && q.balance < q.credits ? " The balance is short of the price." : ""),
        },
      ],
    };
  },
});

const versely_film_drama_episode = defineTool({
  name: "versely_film_drama_episode",
  description:
    "Film episode n of a short drama. PAID: spends the episode's quoted credits once (refunded if filming fails). " +
    "Call it only after the user has seen this episode's lines and the exact price and said yes, and pass that price " +
    "as confirm_credits (from versely_plan_drama_show, versely_write_drama_episode or versely_get_drama_quote). If the " +
    "price has changed, the call is refused with the new one: show it and ask again. Filming runs in the background " +
    "for about 10 minutes, with the same cast as every other episode; tell the user, and they get a notification when " +
    "it is ready. The card follows it; otherwise check versely_get_drama_show every few minutes. Never film the same " +
    "episode twice.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    show_id: ShowId,
    n: EpisodeN,
    confirm_credits: z
      .number()
      .positive()
      .describe("The exact price the user approved. Must equal the current quote."),
  }),
  handler: async (input, ctx) => {
    const path = `/api/v1/drama/shows/${encodeURIComponent(input.show_id)}/episodes/${input.n}/film`;
    let res: unknown;
    try {
      res = await ctx.client.post(path, { confirm_credits: input.confirm_credits });
    } catch (err) {
      if (err instanceof VerselyApiError && err.status === 409) return filmConflict(err, input.show_id, input.n, input.confirm_credits);
      throw err;
    }
    const episode = pick<DramaEpisode>(res, "episode") ?? {
      n: input.n,
      title: `Episode ${input.n}`,
      status: "filming" as const,
      started_at: new Date().toISOString(),
    };
    // The show gives the card its title and the finished episodes; the
    // episode alone still makes a working pending card.
    let show: DramaShow | undefined;
    try {
      show = pick<DramaShow>(await ctx.client.get(`/api/v1/drama/shows/${encodeURIComponent(input.show_id)}`), "show");
    } catch {
      /* the pending card works without it */
    }
    const base: DramaShow = show?.id ? show : { id: input.show_id, title: "your show", episodes: [episode] };
    const focus = episodesOf(base).find((e) => e.n === input.n) ?? episode;
    const filmingFocus: DramaEpisode = focus.status === "filming" ? focus : { ...focus, ...episode, status: "filming" };
    return {
      content: [
        {
          type: "text",
          text:
            `Episode ${input.n} "${filmingFocus.title}" of ${base.title} is filming: ${credits(input.confirm_credits)} charged ` +
            `(refunded if it fails). It takes about 10 minutes and the user gets a notification when it is ready. ` +
            `The card updates by itself; otherwise check versely_get_drama_show { show_id: ${JSON.stringify(input.show_id)}, n: ${input.n} } ` +
            `in a few minutes. It is NOT finished yet; do not film it again.`,
        },
      ],
      structuredContent: showCard(base, filmingFocus, "versely_film_drama_episode", input),
    };
  },
});

/** 409: the price moved (the body carries the fresh quote) or the episode is already filming / ready. */
function filmConflict(err: VerselyApiError, showId: string, n: number, offered: number): ToolResult {
  const body = (err.body ?? {}) as Record<string, unknown>;
  const nested = [body, body.data, body.quote, (body.data as Record<string, unknown> | undefined)?.quote];
  let fresh: number | undefined;
  let tier = "";
  for (const src of nested) {
    const q = src as Record<string, unknown> | undefined;
    const v = q?.credits;
    if (typeof v === "number" && Number.isFinite(v)) {
      fresh = v;
      if (typeof q?.quality === "string" || typeof q?.resolution === "string") {
        tier = `, ${tierOf({ quality: q?.quality as string | undefined, resolution: q?.resolution as string | undefined })}`;
      }
      break;
    }
  }
  if (fresh !== undefined && fresh !== offered) {
    return errorResult(
      `Not filmed, nothing charged: the price of episode ${n} is now ${credits(fresh)}${tier} (you passed ${offered}). ` +
        `Show the user the new price and ask again; if they agree, call versely_film_drama_episode with confirm_credits: ${fresh}.`,
    );
  }
  const said = typeof body.message === "string" ? ` ${clip(body.message, 200)}` : "";
  return errorResult(
    `Not filmed, nothing charged: episode ${n} is already filming or ready.${said} ` +
      `Check it with versely_get_drama_show { show_id: ${JSON.stringify(showId)}, n: ${n} }.`,
  );
}

const versely_get_drama_show = defineTool({
  name: "versely_get_drama_show",
  description:
    "Get a short drama: its cast, the season (episode titles, status and price) and one episode's lines (n; default " +
    "the next one to approve or film). The card shows the finished episodes and follows an episode that is filming " +
    "(about 10 minutes) by itself, so don't call this in a loop: check again every few minutes only when you need the " +
    "result. Free.",
  // Visible to the app too: the film card's poll loop calls this tool.
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({
    show_id: ShowId,
    n: EpisodeN.optional().describe("The episode to focus on (default: the one filming, else the next to approve)."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get(`/api/v1/drama/shows/${encodeURIComponent(input.show_id)}`);
    const show = pick<DramaShow>(res, "show");
    if (!show?.id) return jsonResult(res);
    const eps = episodesOf(show);
    const focus =
      (input.n !== undefined ? eps.find((e) => e.n === input.n) : undefined) ??
      eps.find((e) => e.status === "filming") ??
      nextEpisode(show);
    return showResult(show, focus, "versely_get_drama_show", input);
  },
});

const versely_list_drama_shows = defineTool({
  name: "versely_list_drama_shows",
  description:
    "List the user's short dramas, most recently updated first: title, logline, genre, episode counts by status and " +
    "a cover image. Free. Open one with versely_get_drama_show.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => jsonResult(await ctx.client.get("/api/v1/drama/shows")),
});

export const dramaTools: Tool[] = [
  versely_plan_drama_show,
  versely_update_drama_show,
  versely_write_drama_episode,
  versely_get_drama_quote,
  versely_film_drama_episode,
  versely_get_drama_show,
  versely_list_drama_shows,
];
