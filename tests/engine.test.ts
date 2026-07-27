import assert from "node:assert/strict";
import test from "node:test";

import {
  canDefenseBlock,
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import type {
  CardInstance,
  MatchState,
  PlayerState
} from "../packages/shared/src/model.ts";
import { createRng } from "../packages/shared/src/rng.ts";

function createTwoPlayerMatch(seed = "engine-test") {
  return createMatch({
    matchId: "match-1",
    seed,
    players: [
      { playerId: "alice", displayName: "Alice" },
      { playerId: "bob", displayName: "Bob" }
    ],
    now: "2026-07-25T00:00:00.000Z"
  });
}

function createFourPlayerMatch(seed = "four-player") {
  return createMatch({
    matchId: "match-4p",
    seed,
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" },
      { playerId: "c", displayName: "C" },
      { playerId: "d", displayName: "D" }
    ],
    now: "2026-07-25T00:00:00.000Z"
  });
}

function card(instanceId: string, cardDefinitionId: string): CardInstance {
  return {
    instanceId,
    cardDefinitionId,
    dreamDisguiseCardDefinitionId: null
  };
}

function withEndTimeActor(
  seed: string,
  hand: CardInstance[],
  actorPatch: Partial<PlayerState> = {}
): {
  state: MatchState;
  actorId: string;
} {
  const original = createTwoPlayerMatch(`end-time-${seed}`).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  return {
    actorId,
    state: {
      ...original,
      endTimeThreshold: 1,
      endTimeActive: true,
      rng: createRng(seed),
      randomLog: [],
      players: {
        ...original.players,
        [actorId]: {
          ...original.players[actorId]!,
          ...actorPatch,
          hand
        }
      }
    }
  };
}

function withHands(
  state: MatchState,
  actorCards: CardInstance[],
  targetCards: CardInstance[],
  targetHp = 40
): {
  state: MatchState;
  actorId: string;
  targetId: string;
} {
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const targetId = Object.keys(state.players).find((id) => id !== actorId);
  assert.ok(targetId);
  return {
    actorId,
    targetId,
    state: {
      ...state,
      players: {
        ...state.players,
        [actorId]: {
          ...state.players[actorId]!,
          hand: actorCards
        },
        [targetId]: {
          ...state.players[targetId]!,
          hp: targetHp,
          hand: targetCards
        }
      }
    }
  };
}

function forgivePendingReaction(state: MatchState, commandId: string) {
  const pending = state.pendingAction;
  assert.equal(pending?.kind, "ATTACK");
  if (pending?.kind !== "ATTACK") {
    throw new Error("Expected a pending reaction");
  }
  return handleCommand(state, {
    type: "DECLARE_REACTION",
    matchId: state.matchId,
    commandId,
    actorId: pending.attack.targetPlayerId,
    expectedRevision: state.revision,
    reactionId: pending.attack.reactionId,
    defenseCardInstanceIds: []
  });
}

test("match initialization is deterministic and grants nine cards in round-robin seat order", () => {
  const first = createTwoPlayerMatch("deterministic");
  const second = createTwoPlayerMatch("deterministic");
  assert.deepEqual(first, second);
  assert.equal(first.state.phase, "ACTION_SELECTION");
  assert.equal(first.state.gfCount, 1);
  assert.equal(first.state.players.alice?.hand.length, 9);
  assert.equal(first.state.players.bob?.hand.length, 9);
  const privateGrantTargets = first.events
    .filter(({ type }) => type === "CARD_GRANTED")
    .map((event) => event.type === "CARD_GRANTED" ? event.playerId : "");
  assert.deepEqual(privateGrantTargets.slice(0, 6), [
    "alice",
    "bob",
    "alice",
    "bob",
    "alice",
    "bob"
  ]);
  assert.equal(first.state.randomLog.length, 20);
  assert.equal(
    first.state.randomLog.filter(({ context }) => context === "CARD_GRANT").length,
    18
  );
  assert.equal("Math.random" in first.state, false);
});

test("match initialization accepts 2-9 players and rejects other sizes", () => {
  assert.throws(
    () =>
      createMatch({
        matchId: "solo",
        seed: "seed",
        players: [{ playerId: "a", displayName: "A" }]
      }),
    /2 to 9/u
  );
  const nine = createMatch({
    matchId: "nine",
    seed: "seed",
    players: Array.from({ length: 9 }, (_, index) => ({
      playerId: `p${index}`,
      displayName: `P${index}`
    }))
  });
  assert.equal(Object.keys(nine.state.players).length, 9);
});

test("ordinary discard consumes a card without creating a grant obligation", () => {
  const setup = withHands(
    createTwoPlayerMatch("ordinary-discard").state,
    [card("discarded-card", "leather-cap")],
    []
  );
  const result = handleCommand(setup.state, {
    type: "DISCARD",
    matchId: setup.state.matchId,
    commandId: "ordinary-discard",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "discarded-card"
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.players[setup.actorId]?.hand.length, 0);
  assert.equal(
    result.events.some(({ type }) => type === "GRANT_REQUESTED"),
    false
  );
  assert.equal(
    result.events.some(({ type }) => type === "CARD_GRANTED"),
    false
  );
});

test("a full hand keeps its newly granted card and discards only a prior card", () => {
  const original = createTwoPlayerMatch("full-hand-grant").state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const oldHand = Array.from(
    { length: 18 },
    (_, index) => card(`old-card-${index}`, "leather-cap")
  );
  const oldInstanceIds = new Set(oldHand.map(({ instanceId }) => instanceId));
  const state: MatchState = {
    ...original,
    rng: createRng("full-hand-pray"),
    randomLog: [],
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: oldHand
      }
    }
  };
  const result = handleCommand(state, {
    type: "PRAY",
    matchId: state.matchId,
    commandId: "full-hand-pray",
    actorId,
    expectedRevision: state.revision
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const granted = result.events.find(({ type }) => type === "CARD_GRANTED");
  const discarded = result.events.find(
    ({ type }) => type === "HAND_LIMIT_DISCARD"
  );
  assert.ok(granted && granted.type === "CARD_GRANTED");
  assert.ok(discarded && discarded.type === "HAND_LIMIT_DISCARD");
  if (
    granted?.type !== "CARD_GRANTED" ||
    discarded?.type !== "HAND_LIMIT_DISCARD"
  ) {
    return;
  }
  const finalHand = result.state.players[actorId]?.hand ?? [];
  assert.equal(finalHand.length, 18);
  assert.equal(
    finalHand.some(
      ({ instanceId }) => instanceId === granted.card.instanceId
    ),
    true
  );
  assert.equal(oldInstanceIds.has(discarded.cardInstanceId), true);
  assert.equal(discarded.cardInstanceId === granted.card.instanceId, false);
  assert.deepEqual(
    result.state.randomLog.map(({ context }) => context),
    ["CARD_GRANT", "HAND_LIMIT_DISCARD"]
  );
});

test("matches accept only the supported end-time thresholds", () => {
  for (const endTimeThreshold of [1, 50, 75, 100, 150] as const) {
    const match = createMatch({
      matchId: `end-time-${endTimeThreshold}`,
      seed: "threshold",
      players: [
        { playerId: "a", displayName: "A" },
        { playerId: "b", displayName: "B" }
      ],
      endTimeThreshold
    });
    assert.equal(match.state.endTimeThreshold, endTimeThreshold);
    assert.equal(match.state.endTimeActive, endTimeThreshold === 1);
  }
  const noEndTime = createMatch({
    matchId: "no-end-time",
    seed: "threshold",
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" }
    ],
    endTimeThreshold: null
  });
  assert.equal(noEndTime.state.endTimeActive, false);
  assert.throws(
    () =>
      createMatch({
        matchId: "invalid-end-time",
        seed: "threshold",
        players: [
          { playerId: "a", displayName: "A" },
          { playerId: "b", displayName: "B" }
        ],
        endTimeThreshold: 2 as 1
      }),
    /End-time threshold/u
  );
});

