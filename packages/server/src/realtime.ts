import type {
  DomainEvent,
  MatchState
} from "../../shared/src/model.ts";
import type {
  MatchSyncRequest,
  RealtimeEventBatch,
  RealtimeFullSnapshot,
  RealtimeMatchMessage,
  RealtimeSyncError,
  RealtimeViewer
} from "../../shared/src/protocol.ts";
import {
  projectDomainEvent,
  projectGameView
} from "./projection.ts";
import { syncFailureAudit } from "./persistence.ts";
import type { OperationalAuditLog } from "./persistence.ts";
import {
  assertNoServerSecrets,
  isSafeIdentifier,
  MAX_REALTIME_REQUEST_BYTES,
  serializedByteLength
} from "./security.ts";

const DEFAULT_EVENT_HISTORY_LIMIT = 512;
const DEFAULT_RECENT_IMPORTANT_EVENT_LIMIT = 12;

const IMPORTANT_REPLAY_EVENT_TYPES = new Set<DomainEvent["type"]>([
  "ACTION_DECLARED",
  "ATTACK_CREATED",
  "ATTACK_REDIRECTED",
  "REACTION_REQUESTED",
  "REACTION_DECLARED",
  "RESOURCES_EXCHANGED",
  "TRADE_OFFERED",
  "TRADE_RESOLVED",
  "RESOURCE_CHANGED",
  "DAMAGE_APPLIED",
  "REVIVAL_RESOLVED",
  "DEMON_APPEARED",
  "CARD_GRANTED",
  "PLAYER_ASCENDED",
  "INPUT_TIMED_OUT",
  "PLAYER_CONNECTION_CHANGED",
  "MATCH_ENDED"
]);

type RealtimeSubscriber = {
  viewer: RealtimeViewer;
  eventSeq: number;
  send: (message: RealtimeMatchMessage) => void;
};

type MatchChannel = {
  state: MatchState;
  history: DomainEvent[];
  subscribers: Set<RealtimeSubscriber>;
};

export type RealtimeHubOptions = {
  eventHistoryLimit?: number;
  recentImportantEventLimit?: number;
  clock?: () => string;
  audit?: OperationalAuditLog;
};

export type RealtimeSubscriptionInput = {
  request: MatchSyncRequest;
  viewer: RealtimeViewer;
  send: (message: RealtimeMatchMessage) => void;
};

export type RealtimeTextSocket = {
  send(data: string): void;
};

export type RealtimeSocketConnectionInput = {
  request: unknown;
  viewer: RealtimeViewer;
  socket: RealtimeTextSocket;
};

export type RealtimePrincipal = {
  subjectId: string;
};

export type AuthorizedRealtimeSocketConnectionInput = {
  request: unknown;
  credentials: unknown;
  socket: RealtimeTextSocket;
};

