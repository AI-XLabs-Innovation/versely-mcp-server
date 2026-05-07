import { fetch, type Response } from "undici";
import type { Config } from "./config.js";
import { VerselyApiError, VerselyNetworkError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** Retry once on transient 5xx / network errors. Default true. */
  retry?: boolean;
  /** Override the per-request timeout. Default 60s. */
  timeoutMs?: number;
  /** Extra headers (merged with auth + content-type). */
  headers?: Record<string, string>;
}

export class VerselyClient {
  #cachedUserId?: string;

  constructor(private readonly config: Config) {}

  async getCurrentUserId(): Promise<string> {
    if (this.#cachedUserId) return this.#cachedUserId;
    const me = await this.get<Record<string, unknown>>("/api/v1/user/me");
    const id = pickUserId(me);
    if (!id) {
      throw new Error(
        "Could not determine user_id from GET /api/v1/user/me. The API key may be misconfigured.",
      );
    }
    this.#cachedUserId = id;
    return id;
  }

  request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    return this.#executeWithRetry<T>(method, path, opts);
  }

  get<T = unknown>(path: string, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }
  put<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  patch<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  delete<T = unknown>(path: string, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  async #executeWithRetry<T>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions,
  ): Promise<T> {
    const allowRetry = opts.retry ?? true;
    const maxAttempts = allowRetry ? 2 : 1;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.#executeOnce<T>(method, path, opts);
      } catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts) break;
        if (!isRetryable(err)) break;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastErr;
  }

  async #executeOnce<T>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions,
  ): Promise<T> {
    const url = this.#buildUrl(path, opts.query);
    const headers = this.#buildHeaders(opts.headers);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = mergeSignals(opts.signal, controller.signal);

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        throw new VerselyNetworkError(
          `${method} ${path} aborted after ${timeoutMs}ms`,
          err,
        );
      }
      throw new VerselyNetworkError(
        `${method} ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      return await parseBody<T>(res);
    }

    const errBody = await safeReadBody(res);
    throw new VerselyApiError({
      status: res.status,
      method,
      path,
      body: errBody,
      requestId: res.headers.get("x-request-id") ?? undefined,
    });
  }

  #buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const trimmed = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.apiUrl}${trimmed}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  #buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.config.userAgent,
      ...(extra ?? {}),
    };
  }
}

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  const text = await res.text();
  return text as unknown as T;
}

async function safeReadBody(res: Response): Promise<unknown> {
  try {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return await res.json();
    return await res.text();
  } catch {
    return undefined;
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof VerselyNetworkError) return true;
  if (err instanceof VerselyApiError) {
    return err.status >= 500 && err.status < 600;
  }
  return false;
}

function backoffMs(attempt: number): number {
  return 250 * Math.pow(2, attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickUserId(me: Record<string, unknown>): string | undefined {
  for (const key of ["id", "userId", "user_id", "uuid"]) {
    const v = me[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (me["user"] && typeof me["user"] === "object") {
    return pickUserId(me["user"] as Record<string, unknown>);
  }
  return undefined;
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const ctrl = new AbortController();
  const onAbort = (reason: unknown) => ctrl.abort(reason);
  if (a.aborted) ctrl.abort(a.reason);
  else a.addEventListener("abort", () => onAbort(a.reason), { once: true });
  if (b.aborted) ctrl.abort(b.reason);
  else b.addEventListener("abort", () => onAbort(b.reason), { once: true });
  return ctrl.signal;
}
