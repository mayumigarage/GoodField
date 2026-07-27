import assert from "node:assert/strict";
import test from "node:test";

import {
  actionPreview,
  advanceUiClock,
  inputDeadlineRemainingSeconds,
  initialUiState,
  lockForCommand,
  prepareBuyConfirmation,
  prepareDeclareActionSubmission,
  preparePraySubmission,
  prepareReactionSubmission,
  reactionPreview,
  selectActionCard,
  selectDefenseCard,
  selectLearnedMiracle,
  selectTarget,
  synchronizeUiState,
  tradePaymentPreview
} from "../packages/client/src/ui-machine.ts";
import { createMatch, handleCommand } from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";

function match() {
  return createMatch({
    matchId: "view-match",
    seed: "view-seed",
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" },
      { playerId: "c", displayName: "C" }
    ]
  }).state;
}

test("player projections expose only the viewer private cards", () => {
  const state = match();
  const view = projectGameView(state, "a");
  assert.equal(view.self?.hand.length, 9);
  assert.equal(view.players.find(({ playerId }) => playerId === "b")?.handCount, 9);
  const serializedPlayers = JSON.stringify(view.players);
  for (const card of state.players.b?.hand ?? []) {
    assert.equal(serializedPlayers.includes(card.cardDefinitionId), false);
  }
  const spectator = projectGameView(state, null);
  assert.equal(spectator.self, null);
  assert.equal(JSON.stringify(spectator).includes(state.rng.seed), false);
});

test("UI state derives action/waiting mode and preserves a still-legal target", () => {
  const state = match();
  const activeId = state.activePlayerId;
  assert.ok(activeId);
  const view = projectGameView(state, activeId);
  let ui = synchronizeUiState(initialUiState(), view);
  assert.equal(ui.mode, "COMPOSING_ACTION");
  const legalTarget = view.self?.legalActions
    .find(({ type }) => type === "DECLARE_ACTION");
  if (!legalTarget || legalTarget.type !== "DECLARE_ACTION") {
    // The random hand can contain no primary weapon; mode behavior is still covered.
    assert.equal(ui.selectedTargetIds.length, 0);
    return;
  }
  const secondTarget = legalTarget.targetPlayerIds[1] ?? legalTarget.targetPlayerIds[0];
  assert.ok(secondTarget);
  ui = selectTarget(ui, secondTarget, view);
  assert.deepEqual(ui.selectedTargetIds, [secondTarget]);
  const refreshed = synchronizeUiState(ui, { ...view, revision: view.revision + 1 });
  assert.equal(refreshed.lastSelectedTargetId, secondTarget);
});

test("command locking is released by a newer server revision", () => {
  const state = match();
  const activeId = state.activePlayerId;
  assert.ok(activeId);
  const view = projectGameView(state, activeId);
  const synchronized = synchronizeUiState(initialUiState(), view);
  const locked = lockForCommand(synchronized, "command-1");
  assert.equal(locked.interactionLocked, true);
  const advanced = synchronizeUiState(locked, {
    ...view,
    revision: view.revision + 1
  });
  assert.equal(advanced.interactionLocked, false);
  assert.equal(advanced.awaitingCommandId, null);
});

