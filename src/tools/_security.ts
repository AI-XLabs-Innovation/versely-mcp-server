// Per-tool auth, as ChatGPT reads it (developers.openai.com/plugins/build/auth).
//
// Every tool needs an OAuth 2.0 token, so every descriptor says so with
// `securitySchemes` (and the same array under `_meta`, the back-compat mirror
// for clients that only read `_meta`). The scope named is the one that best
// describes what the tool does. Versely's authorization server grants the full
// scope set to every connection (a client that names none gets all of them),
// so this is disclosure for the consent screen, not a gate: the token is
// checked on every call either way.
//
// When the backend refuses the token mid-session (expired, revoked), the error
// result carries `_meta["mcp/www_authenticate"]`: that challenge is what makes
// ChatGPT show its "sign in again" UI instead of a dead error.

import type { ToolClass } from "./_policy.js";

export const OAUTH_SCOPES = ["generate", "post", "manage_accounts", "slideshow", "ugc", "workflows", "analytics", "read"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export interface SecurityScheme {
  type: "oauth2";
  scopes: OAuthScope[];
}

/** Checked in order: the first match wins. */
const RULES: ReadonlyArray<readonly [RegExp, OAuthScope, "any" | "write"]> = [
  [/analytics/, "analytics", "any"],
  [/_social_auth_url$|_social_accounts?$/, "manage_accounts", "write"],
  [/_(preview|publish|update|delete)_post$|_schedule_hook_collection$/, "post", "write"],
  [/workflow|automation/, "workflows", "write"],
  [/slideshow|_slides?_|_text_overlay$|_caption_style$/, "slideshow", "write"],
  [/ugc|_video_overlay$|_compose_with_overlay$|_captions$/, "ugc", "write"],
];

export function scopeFor(name: string, cls: ToolClass): OAuthScope {
  for (const [re, scope, when] of RULES) {
    if (!re.test(name)) continue;
    if (when === "write" && cls === "read") break;
    return scope;
  }
  return cls === "read" ? "read" : "generate";
}

export function securitySchemesFor(name: string, cls: ToolClass): SecurityScheme[] {
  return [{ type: "oauth2", scopes: [scopeFor(name, cls)] }];
}

export const WWW_AUTHENTICATE_META = "mcp/www_authenticate";

/**
 * The directory plugin's own endpoint (the URL in openai/mcp.json).
 *
 * ChatGPT and Codex share one plugin directory. ChatGPT's tokens carry the
 * signed `ck: "openai"` claim, so on /mcp it already gets the openai profile.
 * Codex signs in from the user's own machine (a loopback redirect), so its
 * token looks like any other desktop client's and /mcp would serve it the full
 * catalog, checkout tools included. Everything that arrives on this path is
 * served the openai profile, whoever it is.
 */
export const OPENAI_MCP_PATH = "/mcp/openai";

/** True for the plugin endpoint, with or without a trailing slash. */
export function isOpenaiPath(path: string): boolean {
  return path.replace(/\/+$/, "") === OPENAI_MCP_PATH;
}

/**
 * The plugin endpoint's own resource identifier (RFC 9728 wants the metadata's
 * `resource` to be the URL the client connected to). The authorization server
 * accepts it next to the canonical one and still mints canonical-audience
 * tokens, so one token works on both paths.
 */
export function openaiResourceUrl(resourceUrl: string): string {
  return `${new URL(resourceUrl).origin}${OPENAI_MCP_PATH}`;
}

/** Where the protected-resource metadata lives for a connection on this path. */
export function resourceMetadataUrl(resourceUrl: string, openaiPath = false): string {
  const base = `${new URL(resourceUrl).origin}/.well-known/oauth-protected-resource`;
  return openaiPath ? `${base}${OPENAI_MCP_PATH}` : base;
}

/** RFC 7235 challenge for a token the backend no longer accepts. */
export function tokenChallenge(resourceUrl: string, openaiPath = false): string {
  return (
    `Bearer resource_metadata="${resourceMetadataUrl(resourceUrl, openaiPath)}", error="invalid_token", ` +
    `error_description="Your Versely sign-in has expired or was revoked. Sign in again to continue."`
  );
}
