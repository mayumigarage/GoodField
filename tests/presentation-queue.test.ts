import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFICIAL_WEB_2026_07_26,
  advancePresentationClock,
  applyRealtimePresentationMessage,
  createPresentationQueue,
  enqueuePresentationEvents,
  isPresentationSettled,
  presentationRemainingMs,
  presentationStepsForEvent,
  replacePresentationFromSnapshot,
  skipCurrentPresentation
} from "../packages/client/src/presentation-queue.ts";
import { createMatch } from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";
import type { DomainEvent } from "../packages/shared/src/model.ts";

type EventInput = DomainEvent extends infer Event
  ? Event extends DomainEvent
    ? Omit<Event, "revision" | "occurredAt" | "visibility">
    : never
  : never;

function event(value: EventInput): DomainEvent {
  return {
    ...value,
    revision: value.eventSeq,
    occurredAt: "2026-07-26T00:00:00.000Z",
    visibility: { scope: "PUBLIC" }
  } as DomainEvent;
}

function snapshot(revision = 1) {
  const state = createMatch({
    matchId: "presentation",
    seed: "presentation-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const projected = projectGameView(state, "a");
  return { ...projected, revision };
}

test("current presentation profile matches the recorded 500/1000ms combat timing", () => {
  assert.deepEqual(OFFICIAL_WEB_2026_07_26, {
    profileId: "OFFICIAL_WEB_2026_07_26",
    introHoldMs: 6_000,
    stageGapMs: 500,
    attackStageMs: 500,
    attackResultMs: 1_000,
    resolutionHoldMs: 500,
    healingHoldMs: 1_000,
    exchangeHoldMs: 1_000,
    exitHoldMs: 500,
    localSelectionDelayMs: 0
  });
});

test("healing and exchange presentations hold for 1,000ms", () => {
  const healing = presentationStepsForEvent(
    event({
      type: "RESOURCE_CHANGED",
      eventSeq: 1,
      playerId: "a",
      resource: "HP",
      delta: 5,
      valueAfter: 35,
      reason: "MIRACLE"
    })
  );
  const mpRecovery = presentationStepsForEvent(
    event({
      type: "RESOURCE_CHANGED",
      eventSeq: 2,
      playerId: "a",
      resource: "MP",
      delta: 10,
      valueAfter: 20,
      reason: "CARD_EFFECT"
    })
  );
  const exchange = presentationStepsForEvent(
    event({
      type: "RESOURCES_EXCHANGED",
      eventSeq: 3,
      playerId: "a",
      hpAfter: 30,
      mpAfter: 20,
      moneyAfter: 20
    })
  );
  const hpLoss = presentationStepsForEvent(
    event({
      type: "RESOURCE_CHANGED",
      eventSeq: 4,
      playerId: "a",
      resource: "HP",
      delta: -2,
      valueAfter: 28,
      reason: "CALAMITY"
    })
  );

  assert.deepEqual(
    healing.map(({ kind, durationMs }) => [kind, durationMs]),
    [["HP_UPDATE", 1_000]]
  );
  assert.deepEqual(
    mpRecovery.map(({ kind, durationMs }) => [kind, durationMs]),
    [["HP_UPDATE", 1_000]]
  );
  assert.deepEqual(
    exchange.map(({ kind, durationMs }) => [kind, durationMs]),
    [["HP_UPDATE", 1_000]]
  );
  assert.deepEqual(
    hpLoss.map(({ kind, durationMs }) => [kind, durationMs]),
    [["CALAMITY", 500]]
  );
});

test("intro advances at 6,000ms but not at 5,999ms", () => {
  const initial = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({
        type: "MATCH_STARTED",
        eventSeq: 1,
        turnOrder: ["a", "b"]
      }),
      event({ type: "GF_COUNT_CHANGED", eventSeq: 2, gfCount: 1 })
    ],
    snapshot(),
    10
  );
  assert.equal(initial.activeStep?.step.kind, "INTRO");
  assert.equal(presentationRemainingMs(initial, 6_009), 1);
  const before = advancePresentationClock(initial, 6_009);
  assert.equal(before.activeStep?.step.kind, "INTRO");
  const boundary = advancePresentationClock(before, 6_010);
  assert.equal(boundary.activeStep?.step.kind, "GF_UPDATE");
  assert.equal(boundary.activeStep?.startedAtMs, 6_010);
});

