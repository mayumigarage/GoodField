import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import type { IncomingMessage } from "node:http";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;
const SESSION_ID_BYTES = 18;
const SESSION_SECRET_BYTES = 32;
const CSRF_TOKEN_BYTES = 24;

export type OnlineSessionRole =
  | "HOST"
  | "PARTICIPANT"
  | "SPECTATOR";

export type OnlineSessionBinding = {
  role: OnlineSessionRole;
  roomId: string;
  participantId: string | null;
};

export type OnlineSession = OnlineSessionBinding & {
  sessionId: string;
  issuedAt: string;
  expiresAt: string;
};

type StoredOnlineSession = OnlineSession & {
  tokenDigest: Buffer;
  csrfDigest: Buffer;
  revokedAt: string | null;
};

export type IssuedOnlineSession = {
  session: OnlineSession;
  cookie: string;
  csrfToken: string;
};

export type OnlineSessionStoreOptions = {
  clock?: () => string;
  random?: (size: number) => Uint8Array;
  secret?: string | Uint8Array;
  ttlMs?: number;
  secureCookies?: boolean;
  allowedOrigins?: readonly string[];
};

export type OnlineSessionStoreSnapshot = {
  schemaVersion: 1;
  sessions: Array<OnlineSession & {
    tokenDigest: string;
    csrfDigest: string;
    revokedAt: string | null;
  }>;
};

export class OnlineSessionError extends Error {
  readonly code:
    | "SESSION_REQUIRED"
    | "SESSION_EXPIRED"
    | "SESSION_INVALID"
    | "CSRF_REJECTED"
    | "ORIGIN_REJECTED";
  readonly status: number;

  constructor(
    code: OnlineSessionError["code"],
    message: string,
    status = 401
  ) {
    super(message);
    this.name = "OnlineSessionError";
    this.code = code;
    this.status = status;
  }
}

function requireTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Clock returned an invalid ISO date: ${value}`);
  }
  return timestamp;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function opaqueToken(
  random: (size: number) => Uint8Array,
  bytes: number
): string {
  return Buffer.from(random(bytes)).toString("base64url");
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength &&
    timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const section of (header ?? "").split(";")) {
    const separator = section.indexOf("=");
    if (separator < 1) continue;
    const name = section.slice(0, separator).trim();
    const value = section.slice(separator + 1).trim();
    if (name.length > 0 && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

function sessionIdFromCookieValue(value: string | undefined): string | null {
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator < 1) return null;
  const sessionId = value.slice(0, separator);
  return /^[A-Za-z0-9_-]+$/u.test(sessionId) ? sessionId : null;
}

function requestOrigin(request: IncomingMessage): string | null {
  const value = request.headers.origin;
  return typeof value === "string" ? value : null;
}

function requestHostOrigin(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (!host) return null;
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwarded === "string"
      ? forwarded.split(",")[0]?.trim()
      : (request.socket as { encrypted?: boolean }).encrypted === true
        ? "https"
        : "http";
  if (protocol !== "http" && protocol !== "https") return null;
  return `${protocol}://${host}`;
}

export class OnlineSessionStore {
  readonly cookieName: string;
  readonly #clock: () => string;
  readonly #random: (size: number) => Uint8Array;
  readonly #secret: Buffer;
  readonly #ttlMs: number;
  readonly #secureCookies: boolean;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #sessions = new Map<string, StoredOnlineSession>();

