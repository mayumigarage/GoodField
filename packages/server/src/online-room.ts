import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import type {
  IncomingMessage,
  ServerResponse
} from "node:http";

import type {
  Controller,
  EndTimeThreshold
} from "../../shared/src/model.ts";
import type {
  GameViewState,
  RealtimeViewer
} from "../../shared/src/protocol.ts";
import {
  OnlineSessionError,
  OnlineSessionStore
} from "./online-session.ts";
import type {
  IssuedOnlineSession,
  OnlineSession
} from "./online-session.ts";
import {
  RuntimeMatchError,
  RuntimeMatchService
} from "./runtime-match.ts";
import {
  FixedWindowRateLimiter,
  MAX_COMMAND_BODY_BYTES
} from "./security.ts";
import type { RateLimiter } from "./security.ts";

const DISPLAY_NAME_MAX_LENGTH = 40;
const PASSPHRASE_MAX_LENGTH = 40;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const DEFAULT_ROOM_TTL_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_HOST_DISCONNECT_GRACE_MS = 5 * 60 * 1_000;
const DEFAULT_ROOM_RETENTION_MS = 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_RESPONSE_TTL_MS = 10 * 60 * 1_000;
const ROOM_ID_BYTES = 18;
const PARTICIPANT_ID_BYTES = 18;
const INVITE_CODE_BYTES = 24;
const REJOIN_TOKEN_BYTES = 32;

type JsonRecord = Record<string, unknown>;

export type OnlineRoomStatus =
  | "OPEN"
  | "STARTING"
  | "STARTED"
  | "EXPIRED";

export type OnlineRoomTeamId =
  | "TEAM_1"
  | "TEAM_2"
  | "TEAM_3"
  | "TEAM_4";

export type OnlineRoomSeatView = {
  seatIndex: number;
  controller: Controller | null;
  participantId: string | null;
  displayName: string | null;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  teamId: OnlineRoomTeamId | null;
};

export type OnlineRoomView = {
  roomId: string;
  accessMode: "PASSPHRASE" | "INVITATION";
  status: OnlineRoomStatus;
  seatCount: number;
  allowSpectators: boolean;
  endTimeThreshold: EndTimeThreshold | null;
  createdAt: string;
  expiresAt: string;
  matchId: string | null;
  seats: OnlineRoomSeatView[];
  canStart: boolean;
};

export type CreateOnlineRoomInput = {
  displayName: string;
  passphrase?: string;
  seatCount?: number;
  cpuCount?: number;
  allowSpectators?: boolean;
  endTimeThreshold?: EndTimeThreshold | null;
  requestId?: string;
};

export type JoinOnlineRoomInput = {
  displayName: string;
  inviteCode: string;
  requestId?: string;
};

export type JoinOnlineRoomByPassphraseInput = {
  displayName: string;
  passphrase: string;
  requestId?: string;
};

export type RejoinOnlineRoomInput = {
  participantId: string;
  rejoinToken: string;
  requestId?: string;
};

export type OnlineRoomAdmission = {
  room: OnlineRoomView;
  participantId: string | null;
  rejoinToken: string | null;
  session: IssuedOnlineSession;
  snapshot: GameViewState | null;
};

export type OnlineRoomCreated = OnlineRoomAdmission & {
  inviteCode: string;
};

export type OnlineRoomStarted = {
  room: OnlineRoomView;
  matchId: string;
  snapshot: GameViewState;
};

type OnlineRoomParticipant = {
  participantId: string;
  displayName: string;
  seatIndex: number;
  rejoinDigest: Buffer;
  joinedAt: string;
  leftAt: string | null;
  connected: boolean;
  matchPlayerId: string | null;
};

type OnlineRoomSeat = {
  seatIndex: number;
  controller: Controller | null;
  participantId: string | null;
  cpuDisplayName: string | null;
  ready: boolean;
  teamId: OnlineRoomTeamId | null;
};

type OnlineRoom = {
  roomId: string;
  status: OnlineRoomStatus;
  hostParticipantId: string;
  allowSpectators: boolean;
  endTimeThreshold: EndTimeThreshold | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  deleteAt: string;
  inviteDigest: Buffer | null;
  passphraseDigest: Buffer | null;
  hostDisconnectedAt: string | null;
  matchId: string | null;
  seats: OnlineRoomSeat[];
  participants: Map<string, OnlineRoomParticipant>;
};

type IdempotentResult = {
  fingerprint: string;
  result: unknown;
  expiresAtMs: number;
};

export type OnlineRoomServiceOptions = {
  matchService: RuntimeMatchService;
  sessions: OnlineSessionStore;
  clock?: () => string;
  random?: (size: number) => Uint8Array;
  secret?: string | Uint8Array;
  roomTtlMs?: number;
  hostDisconnectGraceMs?: number;
  roomRetentionMs?: number;
};

export type OnlineRoomServiceSnapshot = {
  schemaVersion: 1;
  rooms: Array<{
    roomId: string;
    status: OnlineRoomStatus;
    hostParticipantId: string;
    allowSpectators: boolean;
    endTimeThreshold: EndTimeThreshold | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    deleteAt: string;
    inviteDigest: string | null;
    passphraseDigest?: string | null;
    hostDisconnectedAt: string | null;
    matchId: string | null;
    seats: OnlineRoomSeat[];
    participants: Array<Omit<OnlineRoomParticipant, "rejoinDigest"> & {
      rejoinDigest: string;
    }>;
  }>;
};

export type OnlineMatchAuthorization = {
  matchId: string;
  participantId: string | null;
  playerId: string | null;
  viewer: RealtimeViewer;
};

export type OnlineRoomErrorCode =
  | "INVALID_REQUEST"
  | "ROOM_NOT_FOUND"
  | "ROOM_EXPIRED"
  | "ROOM_STARTED"
  | "INVITE_INVALID"
  | "PASSPHRASE_IN_USE"
  | "ROOM_FULL"
  | "DUPLICATE_PARTICIPANT"
  | "PARTICIPANT_NOT_FOUND"
  | "HOST_REQUIRED"
  | "ROOM_NOT_READY"
  | "SEAT_OCCUPIED"
  | "SPECTATING_DISABLED"
  | "IDEMPOTENCY_CONFLICT"
  | "PERSISTENCE_UNAVAILABLE";

export class OnlineRoomError extends Error {
  readonly code: OnlineRoomErrorCode;
  readonly status: number;

  constructor(
    code: OnlineRoomErrorCode,
    message: string,
    status = 400
  ) {
    super(message);
    this.name = "OnlineRoomError";
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: JsonRecord,
  keys: readonly string[]
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "Display name must be a string"
    );
  }
  const displayName = value.normalize("NFKC").trim();
  if (
    displayName.length < 1 ||
    displayName.length > DISPLAY_NAME_MAX_LENGTH ||
    CONTROL_CHARACTER.test(displayName)
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      `Display name must contain 1 to ${DISPLAY_NAME_MAX_LENGTH} characters`
    );
  }
  return displayName;
}

function displayNameKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
}

function normalizePassphrase(value: unknown): string {
  if (typeof value !== "string") {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "Passphrase must be a string"
    );
  }
  const passphrase = value.normalize("NFKC").trim();
  const length = [...passphrase].length;
  if (
    length < 1 ||
    length > PASSPHRASE_MAX_LENGTH ||
    CONTROL_CHARACTER.test(passphrase)
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      `Passphrase must contain 1 to ${PASSPHRASE_MAX_LENGTH} characters`
    );
  }
  return passphrase;
}