test("an end-time grant draws a standard artifact through the 75 percent branch", () => {
  const setup = withEndTimeActor(
    "standard-seed-0",
    [card("sacrifice", "leather-cap")]
  );
  const result = handleCommand(setup.state, {
    type: "SACRIFICE",
    matchId: setup.state.matchId,
    commandId: "standard-end-time-grant",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "sacrifice"
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.events.filter(({ type }) => type === "CARD_GRANTED").length,
    1
  );
  assert.equal(
    result.events.some(({ type }) => type === "DEMON_APPEARED"),
    false
  );
  assert.deepEqual(
    result.state.randomLog.map(({ context }) => context),
    ["END_TIME_GRANT", "CARD_GRANT"]
  );
});

test("small, medium, and large demons deal 10, 20, and 30 damage before the grant continues", () => {
  const cases = [
    ["small-chain-1", 10],
    ["demon-seed-31", 20],
    ["demon-seed-9", 30]
  ] as const;
  for (const [seed, expectedDamage] of cases) {
    const setup = withEndTimeActor(
      seed,
      [card("sacrifice", "leather-cap")]
    );
    const result = handleCommand(setup.state, {
      type: "SACRIFICE",
      matchId: setup.state.matchId,
      commandId: `damage-demon-${expectedDamage}`,
      actorId: setup.actorId,
      expectedRevision: setup.state.revision,
      cardInstanceId: "sacrifice"
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    const damage = result.events.find(
      (event) =>
        event.type === "RESOURCE_CHANGED" &&
        event.reason === "DEMON" &&
        event.resource === "HP"
    );
    assert.equal(damage?.type, "RESOURCE_CHANGED");
    if (damage?.type === "RESOURCE_CHANGED") {
      assert.equal(damage.delta, -expectedDamage);
      assert.equal(damage.valueAfter, 40 - expectedDamage);
    }
    assert.equal(
      result.events.filter(({ type }) => type === "CARD_GRANTED").length,
      1
    );
  }
});

test("mischief removes at most two existing cards or learned miracles without replacement grants", () => {
  const setup = withEndTimeActor(
    "demon-seed-28",
    [
      card("sacrifice", "leather-cap"),
      card("item-a", "bronze-club"),
      card("item-b", "leather-cap"),
      card("item-c", "spring")
    ],
    {
      learnedMiracles: [
        {
          learnedMiracleId: "learned-ice",
          cardDefinitionId: "ice"
        }
      ]
    }
  );
  const result = handleCommand(setup.state, {
    type: "SACRIFICE",
    matchId: setup.state.matchId,
    commandId: "mischief-grant",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "sacrifice"
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const removals = result.events.filter(
    ({ type }) => type === "DEMON_OBJECT_REMOVED"
  );
  assert.equal(removals.length, 2);
  assert.equal(
    removals.every(({ visibility }) => visibility.scope === "PLAYER"),
    true
  );
  const theft = result.events.find(
    ({ type }) => type === "DEMON_THEFT_RESOLVED"
  );
  assert.equal(theft?.type, "DEMON_THEFT_RESOLVED");
  if (theft?.type === "DEMON_THEFT_RESOLVED") {
    assert.equal(theft.removedCount, 2);
  }
  assert.equal(
    result.events.filter(({ type }) => type === "CARD_GRANTED").length,
    1
  );
  const actor = result.state.players[setup.actorId];
  assert.equal(
    (actor?.hand.length ?? 0) + (actor?.learnedMiracles.length ?? 0),
    3
  );
});

test("the fairy boosts one resource and the same obligation continues through later demons", () => {
  const setup = withEndTimeActor(
    "demon-seed-23",
    [card("sacrifice", "leather-cap")]
  );
  const result = handleCommand(setup.state, {
    type: "SACRIFICE",
    matchId: setup.state.matchId,
    commandId: "fairy-chain",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "sacrifice"
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const demons = result.events
    .filter(({ type }) => type === "DEMON_APPEARED")
    .map((event) =>
      event.type === "DEMON_APPEARED"
        ? event.demonCardDefinitionId
        : ""
    );
  assert.deepEqual(demons, [
    "demon-005-めぐみの妖精",
    "demon-001-小悪魔"
  ]);
  assert.equal(result.state.players[setup.actorId]?.mp, 20);
  assert.equal(result.state.players[setup.actorId]?.hp, 30);
  assert.equal(
    result.events.filter(({ type }) => type === "CARD_GRANTED").length,
    1
  );
  assert.equal(
    result.state.randomLog.filter(
      ({ context }) => context === "END_TIME_GRANT"
    ).length,
    3
  );
});

test("a lethal demon cancels its grant obligation and ends the match at the same GF", () => {
  const setup = withEndTimeActor(
    "demon-seed-9",
    [card("sacrifice", "leather-cap")],
    { hp: 20 }
  );
  const result = handleCommand(setup.state, {
    type: "SACRIFICE",
    matchId: setup.state.matchId,
    commandId: "lethal-demon",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "sacrifice"
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.players[setup.actorId]?.alive, false);
  assert.equal(result.state.phase, "MATCH_ENDED");
  assert.equal(result.state.gfCount, 1);
  assert.equal(result.state.pendingGrant.length, 0);
  assert.equal(
    result.events.some(({ type }) => type === "GRANT_CANCELLED"),
    true
  );
  assert.equal(
    result.events.some(({ type }) => type === "CARD_GRANTED"),
    false
  );
});

test("end-time demon chains are deterministic for the same state and command", () => {
  const setup = withEndTimeActor(
    "demon-seed-23",
    [card("sacrifice", "leather-cap")]
  );
  const command = {
    type: "SACRIFICE" as const,
    matchId: setup.state.matchId,
    commandId: "deterministic-demon-chain",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "sacrifice"
  };
  const first = handleCommand(setup.state, command);
  const second = handleCommand(setup.state, command);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.state.randomLog, second.state.randomLog);
  assert.deepEqual(first.state, second.state);
});

test("a basic attack opens an independent reaction and grants used cards after defense", () => {
  const setup = withHands(
    createTwoPlayerMatch().state,
    [card("weapon", "bronze-club")],
    [card("armor", "leather-cap")]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "attack-command",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok) return;
  assert.equal(action.state.phase, "REACTION_SELECTION");
  assert.equal(action.state.pendingAction?.kind, "ATTACK");
  assert.equal(action.state.players[setup.actorId]?.hand.length, 0);
  const reactionId =
    action.state.pendingAction?.kind === "ATTACK"
      ? action.state.pendingAction.attack.reactionId
      : "";
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "defense-command",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId,
    defenseCardInstanceIds: ["armor"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 40);
  assert.equal(reaction.state.players[setup.actorId]?.hand.length, 1);
  assert.equal(reaction.state.players[setup.targetId]?.hand.length, 1);
  assert.equal(reaction.state.gfCount, 2);
  assert.equal(reaction.state.phase, "ACTION_SELECTION");
});

test("a two-hit weapon creates two reactions and grants defense cards only after both", () => {
  const setup = withHands(
    createTwoPlayerMatch("two-hit").state,
    [card("saw", "saw-boom-boom")],
    [
      card("armor-1", "leather-cap"),
      card("armor-2", "leather-cap")
    ]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "two-hit-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["saw"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  assert.equal(action.state.pendingAction.attack.attackNumber, 1);
  assert.equal(action.state.pendingAction.attack.totalAttacks, 2);
  const firstReactionId = action.state.pendingAction.attack.reactionId;
  const firstReaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "first-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: firstReactionId,
    defenseCardInstanceIds: ["armor-1"]
  });
  assert.equal(firstReaction.ok, true);
  if (
    !firstReaction.ok ||
    firstReaction.state.pendingAction?.kind !== "ATTACK"
  ) return;
  assert.equal(firstReaction.state.phase, "REACTION_SELECTION");
  assert.equal(firstReaction.state.pendingAction.attack.attackNumber, 2);
  assert.notEqual(
    firstReaction.state.pendingAction.attack.reactionId,
    firstReactionId
  );
  assert.equal(firstReaction.state.players[setup.targetId]?.hp, 38);
  assert.deepEqual(
    firstReaction.state.players[setup.targetId]?.hand.map(
      ({ instanceId }) => instanceId
    ),
    ["armor-2"]
  );
  assert.equal(
    firstReaction.events.some(({ type }) => type === "CARD_GRANTED"),
    false
  );

  const secondReaction = handleCommand(firstReaction.state, {
    type: "DECLARE_REACTION",
    matchId: firstReaction.state.matchId,
    commandId: "second-defense",
    actorId: setup.targetId,
    expectedRevision: firstReaction.state.revision,
    reactionId: firstReaction.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["armor-2"]
  });
  assert.equal(secondReaction.ok, true);
  if (!secondReaction.ok) return;
  assert.equal(secondReaction.state.players[setup.targetId]?.hp, 36);
  assert.equal(secondReaction.state.players[setup.actorId]?.hand.length, 1);
  assert.equal(secondReaction.state.players[setup.targetId]?.hand.length, 2);
  assert.equal(
    secondReaction.events.filter(({ type }) => type === "CARD_GRANTED").length,
    3
  );
  assert.equal(secondReaction.state.gfCount, 2);
});

test("an all-enemy attack resolves targets one at a time in deterministic random order", () => {
  const original = createFourPlayerMatch("all-enemy").state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const enemyIds = Object.keys(original.players).filter((id) => id !== actorId);
  const state: MatchState = {
    ...original,
    players: Object.fromEntries(
      Object.entries(original.players).map(([playerId, player]) => [
        playerId,
        {
          ...player,
          hand:
            playerId === actorId
              ? [
                  card("sword", "god-sword"),
                  card("mirage-card", "mirage")
                ]
              : []
        }
      ])
    )
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "all-enemy-action",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["sword", "mirage-card"],
    targetPlayerId: enemyIds[0]!
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const targetOrder = action.state.pendingAction.targetPlayerIds;
  assert.deepEqual([...targetOrder].sort(), [...enemyIds].sort());
  assert.equal(new Set(targetOrder).size, 3);
  assert.equal(action.state.pendingAction.attack.totalTargets, 3);
  assert.equal(action.state.players[actorId]?.mp, 5);

  let currentState = action.state;
  const resolvedTargets: string[] = [];
  for (let index = 0; index < targetOrder.length; index += 1) {
    const pending = currentState.pendingAction;
    assert.equal(pending?.kind, "ATTACK");
    if (pending?.kind !== "ATTACK") return;
    resolvedTargets.push(pending.attack.targetPlayerId);
    const reaction = handleCommand(currentState, {
      type: "DECLARE_REACTION",
      matchId: currentState.matchId,
      commandId: `all-defense-${index}`,
      actorId: pending.attack.targetPlayerId,
      expectedRevision: currentState.revision,
      reactionId: pending.attack.reactionId,
      defenseCardInstanceIds: []
    });
    assert.equal(reaction.ok, true);
    if (!reaction.ok) return;
    currentState = reaction.state;
    if (index < targetOrder.length - 1) {
      assert.equal(currentState.phase, "REACTION_SELECTION");
      assert.equal(
        reaction.events.some(({ type }) => type === "CARD_GRANTED"),
        false
      );
    }
  }
  assert.deepEqual(resolvedTargets, targetOrder);
  for (const enemyId of enemyIds) {
    assert.equal(currentState.players[enemyId]?.hp, 10);
  }
  assert.equal(currentState.players[actorId]?.hand.length, 2);
  assert.equal(currentState.gfCount, 2);
  assert.equal(
    currentState.randomLog.filter(
      ({ context }) => context === "TARGET_SELECTION"
    ).length,
    3
  );
});

test("dark cloud makes every target of a percentage attack hit without hit RNG", () => {
  const original = createFourPlayerMatch("dark-cloud").state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const enemyIds = Object.keys(original.players).filter((id) => id !== actorId);
  const state: MatchState = {
    ...original,
    players: Object.fromEntries(
      Object.entries(original.players).map(([playerId, player]) => [
        playerId,
        {
          ...player,
          hand:
            playerId === actorId
              ? [card("spark-bag", "spark-bag")]
              : [],
          calamities:
            playerId === actorId ? player.calamities : { DARK_CLOUD: true }
        }
      ])
    )
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "dark-cloud-attack",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["spark-bag"],
    targetPlayerId: enemyIds[0]!
  });
  assert.equal(action.ok, true);
  if (!action.ok) return;
  let currentState = action.state;
  for (let index = 0; index < enemyIds.length; index += 1) {
    const pending = currentState.pendingAction;
    assert.equal(pending?.kind, "ATTACK");
    if (pending?.kind !== "ATTACK") return;
    assert.equal(pending.attack.hit, true);
    const reaction = handleCommand(currentState, {
      type: "DECLARE_REACTION",
      matchId: currentState.matchId,
      commandId: `dark-cloud-defense-${index}`,
      actorId: pending.attack.targetPlayerId,
      expectedRevision: currentState.revision,
      reactionId: pending.attack.reactionId,
      defenseCardInstanceIds: []
    });
    assert.equal(reaction.ok, true);
    if (!reaction.ok) return;
    currentState = reaction.state;
  }
  for (const enemyId of enemyIds) {
    assert.equal(currentState.players[enemyId]?.hp, 39);
  }
  assert.equal(
    currentState.randomLog.some(({ context }) => context === "HIT_CHECK"),
    false
  );
});

test("fog replaces the declared enemy target with a logged random living enemy", () => {
  const original = createFourPlayerMatch("fog-base").state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const enemies = Object.values(original.players)
    .filter(({ playerId, alive }) => playerId !== actorId && alive)
    .sort((left, right) => left.seat - right.seat);
  const requestedTargetId = enemies[0]?.playerId;
  assert.ok(requestedTargetId);
  const state: MatchState = {
    ...original,
    rng: createRng("fog-reroute"),
    randomLog: [],
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        calamities: { FOG: true },
        hand: [card("fog-weapon", "god-sword")]
      }
    }
  };
  const result = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "fog-reroutes-target",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["fog-weapon"],
    targetPlayerId: requestedTargetId
  });

  assert.equal(result.ok, true);
  if (!result.ok || result.state.pendingAction?.kind !== "ATTACK") return;
  const selectedTargetId = result.state.pendingAction.attack.targetPlayerId;
  assert.equal(
    enemies.some(({ playerId }) => playerId === selectedTargetId),
    true
  );
  assert.notEqual(selectedTargetId, requestedTargetId);
  const targetAudit = result.state.randomLog.find(
    ({ context }) => context === "TARGET_SELECTION"
  );
  assert.ok(targetAudit);
  assert.equal(
    targetAudit?.selectedKey.endsWith(`:${selectedTargetId}`),
    true
  );
});

test("a miracle is learned on first use, spends MP, and is reusable without consumption", () => {
  const setup = withHands(
    createTwoPlayerMatch("miracle").state,
    [card("ice-card", "ice")],
    []
  );
  const firstCast = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "learn-ice",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["ice-card"],
    targetPlayerId: setup.targetId
  });
  assert.equal(firstCast.ok, true);
  if (!firstCast.ok || firstCast.state.pendingAction?.kind !== "ATTACK") return;
  assert.equal(firstCast.state.players[setup.actorId]?.mp, 8);
  assert.equal(firstCast.state.players[setup.actorId]?.hand.length, 0);
  assert.deepEqual(firstCast.state.players[setup.actorId]?.learnedMiracles, [
    {
      learnedMiracleId: "ice-card:learned",
      cardDefinitionId: "ice"
    }
  ]);
  const firstResolution = handleCommand(firstCast.state, {
    type: "DECLARE_REACTION",
    matchId: firstCast.state.matchId,
    commandId: "first-miracle-defense",
    actorId: setup.targetId,
    expectedRevision: firstCast.state.revision,
    reactionId: firstCast.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(firstResolution.ok, true);
  if (!firstResolution.ok) return;
  assert.equal(firstResolution.state.players[setup.actorId]?.hand.length, 1);

  const reusableState: MatchState = {
    ...firstResolution.state,
    activePlayerId: setup.actorId,
    turnCursor: firstResolution.state.turnOrder.indexOf(setup.actorId),
    phase: "ACTION_SELECTION"
  };
  const handCountBeforeReuse =
    reusableState.players[setup.actorId]?.hand.length ?? 0;
  const secondCast = handleCommand(reusableState, {
    type: "DECLARE_ACTION",
    matchId: reusableState.matchId,
    commandId: "reuse-ice",
    actorId: setup.actorId,
    expectedRevision: reusableState.revision,
    cardInstanceIds: [],
    learnedMiracleIds: ["ice-card:learned"],
    targetPlayerId: setup.targetId
  });
  assert.equal(secondCast.ok, true);
  if (!secondCast.ok) return;
  assert.equal(secondCast.state.players[setup.actorId]?.mp, 6);
  assert.equal(
    secondCast.state.players[setup.actorId]?.hand.length,
    handCountBeforeReuse
  );
  assert.equal(
    secondCast.events.some(({ type }) => type === "MIRACLE_CAST"),
    true
  );
  assert.equal(
    secondCast.events.some(
      ({ type }) => type === "MIRACLE_LEARNED" || type === "CARD_CONSUMED"
    ),
    false
  );
});

test("miracles reject insufficient MP before producing any events", () => {
  const setup = withHands(
    createTwoPlayerMatch("low-mp").state,
    [card("ice-card", "ice")],
    []
  );
  const lowMpState: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        mp: 1
      }
    }
  };
  const result = handleCommand(lowMpState, {
    type: "DECLARE_ACTION",
    matchId: lowMpState.matchId,
    commandId: "too-expensive",
    actorId: setup.actorId,
    expectedRevision: lowMpState.revision,
    cardInstanceIds: ["ice-card"],
    targetPlayerId: setup.targetId
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "INSUFFICIENT_MP");
    assert.equal(result.state.players[setup.actorId]?.mp, 1);
  }
});

