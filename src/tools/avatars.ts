// Stock avatars and voices for the avatar lip-sync models. The web app's
// pickers read the same endpoints (backend routes/avatar.routes.ts):
//   GET /avatar                  VEED avatar previews; the FILENAME is the id
//   GET /avatar/avatar-x         Avatar X avatars; `value` is what is sent back
//   GET /avatar/heygen?model=    HeyGen avatars (V3 and V5 catalogs differ)
//   GET /avatar/heygen/voices?model=  HeyGen voices
// Without this tool the assistant had no way to pick an avatar: it sent VEED
// Avatars no avatar_id at all, which that endpoint requires.

import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./_types.js";
import { jsonResult } from "./_helpers.js";

export const AVATAR_MODELS = ["Veed Avatars", "HeyGen Avatar V3", "HeyGen Avatar V5", "Avatar X"] as const;
type AvatarModel = (typeof AVATAR_MODELS)[number];

const HEYGEN_GENERATION: Record<string, "v3" | "v5"> = { "HeyGen Avatar V3": "v3", "HeyGen Avatar V5": "v5" };

/** "emily_vertical_primary.jpg" in a preview URL → "emily_vertical_primary" (versely-web lipsync pickers). */
function veedIdFromUrl(url: string): string {
  const file = url.split("/").pop() ?? url;
  return decodeURIComponent(file.replace(/\?.*$/, "")).replace(/\.[a-z0-9]+$/i, "");
}

/**
 * The avatar ids Veed Avatars accepts: fal's `avatar_id` enum, the same list
 * the backend checks (constants/falSchema, veedAvatarIds; it matched fal's
 * live schema on 2026-09-24). The bucket behind GET /avatar only supplies the
 * preview pictures, so an id is offered only if fal will take it.
 */
export const VEED_AVATAR_IDS: readonly string[] = [
  "emily_vertical_primary", "emily_vertical_secondary", "marcus_vertical_primary", "marcus_vertical_secondary",
  "mira_vertical_primary", "mira_vertical_secondary", "jasmine_vertical_primary", "jasmine_vertical_secondary",
  "jasmine_vertical_walking", "aisha_vertical_walking", "elena_vertical_primary", "elena_vertical_secondary",
  "any_male_vertical_primary", "any_female_vertical_primary", "any_male_vertical_secondary",
  "any_female_vertical_secondary", "any_female_vertical_walking", "emily_primary", "emily_side", "marcus_primary",
  "marcus_side", "aisha_walking", "elena_primary", "elena_side", "any_male_primary", "any_female_primary",
  "any_male_side", "any_female_side",
];

interface VeedAvatar {
  id: string;
  name: string;
  orientation: "portrait" | "landscape";
  gender?: "male" | "female";
  preview_image_url: string | null;
}

function describeVeed(id: string, preview: string | undefined): VeedAvatar {
  const parts = id.split("_");
  const who = parts[0] === "any" ? `Any ${parts[1] ?? ""}`.trim() : parts[0] ?? id;
  const variant = parts.filter((p) => !["any", "male", "female", "vertical", parts[0]].includes(p)).join(" ");
  const gender = id.includes("any_male") ? "male" : id.includes("any_female") ? "female" : undefined;
  return {
    id,
    name: `${who.charAt(0).toUpperCase()}${who.slice(1)}${variant ? ` (${variant})` : ""}`,
    orientation: id.includes("vertical") ? "portrait" : "landscape",
    ...(gender ? { gender } : {}),
    preview_image_url: preview ?? null,
  };
}

export async function loadVeedAvatars(ctx: ToolContext): Promise<VeedAvatar[]> {
  const previews = new Map<string, string>();
  try {
    const res = await ctx.client.get<{ data?: unknown[] }>("/api/v1/avatar");
    for (const u of Array.isArray(res?.data) ? res.data : []) {
      if (typeof u === "string" && u) previews.set(veedIdFromUrl(u), u);
    }
  } catch {
    /* previews are a nicety; the ids stand without them */
  }
  return VEED_AVATAR_IDS.map((id) => describeVeed(id, previews.get(id)));
}

const matches = (q: string | undefined, ...fields: unknown[]) =>
  !q || fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q.toLowerCase()));

