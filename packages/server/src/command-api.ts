import type {
  IncomingMessage,
  ServerResponse
} from "node:http";

import type {
  CommandErrorCode,
  DomainEvent,
  GameCommand,
  MatchState
} from "../../shared/src/model.ts";
import type {
  GameCommandApiFailure,
  GameCommandApiResponse
} from "../../shared/src/protocol.ts";
import { handleCommand } from "./engine.ts";
import {
  commandRejectedAudit,
  effectChainAbortedAudit
} from "./persistence.ts";
import type {
  MatchPersistence,
  OperationalAuditLog,
  PersistedMatch
} from "./persistence.ts";
import { projectGameView } from "./projection.ts";
import {
  FixedWindowRateLimiter,
  isSafeIdentifier,
  isSafeIdentifierArray,
  MAX_COMMAND_BODY_BYTES
} from "./security.ts";
import type { RateLimiter } from "./security.ts";

const COMMAND_PATH = /^\/(?:api\/)?matches\/([^/]+)\/commands$/u;

type JsonRecord = Record<string, unknown>;

type ParsedCommand =
  | { ok: true; command: GameCommand }
  | { ok: false; commandId: string | null; message: string };

export type ExecuteGameCommandInput = {
  authenticatedPlayerId: string | null;
  matchId: string;
  body: unknown;
};

export type HttpAuthentication = (
  request: IncomingMessage
) => Promise<string | null> | string | null;

export type GameCommandHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

export type MatchEventsCommittedListener = (
  state: MatchState,
  events: readonly DomainEvent[]
) => void;

export type GameCommandApiOptions = {
  clock?: () => string;
  persistence?: MatchPersistence;
  audit?: OperationalAuditLog;
};