test("a cost-cutting weapon makes an additive miracle free while still learning it", () => {
  const setup = withHands(
    createTwoPlayerMatch("free-miracle").state,
    [
      card("staff", "spiritual-staff"),
      card("fireball-card", "fireball")
    ],
    []
  );
  const result = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "free-fireball",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["staff", "fireball-card"],
    targetPlayerId: setup.targetId
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.state.pendingAction?.kind !== "ATTACK") return;
  assert.equal(result.state.players[setup.actorId]?.mp, 10);
  assert.equal(result.state.pendingAction.attack.power, 14);
  assert.deepEqual(result.state.players[setup.actorId]?.learnedMiracles, [
    {
      learnedMiracleId: "fireball-card:learned",
      cardDefinitionId: "fireball"
    }
  ]);
  assert.equal(result.events.some(({ type }) => type === "MP_SPENT"), false);
});

test("a direct healing miracle spends MP, becomes learned, and resolves on its user", () => {
  const setup = withHands(
    createTwoPlayerMatch("spring").state,
    [card("spring-card", "spring")],
    []
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        hp: 35
      }
    }
  };
  const result = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "spring-action",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["spring-card"],
    targetPlayerId: setup.actorId
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.players[setup.actorId]?.hp, 45);
  assert.equal(result.state.players[setup.actorId]?.mp, 3);
  assert.deepEqual(result.state.players[setup.actorId]?.learnedMiracles, [
    {
      learnedMiracleId: "spring-card:learned",
      cardDefinitionId: "spring"
    }
  ]);
  assert.equal(result.state.players[setup.actorId]?.hand.length, 1);
  assert.equal(
    result.events.some(
      (event) =>
        event.type === "RESOURCE_CHANGED" &&
        event.resource === "HP" &&
        event.valueAfter === 45
    ),
    true
  );
});

test("receiving another disease worsens the existing disease", () => {
  const setup = withHands(
    createTwoPlayerMatch("disease").state,
    [card("wind-card", "wind")],
    []
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.targetId]: {
        ...setup.state.players[setup.targetId]!,
        calamities: { COLD: true }
      }
    }
  };
  const result = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "disease-action",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["wind-card"],
    targetPlayerId: setup.targetId
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const forgiven = forgivePendingReaction(result.state, "forgive-disease");
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;
  assert.equal(forgiven.state.players[setup.targetId]?.calamities.COLD, undefined);
  assert.equal(forgiven.state.players[setup.targetId]?.calamities.FEVER, true);
});

test("a cleansing miracle removes only mild calamities", () => {
  const setup = withHands(
    createTwoPlayerMatch("cleanse").state,
    [card("tone-card", "tone")],
    []
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        calamities: {
          COLD: true,
          FOG: true,
          DREAM: true,
          DARK_CLOUD: true
        }
      }
    }
  };
  const result = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "cleanse-action",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["tone-card"],
    targetPlayerId: setup.actorId
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.state.players[setup.actorId]?.calamities, {
    DREAM: true,
    DARK_CLOUD: true
  });
});

test("a guardian miracle assigns an unoccupied guardian deterministically", () => {
  const setup = withHands(
    createTwoPlayerMatch("guardian").state,
    [card("release-card", "release")],
    []
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        mp: 20
      },
      [setup.targetId]: {
        ...setup.state.players[setup.targetId]!,
        guardian: {
          guardianId: "occupied",
          guardianName: "太陽神"
        }
      }
    }
  };
  const result = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "guardian-action",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["release-card"],
    targetPlayerId: setup.actorId
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const guardian = result.state.players[setup.actorId]?.guardian;
  assert.notEqual(guardian, null);
  assert.notEqual(guardian?.guardianName, "太陽神");
  assert.equal(
    result.events.some((event) => event.type === "GUARDIAN_ASSIGNED"),
    true
  );
});

