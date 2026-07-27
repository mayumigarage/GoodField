import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  WebSocket,
  WebSocketServer
} from "ws";

import {
  createGameCommandHttpHandler,
  GameCommandApi
} from "./command-api.ts";
import type {
  OnlineStatePersistence
} from "./durable-store.ts";
import type {
  MatchPersistence,
  OperationalAuditLog
} from "./persistence.ts";
import {
  createOnlineRoomHttpHandler,
  OnlineRoomError,
  OnlineRoomService,
  type OnlineRoomServiceSnapshot
} from "./online-room.ts";
import {
  OnlineSessionStore,
  type OnlineSessionStoreSnapshot
} from "./online-session.ts";
import type { OnlineSession } from "./online-session.ts";
import {
  connectAuthorizedRealtimeSocket,
  RealtimeMatchHub
} from "./realtime.ts";
import {
  bearerTokenFromRequest,
  createRuntimeMatchHttpHandler,
  RuntimeMatchService
} from "./runtime-match.ts";
import { FixedWindowRateLimiter } from "./security.ts";

const COMMAND_ROUTE =
  /^\/(?:api\/)?matches\/[^/]+\/commands\/?$/u;
const MATCH_ROUTE =
  /^\/(?:api\/)?matches(?:\/[^/]+(?:\/join)?)?\/?$/u;
const ROOM_ROUTE = /^\/api\/rooms(?:\/|$)/u;
const REALTIME_PATH = "/realtime";
const DEFAULT_SCHEDULER_INTERVAL_MS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

type Closeable = {
  close?: () => Promise<void> | void;
};

export type GoodFieldServerOptions = {
  host?: string;
  port?: number;
  staticDirectory?: string;
  assetDirectory?: string;
  clock?: () => string;
  schedulerIntervalMs?: number;
  heartbeatIntervalMs?: number;
  persistence?: MatchPersistence;
  onlinePersistence?: OnlineStatePersistence;
  audit?: OperationalAuditLog;
  commandApi?: GameCommandApi;
  realtimeHub?: RealtimeMatchHub;
  sessionStore?: OnlineSessionStore;
  roomService?: OnlineRoomService;
  sessionSecret?: string | Uint8Array;
  roomSecret?: string | Uint8Array;
  secureCookies?: boolean;
  allowedOrigins?: readonly string[];
  maxWebSocketConnections?: number;
  onFatalError?: (error: Error) => void;
};

export type GoodFieldServerAddress = {
  host: string;
  port: number;
  url: string;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function configuredPort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("port must be an integer from 0 to 65535");
  }
  return value;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  status: number,
  message: string
): void {
  const statusText =
    status === 401
      ? "Unauthorized"
      : status === 503
        ? "Service Unavailable"
        : "Not Found";
  const body = JSON.stringify({
    ok: false,
    code: status === 401 ? "UNAUTHENTICATED" : "MATCH_NOT_FOUND",
    message
  });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body
  );
}

function tokenFromWebSocketRequest(
  request: IncomingMessage
): string | null {
  const bearerToken = bearerTokenFromRequest(request);
  if (bearerToken) return bearerToken;
  const protocolHeader = request.headers["sec-websocket-protocol"];
  const protocols = Array.isArray(protocolHeader)
    ? protocolHeader.flatMap((value) => value.split(","))
    : (protocolHeader ?? "").split(",");
  for (const protocol of protocols.map((value) => value.trim())) {
    if (protocol.startsWith("goodfield-token.")) {
      const token = protocol.slice("goodfield-token.".length);
      if (/^[A-Za-z0-9_-]+$/u.test(token)) return token;
    }
  }
  return null;
}

function matchIdFromCommandUrl(request: IncomingMessage): string | null {
  const pathname = new URL(
    request.url ?? "/",
    "http://localhost"
  ).pathname;
  const match =
    /^\/(?:api\/)?matches\/([^/]+)\/commands\/?$/u.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function containedFile(root: string, relativePath: string): string | null {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, relativePath);
  const relative = path.relative(absoluteRoot, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    return candidate;
  }
  return null;
}

