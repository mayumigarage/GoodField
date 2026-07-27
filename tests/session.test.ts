import assert from "node:assert/strict";
import test from "node:test";

import {
  initialUiState,
  synchronizeUiState
} from "../packages/client/src/ui-machine.ts";
import {
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";
import {
  advanceCpuControllers,
  processInputDeadline,
  setPlayerConnectionState
} from "../packages/server/src/session.ts";
import type {
  CardInstance,
  MatchState
} from "../packages/shared/src/model.ts";

const STARTED_AT = "2026-07-26T00:00:00.000Z";
const BEFORE_DEADLINE = "2026-07-26T00:00:14.999Z";
const DEADLINE = "2026-07-26T00:00:15.000Z";

function card(
  instanceId: string,
  cardDefinitionId: string
): CardInstance {
  return {
    instanceId,
    cardDefinitionId,
    dreamDisguiseCardDefinitionId: null
  };
}

function onlineMatch(playerCount = 2): MatchState {
  return createMatch({
    matchId: `online-${playerCount}`,
    seed: `online-seed-${playerCount}`,
    mode: "ONLINE",
    players: Array.from({ length: playerCount }, (_, index) => ({
      playerId: `p${index}`,
      displayName: `P${index}`
    })),
    now: STARTED_AT
  }).state;
}

function withHands(
  state: MatchState,
  hands: Record<string, CardInstance[]>
): MatchState {
  return {
    ...state,
    players: Object.fromEntries(
      Object.entries(state.players).map(([playerId, player]) => [
        playerId,
        {
          ...player,
          hand: hands[playerId] ?? player.hand
        }
      ])
    )
  };
}

test("training input remains unlimited and never enables CPU takeover", () => {
  const training = createMatch({
    matchId: "training-deadline",
    seed: "training-deadline-seed",
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" }
    ],
    now: STARTED_AT
  }).state;
  const actorId = training.activePlayerId;
  assert.ok(actorId);
  assert.equal(training.inputDeadlineAt, null);

  const afterThirtySeconds = processInputDeadline(
    training,
    "2026-07-26T00:00:30.000Z"
  );
  assert.equal(afterThirtySeconds.state, training);
  assert.deepEqual(afterThirtySeconds.events, []);
  assert.equal(training.players[actorId]?.controller, "HUMAN");
  assert.equal(training.players[actorId]?.disconnected, false);
});

test("online action timeout disconnects the human and continues from the pending input as CPU", () => {
  const original = onlineMatch();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = original.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state = withHands(original, {
    [actorId]: [card("timeout-weapon", "bronze-club")],
    [targetId]: [card("target-armor", "leather-cap")]
  });
  assert.equal(state.inputDeadlineAt, DEADLINE);

  const early = processInputDeadline(state, BEFORE_DEADLINE);
  assert.equal(early.state, state);
  assert.deepEqual(early.events, []);

  const lateHumanCommand = handleCommand(state, {
    type: "SURRENDER",
    matchId: state.matchId,
    commandId: "late-human-before-timer",
    actorId,
    expectedRevision: state.revision,
    occurredAt: DEADLINE
  });
  assert.equal(lateHumanCommand.ok, false);
  if (lateHumanCommand.ok) return;
  assert.equal(lateHumanCommand.code, "INPUT_DEADLINE_EXPIRED");
  assert.equal(lateHumanCommand.state, state);

  const timedOut = processInputDeadline(state, DEADLINE);
  assert.equal(timedOut.timedOutPlayerId, actorId);
  assert.equal(timedOut.events[0]?.type, "INPUT_TIMED_OUT");
  assert.equal(timedOut.commands.length, 1);
  assert.equal(timedOut.commands[0]?.type, "DECLARE_ACTION");
  assert.equal(timedOut.state.players[actorId]?.controller, "CPU");
  assert.equal(timedOut.state.players[actorId]?.disconnected, true);
  assert.equal(timedOut.state.phase, "REACTION_SELECTION");
  assert.equal(
    timedOut.state.inputDeadlineAt,
    "2026-07-26T00:00:30.000Z"
  );

  const replay = processInputDeadline(state, DEADLINE);
  assert.deepEqual(replay, timedOut);

  const staleHuman = handleCommand(timedOut.state, {
    type: "SURRENDER",
    matchId: timedOut.state.matchId,
    commandId: "late-human-after-takeover",
    actorId,
    expectedRevision: timedOut.state.revision,
    occurredAt: "2026-07-26T00:00:16.000Z"
  });
  assert.equal(staleHuman.ok, false);
  if (staleHuman.ok) return;
  assert.equal(staleHuman.code, "CONTROLLER_MISMATCH");
});