const versely_list_avatars = defineTool({
  name: "versely_list_avatars",
  description:
    "The stock avatars (and HeyGen voices) the avatar lip-sync models take, so you can pick a look instead of " +
    "leaving it to chance. Pass what you pick to versely_generate_lipsync:\n" +
    "• Veed Avatars → `avatar_id` (e.g. 'emily_vertical_primary'; 'vertical' ones are 9:16 portrait).\n" +
    "• HeyGen Avatar V3 / V5 → `avatar_id` and `voice_id` (V3 needs both; V5 falls back to a default without them; " +
    "the two generations have different avatars).\n" +
    "• Avatar X → `avatar_id` (the `avatar` value).\n" +
    "Each entry has a preview image link you can show the user.",
  inputSchema: z.object({
    model: z.enum(AVATAR_MODELS).describe("Which avatar model's catalog: Veed Avatars, HeyGen Avatar V3, HeyGen Avatar V5, or Avatar X."),
    q: z.string().optional().describe("Only avatars (and voices) whose name contains this."),
    gender: z.enum(["male", "female"]).optional(),
    orientation: z.enum(["portrait", "landscape"]).optional().describe("Veed Avatars and Avatar X: 9:16 portrait or 16:9 landscape."),
    language: z.string().optional().describe("HeyGen voices: only this language (e.g. 'English', 'Spanish')."),
    limit: z.number().int().min(1).max(100).optional().describe("Max avatars (and max voices) returned. Default 30."),
  }),
  handler: async (input, ctx) => {
    const limit = input.limit ?? 30;
    const model = input.model as AvatarModel;

    if (model === "Veed Avatars") {
      const all = await loadVeedAvatars(ctx);
      const avatars = all.filter(
        (a) =>
          matches(input.q, a.id, a.name) &&
          (!input.gender || a.gender === input.gender || (a.gender === undefined && !a.id.startsWith("any_"))) &&
          (!input.orientation || a.orientation === input.orientation),
      );
      return jsonResult({
        model,
        pass_as: "avatar_id",
        total: avatars.length,
        avatars: avatars.slice(0, limit),
        ...(input.gender ? { note: "Only the 'any_male' / 'any_female' avatars carry a gender in their id; named ones are kept." } : {}),
      });
    }

    if (model === "Avatar X") {
      const res = await ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/avatar/avatar-x");
      const all = Array.isArray(res?.data) ? res.data : [];
      const avatars = all
        .filter((a) => matches(input.q, a.name, a.value) && (!input.orientation || a.orientation === input.orientation))
        .map((a) => ({
          avatar_id: a.value,
          name: a.name,
          orientation: a.orientation,
          ...(a.is_default ? { is_default: true } : {}),
          preview_image_url: a.preview_image_url ?? null,
          preview_video_url: a.preview_video_url ?? null,
        }));
      return jsonResult({ model, pass_as: "avatar_id", total: avatars.length, avatars: avatars.slice(0, limit) });
    }

    const generation = HEYGEN_GENERATION[model]!;
    const [avatarRes, voiceRes] = await Promise.all([
      ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/avatar/heygen", { query: { model: generation } }),
      ctx.client.get<{ data?: Array<Record<string, unknown>> }>("/api/v1/avatar/heygen/voices", { query: { model: generation } }),
    ]);
    const avatars = (Array.isArray(avatarRes?.data) ? avatarRes.data : [])
      .filter((a) => matches(input.q, a.name, a.avatar_id) && (!input.gender || String(a.gender).toLowerCase() === input.gender))
      .map((a) => ({
        avatar_id: a.avatar_id,
        name: a.name,
        gender: a.gender,
        preview_image_url: a.preview_image_url ?? null,
        preview_video_url: a.preview_video_url ?? null,
      }));
    const voices = (Array.isArray(voiceRes?.data) ? voiceRes.data : [])
      .filter(
        (v) =>
          (!input.gender || String(v.gender).toLowerCase() === input.gender) &&
          (!input.language || String(v.language ?? "").toLowerCase().includes(input.language.toLowerCase())),
      )
      .map((v) => ({ voice_id: v.voice_id, name: v.name, language: v.language, gender: v.gender }));
    return jsonResult({
      model,
      pass_as: "avatar_id + voice_id",
      avatars_total: avatars.length,
      avatars: avatars.slice(0, limit),
      voices_total: voices.length,
      voices: voices.slice(0, limit),
    });
  },
});

/**
 * What an avatar model needs before it may be charged. The endpoints refuse
 * these only after the charge (then refund), or run with no avatar at all;
 * refusing here costs nothing and says exactly what to pick.
 */
export async function checkAvatarRequest(ctx: ToolContext, model: string, body: Record<string, unknown>): Promise<void> {
  const script = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const avatarId = typeof body.avatar_id === "string" ? body.avatar_id.trim() : "";
  const pick = (m: string) => `Pick one with versely_list_avatars (model '${m}').`;

  if (model === "Veed Avatars") {
    if (!script) throw new Error("Veed Avatars speaks a script: pass `script` (the words to say).");
    if (!avatarId) throw new Error(`Veed Avatars needs \`avatar_id\`. ${pick("Veed Avatars")}`);
    if (!VEED_AVATAR_IDS.includes(avatarId)) throw new Error(`"${avatarId}" is not a Veed avatar. ${pick("Veed Avatars")}`);
    return;
  }
  if (model === "HeyGen Avatar V3") {
    const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";
    if (!script) throw new Error("HeyGen Avatar V3 speaks a script: pass `script` (the words to say).");
    if (!avatarId || !voiceId) throw new Error(`HeyGen Avatar V3 needs \`avatar_id\` and \`voice_id\`. ${pick(model)}`);
    return;
  }
  if (model === "HeyGen Avatar V5") {
    // V5 has provider defaults for the avatar and voice; it needs something to say.
    if (!script && !body.audio_url) {
      throw new Error("HeyGen Avatar V5 needs `script` (the words to say) or an `audio_url` to lip-sync.");
    }
    return;
  }
  if (model === "Avatar X Text to Video") {
    const text = typeof body.script === "string" && body.script.trim() ? body.script.trim() : script;
    if (text.length < 50 || text.length > 1500) {
      throw new Error(`Avatar X Text to Video needs a script of 50 to 1,500 characters (got ${text.length}).`);
    }
  }
}

export const avatarTools: Tool[] = [versely_list_avatars];
