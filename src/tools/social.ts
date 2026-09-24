import { z } from "zod";
import { defineTool, type Tool, type ToolContext } from "./_types.js";
import { jsonResult } from "./_helpers.js";

/**
 * Automations and workflow auto-posting match accounts by the provider's id
 * (`external_account_id`), while versely_list_social_accounts' `id` - what
 * publish_post takes - is Versely's own. A Versely id sent there matched
 * nothing, so the automation never posted. Accept either: Versely ids are
 * mapped to provider ids, provider ids are kept, anything else is refused.
 */
export async function toProviderAccountIds(ctx: ToolContext, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const data = await ctx.client.get<{
    accounts?: Array<{ id?: unknown; external_account_id?: unknown }>;
  }>("/api/v1/social/accounts");
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  const byVerselyId = new Map(accounts.map((a) => [String(a.id), String(a.external_account_id)]));
  const providerIds = new Set(accounts.map((a) => String(a.external_account_id)));
  const out: string[] = [];
  const unknown: string[] = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    const mapped = byVerselyId.get(id);
    if (mapped) out.push(mapped);
    else if (providerIds.has(id)) out.push(id);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Not a connected social account: ${unknown.join(", ")}. Use the ids from versely_list_social_accounts.`,
    );
  }
  return [...new Set(out)];
}

/** Platforms a user can connect (versely-web lib/autoPost CONNECTABLE). `twitter` is X's old name. */
const CONNECTABLE = [
  "instagram",
  "tiktok",
  "youtube",
  "x",
  "twitter",
  "facebook",
  "linkedin",
  "pinterest",
  "threads",
  "bluesky",
] as const;

/** Every platform a connected account or post can carry. */
const PlatformSchema = z.enum([...CONNECTABLE, "tiktok_business"]);

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  tiktok_business: "TikTok Business",
  youtube: "YouTube",
  x: "X",
  twitter: "X",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  threads: "Threads",
  bluesky: "Bluesky",
};

const MEDIA_RULES =
  "Media rules: YouTube takes video only; TikTok takes one video or pictures, never both; " +
  "Instagram needs an image or a video; X and Bluesky post at most 4 pictures.";

const versely_get_social_auth_url = defineTool({
  name: "versely_get_social_auth_url",
  description:
    "Get a link the user opens to connect one of their social accounts (Instagram, TikTok, YouTube, X, " +
    "Facebook, LinkedIn, Pinterest, Threads, Bluesky) to Versely, so Versely can post there. Show the link " +
    "to the user as a clickable link. After they say they finished connecting, call " +
    "versely_refresh_social_accounts, then versely_list_social_accounts to get the new account's id.",
  inputSchema: z.object({
    platform: z.enum(CONNECTABLE).describe("Which platform to connect."),
    redirect_url: z
      .string()
      .url()
      .optional()
      .describe("Where to send the user after they connect. Defaults to Versely's accounts page."),
  }),
  handler: async (input, ctx) => {
    const platform = input.platform === "twitter" ? "x" : input.platform;
    const data = await ctx.client.get<{ url?: string }>("/api/v1/social/auth-url", {
      query: { platform, redirect_url: input.redirect_url },
    });
    const url = typeof data?.url === "string" ? data.url : "";
    if (!url) return jsonResult(data);
    const label = PLATFORM_LABELS[platform] ?? platform;
    return {
      content: [
        {
          type: "text",
          text:
            `Connect link for ${label}: ${url}\n\n` +
            `Give the user this link to open and sign in to ${label}. When they say they are done, call ` +
            `versely_refresh_social_accounts so the account is linked to their Versely account, then ` +
            `versely_list_social_accounts for its id.`,
        },
      ],
      structuredContent: { platform, url },
    };
  },
  openai: { hide: ["redirect_url"] },
});

const versely_list_social_accounts = defineTool({
  name: "versely_list_social_accounts",
  description:
    "List the social accounts the user connected to Versely. Each account's `id` is what " +
    "versely_publish_post and versely_preview_post take in account_ids. If an account the user just " +
    "connected is missing, call versely_refresh_social_accounts first.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const data = await ctx.client.get<{ accounts?: unknown[] }>("/api/v1/social/accounts");
    if (Array.isArray(data?.accounts) && data.accounts.length === 0) {
      return jsonResult({
        ...data,
        note: "No social accounts are connected. Use versely_get_social_auth_url to get a connect link.",
      });
    }
    return jsonResult(data);
  },
});

const versely_refresh_social_accounts = defineTool({
  name: "versely_refresh_social_accounts",
  description:
    "Link social accounts the user just connected through a connect link to their Versely account, and " +
    "update the names and pictures of the ones already connected. Call it after the user finishes a connect link.",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const data = await ctx.client.post("/api/v1/social/accounts/refresh", {});
    return jsonResult(data);
  },
});

const versely_disconnect_social_account = defineTool({
  name: "versely_disconnect_social_account",
  description:
    "Disconnect one of the user's social accounts from Versely (by its `id` from versely_list_social_accounts). " +
    "Scheduled posts to it will fail. It can be connected again later with a new connect link.",
  inputSchema: z.object({
    account_id: z.string().describe("The account's `id` from versely_list_social_accounts."),
  }),
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
    "Preview how a post will look on each chosen account, without publishing or charging credits. " +
    "Needs a caption or at least one media URL.",
  inputSchema: z
    .object({
      caption: z.string().optional().describe("Required unless media_urls is provided."),
      media_urls: z.array(z.string().url()).optional().describe("Public https URLs of the images or video to post."),
      account_ids: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Connected account ids to preview for. Required — from versely_list_social_accounts."),
      tiktok_draft: z.boolean().optional().describe("Preview TikTok as a draft sent to the TikTok app."),
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
    "Publish a post (caption plus images or a video) to one or more of the user's connected social " +
    "accounts, now or at a scheduled time. Confirm the caption, media and accounts with the user first. " +
    "Charges Versely credits per account posted to (currently 1 each; the result says how many). " +
    `${MEDIA_RULES} A scheduled post can be moved with versely_update_post, or cancelled for a refund ` +
    "with versely_delete_post before it goes out. Follow up with versely_get_post for the live links.",
  inputSchema: z
    .object({
      caption: z.string().min(1).describe("Post caption. Required."),
      media_urls: z
        .array(z.string().url())
        .optional()
        .describe("Public https URLs of the images or video to post (Versely URLs from earlier results work)."),
      account_ids: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Connected account ids to publish to. Required — from versely_list_social_accounts."),
      scheduled_at: z
        .string()
        .optional()
        .describe("Future ISO-8601 time to publish at, with a timezone offset. Omit to publish now."),
      is_draft: z
        .boolean()
        .optional()
        .describe("Save as a draft in Versely instead of publishing (no charge)."),
      tiktok_draft: z
        .boolean()
        .optional()
        .describe("Send TikTok posts to the TikTok app's drafts for the user to finish there, instead of posting live."),
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
    const data = await ctx.client.post<{ post?: Record<string, unknown> }>("/api/v1/social/posts", body);
    // The response's post.id is Post for Me's id, but versely_get_post,
    // update_post and delete_post take Versely's own id: look it up by the
    // provider id so the next call works.
    const externalId = data?.post?.id;
    if (typeof externalId === "string" && externalId) {
      try {
        const recent = await ctx.client.get<{ posts?: Array<Record<string, unknown>> }>(
          "/api/v1/social/posts",
          { query: { limit: 10, offset: 0 } },
        );
        const row = recent?.posts?.find((p) => p?.external_post_id === externalId);
        if (row && typeof row.id === "string") {
          return jsonResult({ ...data, post_id: row.id, post: { ...data.post, id: row.id, external_post_id: externalId } });
        }
      } catch {
        /* the post went out; only the id lookup failed */
      }
    }
    return jsonResult(data);
  },
});

const versely_list_posts = defineTool({
  name: "versely_list_posts",
  description:
    "List the user's social posts, newest first, with their status (draft, scheduled, processing, posted, " +
    "partial, failed). Note: `platform` is filtered within the fetched page only — widen `limit` if you filter.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How many to skip (default 0). Use for paging, not `page`."),
    platform: PlatformSchema.optional().describe(
      "Optional filter on the returned page.",
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
      const wanted = new Set(
        input.platform === "twitter" || input.platform === "x"
          ? ["x", "twitter"]
          : [String(input.platform).toLowerCase()],
      );
      const posts = data.posts.filter((p) => {
        const platforms = p?.platforms;
        return (
          Array.isArray(platforms) &&
          platforms.some((x) => wanted.has(String(x).toLowerCase()))
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
    "Get one of the user's social posts: its status, per-platform results and the live links once published " +
    "(`post_urls`).",
  inputSchema: z.object({ post_id: z.string().describe("The post's id from versely_list_posts.") }),
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

const versely_update_post = defineTool({
  name: "versely_update_post",
  description:
    "Move a scheduled post to a new time and/or change its caption, without charging again. Only posts " +
    "that are still scheduled (or drafts, caption only) can be changed.",
  inputSchema: z.object({
    post_id: z.string().describe("The post's id from versely_list_posts."),
    scheduled_at: z
      .string()
      .optional()
      .describe("New future ISO-8601 time, with a timezone offset."),
    caption: z.string().min(1).optional().describe("New caption."),
  }),
  handler: async (input, ctx) => {
    if (input.scheduled_at === undefined && input.caption === undefined) {
      throw new Error("Pass scheduled_at and/or caption: there is nothing to change.");
    }
    const data = await ctx.client.patch(`/api/v1/social/posts/${encodeURIComponent(input.post_id)}`, {
      ...(input.scheduled_at !== undefined ? { scheduled_at: input.scheduled_at } : {}),
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
    });
    return jsonResult(data);
  },
});

const versely_delete_post = defineTool({
  name: "versely_delete_post",
  description:
    "Delete one of the user's social posts from Versely. A post that is still scheduled is cancelled before " +
    "it goes out and its credits are refunded (`refunded`). A post that was already published stays live on " +
    "the platform.",
  inputSchema: z.object({
    post_id: z.string().describe("The post's id from versely_list_posts."),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(`/api/v1/social/posts/${encodeURIComponent(input.post_id)}`);
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
  versely_update_post,
  versely_delete_post,
];
