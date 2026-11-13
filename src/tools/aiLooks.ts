// Photo looks (backend /ai-looks, the editor's paid "AI looks"): one photo of
// a person re-shot in a style - digicam flash, night flash, golden hour, film,
// photobooth strip... - keeping the same face, outfit, pose and framing.
//
//   GET  /ai-looks/presets    the looks, each with its price (free)
//   POST /ai-looks            start one: 202 { job } (charged as an image generation)
//   GET  /ai-looks/jobs/:id   processing | succeeded (image_url) | failed (error)
//
// There is no quote endpoint: the presets list carries each look's price, so
// versely_list_photo_looks is the quote. A look is held at its full catalog
// price while it runs (credits_held) and settles to its usual price (credits)
// when it finishes; the two are usually different. versely_apply_photo_look
// takes confirm_credits and re-reads the list before starting, refusing
// (nothing charged) when the look's price is no longer what the user approved.
// The backend's `model` field names the image model; it is never shown.

import { z } from "zod";
import { defineTool, type Tool, type ToolResult } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { SYNC_TIMEOUT_MS } from "../client.js";
import { VerselyApiError } from "../errors.js";
import { metaForMediaCard } from "../ui/templates.js";

// --- Backend shapes (services/aiLooks/core.ts, 2026-11-14) -----------------------

interface LookPreset {
  id: string;
  name: string;
  group?: string;
  description?: string;
  thumbnail?: string;
  /** What the look costs (the usual case). */
  credits: number;
  /** Held while it runs; the difference comes back when it finishes. */
  credits_held?: number;
}

interface LookCatalog {
  presets: LookPreset[];
  groups: Array<{ id: string; label: string }>;
}

type LookStatus = "processing" | "succeeded" | "failed";

interface LookJob {
  id: string;
  status: LookStatus | string;
  preset?: string | null;
  tier?: string | null;
  image_url?: string | null;
  error?: string | null;
  credits?: number;
  credits_held?: number;
}

/** The backend's three prompt tiers; strength is 0..1 on the wire (< 0.34 subtle, > 0.66 bold). */
const STRENGTHS = ["subtle", "balanced", "bold"] as const;
type Strength = (typeof STRENGTHS)[number];
const STRENGTH_VALUE: Record<Strength, number> = { subtle: 0.2, balanced: 0.5, bold: 0.85 };

function credits(n: number | undefined): string {
  return typeof n === "number" ? `${n} credit${n === 1 ? "" : "s"}` : "an unknown number of credits";
}

/** `{ success, presets, groups, ... }`: only the fields the tools use, never the model name. */
function catalogOf(res: unknown): LookCatalog | undefined {
  const r = (res ?? {}) as Record<string, unknown>;
  const src = (Array.isArray(r.presets) ? r : (r.data as Record<string, unknown> | undefined)) ?? {};
  const raw = (src as Record<string, unknown>).presets;
  if (!Array.isArray(raw)) return undefined;
  const presets = raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string")
    .filter((p) => typeof p.credits === "number")
    .map((p) => ({
      id: String(p.id),
      name: typeof p.name === "string" ? p.name : String(p.id),
      group: typeof p.group === "string" ? p.group : undefined,
      description: typeof p.description === "string" ? p.description : undefined,
      thumbnail: typeof p.thumbnail === "string" ? p.thumbnail : undefined,
      credits: p.credits as number,
      credits_held: typeof p.credits_held === "number" ? p.credits_held : undefined,
    }));
  const groupsRaw = (src as Record<string, unknown>).groups;
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object" && typeof (g as Record<string, unknown>).id === "string")
        .map((g) => ({ id: String(g.id), label: typeof g.label === "string" ? g.label : String(g.id) }))
    : [];
  return { presets, groups };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

/** A look by its id ("golden-hour") or its name ("Golden hour"). */
function findLook(catalog: LookCatalog, wanted: string): LookPreset | undefined {
  const w = norm(wanted);
  return catalog.presets.find((p) => norm(p.id) === w) ?? catalog.presets.find((p) => norm(p.name) === w);
}

/** "golden-hour" -> "Golden hour": the poll result carries the look's id only. */
function labelOf(id: string | null | undefined): string {
  const s = String(id ?? "").replace(/[-_]+/g, " ").trim();
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : "Photo look";
}

/** "6 credits" or "6 credits (8 held while it runs; the difference comes back when it finishes)". */
function priceText(p: { credits?: number; credits_held?: number }): string {
  const held = p.credits_held;
  return typeof held === "number" && typeof p.credits === "number" && held > p.credits
    ? `${credits(p.credits)} (${held} held while it runs; the difference comes back when it finishes)`
    : credits(p.credits);
}

// --- Card ----------------------------------------------------------------------

const POLL = { interval_ms: 4000, timeout_ms: 12 * 60_000 };

function pollHint(id: string): string {
  return `versely_get_photo_look { job_id: ${JSON.stringify(id)} }`;
}

/** Card state + text for a look: pending (polling versely_get_photo_look), the finished photo, or the failure. */
function lookResult(job: LookJob, name: string, toolName: string, toolArgs: Record<string, unknown>): ToolResult {
  const echo = { title: name, toolName, toolArgs };
  if (job.status === "succeeded" && job.image_url) {
    return {
      content: [
        {
          type: "text",
          text: `The "${name}" look is ready: ${job.image_url}\nIt is saved in the user's Versely images.`,
        },
      ],
      structuredContent: {
        kind: "image",
        assets: [{ url: job.image_url, label: name }],
        status: "completed",
        task_id: job.id,
        ...echo,
      },
    };
  }
  if (job.status === "failed" || job.status === "succeeded") {
    const error = job.error || "This look could not be made. Any credits held for it were returned.";
    return {
      content: [{ type: "text", text: `The "${name}" look failed: ${error}` }],
      structuredContent: { kind: "image", assets: [], status: "failed", task_id: job.id, error, ...echo },
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `The "${name}" look is still being made (job_id ${job.id}); it usually takes about a minute. ` +
          `The card updates by itself; otherwise check ${pollHint(job.id)} again shortly. It is NOT finished yet; do not apply it again.`,
      },
    ],
    structuredContent: {
      kind: "image",
      assets: [],
      status: "pending",
      task_id: job.id,
      message: `Applying the ${name} look.`,
      poll: { tool_name: "versely_get_photo_look", args: { job_id: job.id }, ...POLL },
      ...echo,
    },
  };
}

