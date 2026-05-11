import crypto from "node:crypto";

/**
 * HS256 JWT verifier — matches the signer in content-creation-backend/src/lib/oauthJwt.ts.
 * Self-contained so we don't pull in jsonwebtoken just for verification.
 */

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function hmacSha256(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  azp: string;
  scope: string;
  exp: number;
  iat: number;
  jti: string;
  token_use?: "access";
}

export interface VerifyOptions {
  secret: string;
  audience: string;
  issuer?: string;
}

export function verifyAccessToken(token: string, opts: VerifyOptions): AccessTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_jwt");
  const [headerSeg, payloadSeg, sig] = parts as [string, string, string];

  const expectedSig = hmacSha256(opts.secret, `${headerSeg}.${payloadSeg}`);
  if (!timingSafeEqual(sig, expectedSig)) throw new Error("bad_signature");

  const header = JSON.parse(fromB64url(headerSeg).toString("utf-8"));
  if (header.alg !== "HS256") throw new Error("unexpected_alg");

  const claims = JSON.parse(fromB64url(payloadSeg).toString("utf-8")) as AccessTokenClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) throw new Error("token_expired");
  if (claims.aud !== opts.audience) throw new Error("bad_audience");
  if (opts.issuer && claims.iss !== opts.issuer) throw new Error("bad_issuer");

  return claims;
}

/**
 * A JWT has three dot-separated base64url segments. `vsk_` keys never look like
 * that, so this cheap shape check lets us dispatch tokens to the right validator
 * without ambiguity.
 */
export function looksLikeJwt(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p) && p.length > 0);
}
