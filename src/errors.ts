export class VerselyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerselyConfigError";
  }
}

export class VerselyApiError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly path: string;
  public readonly body: unknown;
  public readonly requestId?: string;

  constructor(args: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    requestId?: string;
  }) {
    super(buildApiErrorMessage(args));
    this.name = "VerselyApiError";
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.body = args.body;
    this.requestId = args.requestId;
  }
}

export class VerselyNetworkError extends Error {
  public override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "VerselyNetworkError";
    this.cause = cause;
  }
}

export class VerselyTimeoutError extends Error {
  public readonly requestId: string;
  public readonly lastStatus?: string;
  constructor(message: string, requestId: string, lastStatus?: string) {
    super(message);
    this.name = "VerselyTimeoutError";
    this.requestId = requestId;
    this.lastStatus = lastStatus;
  }
}

function buildApiErrorMessage(args: {
  status: number;
  method: string;
  path: string;
  body: unknown;
}): string {
  const detail = extractDetail(args.body);
  const tag = `${args.method} ${args.path} -> HTTP ${args.status}`;
  switch (args.status) {
    case 401:
      return `${tag}: authentication failed. Check VERSELY_API_KEY is valid and has not been revoked.${suffix(detail)}`;
    case 402:
      return `${tag}: insufficient credits. Top up at https://versely.studio.${suffix(detail)}`;
    case 403:
      return `${tag}: forbidden. The API key may lack the required scope.${suffix(detail)}`;
    case 404:
      return `${tag}: resource not found.${suffix(detail)}`;
    case 422:
      return `${tag}: validation error. Inspect the request body.${suffix(detail)}`;
    case 429:
      return `${tag}: rate limited. Back off before retrying.${suffix(detail)}`;
    default:
      if (args.status >= 500) {
        return `${tag}: server error.${suffix(detail)}`;
      }
      return `${tag}.${suffix(detail)}`;
  }
}

function suffix(detail: string | undefined): string {
  return detail ? ` Detail: ${detail}` : "";
}

function extractDetail(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === "string") {
    const trimmed = body.trim();
    return trimmed ? truncate(trimmed) : undefined;
  }
  if (typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "details", "msg"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return truncate(v.trim());
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>)["message"];
      if (typeof inner === "string" && inner.trim()) return truncate(inner.trim());
    }
  }
  return undefined;
}

function truncate(s: string, max = 400): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
