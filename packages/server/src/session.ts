import type {
  DomainEvent,
  GameCommand,
  MatchState
} from "../../shared/src/model.ts";
import { handleCpuDecision } from "./cpu.ts";
import { applyEvent, pendingInputPlayerId } from "./engine.ts";

const DEFAULT_MAX_CPU_DECISIONS = 512;
const PUBLIC_VISIBILITY = { scope: "PUBLIC" } as const;

export type CpuAdvanceResult = {
  state: MatchState;
  events: DomainEvent[];
  commands: GameCommand[];
  decisionLimitReached: boolean;
};

export type InputDeadlineResult = CpuAdvanceResult & {
  timedOutPlayerId: string | null;
};

export type ConnectionTransitionResult = {
  state: MatchState;
  events: DomainEvent[];
};

function requireIsoDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return value;
}

function inputTimedOutEvent(
  state: MatchState,
  playerId: string,
  inputDeadlineAt: string,
  occurredAt: string
): Extract<DomainEvent, { type: "INPUT_TIMED_OUT" }> {
  return {
    type: "INPUT_TIMED_OUT",
    eventSeq: state.eventSequence + 1,
    revision: state.revision + 1,
    occurredAt,
    visibility: PUBLIC_VISIBILITY,
    playerId,
    inputDeadlineAt
  };
}

function connectionChangedEvent(
  state: MatchState,
  playerId: string,
  connected: boolean,
  occurredAt: string
): Extract<DomainEvent, { type: "PLAYER_CONNECTION_CHANGED" }> {
  return {
    type: "PLAYER_CONNECTION_CHANGED",
    eventSeq: state.eventSequence + 1,
    revision: state.revision + 1,
    occurredAt,
    visibility: PUBLIC_VISIBILITY,
    playerId,
    connectionState: connected ? "CONNECTED" : "DISCONNECTED"
  };
}

export function advanceCpuControllers(
  state: MatchState,
  occurredAt: string,
  maxDecisions = DEFAULT_MAX_CPU_DECISIONS
): CpuAdvanceResult {
  const serverTime = requireIsoDate(occurredAt);
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1) {
    throw new Error("maxDecisions must be a positive integer");
  }
  let current = state;
  const events: DomainEvent[] = [];
  const commands: GameCommand[] = [];

  while (commands.length < maxDecisions) {
    const playerId = pendingInputPlayerId(current);
    if (!playerId || current.players[playerId]?.controller !== "CPU") {
      return {
        state: current,
        events,
        commands,
        decisionLimitReached: false
      };
    }
    const handled = handleCpuDecision(current, playerId, {
      occurredAt: serverTime
    });
    if (!handled) {
      return {
        state: current,
        events,
        commands,
        decisionLimitReached: false
      };
    }
    if (!handled.result.ok) {
      throw new Error(
        `CPU command ${handled.command.commandId} failed: ${handled.result.code}`
      );
    }
    commands.push(handled.command);
    events.push(...handled.result.events);
    current = handled.result.state;
  }

  return {
    state: current,
    events,
    commands,
    decisionLimitReached:
      current.players[pendingInputPlayerId(current) ?? ""]?.controller === "CPU"
  };
}

export function processInputDeadline(
  state: MatchState,
  occurredAt: string,
  maxCpuDecisions = DEFAULT_MAX_CPU_DECISIONS
): InputDeadlineResult {
  const serverTime = requireIsoDate(occurredAt);
  const noTimeout = (): InputDeadlineResult => ({
    state,
    events: [],
    commands: [],
    decisionLimitReached: false,
    timedOutPlayerId: null
  });
  if (state.mode !== "ONLINE" || state.inputDeadlineAt === null) {
    return noTimeout();
  }
  if (Date.parse(serverTime) < Date.parse(state.inputDeadlineAt)) {
    return noTimeout();
  }
  const playerId = pendingInputPlayerId(state);
  const player = playerId ? state.players[playerId] : undefined;
  if (!playerId || !player || player.controller !== "HUMAN") {
    return noTimeout();
  }

  const timeoutEvent = inputTimedOutEvent(
    state,
    playerId,
    state.inputDeadlineAt,
    serverTime
  );
  const timedOutState = applyEvent(state, timeoutEvent);
  const advanced = advanceCpuControllers(
    timedOutState,
    serverTime,
    maxCpuDecisions
  );
  return {
    ...advanced,
    events: [timeoutEvent, ...advanced.events],
    timedOutPlayerId: playerId
  };
}

export function setPlayerConnectionState(
  state: MatchState,
  playerId: string,
  connected: boolean,
  occurredAt: string
): ConnectionTransitionResult {
  const serverTime = requireIsoDate(occurredAt);
  const player = state.players[playerId];
  if (!player) throw new Error(`Unknown player ${playerId}`);
  if (player.disconnected === !connected) {
    return { state, events: [] };
  }
  const event = connectionChangedEvent(
    state,
    playerId,
    connected,
    serverTime
  );
  return {
    state: applyEvent(state, event),
    events: [event]
  };
}