test("damage result holds for 1,000ms and then clears", () => {
  const damage = event({
    type: "DAMAGE_APPLIED",
    eventSeq: 4,
    attackId: "attack-1",
    playerId: "b",
    amount: 5,
    hpAfter: 35
  });
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    [damage],
    snapshot(4),
    0
  );
  assert.equal(queued.activeStep?.step.kind, "DAMAGE_RESULT");
  assert.equal(
    advancePresentationClock(queued, 999).activeStep?.step.kind,
    "DAMAGE_RESULT"
  );
  assert.equal(
    isPresentationSettled(advancePresentationClock(queued, 1_000)),
    true
  );
});

test("percentage attacks show their hit or miss result for 1,000ms", () => {
  for (const hit of [true, false]) {
    const result = presentationStepsForEvent(
      event({
        type: "HIT_ROLLED",
        eventSeq: hit ? 5 : 6,
        attackId: `percentage-${hit ? "hit" : "miss"}`,
        hit,
        hitRate: 50
      })
    );
    assert.deepEqual(
      result.map(({ kind, durationMs }) => [kind, durationMs]),
      [["HIT_RESULT", 1_000]]
    );
  }

  assert.deepEqual(
    presentationStepsForEvent(
      event({
        type: "HIT_ROLLED",
        eventSeq: 7,
        attackId: "guaranteed-hit",
        hit: true,
        hitRate: 100
      })
    ),
    []
  );
});

test("events are sorted, deduplicated, and the newest snapshot syncs immediately", () => {
  const firstSnapshot = snapshot(3);
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({
        type: "ACTION_DECLARED",
        eventSeq: 3,
        playerId: "a",
        actionType: "DECLARE_ACTION",
        targetPlayerId: "b"
      }),
      event({ type: "GF_COUNT_CHANGED", eventSeq: 2, gfCount: 2 })
    ],
    firstSnapshot,
    0
  );
  assert.equal(queued.activeStep?.step.eventSeq, 2);
  assert.equal(queued.activeStep?.step.kind, "GF_UPDATE");

  const latestSnapshot = snapshot(8);
  const updated = enqueuePresentationEvents(
    queued,
    [
      event({
        type: "ACTION_DECLARED",
        eventSeq: 3,
        playerId: "a",
        actionType: "DECLARE_ACTION",
        targetPlayerId: "b"
      }),
      event({
        type: "ATTACK_CREATED",
        eventSeq: 8,
        attack: {
          attackId: "attack-1",
          reactionId: "reaction-1",
          reactionDepth: 0,
          seriesId: "series-1",
          attackNumber: 1,
          totalAttacks: 1,
          targetIndex: 0,
          totalTargets: 1,
          attackKind: "WEAPON",
          actorId: "a",
          targetPlayerId: "b",
          sourceCardInstanceIds: ["card-1"],
          sourceLearnedMiracleIds: [],
          sourceCardDefinitionIds: ["bronze-club"],
          element: "PHYSICAL",
          power: 5,
          hit: null
        },
        actionOwnerId: "a",
        targetPlayerIds: ["b"],
        hitRate: 100,
        attackerGrantCount: 1,
        completion: "FINISH_TURN"
      })
    ],
    latestSnapshot,
    100
  );
  assert.equal(updated.latestSnapshot?.revision, 8);
  assert.deepEqual(
    [
      updated.activeStep?.step.eventSeq,
      ...updated.pendingSteps.map(({ eventSeq }) => eventSeq)
    ],
    [2, 3, 8]
  );
});

test("skip completes only the current stage and keeps following events", () => {
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({ type: "GF_COUNT_CHANGED", eventSeq: 1, gfCount: 1 }),
      event({
        type: "ACTION_DECLARED",
        eventSeq: 2,
        playerId: "a",
        actionType: "PRAY",
        targetPlayerId: null
      })
    ],
    snapshot(2),
    0
  );
  const skipped = skipCurrentPresentation(queued, 100);
  assert.equal(skipped.activeStep?.step.eventSeq, 2);
  assert.equal(skipped.activeStep?.step.kind, "ACTION");
  assert.equal(skipped.lastCompletedEventSeq, 1);
  assert.equal(skipped.pendingSteps.length, 0);
});

test("match result remains behind ascension and surrender uses the exit hold", () => {
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({
        type: "PLAYER_ASCENDED",
        eventSeq: 10,
        playerId: "a",
        reason: "SURRENDER"
      }),
      event({
        type: "MATCH_ENDED",
        eventSeq: 11,
        result: {
          kind: "WIN",
          winnerPlayerIds: ["b"],
          winnerTeamId: null
        }
      })
    ],
    snapshot(11),
    0
  );
  assert.equal(queued.activeStep?.step.kind, "ASCENSION");
  assert.equal(queued.activeStep?.step.durationMs, 500);
  assert.equal(
    advancePresentationClock(queued, 499).activeStep?.step.kind,
    "ASCENSION"
  );
  const result = advancePresentationClock(queued, 500);
  assert.equal(result.activeStep?.step.kind, "RESULT");
  assert.equal(result.activeStep?.step.durationMs, 500);
});