export type GameCommandHttpHandlerOptions = {
  maxRequestBodyBytes?: number;
  rateLimiter?: RateLimiter | null;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return isSafeIdentifier(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return isSafeIdentifierArray(value);
}

function hasOnlyKeys(value: JsonRecord, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function commandIdFrom(value: unknown): string | null {
  return isRecord(value) && isNonEmptyString(value.commandId)
    ? value.commandId
    : null;
}

function invalid(value: unknown, message: string): ParsedCommand {
  return { ok: false, commandId: commandIdFrom(value), message };
}

function hasValidBase(value: JsonRecord): boolean {
  return (
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.matchId) &&
    isNonEmptyString(value.commandId) &&
    isNonEmptyString(value.actorId) &&
    isNonNegativeInteger(value.expectedRevision)
  );
}

export function parseGameCommandRequest(value: unknown): ParsedCommand {
  if (!isRecord(value)) return invalid(value, "Request body must be a JSON object");
  if (!hasValidBase(value)) {
    return invalid(value, "Command metadata is missing or invalid");
  }
  const baseKeys = [
    "type",
    "matchId",
    "commandId",
    "actorId",
    "expectedRevision"
  ];
  const base = {
    matchId: value.matchId as string,
    commandId: value.commandId as string,
    actorId: value.actorId as string,
    expectedRevision: value.expectedRevision as number
  };
  switch (value.type) {
    case "PRAY":
    case "SURRENDER":
      if (!hasOnlyKeys(value, baseKeys)) {
        return invalid(value, `${value.type} contains unsupported fields`);
      }
      return { ok: true, command: { ...base, type: value.type } };
    case "DECLARE_ACTION": {
      const allowed = [
        ...baseKeys,
        "cardInstanceIds",
        "learnedMiracleIds",
        "targetPlayerId"
      ];
      if (
        !hasOnlyKeys(value, allowed) ||
        !isStringArray(value.cardInstanceIds) ||
        (value.learnedMiracleIds !== undefined &&
          !isStringArray(value.learnedMiracleIds)) ||
        !isNonEmptyString(value.targetPlayerId)
      ) {
        return invalid(value, "DECLARE_ACTION payload is invalid");
      }
      const command: Extract<GameCommand, { type: "DECLARE_ACTION" }> = {
        ...base,
        type: "DECLARE_ACTION",
        cardInstanceIds: value.cardInstanceIds,
        targetPlayerId: value.targetPlayerId
      };
      if (value.learnedMiracleIds !== undefined) {
        command.learnedMiracleIds = value.learnedMiracleIds;
      }
      return { ok: true, command };
    }
    case "DECLARE_REACTION": {
      const allowed = [
        ...baseKeys,
        "reactionId",
        "defenseCardInstanceIds",
        "defenseLearnedMiracleIds"
      ];
      if (
        !hasOnlyKeys(value, allowed) ||
        !isNonEmptyString(value.reactionId) ||
        !isStringArray(value.defenseCardInstanceIds) ||
        (value.defenseLearnedMiracleIds !== undefined &&
          !isStringArray(value.defenseLearnedMiracleIds))
      ) {
        return invalid(value, "DECLARE_REACTION payload is invalid");
      }
      const command: Extract<GameCommand, { type: "DECLARE_REACTION" }> = {
        ...base,
        type: "DECLARE_REACTION",
        reactionId: value.reactionId,
        defenseCardInstanceIds: value.defenseCardInstanceIds
      };
      if (value.defenseLearnedMiracleIds !== undefined) {
        command.defenseLearnedMiracleIds = value.defenseLearnedMiracleIds;
      }
      return { ok: true, command };
    }
    case "DISCARD":
    case "SACRIFICE":
      if (
        !hasOnlyKeys(value, [...baseKeys, "cardInstanceId"]) ||
        !isNonEmptyString(value.cardInstanceId)
      ) {
        return invalid(value, `${value.type} payload is invalid`);
      }
      return {
        ok: true,
        command: {
          ...base,
          type: value.type,
          cardInstanceId: value.cardInstanceId
        }
      };
    case "EXCHANGE_RESOURCES":
      if (
        !hasOnlyKeys(value, [
          ...baseKeys,
          "cardInstanceId",
          "hp",
          "mp",
          "money"
        ]) ||
        !isNonEmptyString(value.cardInstanceId) ||
        !isInteger(value.hp) ||
        !isInteger(value.mp) ||
        !isInteger(value.money)
      ) {
        return invalid(value, "EXCHANGE_RESOURCES payload is invalid");
      }
      return {
        ok: true,
        command: {
          ...base,
          type: "EXCHANGE_RESOURCES",
          cardInstanceId: value.cardInstanceId,
          hp: value.hp,
          mp: value.mp,
          money: value.money
        }
      };
    case "SELL_CARD":
      if (
        !hasOnlyKeys(value, [
          ...baseKeys,
          "cardInstanceId",
          "productCardInstanceId",
          "targetPlayerId"
        ]) ||
        !isNonEmptyString(value.cardInstanceId) ||
        !isNonEmptyString(value.productCardInstanceId) ||
        !isNonEmptyString(value.targetPlayerId)
      ) {
        return invalid(value, "SELL_CARD payload is invalid");
      }
      return {
        ok: true,
        command: {
          ...base,
          type: "SELL_CARD",
          cardInstanceId: value.cardInstanceId,
          productCardInstanceId: value.productCardInstanceId,
          targetPlayerId: value.targetPlayerId
        }
      };
    case "DECLARE_BUY":
      if (
        !hasOnlyKeys(value, [
          ...baseKeys,
          "cardInstanceId",
          "targetPlayerId"
        ]) ||
        !isNonEmptyString(value.cardInstanceId) ||
        !isNonEmptyString(value.targetPlayerId)
      ) {
        return invalid(value, "DECLARE_BUY payload is invalid");
      }
      return {
        ok: true,
        command: {
          ...base,
          type: "DECLARE_BUY",
          cardInstanceId: value.cardInstanceId,
          targetPlayerId: value.targetPlayerId
        }
      };
    case "CONFIRM_BUY":
      if (
        !hasOnlyKeys(value, [...baseKeys, "tradeId", "accept"]) ||
        !isNonEmptyString(value.tradeId) ||
        typeof value.accept !== "boolean"
      ) {
        return invalid(value, "CONFIRM_BUY payload is invalid");
      }
      return {
        ok: true,
        command: {
          ...base,
          type: "CONFIRM_BUY",
          tradeId: value.tradeId,
          accept: value.accept
        }
      };
    default:
      return invalid(value, `Unsupported command type: ${value.type}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneResponse(response: GameCommandApiResponse): GameCommandApiResponse {
  return structuredClone(response);
}

function commandFailure(
  code: GameCommandApiFailure["code"],
  message: string,
  commandId: string | null,
  state: MatchState | null,
  viewerPlayerId: string | null
): GameCommandApiFailure {
  return {
    ok: false,
    commandId,
    code,
    message,
    eventSeq: state?.eventSequence ?? null,
    snapshot: state ? projectGameView(state, viewerPlayerId) : null
  };
}

function cacheKey(matchId: string, actorId: string, commandId: string): string {
  return `${matchId}\u0000${actorId}\u0000${commandId}`;
}

function engineFailureStatus(code: CommandErrorCode): number {
  if (code === "INVALID_ACTOR" || code === "CONTROLLER_MISMATCH") return 403;
  return 409;
}

export class GameCommandApi {
  readonly #clock: () => string;
  readonly #persistence: MatchPersistence | undefined;
  readonly #audit: OperationalAuditLog | undefined;
  readonly #matches = new Map<string, MatchState>();
  readonly #matchEventListeners = new Set<MatchEventsCommittedListener>();
  readonly #responses = new Map<
    string,
    { fingerprint: string; response: GameCommandApiResponse }
  >();

  constructor(
    clockOrOptions: (() => string) | GameCommandApiOptions =
      () => new Date().toISOString()
  ) {
    if (typeof clockOrOptions === "function") {
      this.#clock = clockOrOptions;
      this.#persistence = undefined;
      this.#audit = undefined;
      return;
    }
    this.#clock =
      clockOrOptions.clock ?? (() => new Date().toISOString());
    this.#persistence = clockOrOptions.persistence;
    this.#audit = clockOrOptions.audit;
  }

  registerMatch(
    state: MatchState,
    initialEvents: readonly DomainEvent[] = []
  ): void {
    this.#persistence?.saveMatchCreated(state, initialEvents);
    this.#matches.set(state.matchId, state);
    const prefix = `${state.matchId}\u0000`;
    for (const key of this.#responses.keys()) {
      if (key.startsWith(prefix)) this.#responses.delete(key);
    }
    this.#notifyMatchEvents(state, []);
  }

  restoreMatch(matchId: string): MatchState | null {
    return this.restorePersistedMatch(matchId)?.state ?? null;
  }

  restorePersistedMatch(matchId: string): PersistedMatch | null {
    if (!this.#persistence) {
      throw new Error("Match persistence is not configured");
    }
    const persisted = this.#persistence.loadMatch(matchId);
    if (!persisted) return null;
    this.#matches.set(matchId, persisted.state);
    this.#notifyMatchEvents(persisted.state, []);
    return persisted;
  }

  onMatchEventsCommitted(
    listener: MatchEventsCommittedListener
  ): () => void {
    this.#matchEventListeners.add(listener);
    return () => {
      this.#matchEventListeners.delete(listener);
    };
  }

  commitMatchTransition(
    state: MatchState,
    events: readonly DomainEvent[],
    commands: readonly GameCommand[] = []
  ): void {
    const current = this.#matches.get(state.matchId);
    if (!current) throw new Error(`Unknown match ${state.matchId}`);
    if (
      state.eventSequence <= current.eventSequence ||
      events[0]?.eventSeq !== current.eventSequence + 1 ||
      events.at(-1)?.eventSeq !== state.eventSequence ||
      events.some(
        (event, index) =>
          index > 0 &&
          event.eventSeq !== (events[index - 1]?.eventSeq ?? 0) + 1
      )
    ) {
      throw new Error("External transition events must be contiguous and new");
    }
    this.#persistence?.saveTransition(state, commands, events);
    this.#matches.set(state.matchId, state);
    this.#recordAbortedChains(state.matchId, events);
    this.#notifyMatchEvents(state, events);
  }

  matchState(matchId: string): MatchState | null {
    return this.#matches.get(matchId) ?? null;
  }

  execute(input: ExecuteGameCommandInput): GameCommandApiResponse {
    const state = this.#matches.get(input.matchId) ?? null;
    if (!input.authenticatedPlayerId) {
      return this.#rejectedCommand(
        "UNAUTHENTICATED",
        "Authentication is required",
        commandIdFrom(input.body),
        null,
        null,
        input.matchId
      );
    }
    if (!state) {
      return this.#rejectedCommand(
        "MATCH_NOT_FOUND",
        "Match was not found",
        commandIdFrom(input.body),
        null,
        input.authenticatedPlayerId,
        input.matchId
      );
    }
    if (!state.players[input.authenticatedPlayerId]) {
      return this.#rejectedCommand(
        "INVALID_ACTOR",
        "Authenticated player does not belong to this match",
        commandIdFrom(input.body),
        null,
        input.authenticatedPlayerId,
        input.matchId
      );
    }
    const parsed = parseGameCommandRequest(input.body);
    if (!parsed.ok) {
      return this.#rejectedCommand(
        "INVALID_REQUEST",
        parsed.message,
        parsed.commandId,
        state,
        input.authenticatedPlayerId,
        input.matchId
      );
    }
    const command = parsed.command;
    if (command.matchId !== input.matchId) {
      return this.#rejectedCommand(
        "MATCH_ID_MISMATCH",
        "Command matchId does not match the request path",
        command.commandId,
        state,
        input.authenticatedPlayerId,
        input.matchId
      );
    }
    if (command.actorId !== input.authenticatedPlayerId) {
      return this.#rejectedCommand(
        "INVALID_ACTOR",
        "Authenticated player does not match command actor",
        command.commandId,
        state,
        input.authenticatedPlayerId,
        input.matchId
      );
    }
    const key = cacheKey(input.matchId, command.actorId, command.commandId);
    const fingerprint = canonicalJson(command);
    const cached = this.#responses.get(key);
    if (cached) {
      if (cached.fingerprint === fingerprint) {
        return cloneResponse(cached.response);
      }
      return this.#rejectedCommand(
        "DUPLICATE_COMMAND_CONFLICT",
        "commandId was already used with another payload",
        command.commandId,
        state,
        input.authenticatedPlayerId,
        input.matchId
      );
    }
    const occurredAt = this.#clock();
    if (!Number.isFinite(Date.parse(occurredAt))) {
      throw new Error(`Clock returned an invalid ISO date: ${occurredAt}`);
    }
    const authoritativeCommand = { ...command, occurredAt } as GameCommand;
    const result = handleCommand(
      state,
      authoritativeCommand,
      "HUMAN"
    );
    const response: GameCommandApiResponse = result.ok
      ? {
          ok: true,
          commandId: command.commandId,
          duplicate: result.duplicate,
          eventSeq: result.state.eventSequence,
          snapshot: projectGameView(result.state, input.authenticatedPlayerId)
        }
      : this.#rejectedCommand(
          result.code,
          result.message,
          command.commandId,
          result.state,
          input.authenticatedPlayerId,
          input.matchId
        );
    if (result.ok) {
      if (!result.duplicate) {
        this.#persistence?.saveTransition(
          result.state,
          [authoritativeCommand],
          result.events
        );
      }
      this.#matches.set(input.matchId, result.state);
      if (!result.duplicate) {
        this.#recordAbortedChains(input.matchId, result.events);
        this.#notifyMatchEvents(result.state, result.events);
      }
    }
    const stored = cloneResponse(response);
    this.#responses.set(key, { fingerprint, response: stored });
    return cloneResponse(stored);
  }

  #rejectedCommand(
    code: GameCommandApiFailure["code"],
    message: string,
    commandId: string | null,
    state: MatchState | null,
    viewerPlayerId: string | null,
    matchId: string
  ): GameCommandApiFailure {
    const failure = commandFailure(
      code,
      message,
      commandId,
      state,
      viewerPlayerId
    );
    if (this.#audit) {
      this.#audit.record(commandRejectedAudit({
        occurredAt: this.#clock(),
        matchId,
        actorId: viewerPlayerId,
        commandId,
        code,
        state
      }));
    }
    return failure;
  }

  #recordAbortedChains(
    matchId: string,
    events: readonly DomainEvent[]
  ): void {
    if (!this.#audit) return;
    for (const event of events) {
      if (event.type === "REACTION_CHAIN_ABORTED") {
        this.#audit.record(effectChainAbortedAudit(matchId, event));
      }
    }
  }

  #notifyMatchEvents(
    state: MatchState,
    events: readonly DomainEvent[]
  ): void {
    for (const listener of this.#matchEventListeners) {
      listener(state, events);
    }
  }
}

function httpStatus(response: GameCommandApiResponse): number {
  if (response.ok) return 200;
  switch (response.code) {
    case "INVALID_REQUEST":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "RATE_LIMITED":
      return 429;
    case "MATCH_NOT_FOUND":
      return 404;
    default:
      return engineFailureStatus(response.code);
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.statusCode = status;
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
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) throw new Error("EMPTY_REQUEST_BODY");
  return JSON.parse(text) as unknown;
}

export function createGameCommandHttpHandler(
  api: GameCommandApi,
  authenticate: HttpAuthentication,
  options: GameCommandHttpHandlerOptions = {}
): GameCommandHttpHandler {
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
      ? new FixedWindowRateLimiter({ limit: 30, windowMs: 10_000 })
      : options.rateLimiter;
  return async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      writeJson(response, 400, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Request URL is invalid"
      });
      return;
    }
    const match = COMMAND_PATH.exec(pathname);
    if (!match) {
      writeJson(response, 404, {
        ok: false,
        code: "MATCH_NOT_FOUND",
        message: "Route was not found"
      });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      writeJson(response, 405, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Only POST is supported"
      });
      return;
    }
    let matchId: string;
    try {
      matchId = decodeURIComponent(match[1] ?? "");
    } catch {
      writeJson(response, 400, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Match ID is invalid"
      });
      return;
    }
    if (!isSafeIdentifier(matchId)) {
      writeJson(response, 400, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Match ID is invalid"
      });
      return;
    }
    let authenticatedPlayerId: string | null;
    try {
      authenticatedPlayerId = await authenticate(request);
    } catch {
      writeJson(response, 401, {
        ok: false,
        code: "UNAUTHENTICATED",
        message: "Authentication failed"
      });
      return;
    }
    if (authenticatedPlayerId && !isSafeIdentifier(authenticatedPlayerId)) {
      writeJson(response, 401, {
        ok: false,
        code: "UNAUTHENTICATED",
        message: "Authenticated player ID is invalid"
      });
      return;
    }
    const rateLimit = rateLimiter?.consume(
      `${authenticatedPlayerId ?? "anonymous"}\u0000${matchId}`
    );
    if (rateLimit && !rateLimit.allowed) {
      response.setHeader(
        "retry-after",
        String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000)))
      );
      writeJson(response, 429, {
        ok: false,
        code: "RATE_LIMITED",
        message: "Too many command requests"
      });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request, maxRequestBodyBytes);
    } catch (error) {
      const tooLarge =
        error instanceof Error && error.message === "REQUEST_BODY_TOO_LARGE";
      writeJson(response, tooLarge ? 413 : 400, {
        ok: false,
        code: "INVALID_REQUEST",
        message: tooLarge
          ? "Request body is too large"
          : "Request body is not valid JSON"
      });
      return;
    }
    const result = api.execute({ authenticatedPlayerId, matchId, body });
    writeJson(response, httpStatus(result), result);
  };
}
