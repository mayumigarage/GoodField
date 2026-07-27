import { createHash, randomBytes } from "node:crypto";
import type {
  IncomingMessage,
  ServerResponse
} from "node:http";

import type {
  Controller,
  EndTimeThreshold,
  MatchMode,
  PlayerSetup
} from "../../shared/src/model.ts";
import type {
  GameViewState,
  RealtimeViewer
} from "../../shared/src/protocol.ts";
import { GameCommandApi } from "./command-api.ts";
import { createMatch } from "./engine.ts";
import { projectGameView } from "./projection.ts";
import { RealtimeMatchHub } from "./realtime.ts";
import {
  FixedWindowRateLimiter,
  isSafeIdentifier,
  MAX_COMMAND_BODY_BYTES
} from "./security.ts";
import type { RateLimiter } from "./security.ts";
import {
  advanceCpuControllers,
  processInputDeadline,
  setPlayerConnectionState
} from "./session.ts";

const DISPLAY_NAME_MAX_LENGTH = 40;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MATCH_COLLECTION_PATH = /^\/(?:api\/)?matches\/?$/u;
const MATCH_MEMBER_PATH =
  /^\/(?:api\/)?matches\/([^/]+)(?:\/join)?\/?$/u;

type JsonRecord = Record<string, unknown>;

export type RuntimePlayerInput = {
  displayName: string;
  controller: Controller;
  teamId?: string | null;
};

export type CreateRuntimeMatchInput = {
  players?: RuntimePlayerInput[];
  displayName?: string;
  cpuCount?: number;
  mode?: MatchMode;
  endTimeThreshold?: EndTimeThreshold | null;
};

export type RuntimeActorCredential = {
  matchId: string;
  playerId: string;
  displayName: string;
  accessToken: string;
};

export type RuntimeMatchParticipant = {
  playerId: string;
  displayName: string;
  controller: Controller;
};

export type RuntimeMatchCreated = {
  matchId: string;
  mode: MatchMode;
  participants: RuntimeMatchParticipant[];
  creator: RuntimeActorCredential;
  actors: RuntimeActorCredential[];
  snapshot: GameViewState;
};

export type RuntimeMatchJoined = {
  matchId: string;
  playerId: string;
  snapshot: GameViewState;
};

export type RuntimeActorPrincipal = {
  subjectId: string;
  matchId: string;
  playerId: string;
};

export type RuntimeMatchServiceOptions = {
  commandApi: GameCommandApi;
  realtimeHub: RealtimeMatchHub;
  clock?: () => string;
  random?: (size: number) => Uint8Array;
  maxCpuDecisionsPerTick?: number;
};

export type RuntimeMatchHttpHandlerOptions = {
  maxRequestBodyBytes?: number;
  rateLimiter?: RateLimiter | null;
};

export type RuntimeMatchHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

export type RuntimeMatchErrorCode =
  | "INVALID_REQUEST"
  | "MATCH_NOT_FOUND"
  | "UNAUTHENTICATED";

export class RuntimeMatchError extends Error {
  readonly code: RuntimeMatchErrorCode;
  readonly status: number;

  constructor(
    code: RuntimeMatchErrorCode,
    message: string,
    status: number
  ) {
    super(message);
    this.name = "RuntimeMatchError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: JsonRecord,
  allowedKeys: readonly string[]
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeDisplayName(value: string): string {
  return value.normalize("NFKC").trim();
}

function displayNameKey(value: string): string {
  return normalizeDisplayName(value).toLocaleLowerCase("ja-JP");
}

function requireDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "Display name must be a string",
      400
    );
  }
  const displayName = normalizeDisplayName(value);
  if (
    displayName.length === 0 ||
    displayName.length > DISPLAY_NAME_MAX_LENGTH ||
    CONTROL_CHARACTER.test(displayName)
  ) {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      `Display name must contain 1 to ${DISPLAY_NAME_MAX_LENGTH} characters`,
      400
    );
  }
  return displayName;
}