function staticCandidate(
  pathname: string,
  staticDirectory: string,
  assetDirectory: string
): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath === "/") {
    return containedFile(staticDirectory, "index.html");
  }
  if (decodedPath.startsWith("/assets/")) {
    const relativePath = decodedPath.slice("/assets/".length);
    if (
      !relativePath.startsWith("client/") &&
      !relativePath.startsWith("shared/")
    ) {
      return null;
    }
    return containedFile(assetDirectory, relativePath);
  }
  return containedFile(staticDirectory, decodedPath.slice(1));
}

async function serveStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  assetDirectory: string
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = new URL(
    request.url ?? "/",
    "http://localhost"
  ).pathname;
  const candidate = staticCandidate(
    pathname,
    staticDirectory,
    assetDirectory
  );
  if (!candidate) return false;
  try {
    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) return false;
    const body = await readFile(candidate);
    response.statusCode = 200;
    response.setHeader(
      "content-type",
      CONTENT_TYPES[path.extname(candidate).toLowerCase()] ??
        "application/octet-stream"
    );
    response.setHeader("content-length", body.byteLength);
    if (pathname.includes(".map")) {
      response.setHeader("cache-control", "no-cache");
    }
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : null;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function listenError(
  error: Error,
  host: string,
  port: number
): Error {
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : "STARTUP_FAILED";
  const target = port === 0 ? `${host}:an available port` : `${host}:${port}`;
  return new Error(
    `GoodField server could not listen on ${target} (${code}): ${error.message}`,
    { cause: error }
  );
}

