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
