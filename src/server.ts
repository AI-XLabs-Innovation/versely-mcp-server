import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { SERVER_NAME, SERVER_VERSION, type Config } from "./config.js";
import type { VerselyClient } from "./client.js";
import { ToolRegistry } from "./tools/_registry.js";
import { allToolDefinitions, registeredTools } from "./tools/index.js";
import { errorResult, formatErr } from "./tools/_helpers.js";
import type { Tool, ToolContext, ToolResult } from "./tools/_types.js";
import { assertPolicyCoverage, getToolPolicy, type ToolPolicy } from "./tools/_policy.js";
import {
  CONFIRM_REPEAT_KEY,
  OPENAI_STRIPPED_INPUTS,
  applyCardSafetyNet,
  applyParamDescriptions,
  dropDeprecatedProperties,
  hideProperties,
  injectConfirmRepeat,
  omitKeys,
  shapeResultForOpenai,
  stripSafetyKeys,
} from "./tools/_shaping.js";
import { UI_MIME_TYPE, uiResourcesFor } from "./ui/templates.js";
import { serverInstructions, type Profile } from "./profiles.js";
import { runWithCallContext, subjectFromMeta } from "./requestContext.js";
import { dedupeKey, dedupeNote, duplicateCallGuard } from "./idempotency.js";

/** Display name hosts show for this server (MCP Implementation.title). */
export const SERVER_TITLE = "Versely";

export interface ServerOptions {
  /** Tool profile the caller resolved to (see profiles.ts). */
  profile: Profile;
  /**
   * sha256 of the caller's identity (JWT `sub`, or the vsk_ key). Scopes the
   * duplicate-call guard so identical requests from different users never
   * share a result.
   */
  ownerKey: string;
}

// --- Registry ------------------------------------------------------------------
// Built lazily from config rather than at import time: the bundle runs module
// bodies before index.ts loads .env, so an env-gated tool list read here at
// import would ignore .env entirely.

let registryMemo: { debug: boolean; registry: ToolRegistry } | null = null;

function getRegistry(config: Config): ToolRegistry {
  if (registryMemo && registryMemo.debug === config.enableDebugTools) return registryMemo.registry;
  // Refuse to start with a tool the policy table doesn't describe: every tool
  // needs a title and reviewed annotations before any host sees it.
  assertPolicyCoverage(allToolDefinitions.map((t) => t.name));
  const registry = new ToolRegistry();
  registry.registerMany(registeredTools({ enableDebugTools: config.enableDebugTools }));
  registryMemo = { debug: config.enableDebugTools, registry };
  return registry;
}

// --- Per-profile catalog ---------------------------------------------------------
// Everything a profile's tools/list and tools/call need, computed once per
// profile and reused by every session — this used to re-run zodToJsonSchema
// for all ~90 tools on every tools/list.

type Json = Record<string, unknown>;

/** Status tools the media card calls from inside the host to follow a job. */
export const CARD_POLL_TARGETS: ReadonlySet<string> = new Set([
  "versely_get_task_status",
  "versely_get_movie_status",
  "versely_get_workflow_run",
  "versely_get_video_workflow_run",
  "versely_get_dub",
]);

interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; [k: string]: unknown };
  annotations: Json;
  _meta?: Json;
}

interface ProfileTool {
  name: string;
  policy: ToolPolicy;
  inputSchema: z.ZodTypeAny;
  handler: (input: any, ctx: ToolContext) => Promise<ToolResult>;
  /** Top-level argument keys removed before parsing (their defaults apply). */
  stripKeys: ReadonlySet<string>;
  /** Guarded against duplicate calls (idempotency.ts). */
  dedupe: boolean;
  /** Declares the media card, so every result must carry card state. */
  isCard: boolean;
  listed: ListedTool;
}

export interface ProfileCatalog {
  tools: ReadonlyMap<string, ProfileTool>;
  listed: readonly ListedTool[];
}

const catalogMemo = new WeakMap<Config, Map<Profile, ProfileCatalog>>();

function hasCardMeta(meta: Json | undefined): boolean {
  const ui = meta?.ui as Json | undefined;
  return typeof ui?.resourceUri === "string";
}

