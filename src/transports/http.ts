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

const PROCESS_START_MS = Date.now();

interface AuthedRequest extends Request {
  apiKey?: string;
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

function requireApiKey(req: AuthedRequest, res: Response, next: NextFunction): void {
  const auth = req.header("authorization");
  if (!auth) {
    res.status(401).json({ error: "missing_authorization" });
    return;
  }
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match) {
    res.status(401).json({ error: "invalid_authorization_format" });
    return;
  }
  const token = match[1]!.trim();
  if (!isValidApiKeyFormat(token)) {
    res.status(401).json({ error: "invalid_api_key_format" });
    return;
  }
  req.apiKey = token;
  next();
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

  app.get("/", (_req, res) => {
    res.json({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      endpoints: {
        mcp: "POST /mcp (requires Authorization: Bearer vsk_...)",
        health: "GET /healthz",
      },
      docs: "https://github.com/AI-XLabs-Innovation/versely-mcp",
    });
  });

  app.post("/mcp", requireApiKey, async (req: AuthedRequest, res) => {
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
