// Duplicate-call guard for creation tools.
//
// ChatGPT cuts a tool call at roughly 60 seconds and may call it again, and
// models retry "failed-looking" calls on their own. Every creation call
// charges the user, so a re-call must not start a second paid job. The guard
// keys each call on (owner, tool, effective arguments):
//
//   - an identical call while the first is still running JOINS it and gets
//     the same result (the retry after a 60s cut lands here);
//   - an identical call within 150s of a successful one gets that result back;
//   - errors are never cached, so a failed call can simply be made again;
//   - `confirm_repeat: true` skips the guard for a deliberate second copy.
//
// In-memory and per-process on purpose: it only has to cover the few minutes
// a host retry takes, and a restart losing it errs on the side of running.

import { createHash } from "node:crypto";
import type { ToolResult } from "./tools/_types.js";

export const DEDUPE_TTL_MS = 150_000;
export const DEDUPE_MAX_ENTRIES = 5_000;
export const DEDUPE_SWEEP_MS = 30_000;
/** An in-flight entry older than this is dropped (a hung call must not block retries forever). */
export const DEDUPE_INFLIGHT_MAX_MS = 10 * 60_000;

/** Never part of the key: they don't change what gets generated. */
const KEY_EXCLUDED = new Set(["mode", "poll_timeout_ms", "poll_interval_ms", "user_id", "confirm_repeat"]);

interface Entry {
  startedAt: number;
  promise: Promise<ToolResult>;
  settledAt?: number;
  result?: ToolResult;
}

export interface GuardOutcome {
  result: ToolResult;
  /** Set when this call reused an earlier one: ms since that call started. */
  reusedAgeMs?: number;
}

/** JSON with object keys sorted, so argument order can't defeat the key. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function dedupeKey(ownerKey: string, tool: string, args: Record<string, unknown>): string {
  const effective: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!KEY_EXCLUDED.has(k)) effective[k] = v;
  return createHash("sha256")
    .update(`${ownerKey}|${tool}|${stableStringify(effective)}`)
    .digest("hex");
}

export function dedupeNote(ageMs: number): string {
  const secs = Math.max(1, Math.round(ageMs / 1000));
  return (
    `This matches a request made ${secs}s ago, so Versely returned that job instead of starting ` +
    `and charging for a duplicate. To make another, call again with confirm_repeat: true.`
  );
}

export class DuplicateCallGuard {
  readonly #entries = new Map<string, Entry>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: {
      ttlMs?: number;
      maxEntries?: number;
      inflightMaxMs?: number;
      sweepMs?: number;
    } = {},
  ) {}

  get size(): number {
    return this.#entries.size;
  }

  async run(key: string, execute: () => Promise<ToolResult>): Promise<GuardOutcome> {
    this.#ensureSweeper();
    const now = Date.now();
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.result && existing.settledAt !== undefined) {
        if (now - existing.settledAt <= this.#ttl) {
          return { result: structuredClone(existing.result), reusedAgeMs: now - existing.startedAt };
        }
      } else if (now - existing.startedAt <= this.#inflightMax) {
        const result = await existing.promise;
        return { result: structuredClone(result), reusedAgeMs: now - existing.startedAt };
      }
      this.#entries.delete(key);
    }

    const entry: Entry = { startedAt: now, promise: Promise.resolve(undefined as unknown as ToolResult) };
    entry.promise = execute().then(
      (result) => {
        if (result.isError) {
          // Never cache a failure: the caller must be able to simply try again.
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
        } else {
          entry.result = result;
          entry.settledAt = Date.now();
        }
        return result;
      },
      (err: unknown) => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        throw err;
      },
    );
    this.#entries.set(key, entry);
    this.#enforceCap();
    return { result: await entry.promise };
  }

  /** Drop expired entries. Runs on a timer; exposed for tests. */
  sweep(now: number = Date.now()): void {
    for (const [key, e] of this.#entries) {
      const expired =
        e.settledAt !== undefined
          ? now - e.settledAt > this.#ttl
          : now - e.startedAt > this.#inflightMax;
      if (expired) this.#entries.delete(key);
    }
  }

  get #ttl(): number {
    return this.opts.ttlMs ?? DEDUPE_TTL_MS;
  }

  get #inflightMax(): number {
    return this.opts.inflightMaxMs ?? DEDUPE_INFLIGHT_MAX_MS;
  }

  #enforceCap(): void {
    const max = this.opts.maxEntries ?? DEDUPE_MAX_ENTRIES;
    if (this.#entries.size <= max) return;
    this.sweep();
    // Map iteration is insertion order, so this evicts oldest-first. An
    // evicted in-flight call keeps running; it just can't be joined any more.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= max) break;
      this.#entries.delete(key);
    }
  }

  #ensureSweeper(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => this.sweep(), this.opts.sweepMs ?? DEDUPE_SWEEP_MS);
    this.#sweeper.unref();
  }
}

/** Process-wide guard; keys carry the owner, so users never share entries. */
export const duplicateCallGuard = new DuplicateCallGuard();