test("large clock jumps never discard intermediate visible stages", () => {
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({ type: "GF_COUNT_CHANGED", eventSeq: 1, gfCount: 1 }),
      event({
        type: "ACTION_DECLARED",
        eventSeq: 2,
        playerId: "a",
        actionType: "PRAY",
        targetPlayerId: null
      }),
      event({
        type: "CARD_GRANTED",
        eventSeq: 3,
        obligationId: "grant-1",
        playerId: "a",
        card: {
          instanceId: "card-1",
          cardDefinitionId: "bronze-club",
          dreamDisguiseCardDefinitionId: null
        }
      })
    ],
    snapshot(3),
    0
  );
  const afterPause = advancePresentationClock(queued, 60_000);
  assert.equal(afterPause.activeStep?.step.eventSeq, 2);
  assert.equal(afterPause.pendingSteps.length, 0);
});

test("full snapshot replacement drops stale backlog and keeps only recent events", () => {
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({ type: "GF_COUNT_CHANGED", eventSeq: 1, gfCount: 1 }),
      event({
        type: "ACTION_DECLARED",
        eventSeq: 2,
        playerId: "a",
        actionType: "PRAY",
        targetPlayerId: null
      })
    ],
    snapshot(2),
    0
  );
  const replaced = replacePresentationFromSnapshot(
    queued,
    [
      event({
        type: "PLAYER_ASCENDED",
        eventSeq: 20,
        playerId: "b",
        reason: "HP_ZERO"
      })
    ],
    snapshot(20),
    100
  );
  assert.equal(replaced.activeStep?.step.eventSeq, 20);
  assert.equal(replaced.activeStep?.step.kind, "ASCENSION");
  assert.equal(replaced.latestSnapshot?.revision, 20);
});

test("realtime batches append while full snapshots replace presentation state", () => {
  const firstSnapshot = snapshot(1);
  const batched = applyRealtimePresentationMessage(
    createPresentationQueue(),
    {
      type: "EVENT_BATCH",
      matchId: firstSnapshot.matchId,
      afterEventSeq: 0,
      eventSeq: 1,
      events: [
        event({ type: "GF_COUNT_CHANGED", eventSeq: 1, gfCount: 1 })
      ],
      snapshot: firstSnapshot
    },
    0
  );
  assert.equal(batched.activeStep?.step.eventSeq, 1);

  const currentSnapshot = snapshot(30);
  const replaced = applyRealtimePresentationMessage(
    batched,
    {
      type: "FULL_SNAPSHOT",
      matchId: currentSnapshot.matchId,
      eventSeq: 30,
      reason: "EVENT_HISTORY_UNAVAILABLE",
      recentEvents: [
        event({
          type: "PLAYER_ASCENDED",
          eventSeq: 30,
          playerId: "b",
          reason: "HP_ZERO"
        })
      ],
      snapshot: currentSnapshot
    },
    100
  );
  assert.equal(replaced.activeStep?.step.eventSeq, 30);
  assert.equal(replaced.pendingSteps.length, 0);
});

test("event-to-stage mapping keeps attack presentation order", () => {
  const action = presentationStepsForEvent(
    event({
      type: "ACTION_DECLARED",
      eventSeq: 1,
      playerId: "a",
      actionType: "DECLARE_ACTION",
      targetPlayerId: "b"
    })
  );
  const target = presentationStepsForEvent(
    event({
      type: "ATTACK_REDIRECTED",
      eventSeq: 2,
      attackId: "attack-1",
      reactionId: "reaction-1",
      actorId: "b",
      targetPlayerId: "a",
      reactionDepth: 1,
      redirectType: "REFLECT"
    })
  );
  const reaction = presentationStepsForEvent(
    event({
      type: "REACTION_DECLARED",
      eventSeq: 3,
      reactionId: "reaction-1",
      playerId: "b",
      defenseCardInstanceIds: [],
      defenseLearnedMiracleIds: []
    })
  );
  assert.deepEqual(
    [...action, ...target, ...reaction].map(({ kind }) => kind),
    ["ACTION", "TARGET", "REACTION"]
  );
  assert.deepEqual(
    [...action, ...target, ...reaction].map(({ durationMs }) => durationMs),
    [500, 500, 500]
  );
});

