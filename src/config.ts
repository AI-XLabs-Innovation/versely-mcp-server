import { VerselyConfigError } from "./errors.js";

export interface Config {
  apiUrl: string;
  defaultPollTimeoutMs: number;
  defaultPollIntervalMs: number;
  userAgent: string;
  httpPort: number;
  httpHost: string;
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

  const defaultPollTimeoutMs = parsePositiveInt("VERSELY_DEFAULT_POLL_TIMEOUT_MS", 180_000);
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

  cached = {
    apiUrl,
    defaultPollTimeoutMs,
    defaultPollIntervalMs,
    httpPort,
    httpHost,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION} (+https://versely.studio)`,
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

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new VerselyConfigError(`${name} must be a positive integer; got "${raw}".`);
  }
  return n;
}