test("turn-end disease worsens before applying the resulting disease effect", () => {
  const base = createTwoPlayerMatch("turn-end-disease").state;
  const actorId = base.activePlayerId;
  assert.ok(actorId);
  const stableState: MatchState = {
    ...base,
    rng: createRng("s0"),
    players: {
      ...base.players,
      [actorId]: {
        ...base.players[actorId]!,
        hp: 10,
        hand: [card("stable-discard", "leather-cap")],
        calamities: { COLD: true }
      }
    }
  };
  const stable = handleCommand(stableState, {
    type: "DISCARD",
    matchId: stableState.matchId,
    commandId: "stable-disease",
    actorId,
    expectedRevision: stableState.revision,
    cardInstanceId: "stable-discard"
  });
  assert.equal(stable.ok, true);
  if (!stable.ok) return;
  assert.equal(stable.state.players[actorId]?.hp, 9);
  assert.deepEqual(stable.state.players[actorId]?.calamities, {
    COLD: true
  });
  assert.equal(
    stable.events.some(
      (event) =>
        event.type === "CALAMITY_WORSEN_CHECKED" && !event.worsened
    ),
    true
  );

  const worseningState: MatchState = {
    ...base,
    rng: createRng("s1"),
    players: {
      ...base.players,
      [actorId]: {
        ...base.players[actorId]!,
        hp: 10,
        hand: [card("worsen-discard", "leather-cap")],
        calamities: { FEVER: true }
      }
    }
  };
  const worsening = handleCommand(worseningState, {
    type: "DISCARD",
    matchId: worseningState.matchId,
    commandId: "worsening-disease",
    actorId,
    expectedRevision: worseningState.revision,
    cardInstanceId: "worsen-discard"
  });
  assert.equal(worsening.ok, true);
  if (!worsening.ok) return;
  assert.equal(worsening.state.players[actorId]?.hp, 5);
  assert.deepEqual(worsening.state.players[actorId]?.calamities, {
    HELL_SICKNESS: true
  });
  const eventTypes = worsening.events.map(({ type }) => type);
  assert.ok(
    eventTypes.indexOf("CALAMITY_WORSEN_CHECKED") <
      eventTypes.indexOf("CALAMITY_WORSENED")
  );
  assert.ok(
    eventTypes.indexOf("CALAMITY_WORSENED") <
      eventTypes.indexOf("RESOURCE_CHANGED")
  );
  assert.equal(
    worsening.state.randomLog.at(-1)?.context,
    "CALAMITY_WORSEN"
  );
});

test("every disease applies its turn-end effect and heaven sickness can trigger HP zero", () => {
  const base = createTwoPlayerMatch("all-disease-effects").state;
  const actorId = base.activePlayerId;
  assert.ok(actorId);
  const cases = [
    { disease: "COLD", expectedHp: 9 },
    { disease: "FEVER", expectedHp: 8 },
    { disease: "HELL_SICKNESS", expectedHp: 5 },
    { disease: "HEAVEN_SICKNESS", expectedHp: 15 }
  ] as const;
  for (const { disease, expectedHp } of cases) {
    const cardInstanceId = `discard-${disease}`;
    const state: MatchState = {
      ...base,
      rng: createRng("s0"),
      players: {
        ...base.players,
        [actorId]: {
          ...base.players[actorId]!,
          hp: 10,
          hand: [card(cardInstanceId, "leather-cap")],
          calamities: { [disease]: true }
        }
      }
    };
    const result = handleCommand(state, {
      type: "DISCARD",
      matchId: state.matchId,
      commandId: `resolve-${disease}`,
      actorId,
      expectedRevision: state.revision,
      cardInstanceId
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.state.players[actorId]?.hp, expectedHp);
  }

  const fatalState: MatchState = {
    ...base,
    rng: createRng("s1"),
    players: {
      ...base.players,
      [actorId]: {
        ...base.players[actorId]!,
        hp: 10,
        hand: [
          card("fatal-heaven-discard", "leather-cap"),
          card("fatal-heaven-revival", "sun-amulet")
        ],
        calamities: { HEAVEN_SICKNESS: true }
      }
    }
  };
  const fatal = handleCommand(fatalState, {
    type: "DISCARD",
    matchId: fatalState.matchId,
    commandId: "fatal-heaven-sickness",
    actorId,
    expectedRevision: fatalState.revision,
    cardInstanceId: "fatal-heaven-discard"
  });
  assert.equal(fatal.ok, true);
  if (!fatal.ok) return;
  assert.equal(fatal.state.players[actorId]?.alive, true);
  assert.equal(fatal.state.players[actorId]?.hp, 10);
  assert.equal(
    fatal.state.players[actorId]?.calamities.HEAVEN_SICKNESS,
    true
  );
  assert.equal(
    fatal.events.some(({ type }) => type === "REVIVAL_RESOLVED"),
    true
  );
});

test("match result waits for turn-end disease after a lethal action", () => {
  const setup = withHands(
    createTwoPlayerMatch("deferred-result").state,
    [],
    [],
    1
  );
  const state: MatchState = {
    ...setup.state,
    rng: createRng("s0"),
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        hp: 1,
        calamities: { COLD: true },
        learnedMiracles: [
          {
            learnedMiracleId: "learned-flame",
            cardDefinitionId: "flame"
          }
        ]
      }
    }
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "lethal-before-disease",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: [],
    learnedMiracleIds: ["learned-flame"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "accept-lethal-before-disease",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.phase, "MATCH_ENDED");
  assert.equal(reaction.state.result?.kind, "DRAW");
  const firstAscension = reaction.events.findIndex(
    (event) =>
      event.type === "PLAYER_ASCENDED" &&
      event.playerId === setup.targetId
  );
  const diseaseCheck = reaction.events.findIndex(
    ({ type }) => type === "CALAMITY_WORSEN_CHECKED"
  );
  const secondAscension = reaction.events.findIndex(
    (event) =>
      event.type === "PLAYER_ASCENDED" &&
      event.playerId === setup.actorId
  );
  const matchEnded = reaction.events.findIndex(
    ({ type }) => type === "MATCH_ENDED"
  );
  assert.ok(firstAscension < diseaseCheck);
  assert.ok(diseaseCheck < secondAscension);
  assert.ok(secondAscension < matchEnded);
});

test("a guardian checks at 25 percent and resolves a weighted direct action", () => {
  const base = createTwoPlayerMatch("guardian-direct").state;
  const actorId = base.activePlayerId;
  assert.ok(actorId);
  const guardianPlayerId = Object.keys(base.players).find(
    (playerId) => playerId !== actorId
  );
  assert.ok(guardianPlayerId);
  const state: MatchState = {
    ...base,
    rng: createRng("s0"),
    players: {
      ...base.players,
      [actorId]: {
        ...base.players[actorId]!,
        hand: [card("guardian-direct-discard", "leather-cap")]
      },
      [guardianPlayerId]: {
        ...base.players[guardianPlayerId]!,
        mp: 10,
        guardian: {
          guardianId: "neptune-guardian",
          guardianName: "海王神"
        }
      }
    }
  };
  const command = {
    type: "DISCARD",
    matchId: state.matchId,
    commandId: "guardian-direct",
    actorId,
    expectedRevision: state.revision,
    cardInstanceId: "guardian-direct-discard"
  } as const;
  const result = handleCommand(state, command);
  const replay = handleCommand(structuredClone(state), command);
  assert.deepEqual(result, replay);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.players[guardianPlayerId]?.mp, 15);
  assert.equal(result.state.gfCount, state.gfCount + 1);
  assert.equal(
    result.events.some(
      (event) =>
        event.type === "GUARDIAN_CHECKED" &&
        event.playerId === guardianPlayerId &&
        event.acted
    ),
    true
  );
  assert.equal(
    result.events.some(
      (event) =>
        event.type === "GUARDIAN_ACTION_SELECTED" &&
        event.actionCardDefinitionId ===
          "guardian-action-033-海王神-磯の香り"
    ),
    true
  );
  assert.deepEqual(
    result.state.randomLog.slice(-2).map(({ context }) => context),
    ["GUARDIAN_CHECK", "GUARDIAN_ACTION"]
  );
});

