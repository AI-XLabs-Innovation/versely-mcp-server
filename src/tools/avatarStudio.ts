// Avatar Studio (backend /hooks/characters/premade, /hooks/characters/:id/
// creations; web /avatars): one consistent person reused across slideshows,
// hook packs, UGC ads and Swap. An avatar IS a hook character, so the user's
// own avatars are listed, made, picked and removed with the hook character
// tools (hooksStudio.ts). This module adds the rest:
//
//   GET  /hooks/characters/premade         the ready-made cast: Versely's
//                                          casting-call characters (portrait +
//                                          full-body shot, typed average / bold /
//                                          extreme / creature), then the UGC ad
//                                          presenters that have a portrait
//                                          (portrait only, no type).
//   POST /hooks/characters/premade         { actor_id } -> { character }: adds one
//                                          to the user's avatars. Free. Adding the
//                                          same person twice returns the existing
//                                          avatar (200 instead of 201). 409 at 12
//                                          active avatars (shared with characters).
//   GET  /hooks/characters/:id/creations   slideshows, hook packs and UGC ads made
//                                          with one of the user's avatars (uuid
//                                          only; a ready-made id is a 404).
//
// Where an id works (backend main, 2026-11-14):
//   - Swap (remixSwap avatarSwapImages): a ready-made id directly, or one of the
//     user's ready avatars.
//   - Character hook packs (hooksStudio getCharacter): the user's avatars only.
//   - UGC ads (ugcAds resolveActor): the user's avatars, and the UGC presenter
//     ids; casting-call ids (char-*) only once added.
// So the plain advice is: add it first, then use the returned character id.

import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { errorResult, jsonResult } from "./_helpers.js";
import { VerselyApiError } from "../errors.js";
import { metaForMediaCard } from "../ui/templates.js";

const TYPES = ["average", "bold", "extreme", "creature"] as const;

interface PremadeAvatar {
  id: string;
  name: string;
  gender?: string;
  age_band?: string;
  style?: string;
  setting?: string;
  image_url?: string;
  type?: string;
  full_body_url?: string | null;
}

interface Character {
  id: string;
  name?: string;
  status?: string;
  image_url?: string | null;
  images?: Array<{ url?: string; kind?: string }>;
  created_at?: string;
}

interface Creation {
  kind: "slideshow" | "hook_pack" | "ugc_ad" | string;
  id: string;
  title?: string;
  thumbnail_url?: string | null;
  status?: string | null;
  created_at?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYPE_TEXT =
  "'average': natural, relatable, influencer-ready people. 'bold': striking fashion-casting faces. 'extreme': " +
  "theatrical, exaggerated characters. 'creature': friendly human-animal hybrids.";

const USES =
  "A ready-made id works directly as avatar_id in versely_swap_video (puts this person into a video). To use one " +
  "in versely_create_character_hook_pack (character_id) or versely_create_ugc_ads (actor_ids), add it first with " +
  "versely_add_ready_made_avatar and use the character id it returns.";

const versely_list_ready_made_avatars = defineTool({
  name: "versely_list_ready_made_avatars",
  description:
    "Versely's ready-made avatar cast: fictional adult characters with a studio portrait and, for the casting-call characters, " +
    "a head-to-toe shot of the same person. Filter by type, gender, age or a word. FREE. Show the user a few that fit " +
    "and let them pick. " +
    USES +
    " The user's own avatars are listed with versely_list_hook_characters.",
  meta: metaForMediaCard(),
  inputSchema: z.object({
    type: z.enum(TYPES).optional().describe(TYPE_TEXT),
    gender: z.enum(["female", "male", "nonbinary"]).optional(),
    age_band: z.enum(["18-24", "25-34", "35-44", "45-54", "55+"]).optional(),
    q: z.string().max(60).optional().describe("Only avatars whose name or style contains this (e.g. 'fitness', 'chef')."),
    full_body_only: z.boolean().optional().describe("Only avatars that have a head-to-toe shot (best for Swap)."),
    limit: z.number().int().min(1).max(100).optional().describe("Default 24."),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (input, ctx) => {
    const res = await ctx.client.get<{ avatars?: PremadeAvatar[] }>("/api/v1/hooks/characters/premade");
    const all = Array.isArray(res?.avatars) ? res.avatars : [];
    const q = input.q?.trim().toLowerCase();
    const matches = all.filter(
      (a) =>
        a?.id &&
        // The UGC presenters carry no type; the web reads absent as 'average'.
        (!input.type || (a.type ?? "average") === input.type) &&
        (!input.gender || a.gender === input.gender) &&
        (!input.age_band || a.age_band === input.age_band) &&
        (!input.full_body_only || !!a.full_body_url) &&
        (!q || `${a.name} ${a.style ?? ""}`.toLowerCase().includes(q)),
    );
    const offset = input.offset ?? 0;
    const page = matches.slice(offset, offset + (input.limit ?? 24)).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type ?? "average",
      gender: a.gender,
      age_band: a.age_band,
      style: a.style,
      portrait_url: a.image_url,
      full_body_url: a.full_body_url ?? null,
    }));
    const result = jsonResult({
      total: matches.length,
      shown: page.length,
      offset,
      avatars: page,
      next:
        "Add one to the user's avatars with versely_add_ready_made_avatar { avatar_id }, or pass the id as avatar_id to versely_swap_video." +
        (matches.length > offset + page.length ? ` More with offset: ${offset + page.length}.` : ""),
    });
    const assets = page
      .filter((a) => typeof a.portrait_url === "string" && a.portrait_url)
      .map((a) => ({ url: String(a.portrait_url), label: `${a.name} (${a.id})` }));
    return assets.length
      ? { ...result, structuredContent: { kind: "gallery", status: "completed", assets, title: "Ready-made avatars" } }
      : result;
  },
});

