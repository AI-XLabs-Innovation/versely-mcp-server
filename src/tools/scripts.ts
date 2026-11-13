// Remix a viral script (backend services/scripts, web /scripts): a viral
// reel's link, or an idea, becomes a short script the user FILMS themselves,
// in their own voice: 3 hook options, timed beats (line, on-screen text, shot),
// caption, hashtags and a call to action, in one of 32 languages.
//
//   GET    /scripts/pricing               { script_credits, analysis_credits }
//   POST   /scripts/generate              202 { script (status generating), credits }
//   GET    /scripts  /scripts/:id         rows; a job dead > 30 min is failed + refunded on read
//   PATCH  /scripts/:id                   title | script (finished only) | scheduled_for | filmed
//   DELETE /scripts/:id
//   GET|DELETE /scripts/voice-profile     the user's one voice profile (or null)
//   POST   /scripts/voice-profile/build   202, learned in the background from their own
//                                         public Instagram / TikTok (free, 3 builds a day)
//
// Price: a fixed script_credits, plus analysis_credits to watch the reel when
// the input is a link this user has not had analysed before (the Trend
// Analyzer's own charge). There is no quote endpoint and no confirm field on
// generate, so versely_write_script reads /scripts/pricing, quotes the most
// the request can cost when confirm_credits is missing, and refuses a
// confirm_credits that differs from it. Everything charged is refunded when no
// script comes out. Generation is asynchronous: the tool waits a little, then
// hands over to versely_get_script.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";

// --- Backend shapes ------------------------------------------------------------

const SCRIPT_LANGUAGES = [
  "en", "hinglish", "hi", "bn", "mr", "ta", "te", "gu", "kn", "ml", "pa", "ur",
  "es", "pt", "fr", "de", "it", "nl", "pl", "ru", "uk", "tr", "ar", "fa",
  "id", "ms", "vi", "th", "fil", "zh", "ja", "ko",
] as const;
type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

const LANGUAGE_NAMES: Record<ScriptLanguage, string> = {
  en: "English", hinglish: "Hinglish", hi: "Hindi", bn: "Bengali", mr: "Marathi", ta: "Tamil", te: "Telugu",
  gu: "Gujarati", kn: "Kannada", ml: "Malayalam", pa: "Punjabi", ur: "Urdu", es: "Spanish", pt: "Portuguese",
  fr: "French", de: "German", it: "Italian", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  tr: "Turkish", ar: "Arabic", fa: "Persian", id: "Indonesian", ms: "Malay", vi: "Vietnamese", th: "Thai",
  fil: "Filipino", zh: "Chinese", ja: "Japanese", ko: "Korean",
};

const isLanguage = (v: unknown): v is ScriptLanguage => typeof v === "string" && (SCRIPT_LANGUAGES as readonly string[]).includes(v);
const languageName = (v: unknown): string => (isLanguage(v) ? LANGUAGE_NAMES[v] : String(v ?? "unknown language"));

interface ScriptHook {
  text: string;
  style?: string;
}

interface ScriptBeat {
  t: string;
  line: string;
  on_screen_text?: string;
  shot?: string;
}

interface ScriptBody {
  idea?: string;
  why_it_works?: string;
  hooks?: ScriptHook[];
  chosen_hook?: number;
  beats?: ScriptBeat[];
  caption?: string;
  hashtags?: string[];
  cta?: string;
  source?: { url?: string; platform?: string; author?: string; title?: string; thumbnail?: string } | null;
}

interface ScriptRow {
  id: string;
  source_url?: string | null;
  source_platform?: string | null;
  analysis_id?: string | null;
  idea_text?: string | null;
  language?: string;
  length_seconds?: number;
  status: "generating" | "ready" | "failed" | string;
  error?: string | null;
  title?: string | null;
  script?: ScriptBody | null;
  scheduled_for?: string | null;
  filmed_at?: string | null;
  credits_charged?: number;
  created_at?: string;
  updated_at?: string;
}

