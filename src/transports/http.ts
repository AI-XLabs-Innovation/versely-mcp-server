import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  SERVER_NAME,
  SERVER_VERSION,
  type Config,
} from "../config.js";
import { VerselyClient, isValidApiKeyFormat } from "../client.js";
import { buildServer, getRegisteredToolCount, validateServerSetup } from "../server.js";
import { verifyAccessToken, looksLikeJwt } from "../oauth.js";
import { resolveProfile, type Profile } from "../profiles.js";
import { OPENAI_APPS_CHALLENGE_TOKEN } from "../openaiChallenge.js";

const PROCESS_START_MS = Date.now();

/** Public repo documenting this server (RFC 9728 resource_documentation). */
const DOCS_URL = "https://github.com/AI-XLabs-Innovation/versely-mcp-server";

interface AuthedRequest extends Request {
  /** The bearer to forward to api.versely.studio. Either a `vsk_*` key or an OAuth JWT. */
  apiKey?: string;
  /** When the bearer is an OAuth JWT, the verified claims. */
  oauthClaims?: { sub: string; scope: string; azp: string; ck?: string };
  /** Tool profile for this request (see profiles.ts). Set by the bearer gate. */
  profile?: Profile;
}

interface ResLocals {
  requestId: string;
}

function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

function logLine(record: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
}

// --- Request recorder --------------------------------------------------------
// Every "Unable to reach versely-mcp" report so far has been diagnosed by
// guesswork, because the one fact that splits the problem in half was never
// available: DID THE REQUEST EVEN ARRIVE?
//
//   arrived + 200  -> the server did its job; the client discarded the answer
//   arrived + 4xx/5xx -> ours, and the record says exactly why
//   never arrived  -> nothing server-side can fix it
//
// stderr already logs this, but reading it needs SSH into the box. This keeps
// the last N in memory and serves them over HTTP so a failure can be inspected
// within seconds of happening. Bounded, no bodies, no tokens — safe to leave on.

interface McpCallRecord {
  ts: string;
  request_id: string;
  /** JSON-RPC method claude.ai asked for (initialize / tools/call / ...). */
  rpc_method?: string;
  /** Tool name when rpc_method is tools/call — the thing that actually failed. */
  tool?: string;
  status: number;
  duration_ms: number;
  /** How the caller authenticated. Never the token itself. */
  auth: "api_key" | "oauth_jwt" | "none" | "invalid";
  /** Tool profile the call was served under. */
  profile?: Profile;
  accept?: string;
  user_agent?: string;
  /**
   * Any Mcp-Session-Id on the request. Sessions are now real (initialize
   * mints one), so this shows which calls rode an existing session versus
   * re-initialized from scratch — the churn that made claude.ai's broken
   * capability-refresh path fire on every single call.
   */
  session_id?: string;
  error?: string;
}

const MCP_CALL_LOG_MAX = 100;
const mcpCallLog: McpCallRecord[] = [];

function recordMcpCall(rec: McpCallRecord): void {
  mcpCallLog.push(rec);
  if (mcpCallLog.length > MCP_CALL_LOG_MAX) mcpCallLog.shift();
}

/** Pull the JSON-RPC method / tool name out of a request body, batch or single. */
function describeRpc(body: unknown): { rpc_method?: string; tool?: string } {
  const one = Array.isArray(body) ? body[0] : body;
  if (!one || typeof one !== "object") return {};
  const o = one as Record<string, unknown>;
  const rpc_method = typeof o.method === "string" ? o.method : undefined;
  const params = o.params as Record<string, unknown> | undefined;
  const tool =
    rpc_method === "tools/call" && params && typeof params.name === "string"
      ? params.name
      : undefined;
  return { ...(rpc_method ? { rpc_method } : {}), ...(tool ? { tool } : {}) };
}

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestId = newRequestId();
  (res.locals as Partial<ResLocals>).requestId = requestId;
  res.setHeader("x-mcp-request-id", requestId);
  res.on("finish", () => {
    logLine({
      level: "info",
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      remote_ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
        req.ip ??
        undefined,
    });
  });
  next();
}

/**
 * What the request asked for: `?profile=` and/or `X-Versely-Profile`. Only
 * ever used to NARROW to the openai profile (resolveProfile) — it can't widen
 * a ChatGPT token's profile, whose `ck` claim decides on its own.
 */