test("a guardian attack pauses for defense and resumes remaining automatic effects", () => {
  const base = createTwoPlayerMatch("guardian-attack").state;
  const actorId = base.activePlayerId;
  assert.ok(actorId);
  const guardianPlayerId = Object.keys(base.players).find(
    (playerId) => playerId !== actorId
  );
  assert.ok(guardianPlayerId);
  const state: MatchState = {
    ...base,
    rng: createRng("s0"),
    players: {
      ...base.players,
      [actorId]: {
        ...base.players[actorId]!,
        hand: [card("guardian-attack-discard", "leather-cap")]
      },
      [guardianPlayerId]: {
        ...base.players[guardianPlayerId]!,
        guardian: {
          guardianId: "moon-guardian",
          guardianName: "月神"
        }
      }
    }
  };
  const action = handleCommand(state, {
    type: "DISCARD",
    matchId: state.matchId,
    commandId: "start-guardian-attack",
    actorId,
    expectedRevision: state.revision,
    cardInstanceId: "guardian-attack-discard"
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  assert.equal(action.state.phase, "REACTION_SELECTION");
  assert.equal(action.state.pendingAction.attack.attackKind, "WEAPON");
  assert.equal(action.state.pendingAction.completion, "RESUME_POST_TURN");
  assert.notEqual(action.state.postTurnAutomatic, null);

  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "accept-guardian-attack",
    actorId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[actorId]?.hp, 30);
  assert.equal(reaction.state.postTurnAutomatic, null);
  assert.equal(reaction.state.phase, "ACTION_SELECTION");
  assert.equal(reaction.state.gfCount, state.gfCount + 1);
  assert.equal(
    reaction.events.some(
      ({ type }) => type === "POST_TURN_AUTOMATIC_EFFECTS_COMPLETED"
    ),
    true
  );
});

test("all queued guardians are checked before a guardian-caused match result", () => {
  const base = createMatch({
    matchId: "guardian-team-match",
    seed: "guardian-team-order",
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" },
      { playerId: "c", displayName: "C" }
    ]
  }).state;
  const actorId = base.activePlayerId;
  assert.ok(actorId);
  const guardianPlayers = Object.values(base.players)
    .filter(({ playerId }) => playerId !== actorId)
    .sort((left, right) => left.seat - right.seat);
  const firstGuardianPlayer = guardianPlayers[0];
  const secondGuardianPlayer = guardianPlayers[1];
  assert.ok(firstGuardianPlayer);
  assert.ok(secondGuardianPlayer);
  const state: MatchState = {
    ...base,
    rng: createRng("s0"),
    players: {
      ...base.players,
      [actorId]: {
        ...base.players[actorId]!,
        teamId: "actor-team",
        hp: 1,
        hand: [card("team-discard", "leather-cap")]
      },
      [firstGuardianPlayer.playerId]: {
        ...firstGuardianPlayer,
        teamId: "guardian-team",
        guardian: {
          guardianId: "first-team-guardian",
          guardianName: "月神"
        }
      },
      [secondGuardianPlayer.playerId]: {
        ...secondGuardianPlayer,
        teamId: "guardian-team",
        guardian: {
          guardianId: "second-team-guardian",
          guardianName: "海王神"
        }
      }
    }
  };
  const action = handleCommand(state, {
    type: "DISCARD",
    matchId: state.matchId,
    commandId: "start-team-guardian-attack",
    actorId,
    expectedRevision: state.revision,
    cardInstanceId: "team-discard"
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "accept-team-guardian-attack",
    actorId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.phase, "MATCH_ENDED");
  assert.equal(reaction.state.result?.kind, "WIN");
  const allEvents = [...action.events, ...reaction.events];
  assert.deepEqual(
    allEvents
      .filter(({ type }) => type === "GUARDIAN_CHECKED")
      .map((event) =>
        event.type === "GUARDIAN_CHECKED" ? event.playerId : ""
      ),
    [firstGuardianPlayer.playerId, secondGuardianPlayer.playerId]
  );
  const secondGuardianCheck = reaction.events.findIndex(
    (event) =>
      event.type === "GUARDIAN_CHECKED" &&
      event.playerId === secondGuardianPlayer.playerId
  );
  const matchEnded = reaction.events.findIndex(
    ({ type }) => type === "MATCH_ENDED"
  );
  assert.ok(secondGuardianCheck < matchEnded);
});

test("a guardian can depart after its host loses HP", () => {
  const setup = withHands(
    createTwoPlayerMatch("guardian-departure").state,
    [card("departure-weapon", "bronze-club")],
    []
  );
  const state: MatchState = {
    ...setup.state,
    rng: createRng("s20"),
    players: {
      ...setup.state.players,
      [setup.targetId]: {
        ...setup.state.players[setup.targetId]!,
        guardian: {
          guardianId: "departing-guardian",
          guardianName: "月神"
        }
      }
    }
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "damage-guardian-host",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["departure-weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "accept-guardian-host-damage",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.guardian, null);
  assert.equal(
    reaction.events.some(
      (event) =>
        event.type === "GUARDIAN_DEPARTED" &&
        event.guardianId === "departing-guardian"
    ),
    true
  );
  assert.equal(
    reaction.state.randomLog.some(
      ({ context }) => context === "GUARDIAN_DEPARTURE"
    ),
    true
  );
});

test("flash limits a reaction to one defense card", () => {
  const setup = withHands(
    createTwoPlayerMatch("flash-defense").state,
    [card("weapon", "god-sword")],
    [
      card("armor-1", "leather-cap"),
      card("armor-2", "leather-cap")
    ]
  );
  const flashedState: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.targetId]: {
        ...setup.state.players[setup.targetId]!,
        calamities: { FLASH: true }
      }
    }
  };
  const action = handleCommand(flashedState, {
    type: "DECLARE_ACTION",
    matchId: flashedState.matchId,
    commandId: "flash-attack",
    actorId: setup.actorId,
    expectedRevision: flashedState.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "too-many-armors",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["armor-1", "armor-2"]
  });
  assert.equal(reaction.ok, false);
  if (!reaction.ok) assert.equal(reaction.code, "INVALID_CARD_SELECTION");
});

test("a first-use wall miracle stops a physical weapon and becomes learned", () => {
  const setup = withHands(
    createTwoPlayerMatch("wall").state,
    [card("weapon", "god-sword")],
    [card("wall-card", "wall")]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "wall-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "wall-reaction",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["wall-card"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 40);
  assert.equal(reaction.state.players[setup.targetId]?.mp, 4);
  assert.deepEqual(reaction.state.players[setup.targetId]?.learnedMiracles, [
    {
      learnedMiracleId: "wall-card:learned",
      cardDefinitionId: "wall"
    }
  ]);
  assert.equal(reaction.state.players[setup.targetId]?.hand.length, 1);
  assert.equal(
    reaction.events.some(({ type }) => type === "ATTACK_STOPPED"),
    true
  );
  assert.equal(
    reaction.events.some(({ type }) => type === "DAMAGE_APPLIED"),
    false
  );
});

test("reflections reuse the attack ID and create a new reaction for every target change", () => {
  const setup = withHands(
    createTwoPlayerMatch("reflection-chain").state,
    [
      card("weapon", "bronze-club"),
      card("actor-mirror", "super-mirror")
    ],
    [card("target-mirror", "super-mirror")]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "reflection-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const attackId = action.state.pendingAction.attack.attackId;
  const firstReactionId = action.state.pendingAction.attack.reactionId;
  const firstReflection = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "first-reflection",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: firstReactionId,
    defenseCardInstanceIds: ["target-mirror"]
  });
  assert.equal(firstReflection.ok, true);
  if (
    !firstReflection.ok ||
    firstReflection.state.pendingAction?.kind !== "ATTACK"
  ) return;
  assert.equal(firstReflection.state.pendingAction.attack.attackId, attackId);
  assert.equal(
    firstReflection.state.pendingAction.attack.targetPlayerId,
    setup.actorId
  );
  assert.notEqual(
    firstReflection.state.pendingAction.attack.reactionId,
    firstReactionId
  );

  const secondReflection = handleCommand(firstReflection.state, {
    type: "DECLARE_REACTION",
    matchId: firstReflection.state.matchId,
    commandId: "second-reflection",
    actorId: setup.actorId,
    expectedRevision: firstReflection.state.revision,
    reactionId: firstReflection.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["actor-mirror"]
  });
  assert.equal(secondReflection.ok, true);
  if (
    !secondReflection.ok ||
    secondReflection.state.pendingAction?.kind !== "ATTACK"
  ) return;
  assert.equal(secondReflection.state.pendingAction.attack.attackId, attackId);
  assert.equal(
    secondReflection.state.pendingAction.attack.targetPlayerId,
    setup.targetId
  );
  assert.equal(secondReflection.state.pendingAction.attack.reactionDepth, 3);

  const forgive = handleCommand(secondReflection.state, {
    type: "DECLARE_REACTION",
    matchId: secondReflection.state.matchId,
    commandId: "reflection-forgive",
    actorId: setup.targetId,
    expectedRevision: secondReflection.state.revision,
    reactionId: secondReflection.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(forgive.ok, true);
  if (!forgive.ok) return;
  assert.equal(forgive.state.players[setup.targetId]?.hp, 39);
  assert.equal(forgive.state.players[setup.actorId]?.hp, 40);
  assert.equal(
    forgive.events.filter(({ type }) => type === "CARD_GRANTED").length,
    3
  );
});

test("a failed bounce returning to its user deals damage without another reaction", () => {
  const setup = withHands(
    createTwoPlayerMatch("bounce-0").state,
    [card("ice-card", "ice")],
    [card("boots", "sky-boots")]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "bounce-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["ice-card"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "failed-bounce",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["boots"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  const redirect = reaction.events.find(
    ({ type }) => type === "ATTACK_REDIRECTED"
  );
  assert.equal(redirect?.type, "ATTACK_REDIRECTED");
  if (redirect?.type === "ATTACK_REDIRECTED") {
    assert.equal(redirect.redirectType, "BOUNCE");
    assert.equal(redirect.targetPlayerId, setup.targetId);
  }
  assert.equal(reaction.state.players[setup.targetId]?.hp, 36);
  assert.equal(
    reaction.events.some(({ type }) => type === "REACTION_REQUESTED"),
    false
  );
  assert.equal(reaction.state.gfCount, 2);
});

test("an absorbing weapon heals its current attacker by dealt damage", () => {
  const setup = withHands(
    createTwoPlayerMatch("absorption").state,
    [card("ghost", "ghost-sword")],
    []
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        hp: 10
      }
    }
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "absorb-attack",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["ghost"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "absorb-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 33);
  assert.equal(reaction.state.players[setup.actorId]?.hp, 17);
});

test("self damage can ascend both players in one turn and produce a draw", () => {
  const setup = withHands(
    createTwoPlayerMatch("self-damage").state,
    [card("evil-sword", "evil-broadsword")],
    [],
    10
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        hp: 10
      }
    }
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "self-damage-attack",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["evil-sword"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "self-damage-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.actorId]?.alive, false);
  assert.equal(reaction.state.players[setup.targetId]?.alive, false);
  assert.deepEqual(reaction.state.result, {
    kind: "DRAW",
    winnerPlayerIds: [],
    winnerTeamId: null
  });
});

test("a damage counter ring retaliates after incoming damage", () => {
  const setup = withHands(
    createTwoPlayerMatch("counter-ring").state,
    [card("weapon", "bronze-club")],
    [card("ring", "saturn-ring")]
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        hp: 10
      }
    }
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "counter-attack",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "ring-counter",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["ring"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 39);
  assert.equal(reaction.state.players[setup.actorId]?.hp, 8);
  assert.equal(reaction.state.players[setup.targetId]?.hand.length, 1);
});

test("venus ring transfers money equal to received damage", () => {
  const setup = withHands(
    createTwoPlayerMatch("venus-ring").state,
    [card("weapon", "spark-bag")],
    [card("ring", "venus-ring")]
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        money: 8
      },
      [setup.targetId]: {
        ...setup.state.players[setup.targetId]!,
        money: 5
      }
    }
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "venus-attack",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "venus-counter",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["ring"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.actorId]?.money, 7);
  assert.equal(reaction.state.players[setup.targetId]?.money, 6);
});