interface VoiceProfile {
  summary?: string;
  tone?: string[];
  hook_patterns?: string[];
  topics?: string[];
  catchphrases?: string[];
  language_mix?: { primary?: string; notes?: string };
  pacing?: string;
  cta_style?: string;
  do?: string[];
  dont?: string[];
  sample_lines?: string[];
}

interface VoiceProfileRow {
  platform?: "instagram" | "tiktok" | "manual" | string;
  handle?: string | null;
  status?: "building" | "ready" | "failed" | string;
  error?: string | null;
  profile?: VoiceProfile | null;
  source_posts?: unknown[] | null;
  updated_at?: string;
}

interface Pricing {
  script_credits: number;
  analysis_credits: number;
}

/** `{ success, <key> }`, tolerating a `data` wrapper. */
function pick<T>(res: unknown, key: string): T | undefined {
  const r = (res ?? {}) as Record<string, unknown>;
  const v = r[key] ?? (r.data as Record<string, unknown> | undefined)?.[key];
  return v && typeof v === "object" ? (v as T) : undefined;
}

function credits(n: number): string {
  return `${n} credit${n === 1 ? "" : "s"}`;
}

function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readPricing(ctx: ToolContext): Promise<Pricing> {
  const res = (await ctx.client.get<Record<string, unknown>>("/api/v1/scripts/pricing")) ?? {};
  const src = ((res.data as Record<string, unknown> | undefined) ?? res) as Record<string, unknown>;
  const s = Number(src.script_credits);
  const a = Number(src.analysis_credits);
  if (!Number.isFinite(s) || !Number.isFinite(a)) throw new Error("Could not read the script price. Nothing was charged.");
  return { script_credits: s, analysis_credits: a };
}

// --- Text ---------------------------------------------------------------------------

function sourceLine(row: ScriptRow): string | null {
  const src = row.script?.source;
  const url = src?.url || row.source_url;
  if (url) return `Remixed from: ${url}${src?.author ? ` (@${src.author.replace(/^@/, "")})` : ""}`;
  if (row.idea_text) return `From the idea: "${clip(row.idea_text, 200)}"`;
  return null;
}

function headLine(row: ScriptRow): string {
  const bits = [
    row.status,
    languageName(row.language),
    row.length_seconds ? `${row.length_seconds} s` : null,
    typeof row.credits_charged === "number" ? credits(row.credits_charged) : null,
    row.scheduled_for ? `to film on ${row.scheduled_for}` : null,
    row.filmed_at ? `filmed ${day(row.filmed_at)}` : null,
  ].filter(Boolean);
  return `"${row.title || "Untitled script"}" (script_id ${row.id}) · ${bits.join(" · ")}`;
}

