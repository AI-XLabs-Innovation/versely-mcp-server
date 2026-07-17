import { randomBytes } from "node:crypto";
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
import { buildServer, getRegisteredToolCount } from "../server.js";
import { verifyAccessToken, looksLikeJwt } from "../oauth.js";

const PROCESS_START_MS = Date.now();

interface AuthedRequest extends Request {
  /** The bearer to forward to api.versely.studio. Either a `vsk_*` key or an OAuth JWT. */
  apiKey?: string;
  /** When the bearer is an OAuth JWT, the verified claims. */
  oauthClaims?: { sub: string; scope: string; azp: string };
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
  accept?: string;
  user_agent?: string;
  /**
   * Any Mcp-Session-Id the caller sent. We run stateless (sessionIdGenerator:
   * undefined) and never issue one, so this should always be absent. If it ever
   * shows up, a client is carrying a session we didn't mint — worth knowing,
   * since that is a common cause of "capabilities not available" on servers
   * that DO keep session state.
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

function makeAuthMiddleware(config: Config) {
  // Per RFC 9728: 401 responses on protected resources must include a
  // WWW-Authenticate header pointing clients at our protected-resource metadata
  // so they can discover the authorization server and start an OAuth flow.
  // mcp.versely.studio/.well-known/oauth-protected-resource is served below.
  const resourceMetadataUrl = `${new URL(config.resourceUrl).origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer realm="versely-mcp", resource_metadata="${resourceMetadataUrl}"`;

  return function requireBearer(req: AuthedRequest, res: Response, next: NextFunction): void {
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
      return next();
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
        req.oauthClaims = { sub: claims.sub, scope: claims.scope, azp: claims.azp };
        return next();
      } catch (err) {
        return send401("invalid_token", err instanceof Error ? err.message : "JWT verification failed");
      }
    }

    return send401("invalid_token", "Unrecognized token format");
  };
}

export async function startHttpServer(config: Config): Promise<void> {
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
      // used for SSE resumption; omitting a header the client sends fails the
      // whole preflight, so this errs on the side of listing.
      "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
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
      tools: getRegisteredToolCount(),
    });
  });

  // RFC 9728 OAuth Protected Resource Metadata. Tells clients which authorization
  // server protects this MCP endpoint and which scopes/auth methods are supported.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: config.resourceUrl,
      authorization_servers: [config.authServerUrl],
      scopes_supported: [
        "generate", "post", "manage_accounts", "slideshow",
        "ugc", "workflows", "analytics", "read",
      ],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://github.com/AI-XLabs-Innovation/versely-mcp",
    });
  });

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
      docs: "https://github.com/AI-XLabs-Innovation/versely-mcp",
    });
  });

  const requireBearer = makeAuthMiddleware(config);

  app.post("/mcp", requireBearer, async (req: AuthedRequest, res) => {
    const apiKey = req.apiKey!;
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

    const client = new VerselyClient(config, apiKey);
    const server = buildServer(config, client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    let closed = false;
    res.on("close", () => {
      if (closed) return;
      closed = true;
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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

  // Method-not-allowed for /mcp on anything but POST.
  app.all("/mcp", (_req, res) => {
    res.status(405).json({ error: "method_not_allowed", allow: ["POST"] });
  });

  /**
   * GET /debug/recent-calls — the last N MCP calls that REACHED this server.
   *
   * Answers the question that splits "Unable to reach versely-mcp" in half:
   * if the failing call is listed with status 200, the server answered and the
   * client dropped it; if it isn't listed at all, the request never arrived and
   * no server change can help. Bearer-gated (same rule as /mcp) because the
   * tool names reveal usage. Carries no bodies and no tokens.
   */
  app.get("/debug/recent-calls", requireBearer, (req: AuthedRequest, res) => {
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

  await new Promise<void>((resolve) => {
    const httpServer = app.listen(config.httpPort, config.httpHost, () => {
      logLine({
        level: "info",
        message: "http_listening",
        host: config.httpHost,
        port: config.httpPort,
        api: config.apiUrl,
        tools: getRegisteredToolCount(),
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