export type RealtimeSocketSecurity = {
  authenticate(credentials: unknown): RealtimePrincipal | null;
  authorize(
    principal: RealtimePrincipal,
    matchId: string
  ): RealtimeViewer | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function viewerPlayerId(viewer: RealtimeViewer): string | null {
  return viewer.kind === "PLAYER" ? viewer.playerId : null;
}

function syncError(
  code: RealtimeSyncError["code"],
  message: string,
  matchId: string | null
): RealtimeSyncError {
  return {
    type: "SYNC_ERROR",
    matchId,
    code,
    message
  };
}

function eventSequenceIsContiguous(events: readonly DomainEvent[]): boolean {
  return events.every(
    (event, index) =>
      index === 0 ||
      event.eventSeq === (events[index - 1]?.eventSeq ?? 0) + 1
  );
}

function projectEvents(
  events: readonly DomainEvent[],
  viewer: RealtimeViewer
): DomainEvent[] {
  const playerId = viewerPlayerId(viewer);
  return events.flatMap((event) => {
    const projected = projectDomainEvent(event, playerId);
    return projected ? [projected] : [];
  });
}

function isImportantReplayEvent(event: DomainEvent): boolean {
  return IMPORTANT_REPLAY_EVENT_TYPES.has(event.type);
}

function assertSafeRealtimePayload(value: unknown): void {
  assertNoServerSecrets(value);
}

export function parseMatchSyncRequest(
  value: unknown
): MatchSyncRequest | null {
  if (!isRecord(value)) return null;
  if (serializedByteLength(value) > MAX_REALTIME_REQUEST_BYTES) return null;
  if (
    Object.keys(value).some(
      (key) => !["type", "matchId", "lastEventSeq"].includes(key)
    )
  ) {
    return null;
  }
  if (
    value.type !== "SYNC_MATCH" ||
    !isSafeIdentifier(value.matchId) ||
    (value.lastEventSeq !== null &&
      !isNonNegativeInteger(value.lastEventSeq))
  ) {
    return null;
  }
  return {
    type: "SYNC_MATCH",
    matchId: value.matchId,
    lastEventSeq: value.lastEventSeq
  };
}

export class RealtimeMatchHub {
  readonly #eventHistoryLimit: number;
  readonly #recentImportantEventLimit: number;
  readonly #clock: () => string;
  readonly #audit: OperationalAuditLog | undefined;
  readonly #matches = new Map<string, MatchChannel>();

  constructor(options: RealtimeHubOptions = {}) {
    this.#eventHistoryLimit =
      options.eventHistoryLimit ?? DEFAULT_EVENT_HISTORY_LIMIT;
    this.#recentImportantEventLimit =
      options.recentImportantEventLimit ??
      DEFAULT_RECENT_IMPORTANT_EVENT_LIMIT;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#audit = options.audit;
    assertPositiveInteger(this.#eventHistoryLimit, "eventHistoryLimit");
    assertPositiveInteger(
      this.#recentImportantEventLimit,
      "recentImportantEventLimit"
    );
  }

  registerMatch(
    state: MatchState,
    completeOrRecentHistory: readonly DomainEvent[] = []
  ): void {
    this.#validateHistory(state, completeOrRecentHistory);
    const current = this.#matches.get(state.matchId);
    const channel: MatchChannel = {
      state,
      history: this.#trimHistory(completeOrRecentHistory),
      subscribers: current?.subscribers ?? new Set()
    };
    this.#matches.set(state.matchId, channel);
    if (current && state.eventSequence !== current.state.eventSequence) {
      this.#broadcastFullSnapshots(channel, "EVENT_HISTORY_UNAVAILABLE");
    }
  }

  publish(state: MatchState, events: readonly DomainEvent[]): void {
    const channel = this.#matches.get(state.matchId);
    if (!channel) {
      this.registerMatch(state, events);
      return;
    }
    const previousEventSeq = channel.state.eventSequence;
    if (state.eventSequence < previousEventSeq) {
      throw new Error("Cannot publish a state older than the realtime channel");
    }
    const newEvents = events.filter(
      ({ eventSeq }) => eventSeq > previousEventSeq
    );
    if (state.eventSequence === previousEventSeq) {
      if (newEvents.length > 0) {
        throw new Error("New events cannot accompany an unchanged state");
      }
      return;
    }
    if (
      newEvents[0]?.eventSeq !== previousEventSeq + 1 ||
      newEvents.at(-1)?.eventSeq !== state.eventSequence ||
      !eventSequenceIsContiguous(newEvents)
    ) {
      throw new Error("Published events do not bridge the realtime sequence");
    }
    for (const event of newEvents) {
      if (event.revision > state.revision) {
        throw new Error("Published event revision is newer than match state");
      }
    }

    channel.state = state;
    channel.history = this.#trimHistory([
      ...channel.history,
      ...newEvents
    ]);
    for (const subscriber of [...channel.subscribers]) {
      const message = this.#eventBatch(
        channel,
        subscriber.viewer,
        subscriber.eventSeq,
        newEvents
      );
      try {
        subscriber.send(message);
        subscriber.eventSeq = state.eventSequence;
      } catch {
        channel.subscribers.delete(subscriber);
      }
    }
  }

  synchronize(
    request: MatchSyncRequest,
    viewer: RealtimeViewer
  ): RealtimeMatchMessage {
    const channel = this.#matches.get(request.matchId);
    if (!channel) {
      this.recordSyncFailure(
        request.matchId,
        "MATCH_NOT_FOUND",
        viewer,
        null
      );
      return syncError(
        "MATCH_NOT_FOUND",
        "Match was not found",
        request.matchId
      );
    }
    const playerId = viewerPlayerId(viewer);
    if (playerId !== null && !channel.state.players[playerId]) {
      this.recordSyncFailure(
        request.matchId,
        "VIEWER_NOT_ALLOWED",
        viewer,
        channel.state.eventSequence
      );
      return syncError(
        "VIEWER_NOT_ALLOWED",
        "Player does not belong to this match",
        request.matchId
      );
    }
    const currentEventSeq = channel.state.eventSequence;
    if (request.lastEventSeq === null) {
      return this.#fullSnapshot(channel, viewer, "INITIAL_SYNC");
    }
    if (request.lastEventSeq > currentEventSeq) {
      this.recordSyncFailure(
        request.matchId,
        "CLIENT_AHEAD",
        viewer,
        currentEventSeq
      );
      return this.#fullSnapshot(channel, viewer, "CLIENT_AHEAD");
    }
    const firstRetainedEventSeq =
      channel.history[0]?.eventSeq ?? currentEventSeq + 1;
    if (request.lastEventSeq < firstRetainedEventSeq - 1) {
      this.recordSyncFailure(
        request.matchId,
        "EVENT_HISTORY_UNAVAILABLE",
        viewer,
        currentEventSeq
      );
      return this.#fullSnapshot(
        channel,
        viewer,
        "EVENT_HISTORY_UNAVAILABLE"
      );
    }
    return this.#eventBatch(
      channel,
      viewer,
      request.lastEventSeq,
      channel.history.filter(
        ({ eventSeq }) => eventSeq > request.lastEventSeq!
      )
    );
  }

  recordSyncFailure(
    matchId: string,
    code: string,
    viewer: RealtimeViewer | null,
    eventSeq: number | null
  ): void {
    if (!this.#audit) return;
    this.#audit.record(syncFailureAudit({
      occurredAt: this.#clock(),
      matchId,
      viewerKind: viewer?.kind ?? "UNKNOWN",
      viewerId: viewer?.kind === "PLAYER" ? viewer.playerId : null,
      code,
      eventSeq
    }));
  }

  subscribe(input: RealtimeSubscriptionInput): () => void {
    const initial = this.synchronize(input.request, input.viewer);
    assertSafeRealtimePayload(initial);
    input.send(initial);
    if (initial.type === "SYNC_ERROR") return () => {};
    const channel = this.#matches.get(input.request.matchId);
    if (!channel) return () => {};
    const subscriber: RealtimeSubscriber = {
      viewer: input.viewer,
      eventSeq: initial.eventSeq,
      send: input.send
    };
    channel.subscribers.add(subscriber);
    return () => {
      channel.subscribers.delete(subscriber);
    };
  }

  #eventBatch(
    channel: MatchChannel,
    viewer: RealtimeViewer,
    afterEventSeq: number,
    events: readonly DomainEvent[]
  ): RealtimeEventBatch {
    const message: RealtimeEventBatch = {
      type: "EVENT_BATCH",
      matchId: channel.state.matchId,
      afterEventSeq,
      eventSeq: channel.state.eventSequence,
      events: projectEvents(events, viewer),
      snapshot: projectGameView(
        channel.state,
        viewerPlayerId(viewer)
      )
    };
    assertSafeRealtimePayload(message);
    return message;
  }

  #fullSnapshot(
    channel: MatchChannel,
    viewer: RealtimeViewer,
    reason: RealtimeFullSnapshot["reason"]
  ): RealtimeFullSnapshot {
    const importantEvents = channel.history
      .filter(isImportantReplayEvent)
      .slice(-this.#recentImportantEventLimit);
    const message: RealtimeFullSnapshot = {
      type: "FULL_SNAPSHOT",
      matchId: channel.state.matchId,
      eventSeq: channel.state.eventSequence,
      reason,
      recentEvents: projectEvents(importantEvents, viewer),
      snapshot: projectGameView(
        channel.state,
        viewerPlayerId(viewer)
      )
    };
    assertSafeRealtimePayload(message);
    return message;
  }

  #broadcastFullSnapshots(
    channel: MatchChannel,
    reason: RealtimeFullSnapshot["reason"]
  ): void {
    for (const subscriber of [...channel.subscribers]) {
      const message = this.#fullSnapshot(
        channel,
        subscriber.viewer,
        reason
      );
      try {
        subscriber.send(message);
        subscriber.eventSeq = channel.state.eventSequence;
      } catch {
        channel.subscribers.delete(subscriber);
      }
    }
  }

  #trimHistory(events: readonly DomainEvent[]): DomainEvent[] {
    return structuredClone(events.slice(-this.#eventHistoryLimit));
  }

  #validateHistory(
    state: MatchState,
    history: readonly DomainEvent[]
  ): void {
    if (history.length === 0) return;
    if (
      !eventSequenceIsContiguous(history) ||
      history.at(-1)?.eventSeq !== state.eventSequence
    ) {
      throw new Error("Realtime history must be contiguous and current");
    }
    for (const event of history) {
      if (event.revision > state.revision) {
        throw new Error("Realtime history revision is newer than match state");
      }
    }
  }
}