function requestedProfile(req: Request): string[] {
  const out: string[] = [];
  const q = req.query.profile;
  if (typeof q === "string") out.push(q);
  else if (Array.isArray(q)) for (const v of q) if (typeof v === "string") out.push(v);
  const h = req.header("x-versely-profile");
  if (h) out.push(h);
  return out;
}

function makeAuthMiddleware(config: Config) {
  // Per RFC 9728: 401 responses on protected resources must include a
  // WWW-Authenticate header pointing clients at our protected-resource metadata
  // so they can discover the authorization server and start an OAuth flow.
  // mcp.versely.studio/.well-known/oauth-protected-resource is served below.
  const resourceMetadataUrl = `${new URL(config.resourceUrl).origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer realm="versely-mcp", resource_metadata="${resourceMetadataUrl}"`;

  return function requireBearer(req: AuthedRequest, res: Response, next: NextFunction): void {
    // Once the bearer is verified: decide the tool profile from the SIGNED
    // claim first, the request's own ask second.
    const proceed = () => {
      req.profile = resolveProfile({ ck: req.oauthClaims?.ck, requested: requestedProfile(req) });
      next();
    };
    const send401 = (error: string, description?: string) => {
      res.setHeader("WWW-Authenticate", description
        ? `${challenge}, error="${error}", error_description="${description}"`
        : `${challenge}, error="${error}"`);
      res.status(401).json({ error, ...(description ? { error_description: description } : {}) });
    };

    const auth = req.header("authorization");
    if (!auth) return send401("missing_authorization");

    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!match) return send401("invalid_token", "Authorization header must be 'Bearer <token>'");
    const token = match[1]!.trim();

    // Legacy path: `vsk_*` keys forward straight through to the backend.
    if (isValidApiKeyFormat(token)) {
      req.apiKey = token;
      return proceed();
    }

    // OAuth JWT path: verify locally (HS256, shared secret with backend).
    if (looksLikeJwt(token)) {
      if (!config.oauthJwtSecret) {
        return send401("invalid_token", "OAuth JWT verification disabled (OAUTH_JWT_SECRET unset)");
      }
      try {
        const claims = verifyAccessToken(token, {
          secret: config.oauthJwtSecret,
          audience: config.resourceUrl,
          issuer: config.oauthIssuer,
        });
        req.apiKey = token;        // forwarded as Bearer to api.versely.studio
        req.oauthClaims = {
          sub: claims.sub,
          scope: claims.scope,
          azp: claims.azp,
          ...(typeof claims.ck === "string" ? { ck: claims.ck } : {}),
        };
        return proceed();
      } catch (err) {
        return send401("invalid_token", err instanceof Error ? err.message : "JWT verification failed");
      }
    }

    return send401("invalid_token", "Unrecognized token format");
  };
}

// --- Sessions ----------------------------------------------------------------
// This server ran stateless from day one (fresh Server per request, no
// Mcp-Session-Id) to keep each caller's bearer request-scoped. The cost only
// became visible on claude.ai: with no session to resume, its client runs the
// full initialize + capability handshake before EVERY tool call, and each
// handshake is one more chance to trip the client-side capability bug
// (anthropics/claude-code#78193) that renders 200 results as "Unable to reach
// versely-mcp". Stateful servers (which is most of them) go through that path
// once per conversation — that's why other connectors' cards look immune.
//
// So: initialize now mints a session. The bearer stays per-user — a session is
// bound to the identity that created it (JWT `sub`, or the vsk_ key itself)
// and every subsequent request must both pass the bearer gate AND belong to
// the same identity. Tokens may rotate mid-session (claude.ai refreshes its
// JWT); the freshest verified bearer is re-bound to the session's client on
// each request. Clients that never echo the session id keep working on the
// old one-shot path below.

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof buildServer>;
  client: VerselyClient;
  /** `<JWT sub or vsk_ key>#<profile>` — see sessionOwner. */
  owner: string;
  lastSeenMs: number;
}

const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_MAX = 500; // hard cap; beyond this, oldest-idle sessions are evicted

/**
 * Who a session belongs to: the identity (JWT `sub` for OAuth callers, the
 * vsk_ key itself for key callers) AND the profile it was opened under. A
 * session's server is built for one profile, so a request arriving on it
 * under another profile — e.g. an openai session re-used without
 * ?profile=openai — is refused (403) rather than served the wrong tool set.
 */