function requireMode(value: unknown): MatchMode {
  if (value === undefined) return "TRAINING";
  if (value === "TRAINING" || value === "ONLINE") return value;
  throw new RuntimeMatchError(
    "INVALID_REQUEST",
    "Mode must be TRAINING or ONLINE",
    400
  );
}

function requireEndTimeThreshold(
  value: unknown
): EndTimeThreshold | null | undefined {
  if (value === undefined || value === null) return value;
  if ([1, 50, 75, 100, 150].includes(value as number)) {
    return value as EndTimeThreshold;
  }
  throw new RuntimeMatchError(
    "INVALID_REQUEST",
    "End-time threshold must be 1, 50, 75, 100, 150, or null",
    400
  );
}

function validateParticipants(
  players: readonly RuntimePlayerInput[]
): RuntimePlayerInput[] {
  if (players.length < 2 || players.length > 9) {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "A match requires 2 to 9 players",
      400
    );
  }
  const normalized = players.map((player) => ({
    displayName: requireDisplayName(player.displayName),
    controller: player.controller,
    teamId: player.teamId ?? null
  }));
  if (
    normalized.some(
      ({ controller }) => controller !== "HUMAN" && controller !== "CPU"
    )
  ) {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "Player controller must be HUMAN or CPU",
      400
    );
  }
  if (normalized[0]?.controller !== "HUMAN") {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "The match creator must be HUMAN",
      400
    );
  }
  const nameKeys = normalized.map(({ displayName }) =>
    displayNameKey(displayName)
  );
  if (new Set(nameKeys).size !== nameKeys.length) {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "Display names must be unique",
      400
    );
  }
  return normalized;
}

function localParticipants(
  displayNameValue: unknown,
  cpuCountValue: unknown
): RuntimePlayerInput[] {
  const displayName = requireDisplayName(displayNameValue ?? "Player");
  const cpuCount = cpuCountValue ?? 1;
  if (
    typeof cpuCount !== "number" ||
    !Number.isInteger(cpuCount) ||
    cpuCount < 1 ||
    cpuCount > 8
  ) {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "cpuCount must be an integer from 1 to 8",
      400
    );
  }
  const players: RuntimePlayerInput[] = [
    { displayName, controller: "HUMAN" }
  ];
  const usedNames = new Set([displayNameKey(displayName)]);
  for (let index = 1; index <= cpuCount; index += 1) {
    let suffix = index;
    let cpuName = `CPU ${suffix}`;
    while (usedNames.has(displayNameKey(cpuName))) {
      suffix += 1;
      cpuName = `CPU ${suffix}`;
    }
    usedNames.add(displayNameKey(cpuName));
    players.push({ displayName: cpuName, controller: "CPU" });
  }
  return validateParticipants(players);
}

export function parseCreateRuntimeMatchRequest(
  value: unknown
): CreateRuntimeMatchInput {
  if (!isRecord(value)) {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "Request body must be a JSON object",
      400
    );
  }
  if (
    !hasOnlyKeys(value, [
      "players",
      "displayName",
      "cpuCount",
      "mode",
      "endTimeThreshold"
    ])
  ) {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "Request body contains unsupported fields",
      400
    );
  }
  const mode = requireMode(value.mode);
  const endTimeThreshold = requireEndTimeThreshold(value.endTimeThreshold);
  if (value.players !== undefined) {
    if (value.displayName !== undefined || value.cpuCount !== undefined) {
      throw new RuntimeMatchError(
        "INVALID_REQUEST",
        "players cannot be combined with displayName or cpuCount",
        400
      );
    }
    if (!Array.isArray(value.players)) {
      throw new RuntimeMatchError(
        "INVALID_REQUEST",
        "players must be an array",
        400
      );
    }
    const players = value.players.map((candidate) => {
      if (
        !isRecord(candidate) ||
        !hasOnlyKeys(candidate, ["displayName", "controller", "teamId"]) ||
        (
          candidate.teamId !== undefined &&
          candidate.teamId !== null &&
          (
            typeof candidate.teamId !== "string" ||
            candidate.teamId.length < 1 ||
            candidate.teamId.length > 40 ||
            CONTROL_CHARACTER.test(candidate.teamId)
          )
        )
      ) {
        throw new RuntimeMatchError(
          "INVALID_REQUEST",
          "Each player must contain displayName and controller",
          400
        );
      }
      return {
        displayName: requireDisplayName(candidate.displayName),
        controller: candidate.controller as Controller,
        teamId:
          candidate.teamId === undefined ? null : candidate.teamId
      };
    });
    return {
      players: validateParticipants(players),
      mode,
      ...(endTimeThreshold === undefined ? {} : { endTimeThreshold })
    };
  }
  return {
    players: localParticipants(value.displayName, value.cpuCount),
    mode,
    ...(endTimeThreshold === undefined ? {} : { endTimeThreshold })
  };
}