test("rainbow curtain filters an elemental attack before ordinary defense", () => {
  const setup = withHands(
    createTwoPlayerMatch("element-filter").state,
    [card("torch", "torch")],
    [
      card("curtain", "rainbow-curtain"),
      card("armor", "leather-cap")
    ]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "fire-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["torch"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "filtered-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["curtain", "armor"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 40);
  assert.equal(reaction.state.players[setup.targetId]?.hand.length, 2);
  assert.equal(
    reaction.events.some(({ type }) => type === "ATTACK_ELEMENT_FILTERED"),
    true
  );
});

test("on-damage weapon effects apply their calamity after positive damage", () => {
  const setup = withHands(
    createTwoPlayerMatch("on-damage-calamity").state,
    [card("gale", "gale-sword")],
    []
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "gale-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["gale"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "gale-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 31);
  assert.equal(reaction.state.players[setup.targetId]?.calamities.COLD, true);
});

test("dark residual damage sets HP to zero and ends a two-player match", () => {
  const setup = withHands(
    createTwoPlayerMatch("dark").state,
    [card("dark-weapon", "death-s-scythe")],
    [card("armor", "leather-cap")]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "dark-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["dark-weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok) return;
  const pending = action.state.pendingAction;
  assert.equal(pending?.kind, "ATTACK");
  if (pending?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "dark-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: pending.attack.reactionId,
    defenseCardInstanceIds: ["armor"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 0);
  assert.equal(reaction.state.players[setup.targetId]?.alive, false);
  assert.equal(reaction.state.phase, "MATCH_ENDED");
  assert.deepEqual(reaction.state.result, {
    kind: "WIN",
    winnerPlayerIds: [setup.actorId],
    winnerTeamId: null
  });
});

test("a fully defended dark attack deals zero damage and does not ascend its target", () => {
  const setup = withHands(
    createTwoPlayerMatch("dark-zero-residual").state,
    [card("dark-weapon", "cobra")],
    [card("god-shield", "god-shield")]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "dark-zero-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["dark-weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "dark-zero-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["god-shield"]
  });

  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.hp, 40);
  assert.equal(reaction.state.players[setup.targetId]?.alive, true);
  const damage = reaction.events.find(
    ({ type }) => type === "DAMAGE_APPLIED"
  );
  assert.ok(damage && damage.type === "DAMAGE_APPLIED");
  if (damage?.type === "DAMAGE_APPLIED") {
    assert.equal(damage.amount, 0);
  }
});

test("sun amulet interrupts HP zero before ascension", () => {
  const setup = withHands(
    createTwoPlayerMatch("revival").state,
    [card("god-sword", "god-sword")],
    [card("amulet", "sun-amulet")],
    5
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "lethal",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["god-sword"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "forgive",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(reaction.state.players[setup.targetId]?.alive, true);
  assert.equal(reaction.state.players[setup.targetId]?.hp, 10);
  assert.equal(
    reaction.events.some(({ type }) => type === "REVIVAL_RESOLVED"),
    true
  );
});

test("stale commands are rejected and command IDs are idempotent", () => {
  const state = createTwoPlayerMatch("commands").state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const stale = handleCommand(state, {
    type: "SURRENDER",
    matchId: state.matchId,
    commandId: "stale",
    actorId,
    expectedRevision: state.revision - 1
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "STALE_REVISION");

  const command = {
    type: "SURRENDER" as const,
    matchId: state.matchId,
    commandId: "same-id",
    actorId,
    expectedRevision: state.revision
  };
  const first = handleCommand(state, command);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const duplicate = handleCommand(first.state, command);
  assert.equal(duplicate.ok, true);
  if (!duplicate.ok) return;
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.events, first.events);
  assert.equal(duplicate.state.revision, first.state.revision);
});

test("the seven-element defense table follows the specification", () => {
  assert.equal(canDefenseBlock("PHYSICAL", "PHYSICAL"), true);
  assert.equal(canDefenseBlock("WATER", "FIRE"), true);
  assert.equal(canDefenseBlock("FIRE", "WATER"), true);
  assert.equal(canDefenseBlock("EARTH", "WOOD"), true);
  assert.equal(canDefenseBlock("WOOD", "EARTH"), true);
  assert.equal(canDefenseBlock("LIGHT", "FIRE"), true);
  assert.equal(canDefenseBlock("LIGHT", "LIGHT"), false);
  assert.equal(canDefenseBlock("PHYSICAL", "DARK"), true);
});

test("exchange redistributes HP, MP, and money without changing their total", () => {
  const setup = withHands(
    createTwoPlayerMatch("exchange").state,
    [card("exchange-card", "exchange")],
    []
  );
  const invalid = handleCommand(setup.state, {
    type: "EXCHANGE_RESOURCES",
    matchId: setup.state.matchId,
    commandId: "invalid-exchange",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "exchange-card",
    hp: 20,
    mp: 20,
    money: 20
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.code, "INVALID_RESOURCE_ALLOCATION");
  }

  const exchanged = handleCommand(setup.state, {
    type: "EXCHANGE_RESOURCES",
    matchId: setup.state.matchId,
    commandId: "valid-exchange",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "exchange-card",
    hp: 25,
    mp: 15,
    money: 30
  });
  assert.equal(exchanged.ok, true);
  if (!exchanged.ok) return;
  const actor = exchanged.state.players[setup.actorId];
  assert.equal(actor?.hp, 25);
  assert.equal(actor?.mp, 15);
  assert.equal(actor?.money, 30);
  assert.equal(actor?.hand.length, 1);
  assert.equal(
    exchanged.events.filter(({ type }) => type === "RESOURCES_EXCHANGED").length,
    1
  );
  const declared = exchanged.events.find(
    (event) => event.type === "ACTION_DECLARED"
  );
  assert.deepEqual(
    declared?.type === "ACTION_DECLARED"
      ? declared.actionCardDefinitionIds
      : null,
    ["exchange"]
  );
});

test("sell transfers one artifact, charges money then MP then HP, and grants only once", () => {
  const setup = withHands(
    createTwoPlayerMatch("sell").state,
    [
      card("sell-card", "sell"),
      card("product", "strength-powder")
    ],
    []
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        money: 5
      },
      [setup.targetId]: {
        ...setup.state.players[setup.targetId]!,
        money: 2,
        mp: 3,
        hp: 20
      }
    }
  };
  const sold = handleCommand(state, {
    type: "SELL_CARD",
    matchId: state.matchId,
    commandId: "sell-product",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceId: "sell-card",
    productCardInstanceId: "product",
    targetPlayerId: setup.targetId
  });
  assert.equal(sold.ok, true);
  if (!sold.ok) return;
  assert.equal(sold.state.phase, "REACTION_SELECTION");
  const forgiven = forgivePendingReaction(sold.state, "accept-sale");
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;
  const seller = forgiven.state.players[setup.actorId];
  const buyer = forgiven.state.players[setup.targetId];
  assert.equal(seller?.money, 20);
  assert.equal(seller?.hand.length, 1);
  assert.equal(buyer?.money, 0);
  assert.equal(buyer?.mp, 0);
  assert.equal(buyer?.hp, 10);
  assert.equal(
    buyer?.hand.some(({ instanceId }) => instanceId === "product"),
    true
  );
  const payment = forgiven.events.find(
    ({ type }) => type === "TRADE_PAYMENT_COLLECTED"
  );
  assert.ok(payment && payment.type === "TRADE_PAYMENT_COLLECTED");
  if (payment?.type === "TRADE_PAYMENT_COLLECTED") {
    assert.deepEqual(
      [payment.moneyPaid, payment.mpPaid, payment.hpPaid],
      [2, 3, 10]
    );
  }
  assert.equal(
    forgiven.events.filter(({ type }) => type === "CARD_GRANTED").length,
    1
  );
});

test("targeted card reactions allow reflection chains before a sale resolves", () => {
  const setup = withHands(
    createTwoPlayerMatch("sell-reflection-chain").state,
    [
      card("sell-card", "sell"),
      card("product", "strength-powder"),
      card("seller-mirror", "super-mirror")
    ],
    [card("buyer-mirror", "super-mirror")]
  );
  const declared = handleCommand(setup.state, {
    type: "SELL_CARD",
    matchId: setup.state.matchId,
    commandId: "reflected-sale",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "sell-card",
    productCardInstanceId: "product",
    targetPlayerId: setup.targetId
  });
  assert.equal(declared.ok, true);
  if (!declared.ok || declared.state.pendingAction?.kind !== "ATTACK") return;
  assert.equal(declared.state.pendingAction.attack.attackKind, "TARGETED_CARD");
  assert.equal(declared.state.pendingAction.attack.targetPlayerId, setup.targetId);

  const firstReflection = handleCommand(declared.state, {
    type: "DECLARE_REACTION",
    matchId: declared.state.matchId,
    commandId: "reflect-sale-1",
    actorId: setup.targetId,
    expectedRevision: declared.state.revision,
    reactionId: declared.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["buyer-mirror"]
  });
  assert.equal(firstReflection.ok, true);
  if (
    !firstReflection.ok ||
    firstReflection.state.pendingAction?.kind !== "ATTACK"
  ) return;
  assert.equal(
    firstReflection.state.pendingAction.attack.targetPlayerId,
    setup.actorId
  );

  const secondReflection = handleCommand(firstReflection.state, {
    type: "DECLARE_REACTION",
    matchId: firstReflection.state.matchId,
    commandId: "reflect-sale-2",
    actorId: setup.actorId,
    expectedRevision: firstReflection.state.revision,
    reactionId: firstReflection.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["seller-mirror"]
  });
  assert.equal(secondReflection.ok, true);
  if (
    !secondReflection.ok ||
    secondReflection.state.pendingAction?.kind !== "ATTACK"
  ) return;
  assert.equal(
    secondReflection.state.pendingAction.attack.targetPlayerId,
    setup.targetId
  );
  assert.equal(secondReflection.state.pendingAction.attack.reactionDepth, 3);

  const forgiven = forgivePendingReaction(
    secondReflection.state,
    "accept-reflected-sale"
  );
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;
  assert.equal(
    forgiven.state.players[setup.targetId]?.hand.some(
      ({ instanceId }) => instanceId === "product"
    ),
    true
  );
});