function serverClose(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

function webSocketServerClose(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export class GoodFieldServer {
  readonly commandApi: GameCommandApi;
  readonly realtimeHub: RealtimeMatchHub;
  readonly matchService: RuntimeMatchService;
  readonly sessionStore: OnlineSessionStore;
  readonly roomService: OnlineRoomService;
  readonly #host: string;
  readonly #port: number;
  readonly #staticDirectory: string;
  readonly #assetDirectory: string;
  readonly #clock: () => string;
  readonly #schedulerIntervalMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #persistence: MatchPersistence | undefined;
  readonly #onlinePersistence: OnlineStatePersistence | undefined;
  readonly #maxWebSocketConnections: number;
  readonly #onFatalError: (error: Error) => void;
  readonly #httpServer: HttpServer;
  readonly #webSocketServer: WebSocketServer;
  readonly #runtimeHandler: ReturnType<
    typeof createRuntimeMatchHttpHandler
  >;
  readonly #commandHandler: ReturnType<
    typeof createGameCommandHttpHandler
  >;
  readonly #roomHandler: ReturnType<
    typeof createOnlineRoomHttpHandler
  >;
  readonly #connectionCounts = new Map<string, number>();
  readonly #webSocketRateLimiter = new FixedWindowRateLimiter({
    limit: 30,
    windowMs: 10_000
  });
  readonly #responsiveSockets = new WeakSet<WebSocket>();
  readonly #metrics = {
    requests: 0,
    rejectedWhileDraining: 0,
    websocketConnections: 0,
    persistenceFailures: 0
  };
  #onlineStateVersion: number | null = null;
  #lastOnlineCheckpoint = "";
  #durabilityHealthy = true;
  #draining = false;
  #nextRetentionSweepAt = 0;
  #scheduler: ReturnType<typeof setInterval> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #stopping: Promise<void> | null = null;

  constructor(options: GoodFieldServerOptions = {}) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = configuredPort(options.port ?? 3000);
    this.#staticDirectory = path.resolve(
      options.staticDirectory ?? "dist/public"
    );
    this.#assetDirectory = path.resolve(
      options.assetDirectory ?? "dist/packages"
    );
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#schedulerIntervalMs = positiveInteger(
      options.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
      "schedulerIntervalMs"
    );
    this.#heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs"
    );
    this.#persistence = options.persistence;
    this.#onlinePersistence = options.onlinePersistence;
    this.#maxWebSocketConnections = positiveInteger(
      options.maxWebSocketConnections ?? 1_000,
      "maxWebSocketConnections"
    );
    this.#onFatalError =
      options.onFatalError ??
      ((error) => {
        process.stderr.write(`${JSON.stringify({
          level: "error",
          category: "RUNTIME_FAILURE",
          occurredAt: this.#clock(),
          message: error.message,
          stack: error.stack
        })}\n`);
      });
    this.commandApi =
      options.commandApi ??
      new GameCommandApi({
        clock: this.#clock,
        ...(options.persistence === undefined
          ? {}
          : { persistence: options.persistence }),
        ...(options.audit === undefined ? {} : { audit: options.audit })
      });
    this.realtimeHub =
      options.realtimeHub ??
      new RealtimeMatchHub({
        clock: this.#clock,
        ...(options.audit === undefined ? {} : { audit: options.audit })
      });
    this.matchService = new RuntimeMatchService({
      commandApi: this.commandApi,
      realtimeHub: this.realtimeHub,
      clock: this.#clock
    });
    this.sessionStore =
      options.sessionStore ??
      new OnlineSessionStore({
        clock: this.#clock,
        ...(options.sessionSecret === undefined
          ? {}
          : { secret: options.sessionSecret }),
        ...(options.secureCookies === undefined
          ? {}
          : { secureCookies: options.secureCookies }),
        ...(options.allowedOrigins === undefined
          ? {}
          : { allowedOrigins: options.allowedOrigins })
      });
    this.roomService =
      options.roomService ??
      new OnlineRoomService({
        matchService: this.matchService,
        sessions: this.sessionStore,
        clock: this.#clock,
        ...(options.roomSecret === undefined
          ? {}
          : { secret: options.roomSecret })
      });
    const restoredOnlineState =
      this.#onlinePersistence?.loadOnlineState() ?? null;
    if (restoredOnlineState) {
      this.#onlineStateVersion = restoredOnlineState.version;
      this.sessionStore.restoreState(
        restoredOnlineState.checkpoint
          .sessions as OnlineSessionStoreSnapshot
      );
      this.roomService.restoreState(
        restoredOnlineState.checkpoint
          .rooms as OnlineRoomServiceSnapshot
      );
      for (const matchId of this.roomService.startedMatchIds()) {
        if (!this.matchService.restore(matchId)) {
          throw new Error(
            `Online room references missing persisted match ${matchId}`
          );
        }
      }
      this.#lastOnlineCheckpoint = this.#onlineCheckpointFingerprint();
    }
    this.#runtimeHandler = createRuntimeMatchHttpHandler(
      this.matchService
    );
    this.#roomHandler = createOnlineRoomHttpHandler(
      this.roomService,
      this.sessionStore,
      {
        commit: () => {
          try {
            this.#checkpointOnlineState();
          } catch (error) {
            this.#onFatalError(
              error instanceof Error ? error : new Error(String(error))
            );
            throw new OnlineRoomError(
              "PERSISTENCE_UNAVAILABLE",
              "Durable storage is temporarily unavailable",
              503
            );
          }
        }
      }
    );
    this.#commandHandler = createGameCommandHttpHandler(
      this.commandApi,
      (request) => {
        const matchId = matchIdFromCommandUrl(request);
        if (!matchId) return null;
        const localActor = this.matchService.authorize(
          bearerTokenFromRequest(request),
          matchId
        );
        if (localActor) return localActor.playerId;
        try {
          const session = this.sessionStore.requireRequest(request, {
            origin: true,
            csrf: true
          });
          const onlineActor = this.roomService.authorizeMatch(session);
          return onlineActor?.matchId === matchId
            ? onlineActor.playerId
            : null;
        } catch {
          return null;
        }
      }
    );
    this.#httpServer = createServer((request, response) => {
      void this.#handleRequest(request, response).catch((error: unknown) => {
        const runtimeError =
          error instanceof Error ? error : new Error(String(error));
        this.#onFatalError(runtimeError);
        if (!response.headersSent) {
          writeJson(response, 500, {
            ok: false,
            code: "INTERNAL_ERROR",
            message: "The server could not process the request"
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 4 * 1024,
      handleProtocols(protocols) {
        return protocols.has("goodfield") ? "goodfield" : false;
      }
    });
    this.#httpServer.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
  }

  async start(): Promise<GoodFieldServerAddress> {
    if (this.#httpServer.listening) return this.address();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#httpServer.off("listening", onListening);
        reject(listenError(error, this.#host, this.#port));
      };
      const onListening = (): void => {
        this.#httpServer.off("error", onError);
        resolve();
      };
      this.#httpServer.once("error", onError);
      this.#httpServer.once("listening", onListening);
      this.#httpServer.listen(this.#port, this.#host);
    });
    this.#httpServer.on("error", this.#reportFatalError);
    this.#scheduler = setInterval(() => {
      try {
        const now = this.#clock();
        let changed = false;
        for (const matchId of this.matchService.matchIds()) {
          const before =
            this.commandApi.matchState(matchId)?.eventSequence ?? 0;
          this.matchService.advanceMatch(matchId, now);
          const after =
            this.commandApi.matchState(matchId)?.eventSequence ?? 0;
          if (after !== before) changed = true;
        }
        const swept = this.roomService.sweep();
        if (
          swept.expired > 0 ||
          swept.deleted > 0 ||
          swept.transferred > 0
        ) {
          changed = true;
        }
        if (changed) this.#checkpointOnlineState();
        const nowMs = Date.parse(now);
        if (nowMs >= this.#nextRetentionSweepAt) {
          this.#onlinePersistence?.deleteExpired(now);
          this.#nextRetentionSweepAt = nowMs + 60 * 60 * 1_000;
        }
      } catch (error) {
        this.#onFatalError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }, this.#schedulerIntervalMs);
    this.#scheduler.unref();
    this.#heartbeat = setInterval(() => {
      for (const socket of this.#webSocketServer.clients) {
        if (!this.#responsiveSockets.has(socket)) {
          socket.terminate();
          continue;
        }
        this.#responsiveSockets.delete(socket);
        socket.ping();
      }
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref();
    return this.address();
  }

  address(): GoodFieldServerAddress {
    const address = this.#httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("GoodField server is not listening");
    }
    const port = (address as AddressInfo).port;
    const displayHost =
      this.#host === "0.0.0.0" || this.#host === "::"
        ? "127.0.0.1"
        : this.#host;
    const bracketedHost = displayHost.includes(":")
      ? `[${displayHost}]`
      : displayHost;
    return {
      host: this.#host,
      port,
      url: `http://${bracketedHost}:${port}`
    };
  }

  beginDrain(): void {
    this.#draining = true;
  }

  readiness(): {
    ready: boolean;
    draining: boolean;
    durabilityHealthy: boolean;
  } {
    return {
      ready: !this.#draining && this.#durabilityHealthy,
      draining: this.#draining,
      durabilityHealthy: this.#durabilityHealthy
    };
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#stop();
    return this.#stopping;
  }

  readonly #reportFatalError = (error: Error): void => {
    this.#onFatalError(error);
  };

  #onlineCheckpointFingerprint(): string {
    const reconnectCursors = Object.fromEntries(
      this.roomService.startedMatchIds().map((matchId) => [
        matchId,
        this.commandApi.matchState(matchId)?.eventSequence ?? 0
      ])
    );
    return JSON.stringify({
      rooms: this.roomService.exportState(),
      sessions: this.sessionStore.exportState(),
      reconnectCursors
    });
  }

  #checkpointOnlineState(): void {
    if (!this.#onlinePersistence) return;
    const fingerprint = this.#onlineCheckpointFingerprint();
    if (fingerprint === this.#lastOnlineCheckpoint) {
      this.#durabilityHealthy = true;
      return;
    }
    const parsed = JSON.parse(fingerprint) as {
      rooms: unknown;
      sessions: unknown;
      reconnectCursors: Record<string, number>;
    };
    try {
      this.#onlineStateVersion =
        this.#onlinePersistence.saveOnlineState(
          this.#onlineStateVersion,
          {
            schemaVersion: 1,
            storedAt: this.#clock(),
            rooms: parsed.rooms,
            sessions: parsed.sessions,
            reconnectCursors: parsed.reconnectCursors
          }
        );
      this.#lastOnlineCheckpoint = fingerprint;
      this.#durabilityHealthy = true;
    } catch (error) {
      this.#durabilityHealthy = false;
      this.#metrics.persistenceFailures += 1;
      throw error;
    }
  }

  async #stop(): Promise<void> {
    try {
      this.#checkpointOnlineState();
    } catch (error) {
      this.#onFatalError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
    if (this.#scheduler !== null) {
      clearInterval(this.#scheduler);
      this.#scheduler = null;
    }
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    this.#httpServer.off("error", this.#reportFatalError);
    await Promise.all([
      webSocketServerClose(this.#webSocketServer),
      serverClose(this.#httpServer)
    ]);
    this.matchService.close();
    const closeable = this.#persistence as
      | (MatchPersistence & Closeable)
      | undefined;
    await closeable?.close?.();
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    this.#metrics.requests += 1;
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; connect-src 'self' ws: wss:; " +
        "img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self'; object-src 'none'; base-uri 'none'; " +
        "frame-ancestors 'none'; form-action 'self'"
    );
    response.setHeader("cross-origin-opener-policy", "same-origin");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    const pathname = new URL(
      request.url ?? "/",
      "http://localhost"
    ).pathname;
    if (
      pathname === "/health" ||
      pathname === "/health/live" ||
      pathname === "/health/ready"
    ) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        writeJson(response, 405, {
          ok: false,
          code: "INVALID_REQUEST",
          message: "Only GET and HEAD are supported"
        });
        return;
      }
      if (pathname === "/health") {
        writeJson(response, 200, { ok: true, status: "ready" });
        return;
      }
      const live = pathname !== "/health/ready";
      const status = live || this.readiness().ready ? 200 : 503;
      writeJson(response, status, {
        ok: status === 200,
        status: live ? "live" : this.readiness().ready ? "ready" : "unready",
        ...this.readiness()
      });
      return;
    }
    if (pathname === "/metrics") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        writeJson(response, 405, {
          ok: false,
          code: "INVALID_REQUEST",
          message: "Only GET and HEAD are supported"
        });
        return;
      }
      response.statusCode = 200;
      response.setHeader(
        "content-type",
        "text/plain; version=0.0.4; charset=utf-8"
      );
      response.end(
        [
          "# TYPE goodfield_http_requests_total counter",
          `goodfield_http_requests_total ${this.#metrics.requests}`,
          "# TYPE goodfield_websocket_connections gauge",
          `goodfield_websocket_connections ${this.#metrics.websocketConnections}`,
          "# TYPE goodfield_persistence_failures_total counter",
          `goodfield_persistence_failures_total ${this.#metrics.persistenceFailures}`,
          "# TYPE goodfield_rejected_while_draining_total counter",
          `goodfield_rejected_while_draining_total ${this.#metrics.rejectedWhileDraining}`,
          ""
        ].join("\n")
      );
      return;
    }
    const newAdmission =
      request.method === "POST" &&
      (
        pathname === "/api/rooms" ||
        pathname === "/api/rooms/" ||
        /\/(?:join|rejoin|spectate)\/?$/u.test(pathname)
      );
    if (this.#draining && newAdmission) {
      this.#metrics.rejectedWhileDraining += 1;
      response.setHeader("retry-after", "30");
      writeJson(response, 503, {
        ok: false,
        code: "SERVER_DRAINING",
        message: "New online admissions are temporarily paused"
      });
      return;
    }
    if (
      !this.#durabilityHealthy &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      (COMMAND_ROUTE.test(pathname) || ROOM_ROUTE.test(pathname))
    ) {
      response.setHeader("retry-after", "5");
      writeJson(response, 503, {
        ok: false,
        code: "PERSISTENCE_UNAVAILABLE",
        message: "Durable storage is temporarily unavailable"
      });
      return;
    }
    if (COMMAND_ROUTE.test(pathname)) {
      try {
        await this.#commandHandler(request, response);
        this.#checkpointOnlineState();
      } catch (error) {
        this.#durabilityHealthy = false;
        this.#metrics.persistenceFailures += 1;
        this.#onFatalError(
          error instanceof Error ? error : new Error(String(error))
        );
        if (!response.headersSent) {
          response.setHeader("retry-after", "5");
          writeJson(response, 503, {
            ok: false,
            code: "PERSISTENCE_UNAVAILABLE",
            message: "The command was not committed; retry synchronization"
          });
        }
      }
      return;
    }
    if (ROOM_ROUTE.test(pathname)) {
      await this.#roomHandler(request, response);
      return;
    }
    if (MATCH_ROUTE.test(pathname)) {
      await this.#runtimeHandler(request, response);
      return;
    }
    if (
      await serveStaticFile(
        request,
        response,
        this.#staticDirectory,
        this.#assetDirectory
      )
    ) {
      return;
    }
    writeJson(response, 404, {
      ok: false,
      code: "NOT_FOUND",
      message: "Route or static asset was not found"
    });
  }

  #handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer
  ): void {
    let pathname: string;
    try {
      pathname = new URL(
        request.url ?? "/",
        "http://localhost"
      ).pathname;
    } catch {
      rejectUpgrade(socket, 404, "Realtime route was not found");
      return;
    }
    if (pathname !== REALTIME_PATH) {
      rejectUpgrade(socket, 404, "Realtime route was not found");
      return;
    }
    if (
      this.#webSocketServer.clients.size >=
      this.#maxWebSocketConnections
    ) {
      rejectUpgrade(socket, 503, "Realtime connection limit reached");
      return;
    }
    const rate = this.#webSocketRateLimiter.consume(
      `websocket\u0000${request.socket.remoteAddress ?? "unknown"}`
    );
    if (!rate.allowed) {
      rejectUpgrade(socket, 503, "Realtime connection rate exceeded");
      return;
    }
    const localAccessToken = tokenFromWebSocketRequest(request);
    const localPrincipal =
      this.matchService.authenticate(localAccessToken);
    let roomSession: OnlineSession | null = null;
    let onlineAuthorization:
      | ReturnType<OnlineRoomService["authorizeMatch"]>
      | null = null;
    if (!localPrincipal) {
      try {
        roomSession = this.sessionStore.requireRequest(request, {
          origin: true
        });
        onlineAuthorization =
          this.roomService.authorizeMatch(roomSession);
      } catch {
        roomSession = null;
        onlineAuthorization = null;
      }
    }
    const identity = localPrincipal
      ? {
          subjectId: localPrincipal.subjectId,
          matchId: localPrincipal.matchId,
          playerId: localPrincipal.playerId,
          viewer: {
            kind: "PLAYER" as const,
            playerId: localPrincipal.playerId
          },
          roomSession: null
        }
      : onlineAuthorization && roomSession
        ? {
            subjectId: roomSession.sessionId,
            matchId: onlineAuthorization.matchId,
            playerId: onlineAuthorization.playerId,
            viewer: onlineAuthorization.viewer,
            roomSession
          }
        : null;
    if (!identity) {
      rejectUpgrade(socket, 401, "Realtime authentication is required");
      return;
    }
    this.#webSocketServer.handleUpgrade(
      request,
      socket,
      head,
      (webSocket) => {
        this.#openRealtimeConnection(
          webSocket,
          identity
        );
      }
    );
  }

  #openRealtimeConnection(
    socket: WebSocket,
    identity: {
      subjectId: string;
      matchId: string;
      playerId: string | null;
      viewer: import("../../shared/src/protocol.ts").RealtimeViewer;
      roomSession: OnlineSession | null;
    }
  ): void {
    this.#metrics.websocketConnections += 1;
    const connectionKey =
      `${identity.matchId}\u0000${identity.subjectId}`;
    const connectionCount = this.#connectionCounts.get(connectionKey) ?? 0;
    this.#connectionCounts.set(connectionKey, connectionCount + 1);
    if (connectionCount === 0) {
      if (identity.playerId) {
        this.matchService.setConnected({
          subjectId: identity.playerId,
          matchId: identity.matchId,
          playerId: identity.playerId
        }, true);
      }
      if (identity.roomSession) {
        this.roomService.setConnected(identity.roomSession, true);
      }
    }
    this.#responsiveSockets.add(socket);
    let unsubscribe = (): void => {};
    let closed = false;

    socket.on("pong", () => {
      this.#responsiveSockets.add(socket);
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text messages are required");
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(data.toString()) as unknown;
      } catch {
        request = null;
      }
      unsubscribe();
      unsubscribe = connectAuthorizedRealtimeSocket(
        this.realtimeHub,
        {
          request,
          credentials: identity.subjectId,
          socket: {
            send(message) {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(message);
              }
            }
          }
        },
        {
          authenticate: (credentials) =>
            credentials === identity.subjectId
              ? { subjectId: identity.subjectId }
              : null,
          authorize: (_authenticatedPrincipal, matchId) =>
            matchId === identity.matchId ? identity.viewer : null
        }
      );
    });
    socket.on("error", () => {
      socket.close();
    });
    socket.on("close", () => {
      if (closed) return;
      closed = true;
      this.#metrics.websocketConnections = Math.max(
        0,
        this.#metrics.websocketConnections - 1
      );
      unsubscribe();
      const count = this.#connectionCounts.get(connectionKey) ?? 1;
      if (count <= 1) {
        this.#connectionCounts.delete(connectionKey);
        if (identity.playerId) {
          this.matchService.setConnected({
            subjectId: identity.playerId,
            matchId: identity.matchId,
            playerId: identity.playerId
          }, false);
        }
        if (identity.roomSession) {
          this.roomService.setConnected(identity.roomSession, false);
        }
      } else {
        this.#connectionCounts.set(connectionKey, count - 1);
      }
      try {
        this.#checkpointOnlineState();
      } catch (error) {
        this.#onFatalError(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
    socket.send(JSON.stringify({
      type: "CONNECTED",
      matchId: identity.matchId
    }));
  }
}