function tokenHash(accessToken: string): string {
  return createHash("sha256")
    .update(`goodfield-local-access-v1\u0000${accessToken}`, "utf8")
    .digest("base64url");
}

function encodeRandom(
  random: (size: number) => Uint8Array,
  size: number
): string {
  return Buffer.from(random(size)).toString("base64url");
}

function requireIsoDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Clock returned an invalid ISO date: ${value}`);
  }
  return value;
}

export class RuntimeMatchService {
  readonly #commandApi: GameCommandApi;
  readonly #realtimeHub: RealtimeMatchHub;
  readonly #clock: () => string;
  readonly #random: (size: number) => Uint8Array;
  readonly #maxCpuDecisionsPerTick: number;
  readonly #actorsByTokenHash = new Map<string, RuntimeActorPrincipal>();
  readonly #actorsByPlayerId = new Map<string, RuntimeActorPrincipal>();
  readonly #matchIds = new Set<string>();
  readonly #removeEventListener: () => void;

  constructor(options: RuntimeMatchServiceOptions) {
    this.#commandApi = options.commandApi;
    this.#realtimeHub = options.realtimeHub;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#random = options.random ?? randomBytes;
    this.#maxCpuDecisionsPerTick =
      options.maxCpuDecisionsPerTick ?? 512;
    if (
      !Number.isInteger(this.#maxCpuDecisionsPerTick) ||
      this.#maxCpuDecisionsPerTick < 1
    ) {
      throw new Error("maxCpuDecisionsPerTick must be a positive integer");
    }
    this.#removeEventListener = this.#commandApi.onMatchEventsCommitted(
      (state, events) => {
        this.#realtimeHub.publish(state, events);
      }
    );
  }

  create(input: CreateRuntimeMatchInput): RuntimeMatchCreated {
    const parsed = parseCreateRuntimeMatchRequest(input);
    const players = parsed.players;
    if (!players) throw new Error("Parsed players are missing");
    const now = requireIsoDate(this.#clock());
    const matchId = this.#uniqueIdentifier("match", this.#matchIds);
    const playerIds = new Set<string>();
    const setups: PlayerSetup[] = players.map((player) => ({
      playerId: this.#uniqueIdentifier("player", playerIds),
      displayName: player.displayName,
      controller: player.controller,
      teamId: player.teamId ?? null
    }));
    const created = createMatch({
      matchId,
      seed: encodeRandom(this.#random, 32),
      mode: parsed.mode ?? "TRAINING",
      players: setups,
      ...(parsed.endTimeThreshold === undefined
        ? {}
        : { endTimeThreshold: parsed.endTimeThreshold }),
      now
    });
    this.#matchIds.add(matchId);
    this.#realtimeHub.registerMatch(created.state, created.events);
    this.#commandApi.registerMatch(created.state, created.events);

    const actors: RuntimeActorCredential[] = [];
    for (const setup of setups) {
      if (setup.controller !== "HUMAN") continue;
      const accessToken = encodeRandom(this.#random, 32);
      const principal: RuntimeActorPrincipal = {
        subjectId: setup.playerId,
        matchId,
        playerId: setup.playerId
      };
      this.#actorsByTokenHash.set(tokenHash(accessToken), principal);
      this.#actorsByPlayerId.set(setup.playerId, principal);
      actors.push({
        matchId,
        playerId: setup.playerId,
        displayName: setup.displayName,
        accessToken
      });
    }
    const creator = actors[0];
    if (!creator) throw new Error("Created match has no human actor");
    this.advanceMatch(matchId, now);
    const state = this.#commandApi.matchState(matchId);
    if (!state) throw new Error("Created match was not registered");
    return {
      matchId,
      mode: state.mode,
      participants: setups.map((setup) => ({
        playerId: setup.playerId,
        displayName: setup.displayName,
        controller: setup.controller ?? "HUMAN"
      })),
      creator: structuredClone(creator),
      actors: structuredClone(actors),
      snapshot: projectGameView(state, creator.playerId)
    };
  }

  join(matchId: string, accessToken: string | null): RuntimeMatchJoined {
    const state = this.#commandApi.matchState(matchId);
    if (!state) {
      throw new RuntimeMatchError(
        "MATCH_NOT_FOUND",
        "Match was not found",
        404
      );
    }
    const principal = this.authorize(accessToken, matchId);
    if (!principal) {
      throw new RuntimeMatchError(
        "UNAUTHENTICATED",
        "A valid actor access token is required",
        401
      );
    }
    return {
      matchId,
      playerId: principal.playerId,
      snapshot: projectGameView(state, principal.playerId)
    };
  }

  view(
    matchId: string,
    viewerPlayerId: string | null
  ): GameViewState | null {
    const state = this.#commandApi.matchState(matchId);
    return state ? projectGameView(state, viewerPlayerId) : null;
  }

  authenticate(accessToken: string | null): RuntimeActorPrincipal | null {
    if (!accessToken || accessToken.length > 512) return null;
    const principal = this.#actorsByTokenHash.get(tokenHash(accessToken));
    return principal ? structuredClone(principal) : null;
  }

  authorize(
    accessToken: string | null,
    matchId: string
  ): RuntimeActorPrincipal | null {
    const principal = this.authenticate(accessToken);
    return principal?.matchId === matchId ? principal : null;
  }

  authorizePrincipal(
    principal: { subjectId: string },
    matchId: string
  ): RealtimeViewer | null {
    const actor = this.#actorsByPlayerId.get(principal.subjectId);
    if (!actor || actor.matchId !== matchId) return null;
    return { kind: "PLAYER", playerId: actor.playerId };
  }

  matchIds(): string[] {
    return [...this.#matchIds];
  }

  restore(matchId: string): boolean {
    const persisted = this.#commandApi.restorePersistedMatch(matchId);
    if (!persisted) return false;
    this.#matchIds.add(matchId);
    this.#realtimeHub.registerMatch(
      persisted.state,
      persisted.events
    );
    return true;
  }

  advanceMatch(matchId: string, occurredAt = this.#clock()): void {
    let state = this.#commandApi.matchState(matchId);
    if (!state || state.result) return;
    const serverTime = requireIsoDate(occurredAt);
    const deadline = processInputDeadline(
      state,
      serverTime,
      this.#maxCpuDecisionsPerTick
    );
    if (deadline.events.length > 0) {
      this.#commandApi.commitMatchTransition(
        deadline.state,
        deadline.events,
        deadline.commands
      );
      state = deadline.state;
    }
    if (state.result) return;
    const cpu = advanceCpuControllers(
      state,
      serverTime,
      this.#maxCpuDecisionsPerTick
    );
    if (cpu.events.length > 0) {
      this.#commandApi.commitMatchTransition(
        cpu.state,
        cpu.events,
        cpu.commands
      );
    }
  }

  setConnected(
    principal: RuntimeActorPrincipal,
    connected: boolean,
    occurredAt = this.#clock()
  ): void {
    const state = this.#commandApi.matchState(principal.matchId);
    if (!state || !state.players[principal.playerId]) return;
    const transition = setPlayerConnectionState(
      state,
      principal.playerId,
      connected,
      requireIsoDate(occurredAt)
    );
    if (transition.events.length > 0) {
      this.#commandApi.commitMatchTransition(
        transition.state,
        transition.events
      );
    }
  }

  close(): void {
    this.#removeEventListener();
  }

  #uniqueIdentifier(prefix: string, existing: Set<string>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const identifier = `${prefix}_${encodeRandom(this.#random, 18)}`;
      if (!existing.has(identifier)) {
        existing.add(identifier);
        return identifier;
      }
    }
    throw new Error(`Unable to allocate a unique ${prefix} identifier`);
  }
}