function sessionOwner(req: AuthedRequest): string {
  return `${req.oauthClaims?.sub ?? req.apiKey!}#${req.profile ?? "full"}`;
}

/** Stable, non-reversible identity key for per-user in-memory state (dedupe). */
function ownerKeyOf(req: AuthedRequest): string {
  return createHash("sha256").update(req.oauthClaims?.sub ?? req.apiKey!).digest("hex");
}

/** Constant-time string compare that doesn't leak the length either. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function isInitializeBody(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some(
    (m) => m && typeof m === "object" && (m as Record<string, unknown>).method === "initialize",
  );
}

export async function startHttpServer(config: Config): Promise<void> {
  const sessions = new Map<string, SessionEntry>();

  function dropSession(sid: string, reason: string): void {
    const entry = sessions.get(sid);
    if (!entry) return;
    sessions.delete(sid);
    entry.transport.close().catch(() => {});
    entry.server.close().catch(() => {});
    logLine({ level: "info", message: "session_closed", session_id: sid, reason, open_sessions: sessions.size });
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastSeenMs > SESSION_IDLE_MS) dropSession(sid, "idle_expired");
    }
    if (sessions.size > SESSION_MAX) {
      const byIdle = [...sessions.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
      for (const [sid] of byIdle.slice(0, sessions.size - SESSION_MAX)) dropSession(sid, "capacity_evicted");
    }
  }, 60_000);
  sweeper.unref();
  const app = express();
  app.disable("x-powered-by");
  // Trust the first proxy hop so req.ip reflects the real client when behind nginx.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "4mb" }));
  app.use(requestLogger);

  // --- CORS ------------------------------------------------------------------
  // NOT optional. claude.ai's MCP client runs IN A BROWSER, so every call to
  // this server is a cross-origin request: the browser sends an OPTIONS
  // preflight first and blocks the real request unless the response approves
  // it. Without these headers the call never leaves the browser — which the
  // host reports as "Unable to reach versely-mcp" even though the server is
  // healthy and never saw a request. curl and stdio clients don't enforce CORS,
  // so this failure is invisible from the terminal and looks like a phantom.
  //
  // This lived only as an untracked edit on the droplet for a while. A pull that
  // touched this file would have silently reverted it and taken claude.ai down
  // with no obvious cause, so it belongs in the repo.
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin) {
      // Reflect rather than hardcode: claude.ai's iframe/app origins differ
      // (claude.ai, claudeusercontent.com, ...) and a fixed value breaks them.
      // Safe here because every route is bearer-authenticated — there is no
      // cookie or ambient credential a hostile origin could ride.
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    // Always, even without an Origin: the response varies by it, and a cache
    // that stored a no-Origin copy would otherwise serve it to a browser
    // request and strip the approval — an intermittent, cache-shaped failure.
    res.setHeader("Vary", "Origin");
    // DELETE is in the spec's session-termination flow. We're stateless and
    // answer 405, but a browser must be allowed to ASK — a preflight that
    // omits the method fails before the 405 can be returned.
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      // Only non-safelisted request headers need listing. Last-Event-ID is
      // used for SSE resumption; X-Versely-Profile lets a browser client
      // restrict itself to a profile. Omitting a header the client sends
      // fails the whole preflight, so this errs on the side of listing.
      "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, X-Versely-Profile",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      // WWW-Authenticate must be readable or the browser can't see the OAuth
      // challenge and never starts the auth flow.
      "WWW-Authenticate, X-MCP-Request-Id, MCP-Session-Id",
    );
    if (req.method === "OPTIONS") {
      // Cache the preflight. Without this the browser preflights EVERY call,
      // doubling the request count and the number of chances to fail.
      res.setHeader("Access-Control-Max-Age", "86400");
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      uptime_s: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
      tools: getRegisteredToolCount(config, "full"),
      tools_openai: getRegisteredToolCount(config, "openai"),
    });
  });

  // OpenAI Apps domain verification. Public by design (OpenAI fetches it with
  // no credentials), so it is registered with no auth at all; the token is a
  // committed constant (see openaiChallenge.ts) and 404s while it is empty.
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("text/plain");
    if (!OPENAI_APPS_CHALLENGE_TOKEN) {
      res.status(404).send("Not found");
      return;
    }
    res.send(OPENAI_APPS_CHALLENGE_TOKEN);
  });

  // RFC 9728 OAuth Protected Resource Metadata. Tells clients which authorization
  // server protects this MCP endpoint and which scopes/auth methods are supported.
  // Also served at the path-suffixed form RFC 9728 §3.1 derives for a resource
  // with a path (/mcp) — some clients only look there.
  const protectedResourceMetadata = (_req: Request, res: Response) => {
    res.json({
      resource: config.resourceUrl,
      authorization_servers: [config.authServerUrl],
      scopes_supported: [
        "generate", "post", "manage_accounts", "slideshow",
        "ugc", "workflows", "analytics", "read",
      ],
      bearer_methods_supported: ["header"],
      resource_documentation: DOCS_URL,
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  app.get("/", (_req, res) => {
    res.json({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      endpoints: {
        mcp: "POST /mcp (requires Authorization: Bearer <vsk_... or OAuth JWT>)",
        health: "GET /healthz",
        oauth_protected_resource: "GET /.well-known/oauth-protected-resource",
      },
      docs: DOCS_URL,
    });
  });

  const requireBearer = makeAuthMiddleware(config);

  app.post("/mcp", requireBearer, async (req: AuthedRequest, res) => {
    const apiKey = req.apiKey!;
    const profile = req.profile ?? "full";
    const ownerKey = ownerKeyOf(req);
    const requestId = (res.locals as ResLocals).requestId;

    // Record every call that reaches us, with the outcome we actually produced.
    // Registered before any work so a throw or a client disconnect still lands.
    const startedAt = Date.now();
    const rpc = describeRpc(req.body);
    let recorded = false;
    const finalize = (error?: string) => {
      if (recorded) return;
      recorded = true;
      recordMcpCall({
        ts: new Date().toISOString(),
        request_id: requestId,
        ...rpc,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        auth: req.oauthClaims ? "oauth_jwt" : "api_key",
        profile,
        accept: req.header("accept"),
        user_agent: req.header("user-agent"),
        ...(req.header("mcp-session-id") ? { session_id: req.header("mcp-session-id") } : {}),
        ...(error ? { error } : {}),
      });
    };
    res.on("finish", () => finalize());
    // 'close' without 'finish' means the caller hung up before we answered —
    // exactly the shape a severed/abandoned request leaves behind.
    res.on("close", () => finalize(res.writableEnded ? undefined : "client_disconnected_before_response"));

    const sid = req.header("mcp-session-id");

    // One-shot serving: ephemeral stateless transport, torn down with the
    // response. Used for clients that never adopted a session AND as the
    // graceful path for stale session ids (see below). Stateless transports
    // don't validate the Mcp-Session-Id header, so a stale id rides along
    // harmlessly; auth is per-request either way.
    const serveOneShot = async (): Promise<void> => {
      const client = new VerselyClient(config, apiKey, { profile });
      const server = buildServer(config, client, { profile, ownerKey });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      let closed = false;
      res.on("close", () => {
        if (closed) return;
        closed = true;
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    };

    try {
      // --- Established session: route to its long-lived transport. ---------
      if (sid) {
        const entry = sessions.get(sid);
        if (!entry) {
          // Stale session: expired, evicted, or minted by a process that has
          // since restarted (every deploy wipes the in-memory map). The spec
          // says 404 "re-initialize" — but claude.ai surfaces that as a
          // fatal "MCP session has been terminated" toast and fails the
          // in-flight tool call instead of quietly re-initializing. The
          // session id carries no authority (every request is bearer-authed
          // on its own), so the graceful move is to just SERVE the call
          // statelessly. The client keeps believing in its session; every
          // call still works; deploys become invisible.
          //
          // An initialize with a stale id still mints a fresh session below
          // by falling through — the client is explicitly starting over.
          if (isInitializeBody(req.body)) {
            // fall through to the initialize branch (fresh session)
          } else {
            finalize("stale_session_served_one_shot");
            await serveOneShot();
            return;
          }
        } else {
          if (entry.owner !== sessionOwner(req)) {
            // Valid bearer, wrong user: someone is replaying another user's
            // session id. Refuse rather than serving them that user's session.
            finalize("session_owner_mismatch");
            res.status(403).json({ error: "session_owner_mismatch" });
            return;
          }
          entry.lastSeenMs = Date.now();
          // Re-bind the freshest verified bearer — OAuth tokens rotate
          // mid-session and the backend must see a live one.
          entry.client.setApiKey(apiKey);
          await entry.transport.handleRequest(req, res, req.body);
          return;
        }
      }

      // --- No session yet + initialize: mint one. ---------------------------
      if (isInitializeBody(req.body)) {
        const client = new VerselyClient(config, apiKey, { profile });
        const server = buildServer(config, client, { profile, ownerKey });
        const owner = sessionOwner(req);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Plain JSON bodies instead of one-event SSE frames — we never
          // push on the POST channel, so the framing bought nothing.
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, {
              transport,
              server,
              client,
              owner,
              lastSeenMs: Date.now(),
            });
            logLine({
              level: "info",
              message: "session_opened",
              session_id: sessionId,
              open_sessions: sessions.size,
            });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId && sessions.has(transport.sessionId)) {
            sessions.delete(transport.sessionId);
            logLine({
              level: "info",
              message: "session_closed",
              session_id: transport.sessionId,
              reason: "transport_closed",
              open_sessions: sessions.size,
            });
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // --- Legacy one-shot: no session id, non-initialize call. ------------
      // Some clients never echo Mcp-Session-Id; they keep the original
      // stateless contract — ephemeral server, torn down with the response.
      await serveOneShot();
    } catch (err) {
      logLine({
        level: "error",
        request_id: requestId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", request_id: requestId });
      }
    }
  });

  /**
   * GET /mcp — the streamable-http "standalone SSE stream".
   *
   * The spec makes this stream optional and explicitly permits answering 405.
   * claude.ai's client does not honor that: it opens this GET on every
   * capability refresh, and when the answer is 405 it marks the WHOLE
   * connector's capabilities as failed — the "Client server capabilities not
   * available" toast (anthropics/claude-code#78193). With capabilities down,
   * the MCP Apps bridge refuses the media card's tools/call polls, and every
   * refused poll renders in chat as "Unable to reach versely-mcp" — while the
   * POSTs all return 200 and the generations run fine. The 405 we used to
   * send from the catch-all below was the first domino.
   *
   * So: accept the stream. We have no server→client notifications to push,
   * so this is a keepalive-only stream — SSE comment lines (":" prefix),
   * which clients must ignore by spec. That satisfies the client without
   * inventing traffic. Recorded in the ring buffer as rpc_method "GET /mcp"
   * so /debug/recent-calls finally shows whether claude.ai's GETs reach us
   * at all, or die earlier at Anthropic's proxy / Cloudflare.
   */
  app.get("/mcp", requireBearer, async (req: AuthedRequest, res) => {
    const sid = req.header("mcp-session-id");
    recordMcpCall({
      ts: new Date().toISOString(),
      request_id: (res.locals as ResLocals).requestId,
      rpc_method: "GET /mcp (sse stream)",
      status: 200,
      duration_ms: 0,
      auth: req.oauthClaims ? "oauth_jwt" : "api_key",
      profile: req.profile,
      accept: req.header("accept"),
      user_agent: req.header("user-agent"),
      ...(sid ? { session_id: sid } : {}),
    });

    // Session-bound stream: hand it to the session's transport so real
    // server→client notifications can ride it. A heartbeat comment keeps
    // nginx/Cloudflare from idling the connection out between events.
    // A STALE session id (post-restart, expired) falls through to the plain
    // keepalive stream below instead of 404ing — same rationale as POST:
    // the id carries no authority and a hard failure only produces scary
    // client toasts.
    if (sid && sessions.has(sid)) {
      const entry = sessions.get(sid)!;
      if (entry.owner !== sessionOwner(req)) {
        res.status(403).json({ error: "session_owner_mismatch" });
        return;
      }
      entry.lastSeenMs = Date.now();
      res.setHeader("X-Accel-Buffering", "no");
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: keepalive ${Date.now()}\n\n`);
      }, 25_000);
      res.on("close", () => clearInterval(heartbeat));
      try {
        await entry.transport.handleRequest(req, res);
      } catch {
        clearInterval(heartbeat);
        if (!res.headersSent) res.status(500).json({ error: "internal_error" });
      }
      return;
    }

    // Session-less stream (claude.ai opens this before/without a session —
    // a 405 here trips its fatal capability toast, claude-code#78193).
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Tell nginx not to buffer this response — buffered SSE never flushes,
    // which the client experiences as a hang instead of an open stream.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": versely-mcp standalone sse stream (keepalive only)\n\n");
    const heartbeat = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 25_000);
    res.on("close", () => clearInterval(heartbeat));
  });

  // DELETE /mcp — spec session termination. Routes to the session's
  // transport (which closes it; onclose sweeps the map). Without a known
  // session there is nothing to terminate: 405, as the spec allows.
  app.delete("/mcp", requireBearer, async (req: AuthedRequest, res) => {
    const sid = req.header("mcp-session-id");
    if (!sid) {
      res.status(405).json({ error: "method_not_allowed", allow: ["POST", "GET"] });
      return;
    }
    const entry = sessions.get(sid);
    if (!entry) {
      // Deleting a session that's already gone (restart, sweep) is a no-op
      // success — the client wanted it dead and it is.
      res.status(200).json({ ok: true, note: "session already terminated" });
      return;
    }
    if (entry.owner !== sessionOwner(req)) {
      res.status(403).json({ error: "session_owner_mismatch" });
      return;
    }
    try {
      await entry.transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  // Method-not-allowed for anything else (PUT, PATCH, ...).
  app.all("/mcp", (_req, res) => {
    res.status(405).json({ error: "method_not_allowed", allow: ["POST", "GET", "DELETE"] });
  });

  /**
   * GET /debug/recent-calls — the last N MCP calls that REACHED this server.
   *
   * Answers the question that splits "Unable to reach versely-mcp" in half:
   * if the failing call is listed with status 200, the server answered and the
   * client dropped it; if it isn't listed at all, the request never arrived and
   * no server change can help. Carries no bodies and no tokens.
   *
   * Operator-only: `Authorization: Bearer <MCP_ADMIN_TOKEN>`. It used to accept
   * any bearer that merely LOOKED like a vsk_ key (the gate only checks the
   * format), which showed every user's recent tool calls to anyone. With no
   * admin token configured — or a wrong one — the route doesn't exist (404).
   */
  app.get("/debug/recent-calls", (req: Request, res) => {
    const auth = /^Bearer\s+(.+)$/i.exec(req.header("authorization")?.trim() ?? "");
    if (!config.adminToken || !auth || !safeEqual(auth[1]!.trim(), config.adminToken)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), MCP_CALL_LOG_MAX);
    const recent = mcpCallLog.slice(-limit).reverse();
    res.json({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      uptime_s: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
      // The buffer is per-process. If this box runs PM2 in cluster mode, each
      // worker keeps its own and a call can look "absent" merely because it was
      // handled by a sibling. Curl this a few times: a changing pid means more
      // than one worker, and absence proves nothing until every pid is checked.
      // (Statelessness makes multi-worker safe to RUN — it just makes this log
      // partial to READ.)
      pid: process.pid,
      open_sessions: sessions.size,
      note:
        "In-memory ring buffer, per-process, cleared on restart. If `pid` differs between calls, this box is multi-worker and a missing entry may just live on another worker.",
      returned: recent.length,
      total_seen: mcpCallLog.length,
      calls: recent,
    });
  });

  // Final error handler — anything that escapes route handlers ends up here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = (res.locals as Partial<ResLocals>).requestId;
    logLine({
      level: "error",
      request_id: requestId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  });

  // Build every profile's tool catalog before accepting traffic: a tool with
  // no policy row, or a stale description override, fails the deploy here
  // instead of the first user's tools/list.
  const toolCounts = validateServerSetup(config);

  await new Promise<void>((resolve) => {
    const httpServer = app.listen(config.httpPort, config.httpHost, () => {
      logLine({
        level: "info",
        message: "http_listening",
        host: config.httpHost,
        port: config.httpPort,
        api: config.apiUrl,
        tools: toolCounts.full,
        tools_openai: toolCounts.openai,
        version: SERVER_VERSION,
      });
      resolve();
    });

    const shutdown = (signal: string) => {
      logLine({ level: "info", message: "shutdown", signal });
      httpServer.close((err) => {
        if (err) {
          logLine({ level: "error", message: "shutdown_error", error: err.message });
          process.exit(1);
        }
        process.exit(0);
      });
      setTimeout(() => {
        logLine({ level: "warn", message: "shutdown_force", reason: "drain_timeout" });
        process.exit(1);
      }, 10_000).unref();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}
