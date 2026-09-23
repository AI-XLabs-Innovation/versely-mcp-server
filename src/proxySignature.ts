import crypto from "node:crypto";

/**
 * X-Versely-Proxy: proof, for the backend, that a request came THROUGH this
 * MCP server (cross-repo contract 2; verified by content-creation-backend's
 * lib/mcpProxy.ts).
 *
 *   K   = HKDF-SHA256(ikm = utf8(OAUTH_JWT_SECRET), salt = empty,
 *                     info = "versely-mcp-proxy-v1", 32 bytes)
 *   sig = hex(HMAC-SHA256(K, "v1." + ts + "." + subject))
 *   header value = "v1.<ts>.<sig>"
 *
 * `subject` is the exact X-Versely-OpenAI-Subject value sent alongside, or ""
 * when that header is omitted — signing it means ChatGPT's user id can't be
 * swapped in transit. The secret is the one both servers already share for
 * OAuth access tokens; HKDF with a purpose label keeps this key distinct from
 * the token-signing key. With no secret configured, no header is sent and the
 * backend trusts nothing.
 */

const HKDF_INFO = "versely-mcp-proxy-v1";

export function mcpProxyKeyFromSecret(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), HKDF_INFO, 32),
  );
}

export function signMcpProxy(key: Buffer, ts: number, subject: string): string {
  const sig = crypto.createHmac("sha256", key).update(`v1.${ts}.${subject}`).digest("hex");
  return `v1.${ts}.${sig}`;
}

// HKDF once per secret, not once per request.
let memo: { secret: string; key: Buffer } | null = null;

/** Header value for "now", or undefined when no secret is configured. */
export function proxyHeaderValue(
  secret: string | null | undefined,
  subject: string,
  nowS: number = Math.floor(Date.now() / 1000),
): string | undefined {
  if (!secret) return undefined;
  if (!memo || memo.secret !== secret) memo = { secret, key: mcpProxyKeyFromSecret(secret) };
  return signMcpProxy(memo.key, nowS, subject);
}