export function bearerTokenFromRequest(
  request: IncomingMessage
): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
  return match?.[1] ?? null;
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

async function readJsonBody(
  request: IncomingMessage,
  maxRequestBodyBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxRequestBodyBytes) {
      throw new RuntimeMatchError(
        "INVALID_REQUEST",
        "Request body is too large",
        413
      );
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeMatchError(
      "INVALID_REQUEST",
      "Request body is not valid JSON",
      400
    );
  }
}

function decodedIdentifier(value: string | undefined): string | null {
  try {
    const decoded = decodeURIComponent(value ?? "");
    return isSafeIdentifier(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function createRuntimeMatchHttpHandler(
  service: RuntimeMatchService,
  options: RuntimeMatchHttpHandlerOptions = {}
): RuntimeMatchHttpHandler {
  const maxRequestBodyBytes =
    options.maxRequestBodyBytes ?? MAX_COMMAND_BODY_BYTES;
  if (
    !Number.isSafeInteger(maxRequestBodyBytes) ||
    maxRequestBodyBytes < 1
  ) {
    throw new Error("maxRequestBodyBytes must be a positive integer");
  }
  const rateLimiter =
    options.rateLimiter === undefined
      ? new FixedWindowRateLimiter({ limit: 20, windowMs: 10_000 })
      : options.rateLimiter;

  return async (request, response) => {
    const pathname = new URL(
      request.url ?? "/",
      "http://localhost"
    ).pathname;
    if (MATCH_COLLECTION_PATH.test(pathname)) {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        writeJson(response, 405, {
          ok: false,
          code: "INVALID_REQUEST",
          message: "Only POST is supported"
        });
        return;
      }
      const clientKey = request.socket.remoteAddress ?? "local";
      const rateLimit = rateLimiter?.consume(`create\u0000${clientKey}`);
      if (rateLimit && !rateLimit.allowed) {
        response.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000)))
        );
        writeJson(response, 429, {
          ok: false,
          code: "RATE_LIMITED",
          message: "Too many match creation requests"
        });
        return;
      }
      try {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        const created = service.create(parseCreateRuntimeMatchRequest(body));
        writeJson(response, 201, { ok: true, ...created });
      } catch (error) {
        const failure =
          error instanceof RuntimeMatchError
            ? error
            : new RuntimeMatchError(
                "INVALID_REQUEST",
                "Match could not be created",
                400
              );
        writeJson(response, failure.status, {
          ok: false,
          code: failure.code,
          message: failure.message
        });
      }
      return;
    }

    const memberMatch = MATCH_MEMBER_PATH.exec(pathname);
    if (!memberMatch) {
      writeJson(response, 404, {
        ok: false,
        code: "MATCH_NOT_FOUND",
        message: "Route was not found"
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.setHeader("allow", "GET, POST");
      writeJson(response, 405, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Only GET and POST are supported"
      });
      return;
    }
    const matchId = decodedIdentifier(memberMatch[1]);
    if (!matchId) {
      writeJson(response, 400, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Match ID is invalid"
      });
      return;
    }
    try {
      const joined = service.join(
        matchId,
        bearerTokenFromRequest(request)
      );
      writeJson(response, 200, { ok: true, ...joined });
    } catch (error) {
      const failure =
        error instanceof RuntimeMatchError
          ? error
          : new RuntimeMatchError(
              "UNAUTHENTICATED",
              "Match could not be joined",
              401
            );
      writeJson(response, failure.status, {
        ok: false,
        code: failure.code,
        message: failure.message
      });
    }
  };
}
