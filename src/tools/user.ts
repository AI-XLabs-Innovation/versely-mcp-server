import { z } from "zod";
import { defineTool, defineVariant, type Tool, type ToolContext } from "./_types.js";
import { jsonResult, resolveUserId } from "./_helpers.js";

const Empty = z.object({});

const versely_get_me = defineTool({
  name: "versely_get_me",
  description:
    "Get the authenticated user's profile (email, name) and credit balance.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.get("/api/v1/user/me");
    return jsonResult(data);
  },
});

/**
 * The backend's `plugin` block (cross-repo contract 4) — present only on
 * ChatGPT-plugin requests (a ck:"openai" token that came through this server).
 */
interface PluginBlock {
  free_account?: boolean;
  free_credits_granted?: number;
  free_credits_remaining?: number;
  runpod_only?: boolean;
}

// openai: the balance in the plugin's own terms. `trial` / `trial_offer`
// describe the web app's free trial, which the plugin can't start and must
// not advertise, so they never appear here.
/**
 * The account's plugin status: on the free trial (`free_account`: never paid,
 * never subscribed, spending the free plugin credits) or not. The backend adds
 * the `plugin` block only to ChatGPT-plugin requests, so any other caller reads
 * as not on the trial.
 */
export async function loadTrialStatus(ctx: ToolContext): Promise<{ freeAccount: boolean; remaining: number; credits: number }> {
  const userId = await ctx.client.getCurrentUserId();
  const data = await ctx.client.get<Record<string, unknown>>(
    `/api/v1/user/${encodeURIComponent(userId)}/credits`,
  );
  const plugin = (data?.plugin && typeof data.plugin === "object" ? data.plugin : {}) as PluginBlock;
  const freeAccount = plugin.free_account === true;
  return {
    freeAccount,
    // Frozen (unusable) once the account pays, so only reported while free.
    remaining: freeAccount ? (plugin.free_credits_remaining ?? 0) : 0,
    credits: typeof data?.credits === "number" ? data.credits : 0,
  };
}

const GET_CREDITS_OPENAI = defineVariant({
  description:
    "Get the user's Versely credit balance. `credits` is the main balance. When `free_account` is true the " +
    "account is on the free trial and works on free plugin credits (`plugin_free_credits`): it can generate only " +
    "with the models versely_find_models marks free_trial, and some features are unavailable - tell the user that plainly.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const { freeAccount, remaining, credits } = await loadTrialStatus(ctx);
    return jsonResult({
      credits,
      plugin_free_credits: remaining,
      free_account: freeAccount,
      ...(freeAccount
        ? {
            note:
              "Free trial: the free plugin credits cover image, video and voiceover generation with the models " +
              "versely_find_models marks free_trial. Other models and features are not available on the free trial.",
          }
        : {}),
    });
  },
});

const versely_get_credits = defineTool({
  name: "versely_get_credits",
  description: "Get the credit balance for the current user (or a specified user_id).",
  inputSchema: z.object({
    user_id: z
      .string()
      .optional()
      .describe("Override the user_id; defaults to the authenticated user."),
  }),
  handler: async (input, ctx) => {
    const userId = await resolveUserId(ctx, input.user_id);
    const data = await ctx.client.get(
      `/api/v1/user/${encodeURIComponent(userId)}/credits`,
    );
    // `trial_offer` is the web app's "start a free trial" pitch (spots left,
    // eligibility). It is an upsell, not a balance, and has no place in an
    // assistant's answer to "how many credits do I have".
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const { trial_offer: _offer, ...rest } = data as Record<string, unknown>;
      return jsonResult(rest);
    }
    return jsonResult(data);
  },
  openai: GET_CREDITS_OPENAI,
});

const versely_list_api_key_scopes = defineTool({
  name: "versely_list_api_key_scopes",
  description: "List all API-key scopes available on the Versely platform (catalog).",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.get("/api/v1/auth/api-keys/scopes");
    return jsonResult(data);
  },
});

const versely_list_purchases = defineTool({
  name: "versely_list_purchases",
  description:
    "The user's transaction history: every subscription payment and credit-pack purchase, newest first, with the " +
    "credits each added, its status and date, plus the total credits purchased.",
  inputSchema: z.object({
    category: z
      .enum(["subscription", "credit_pack"])
      .optional()
      .describe("Only subscription payments, or only credit packs. Omit for both."),
    limit: z.number().int().min(1).max(100).optional().describe("How many (default 50)."),
    offset: z.number().int().min(0).optional().describe("How many to skip, for paging."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/user/purchase-history", {
      query: { category: input.category, limit: input.limit, offset: input.offset },
    });
    return jsonResult(data);
  },
});

const versely_list_user_media = defineTool({
  name: "versely_list_user_media",
  description:
    "List the user's generated media of a given type (images, videos, audios, music, slideshows, ugc), paginated.",
  inputSchema: z.object({
    type: z
      .enum(["images", "videos", "audios", "music", "slideshows", "ugc"])
      .describe("Media category to list."),
    user_id: z
      .string()
      .optional()
      .describe("Override the user_id; defaults to the authenticated user."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Page size (default 10, server caps at 50)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How many to skip (default 0). Use for paging, not `page`."),
  }),
  handler: async (input, ctx) => {
    const userId = await resolveUserId(ctx, input.user_id);
    const query = { limit: input.limit, offset: input.offset };

    // GET /user/:id/slideshows and /user/:id/ugc both destructure req.body, which is
    // `undefined` on a bodyless GET under Express 5 — they 500 unconditionally. Their
    // POST siblings are the same handlers with a body present, so route there instead.
    if (input.type === "slideshows") {
      const data = await ctx.client.post("/api/v1/slideshow/user/list", {}, { query });
      return jsonResult(data);
    }
    if (input.type === "ugc") {
      const data = await ctx.client.post(
        `/api/v1/ugc/user/${encodeURIComponent(userId)}`,
        { limit: input.limit, offset: input.offset },
      );
      return jsonResult(data);
    }

    // The backend reads limit/offset; `page` was read nowhere → always the first page.
    const data = await ctx.client.get(
      `/api/v1/user/${encodeURIComponent(userId)}/${input.type}`,
      { query },
    );
    return jsonResult(data);
  },
});

const versely_delete_generation = defineTool({
  name: "versely_delete_generation",
  description:
    "Delete a generation by ID. The plain types delete the media row; the '-row' variants delete the PARENT generation record — use those to clear a failed/pending generation that has no output URL (e.g. a failure tile).",
  inputSchema: z.object({
    type: z
      .enum([
        "image",
        "video",
        "audio",
        "music",
        "slideshow",
        "ugc",
        "image-row",
        "video-row",
      ])
      .describe("Generation type. Use 'image-row'/'video-row' to remove a failed generation."),
    generation_id: z.string().describe("ID of the generation to delete."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/user/generation/${encodeURIComponent(input.type)}/${encodeURIComponent(input.generation_id)}`,
    );
    return jsonResult(data);
  },
});

export const userTools: Tool[] = [
  versely_get_me,
  versely_get_credits,
  versely_list_api_key_scopes,
  versely_list_purchases,
  versely_list_user_media,
  versely_delete_generation,
];