function requireSafeToken(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      `${name} is invalid`
    );
  }
  return value;
}

function optionalRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "requestId is invalid"
    );
  }
  return value;
}

function safeEqual(left: Buffer | null, right: Buffer): boolean {
  return left !== null &&
    left.byteLength === right.byteLength &&
    timingSafeEqual(left, right);
}

function opaqueToken(
  random: (size: number) => Uint8Array,
  size: number
): string {
  return Buffer.from(random(size)).toString("base64url");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseCreateOnlineRoomRequest(
  value: unknown
): CreateOnlineRoomInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "displayName",
      "passphrase",
      "seatCount",
      "cpuCount",
      "allowSpectators",
      "endTimeThreshold",
      "requestId"
    ])
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "Room request contains unsupported fields"
    );
  }
  const seatCount = value.seatCount ?? 2;
  const cpuCount = value.cpuCount ?? 0;
  if (
    typeof seatCount !== "number" ||
    !Number.isInteger(seatCount) ||
    seatCount < 2 ||
    seatCount > 9
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "seatCount must be an integer from 2 to 9"
    );
  }
  if (
    typeof cpuCount !== "number" ||
    !Number.isInteger(cpuCount) ||
    cpuCount < 0 ||
    cpuCount >= seatCount
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "cpuCount must leave at least one human seat"
    );
  }
  const allowSpectators = value.allowSpectators ?? false;
  if (typeof allowSpectators !== "boolean") {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "allowSpectators must be boolean"
    );
  }
  const endTimeThreshold = value.endTimeThreshold ?? null;
  if (
    endTimeThreshold !== null &&
    ![1, 50, 75, 100, 150].includes(endTimeThreshold as number)
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "endTimeThreshold is invalid"
    );
  }
  const requestId = optionalRequestId(value.requestId);
  const passphrase =
    value.passphrase === undefined
      ? undefined
      : normalizePassphrase(value.passphrase);
  return {
    displayName: normalizeDisplayName(value.displayName),
    ...(passphrase === undefined ? {} : { passphrase }),
    seatCount,
    cpuCount,
    allowSpectators,
    endTimeThreshold: endTimeThreshold as EndTimeThreshold | null,
    ...(requestId === undefined ? {} : { requestId })
  };
}

function parsePassphraseJoinRequest(
  value: unknown
): JoinOnlineRoomByPassphraseInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["displayName", "passphrase", "requestId"])
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "Passphrase join request contains unsupported fields"
    );
  }
  const requestId = optionalRequestId(value.requestId);
  return {
    displayName: normalizeDisplayName(value.displayName),
    passphrase: normalizePassphrase(value.passphrase),
    ...(requestId === undefined ? {} : { requestId })
  };
}

function parseJoinRequest(value: unknown): JoinOnlineRoomInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["displayName", "inviteCode", "requestId"])
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "Join request contains unsupported fields"
    );
  }
  const requestId = optionalRequestId(value.requestId);
  return {
    displayName: normalizeDisplayName(value.displayName),
    inviteCode: requireSafeToken(value.inviteCode, "inviteCode"),
    ...(requestId === undefined ? {} : { requestId })
  };
}

function parseRejoinRequest(value: unknown): RejoinOnlineRoomInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "participantId",
      "rejoinToken",
      "requestId"
    ])
  ) {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "Rejoin request contains unsupported fields"
    );
  }
  const requestId = optionalRequestId(value.requestId);
  return {
    participantId: requireSafeToken(
      value.participantId,
      "participantId"
    ),
    rejoinToken: requireSafeToken(
      value.rejoinToken,
      "rejoinToken"
    ),
    ...(requestId === undefined ? {} : { requestId })
  };
}

export class OnlineRoomService {
  readonly #matchService: RuntimeMatchService;
  readonly #sessions: OnlineSessionStore;
  readonly #clock: () => string;
  readonly #random: (size: number) => Uint8Array;
  readonly #secret: Buffer;
  readonly #roomTtlMs: number;
  readonly #hostDisconnectGraceMs: number;
  readonly #roomRetentionMs: number;
  readonly #rooms = new Map<string, OnlineRoom>();
  readonly #idempotency = new Map<string, IdempotentResult>();