export function connectRealtimeSocket(
  hub: RealtimeMatchHub,
  input: RealtimeSocketConnectionInput
): () => void {
  const request = parseMatchSyncRequest(input.request);
  if (!request) {
    hub.recordSyncFailure(
      isRecord(input.request) && typeof input.request.matchId === "string"
        ? input.request.matchId
        : "invalid-match-id",
      "INVALID_REQUEST",
      input.viewer,
      null
    );
    const error = syncError(
      "INVALID_REQUEST",
      "SYNC_MATCH request is invalid",
      isRecord(input.request) && typeof input.request.matchId === "string"
        ? input.request.matchId
        : null
    );
    assertSafeRealtimePayload(error);
    input.socket.send(JSON.stringify(error));
    return () => {};
  }
  return hub.subscribe({
    request,
    viewer: input.viewer,
    send: (message) => {
      input.socket.send(JSON.stringify(message));
    }
  });
}

export function connectAuthorizedRealtimeSocket(
  hub: RealtimeMatchHub,
  input: AuthorizedRealtimeSocketConnectionInput,
  security: RealtimeSocketSecurity
): () => void {
  const request = parseMatchSyncRequest(input.request);
  if (!request) {
    return connectRealtimeSocket(hub, {
      request: input.request,
      viewer: { kind: "SPECTATOR" },
      socket: input.socket
    });
  }
  let principal: RealtimePrincipal | null;
  try {
    principal = security.authenticate(input.credentials);
  } catch {
    principal = null;
  }
  if (!principal || !isSafeIdentifier(principal.subjectId)) {
    hub.recordSyncFailure(
      request.matchId,
      "UNAUTHENTICATED",
      null,
      null
    );
    const error = syncError(
      "UNAUTHENTICATED",
      "Realtime authentication is required",
      request.matchId
    );
    assertSafeRealtimePayload(error);
    input.socket.send(JSON.stringify(error));
    return () => {};
  }
  let viewer: RealtimeViewer | null;
  try {
    viewer = security.authorize(principal, request.matchId);
  } catch {
    viewer = null;
  }
  if (!viewer) {
    hub.recordSyncFailure(
      request.matchId,
      "VIEWER_NOT_ALLOWED",
      null,
      null
    );
    const error = syncError(
      "VIEWER_NOT_ALLOWED",
      "Viewer is not allowed to access this match",
      request.matchId
    );
    assertSafeRealtimePayload(error);
    input.socket.send(JSON.stringify(error));
    return () => {};
  }
  return connectRealtimeSocket(hub, {
    request,
    viewer,
    socket: input.socket
  });
}
