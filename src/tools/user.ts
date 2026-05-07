import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult, resolveUserId } from "./_helpers.js";

const Empty = z.object({});

const versely_get_me = defineTool({
  name: "versely_get_me",
  description:
    "Get the authenticated user's profile, plan, and credit balance. Returns the full /user/me response.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.get("/api/v1/user/me");
    return jsonResult(data);
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
    return jsonResult(data);
  },
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
  description: "Get the credit purchase history for the authenticated user.",
  inputSchema: Empty,
  handler: async (_input, ctx) => {
    const data = await ctx.client.get("/api/v1/user/purchase-history");
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
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  handler: async (input, ctx) => {
    const userId = await resolveUserId(ctx, input.user_id);
    const data = await ctx.client.get(
      `/api/v1/user/${encodeURIComponent(userId)}/${input.type}`,
      { query: { page: input.page, limit: input.limit } },
    );
    return jsonResult(data);
  },
});

const versely_delete_generation = defineTool({
  name: "versely_delete_generation",
  description: "Delete a specific generation (image, video, audio, or music) by ID.",
  inputSchema: z.object({
    type: z
      .enum(["image", "video", "audio", "music"])
      .describe("Generation type."),
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