  constructor(options: OnlineRoomServiceOptions) {
    this.#matchService = options.matchService;
    this.#sessions = options.sessions;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#random = options.random ?? randomBytes;
    this.#secret = Buffer.from(
      options.secret ?? this.#random(32)
    );
    if (this.#secret.byteLength < 32) {
      throw new Error("Online room secret must contain at least 32 bytes");
    }
    this.#roomTtlMs = positiveInteger(
      options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS,
      "roomTtlMs"
    );
    this.#hostDisconnectGraceMs = positiveInteger(
      options.hostDisconnectGraceMs ??
        DEFAULT_HOST_DISCONNECT_GRACE_MS,
      "hostDisconnectGraceMs"
    );
    this.#roomRetentionMs = positiveInteger(
      options.roomRetentionMs ?? DEFAULT_ROOM_RETENTION_MS,
      "roomRetentionMs"
    );
  }

  create(inputValue: CreateOnlineRoomInput): OnlineRoomCreated {
    const input = parseCreateOnlineRoomRequest(inputValue);
    return this.#idempotent(
      `create\u0000${input.requestId ?? opaqueToken(this.#random, 12)}`,
      input,
      () => {
        const now = this.#clock();
        const nowMs = requireTimestamp(now);
        const passphraseDigest =
          input.passphrase === undefined
            ? null
            : this.#digest("passphrase", input.passphrase);
        if (
          passphraseDigest !== null &&
          this.#openRoomForPassphraseDigest(passphraseDigest) !== null
        ) {
          throw new OnlineRoomError(
            "PASSPHRASE_IN_USE",
            "An open room already uses this passphrase",
            409
          );
        }
        const roomId = this.#uniqueId("room", this.#rooms);
        const participantId = this.#uniqueParticipantId();
        const rejoinToken = opaqueToken(this.#random, REJOIN_TOKEN_BYTES);
        const inviteCode = opaqueToken(this.#random, INVITE_CODE_BYTES);
        const seatCount = input.seatCount ?? 2;
        const cpuCount = input.cpuCount ?? 0;
        const host: OnlineRoomParticipant = {
          participantId,
          displayName: input.displayName,
          seatIndex: 0,
          rejoinDigest: this.#digest("rejoin", rejoinToken),
          joinedAt: now,
          leftAt: null,
          connected: true,
          matchPlayerId: null
        };
        const seats: OnlineRoomSeat[] = Array.from(
          { length: seatCount },
          (_, seatIndex) => {
            if (seatIndex === 0) {
              return {
                seatIndex,
                controller: "HUMAN",
                participantId,
                cpuDisplayName: null,
                ready: false,
                teamId: null
              };
            }
            if (seatIndex <= cpuCount) {
              return {
                seatIndex,
                controller: "CPU",
                participantId: null,
                cpuDisplayName: `CPU ${seatIndex}`,
                ready: true,
                teamId: null
              };
            }
            return {
              seatIndex,
              controller: null,
              participantId: null,
              cpuDisplayName: null,
              ready: false,
              teamId: null
            };
          }
        );
        const room: OnlineRoom = {
          roomId,
          status: "OPEN",
          hostParticipantId: participantId,
          allowSpectators: input.allowSpectators ?? false,
          endTimeThreshold: input.endTimeThreshold ?? null,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(nowMs + this.#roomTtlMs).toISOString(),
          deleteAt: new Date(
            nowMs + this.#roomTtlMs + this.#roomRetentionMs
          ).toISOString(),
          inviteDigest: this.#digest("invite", inviteCode),
          passphraseDigest,
          hostDisconnectedAt: null,
          matchId: null,
          seats,
          participants: new Map([[participantId, host]])
        };
        this.#rooms.set(roomId, room);
        const session = this.#sessions.issue({
          role: "HOST",
          roomId,
          participantId
        });
        return {
          room: this.#view(room),
          participantId,
          rejoinToken,
          inviteCode,
          session,
          snapshot: null
        };
      }
    );
  }

  join(
    roomId: string,
    inputValue: JoinOnlineRoomInput
  ): OnlineRoomAdmission {
    const input = parseJoinRequest(inputValue);
    return this.#idempotent(
      `join\u0000${roomId}\u0000${input.requestId ?? opaqueToken(this.#random, 12)}`,
      input,
      () => {
        const room = this.#requireOpenRoom(roomId);
        this.#requireInvite(room, input.inviteCode);
        return this.#admitParticipant(room, input.displayName);
      }
    );
  }

  joinByPassphrase(
    inputValue: JoinOnlineRoomByPassphraseInput
  ): OnlineRoomAdmission {
    const input = parsePassphraseJoinRequest(inputValue);
    const digest = this.#digest("passphrase", input.passphrase);
    const room = this.#openRoomForPassphraseDigest(digest);
    if (!room) {
      return this.create({
        displayName: input.displayName,
        passphrase: input.passphrase,
        seatCount: 9,
        cpuCount: 0,
        allowSpectators: false,
        endTimeThreshold: 100,
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId })
      });
    }
    return this.#idempotent(
      `join-passphrase\u0000${room.roomId}\u0000${
        input.requestId ?? opaqueToken(this.#random, 12)
      }`,
      input,
      () => this.#admitParticipant(
        this.#requireOpenRoom(room.roomId),
        input.displayName
      )
    );
  }

  rejoin(
    roomId: string,
    inputValue: RejoinOnlineRoomInput
  ): OnlineRoomAdmission {
    const input = parseRejoinRequest(inputValue);
    return this.#idempotent(
      `rejoin\u0000${roomId}\u0000${input.requestId ?? opaqueToken(this.#random, 12)}`,
      input,
      () => {
        const room = this.#requireRoom(roomId);
        const participant = room.participants.get(input.participantId);
        if (
          !participant ||
          !safeEqual(
            participant.rejoinDigest,
            this.#digest("rejoin", input.rejoinToken)
          )
        ) {
          throw new OnlineRoomError(
            "PARTICIPANT_NOT_FOUND",
            "Rejoin identity is invalid",
            401
          );
        }
        if (room.status === "EXPIRED") {
          throw new OnlineRoomError(
            "ROOM_EXPIRED",
            "The room has expired",
            410
          );
        }
        if (participant.leftAt !== null && room.status === "OPEN") {
          const seat = room.seats.find(
            ({ controller }) => controller === null
          );
          if (!seat) {
            throw new OnlineRoomError(
              "ROOM_FULL",
              "The participant seat is no longer available",
              409
            );
          }
          participant.seatIndex = seat.seatIndex;
          participant.leftAt = null;
          seat.controller = "HUMAN";
          seat.participantId = participant.participantId;
          seat.cpuDisplayName = null;
          seat.ready = false;
          seat.teamId = null;
        }
        participant.connected = true;
        room.updatedAt = this.#clock();
        this.#sessions.revokeParticipant(roomId, participant.participantId);
        const role =
          room.hostParticipantId === participant.participantId
            ? "HOST"
            : "PARTICIPANT";
        const session = this.#sessions.issue({
          role,
          roomId,
          participantId: participant.participantId
        });
        return {
          room: this.#view(room),
          participantId: participant.participantId,
          rejoinToken: null,
          session,
          snapshot: this.#snapshotForParticipant(room, participant)
        };
      }
    );
  }

  spectate(
    roomId: string,
    inviteCode: string
  ): OnlineRoomAdmission {
    const room = this.#requireRoom(roomId);
    this.#requireInvite(room, requireSafeToken(inviteCode, "inviteCode"));
    if (room.status !== "STARTED" || !room.matchId) {
      throw new OnlineRoomError(
        "ROOM_STARTED",
        "Spectators can connect only after the match starts",
        409
      );
    }
    if (!room.allowSpectators) {
      throw new OnlineRoomError(
        "SPECTATING_DISABLED",
        "This room does not allow spectators",
        403
      );
    }
    const session = this.#sessions.issue({
      role: "SPECTATOR",
      roomId,
      participantId: null
    });
    return {
      room: this.#view(room),
      participantId: null,
      rejoinToken: null,
      session,
      snapshot: this.#matchService.view(room.matchId, null)
    };
  }

  view(session: OnlineSession): OnlineRoomView {
    const room = this.#requireSessionRoom(session);
    return this.#view(room);
  }

  snapshot(session: OnlineSession): GameViewState {
    const authorization = this.authorizeMatch(session);
    if (!authorization) {
      throw new OnlineRoomError(
        "ROOM_STARTED",
        "The room has not started a match",
        409
      );
    }
    const snapshot = this.#matchService.view(
      authorization.matchId,
      authorization.playerId
    );
    if (!snapshot) {
      throw new RuntimeMatchError(
        "MATCH_NOT_FOUND",
        "Match was not found",
        404
      );
    }
    return snapshot;
  }

  setReady(session: OnlineSession, ready: boolean): OnlineRoomView {
    if (typeof ready !== "boolean") {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "ready must be boolean"
      );
    }
    const { room, participant } = this.#requireParticipant(session);
    this.#requireOpenRoom(room.roomId);
    const seat = room.seats[participant.seatIndex];
    if (!seat || seat.participantId !== participant.participantId) {
      throw new OnlineRoomError(
        "PARTICIPANT_NOT_FOUND",
        "Participant seat was not found",
        404
      );
    }
    seat.ready = ready;
    room.updatedAt = this.#clock();
    return this.#view(room);
  }

  setTeam(
    session: OnlineSession,
    teamId: OnlineRoomTeamId | null
  ): OnlineRoomView {
    if (
      teamId !== null &&
      !["TEAM_1", "TEAM_2", "TEAM_3", "TEAM_4"].includes(teamId)
    ) {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "teamId is invalid"
      );
    }
    const { room, participant } = this.#requireParticipant(session);
    this.#requireOpenRoom(room.roomId);
    if (room.passphraseDigest === null) {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "Teams are available only in hidden brawl"
      );
    }
    const seat = room.seats[participant.seatIndex];
    if (!seat || seat.participantId !== participant.participantId) {
      throw new OnlineRoomError(
        "PARTICIPANT_NOT_FOUND",
        "Participant seat was not found",
        404
      );
    }
    seat.teamId = teamId;
    room.updatedAt = this.#clock();
    return this.#view(room);
  }

  shuffleTeams(session: OnlineSession): OnlineRoomView {
    const room = this.#requireHost(session);
    this.#requireOpenRoom(room.roomId);
    if (room.passphraseDigest === null) {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "Teams are available only in hidden brawl"
      );
    }
    const seats = room.seats.filter(
      (seat) => seat.controller === "HUMAN"
    );
    const random = this.#random(Math.max(1, seats.length));
    for (let index = seats.length - 1; index > 0; index -= 1) {
      const swapIndex = (random[index] ?? 0) % (index + 1);
      [seats[index], seats[swapIndex]] = [
        seats[swapIndex]!,
        seats[index]!
      ];
    }
    const teams: OnlineRoomTeamId[] = [
      "TEAM_1",
      "TEAM_2",
      "TEAM_3",
      "TEAM_4"
    ];
    seats.forEach((seat, index) => {
      seat.teamId = teams[index % teams.length] ?? null;
    });
    room.updatedAt = this.#clock();
    return this.#view(room);
  }

  setEndTimeThreshold(
    session: OnlineSession,
    endTimeThreshold: EndTimeThreshold
  ): OnlineRoomView {
    if (![1, 50, 75, 100, 150].includes(endTimeThreshold)) {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "endTimeThreshold is invalid"
      );
    }
    const room = this.#requireHost(session);
    this.#requireOpenRoom(room.roomId);
    room.endTimeThreshold = endTimeThreshold;
    room.updatedAt = this.#clock();
    return this.#view(room);
  }

  setSeatController(
    session: OnlineSession,
    seatIndex: number,
    controller: "CPU" | "OPEN"
  ): OnlineRoomView {
    const room = this.#requireHost(session);
    this.#requireOpenRoom(room.roomId);
    if (
      !Number.isInteger(seatIndex) ||
      seatIndex < 0 ||
      seatIndex >= room.seats.length
    ) {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "seatIndex is outside this room"
      );
    }
    if (controller !== "CPU" && controller !== "OPEN") {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "controller must be CPU or OPEN"
      );
    }
    const seat = room.seats[seatIndex];
    if (!seat) {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "Seat was not found"
      );
    }
    if (seat.controller === "HUMAN") {
      throw new OnlineRoomError(
        "SEAT_OCCUPIED",
        "A human participant occupies this seat",
        409
      );
    }
    if (controller === "CPU") {
      seat.controller = "CPU";
      seat.cpuDisplayName = this.#uniqueCpuName(room, seatIndex);
      seat.ready = true;
      seat.teamId = null;
    } else {
      seat.controller = null;
      seat.cpuDisplayName = null;
      seat.ready = false;
      seat.teamId = null;
    }
    room.updatedAt = this.#clock();
    return this.#view(room);
  }

  start(
    session: OnlineSession,
    requestId?: string
  ): OnlineRoomStarted {
    const room = this.#requireHost(session);
    const normalizedRequestId = optionalRequestId(requestId);
    return this.#idempotent(
      `start\u0000${room.roomId}\u0000${normalizedRequestId ?? opaqueToken(this.#random, 12)}`,
      { roomId: room.roomId },
      () => {
        this.#requireOpenRoom(room.roomId);
        const occupiedSeats = room.seats.filter(
          ({ controller }) => controller !== null
        );
        if (
          occupiedSeats.length < 2 ||
          (
            room.passphraseDigest === null &&
            occupiedSeats.some(
              (seat) => seat.controller === "HUMAN" && !seat.ready
            )
          )
        ) {
          throw new OnlineRoomError(
            "ROOM_NOT_READY",
            "At least two occupied seats and every human ready are required",
            409
          );
        }
        const orderedSeats = [
          ...occupiedSeats.filter(
            ({ participantId }) =>
              participantId === room.hostParticipantId
          ),
          ...occupiedSeats.filter(
            ({ participantId }) =>
              participantId !== room.hostParticipantId
          )
        ];
        room.status = "STARTING";
        room.updatedAt = this.#clock();
        try {
          const created = this.#matchService.create({
            mode: "ONLINE",
            players: orderedSeats.map((seat) => {
              if (seat.controller === "CPU") {
                return {
                  displayName:
                    seat.cpuDisplayName ?? `CPU ${seat.seatIndex + 1}`,
                  controller: "CPU",
                  teamId: seat.teamId
                };
              }
              const participant = seat.participantId
                ? room.participants.get(seat.participantId)
                : null;
              if (!participant) {
                throw new Error("Human room seat has no participant");
              }
              return {
                displayName: participant.displayName,
                controller: "HUMAN",
                teamId: seat.teamId
              };
            }),
            endTimeThreshold: room.endTimeThreshold
          });
          room.matchId = created.matchId;
          room.status = "STARTED";
          room.expiresAt = new Date(
            requireTimestamp(room.updatedAt) + this.#roomRetentionMs
          ).toISOString();
          room.deleteAt = room.expiresAt;
          for (const participant of room.participants.values()) {
            const runtimeParticipant = created.participants.find(
              ({ displayName, controller }) =>
                controller === "HUMAN" &&
                displayName === participant.displayName
            );
            participant.matchPlayerId =
              runtimeParticipant?.playerId ?? null;
          }
          const host = room.participants.get(room.hostParticipantId);
          const snapshot =
            host ? this.#snapshotForParticipant(room, host) : null;
          if (!snapshot) {
            throw new Error("Started room has no host snapshot");
          }
          return {
            room: this.#view(room),
            matchId: created.matchId,
            snapshot
          };
        } catch (error) {
          room.status = "OPEN";
          room.matchId = null;
          throw error;
        }
      }
    );
  }

  rotateInvitation(
    session: OnlineSession
  ): { room: OnlineRoomView; inviteCode: string } {
    const room = this.#requireHost(session);
    if (room.status === "EXPIRED") {
      throw new OnlineRoomError(
        "ROOM_EXPIRED",
        "The room has expired",
        410
      );
    }
    const inviteCode = opaqueToken(this.#random, INVITE_CODE_BYTES);
    room.inviteDigest = this.#digest("invite", inviteCode);
    room.updatedAt = this.#clock();
    return { room: this.#view(room), inviteCode };
  }

  revokeInvitation(session: OnlineSession): OnlineRoomView {
    const room = this.#requireHost(session);
    room.inviteDigest = null;
    room.updatedAt = this.#clock();
    return this.#view(room);
  }

  leave(session: OnlineSession): OnlineRoomView | null {
    const room = this.#requireSessionRoom(session);
    if (session.role === "SPECTATOR") {
      this.#sessions.revoke(session.sessionId);
      return this.#view(room);
    }
    const participantId = session.participantId;
    const participant = participantId
      ? room.participants.get(participantId)
      : null;
    if (!participant) {
      throw new OnlineRoomError(
        "PARTICIPANT_NOT_FOUND",
        "Participant was not found",
        404
      );
    }
    participant.connected = false;
    this.#sessions.revokeParticipant(room.roomId, participant.participantId);
    const now = this.#clock();
    room.updatedAt = now;
    if (room.status === "OPEN") {
      participant.leftAt = now;
      const seat = room.seats[participant.seatIndex];
      if (seat?.participantId === participant.participantId) {
        seat.controller = null;
        seat.participantId = null;
        seat.cpuDisplayName = null;
        seat.ready = false;
        seat.teamId = null;
      }
      if (room.hostParticipantId === participant.participantId) {
        const successor = this.#randomHostSuccessor(
          room,
          participant.participantId,
          false
        );
        if (successor) {
          room.hostParticipantId = successor.participantId;
          room.hostDisconnectedAt = null;
        } else {
          this.#expire(room, now);
          return null;
        }
      }
    }
    return this.#view(room);
  }

  setConnected(session: OnlineSession, connected: boolean): void {
    if (!session.participantId) return;
    const room = this.#rooms.get(session.roomId);
    const participant = room?.participants.get(session.participantId);
    if (!room || !participant || participant.leftAt !== null) return;
    participant.connected = connected;
    room.updatedAt = this.#clock();
    if (room.hostParticipantId === participant.participantId) {
      room.hostDisconnectedAt = connected ? null : room.updatedAt;
    }
  }

  authorizeMatch(
    session: OnlineSession
  ): OnlineMatchAuthorization | null {
    const room = this.#rooms.get(session.roomId);
    if (
      !room ||
      room.status !== "STARTED" ||
      !room.matchId
    ) {
      return null;
    }
    if (session.role === "SPECTATOR") {
      if (!room.allowSpectators) return null;
      return {
        matchId: room.matchId,
        participantId: null,
        playerId: null,
        viewer: { kind: "SPECTATOR" }
      };
    }
    const participant = session.participantId
      ? room.participants.get(session.participantId)
      : null;
    if (!participant?.matchPlayerId) return null;
    return {
      matchId: room.matchId,
      participantId: participant.participantId,
      playerId: participant.matchPlayerId,
      viewer: {
        kind: "PLAYER",
        playerId: participant.matchPlayerId
      }
    };
  }

  sweep(): { expired: number; deleted: number; transferred: number } {
    const now = this.#clock();
    const nowMs = requireTimestamp(now);
    let expired = 0;
    let deleted = 0;
    let transferred = 0;
    for (const [key, entry] of this.#idempotency) {
      if (entry.expiresAtMs <= nowMs) this.#idempotency.delete(key);
    }
    for (const [roomId, room] of this.#rooms) {
      if (requireTimestamp(room.deleteAt) <= nowMs) {
        this.#rooms.delete(roomId);
        deleted += 1;
        continue;
      }
      if (
        room.status === "OPEN" &&
        requireTimestamp(room.expiresAt) <= nowMs
      ) {
        this.#expire(room, now);
        expired += 1;
        continue;
      }
      if (
        room.status === "OPEN" &&
        room.hostDisconnectedAt !== null &&
        requireTimestamp(room.hostDisconnectedAt) +
          this.#hostDisconnectGraceMs <= nowMs
      ) {
        const successor = this.#randomHostSuccessor(
          room,
          room.hostParticipantId,
          true
        );
        if (successor) {
          room.hostParticipantId = successor.participantId;
          room.hostDisconnectedAt = null;
          room.updatedAt = now;
          transferred += 1;
        } else {
          this.#expire(room, now);
          expired += 1;
        }
      }
    }
    this.#sessions.clearExpired();
    return { expired, deleted, transferred };
  }

  startedMatchIds(): string[] {
    return [...this.#rooms.values()]
      .filter(
        (room): room is OnlineRoom & { matchId: string } =>
          room.status === "STARTED" && room.matchId !== null
      )
      .map((room) => room.matchId);
  }

  exportState(): OnlineRoomServiceSnapshot {
    return {
      schemaVersion: 1,
      rooms: [...this.#rooms.values()].map((room) => ({
        roomId: room.roomId,
        status: room.status,
        hostParticipantId: room.hostParticipantId,
        allowSpectators: room.allowSpectators,
        endTimeThreshold: room.endTimeThreshold,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        expiresAt: room.expiresAt,
        deleteAt: room.deleteAt,
        inviteDigest:
          room.inviteDigest === null
            ? null
            : room.inviteDigest.toString("base64"),
        passphraseDigest:
          room.passphraseDigest === null
            ? null
            : room.passphraseDigest.toString("base64"),
        hostDisconnectedAt: room.hostDisconnectedAt,
        matchId: room.matchId,
        seats: structuredClone(room.seats),
        participants: [...room.participants.values()].map(
          (participant) => ({
            ...participant,
            rejoinDigest: participant.rejoinDigest.toString("base64")
          })
        )
      }))
    };
  }

  restoreState(snapshot: OnlineRoomServiceSnapshot): void {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.rooms)) {
      throw new Error("Online room snapshot is incompatible");
    }
    const restored = new Map<string, OnlineRoom>();
    for (const value of snapshot.rooms) {
      if (
        typeof value.roomId !== "string" ||
        !["OPEN", "STARTING", "STARTED", "EXPIRED"].includes(
          value.status
        ) ||
        typeof value.hostParticipantId !== "string" ||
        !Number.isFinite(Date.parse(value.createdAt)) ||
        !Number.isFinite(Date.parse(value.updatedAt)) ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        !Number.isFinite(Date.parse(value.deleteAt)) ||
        (
          value.hostDisconnectedAt !== null &&
          !Number.isFinite(Date.parse(value.hostDisconnectedAt))
        ) ||
        !Array.isArray(value.seats) ||
        value.seats.length < 2 ||
        value.seats.length > 9 ||
        !Array.isArray(value.participants)
      ) {
        throw new Error("Online room snapshot contains invalid data");
      }
      const inviteDigest =
        value.inviteDigest === null
          ? null
          : Buffer.from(value.inviteDigest, "base64");
      if (inviteDigest !== null && inviteDigest.byteLength !== 32) {
        throw new Error("Online room invitation digest is invalid");
      }
      const passphraseDigest =
        value.passphraseDigest === undefined ||
        value.passphraseDigest === null
          ? null
          : Buffer.from(value.passphraseDigest, "base64");
      if (
        passphraseDigest !== null &&
        passphraseDigest.byteLength !== 32
      ) {
        throw new Error("Online room passphrase digest is invalid");
      }
      const participants = new Map<string, OnlineRoomParticipant>();
      for (const participant of value.participants) {
        const rejoinDigest = Buffer.from(
          participant.rejoinDigest,
          "base64"
        );
        if (
          rejoinDigest.byteLength !== 32 ||
          !Number.isSafeInteger(participant.seatIndex) ||
          participant.seatIndex < 0 ||
          participant.seatIndex >= value.seats.length
        ) {
          throw new Error("Online room participant snapshot is invalid");
        }
        participants.set(participant.participantId, {
          ...participant,
          rejoinDigest
        });
      }
      restored.set(value.roomId, {
        roomId: value.roomId,
        status: value.status,
        hostParticipantId: value.hostParticipantId,
        allowSpectators: value.allowSpectators,
        endTimeThreshold: value.endTimeThreshold,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        expiresAt: value.expiresAt,
        deleteAt: value.deleteAt,
        inviteDigest,
        passphraseDigest,
        hostDisconnectedAt: value.hostDisconnectedAt,
        matchId: value.matchId,
        seats: value.seats.map((seat) => ({
          ...structuredClone(seat),
          teamId: seat.teamId ?? null
        })),
        participants
      });
    }
    this.#rooms.clear();
    for (const [roomId, room] of restored) this.#rooms.set(roomId, room);
    this.sweep();
  }

  #requireRoom(roomId: string): OnlineRoom {
    this.sweep();
    const room = this.#rooms.get(roomId);
    if (!room) {
      throw new OnlineRoomError(
        "ROOM_NOT_FOUND",
        "Room was not found",
        404
      );
    }
    return room;
  }

  #requireOpenRoom(roomId: string): OnlineRoom {
    const room = this.#requireRoom(roomId);
    if (room.status === "EXPIRED") {
      throw new OnlineRoomError(
        "ROOM_EXPIRED",
        "The room has expired",
        410
      );
    }
    if (room.status !== "OPEN") {
      throw new OnlineRoomError(
        "ROOM_STARTED",
        "The room has already started",
        409
      );
    }
    return room;
  }

  #requireSessionRoom(session: OnlineSession): OnlineRoom {
    if (!this.#sessions.isActive(session)) {
      throw new OnlineSessionError(
        "SESSION_INVALID",
        "Online session is no longer active"
      );
    }
    return this.#requireRoom(session.roomId);
  }

  #requireParticipant(
    session: OnlineSession
  ): { room: OnlineRoom; participant: OnlineRoomParticipant } {
    const room = this.#requireSessionRoom(session);
    const participant = session.participantId
      ? room.participants.get(session.participantId)
      : null;
    if (!participant || participant.leftAt !== null) {
      throw new OnlineRoomError(
        "PARTICIPANT_NOT_FOUND",
        "Participant was not found",
        404
      );
    }
    return { room, participant };
  }

  #requireHost(session: OnlineSession): OnlineRoom {
    const { room, participant } = this.#requireParticipant(session);
    if (room.hostParticipantId !== participant.participantId) {
      throw new OnlineRoomError(
        "HOST_REQUIRED",
        "Only the current host can perform this operation",
        403
      );
    }
    return room;
  }

  #requireInvite(room: OnlineRoom, inviteCode: string): void {
    if (
      !safeEqual(
        room.inviteDigest,
        this.#digest("invite", inviteCode)
      )
    ) {
      throw new OnlineRoomError(
        "INVITE_INVALID",
        "Invitation is invalid or has been revoked",
        401
      );
    }
  }

  #openRoomForPassphraseDigest(digest: Buffer): OnlineRoom | null {
    this.sweep();
    return [...this.#rooms.values()].find(
      (room) =>
        room.status === "OPEN" &&
        safeEqual(room.passphraseDigest, digest)
    ) ?? null;
  }

  #admitParticipant(
    room: OnlineRoom,
    displayName: string
  ): OnlineRoomAdmission {
    const nameKey = displayNameKey(displayName);
    if (
      [...room.participants.values()].some(
        (participant) =>
          participant.leftAt === null &&
          displayNameKey(participant.displayName) === nameKey
      ) ||
      room.seats.some(
        (seat) =>
          seat.controller === "CPU" &&
          seat.cpuDisplayName !== null &&
          displayNameKey(seat.cpuDisplayName) === nameKey
      )
    ) {
      throw new OnlineRoomError(
        "DUPLICATE_PARTICIPANT",
        "Display name is already in use",
        409
      );
    }
    const seat = room.seats.find(
      ({ controller }) => controller === null
    );
    if (!seat) {
      throw new OnlineRoomError(
        "ROOM_FULL",
        "The room has no open seat",
        409
      );
    }
    const now = this.#clock();
    const participantId = this.#uniqueParticipantId();
    const rejoinToken = opaqueToken(this.#random, REJOIN_TOKEN_BYTES);
    const participant: OnlineRoomParticipant = {
      participantId,
      displayName,
      seatIndex: seat.seatIndex,
      rejoinDigest: this.#digest("rejoin", rejoinToken),
      joinedAt: now,
      leftAt: null,
      connected: true,
      matchPlayerId: null
    };
    room.participants.set(participantId, participant);
    seat.controller = "HUMAN";
    seat.participantId = participantId;
    seat.cpuDisplayName = null;
    seat.ready = false;
    seat.teamId = null;
    room.updatedAt = now;
    const session = this.#sessions.issue({
      role: "PARTICIPANT",
      roomId: room.roomId,
      participantId
    });
    return {
      room: this.#view(room),
      participantId,
      rejoinToken,
      session,
      snapshot: null
    };
  }

  #activeHumans(room: OnlineRoom): OnlineRoomParticipant[] {
    return [...room.participants.values()]
      .filter(({ leftAt }) => leftAt === null)
      .sort((left, right) => left.seatIndex - right.seatIndex);
  }

  #randomHostSuccessor(
    room: OnlineRoom,
    departingParticipantId: string,
    connectedOnly: boolean
  ): OnlineRoomParticipant | null {
    const candidates = this.#activeHumans(room).filter(
      ({ connected, participantId }) =>
        participantId !== departingParticipantId &&
        (!connectedOnly || connected)
    );
    if (candidates.length === 0) return null;
    const randomByte = this.#random(1)[0] ?? 0;
    return candidates[randomByte % candidates.length] ?? null;
  }

  #view(room: OnlineRoom): OnlineRoomView {
    const seats = room.seats.map((seat): OnlineRoomSeatView => {
      const participant = seat.participantId
        ? room.participants.get(seat.participantId)
        : null;
      return {
        seatIndex: seat.seatIndex,
        controller: seat.controller,
        participantId: participant?.participantId ?? null,
        displayName:
          participant?.displayName ?? seat.cpuDisplayName,
        ready:
          seat.controller === "CPU" ? true : seat.ready,
        connected:
          seat.controller === "CPU" ? true : participant?.connected ?? false,
        isHost:
          participant?.participantId === room.hostParticipantId,
        teamId: seat.teamId
      };
    });
    const occupied = seats.filter(({ controller }) => controller !== null);
    return {
      roomId: room.roomId,
      accessMode:
        room.passphraseDigest === null ? "INVITATION" : "PASSPHRASE",
      status: room.status,
      seatCount: room.seats.length,
      allowSpectators: room.allowSpectators,
      endTimeThreshold: room.endTimeThreshold,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      matchId: room.matchId,
      seats,
      canStart:
        room.status === "OPEN" &&
        occupied.length >= 2 &&
        (
          room.passphraseDigest !== null ||
          occupied.every(
            ({ controller, ready }) => controller === "CPU" || ready
          )
        )
    };
  }

  #snapshotForParticipant(
    room: OnlineRoom,
    participant: OnlineRoomParticipant
  ): GameViewState | null {
    if (!room.matchId || !participant.matchPlayerId) return null;
    return this.#matchService.view(
      room.matchId,
      participant.matchPlayerId
    );
  }

  #expire(room: OnlineRoom, now: string): void {
    room.status = "EXPIRED";
    room.updatedAt = now;
    room.inviteDigest = null;
    room.passphraseDigest = null;
    room.deleteAt = new Date(
      requireTimestamp(now) + this.#roomRetentionMs
    ).toISOString();
    for (const participant of room.participants.values()) {
      this.#sessions.revokeParticipant(
        room.roomId,
        participant.participantId
      );
    }
  }

  #uniqueCpuName(room: OnlineRoom, seatIndex: number): string {
    const used = new Set(
      [
        ...[...room.participants.values()]
          .filter(({ leftAt }) => leftAt === null)
          .map(({ displayName }) => displayName),
        ...room.seats
          .map(({ cpuDisplayName }) => cpuDisplayName)
          .filter((value): value is string => value !== null)
      ].map(displayNameKey)
    );
    let suffix = seatIndex + 1;
    while (used.has(displayNameKey(`CPU ${suffix}`))) suffix += 1;
    return `CPU ${suffix}`;
  }

  #uniqueId(prefix: string, existing: Map<string, unknown>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = `${prefix}_${opaqueToken(this.#random, ROOM_ID_BYTES)}`;
      if (!existing.has(id)) return id;
    }
    throw new Error(`Unable to allocate ${prefix} identifier`);
  }

  #uniqueParticipantId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = `participant_${opaqueToken(
        this.#random,
        PARTICIPANT_ID_BYTES
      )}`;
      const exists = [...this.#rooms.values()].some(
        ({ participants }) => participants.has(id)
      );
      if (!exists) return id;
    }
    throw new Error("Unable to allocate participant identifier");
  }

  #digest(namespace: string, value: string): Buffer {
    return createHmac("sha256", this.#secret)
      .update(`${namespace}\u0000${value}`, "utf8")
      .digest();
  }

  #idempotent<T>(
    key: string,
    input: unknown,
    operation: () => T
  ): T {
    const fingerprint = canonical(input);
    const existing = this.#idempotency.get(key);
    if (existing) {
      if (existing.expiresAtMs <= requireTimestamp(this.#clock())) {
        this.#idempotency.delete(key);
        return this.#idempotent(key, input, operation);
      }
      if (existing.fingerprint !== fingerprint) {
        throw new OnlineRoomError(
          "IDEMPOTENCY_CONFLICT",
          "requestId was already used with another request",
          409
        );
      }
      return structuredClone(existing.result) as T;
    }
    const result = operation();
    this.#idempotency.set(key, {
      fingerprint,
      result: structuredClone(result),
      expiresAtMs:
        requireTimestamp(this.#clock()) + IDEMPOTENCY_RESPONSE_TTL_MS
    });
    return result;
  }
}

export type OnlineRoomHttpHandlerOptions = {
  maxRequestBodyBytes?: number;
  rateLimiter?: RateLimiter | null;
  commit?: () => void;
};

export type OnlineRoomHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new OnlineRoomError(
        "INVALID_REQUEST",
        "Request body is too large",
        413
      );
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new OnlineRoomError(
      "INVALID_REQUEST",
      "Request body is not valid JSON"
    );
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  session?: IssuedOnlineSession
): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (session) response.setHeader("set-cookie", session.cookie);
  response.end(JSON.stringify(body));
}

function roomPath(
  pathname: string
): { roomId: string; action: string | null; seatIndex: number | null } | null {
  const match =
    /^\/api\/rooms\/([^/]+)(?:\/(join|rejoin|spectate|ready|team|shuffle-teams|end-time|start|leave|match|session|invitation|seats)(?:\/([^/]+))?)?\/?$/u
      .exec(pathname);
  if (!match?.[1]) return null;
  let roomId: string;
  try {
    roomId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const action = match[2] ?? null;
  const seatIndex =
    action === "seats" && match[3] !== undefined
      ? Number(match[3])
      : null;
  return { roomId, action, seatIndex };
}

function inviteUrl(request: IncomingMessage, roomId: string, code: string): string {
  const origin = request.headers.origin;
  const base =
    typeof origin === "string"
      ? origin
      : `http://${request.headers.host ?? "localhost"}`;
  const url = new URL("/", base);
  url.searchParams.set("room", roomId);
  url.searchParams.set("invite", code);
  return url.toString();
}