test("a sold sun amulet moves before HP-zero resolution and can revive its buyer", () => {
  const setup = withHands(
    createTwoPlayerMatch("sell-revival").state,
    [
      card("sell-card", "sell"),
      card("sun-product", "sun-amulet")
    ],
    []
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.targetId]: {
        ...setup.state.players[setup.targetId]!,
        money: 0,
        mp: 0,
        hp: 5
      }
    }
  };
  const sold = handleCommand(state, {
    type: "SELL_CARD",
    matchId: state.matchId,
    commandId: "sell-revival",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceId: "sell-card",
    productCardInstanceId: "sun-product",
    targetPlayerId: setup.targetId
  });
  assert.equal(sold.ok, true);
  if (!sold.ok) return;
  const forgiven = forgivePendingReaction(sold.state, "accept-revival-sale");
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;
  const buyer = forgiven.state.players[setup.targetId];
  assert.equal(buyer?.alive, true);
  assert.equal(buyer?.hp, 10);
  assert.equal(
    forgiven.events.some(({ type }) => type === "REVIVAL_RESOLVED"),
    true
  );
  const transferIndex = forgiven.events.findIndex(
    ({ type }) => type === "CARD_TRANSFERRED"
  );
  const revivalIndex = forgiven.events.findIndex(
    ({ type }) => type === "REVIVAL_RESOLVED"
  );
  assert.ok(transferIndex >= 0 && revivalIndex > transferIndex);
});

test("buy uses a private deterministic offer and transfers only after confirmation", () => {
  const setup = withHands(
    createTwoPlayerMatch("buy").state,
    [card("buy-card", "buy")],
    [card("offered-product", "strength-powder")]
  );
  const state: MatchState = {
    ...setup.state,
    players: {
      ...setup.state.players,
      [setup.actorId]: {
        ...setup.state.players[setup.actorId]!,
        money: 2,
        mp: 3
      }
    }
  };
  const offered = handleCommand(state, {
    type: "DECLARE_BUY",
    matchId: state.matchId,
    commandId: "buy-product",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceId: "buy-card",
    targetPlayerId: setup.targetId
  });
  assert.equal(offered.ok, true);
  if (!offered.ok) return;
  assert.equal(offered.state.phase, "REACTION_SELECTION");
  assert.equal(offered.state.players[setup.actorId]?.hand.length, 0);
  assert.equal(offered.state.players[setup.targetId]?.hand.length, 1);
  const forgiven = forgivePendingReaction(offered.state, "allow-buy");
  assert.equal(forgiven.ok, true);
  if (!forgiven.ok) return;
  assert.equal(forgiven.state.phase, "TRADE_CONFIRMATION");
  assert.equal(forgiven.state.pendingAction?.kind, "TRADE_CONFIRMATION");
  const offerEvent = forgiven.events.find(
    ({ type }) => type === "TRADE_OFFERED"
  );
  assert.ok(offerEvent && offerEvent.type === "TRADE_OFFERED");
  assert.deepEqual(offerEvent?.visibility, {
    scope: "PLAYER",
    playerId: setup.actorId
  });

  const confirmed = handleCommand(forgiven.state, {
    type: "CONFIRM_BUY",
    matchId: forgiven.state.matchId,
    commandId: "confirm-buy-product",
    actorId: setup.actorId,
    expectedRevision: forgiven.state.revision,
    tradeId: "buy-product",
    accept: true
  });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const buyer = confirmed.state.players[setup.actorId];
  const seller = confirmed.state.players[setup.targetId];
  assert.equal(buyer?.money, 0);
  assert.equal(buyer?.mp, 0);
  assert.equal(buyer?.hp, 30);
  assert.equal(buyer?.hand.length, 2);
  assert.equal(
    buyer?.hand.some(({ instanceId }) => instanceId === "offered-product"),
    true
  );
  assert.equal(seller?.money, 35);
  assert.equal(seller?.hand.length, 0);
  assert.equal(
    confirmed.events.filter(({ type }) => type === "CARD_GRANTED").length,
    1
  );
});

test("buy still requires confirmation when the offered artifact costs zero", () => {
  const setup = withHands(
    createTwoPlayerMatch("buy-free").state,
    [card("buy-card", "buy")],
    [card("free-miracle", "fireball")]
  );
  const offered = handleCommand(setup.state, {
    type: "DECLARE_BUY",
    matchId: setup.state.matchId,
    commandId: "buy-free",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceId: "buy-card",
    targetPlayerId: setup.targetId
  });
  assert.equal(offered.ok, true);
  if (!offered.ok || offered.state.pendingAction?.kind !== "TRADE_CONFIRMATION") {
    return;
  }
  assert.equal(offered.state.pendingAction.price, 0);
  assert.equal(offered.state.pendingAction.canAfford, true);
  const declined = handleCommand(offered.state, {
    type: "CONFIRM_BUY",
    matchId: offered.state.matchId,
    commandId: "decline-free",
    actorId: setup.actorId,
    expectedRevision: offered.state.revision,
    tradeId: offered.state.pendingAction.tradeId,
    accept: false
  });
  assert.equal(declined.ok, true);
  if (!declined.ok) return;
  assert.equal(
    declined.state.players[setup.targetId]?.hand.some(
      ({ instanceId }) => instanceId === "free-miracle"
    ),
    true
  );
});

test("direct-use goods apply their effects, consume the card, and replenish once", () => {
  const healingSetup = withHands(
    createTwoPlayerMatch("goods-heal").state,
    [card("dew", "smile-dew")],
    []
  );
  const healingState: MatchState = {
    ...healingSetup.state,
    players: {
      ...healingSetup.state.players,
      [healingSetup.actorId]: {
        ...healingSetup.state.players[healingSetup.actorId]!,
        hp: 37
      }
    }
  };
  const healed = handleCommand(healingState, {
    type: "DECLARE_ACTION",
    matchId: healingState.matchId,
    commandId: "use-dew",
    actorId: healingSetup.actorId,
    expectedRevision: healingState.revision,
    cardInstanceIds: ["dew"],
    targetPlayerId: healingSetup.actorId
  });
  assert.equal(healed.ok, true);
  if (!healed.ok) return;
  assert.equal(healed.state.players[healingSetup.actorId]?.hp, 42);
  assert.equal(healed.state.players[healingSetup.actorId]?.hand.length, 1);

  const herbSetup = withHands(
    createTwoPlayerMatch("goods-herb").state,
    [card("herb", "heaven-herb")],
    []
  );
  const herbState: MatchState = {
    ...herbSetup.state,
    players: {
      ...herbSetup.state.players,
      [herbSetup.actorId]: {
        ...herbSetup.state.players[herbSetup.actorId]!,
        mp: 90
      }
    }
  };
  const herb = handleCommand(herbState, {
    type: "DECLARE_ACTION",
    matchId: herbState.matchId,
    commandId: "use-herb",
    actorId: herbSetup.actorId,
    expectedRevision: herbState.revision,
    cardInstanceIds: ["herb"],
    targetPlayerId: herbSetup.actorId
  });
  assert.equal(herb.ok, true);
  if (!herb.ok) return;
  assert.equal(herb.state.players[herbSetup.actorId]?.mp, 99);
  assert.equal(
    herb.state.players[herbSetup.actorId]?.calamities.HEAVEN_SICKNESS,
    true
  );
});

test("forced artifact and learned-miracle removal is deterministic and private", () => {
  const broomSetup = withHands(
    createTwoPlayerMatch("broom").state,
    [card("broom", "nocturnal-broom")],
    [
      card("target-1", "bronze-club"),
      card("target-2", "leather-cap"),
      card("target-3", "spring"),
      card("target-4", "torch")
    ]
  );
  const broomState: MatchState = {
    ...broomSetup.state,
    rng: createRng("broom-removal"),
    randomLog: []
  };
  const swept = handleCommand(broomState, {
    type: "DECLARE_ACTION",
    matchId: broomState.matchId,
    commandId: "sweep-three",
    actorId: broomSetup.actorId,
    expectedRevision: broomState.revision,
    cardInstanceIds: ["broom"],
    targetPlayerId: broomSetup.targetId
  });
  assert.equal(swept.ok, true);
  if (!swept.ok) return;
  const sweptAfterDefense = forgivePendingReaction(
    swept.state,
    "accept-sweep"
  );
  assert.equal(sweptAfterDefense.ok, true);
  if (!sweptAfterDefense.ok) return;
  assert.equal(
    sweptAfterDefense.state.players[broomSetup.targetId]?.hand.length,
    1
  );
  const removals = sweptAfterDefense.events.filter(
    ({ type }) => type === "ARTIFACT_REMOVED"
  );
  assert.equal(removals.length, 3);
  assert.equal(
    removals.every(
      ({ visibility }) =>
        visibility.scope === "PLAYER" &&
        visibility.playerId === broomSetup.targetId
    ),
    true
  );
  assert.equal(
    sweptAfterDefense.state.randomLog.filter(
      ({ context }) => context === "CARD_REMOVAL"
    ).length,
    3
  );

  const soapSetup = withHands(
    createTwoPlayerMatch("soap").state,
    [card("soap", "goddess-s-soap")],
    []
  );
  const soapState: MatchState = {
    ...soapSetup.state,
    rng: createRng("soap-removal"),
    randomLog: [],
    players: {
      ...soapSetup.state.players,
      [soapSetup.targetId]: {
        ...soapSetup.state.players[soapSetup.targetId]!,
        learnedMiracles: [
          {
            learnedMiracleId: "learned-a",
            cardDefinitionId: "ice"
          },
          {
            learnedMiracleId: "learned-b",
            cardDefinitionId: "spring"
          },
          {
            learnedMiracleId: "learned-c",
            cardDefinitionId: "tone"
          }
        ]
      }
    }
  };
  const washed = handleCommand(soapState, {
    type: "DECLARE_ACTION",
    matchId: soapState.matchId,
    commandId: "wash-two",
    actorId: soapSetup.actorId,
    expectedRevision: soapState.revision,
    cardInstanceIds: ["soap"],
    targetPlayerId: soapSetup.targetId
  });
  assert.equal(washed.ok, true);
  if (!washed.ok) return;
  const washedAfterDefense = forgivePendingReaction(
    washed.state,
    "accept-wash"
  );
  assert.equal(washedAfterDefense.ok, true);
  if (!washedAfterDefense.ok) return;
  assert.equal(
    washedAfterDefense.state.players[soapSetup.targetId]?.learnedMiracles.length,
    1
  );
  assert.equal(
    washedAfterDefense.events.filter(
      ({ type }) => type === "LEARNED_MIRACLE_REMOVED"
    ).length,
    2
  );
});

