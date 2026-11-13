// Fetching a file from a URL somebody handed us (versely_upload_media).
//
// The URL comes from a user or an assistant, and this server runs inside our
// network, so a careless fetch is a way to read things only we can reach
// (cloud metadata, localhost admin ports, private services). Every hop is
// therefore held to: https only, no credentials in the URL, the default port,
// and an address that is public - checked on the address the socket actually
// connects to (the agent's own lookup), so a name that resolves to a private
// address, or changes its answer between a check and the connect, is refused
// too. Redirects are followed by hand, each hop checked the same way.

import dns from "node:dns";
import net from "node:net";
import { Agent, fetch, type Response } from "undici";

const MAX_REDIRECTS = 4;

/**
 * Smoke tests fetch from the in-process fake backend on 127.0.0.1 over http.
 * Nothing but this exact value opens that door, and it is never set in a
 * deployment (see scripts/smoke-test.ts).
 */
function localFetchAllowed(): boolean {
  return process.env.MCP_UPLOAD_FETCH_GUARD === "off-for-smoke-test";
}

function ipv4IsPublic(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 and 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // documentation
  if (a === 203 && b === 0) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** True only for an address on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return ipv4IsPublic(ip);
  if (family !== 6) return false;
  const lower = ip.toLowerCase();
  // IPv4 carried in IPv6: judge the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4IsPublic(mapped[1]!);
  // Global unicast is 2000::/3. Everything else (loopback, unique local,
  // link-local, multicast, NAT64, unspecified) is refused.
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return false;
  if (lower.startsWith("2001:db8")) return false; // documentation
  return true;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

/** dns.lookup that refuses any answer holding a non-public address. */
function guardedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  dns.lookup(hostname, options as dns.LookupOptions, ((err: NodeJS.ErrnoException | null, address: unknown, family?: number) => {
    if (err) return callback(err);
    const addresses = Array.isArray(address) ? address.map((a) => (a as { address: string }).address) : [String(address)];
    if (!localFetchAllowed() && addresses.some((a) => !isPublicAddress(a))) {
      return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: "EUNSAFEADDRESS" }));
    }
    callback(null, address, family);
  }) as never);
}

let agent: Agent | undefined;
function guardedAgent(): Agent {
  agent ??= new Agent({ connect: { lookup: guardedLookup as never }, connections: 4 });
  return agent;
}

/** Null when the URL may be fetched; otherwise why not, in words a user can act on. */
export function unsafeUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a valid link.";
  }
  const local = localFetchAllowed();
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "The link must start with https://.";
  if (url.username || url.password) return "The link must not carry a username or password.";
  if (!local && url.port && url.port !== "443") return "The link must use the standard https port.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return "That is not a valid link.";
  if (net.isIP(host)) {
    if (!local && !isPublicAddress(host)) return "That link points to a private address.";
  } else if (!local && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes("."))) {
    return "That link points to a private address.";
  }
  return null;
}

/**
 * GET a user-supplied URL, following up to MAX_REDIRECTS redirects, every hop
 * checked. The caller reads (and bounds) the body.
 */
export async function guardedGet(raw: string, signal: AbortSignal): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const reason = unsafeUrlReason(current);
    if (reason) throw new UnsafeUrlError(reason);
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal, dispatcher: guardedAgent(), headers: { accept: "*/*" } });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } })?.cause;
      if (cause?.code === "EUNSAFEADDRESS") throw new UnsafeUrlError("That link points to a private address.");
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!next) throw new UnsafeUrlError("The link redirects nowhere.");
      current = new URL(next, current).toString();
      continue;
    }
    return res;
  }
  throw new UnsafeUrlError("The link redirects too many times.");
}