function buildProfileTool(tool: Tool, profile: Profile, config: Config): ProfileTool {
  const policy = getToolPolicy(tool.name)!; // guaranteed by assertPolicyCoverage
  const variant = profile === "openai" ? tool.openai : undefined;
  if (variant?.inputSchema && !variant.handler) {
    throw new Error(`${tool.name}: the openai variant replaces the input schema but not the handler`);
  }
  const inputSchema = variant?.inputSchema ?? tool.inputSchema;
  const handler = variant?.handler ?? tool.handler;

  const schema = zodToJsonSchema(inputSchema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Json;

  const hidden: string[] = [];
  if (profile === "openai") {
    const props = (schema.properties ?? {}) as Json;
    for (const key of variant?.hide ?? []) {
      if (!(key in props)) throw new Error(`${tool.name}: openai hides unknown input "${key}"`);
    }
    hidden.push(...OPENAI_STRIPPED_INPUTS, ...(variant?.hide ?? []));
    hideProperties(schema, hidden);
    dropDeprecatedProperties(schema);
  }
  applyParamDescriptions(schema, variant?.params, tool.name);

  const dedupe = policy.class === "create" && config.dedupeProfiles.has(profile);
  if (dedupe) injectConfirmRepeat(schema);

  const appsUi = !config.disableAppsUi;
  const isCard = appsUi && hasCardMeta(tool.meta);
  // Tool _meta.ui stays exactly { resourceUri, visibility } (claude.ai flags
  // anything more as malformed). ChatGPT's status strings are top-level
  // _meta keys and only ever sent to the openai profile.
  const meta: Json = {
    ...(appsUi && tool.meta ? tool.meta : {}),
    ...(profile === "openai" && policy.invoking
      ? { "openai/toolInvocation/invoking": policy.invoking }
      : {}),
    ...(profile === "openai" && policy.invoked
      ? { "openai/toolInvocation/invoked": policy.invoked }
      : {}),
  };
  // The tools the media card polls from inside ChatGPT. ChatGPT only lets a
  // widget call a tool that is explicitly open to it: say so both ways - the
  // MCP Apps visibility list and ChatGPT's own widgetAccessible flag - or the
  // card's polls are refused and it spins on "Generating" forever.
  if (profile === "openai" && appsUi && CARD_POLL_TARGETS.has(tool.name)) {
    const ui = (meta.ui && typeof meta.ui === "object" ? (meta.ui as Json) : {}) as Json;
    meta.ui = { ...ui, visibility: ["model", "app"] };
    meta["openai/widgetAccessible"] = true;
  }

  return {
    name: tool.name,
    policy,
    inputSchema,
    handler,
    stripKeys: new Set([CONFIRM_REPEAT_KEY, ...hidden]),
    dedupe,
    isCard,
    listed: {
      name: tool.name,
      title: policy.title,
      description: variant?.description ?? tool.description,
      inputSchema: schema as ListedTool["inputSchema"],
      annotations: { title: policy.title, ...policy.annotations },
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    },
  };
}

export function getProfileCatalog(config: Config, profile: Profile): ProfileCatalog {
  let byProfile = catalogMemo.get(config);
  if (!byProfile) {
    byProfile = new Map();
    catalogMemo.set(config, byProfile);
  }
  const memo = byProfile.get(profile);
  if (memo) return memo;

  const tools = new Map<string, ProfileTool>();
  for (const tool of getRegistry(config).list()) {
    if (!getToolPolicy(tool.name)!.profiles.includes(profile)) continue;
    tools.set(tool.name, buildProfileTool(tool, profile, config));
  }
  const catalog: ProfileCatalog = { tools, listed: [...tools.values()].map((t) => t.listed) };
  byProfile.set(profile, catalog);
  return catalog;
}

export function getRegisteredToolCount(config: Config, profile: Profile = "full"): number {
  return getProfileCatalog(config, profile).listed.length;
}

/**
 * Build every profile's catalog now, so a broken policy row, variant or
 * description override fails the process at startup instead of the first
 * tools/list a user sends.
 */
export function validateServerSetup(config: Config): Record<Profile, number> {
  return {
    full: getRegisteredToolCount(config, "full"),
    openai: getRegisteredToolCount(config, "openai"),
  };
}

// --- Server ------------------------------------------------------------------------

/**
 * Build a fresh MCP `Server` wired to a request-scoped Versely client.
 * Each session (or one-shot request) constructs its own server (cheap — the
 * per-profile catalog is shared) so the per-user bearer stays scoped to it.
 */
export function buildServer(config: Config, client: VerselyClient, opts: ServerOptions): Server {
  const { profile, ownerKey } = opts;
  const catalog = getProfileCatalog(config, profile);

  // MCP Apps extension capability. claude.ai's initialize advertises
  // `capabilities.extensions["io.modelcontextprotocol/ui"]`; servers must
  // echo a matching declaration on the same path or the host treats `ui://`
  // entries in resources/list as ordinary resources and never calls
  // resources/read to fetch the iframe HTML. `extensions` is a typed key in
  // ServerCapabilitiesSchema (Record<string, object>), so the namespaced
  // sub-key passes through verbatim.
  // MCP_DISABLE_APPS_UI: strip every Apps surface (extension capability,
  // tool _meta.ui, ui:// resources) so hosts treat all tools as ordinary
  // non-interactive tools. See Config.disableAppsUi for why this exists.
  const appsUi = !config.disableAppsUi;
  const instructions = serverInstructions(profile);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE },
    {
      capabilities: {
        tools: {},
        resources: {},
        ...(appsUi
          ? {
              extensions: {
                "io.modelcontextprotocol/ui": {
                  mimeTypes: [UI_MIME_TYPE],
                },
              },
            }
          : {}),
      },
      ...(instructions ? { instructions } : {}),
    },
  );

  // MCP Apps (SEP-1865): tools that declare a UI template carry `_meta.ui`
  // so the host can fetch the linked `ui://` resource and render it inline.
  // Hosts without MCP Apps support ignore it.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.listed as ListedTool[],
  }));

  async function callTool(entry: ProfileTool, rawArgs: unknown, requestMeta: unknown): Promise<ToolResult> {
    // Safety switches never reach a handler (or a .passthrough() body), in
    // any profile; hidden inputs are dropped so their defaults apply.
    const cleaned = stripSafetyKeys(rawArgs ?? {}) as Json;
    const confirmRepeat = cleaned[CONFIRM_REPEAT_KEY] === true;
    const args = omitKeys(cleaned, entry.stripKeys);

    let result: ToolResult;
    const parsed = entry.inputSchema.safeParse(args);
    if (!parsed.success) {
      result = errorResult(
        `Invalid arguments for ${entry.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      );
    } else {
      const subject = subjectFromMeta(requestMeta);
      const ctx: ToolContext = { client, config, profile };
      const run = () =>
        runWithCallContext({ profile, ...(subject ? { subject } : {}) }, async () => {
          try {
            // ToolResult.structuredContent flows through unchanged — the SDK's
            // CallToolResult schema accepts it natively, and MCP Apps-capable
            // hosts hydrate the linked ui:// iframe with that payload.
            return await entry.handler(parsed.data, ctx);
          } catch (err) {
            return errorResult(formatErr(err));
          }
        });

      if (entry.dedupe && !confirmRepeat) {
        const key = dedupeKey(ownerKey, entry.name, parsed.data as Json);
        const outcome = await duplicateCallGuard.run(key, run);
        result =
          outcome.reusedAgeMs !== undefined && !outcome.result.isError
            ? {
                ...outcome.result,
                content: [{ type: "text", text: dedupeNote(outcome.reusedAgeMs) }, ...outcome.result.content],
              }
            : outcome.result;
      } else {
        result = await run();
      }
    }

    if (entry.isCard) result = applyCardSafetyNet(result);
    if (profile === "openai") result = shapeResultForOpenai(result);
    return result;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args, _meta } = request.params;
    const entry = catalog.tools.get(name);
    if (!entry) {
      // Tools outside the caller's profile are indistinguishable from
      // tools that don't exist: a ChatGPT token can't reach social posting
      // just by knowing the name.
      return errorResult(`Unknown tool: ${name}`) as CallToolResult;
    }
    return (await callTool(entry, args, _meta)) as CallToolResult;
  });

  // MCP Apps: expose `ui://` resources as a discoverable list. Hosts call
  // resources/list during initialization, then resources/read on the URI
  // declared in a tool's `_meta.ui.resourceUri`. The resource's own _meta
  // carries `ui.csp` (and, for the openai profile, `ui.domain` +
  // `ui.prefersBorder`) per spec.
  const resources = uiResourcesFor({ profile, cardV2: config.cardV2Profiles.has(profile) });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: (appsUi ? resources : []).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: UI_MIME_TYPE,
      _meta: r.meta,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const resource = resources.find((r) => r.uri === uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: UI_MIME_TYPE,
          text: resource.html,
          _meta: resource.meta,
        },
      ],
    };
  });

  return server;
}
