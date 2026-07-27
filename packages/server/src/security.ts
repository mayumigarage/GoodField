export const MAX_COMMAND_BODY_BYTES = 16 * 1024;
export const MAX_IDENTIFIER_LENGTH = 128;
export const MAX_COMMAND_REFERENCE_COUNT = 64;
export const MAX_REALTIME_REQUEST_BYTES = 4 * 1024;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

export function isSafeIdentifierArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_COMMAND_REFERENCE_COUNT &&
    value.every(isSafeIdentifier) &&
    new Set(value).size === value.length
  );
}

export function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const SERVER_ONLY_KEYS = new Set([
  "seed",
  "rng",
  "rngState",
  "rngIndex",
  "randomLog",
  "processedCommands",
  "postTurnAutomatic",
  "phenomenonAutomatic",
  "pendingAction",
  "nextEntitySequence",
  "commandFingerprint"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNoServerSecrets(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      if (SERVER_ONLY_KEYS.has(key)) {
        throw new Error(`Public payload contains server-only field ${key}`);
      }
      visit(child);
    }
  };
  visit(value);
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

export type RateLimiter = {
  consume(key: string): RateLimitResult;
};

export type FixedWindowRateLimiterOptions = {
  limit: number;
  windowMs: number;
  clock?: () => number;
};

type RateLimitWindow = {
  startedAt: number;
  count: number;
};

export class FixedWindowRateLimiter implements RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  readonly #windows = new Map<string, RateLimitWindow>();

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error("Rate limit must be a positive integer");
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error("Rate-limit window must be a positive integer");
    }
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#clock = options.clock ?? Date.now;
  }

  consume(key: string): RateLimitResult {
    if (key.length === 0 || key.length > MAX_IDENTIFIER_LENGTH * 3) {
      throw new Error("Rate-limit key is invalid");
    }
    const now = this.#clock();
    if (!Number.isFinite(now)) throw new Error("Rate-limit clock is invalid");
    const current = this.#windows.get(key);
    const window =
      !current || now - current.startedAt >= this.#windowMs
        ? { startedAt: now, count: 0 }
        : current;
    window.count += 1;
    this.#windows.set(key, window);
    const retryAfterMs = Math.max(
      0,
      window.startedAt + this.#windowMs - now
    );
    return {
      allowed: window.count <= this.#limit,
      remaining: Math.max(0, this.#limit - window.count),
      retryAfterMs: window.count <= this.#limit ? 0 : retryAfterMs
    };
  }
}
