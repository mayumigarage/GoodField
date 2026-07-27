import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseCpuCommand,
  handleCpuDecision
} from "../packages/server/src/cpu.ts";
import {
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";
import type {
  CardInstance,
  MatchState
} from "../packages/shared/src/model.ts";

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

function cpuActionState(playerCount = 3): {
  state: MatchState;
  actorId: string;
  targetIds: string[];
} {
  const original = createMatch({
    matchId: `cpu-${playerCount}`,
    seed: "cpu-match-seed",
    players: Array.from({ length: playerCount }, (_, index) => ({
      playerId: `p${index}`,
      displayName: `P${index}`
    })),
    now: "2026-07-26T00:00:00.000Z"
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetIds = original.turnOrder.filter(
    (playerId) => playerId !== actorId
  );
  return {
    actorId,
    targetIds,
    state: {
      ...original,
      players: Object.fromEntries(
        Object.entries(original.players).map(([playerId, player]) => [
          playerId,
          {
            ...player,
            controller: playerId === actorId ? "CPU" : "HUMAN",
            hand:
              playerId === actorId
                ? [card("cpu-weapon", "bronze-club")]
                : [card(`secret-${playerId}`, "leather-cap")]
          }
        ])
      )
    }
  };
}

test("CPU decisions use only the projected private view and are seed reproducible", () => {
  const setup = cpuActionState();
  const firstView = projectGameView(setup.state, setup.actorId);
  const secretTargetId = setup.targetIds[0];
  assert.ok(secretTargetId);
  const changedSecretState: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [secretTargetId]: {
        ...setup.state.players[secretTargetId]!,
        hand: [card(`secret-${secretTargetId}`, "sun-amulet")]
      }
    }
  };
  const secondView = projectGameView(changedSecretState, setup.actorId);
  assert.deepEqual(secondView, firstView);

  const first = chooseCpuCommand(firstView, { seed: "decision-seed" });
  const replay = chooseCpuCommand(secondView, { seed: "decision-seed" });
  assert.deepEqual(replay, first);
  assert.equal(first?.type, "DECLARE_ACTION");

  const selectedTargets = new Set<string>();
  for (let index = 0; index < 32; index += 1) {
    const command = chooseCpuCommand(firstView, {
      seed: `decision-seed-${index}`
    });
    if (command?.type === "DECLARE_ACTION") {
      selectedTargets.add(command.targetPlayerId);
    }
  }
  assert.ok(selectedTargets.size > 1);
});

test("CPU action commands pass through the normal command handler", () => {
  const setup = cpuActionState(2);
  const handled = handleCpuDecision(setup.state, setup.actorId, {
    seed: "cpu-action"
  });
  assert.ok(handled);
  assert.equal(handled.command.type, "DECLARE_ACTION");
  assert.equal(handled.result.ok, true);
  if (!handled.result.ok) return;
  assert.equal(
    handled.result.events.some(
      ({ type }) =>
        type === "ACTION_DECLARED" || type === "REACTION_REQUESTED"
    ),
    true
  );
});

test("CPU selects a legal defense and forgives only when none exists", () => {
  const setup = cpuActionState(2);
  const targetId = setup.targetIds[0];
  assert.ok(targetId);
  const attackingState: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        controller: "HUMAN"
      },
      [targetId]: {
        ...setup.state.players[targetId]!,
        controller: "CPU",
        hand: [card("cpu-armor", "leather-cap")]
      }
    }
  };
  const attack = handleCommand(attackingState, {
    type: "DECLARE_ACTION",
    matchId: attackingState.matchId,
    commandId: "human-attack",
    actorId: setup.actorId,
    expectedRevision: attackingState.revision,
    cardInstanceIds: ["cpu-weapon"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok) return;

  const defense = handleCpuDecision(attack.state, targetId, {
    seed: "cpu-defense"
  });
  assert.ok(defense);
  assert.equal(defense.command.type, "DECLARE_REACTION");
  if (defense.command.type !== "DECLARE_REACTION") return;
  assert.deepEqual(defense.command.defenseCardInstanceIds, ["cpu-armor"]);
  assert.equal(defense.result.ok, true);
});

test("CPU accepts an affordable buy offer through the shared trade validation", () => {
  const setup = cpuActionState(2);
  const targetId = setup.targetIds[0];
  assert.ok(targetId);
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        hand: [card("cpu-buy", "buy")]
      },
      [targetId]: {
        ...setup.state.players[targetId]!,
        hand: [card("offered-card", "strength-powder")]
      }
    }
  };
  const offer = handleCommand(
    state,
    {
      type: "DECLARE_BUY",
      matchId: state.matchId,
      commandId: "cpu-buy-offer",
      actorId: setup.actorId,
      expectedRevision: state.revision,
      cardInstanceId: "cpu-buy",
      targetPlayerId: targetId
    },
    "CPU"
  );
  assert.equal(offer.ok, true);
  if (!offer.ok || offer.state.pendingAction?.kind !== "ATTACK") return;
  const forgiven = handleCommand(offer.state, {
    type: "DECLARE_REACTION",
    matchId: offer.state.matchId,
    commandId: "cpu-buy-forgiven",
    actorId: targetId,
    expectedRevision: offer.state.revision,
    reactionId: offer.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;

  const confirmation = handleCpuDecision(forgiven.state, setup.actorId, {
    seed: "cpu-confirm-buy"
  });
  assert.ok(confirmation);
  assert.equal(confirmation.command.type, "CONFIRM_BUY");
  if (confirmation.command.type !== "CONFIRM_BUY") return;
  assert.equal(confirmation.command.accept, true);
  assert.equal(confirmation.result.ok, true);
  if (!confirmation.result.ok) return;
  assert.equal(
    confirmation.result.events.some(
      (event) =>
        event.type === "CARD_TRANSFERRED" &&
        event.card.instanceId === "offered-card"
    ),
    true
  );
});

test("legal actions include a required cost cutter for a low-MP CPU miracle", () => {
  const setup = cpuActionState(2);
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        mp: 0,
        hand: [
          card("expensive-miracle", "ice"),
          card("cost-cutter", "spiritual-doll")
        ]
      }
    }
  };
  const view = projectGameView(state, setup.actorId);
  const miracleAction = view.self?.legalActions.find(
    (action) =>
      action.type === "DECLARE_ACTION" &&
      action.cardInstanceIds.includes("expensive-miracle")
  );
  assert.ok(miracleAction);
  if (!miracleAction || miracleAction.type !== "DECLARE_ACTION" || !view.self) {
    return;
  }
  assert.deepEqual(
    miracleAction.cardInstanceIds,
    ["expensive-miracle", "cost-cutter"]
  );
  const command = chooseCpuCommand(
    {
      ...view,
      self: {
        ...view.self,
        legalActions: [miracleAction]
      }
    },
    { seed: "cpu-cost-cut" }
  );
  assert.equal(command?.type, "DECLARE_ACTION");
  if (!command) return;
  const result = handleCommand(state, command, "CPU");
  assert.equal(result.ok, true);
});
