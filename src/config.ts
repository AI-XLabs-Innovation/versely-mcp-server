import { VerselyConfigError } from "./errors.js";

export interface Config {
  apiUrl: string;
  defaultPollTimeoutMs: number;
  defaultPollIntervalMs: number;
  userAgent: string;
  httpPort: number;
  httpHost: string;
  // OAuth resource server settings. The MCP server validates JWT access tokens
  // (issued by the backend) without phoning home, so it needs the shared HS256
  // secret and the expected audience.
  oauthJwtSecret: string | null;
  oauthIssuer: string;
  resourceUrl: string;          // canonical URL of this resource (audience claim)
  authServerUrl: string;        // base URL of the OAuth authorization server
  /**
   * Kill switch for the MCP Apps media cards (MCP_DISABLE_APPS_UI=1).
   *
   * claude.ai's connector proxy 405s the client's capability-refresh GET
   * before it reaches this server (anthropics/claude-code#78193). When that
   * lands, claude.ai marks the connector's capabilities dead and every
   * *interactive* tool result — even ones answered 200 — renders as an
   * "Unable to reach versely-mcp" error chip, because the card iframe can't
   * hydrate. Plain (non-interactive) results keep rendering through the same
   * outage. This flag strips the ui declarations so results degrade to the
   * ordinary render path until Anthropic fixes the client.
   */
  disableAppsUi: boolean;
}

export const SERVER_NAME = "versely-mcp";
export const SERVER_VERSION = "0.1.0";

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const rawUrl = process.env.VERSELY_API_URL?.trim() || "https://api.versely.studio";
  const apiUrl = stripTrailingSlash(rawUrl);
  if (!isValidHttpUrl(apiUrl)) {
    throw new VerselyConfigError(
      `VERSELY_API_URL must be a valid http(s) URL. Got: ${rawUrl}`,
    );
  }

  // 70s, not the 180s this used to default to. Blocking polls run through a
  // Cloudflare proxy that severs any request at ~100s, and the client reports
  // that as "unable to reach the server" — so a 180s budget could never be
  // spent, it just guaranteed a confusing failure for any job over 100s.
  // pollStatus clamps to MAX_BLOCKING_POLL_MS regardless of what's set here.
  const defaultPollTimeoutMs = parsePositiveInt("VERSELY_DEFAULT_POLL_TIMEOUT_MS", 70_000);
  const defaultPollIntervalMs = parsePositiveInt("VERSELY_DEFAULT_POLL_INTERVAL_MS", 3_000);
  if (defaultPollIntervalMs > defaultPollTimeoutMs) {
    throw new VerselyConfigError(
      "VERSELY_DEFAULT_POLL_INTERVAL_MS must be <= VERSELY_DEFAULT_POLL_TIMEOUT_MS.",
    );
  }

  const httpPort = parsePositiveInt("MCP_HTTP_PORT", 8080);
  if (httpPort > 65535) {
    throw new VerselyConfigError(`MCP_HTTP_PORT must be 1-65535. Got: ${httpPort}`);
  }
  const httpHost = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";

  const oauthJwtSecret = process.env.OAUTH_JWT_SECRET?.trim() || null;
  if (oauthJwtSecret !== null && oauthJwtSecret.length < 32) {
    throw new VerselyConfigError("OAUTH_JWT_SECRET must be at least 32 characters when set.");
  }
  const oauthIssuer = stripTrailingSlash(process.env.OAUTH_ISSUER?.trim() || apiUrl);
  const resourceUrl = stripTrailingSlash(
    process.env.MCP_RESOURCE_URL?.trim() || "https://mcp.versely.studio/mcp",
  );
  const authServerUrl = stripTrailingSlash(
    process.env.OAUTH_AUTH_SERVER_URL?.trim() || apiUrl,
  );

  cached = {
    apiUrl,
    defaultPollTimeoutMs,
    defaultPollIntervalMs,
    httpPort,
    httpHost,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION} (+https://versely.studio)`,
    oauthJwtSecret,
    oauthIssuer,
    resourceUrl,
    authServerUrl,
    disableAppsUi: parseBool("MCP_DISABLE_APPS_UI"),
  };
  return cached;
}

export function resetConfigForTesting(): void {
  cached = null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseBool(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new VerselyConfigError(`${name} must be a positive integer; got "${raw}".`);
  }
  return n;
}