// --- Tools ---------------------------------------------------------------------

const ABOUT =
  "Photo looks re-shoot one photo of a person in a new camera, light and colour style (digicam flash, date stamp, night " +
  "flash, film, black and white, golden hour, neon night, photobooth strip, magazine flash...) while keeping the same face, " +
  "outfit, pose and framing. ";

const versely_list_photo_looks = defineTool({
  name: "versely_list_photo_looks",
  description:
    ABOUT +
    "This tool is FREE: it lists every look by group with its id, a one-line description, an example picture and its price " +
    "in credits per photo. It is also the price check for versely_apply_photo_look: show the user the looks (or the one they " +
    "asked for) with the price, and apply one only after they pick it and agree to the price.",
  inputSchema: z.object({
    group: z
      .string()
      .max(40)
      .optional()
      .describe("Only one group, by id or label: digicam, flash, film, golden (golden hour & sunset), night, photobooth, editorial."),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get("/api/v1/ai-looks/presets");
    const catalog = catalogOf(res);
    if (!catalog) return jsonResult(res);
    const want = input.group ? norm(input.group) : undefined;
    const groups = catalog.groups.length
      ? catalog.groups
      : [...new Set(catalog.presets.map((p) => p.group ?? "other"))].map((id) => ({ id, label: labelOf(id) }));
    const shown = groups.filter((g) => !want || norm(g.id) === want || norm(g.label) === want || norm(g.label).startsWith(want));
    if (want && shown.length === 0) {
      return errorResult(`No look group "${input.group}". Groups: ${groups.map((g) => `${g.id} (${g.label})`).join(", ")}.`);
    }
    const lines: string[] = ["Photo looks (PAID per photo; listing them is free):"];
    for (const g of shown) {
      const looks = catalog.presets.filter((p) => (p.group ?? "other") === g.id);
      if (!looks.length) continue;
      lines.push("", `${g.label} (group ${g.id}):`);
      for (const p of looks) {
        lines.push(
          `- ${p.id}: ${p.name}${p.description ? `. ${p.description}` : ""} ${priceText(p)}.${p.thumbnail ? ` Example: ${p.thumbnail}` : ""}`,
        );
      }
    }
    const listed = new Set(shown.map((g) => g.id));
    const ungrouped = want ? [] : catalog.presets.filter((p) => !listed.has(p.group ?? "other"));
    if (ungrouped.length) {
      lines.push("", "Other:");
      for (const p of ungrouped) lines.push(`- ${p.id}: ${p.name}${p.description ? `. ${p.description}` : ""} ${priceText(p)}.`);
    }
    lines.push(
      "",
      "Next: once the user has picked a look and agreed to its price, call versely_apply_photo_look with image_url, look (the id) " +
        "and confirm_credits (that look's price). Strength 'subtle', 'balanced' (default) or 'bold' does not change the price.",
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
});

const versely_apply_photo_look = defineTool({
  name: "versely_apply_photo_look",
  description:
    ABOUT +
    "PAID: spends the look's price in credits once (refunded if it fails). Call it only after the user picked the look and " +
    "agreed to its price from versely_list_photo_looks, and pass that price as confirm_credits. If the price is different " +
    "now, the call is refused with the new price and nothing is charged: show it and ask again. The photo must be a public " +
    "https image of the user or of someone who agreed to it: a result of an earlier Versely tool or a file stored with " +
    "versely_upload_media. The result keeps the photo's shape (the photobooth strip is 9:16) and usually takes about a " +
    "minute; the card follows it, otherwise check versely_get_photo_look. Never apply the same look twice by accident.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    image_url: z.string().url().max(2000).describe("The photo to re-shoot: a public https image URL of a person."),
    look: z
      .string()
      .min(1)
      .max(80)
      .describe("The look's id from versely_list_photo_looks, e.g. 'golden-hour', 'night-flash', 'photo-strip' (its name also works)."),
    strength: z
      .enum(STRENGTHS)
      .optional()
      .describe("'subtle' (gentle change), 'balanced' (default: obvious at a glance) or 'bold' (pushed hard). Same price."),
    confirm_credits: z
      .number()
      .positive()
      .describe("The look's price from versely_list_photo_looks that the user approved. Must equal the current price."),
  }),
  handler: async (input, ctx) => {
    const catalog = catalogOf(await ctx.client.get("/api/v1/ai-looks/presets"));
    if (!catalog) return errorResult("Could not read the photo looks right now, so nothing was started or charged. Try again shortly.");
    const look = findLook(catalog, input.look);
    if (!look) {
      return errorResult(
        `No photo look "${input.look}". Nothing was charged. Looks: ${catalog.presets.map((p) => p.id).join(", ")}. ` +
          `Show them with versely_list_photo_looks.`,
      );
    }
    // The user approved either the usual price or the amount held while it runs; both are quoted figures.
    if (input.confirm_credits !== look.credits && input.confirm_credits !== look.credits_held) {
      return errorResult(
        `Not started, nothing charged: the "${look.name}" look costs ${priceText(look)} now (you passed ${input.confirm_credits}). ` +
          `Show the user the new price and ask again; if they agree, call versely_apply_photo_look with confirm_credits: ${look.credits}.`,
      );
    }
    const strength = input.strength ?? "balanced";
    const res = await ctx.client.post<Record<string, unknown>>(
      "/api/v1/ai-looks",
      { image_url: input.image_url, preset: look.id, strength: STRENGTH_VALUE[strength] },
      { timeoutMs: SYNC_TIMEOUT_MS },
    );
    const job = ((res?.job ?? (res?.data as Record<string, unknown> | undefined)?.job) ?? undefined) as LookJob | undefined;
    if (!job || typeof job.id !== "string") return jsonResult(res);

    const card = lookResult(job, look.name, "versely_apply_photo_look", input);
    if (job.status !== "processing") return card;
    return {
      ...card,
      content: [
        {
          type: "text",
          text:
            `Applying the "${look.name}" look (${strength}) to the photo: ${priceText({ credits: job.credits ?? look.credits, credits_held: job.credits_held ?? look.credits_held })}, ` +
            `refunded if it fails. It usually takes about a minute. The card updates by itself; otherwise check ${pollHint(job.id)}. ` +
            `It is NOT finished yet; do not apply it again.`,
        },
      ],
    };
  },
});

const versely_get_photo_look = defineTool({
  name: "versely_get_photo_look",
  description:
    "Check a photo look started with versely_apply_photo_look: still being made, the finished photo's URL, or why it failed " +
    "(the credits come back then). FREE. The card follows it by itself, so don't call this in a loop. Finished photos stay in " +
    "the user's Versely images.",
  // Visible to the app too: the apply card's poll loop calls this tool.
  meta: metaForMediaCard({ app: true }),
  inputSchema: z.object({
    job_id: z.string().min(1).max(64).describe("The job_id versely_apply_photo_look returned."),
  }),
  handler: async (input, ctx) => {
    let res: Record<string, unknown>;
    try {
      res = await ctx.client.get<Record<string, unknown>>(`/api/v1/ai-looks/jobs/${encodeURIComponent(input.job_id)}`);
    } catch (err) {
      if (err instanceof VerselyApiError && err.status === 404) {
        const error = "No photo look with that job_id. Finished looks stay in the user's Versely images (versely_list_user_media, type 'images').";
        return {
          content: [{ type: "text", text: error }],
          structuredContent: { kind: "image", assets: [], status: "failed", task_id: input.job_id, error, toolName: "versely_get_photo_look", toolArgs: input },
        };
      }
      throw err;
    }
    const job = ((res?.job ?? (res?.data as Record<string, unknown> | undefined)?.job) ?? undefined) as LookJob | undefined;
    if (!job || typeof job.id !== "string") return jsonResult(res);
    return lookResult(job, labelOf(job.preset), "versely_get_photo_look", input);
  },
});

export const aiLooksTools: Tool[] = [versely_list_photo_looks, versely_apply_photo_look, versely_get_photo_look];