test("all committed defense cards and forgive use one 500ms stage", () => {
  const defended = presentationStepsForEvent(
    event({
      type: "REACTION_DECLARED",
      eventSeq: 1,
      reactionId: "reaction-defended",
      playerId: "b",
      defenseCardInstanceIds: ["armor-1", "armor-2"],
      defenseLearnedMiracleIds: [],
      defenseCardDefinitionIds: ["leather-clothes", "leather-cap"]
    })
  );
  const forgiven = presentationStepsForEvent(
    event({
      type: "REACTION_DECLARED",
      eventSeq: 2,
      reactionId: "reaction-forgiven",
      playerId: "b",
      defenseCardInstanceIds: [],
      defenseLearnedMiracleIds: []
    })
  );

  assert.deepEqual(
    defended.map(({ kind, durationMs, stageIndex }) => [
      kind,
      durationMs,
      stageIndex
    ]),
    [["REACTION", 500, 0]]
  );
  assert.deepEqual(
    forgiven.map(({ kind, durationMs }) => [kind, durationMs]),
    [["REACTION", 500]]
  );
});

test("demon display and central effect each hold for 500ms before ascension", () => {
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({
        type: "DEMON_APPEARED",
        eventSeq: 1,
        obligationId: "grant-1",
        playerId: "a",
        demonCardDefinitionId: "small-demon"
      }),
      event({
        type: "RESOURCE_CHANGED",
        eventSeq: 2,
        playerId: "a",
        resource: "HP",
        delta: -40,
        valueAfter: 0,
        reason: "DEMON"
      }),
      event({
        type: "HP_REACHED_ZERO",
        eventSeq: 3,
        playerId: "a"
      }),
      event({
        type: "PLAYER_ASCENDED",
        eventSeq: 4,
        playerId: "a",
        reason: "HP_ZERO"
      })
    ],
    snapshot(4),
    0
  );

  assert.equal(queued.activeStep?.step.kind, "DEMON");
  assert.equal(
    advancePresentationClock(queued, 499).activeStep?.step.kind,
    "DEMON"
  );
  const effect = advancePresentationClock(queued, 500);
  assert.equal(effect.activeStep?.step.kind, "DEMON_EFFECT");
  assert.equal(
    advancePresentationClock(effect, 999).activeStep?.step.kind,
    "DEMON_EFFECT"
  );
  const ascension = advancePresentationClock(effect, 1_000);
  assert.equal(ascension.activeStep?.step.kind, "ASCENSION");
  assert.equal(ascension.activeStep?.step.eventSeq, 4);
});

test("grant notices are hidden while hand-limit, guardian, and disease keep server order", () => {
  const events = [
    event({
      type: "GRANT_REQUESTED",
      eventSeq: 1,
      obligation: {
        obligationId: "grant-1",
        playerId: "a",
        reason: "PRAY"
      }
    }),
    event({
      type: "CARD_GRANTED",
      eventSeq: 2,
      obligationId: "grant-1",
      playerId: "a",
      card: {
        instanceId: "new-card",
        cardDefinitionId: "bronze-club",
        dreamDisguiseCardDefinitionId: null
      }
    }),
    event({
      type: "HAND_LIMIT_DISCARD",
      eventSeq: 3,
      playerId: "a",
      cardInstanceId: "old-card"
    }),
    event({
      type: "GUARDIAN_CHECKED",
      eventSeq: 4,
      playerId: "b",
      acted: true
    }),
    event({
      type: "GUARDIAN_ACTION_SELECTED",
      eventSeq: 5,
      playerId: "b",
      guardianId: "guardian-1",
      actionCardDefinitionId: "guardian-action-001-火星神-げっぷ",
      targetPlayerId: "a"
    }),
    event({
      type: "CALAMITY_WORSEN_CHECKED",
      eventSeq: 6,
      playerId: "a",
      disease: "COLD",
      worsened: true
    }),
    event({
      type: "CALAMITY_WORSENED",
      eventSeq: 7,
      playerId: "a",
      from: "COLD",
      to: "FEVER"
    }),
    event({
      type: "RESOURCE_CHANGED",
      eventSeq: 8,
      playerId: "a",
      resource: "HP",
      delta: -2,
      valueAfter: 38,
      reason: "CALAMITY"
    })
  ];
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    snapshot(8),
    0
  );

  assert.deepEqual(
    [
      queued.activeStep?.step,
      ...queued.pendingSteps
    ].map((step) => [step?.eventSeq, step?.kind]),
    [
      [3, "GRANT"],
      [4, "GUARDIAN"],
      [5, "GUARDIAN"],
      [6, "CALAMITY"],
      [7, "CALAMITY"],
      [8, "CALAMITY"]
    ]
  );
});
