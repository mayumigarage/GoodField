import assert from "node:assert/strict";
import test from "node:test";

import { createMatch, handleCommand } from "../packages/server/src/engine.ts";
import {
  projectDomainEvent,
  projectGameView
} from "../packages/server/src/projection.ts";
import { CARD_DEFINITIONS_BY_ID } from "../packages/shared/src/cards.ts";
import type {
  CardInstance,
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";

function card(instanceId: string, cardDefinitionId: string): CardInstance {
  return { instanceId, cardDefinitionId, dreamDisguiseCardDefinitionId: null };
}

function setup(
  seed: string,
  actorCards: CardInstance[],
  targetCards: CardInstance[],
  targetDreaming: boolean
): { state: MatchState; actorId: string; targetId: string } {
  const created = createMatch({
    matchId: "dream-match",
    seed,
    players: [
      { playerId: "alice", displayName: "Alice" },
      { playerId: "bob", displayName: "Bob" }
    ],
    now: "2026-11-04T00:00:00.000Z"
  });
  const state = created.state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const targetId = actorId === "alice" ? "bob" : "alice";
  return {
    actorId,
    targetId,
    state: {
      ...state,
      players: {
        ...state.players,
        [actorId]: { ...state.players[actorId]!, hand: actorCards },
        [targetId]: {
          ...state.players[targetId]!,
          hand: targetCards,
          calamities: targetDreaming ? { DREAM: true } : {}
        }
      }
    }
  };
}

function attackAndDefend(
  seed: string,
  targetDreaming: boolean,
  defenseCardInstanceIds: string[],
  targetCards: CardInstance[]
) {
  const start = setup(
    seed,
    [card("club", "bronze-club")],
    targetCards,
    targetDreaming
  );
  const action = handleCommand(start.state, {
    type: "DECLARE_ACTION",
    matchId: start.state.matchId,
    commandId: "attack",
    actorId: start.actorId,
    expectedRevision: start.state.revision,
    cardInstanceIds: ["club"],
    targetPlayerId: start.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok) throw new Error("attack was rejected");
  const pending = action.state.pendingAction;
  assert.equal(pending?.kind, "ATTACK");
  if (pending?.kind !== "ATTACK") throw new Error("no pending attack");
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "defense",
    actorId: start.targetId,
    expectedRevision: action.state.revision,
    reactionId: pending.attack.reactionId,
    defenseCardInstanceIds
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) throw new Error("defense was rejected");
  return { ...start, reaction };
}

function fillerHand(count: number): CardInstance[] {
  return Array.from({ length: count }, (_, index) =>
    card(`filler-${index}`, "bronze-club")
  );
}

function indexOfType(events: readonly DomainEvent[], type: string): number {
  return events.findIndex((event) => event.type === type);
}

test("夢見る帽子 resolves 無事 first, then 夢, then a public 神器一新", () => {
  const { reaction, targetId } = attackAndDefend(
    "dream-hat-order",
    false,
    ["hat"],
    [card("hat", "dreaming-hat"), ...fillerHand(4)]
  );
  const events = reaction.events;
  const damage = indexOfType(events, "DAMAGE_APPLIED");
  const dream = events.findIndex(
    (event) =>
      event.type === "CALAMITY_APPLIED" &&
      event.playerId === targetId &&
      event.calamity === "DREAM"
  );
  const redraw = indexOfType(events, "HAND_REDRAWN");
  assert.ok(damage >= 0, "damage result is recorded");
  assert.ok(dream > damage, "夢 follows the attack result");
  assert.ok(redraw > dream, "神器一新 follows 夢");
  const redrawEvent = events[redraw];
  assert.equal(redrawEvent?.type, "HAND_REDRAWN");
  if (redrawEvent?.type === "HAND_REDRAWN") {
    assert.equal(redrawEvent.playerId, targetId);
    assert.equal(redrawEvent.cardCount, 4);
    assert.equal(redrawEvent.visibility.scope, "PUBLIC");
  }
  assert.equal(reaction.state.players[targetId]?.calamities.DREAM, true);
  // Four redrawn cards plus the replacement for the hat.
  assert.equal(reaction.state.players[targetId]?.hand.length, 5);
  assert.equal(
    reaction.state.players[targetId]?.hand.some(({ instanceId }) =>
      instanceId.startsWith("filler-")
    ),
    false
  );
});

test("a dreamer using 夢見る帽子 shows no second 夢 and goes straight to 神器一新", () => {
  const { reaction, targetId } = attackAndDefend(
    "dream-hat-dreamer",
    true,
    ["hat"],
    [card("hat", "dreaming-hat"), ...fillerHand(2)]
  );
  assert.equal(
    reaction.events.some(
      (event) =>
        event.type === "CALAMITY_APPLIED" && event.playerId === targetId
    ),
    false
  );
  assert.ok(indexOfType(reaction.events, "HAND_REDRAWN") >= 0);
});

test("cards granted while dreaming show a fixed same-use face half of the time", () => {
  let disguised = 0;
  let truthful = 0;
  for (let round = 0; round < 12; round += 1) {
    const { reaction, targetId } = attackAndDefend(
      `dream-grants-${round}`,
      true,
      ["hat"],
      [card("hat", "dreaming-hat"), ...fillerHand(10)]
    );
    const hand = reaction.state.players[targetId]?.hand ?? [];
    assert.equal(hand.length, 11);
    const own = projectGameView(reaction.state, targetId);
    for (const granted of hand) {
      const real = CARD_DEFINITIONS_BY_ID.get(granted.cardDefinitionId);
      assert.ok(real);
      const visible = own.self?.hand.find(
        ({ instanceId }) => instanceId === granted.instanceId
      );
      assert.ok(visible);
      assert.equal(visible.dreamDisguiseCardDefinitionId, null);
      if (granted.dreamDisguiseCardDefinitionId === null) {
        truthful += 1;
        assert.equal(visible.cardDefinitionId, granted.cardDefinitionId);
        continue;
      }
      disguised += 1;
      const face = CARD_DEFINITIONS_BY_ID.get(
        granted.dreamDisguiseCardDefinitionId
      );
      assert.ok(face);
      assert.notEqual(face.cardDefinitionId, real.cardDefinitionId);
      assert.equal(face.category, real.category);
      assert.ok(["WEAPON", "ARMOR", "GOODS"].includes(real.category));
      // The owner only ever sees the fake face, never the real id.
      assert.equal(visible.cardDefinitionId, face.cardDefinitionId);
    }
    // Owner-only grant events carry the fake face too.
    for (const event of reaction.events) {
      if (event.type !== "CARD_GRANTED" || event.playerId !== targetId) {
        continue;
      }
      const projected = projectDomainEvent(event, targetId);
      assert.equal(projected?.type, "CARD_GRANTED");
      if (projected?.type !== "CARD_GRANTED") continue;
      assert.equal(
        projected.card.cardDefinitionId,
        event.card.dreamDisguiseCardDefinitionId ?? event.card.cardDefinitionId
      );
      assert.equal(projected.card.dreamDisguiseCardDefinitionId, null);
      assert.equal(projectDomainEvent(event, "someone-else"), null);
    }
  }
  assert.ok(disguised > 0, "some grants are disguised");
  assert.ok(truthful > 0, "some grants keep their real face");
});

test("cards granted while awake are never disguised", () => {
  const { reaction, actorId } = attackAndDefend(
    "awake-grants",
    false,
    [],
    fillerHand(1)
  );
  for (const held of reaction.state.players[actorId]?.hand ?? []) {
    assert.equal(held.dreamDisguiseCardDefinitionId, null);
  }
});

test("waking from 夢 reveals every disguised card in hand", () => {
  const start = setup("dream-wake", [], [], false);
  const actor = start.state.players[start.actorId]!;
  const state: MatchState = {
    ...start.state,
    players: {
      ...start.state.players,
      [start.actorId]: {
        ...actor,
        calamities: { DREAM: true },
        hand: [
          card("shell", "heart-shell"),
          {
            instanceId: "fake",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: "dream-mallet"
          }
        ]
      }
    }
  };
  const result = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "wake",
    actorId: start.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["shell"],
    targetPlayerId: start.actorId
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const player = result.state.players[start.actorId];
  assert.equal(player?.calamities.DREAM, undefined);
  const revealed = player?.hand.find(({ instanceId }) => instanceId === "fake");
  assert.deepEqual(revealed, card("fake", "bronze-club"));
});