test("online input deadline closes local input without resending its command", () => {
  const original = match();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const state = {
    ...original,
    mode: "ONLINE" as const,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: [
          {
            instanceId: "deadline-weapon",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const deadlineAt = "2026-07-26T00:00:15.000Z";
  const view = {
    ...projectGameView(state, actorId),
    inputDeadlineAt: deadlineAt
  };
  let ui = synchronizeUiState(initialUiState(), view);
  ui = selectActionCard(ui, "deadline-weapon", view);
  const prepared = prepareDeclareActionSubmission(
    ui,
    view,
    () => "deadline-command"
  );
  assert.ok(prepared);
  assert.equal(
    inputDeadlineRemainingSeconds(
      prepared.ui,
      Date.parse("2026-07-26T00:00:14.001Z")
    ),
    1
  );

  const expired = advanceUiClock(
    prepared.ui,
    view,
    Date.parse(deadlineAt)
  );
  assert.equal(expired.mode, "RESOLVING");
  assert.equal(expired.inputDeadlineExpired, true);
  assert.equal(expired.interactionLocked, true);
  assert.equal(expired.awaitingCommandId, null);
  assert.deepEqual(expired.selectedActionCardIds, []);
  assert.equal(
    prepareDeclareActionSubmission(
      expired,
      view,
      () => "must-not-be-sent"
    ),
    null
  );

  const staleSnapshot = synchronizeUiState(expired, view);
  assert.equal(staleSnapshot.mode, "RESOLVING");
  assert.equal(staleSnapshot.inputDeadlineExpired, true);
});

test("training input remains open without a deadline after thirty seconds", () => {
  const state = match();
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);

  assert.equal(view.matchMode, "TRAINING");
  assert.equal(ui.inputDeadlineAt, null);
  assert.equal(
    advanceUiClock(ui, view, Date.parse("2026-07-26T00:00:30.000Z")),
    ui
  );
  assert.equal(ui.mode, "COMPOSING_ACTION");
});

test("reconnected CPU controller stays authoritative and does not restore input", () => {
  const state = match();
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const view = {
    ...projectGameView(state, actorId),
    inputDeadlineAt: "2026-07-26T00:00:15.000Z"
  };
  const ui = advanceUiClock(
    synchronizeUiState(initialUiState(), view),
    view,
    Date.parse("2026-07-26T00:00:15.000Z")
  );
  const reconnectedView = {
    ...view,
    revision: view.revision + 1,
    inputDeadlineAt: null,
    players: view.players.map((player) =>
      player.playerId === actorId
        ? {
            ...player,
            controller: "CPU" as const,
            connectionState: "CONNECTED" as const
          }
        : player
    )
  };
  const restored = synchronizeUiState(ui, reconnectedView);

  assert.equal(restored.mode, "WAITING");
  assert.equal(restored.inputDeadlineExpired, false);
  assert.equal(restored.awaitingCommandId, null);
  assert.deepEqual(restored.selectedActionCardIds, []);
  assert.equal(
    preparePraySubmission(
      restored,
      reconnectedView,
      () => "must-not-be-sent"
    ),
    null
  );
});

test("a buy offer is visible only to its buyer and enters trade confirmation mode", () => {
  const original = match();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = Object.keys(original.players).find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        money: 3,
        mp: 2,
        hand: [
          {
            instanceId: "buy-card",
            cardDefinitionId: "buy",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      [targetId]: {
        ...original.players[targetId]!,
        hand: [
          {
            instanceId: "secret-offer",
            cardDefinitionId: "sword-shield",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const result = handleCommand(state, {
    type: "DECLARE_BUY",
    matchId: state.matchId,
    commandId: "private-buy",
    actorId,
    expectedRevision: state.revision,
    cardInstanceId: "buy-card",
    targetPlayerId: targetId
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.state.pendingAction?.kind !== "ATTACK") return;
  const forgiven = handleCommand(result.state, {
    type: "DECLARE_REACTION",
    matchId: result.state.matchId,
    commandId: "allow-private-buy",
    actorId: targetId,
    expectedRevision: result.state.revision,
    reactionId: result.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;

  const buyerView = projectGameView(forgiven.state, actorId);
  assert.equal(buyerView.self?.tradeConfirmation?.offeredCard.instanceId, "secret-offer");
  assert.equal(
    buyerView.self?.legalActions.some(({ type }) => type === "CONFIRM_BUY"),
    true
  );
  const ui = synchronizeUiState(initialUiState(), buyerView);
  assert.equal(ui.mode, "CONFIRMING_TRADE");
  assert.deepEqual(tradePaymentPreview(buyerView), {
    tradeId: buyerView.self?.tradeConfirmation?.tradeId,
    price: 15,
    money: 3,
    mp: 2,
    hp: 10,
    canAfford: true
  });
  const accepted = prepareBuyConfirmation(
    ui,
    buyerView,
    true,
    () => "confirm-private-buy"
  );
  assert.ok(accepted);
  assert.deepEqual(accepted.command, {
    type: "CONFIRM_BUY",
    matchId: buyerView.matchId,
    commandId: "confirm-private-buy",
    actorId,
    expectedRevision: buyerView.revision,
    tradeId: buyerView.self?.tradeConfirmation?.tradeId,
    accept: true
  });

  const otherView = projectGameView(result.state, targetId);
  assert.equal(otherView.self?.tradeConfirmation, null);
  const spectatorView = projectGameView(result.state, null);
  assert.equal(JSON.stringify(spectatorView).includes("secret-offer"), false);
  assert.equal(
    JSON.stringify(spectatorView).includes("sword-shield"),
    false
  );
});

test("reaction composition totals defense, submits forgive, and resets for a new reaction id", () => {
  const original = match();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = Object.keys(original.players).find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: [
          {
            instanceId: "attack-club",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      [targetId]: {
        ...original.players[targetId]!,
        hand: [
          {
            instanceId: "defense-rod",
            cardDefinitionId: "saver-rod",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const attack = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "open-reaction",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["attack-club"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok) return;

  const view = projectGameView(attack.state, targetId);
  let ui = synchronizeUiState(initialUiState(), view);
  assert.equal(ui.mode, "COMPOSING_REACTION");
  const firstReactionId = ui.activeReactionId;
  assert.ok(firstReactionId);

  const forgiven = prepareReactionSubmission(
    ui,
    view,
    () => "forgive-command",
    true
  );
  assert.ok(forgiven);
  assert.equal(forgiven.command.type, "DECLARE_REACTION");
  if (forgiven.command.type !== "DECLARE_REACTION") return;
  assert.deepEqual(forgiven.command.defenseCardInstanceIds, []);

  ui = selectDefenseCard(ui, "defense-rod", view);
  assert.deepEqual(reactionPreview(ui, view), {
    reactionId: firstReactionId,
    totalDefense: 6,
    requiredMp: 0,
    hasSelection: true,
    canSubmit: true,
    invalidReason: null
  });
  const defended = prepareReactionSubmission(
    ui,
    view,
    () => "defense-command"
  );
  assert.ok(defended);
  assert.equal(defended.command.type, "DECLARE_REACTION");
  if (defended.command.type !== "DECLARE_REACTION") return;
  assert.deepEqual(defended.command.defenseCardInstanceIds, ["defense-rod"]);

  const nextView = {
    ...view,
    revision: view.revision + 1,
    self: view.self
      ? {
          ...view.self,
          legalActions: view.self.legalActions.map((action) =>
            action.type === "DECLARE_REACTION"
              ? { ...action, reactionId: "next-reaction" }
              : action
          )
        }
      : null
  };
  const reset = synchronizeUiState(ui, nextView);
  assert.equal(reset.activeReactionId, "next-reaction");
  assert.deepEqual(reset.selectedDefenseCardIds, []);
});

test("action composition replaces the primary source, keeps additive sources, and previews totals", () => {
  const original = match();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const actor = original.players[actorId];
  assert.ok(actor);
  const state = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...actor,
        hand: [
          {
            instanceId: "bronze",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          },
          {
            instanceId: "whip",
            cardDefinitionId: "whip",
            dreamDisguiseCardDefinitionId: null
          },
          {
            instanceId: "blowgun",
            cardDefinitionId: "blowgun",
            dreamDisguiseCardDefinitionId: null
          }
        ],
        learnedMiracles: [
          {
            learnedMiracleId: "learned-fireball",
            cardDefinitionId: "fireball"
          }
        ]
      }
    }
  };
  const view = projectGameView(state, actorId);
  let ui = synchronizeUiState(initialUiState(), view);

  ui = selectActionCard(ui, "bronze", view);
  assert.deepEqual(ui.selectedActionCardIds, ["bronze"]);
  assert.equal(ui.mode, "CHOOSING_TARGET");
  const firstTarget = view.players.find(
    ({ playerId, alive }) => playerId !== actorId && alive
  )?.playerId;
  assert.equal(ui.selectedTargetIds[0], firstTarget);

  const otherTarget = view.players.find(
    ({ playerId, alive }) =>
      playerId !== actorId && playerId !== firstTarget && alive
  )?.playerId;
  assert.ok(otherTarget);
  ui = selectTarget(ui, otherTarget, view);
  ui = selectActionCard(ui, "blowgun", view);
  ui = selectLearnedMiracle(ui, "learned-fireball", view);
  assert.deepEqual(ui.selectedActionCardIds, ["bronze", "blowgun"]);
  assert.deepEqual(ui.selectedLearnedMiracleIds, ["learned-fireball"]);
  assert.deepEqual(actionPreview(ui, view), {
    attackPower: 4,
    element: "PHYSICAL",
    requiredMp: 2,
    targetPlayerIds: [firstTarget, otherTarget],
    canSubmit: true,
    invalidReason: null
  });

  ui = selectActionCard(ui, "whip", view);
  assert.deepEqual(ui.selectedActionCardIds, ["whip"]);
  assert.deepEqual(ui.selectedLearnedMiracleIds, []);
  assert.deepEqual(ui.selectedTargetIds, [otherTarget]);
  assert.equal(actionPreview(ui, view).attackPower, 2);
});

test("action submission reuses its command id and stale selections are removed", () => {
  const original = match();
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const actor = original.players[actorId];
  assert.ok(actor);
  const state = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...actor,
        hand: [
          {
            instanceId: "bronze",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const view = projectGameView(state, actorId);
  let ui = synchronizeUiState(initialUiState(), view);
  ui = selectActionCard(ui, "bronze", view);
  const first = prepareDeclareActionSubmission(
    ui,
    view,
    () => "ui-command-1"
  );
  assert.ok(first);
  const duplicate = prepareDeclareActionSubmission(
    first.ui,
    view,
    () => "must-not-be-used"
  );
  assert.ok(duplicate);
  assert.equal(first.command.commandId, "ui-command-1");
  assert.equal(duplicate.command.commandId, "ui-command-1");
  assert.deepEqual(duplicate.command, first.command);

  const refreshed = synchronizeUiState(first.ui, {
    ...view,
    revision: view.revision + 1,
    self: view.self
      ? {
          ...view.self,
          legalActions: view.self.legalActions.filter(
            ({ type }) => type !== "DECLARE_ACTION"
          )
        }
      : null
  });
  assert.deepEqual(refreshed.selectedActionCardIds, []);
  assert.match(refreshed.selectionInvalidReason ?? "", /選択を解除/u);
  assert.equal(refreshed.interactionLocked, false);
});