export function createGoodFieldServerFromEnvironment(
  overrides: GoodFieldServerOptions = {}
): GoodFieldServer {
  const production = process.env.NODE_ENV === "production";
  const publicOrigin = process.env.GOODFIELD_PUBLIC_ORIGIN;
  if (
    production &&
    (
      !publicOrigin?.startsWith("https://") ||
      process.env.GOODFIELD_SESSION_SECRET === undefined ||
      process.env.GOODFIELD_ROOM_SECRET === undefined
    )
  ) {
    throw new Error(
      "Production requires an HTTPS GOODFIELD_PUBLIC_ORIGIN and both online secrets"
    );
  }
  const environmentPort = process.env.GOODFIELD_PORT;
  const port =
    overrides.port ??
    (environmentPort === undefined ? 3000 : Number(environmentPort));
  return new GoodFieldServer({
    host: process.env.GOODFIELD_HOST ?? "127.0.0.1",
    staticDirectory:
      process.env.GOODFIELD_STATIC_DIR ?? path.resolve("dist/public"),
    assetDirectory:
      process.env.GOODFIELD_ASSET_DIR ?? path.resolve("dist/packages"),
    ...(process.env.GOODFIELD_SESSION_SECRET === undefined
      ? {}
      : { sessionSecret: process.env.GOODFIELD_SESSION_SECRET }),
    ...(process.env.GOODFIELD_ROOM_SECRET === undefined
      ? {}
      : { roomSecret: process.env.GOODFIELD_ROOM_SECRET }),
    secureCookies:
      process.env.GOODFIELD_COOKIE_SECURE === "true" ||
      publicOrigin?.startsWith("https://") === true,
    ...(publicOrigin === undefined
      ? {}
      : {
          allowedOrigins: publicOrigin
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        }),
    ...overrides,
    port
  });
}
