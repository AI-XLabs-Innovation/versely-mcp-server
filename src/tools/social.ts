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

/**
 * The API takes a flat `account_ids: string[]`. It has no per-target options
 * concept, so a `targets: [{account_id, platform_options}]` array (which this
 * MCP used to send) never reached it — every publish/preview 400'd with
 * "At least one account_id is required". Legacy `targets` input is still
 * accepted here and flattened to account_ids; platform_options is dropped
 * because no server-side equivalent exists.
 */
const LegacyPostTarget = z
  .object({
    account_id: z.string().describe("Connected social account ID."),
    platform_options: z
      .record(z.unknown())
      .optional()
      .describe("Ignored — the API has no per-platform options parameter."),
  })
  .passthrough();

/** Normalise account_ids from either the current or the legacy `targets` shape. */
function resolveAccountIds(input: {
  account_ids?: string[];
  targets?: Array<{ account_id?: string }>;
}): string[] {
  if (Array.isArray(input.account_ids) && input.account_ids.length > 0) {
    return input.account_ids;
  }
  const fromTargets = (input.targets ?? [])
    .map((t) => t?.account_id)
    .filter((id): id is string => typeof id === "string" && !!id);
  if (fromTargets.length === 0) {
    throw new Error(
      "`account_ids` is required — a non-empty array of connected account IDs (get them from versely_list_social_accounts).",
    );
  }
  return fromTargets;
}

const versely_preview_post = defineTool({
  name: "versely_preview_post",
  description:
    "Preview how a post will appear on each target platform without publishing or charging credits. Requires a caption or at least one media URL.",
  inputSchema: z
    .object({
      caption: z.string().optional().describe("Required unless media_urls is provided."),
      media_urls: z.array(z.string().url()).optional(),
      account_ids: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Connected account IDs to preview for. Required — from versely_list_social_accounts."),
      targets: z
        .array(LegacyPostTarget)
        .min(1)
        .optional()
        .describe("Deprecated shape — prefer account_ids."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { targets, account_ids, ...rest } = input;
    const body = { ...rest, account_ids: resolveAccountIds(input) };
    const data = await ctx.client.post("/api/v1/social/preview", body);
    return jsonResult(data);
  },
});

const versely_publish_post = defineTool({
  name: "versely_publish_post",
  description:
    "Publish (or schedule) a post to one or more connected social accounts via Post for Me. Caption is required. Costs credits.",
  inputSchema: z
    .object({
      caption: z.string().describe("Post caption. Required — the API rejects posts without one."),
      media_urls: z.array(z.string().url()).optional(),
      account_ids: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Connected account IDs to publish to. Required — from versely_list_social_accounts."),
      scheduled_at: z
        .string()
        .optional()
        .describe("ISO-8601 timestamp to schedule the post; omit to publish immediately."),
      is_draft: z.boolean().optional().describe("Save as a draft instead of publishing."),
      tiktok_draft: z
        .boolean()
        .optional()
        .describe("Send to the TikTok app's drafts for manual review rather than posting live."),
      targets: z
        .array(LegacyPostTarget)
        .min(1)
        .optional()
        .describe("Deprecated shape — prefer account_ids."),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { targets, account_ids, ...rest } = input;
    const body = { ...rest, account_ids: resolveAccountIds(input) };
    const data = await ctx.client.post("/api/v1/social/posts", body);
    return jsonResult(data);
  },
});

const versely_list_posts = defineTool({
  name: "versely_list_posts",
  description:
    "List the authenticated user's posts (newest first). Note: `platform` is filtered client-side within the fetched page — the API has no platform filter, so widen `limit` if you filter.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How many to skip (default 0). Use for paging, not `page`."),
    platform: PlatformSchema.optional().describe(
      "Optional client-side filter on the returned page.",
    ),
  }),
  handler: async (input, ctx) => {
    // The backend reads limit/offset only — `page` was read nowhere (always page 1)
    // and no platform filter exists server-side.
    const data = await ctx.client.get<{ posts?: Array<Record<string, unknown>> }>(
      "/api/v1/social/posts",
      { query: { limit: input.limit, offset: input.offset } },
    );
    if (input.platform && Array.isArray(data?.posts)) {
      const wanted = String(input.platform).toLowerCase();
      const posts = data.posts.filter((p) => {
        const platforms = p?.platforms;
        return (
          Array.isArray(platforms) &&
          platforms.some((x) => String(x).toLowerCase() === wanted)
        );
      });
      return jsonResult({
        ...data,
        posts,
        filtered_client_side: {
          platform: input.platform,
          matched: posts.length,
          scanned: data.posts.length,
          note: "Filter applied to the fetched page only; increase limit/offset to scan further.",
        },
      });
    }
    return jsonResult(data);
  },
});

const versely_get_post = defineTool({
  name: "versely_get_post",
  description:
    "Get a post's details, live results, and its published permalink(s). The public URL comes from the stored per-platform result — `results` (a live refetch) does not include it.",
  inputSchema: z.object({ post_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get<{
      post?: { result?: Array<Record<string, any>> };
      results?: unknown;
    }>(`/api/v1/social/posts/${encodeURIComponent(input.post_id)}`);

    // The authoritative permalink lives on the stored webhook result
    // (post.result[].platform_data.url). The `results` array is a live Post-for-Me
    // refetch whose shape omits the URL, so surface the real links explicitly
    // rather than leaving the model to read the obvious-but-URL-less key.
    const stored = Array.isArray(data?.post?.result) ? data.post!.result! : [];
    const post_urls = stored
      .map((r) => ({
        platform: r?.platform,
        url: r?.platform_data?.url,
      }))
      .filter((r) => typeof r.url === "string" && r.url);

    return jsonResult(post_urls.length ? { ...data, post_urls } : data);
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