/** The whole script, as the model shows it to the user. */
function scriptText(row: ScriptRow, lead?: string): string {
  const lines: string[] = [];
  if (lead) lines.push(lead, "");
  lines.push(headLine(row));
  const src = sourceLine(row);
  if (src) lines.push(src);

  if (row.status === "generating") {
    lines.push(
      "",
      `Still being written (about 30 s from an idea, 1 to 3 minutes from a link). Check again with versely_get_script ` +
        `{ script_id: "${row.id}" } in about 30 seconds. Do not start it again.`,
    );
    return lines.join("\n");
  }
  if (row.status === "failed") {
    lines.push("", `This script failed: ${row.error || "no script came out."} Credits charged for it are refunded.`);
    return lines.join("\n");
  }

  const s = row.script ?? {};
  if (s.idea) lines.push("", `Idea: ${s.idea}`);
  if (s.why_it_works) lines.push(`Why it works: ${s.why_it_works}`);
  const hooks = s.hooks ?? [];
  if (hooks.length) {
    const chosen = Number.isInteger(s.chosen_hook) ? Number(s.chosen_hook) : 0;
    lines.push("", "Hooks (the opening line; pick one):");
    hooks.forEach((h, i) => lines.push(`${i + 1}. ${h.text}${h.style ? ` [${h.style}]` : ""}${i === chosen ? " (chosen)" : ""}`));
  }
  const beats = s.beats ?? [];
  if (beats.length) {
    lines.push("", "Beats:");
    for (const b of beats) {
      lines.push(`${b.t || "-"}  Say: "${b.line}"`);
      if (b.on_screen_text) lines.push(`      On screen: ${b.on_screen_text}`);
      if (b.shot) lines.push(`      Shot: ${b.shot}`);
    }
  }
  if (s.cta) lines.push("", `Call to action: ${s.cta}`);
  if (s.caption) lines.push(`Caption: ${s.caption}`);
  if (s.hashtags?.length) lines.push(`Hashtags: ${s.hashtags.map((h) => `#${h.replace(/^#+/, "")}`).join(" ")}`);
  return lines.join("\n");
}

function voiceText(row: VoiceProfileRow | null | undefined, lead?: string): string {
  const out: string[] = [];
  if (lead) out.push(lead, "");
  if (!row) {
    out.push(
      "The user has no voice profile yet, so scripts are written in a neutral creator voice. Build one (free) from " +
        "their own public Instagram or TikTok with versely_build_voice_profile.",
    );
    return out.join("\n");
  }
  const from =
    row.platform === "manual" ? "written by the user" : `learned from ${row.platform ?? "social"} @${row.handle ?? "?"}`;
  const posts = Array.isArray(row.source_posts) && row.source_posts.length ? `, ${row.source_posts.length} videos` : "";
  out.push(`Voice profile: ${row.status ?? "unknown"} (${from}${posts}${row.updated_at ? `, updated ${day(row.updated_at)}` : ""}).`);
  if (row.status === "building") {
    out.push(
      "It is still being built (about a minute). Check again with versely_get_voice_profile in a minute." +
        (row.profile ? " Until it finishes, scripts use the previous profile below." : ""),
    );
  } else if (row.status === "failed") {
    out.push(`The last build failed: ${row.error || "unknown error"}.${row.profile ? " Scripts still use the previous profile below." : ""}`);
  }
  const p = row.profile;
  if (p) {
    const list = (label: string, v: string[] | undefined) => {
      if (v?.length) out.push(`${label}: ${v.join("; ")}`);
    };
    if (p.summary) out.push(`Summary: ${p.summary}`);
    list("Tone", p.tone);
    if (p.language_mix?.primary) out.push(`Language: ${languageName(p.language_mix.primary)}${p.language_mix.notes ? ` (${p.language_mix.notes})` : ""}`);
    list("Hook patterns", p.hook_patterns);
    list("Topics", p.topics);
    list("Catchphrases", p.catchphrases);
    if (p.pacing) out.push(`Pacing: ${p.pacing}`);
    if (p.cta_style) out.push(`Call to action style: ${p.cta_style}`);
    list("Do", p.do);
    list("Don't", p.dont);
    if (p.sample_lines?.length) out.push(`Sample lines: ${p.sample_lines.map((l) => `"${l}"`).join(" / ")}`);
    out.push("", "versely_write_script follows this profile. Remove it with versely_delete_voice_profile.");
  }
  return out.join("\n");
}

// --- Polling --------------------------------------------------------------------------

/** How long a paid or build call waits for its result before handing over (ChatGPT cuts a call at ~60 s). */
const WAIT_MS = 40_000;
const FIRST_CHECK_MS = 3_000;
const CHECK_EVERY_MS = 4_000;

async function waitUntil<T>(read: () => Promise<T | undefined>, done: (v: T) => boolean): Promise<T | undefined> {
  const deadline = Date.now() + WAIT_MS;
  let last: T | undefined;
  let step = FIRST_CHECK_MS;
  while (Date.now() + step <= deadline) {
    await sleep(step);
    step = CHECK_EVERY_MS;
    try {
      last = (await read()) ?? last;
    } catch {
      /* keep waiting; the caller hands over with what it has */
    }
    if (last !== undefined && done(last)) break;
  }
  return last;
}

async function readScript(ctx: ToolContext, id: string): Promise<ScriptRow | undefined> {
  return pick<ScriptRow>(await ctx.client.get(`/api/v1/scripts/${encodeURIComponent(id)}`), "script");
}

async function readVoice(ctx: ToolContext): Promise<VoiceProfileRow | null> {
  return pick<VoiceProfileRow>(await ctx.client.get("/api/v1/scripts/voice-profile"), "profile") ?? null;
}

// --- Inputs -------------------------------------------------------------------------------

const ScriptId = z.string().uuid().describe("The script's id, from versely_write_script or versely_list_scripts.");

const LANGUAGE_TEXT =
  "The language the user will speak: " +
  SCRIPT_LANGUAGES.map((c) => `${c} ${LANGUAGE_NAMES[c]}`).join(", ") +
  ". Default: the language of the user's voice profile, else en.";

// --- Tools --------------------------------------------------------------------------------

const versely_write_script = defineTool({
  name: "versely_write_script",
  description:
    "Remix a viral script: turn a viral reel's link, or an idea, into a short script the user films themselves in " +
    "their own voice. It keeps what made the reel work without copying its lines: 3 hook options, timed beats (what to " +
    "say, on-screen text, the shot), a call to action, a caption and hashtags, 15 to 60 seconds, in one of 32 languages. " +
    "It follows the user's voice profile (versely_build_voice_profile) and their default brand when they have them. " +
    "Links: TikTok, Instagram, YouTube, X, Facebook or LinkedIn posts. PAID, a fixed price in credits: the script, plus " +
    "watching the reel when the input is a link (pass the analysis_id of an earlier versely_analyze_post breakdown " +
    "instead of the link and only the script is charged). Call first WITHOUT confirm_credits: nothing is charged and " +
    "the price comes back. Show the user the price, and only after they agree call again with the same inputs and " +
    "confirm_credits set to it; a different number is refused with the current price, nothing charged. Writing takes " +
    "about 30 seconds from an idea and 1 to 3 minutes from a link; this waits up to about 40 seconds, then hand over " +
    "to versely_get_script. Credits are refunded if no script comes out. Not a video tool: nothing is filmed or generated.",
  inputSchema: z.object({
    source_url: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe("Link to the viral post to remix (TikTok, Instagram, YouTube, X, Facebook or LinkedIn)."),
    analysis_id: z
      .string()
      .uuid()
      .optional()
      .describe("Instead of a link: a post breakdown from versely_analyze_post or versely_list_post_analyses to remix."),
    idea: z.string().min(3).max(2000).optional().describe("Instead of a reel: the user's own idea for the video."),
    language: z.enum(SCRIPT_LANGUAGES).optional().describe(LANGUAGE_TEXT),
    length_seconds: z
      .union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)])
      .optional()
      .describe("Spoken length in seconds: 15, 30 (default), 45 or 60."),
    notes: z
      .string()
      .max(2000)
      .optional()
      .describe("Extra direction from the user: the angle, a product to mention, the audience, the tone."),
    confirm_credits: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The exact price the user approved, from a call without it. Leave it out to get the price."),
  }),
  handler: async (input, ctx) => {
    const sources = [input.source_url, input.analysis_id, input.idea].filter((v) => typeof v === "string" && v.trim());
    if (sources.length !== 1) {
      return errorResult("Pass exactly one of source_url, analysis_id or idea. Nothing was charged.");
    }
    const pricing = await readPricing(ctx);
    const fromLink = Boolean(input.source_url?.trim());
    const price = pricing.script_credits + (fromLink ? pricing.analysis_credits : 0);
    const breakdown = fromLink
      ? `${pricing.script_credits} for the script + ${pricing.analysis_credits} to watch the reel; only ` +
        `${credits(pricing.script_credits)} if the user already had this exact post analysed`
      : `${pricing.script_credits} for the script`;

    if (input.confirm_credits === undefined) {
      return {
        content: [
          {
            type: "text",
            text:
              `Not started, nothing charged. Writing this script costs ${credits(price)} (${breakdown}). ` +
              `Show the user this price and ask. If they agree, call versely_write_script again with the same inputs and ` +
              `confirm_credits: ${price}.`,
          },
        ],
      };
    }
    if (input.confirm_credits !== price) {
      return errorResult(
        `Not started, nothing charged: writing this script costs ${credits(price)} (${breakdown}), and you passed ` +
          `${input.confirm_credits}. Show the user this price and ask again; if they agree, call versely_write_script ` +
          `with confirm_credits: ${price}.`,
      );
    }

    let language: ScriptLanguage | undefined = input.language;
    if (!language) {
      try {
        const primary = (await readVoice(ctx))?.profile?.language_mix?.primary;
        if (isLanguage(primary)) language = primary;
      } catch {
        /* the default below */
      }
    }
    const res = await ctx.client.post<Record<string, unknown>>("/api/v1/scripts/generate", {
      ...(input.source_url ? { source_url: input.source_url.trim() } : {}),
      ...(input.analysis_id ? { analysis_id: input.analysis_id } : {}),
      ...(input.idea ? { idea: input.idea.trim() } : {}),
      language: language ?? "en",
      length_seconds: input.length_seconds ?? 30,
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    });
    const started = pick<ScriptRow>(res, "script");
    if (!started?.id) return jsonResult(res);
    const charged = typeof res?.credits === "number" ? (res.credits as number) : started.credits_charged;
    const chargedText = typeof charged === "number" ? `${credits(charged)} charged` : "charged";

    const row = (await waitUntil(() => readScript(ctx, started.id), (r) => r.status !== "generating")) ?? started;
    if (row.status === "failed") {
      return errorResult(scriptText(row, `The script could not be written (${chargedText}, now refunded).`));
    }
    if (row.status === "ready") {
      return {
        content: [
          {
            type: "text",
            text: scriptText(
              row,
              `Script ready (${chargedText}). Show it to the user. Edit it with versely_update_script; it is saved in ` +
                `their Versely scripts.`,
            ),
          },
        ],
      };
    }
    return { content: [{ type: "text", text: scriptText(row, `Writing started (${chargedText}).`) }] };
  },
});