export function createOnlineRoomHttpHandler(
  service: OnlineRoomService,
  sessions: OnlineSessionStore,
  options: OnlineRoomHttpHandlerOptions = {}
): OnlineRoomHttpHandler {
  const maxRequestBodyBytes =
    options.maxRequestBodyBytes ?? MAX_COMMAND_BODY_BYTES;
  const rateLimiter =
    options.rateLimiter === undefined
      ? new FixedWindowRateLimiter({ limit: 30, windowMs: 10_000 })
      : options.rateLimiter;
  const commit = options.commit ?? (() => {});
  return async (request, response) => {
    try {
      const pathname = new URL(
        request.url ?? "/",
        "http://localhost"
      ).pathname;
      if (pathname === "/api/rooms" || pathname === "/api/rooms/") {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, {
            ok: false,
            code: "INVALID_REQUEST",
            message: "Only POST is supported"
          });
          return;
        }
        if (!sessions.originAllowed(request)) {
          throw new OnlineSessionError(
            "ORIGIN_REJECTED",
            "Request origin is not allowed",
            403
          );
        }
        const key = request.socket.remoteAddress ?? "unknown";
        const rate = rateLimiter?.consume(`room-create\u0000${key}`);
        if (rate && !rate.allowed) {
          writeJson(response, 429, {
            ok: false,
            code: "RATE_LIMITED",
            message: "Too many room creation requests"
          });
          return;
        }
        const body = parseCreateOnlineRoomRequest(
          await readJsonBody(request, maxRequestBodyBytes)
        );
        const requestId =
          request.headers["idempotency-key"] ?? body.requestId;
        const created = service.create({
          ...body,
          ...(typeof requestId === "string" ? { requestId } : {})
        });
        commit();
        writeJson(response, 201, {
          ok: true,
          room: created.room,
          participantId: created.participantId,
          rejoinToken: created.rejoinToken,
          csrfToken: created.session.csrfToken,
          ...(body.passphrase === undefined
            ? {
                inviteUrl: inviteUrl(
                  request,
                  created.room.roomId,
                  created.inviteCode
                )
              }
            : {})
        }, created.session);
        return;
      }

      if (
        pathname === "/api/rooms/join" ||
        pathname === "/api/rooms/join/"
      ) {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, {
            ok: false,
            code: "INVALID_REQUEST",
            message: "Only POST is supported"
          });
          return;
        }
        if (!sessions.originAllowed(request)) {
          throw new OnlineSessionError(
            "ORIGIN_REJECTED",
            "Request origin is not allowed",
            403
          );
        }
        const key = request.socket.remoteAddress ?? "unknown";
        const rate = rateLimiter?.consume(
          `room-passphrase-join\u0000${key}`
        );
        if (rate && !rate.allowed) {
          writeJson(response, 429, {
            ok: false,
            code: "RATE_LIMITED",
            message: "Too many room join requests"
          });
          return;
        }
        const body = parsePassphraseJoinRequest(
          await readJsonBody(request, maxRequestBodyBytes)
        );
        const requestId =
          request.headers["idempotency-key"] ?? body.requestId;
        const joined = service.joinByPassphrase({
          ...body,
          ...(typeof requestId === "string" ? { requestId } : {})
        });
        commit();
        writeJson(response, 200, {
          ok: true,
          room: joined.room,
          participantId: joined.participantId,
          rejoinToken: joined.rejoinToken,
          csrfToken: joined.session.csrfToken
        }, joined.session);
        return;
      }

      const route = roomPath(pathname);
      if (!route) {
        writeJson(response, 404, {
          ok: false,
          code: "ROOM_NOT_FOUND",
          message: "Room route was not found"
        });
        return;
      }
      if (request.method === "POST" && route.action === "join") {
        if (!sessions.originAllowed(request)) {
          throw new OnlineSessionError(
            "ORIGIN_REJECTED",
            "Request origin is not allowed",
            403
          );
        }
        const rate = rateLimiter?.consume(
          `room-join\u0000${route.roomId}\u0000${request.socket.remoteAddress ?? "unknown"}`
        );
        if (rate && !rate.allowed) {
          writeJson(response, 429, {
            ok: false,
            code: "RATE_LIMITED",
            message: "Too many room join requests"
          });
          return;
        }
        const body = parseJoinRequest(
          await readJsonBody(request, maxRequestBodyBytes)
        );
        const requestId =
          request.headers["idempotency-key"] ?? body.requestId;
        const joined = service.join(route.roomId, {
          ...body,
          ...(typeof requestId === "string" ? { requestId } : {})
        });
        commit();
        writeJson(response, 200, {
          ok: true,
          room: joined.room,
          participantId: joined.participantId,
          rejoinToken: joined.rejoinToken,
          csrfToken: joined.session.csrfToken
        }, joined.session);
        return;
      }
      if (request.method === "POST" && route.action === "rejoin") {
        if (!sessions.originAllowed(request)) {
          throw new OnlineSessionError(
            "ORIGIN_REJECTED",
            "Request origin is not allowed",
            403
          );
        }
        const rate = rateLimiter?.consume(
          `room-rejoin\u0000${route.roomId}\u0000${request.socket.remoteAddress ?? "unknown"}`
        );
        if (rate && !rate.allowed) {
          writeJson(response, 429, {
            ok: false,
            code: "RATE_LIMITED",
            message: "Too many room rejoin requests"
          });
          return;
        }
        const body = parseRejoinRequest(
          await readJsonBody(request, maxRequestBodyBytes)
        );
        const requestId =
          request.headers["idempotency-key"] ?? body.requestId;
        const joined = service.rejoin(route.roomId, {
          ...body,
          ...(typeof requestId === "string" ? { requestId } : {})
        });
        commit();
        writeJson(response, 200, {
          ok: true,
          room: joined.room,
          participantId: joined.participantId,
          csrfToken: joined.session.csrfToken,
          snapshot: joined.snapshot
        }, joined.session);
        return;
      }
      if (request.method === "POST" && route.action === "spectate") {
        if (!sessions.originAllowed(request)) {
          throw new OnlineSessionError(
            "ORIGIN_REJECTED",
            "Request origin is not allowed",
            403
          );
        }
        const rate = rateLimiter?.consume(
          `room-spectate\u0000${route.roomId}\u0000${request.socket.remoteAddress ?? "unknown"}`
        );
        if (rate && !rate.allowed) {
          writeJson(response, 429, {
            ok: false,
            code: "RATE_LIMITED",
            message: "Too many spectator requests"
          });
          return;
        }
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (!isRecord(body) || !hasOnlyKeys(body, ["inviteCode"])) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "Spectator request is invalid"
          );
        }
        const admitted = service.spectate(
          route.roomId,
          requireSafeToken(body.inviteCode, "inviteCode")
        );
        commit();
        writeJson(response, 200, {
          ok: true,
          room: admitted.room,
          csrfToken: admitted.session.csrfToken,
          snapshot: admitted.snapshot
        }, admitted.session);
        return;
      }

      const unsafe = request.method !== "GET" && request.method !== "HEAD";
      const session = sessions.requireRequest(request, {
        origin: unsafe,
        csrf: unsafe
      });
      if (session.roomId !== route.roomId) {
        throw new OnlineSessionError(
          "SESSION_INVALID",
          "Session does not belong to this room",
          403
        );
      }
      if (request.method === "GET" && route.action === null) {
        writeJson(response, 200, {
          ok: true,
          room: service.view(session)
        });
        return;
      }
      if (request.method === "GET" && route.action === "match") {
        writeJson(response, 200, {
          ok: true,
          snapshot: service.snapshot(session)
        });
        return;
      }
      if (request.method === "POST" && route.action === "ready") {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (!isRecord(body) || !hasOnlyKeys(body, ["ready"])) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "Ready request is invalid"
          );
        }
        const room = service.setReady(session, body.ready as boolean);
        commit();
        writeJson(response, 200, {
          ok: true,
          room
        });
        return;
      }
      if (request.method === "POST" && route.action === "team") {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (
          !isRecord(body) ||
          !hasOnlyKeys(body, ["teamId"]) ||
          (
            body.teamId !== null &&
            !["TEAM_1", "TEAM_2", "TEAM_3", "TEAM_4"].includes(
              body.teamId as string
            )
          )
        ) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "Team request is invalid"
          );
        }
        const room = service.setTeam(
          session,
          body.teamId as OnlineRoomTeamId | null
        );
        commit();
        writeJson(response, 200, { ok: true, room });
        return;
      }
      if (
        request.method === "POST" &&
        route.action === "shuffle-teams"
      ) {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (!isRecord(body) || !hasOnlyKeys(body, [])) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "Team shuffle request is invalid"
          );
        }
        const room = service.shuffleTeams(session);
        commit();
        writeJson(response, 200, { ok: true, room });
        return;
      }
      if (request.method === "POST" && route.action === "end-time") {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (
          !isRecord(body) ||
          !hasOnlyKeys(body, ["endTimeThreshold"]) ||
          ![1, 50, 75, 100, 150].includes(
            body.endTimeThreshold as number
          )
        ) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "End-time request is invalid"
          );
        }
        const room = service.setEndTimeThreshold(
          session,
          body.endTimeThreshold as EndTimeThreshold
        );
        commit();
        writeJson(response, 200, { ok: true, room });
        return;
      }
      if (
        request.method === "PATCH" &&
        route.action === "seats" &&
        route.seatIndex !== null
      ) {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (
          !isRecord(body) ||
          !hasOnlyKeys(body, ["controller"]) ||
          (body.controller !== "CPU" && body.controller !== "OPEN")
        ) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "Seat request is invalid"
          );
        }
        const room = service.setSeatController(
          session,
          route.seatIndex,
          body.controller
        );
        commit();
        writeJson(response, 200, {
          ok: true,
          room
        });
        return;
      }
      if (request.method === "POST" && route.action === "start") {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (!isRecord(body) || !hasOnlyKeys(body, ["requestId"])) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "Start request is invalid"
          );
        }
        const requestId =
          request.headers["idempotency-key"] ?? body.requestId;
        const started = service.start(
          session,
          typeof requestId === "string" ? requestId : undefined
        );
        commit();
        writeJson(response, 200, {
          ok: true,
          ...started
        });
        return;
      }
      if (request.method === "POST" && route.action === "invitation") {
        const body = await readJsonBody(request, maxRequestBodyBytes);
        if (
          !isRecord(body) ||
          !hasOnlyKeys(body, ["operation"]) ||
          (body.operation !== "ROTATE" && body.operation !== "REVOKE")
        ) {
          throw new OnlineRoomError(
            "INVALID_REQUEST",
            "Invitation request is invalid"
          );
        }
        if (body.operation === "REVOKE") {
          const room = service.revokeInvitation(session);
          commit();
          writeJson(response, 200, {
            ok: true,
            room
          });
          return;
        }
        const rotated = service.rotateInvitation(session);
        commit();
        writeJson(response, 200, {
          ok: true,
          room: rotated.room,
          inviteUrl: inviteUrl(
            request,
            rotated.room.roomId,
            rotated.inviteCode
          )
        });
        return;
      }
      if (request.method === "POST" && route.action === "session") {
        const rotated = sessions.rotate(request.headers.cookie);
        commit();
        writeJson(response, 200, {
          ok: true,
          csrfToken: rotated.csrfToken,
          expiresAt: rotated.session.expiresAt
        }, rotated);
        return;
      }
      if (request.method === "POST" && route.action === "leave") {
        const room = service.leave(session);
        commit();
        response.setHeader("set-cookie", sessions.clearCookie());
        writeJson(response, 200, { ok: true, room });
        return;
      }
      response.setHeader("allow", "GET, POST, PATCH");
      writeJson(response, 405, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Method is not supported for this room route"
      });
    } catch (error) {
      const failure =
        error instanceof OnlineRoomError ||
        error instanceof OnlineSessionError ||
        error instanceof RuntimeMatchError
          ? error
          : new OnlineRoomError(
              "INVALID_REQUEST",
              "Room request could not be processed"
            );
      writeJson(response, failure.status, {
        ok: false,
        code: failure.code,
        message: failure.message
      });
    }
  };
}