const versely_add_ready_made_avatar = defineTool({
  name: "versely_add_ready_made_avatar",
  description:
    "Add a ready-made person (from versely_list_ready_made_avatars) to the user's own avatars and return its " +
    "character id. FREE, no credits. Adding the same person again returns the avatar the user already has. The " +
    "user can keep up to 12 avatars (shared with their hook characters); remove one with " +
    "versely_delete_hook_character to make room. The character id works as character_id in " +
    "versely_create_character_hook_pack, in actor_ids for versely_create_ugc_ads (pick a voice_id there: an added " +
    "avatar has no voice of its own) and as avatar_id in versely_swap_video.",
  inputSchema: z.object({
    avatar_id: z.string().min(2).max(64).describe("The ready-made avatar's id (e.g. 'char-tessa') from versely_list_ready_made_avatars."),
  }),
  handler: async (input, ctx) => {
    let res: { character?: Character };
    try {
      res = await ctx.client.post<{ character?: Character }>("/api/v1/hooks/characters/premade", { actor_id: input.avatar_id });
    } catch (err) {
      if (err instanceof VerselyApiError && err.status === 409) {
        return errorResult(
          "Not added: the user already has 12 avatars, the most they can keep. Remove one with versely_delete_hook_character " +
            "(list them with versely_list_hook_characters), then add this one again.",
        );
      }
      if (err instanceof VerselyApiError && err.status === 404) {
        return errorResult(`No ready-made avatar has the id "${input.avatar_id}". Use an id from versely_list_ready_made_avatars.`);
      }
      throw err;
    }
    const c = res?.character;
    if (!c?.id) return jsonResult(res);
    const fullBody = (c.images ?? []).find((i) => i?.kind === "full_body")?.url;
    const lines = [
      `${c.name ?? "The avatar"} is one of the user's avatars: character_id ${c.id} (free, nothing charged).`,
      c.image_url ? `Portrait: ${c.image_url}` : null,
      fullBody ? `Full body: ${fullBody}` : null,
      `Use it as character_id in versely_create_character_hook_pack, in actor_ids for versely_create_ugc_ads (with a ` +
        `voice_id from versely_list_ugc_voices) or as avatar_id in versely_swap_video. See what was made with it later ` +
        `with versely_list_avatar_creations.`,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
});

const FOLLOW_UP: Record<string, string> = {
  slideshow: "versely_get_slideshow { slideshow_id }",
  hook_pack: "versely_get_hook_collection { collection_id }",
  ugc_ad: "a video in the user's library (versely_list_user_media, type videos)",
};

const versely_list_avatar_creations = defineTool({
  name: "versely_list_avatar_creations",
  description:
    "Everything made with one of the user's avatars, newest first: slideshows, hook packs and UGC ads, each with a " +
    "title, status and thumbnail. FREE. Takes the avatar's character id (versely_list_hook_characters or " +
    "versely_add_ready_made_avatar); a ready-made id has no history until it is added. Open a slideshow with " +
    "versely_get_slideshow and a hook pack with versely_get_hook_collection.",
  inputSchema: z.object({
    character_id: z.string().min(2).max(64).describe("The user's avatar (character id)."),
  }),
  handler: async (input, ctx) => {
    if (!UUID_RE.test(input.character_id)) {
      return errorResult(
        `"${input.character_id}" is not one of the user's avatars. Creations are kept for the user's own avatars: ` +
          `list them with versely_list_hook_characters, or add a ready-made one with versely_add_ready_made_avatar first.`,
      );
    }
    const res = await ctx.client.get<{ creations?: Creation[] }>(
      `/api/v1/hooks/characters/${encodeURIComponent(input.character_id)}/creations`,
    );
    const creations = Array.isArray(res?.creations) ? res.creations : null;
    if (!creations) return jsonResult(res);
    const counts: Record<string, number> = {};
    for (const c of creations) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
    return jsonResult({
      total: creations.length,
      counts,
      creations: creations.map((c) => ({
        kind: c.kind,
        id: c.id,
        title: c.title,
        status: c.status ?? null,
        thumbnail_url: c.thumbnail_url ?? null,
        created_at: c.created_at,
        open_with: FOLLOW_UP[c.kind] ?? null,
      })),
      ...(creations.length === 0 ? { note: "Nothing has been made with this avatar yet." } : {}),
    });
  },
});

export const avatarStudioTools: Tool[] = [
  versely_list_ready_made_avatars,
  versely_add_ready_made_avatar,
  versely_list_avatar_creations,
];