test("dreaming hat applies dream and redraws the remaining hand during defense", () => {
  const setup = withHands(
    createTwoPlayerMatch("redraw-hand").state,
    [card("weapon", "bronze-club")],
    [
      card("dreaming-hat", "dreaming-hat"),
      card("old-card", "torch")
    ]
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "redraw-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "redraw-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["dreaming-hat"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  assert.equal(
    reaction.state.players[setup.targetId]?.calamities.DREAM,
    true
  );
  assert.equal(
    reaction.state.players[setup.targetId]?.hand.some(
      ({ instanceId }) => instanceId === "old-card"
    ),
    false
  );
  assert.equal(
    reaction.events.some(
      (event) =>
        event.type === "ARTIFACT_REMOVED" &&
        event.reason === "HAND_REDRAW"
    ),
    true
  );
});

test("dangerous pestle deals 99 power to a holder of dangerous mortar", () => {
  const setup = withHands(
    createTwoPlayerMatch("dangerous-pair").state,
    [card("pestle", "dangerous-pestle")],
    [card("mortar", "dangerous-mortar")],
    99
  );
  const action = handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId: "dangerous-attack",
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["pestle"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "dangerous-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  const damage = reaction.events.find(
    ({ type }) => type === "DAMAGE_APPLIED"
  );
  assert.ok(damage && damage.type === "DAMAGE_APPLIED");
  if (damage?.type === "DAMAGE_APPLIED") {
    assert.equal(damage.amount, 99);
  }
  assert.equal(
    reaction.state.players[setup.targetId]?.alive,
    false
  );
});

test("ascension bow fires a deterministic 75 percent counter before ascension", () => {
  const setup = withHands(
    createTwoPlayerMatch("ascension-counter").state,
    [card("weapon", "bronze-club")],
    [card("ascension-bow", "ascension-bow")],
    1
  );
  const state: MatchState = {
    ...setup.state,
    rng: createRng("bow-miss"),
    randomLog: []
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "ascension-attack",
    actorId: setup.actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["weapon"],
    targetPlayerId: setup.targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "ascension-defense",
    actorId: setup.targetId,
    expectedRevision: action.state.revision,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  const triggered = reaction.events.find(
    ({ type }) => type === "ASCENSION_BOW_TRIGGERED"
  );
  assert.ok(triggered && triggered.type === "ASCENSION_BOW_TRIGGERED");
  if (triggered?.type === "ASCENSION_BOW_TRIGGERED") {
    assert.equal(triggered.hit, true);
  }
  assert.equal(
    reaction.state.players[setup.actorId]?.hp,
    10
  );
  assert.equal(
    reaction.state.players[setup.targetId]?.alive,
    false
  );
});

function phenomenonMatch(
  seed: string,
  playerCount = 2
): {
  state: MatchState;
  actorId: string;
  targetId: string;
} {
  const created =
    playerCount === 4
      ? createFourPlayerMatch(`phenomenon-${seed}`).state
      : createTwoPlayerMatch(`phenomenon-${seed}`).state;
  const actorId = created.activePlayerId;
  assert.ok(actorId);
  const targetId = Object.keys(created.players).find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  return {
    actorId,
    targetId,
    state: {
      ...created,
      rng: createRng(seed),
      randomLog: [],
      players: Object.fromEntries(
        Object.entries(created.players).map(
          ([playerId, player]) => [
            playerId,
            {
              ...player,
              hand:
                playerId === actorId
                  ? [card("fate", "string-of-fate")]
                  : []
            }
          ]
        )
      )
    }
  };
}

function invokePhenomenon(
  setup: ReturnType<typeof phenomenonMatch>,
  commandId: string
) {
  return handleCommand(setup.state, {
    type: "DECLARE_ACTION",
    matchId: setup.state.matchId,
    commandId,
    actorId: setup.actorId,
    expectedRevision: setup.state.revision,
    cardInstanceIds: ["fate"],
    targetPlayerId: setup.actorId
  });
}

test("all-player calamity, HP, healing, money, shuffle, and guardian phenomena resolve", () => {
  const fever = invokePhenomenon(
    phenomenonMatch("phen-5"),
    "phenomenon-fever"
  );
  assert.equal(fever.ok, true);
  if (!fever.ok) return;
  assert.equal(
    Object.values(fever.state.players).every(
      ({ calamities }) => calamities.FEVER
    ),
    true
  );

  const fog = invokePhenomenon(
    phenomenonMatch("phen-12"),
    "phenomenon-fog"
  );
  assert.equal(fog.ok, true);
  if (!fog.ok) return;
  assert.equal(
    Object.values(fog.state.players).every(
      ({ calamities }) => calamities.FOG
    ),
    true
  );

  const tornado = invokePhenomenon(
    phenomenonMatch("phen-11"),
    "phenomenon-tornado"
  );
  assert.equal(tornado.ok, true);
  if (!tornado.ok) return;
  assert.equal(
    Object.values(tornado.state.players).every(({ hp }) => hp === 1),
    true
  );

  const warmCurrent = phenomenonMatch("phen-0");
  const warmState: MatchState = {
    ...warmCurrent.state,
    players: Object.fromEntries(
      Object.entries(warmCurrent.state.players).map(
        ([playerId, player]) => [
          playerId,
          { ...player, hp: 30 }
        ]
      )
    )
  };
  const warm = invokePhenomenon(
    { ...warmCurrent, state: warmState },
    "phenomenon-warm-current"
  );
  assert.equal(warm.ok, true);
  if (!warm.ok) return;
  assert.equal(
    Object.values(warm.state.players).every(({ hp }) => hp === 80),
    true
  );

  const goldSetup = phenomenonMatch("phen-14", 4);
  const goldState: MatchState = {
    ...goldSetup.state,
    players: Object.fromEntries(
      Object.entries(goldSetup.state.players).map(
        ([playerId, player], index) => [
          playerId,
          { ...player, money: index + 1 }
        ]
      )
    )
  };
  const gold = invokePhenomenon(
    { ...goldSetup, state: goldState },
    "phenomenon-gold"
  );
  assert.equal(gold.ok, true);
  if (!gold.ok) return;
  assert.deepEqual(
    Object.values(gold.state.players)
      .map(({ money }) => money)
      .sort((left, right) => left - right),
    [0, 0, 0, 10]
  );

  const magneticSetup = phenomenonMatch("phen-2", 4);
  const magneticState: MatchState = {
    ...magneticSetup.state,
    players: Object.fromEntries(
      Object.entries(magneticSetup.state.players).map(
        ([playerId, player], index) => [
          playerId,
          {
            ...player,
            hand: [
              ...(playerId === magneticSetup.actorId
                ? [card("fate", "string-of-fate")]
                : []),
              card(`magnetic-${index}`, "leather-cap")
            ]
          }
        ]
      )
    )
  };
  const magnetic = invokePhenomenon(
    { ...magneticSetup, state: magneticState },
    "phenomenon-magnetic"
  );
  assert.equal(magnetic.ok, true);
  if (!magnetic.ok) return;
  const shuffled = magnetic.events.find(
    ({ type }) => type === "ARTIFACT_HANDS_SHUFFLED"
  );
  assert.ok(shuffled && shuffled.type === "ARTIFACT_HANDS_SHUFFLED");
  if (shuffled?.type === "ARTIFACT_HANDS_SHUFFLED") {
    assert.equal(shuffled.visibility.scope, "SERVER");
    assert.equal(
      Object.values(shuffled.hands).flat().length,
      4
    );
  }

  const eclipse = invokePhenomenon(
    phenomenonMatch("phen-22", 4),
    "phenomenon-eclipse"
  );
  assert.equal(eclipse.ok, true);
  if (!eclipse.ok) return;
  const guardians = Object.values(eclipse.state.players).map(
    ({ guardian }) => guardian?.guardianName
  );
  assert.equal(guardians.every(Boolean), true);
  assert.equal(new Set(guardians).size, 4);
});

test("random attack phenomena open a phenomenon reaction against a logged target", () => {
  for (const [seed, expectedDefinition] of [
    ["phen-44", "phenomenon-005-巨大なタライ"],
    ["phen-4", "phenomenon-006-ブラックホール"]
  ] as const) {
    const setup = phenomenonMatch(seed, 4);
    const result = invokePhenomenon(
      setup,
      `attack-${expectedDefinition}`
    );
    assert.equal(result.ok, true);
    if (!result.ok || result.state.pendingAction?.kind !== "ATTACK") {
      continue;
    }
    assert.equal(
      result.state.pendingAction.attack.attackKind,
      "PHENOMENON"
    );
    assert.deepEqual(
      result.state.pendingAction.attack.sourceCardDefinitionIds,
      [expectedDefinition]
    );
    assert.equal(
      result.state.randomLog.some(
        ({ context }) => context === "TARGET_SELECTION"
      ),
      true
    );
  }
});

test("mushroom phenomenon schedules three seat-order rounds and increments GF per automatic action", () => {
  const setup = phenomenonMatch("phen-6", 4);
  const first = invokePhenomenon(setup, "mushroom-actions");
  const second = invokePhenomenon(setup, "mushroom-actions");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.state.randomLog, second.state.randomLog);
  const started = first.events.find(
    ({ type }) => type === "CONFUSION_ACTIONS_STARTED"
  );
  assert.ok(started && started.type === "CONFUSION_ACTIONS_STARTED");
  if (started?.type === "CONFUSION_ACTIONS_STARTED") {
    assert.equal(started.actionSlots.length, 12);
    assert.deepEqual(
      started.actionSlots.slice(0, 4).map(({ round }) => round),
      [1, 1, 1, 1]
    );
  }
  const selectedCount = first.events.filter(
    ({ type }) => type === "CONFUSION_ACTION_SELECTED"
  ).length;
  assert.ok(selectedCount > 0);
  assert.equal(
    first.state.gfCount,
    setup.state.gfCount + selectedCount
  );
  assert.equal(
    first.state.randomLog.some(
      ({ context }) => context === "PHENOMENON_ACTION"
    ),
    true
  );
});