test("online defense timeout uses the same reaction and then yields to the next human", () => {
  const original = onlineMatch(3);
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const nextPlayerId =
    original.turnOrder[(original.turnCursor + 1) % original.turnOrder.length];
  assert.ok(nextPlayerId);
  const targetId = original.turnOrder.find(
    (playerId) => playerId !== actorId && playerId !== nextPlayerId
  );
  assert.ok(targetId);
  const state = withHands(original, {
    [actorId]: [card("reaction-weapon", "bronze-club")],
    [targetId]: [card("reaction-armor", "leather-cap")]
  });
  const attack = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "reaction-timeout-attack",
    actorId,
    expectedRevision: state.revision,
    occurredAt: STARTED_AT,
    cardInstanceIds: ["reaction-weapon"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok) return;
  assert.equal(attack.state.phase, "REACTION_SELECTION");
  assert.equal(attack.state.inputDeadlineAt, DEADLINE);

  const timedOut = processInputDeadline(attack.state, DEADLINE);
  assert.equal(timedOut.timedOutPlayerId, targetId);
  assert.equal(timedOut.commands[0]?.type, "DECLARE_REACTION");
  if (timedOut.commands[0]?.type !== "DECLARE_REACTION") return;
  assert.equal(timedOut.commands[0].reactionId, attack.state.pendingAction?.kind === "ATTACK"
    ? attack.state.pendingAction.attack.reactionId
    : null);
  assert.equal(timedOut.state.players[targetId]?.controller, "CPU");
  assert.equal(timedOut.state.activePlayerId, nextPlayerId);
  assert.equal(timedOut.state.players[nextPlayerId]?.controller, "HUMAN");
  assert.equal(timedOut.state.inputDeadlineAt, "2026-07-26T00:00:30.000Z");
});

test("online trade confirmation timeout is accepted through the CPU command path", () => {
  const original = onlineMatch();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = original.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state = withHands(original, {
    [actorId]: [card("timeout-buy", "buy")],
    [targetId]: [card("timeout-product", "strength-powder")]
  });
  const offer = handleCommand(state, {
    type: "DECLARE_BUY",
    matchId: state.matchId,
    commandId: "trade-timeout-offer",
    actorId,
    expectedRevision: state.revision,
    occurredAt: STARTED_AT,
    cardInstanceId: "timeout-buy",
    targetPlayerId: targetId
  });
  assert.equal(offer.ok, true);
  if (!offer.ok || offer.state.pendingAction?.kind !== "ATTACK") return;
  const forgiven = handleCommand(offer.state, {
    type: "DECLARE_REACTION",
    matchId: offer.state.matchId,
    commandId: "trade-timeout-defense",
    actorId: targetId,
    expectedRevision: offer.state.revision,
    occurredAt: STARTED_AT,
    reactionId: offer.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;
  assert.equal(forgiven.state.phase, "TRADE_CONFIRMATION");
  assert.equal(forgiven.state.inputDeadlineAt, DEADLINE);

  const timedOut = processInputDeadline(forgiven.state, DEADLINE);
  assert.equal(timedOut.timedOutPlayerId, actorId);
  assert.equal(timedOut.commands.length, 1);
  assert.equal(timedOut.commands[0]?.type, "CONFIRM_BUY");
  if (timedOut.commands[0]?.type !== "CONFIRM_BUY") return;
  assert.equal(timedOut.commands[0].accept, true);
  assert.equal(
    timedOut.events.some(
      (event) =>
        event.type === "CARD_TRANSFERRED" &&
        event.card.instanceId === "timeout-product"
    ),
    true
  );
});

test("reconnection changes only connection state and does not restore human control", () => {
  const original = onlineMatch();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = original.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state = withHands(original, {
    [actorId]: [card("reconnect-weapon", "bronze-club")],
    [targetId]: [card("reconnect-armor", "leather-cap")]
  });
  const timedOut = processInputDeadline(state, DEADLINE);
  const reconnected = setPlayerConnectionState(
    timedOut.state,
    actorId,
    true,
    "2026-07-26T00:00:16.000Z"
  );
  assert.equal(reconnected.events[0]?.type, "PLAYER_CONNECTION_CHANGED");
  assert.equal(reconnected.state.players[actorId]?.disconnected, false);
  assert.equal(reconnected.state.players[actorId]?.controller, "CPU");

  const repeated = setPlayerConnectionState(
    reconnected.state,
    actorId,
    true,
    "2026-07-26T00:00:17.000Z"
  );
  assert.equal(repeated.state, reconnected.state);
  assert.deepEqual(repeated.events, []);

  const view = projectGameView(reconnected.state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  assert.equal(ui.mode, "WAITING");
  assert.equal(ui.inputDeadlineAt, reconnected.state.inputDeadlineAt);
});

test("CPU-controlled online inputs never receive a human deadline", () => {
  const state = createMatch({
    matchId: "online-cpu",
    seed: "online-cpu-seed",
    mode: "ONLINE",
    players: [
      { playerId: "cpu-a", displayName: "CPU A", controller: "CPU" },
      { playerId: "cpu-b", displayName: "CPU B", controller: "CPU" }
    ],
    now: STARTED_AT
  }).state;
  assert.equal(state.inputDeadlineAt, null);

  const advanced = advanceCpuControllers(state, STARTED_AT, 1);
  assert.equal(advanced.commands.length, 1);
  assert.equal(advanced.state.inputDeadlineAt, null);
  assert.equal(advanced.decisionLimitReached, true);
});