  constructor(options: OnlineSessionStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#random = options.random ?? randomBytes;
    this.#secret =
      typeof options.secret === "string"
        ? Buffer.from(options.secret, "utf8")
        : Buffer.from(options.secret ?? this.#random(SESSION_SECRET_BYTES));
    if (this.#secret.byteLength < SESSION_SECRET_BYTES) {
      throw new Error("Online session secret must contain at least 32 bytes");
    }
    this.#ttlMs = positiveInteger(
      options.ttlMs ?? DEFAULT_SESSION_TTL_MS,
      "ttlMs"
    );
    this.#secureCookies = options.secureCookies ?? false;
    this.cookieName = this.#secureCookies
      ? "__Host-goodfield_session"
      : "goodfield_session";
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((origin) =>
        new URL(origin).origin
      )
    );
  }

  issue(binding: OnlineSessionBinding): IssuedOnlineSession {
    const now = this.#clock();
    const nowMs = requireTimestamp(now);
    let sessionId: string;
    do {
      sessionId = opaqueToken(this.#random, SESSION_ID_BYTES);
    } while (this.#sessions.has(sessionId));
    const token = opaqueToken(this.#random, SESSION_SECRET_BYTES);
    const csrfToken = opaqueToken(this.#random, CSRF_TOKEN_BYTES);
    const stored: StoredOnlineSession = {
      sessionId,
      role: binding.role,
      roomId: binding.roomId,
      participantId: binding.participantId,
      issuedAt: now,
      expiresAt: new Date(nowMs + this.#ttlMs).toISOString(),
      tokenDigest: this.#digest("session-token", token),
      csrfDigest: this.#digest("csrf-token", csrfToken),
      revokedAt: null
    };
    this.#sessions.set(sessionId, stored);
    return {
      session: this.#publicSession(stored),
      cookie: this.#cookie(`${sessionId}.${token}`, this.#ttlMs),
      csrfToken
    };
  }

  authenticateCookieHeader(
    cookieHeader: string | undefined
  ): OnlineSession | null {
    const encoded = parseCookies(cookieHeader).get(this.cookieName);
    if (!encoded) return null;
    const separator = encoded.indexOf(".");
    if (separator < 1) return null;
    const sessionId = encoded.slice(0, separator);
    const token = encoded.slice(separator + 1);
    if (
      !/^[A-Za-z0-9_-]+$/u.test(sessionId) ||
      !/^[A-Za-z0-9_-]+$/u.test(token)
    ) {
      return null;
    }
    const stored = this.#sessions.get(sessionId);
    if (
      !stored ||
      stored.revokedAt !== null ||
      !safeEqual(
        stored.tokenDigest,
        this.#digest("session-token", token)
      )
    ) {
      return null;
    }
    if (requireTimestamp(stored.expiresAt) <= requireTimestamp(this.#clock())) {
      return null;
    }
    return this.#publicSession(stored);
  }

  requireRequest(
    request: IncomingMessage,
    options: {
      csrf?: boolean;
      origin?: boolean;
      roles?: readonly OnlineSessionRole[];
    } = {}
  ): OnlineSession {
    if (options.origin && !this.originAllowed(request)) {
      throw new OnlineSessionError(
        "ORIGIN_REJECTED",
        "Request origin is not allowed",
        403
      );
    }
    const session = this.authenticateCookieHeader(request.headers.cookie);
    if (!session) {
      const encoded = parseCookies(request.headers.cookie).get(
        this.cookieName
      );
      const sessionId = sessionIdFromCookieValue(encoded);
      const stored = sessionId ? this.#sessions.get(sessionId) : null;
      const expired =
        stored !== null &&
        stored !== undefined &&
        stored.revokedAt === null &&
        requireTimestamp(stored.expiresAt) <=
          requireTimestamp(this.#clock());
      throw new OnlineSessionError(
        expired ? "SESSION_EXPIRED" : "SESSION_REQUIRED",
        expired
          ? "The online session has expired"
          : "A valid online session is required"
      );
    }
    if (options.roles && !options.roles.includes(session.role)) {
      throw new OnlineSessionError(
        "SESSION_INVALID",
        "The online session does not have permission",
        403
      );
    }
    if (options.csrf) {
      const csrfToken = request.headers["x-goodfield-csrf"];
      const stored = this.#sessions.get(session.sessionId);
      if (
        typeof csrfToken !== "string" ||
        !stored ||
        !safeEqual(
          stored.csrfDigest,
          this.#digest("csrf-token", csrfToken)
        )
      ) {
        throw new OnlineSessionError(
          "CSRF_REJECTED",
          "CSRF validation failed",
          403
        );
      }
    }
    return session;
  }

  originAllowed(request: IncomingMessage): boolean {
    const origin = requestOrigin(request);
    if (!origin) return false;
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      return false;
    }
    if (this.#allowedOrigins.size > 0) {
      return this.#allowedOrigins.has(normalized);
    }
    return normalized === requestHostOrigin(request);
  }

  rotate(cookieHeader: string | undefined): IssuedOnlineSession {
    const session = this.authenticateCookieHeader(cookieHeader);
    if (!session) {
      throw new OnlineSessionError(
        "SESSION_INVALID",
        "The online session cannot be rotated"
      );
    }
    this.revoke(session.sessionId);
    return this.issue({
      role: session.role,
      roomId: session.roomId,
      participantId: session.participantId
    });
  }

  revoke(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session || session.revokedAt !== null) return false;
    session.revokedAt = this.#clock();
    return true;
  }

  isActive(session: OnlineSession): boolean {
    const stored = this.#sessions.get(session.sessionId);
    return stored !== undefined &&
      stored.revokedAt === null &&
      stored.role === session.role &&
      stored.roomId === session.roomId &&
      stored.participantId === session.participantId &&
      requireTimestamp(stored.expiresAt) > requireTimestamp(this.#clock());
  }

  revokeParticipant(roomId: string, participantId: string): number {
    let count = 0;
    for (const session of this.#sessions.values()) {
      if (
        session.roomId === roomId &&
        session.participantId === participantId &&
        session.revokedAt === null
      ) {
        session.revokedAt = this.#clock();
        count += 1;
      }
    }
    return count;
  }

  clearExpired(): number {
    const now = requireTimestamp(this.#clock());
    let removed = 0;
    for (const [sessionId, session] of this.#sessions) {
      if (
        session.revokedAt !== null ||
        requireTimestamp(session.expiresAt) <= now
      ) {
        this.#sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  clearCookie(): string {
    return this.#cookie("", 0);
  }

  exportState(): OnlineSessionStoreSnapshot {
    return {
      schemaVersion: 1,
      sessions: [...this.#sessions.values()].map((session) => ({
        ...this.#publicSession(session),
        tokenDigest: session.tokenDigest.toString("base64"),
        csrfDigest: session.csrfDigest.toString("base64"),
        revokedAt: session.revokedAt
      }))
    };
  }

  restoreState(snapshot: OnlineSessionStoreSnapshot): void {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.sessions)) {
      throw new Error("Online session snapshot is incompatible");
    }
    const restored = new Map<string, StoredOnlineSession>();
    for (const session of snapshot.sessions) {
      if (
        typeof session.sessionId !== "string" ||
        !["HOST", "PARTICIPANT", "SPECTATOR"].includes(session.role) ||
        typeof session.roomId !== "string" ||
        (
          session.participantId !== null &&
          typeof session.participantId !== "string"
        ) ||
        !Number.isFinite(Date.parse(session.issuedAt)) ||
        !Number.isFinite(Date.parse(session.expiresAt)) ||
        (
          session.revokedAt !== null &&
          !Number.isFinite(Date.parse(session.revokedAt))
        )
      ) {
        throw new Error("Online session snapshot contains invalid data");
      }
      const tokenDigest = Buffer.from(session.tokenDigest, "base64");
      const csrfDigest = Buffer.from(session.csrfDigest, "base64");
      if (tokenDigest.byteLength !== 32 || csrfDigest.byteLength !== 32) {
        throw new Error("Online session snapshot digest is invalid");
      }
      restored.set(session.sessionId, {
        sessionId: session.sessionId,
        role: session.role,
        roomId: session.roomId,
        participantId: session.participantId,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        tokenDigest,
        csrfDigest,
        revokedAt: session.revokedAt
      });
    }
    this.#sessions.clear();
    for (const [sessionId, session] of restored) {
      this.#sessions.set(sessionId, session);
    }
    this.clearExpired();
  }

  #digest(namespace: string, value: string): Buffer {
    return createHmac("sha256", this.#secret)
      .update(`${namespace}\u0000${value}`, "utf8")
      .digest();
  }

  #cookie(value: string, maxAgeMs: number): string {
    const parts = [
      `${this.cookieName}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1_000))}`
    ];
    if (this.#secureCookies) parts.push("Secure");
    return parts.join("; ");
  }

  #publicSession(session: StoredOnlineSession): OnlineSession {
    return {
      sessionId: session.sessionId,
      role: session.role,
      roomId: session.roomId,
      participantId: session.participantId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt
    };
  }
}