const versely_get_script = defineTool({
  name: "versely_get_script",
  description:
    "Read one of the user's scripts: its hooks, timed beats, call to action, caption and hashtags, or that it is still " +
    "being written (check again about 30 seconds later) or failed (refunded). FREE.",
  inputSchema: z.object({ script_id: ScriptId }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get(`/api/v1/scripts/${encodeURIComponent(input.script_id)}`);
    const row = pick<ScriptRow>(res, "script");
    if (!row?.id) return jsonResult(res);
    return { content: [{ type: "text", text: scriptText(row) }] };
  },
});

const versely_list_scripts = defineTool({
  name: "versely_list_scripts",
  description:
    "List the user's scripts, newest first: id, title, status, language, length, the reel or idea it came from, and " +
    "the day they plan to film it. FREE. Open one with versely_get_script.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional().describe("How many (default 20, max 100)."),
    before: z.string().datetime({ offset: true }).optional().describe("Only scripts created before this ISO time (paging)."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<Record<string, unknown>>("/api/v1/scripts", {
      query: { limit: input.limit ?? 20, before: input.before },
    });
    const rows = (res?.scripts ?? (res?.data as Record<string, unknown> | undefined)?.scripts) as ScriptRow[] | undefined;
    if (!Array.isArray(rows)) return jsonResult(res);
    if (!rows.length) return { content: [{ type: "text", text: "The user has no scripts yet. Write one with versely_write_script." }] };
    const lines = rows.map((r) => {
      const from = r.source_url ? `remix of ${r.source_url}` : r.idea_text ? `idea: "${clip(r.idea_text, 80)}"` : null;
      return `- ${headLine(r)} · ${day(r.created_at)}${from ? ` · ${from}` : ""}`;
    });
    const next = rows.length >= (input.limit ?? 20) && rows.at(-1)?.created_at ? `\nMore: before "${rows.at(-1)!.created_at}".` : "";
    return { content: [{ type: "text", text: `${rows.length} script${rows.length === 1 ? "" : "s"}, newest first:\n${lines.join("\n")}${next}` }] };
  },
});

