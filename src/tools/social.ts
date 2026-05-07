import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult } from "./_helpers.js";

const PlatformSchema = z.enum([
  "instagram",
  "tiktok",
  "youtube",
  "twitter",
  "facebook",
  "linkedin",
  "pinterest",
  "bluesky",
  "threads",
]);

const versely_get_social_auth_url = defineTool({
  name: "versely_get_social_auth_url",
  description:
    "Get an OAuth URL the user can open in a browser to connect a social account to their Versely account.",
  inputSchema: z.object({
    platform: PlatformSchema.describe("Which platform to connect."),
    redirect_url: z
      .string()
      .url()
      .optional()
      .describe("Where to send the user after OAuth completes."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/social/auth-url", {
      query: { platform: input.platform, redirect_url: input.redirect_url },
    });
    return jsonResult(data);
  },
});

const versely_list_social_accounts = defineTool({
  name: "versely_list_social_accounts",
  description: "List all social media accounts connected to the authenticated user.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const data = await ctx.client.get("/api/v1/social/accounts");
    return jsonResult(data);
  },
});

const versely_refresh_social_accounts = defineTool({
  name: "versely_refresh_social_accounts",
  description:
    "Refresh OAuth tokens and sync the latest follower counts / metadata for connected accounts.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const data = await ctx.client.post("/api/v1/social/accounts/refresh", {});
    return jsonResult(data);
  },
});

const versely_disconnect_social_account = defineTool({
  name: "versely_disconnect_social_account",
  description: "Disconnect a connected social account by accountId.",
  inputSchema: z.object({ account_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/social/accounts/${encodeURIComponent(input.account_id)}`,
    );
    return jsonResult(data);
  },
});

const PostTargetSchema = z
  .object({
    account_id: z.string().describe("Connected social account ID to post to."),
    platform_options: z
      .record(z.unknown())
      .optional()
      .describe(
        "Platform-specific options (e.g. Instagram caption first comment, YouTube category, etc.).",
      ),
  })
  .passthrough();

const versely_preview_post = defineTool({
  name: "versely_preview_post",
  description:
    "Preview how a post will appear on each target platform without publishing or charging credits.",
  inputSchema: z
    .object({
      caption: z.string().optional(),
      media_urls: z.array(z.string().url()).optional(),
      targets: z.array(PostTargetSchema).min(1),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/social/preview", input);
    return jsonResult(data);
  },
});

const versely_publish_post = defineTool({
  name: "versely_publish_post",
  description:
    "Publish (or schedule) a post to one or more connected social accounts via Post for Me.",
  inputSchema: z
    .object({
      caption: z.string().optional(),
      media_urls: z.array(z.string().url()).optional(),
      targets: z.array(PostTargetSchema).min(1),
      scheduled_at: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp to schedule the post; omit to publish immediately."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/social/posts", input);
    return jsonResult(data);
  },
});

const versely_list_posts = defineTool({
  name: "versely_list_posts",
  description: "List the authenticated user's published posts.",
  inputSchema: z.object({
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    platform: PlatformSchema.optional(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/social/posts", {
      query: input,
    });
    return jsonResult(data);
  },
});

const versely_get_post = defineTool({
  name: "versely_get_post",
  description: "Get a published post's details and performance metrics.",
  inputSchema: z.object({ post_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/social/posts/${encodeURIComponent(input.post_id)}`,
    );
    return jsonResult(data);
  },
});

export const socialTools: Tool[] = [
  versely_get_social_auth_url,
  versely_list_social_accounts,
  versely_refresh_social_accounts,
  versely_disconnect_social_account,
  versely_preview_post,
  versely_publish_post,
  versely_list_posts,
  versely_get_post,
];