const versely_update_script = defineTool({
  name: "versely_update_script",
  description:
    "Edit one of the user's finished scripts: rename it, pick another hook, rewrite hooks, beats, the call to action, " +
    "caption or hashtags, set the day they plan to film it, or mark it filmed. FREE. Only the fields given change; " +
    "hooks are always 3 and replace the old ones, beats replace the old list. To get a new script instead, use " +
    "versely_write_script (paid).",
  inputSchema: z.object({
    script_id: ScriptId,
    title: z.string().min(1).max(200).optional(),
    chosen_hook: z.number().int().min(1).max(3).optional().describe("The hook to open with: 1, 2 or 3."),
    hooks: z
      .array(z.object({ text: z.string().min(1).max(300), style: z.string().max(60).optional() }))
      .length(3)
      .optional()
      .describe("All 3 hooks, in order."),
    beats: z
      .array(
        z.object({
          t: z.string().min(1).max(20).describe("When, like '0-3s'."),
          line: z.string().min(1).max(600).describe("What the user says."),
          on_screen_text: z.string().max(120).optional(),
          shot: z.string().max(400).optional().describe("What the camera shows."),
        }),
      )
      .min(1)
      .max(30)
      .optional()
      .describe("The full list of beats, in order."),
    idea: z.string().max(600).optional(),
    cta: z.string().max(300).optional().describe("The call to action."),
    caption: z.string().max(2200).optional().describe("The post caption."),
    hashtags: z.array(z.string().min(1).max(60)).max(30).optional().describe("Hashtags, without or with '#'."),
    scheduled_for: z
      .string()
      .regex(/^(\d{4}-\d{2}-\d{2}|none)$/, "A date 'YYYY-MM-DD', or 'none'.")
      .optional()
      .describe("The day the user plans to film it, 'YYYY-MM-DD'; 'none' clears it."),
    filmed: z.boolean().optional().describe("true once the user has filmed it; false to undo."),
  }),
  handler: async (input, ctx) => {
    const { script_id, title, scheduled_for, filmed, chosen_hook, hooks, beats, idea, cta, caption, hashtags } = input;
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (scheduled_for !== undefined) patch.scheduled_for = scheduled_for === "none" ? null : scheduled_for;
    if (filmed !== undefined) patch.filmed = filmed;

    const editsScript = [chosen_hook, hooks, beats, idea, cta, caption, hashtags].some((v) => v !== undefined);
    if (editsScript) {
      const current = await readScript(ctx, script_id);
      if (!current) return errorResult(`No script ${script_id} in the user's scripts.`);
      if (current.status !== "ready" || !current.script) {
        return errorResult(`Only a finished script can be edited; this one is ${current.status}. Nothing was changed.`);
      }
      const s = current.script;
      patch.script = {
        ...s,
        ...(idea !== undefined ? { idea } : {}),
        ...(hooks ? { hooks: hooks.map((h, i) => ({ text: h.text, style: h.style ?? s.hooks?.[i]?.style ?? "" })) } : {}),
        ...(chosen_hook !== undefined ? { chosen_hook: chosen_hook - 1 } : {}),
        ...(beats ? { beats: beats.map((b) => ({ t: b.t, line: b.line, on_screen_text: b.on_screen_text ?? "", shot: b.shot ?? "" })) } : {}),
        ...(cta !== undefined ? { cta } : {}),
        ...(caption !== undefined ? { caption } : {}),
        ...(hashtags ? { hashtags: hashtags.map((h) => h.replace(/^#+/, "")) } : {}),
      };
    }
    if (!Object.keys(patch).length) return errorResult("Nothing to change: pass at least one field to edit.");

    const res = await ctx.client.patch(`/api/v1/scripts/${encodeURIComponent(script_id)}`, patch);
    const row = pick<ScriptRow>(res, "script");
    if (!row?.id) return jsonResult(res);
    return { content: [{ type: "text", text: scriptText(row, "Updated (free).") }] };
  },
});

const versely_delete_script = defineTool({
  name: "versely_delete_script",
  description: "Delete one of the user's scripts for good. FREE. Credits spent on it are not returned.",
  inputSchema: z.object({ script_id: ScriptId }),
  handler: async (input, ctx) => {
    await ctx.client.delete(`/api/v1/scripts/${encodeURIComponent(input.script_id)}`);
    return { content: [{ type: "text", text: `Deleted script ${input.script_id}.` }] };
  },
});

const versely_get_voice_profile = defineTool({
  name: "versely_get_voice_profile",
  description:
    "Read the user's voice profile: how they talk on camera (summary, tone, language mix, hook patterns, topics, " +
    "catchphrases, pacing, call-to-action style, dos and don'ts, sample lines), which versely_write_script follows. " +
    "FREE. Also says whether a build is still running or failed.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => ({ content: [{ type: "text", text: voiceText(await readVoice(ctx)) }] }),
});

const versely_build_voice_profile = defineTool({
  name: "versely_build_voice_profile",
  description:
    "Learn how the user talks on camera from their OWN public Instagram or TikTok account (what they say in their " +
    "recent videos, then their captions) and save it as their voice profile, which versely_write_script follows. FREE, " +
    "no credits; up to 3 builds a day. Only for the user's own account: ask for their handle, and never build from " +
    "someone else's. The account must be public, with videos where they speak. Takes about a minute: this waits up to " +
    "about 40 seconds, then check versely_get_voice_profile. A finished rebuild replaces the previous profile.",
  inputSchema: z.object({
    platform: z.enum(["instagram", "tiktok"]).describe("Where the user's own account is."),
    handle: z
      .string()
      .min(1)
      .max(120)
      .describe("The user's own handle, like '@yourname', or their profile link."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.post("/api/v1/scripts/voice-profile/build", {
      platform: input.platform,
      handle: input.handle.trim(),
    });
    const started = pick<VoiceProfileRow>(res, "profile");
    if (!started) return jsonResult(res);
    const row = started.status === "building" ? (await waitUntil(() => readVoice(ctx).then((r) => r ?? undefined), (r) => r.status !== "building")) ?? started : started;
    if (row.status === "failed") return errorResult(voiceText(row, "The voice profile could not be built (free, nothing charged)."));
    if (row.status === "ready") return { content: [{ type: "text", text: voiceText(row, "Voice profile ready (free).") }] };
    return { content: [{ type: "text", text: voiceText(row, "Building the voice profile (free).") }] };
  },
});

const versely_delete_voice_profile = defineTool({
  name: "versely_delete_voice_profile",
  description:
    "Delete the user's voice profile. FREE. Scripts are then written in a neutral creator voice until they build a new " +
    "one with versely_build_voice_profile.",
  inputSchema: z.object({}),
  handler: async (_input, ctx): Promise<ToolResult> => {
    await ctx.client.delete("/api/v1/scripts/voice-profile");
    return { content: [{ type: "text", text: "Voice profile deleted." }] };
  },
});

export const scriptTools: Tool[] = [
  versely_write_script,
  versely_get_script,
  versely_list_scripts,
  versely_update_script,
  versely_delete_script,
  versely_get_voice_profile,
  versely_build_voice_profile,
  versely_delete_voice_profile,
];
