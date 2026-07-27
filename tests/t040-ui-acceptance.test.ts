import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTLE_SCREEN_STYLES,
  renderBattleScreen
} from "../packages/client/src/battle-screen.ts";
import {
  advancePresentationClock,
  createPresentationQueue,
  enqueuePresentationEvents,
  isPresentationSettled
} from "../packages/client/src/presentation-queue.ts";
import {
  actionPreview,
  advanceUiClock,
  initialUiState,
  prepareBuyConfirmation,
  prepareDeclareActionSubmission,
  prepareReactionSubmission,
  releaseCommandLock,
  selectActionCard,
  selectDefenseCard,
  selectTarget,
  synchronizeUiState
} from "../packages/client/src/ui-machine.ts";
import {
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";
import { processInputDeadline } from "../packages/server/src/session.ts";
import type {
  CardInstance,
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";

const NOW = "2026-07-26T00:00:00.000Z";

type EventInput = DomainEvent extends infer Event
  ? Event extends DomainEvent
    ? Omit<Event, "revision" | "occurredAt" | "visibility">
    : never
  : never;

function event(value: EventInput): DomainEvent {
  return {
    ...value,
    revision: value.eventSeq,
    occurredAt: NOW,
    visibility: { scope: "PUBLIC" }
  } as DomainEvent;
}

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

function createPlayers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `p${index}`,
    displayName: `P${index}`
  }));
}

test("T-040 covers action, target, resolving, defense, trade, spectating, and result transitions", () => {
  const created = createMatch({
    matchId: "t040-transitions",
    seed: "t040-transitions-seed",
    now: NOW,
    players: createPlayers(4)
  });
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const targetIds = created.state.turnOrder.filter(
    (playerId) => playerId !== actorId
  );
  const targetId = targetIds[0];
  const observerId = targetIds[1];
  assert.ok(targetId);
  assert.ok(observerId);
  const state: MatchState = {
    ...created.state,
    players: {
      ...created.state.players,
      [actorId]: {
        ...created.state.players[actorId]!,
        hand: [card("weapon", "bronze-club")]
      },
      [targetId]: {
        ...created.state.players[targetId]!,
        hand: []
      }
    }
  };
  const actorView = projectGameView(state, actorId);
  let actorUi = synchronizeUiState(initialUiState(), actorView);
  assert.equal(actorUi.mode, "COMPOSING_ACTION");
  actorUi = selectActionCard(actorUi, "weapon", actorView);
  assert.equal(actorUi.mode, "CHOOSING_TARGET");
  assert.equal(actorUi.selectedActionCardIds[0], "weapon");
  actorUi = selectTarget(actorUi, targetId, actorView);
  assert.equal(actorUi.selectedTargetIds[0], targetId);
  assert.equal(actorUi.selectedActionCardIds[0], "weapon");

  const prepared = prepareDeclareActionSubmission(
    actorUi,
    actorView,
    () => "t040-action"
  );
  assert.ok(prepared);
  assert.equal(prepared.ui.interactionLocked, true);
  const recovered = releaseCommandLock(prepared.ui, actorView);
  assert.equal(recovered.interactionLocked, false);
  assert.equal(recovered.selectedActionCardIds[0], "weapon");
  assert.equal(recovered.selectedTargetIds[0], targetId);

  const action = handleCommand(state, prepared.command);
  assert.equal(action.ok, true);
  if (!action.ok) return;
  const resolvingActor = synchronizeUiState(
    prepared.ui,
    projectGameView(action.state, actorId)
  );
  const resolvingObserver = synchronizeUiState(
    initialUiState(),
    projectGameView(action.state, observerId)
  );
  const defenderView = projectGameView(action.state, targetId);
  const defenderUi = synchronizeUiState(initialUiState(), defenderView);
  assert.equal(resolvingActor.mode, "RESOLVING");
  assert.equal(resolvingObserver.mode, "RESOLVING");
  assert.equal(defenderUi.mode, "COMPOSING_REACTION");
  const forgive = prepareReactionSubmission(
    defenderUi,
    defenderView,
    () => "t040-forgive",
    true
  );
  assert.ok(forgive);
  const defended = handleCommand(action.state, forgive.command);
  assert.equal(defended.ok, true);

  const tradeCreated = createMatch({
    matchId: "t040-trade",
    seed: "t040-trade-seed",
    now: NOW,
    players: createPlayers(2)
  });
  const buyerId = tradeCreated.state.activePlayerId;
  assert.ok(buyerId);
  const sellerId = tradeCreated.state.turnOrder.find(
    (playerId) => playerId !== buyerId
  );
  assert.ok(sellerId);
  const tradeState: MatchState = {
    ...tradeCreated.state,
    players: {
      ...tradeCreated.state.players,
      [buyerId]: {
        ...tradeCreated.state.players[buyerId]!,
        hand: [card("buy", "buy")]
      },
      [sellerId]: {
        ...tradeCreated.state.players[sellerId]!,
        hand: [card("product", "strength-powder")]
      }
    }
  };
  const offer = handleCommand(tradeState, {
    type: "DECLARE_BUY",
    matchId: tradeState.matchId,
    commandId: "t040-buy",
    actorId: buyerId,
    expectedRevision: tradeState.revision,
    occurredAt: NOW,
    cardInstanceId: "buy",
    targetPlayerId: sellerId
  });
  assert.equal(offer.ok, true);
  if (!offer.ok || offer.state.pendingAction?.kind !== "ATTACK") return;
  const sellerReactionView = projectGameView(offer.state, sellerId);
  const sellerReactionUi = synchronizeUiState(
    initialUiState(),
    sellerReactionView
  );
  assert.equal(sellerReactionUi.mode, "COMPOSING_REACTION");
  const allowed = prepareReactionSubmission(
    sellerReactionUi,
    sellerReactionView,
    () => "t040-buy-allow",
    true
  );
  assert.ok(allowed);
  const afterDefense = handleCommand(offer.state, allowed.command);
  assert.equal(afterDefense.ok, true);
  if (!afterDefense.ok) return;
  const buyerView = projectGameView(afterDefense.state, buyerId);
  const buyerUi = synchronizeUiState(initialUiState(), buyerView);
  const sellerUi = synchronizeUiState(
    initialUiState(),
    projectGameView(afterDefense.state, sellerId)
  );
  assert.equal(buyerUi.mode, "CONFIRMING_TRADE");
  assert.equal(sellerUi.mode, "RESOLVING");
  assert.ok(
    prepareBuyConfirmation(
      buyerUi,
      buyerView,
      true,
      () => "t040-confirm"
    )
  );

  const ascendedViewerId = observerId;
  const spectatingState: MatchState = {
    ...action.state,
    players: {
      ...action.state.players,
      [ascendedViewerId]: {
        ...action.state.players[ascendedViewerId]!,
        alive: false,
        hp: 0
      }
    }
  };
  assert.equal(
    synchronizeUiState(
      initialUiState(),
      projectGameView(spectatingState, ascendedViewerId)
    ).mode,
    "SPECTATING"
  );
  const winnerId = targetIds[2]!;
  const resultState: MatchState = {
    ...spectatingState,
    phase: "MATCH_ENDED",
    activePlayerId: null,
    pendingAction: null,
    inputDeadlineAt: null,
    result: {
      kind: "WIN",
      winnerPlayerIds: [winnerId],
      winnerTeamId: null
    }
  };
  assert.equal(
    synchronizeUiState(
      initialUiState(),
      projectGameView(resultState, ascendedViewerId)
    ).mode,
    "MATCH_RESULT"
  );
});

test("T-040 recreates response UI for repeat, all-enemy, and reflected attacks", () => {
  const twoCreated = createMatch({
    matchId: "t040-repeat",
    seed: "t040-repeat-seed",
    now: NOW,
    players: createPlayers(2)
  });
  const actorId = twoCreated.state.activePlayerId;
  assert.ok(actorId);
  const targetId = twoCreated.state.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const repeatState: MatchState = {
    ...twoCreated.state,
    players: {
      ...twoCreated.state.players,
      [actorId]: {
        ...twoCreated.state.players[actorId]!,
        hand: [card("saw", "saw-boom-boom")]
      },
      [targetId]: {
        ...twoCreated.state.players[targetId]!,
        hand: [
          card("armor-1", "leather-cap"),
          card("armor-2", "leather-cap")
        ]
      }
    }
  };
  const repeated = handleCommand(repeatState, {
    type: "DECLARE_ACTION",
    matchId: repeatState.matchId,
    commandId: "repeat-action",
    actorId,
    expectedRevision: repeatState.revision,
    occurredAt: NOW,
    cardInstanceIds: ["saw"],
    targetPlayerId: targetId
  });
  assert.equal(repeated.ok, true);
  if (!repeated.ok || repeated.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const firstReactionId = repeated.state.pendingAction.attack.reactionId;
  const firstView = projectGameView(repeated.state, targetId);
  let reactionUi = synchronizeUiState(initialUiState(), firstView);
  reactionUi = selectDefenseCard(reactionUi, "armor-1", firstView);
  const firstDefense = prepareReactionSubmission(
    reactionUi,
    firstView,
    () => "repeat-defense-1"
  );
  assert.ok(firstDefense);
  const nextHit = handleCommand(repeated.state, firstDefense.command);
  assert.equal(nextHit.ok, true);
  if (!nextHit.ok || nextHit.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const secondView = projectGameView(nextHit.state, targetId);
  const secondUi = synchronizeUiState(firstDefense.ui, secondView);
  assert.notEqual(
    nextHit.state.pendingAction.attack.reactionId,
    firstReactionId
  );
  assert.equal(
    secondUi.activeReactionId,
    nextHit.state.pendingAction.attack.reactionId
  );
  assert.deepEqual(secondUi.selectedDefenseCardIds, []);

  const fourCreated = createMatch({
    matchId: "t040-all",
    seed: "t040-all-seed",
    now: NOW,
    players: createPlayers(4)
  });
  const allActorId = fourCreated.state.activePlayerId;
  assert.ok(allActorId);
  const enemyIds = fourCreated.state.turnOrder.filter(
    (playerId) => playerId !== allActorId
  );
  const allState: MatchState = {
    ...fourCreated.state,
    players: Object.fromEntries(
      Object.entries(fourCreated.state.players).map(([playerId, player]) => [
        playerId,
        {
          ...player,
          hand:
            playerId === allActorId
              ? [
                  card("god-sword", "god-sword"),
                  card("mirage", "mirage")
                ]
              : []
        }
      ])
    )
  };
  const allAttack = handleCommand(allState, {
    type: "DECLARE_ACTION",
    matchId: allState.matchId,
    commandId: "all-action",
    actorId: allActorId,
    expectedRevision: allState.revision,
    occurredAt: NOW,
    cardInstanceIds: ["god-sword", "mirage"],
    targetPlayerId: enemyIds[0]!
  });
  assert.equal(allAttack.ok, true);
  if (!allAttack.ok || allAttack.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const allOrder = allAttack.state.pendingAction.targetPlayerIds;
  const firstAllTarget = allAttack.state.pendingAction.attack.targetPlayerId;
  const allFirstView = projectGameView(allAttack.state, firstAllTarget);
  const allFirstUi = synchronizeUiState(initialUiState(), allFirstView);
  assert.equal(allFirstUi.mode, "COMPOSING_REACTION");
  const allForgive = prepareReactionSubmission(
    allFirstUi,
    allFirstView,
    () => "all-forgive-1",
    true
  );
  assert.ok(allForgive);
  const allNext = handleCommand(allAttack.state, allForgive.command);
  assert.equal(allNext.ok, true);
  if (!allNext.ok || allNext.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  assert.deepEqual(
    allNext.state.pendingAction.targetPlayerIds,
    allOrder
  );
  assert.notEqual(
    allNext.state.pendingAction.attack.targetPlayerId,
    firstAllTarget
  );

  const reflectionState: MatchState = {
    ...twoCreated.state,
    players: {
      ...twoCreated.state.players,
      [actorId]: {
        ...twoCreated.state.players[actorId]!,
        hand: [
          card("reflect-weapon", "bronze-club"),
          card("actor-mirror", "super-mirror")
        ]
      },
      [targetId]: {
        ...twoCreated.state.players[targetId]!,
        hand: [card("target-mirror", "super-mirror")]
      }
    }
  };
  const reflection = handleCommand(reflectionState, {
    type: "DECLARE_ACTION",
    matchId: reflectionState.matchId,
    commandId: "reflection-action",
    actorId,
    expectedRevision: reflectionState.revision,
    occurredAt: NOW,
    cardInstanceIds: ["reflect-weapon"],
    targetPlayerId: targetId
  });
  assert.equal(reflection.ok, true);
  if (!reflection.ok || reflection.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const reflected = handleCommand(reflection.state, {
    type: "DECLARE_REACTION",
    matchId: reflection.state.matchId,
    commandId: "reflection-defense",
    actorId: targetId,
    expectedRevision: reflection.state.revision,
    occurredAt: NOW,
    reactionId: reflection.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["target-mirror"]
  });
  assert.equal(reflected.ok, true);
  if (!reflected.ok || reflected.state.pendingAction?.kind !== "ATTACK") {
    return;
  }
  const reflectedActorUi = synchronizeUiState(
    initialUiState(),
    projectGameView(reflected.state, actorId)
  );
  assert.equal(reflectedActorUi.mode, "COMPOSING_REACTION");
  assert.equal(
    reflectedActorUi.activeReactionId,
    reflected.state.pendingAction.attack.reactionId
  );
  assert.equal(
    reflected.state.pendingAction.attack.targetPlayerId,
    actorId
  );
});

test("T-040 renders 2, 4, and 9 players across the declared responsive breakpoints", () => {
  for (const playerCount of [2, 4, 9]) {
    const state = createMatch({
      matchId: `t040-layout-${playerCount}`,
      seed: `t040-layout-seed-${playerCount}`,
      now: NOW,
      players: createPlayers(playerCount)
    }).state;
    const viewerId = state.activePlayerId;
    assert.ok(viewerId);
    const view = projectGameView(state, viewerId);
    const html = renderBattleScreen(
      view,
      synchronizeUiState(initialUiState(), view)
    );
    assert.match(
      html,
      new RegExp(`data-player-count="${playerCount}"`, "u")
    );
    assert.equal(
      html.match(/class="gf-player-list__item"/gu)?.length,
      playerCount
    );
  }
  assert.match(BATTLE_SCREEN_STYLES, /@media \(max-width: 64rem\)/u);
  assert.match(BATTLE_SCREEN_STYLES, /@media \(max-width: 44rem\)/u);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /@media \(max-width: 44rem\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /@media \(max-width: 44rem\)[\s\S]*?overflow-x: auto/u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__content\s*\{[\s\S]*?left: -1\.5625%;[\s\S]*?grid-template-columns: repeat\(2, 46\.875%\);[\s\S]*?grid-template-rows: 100%;/u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__stack\s*\{[\s\S]*?grid-auto-flow: row;[\s\S]*?grid-auto-rows: 90px;[\s\S]*?gap: 10px;/u
  );
});

test("T-040 virtual clock matches recorded 500/1000ms combat boundaries", () => {
  const snapshotState = createMatch({
    matchId: "t040-clock",
    seed: "t040-clock-seed",
    now: NOW,
    players: createPlayers(2)
  }).state;
  const viewerId = snapshotState.activePlayerId;
  assert.ok(viewerId);
  const snapshot = projectGameView(snapshotState, viewerId);
  const queue = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      event({ type: "GF_COUNT_CHANGED", eventSeq: 1, gfCount: 2 }),
      event({
        type: "ACTION_DECLARED",
        eventSeq: 2,
        playerId: viewerId,
        actionType: "DECLARE_ACTION",
        targetPlayerId: snapshotState.turnOrder.find(
          (playerId) => playerId !== viewerId
        ) ?? null
      }),
      event({
        type: "ATTACK_CREATED",
        eventSeq: 3,
        attack: {
          attackId: "clock-attack",
          reactionId: "clock-reaction",
          reactionDepth: 0,
          seriesId: "clock-series",
          attackNumber: 1,
          totalAttacks: 1,
          targetIndex: 0,
          totalTargets: 1,
          attackKind: "WEAPON",
          actorId: viewerId,
          targetPlayerId: snapshotState.turnOrder.find(
            (playerId) => playerId !== viewerId
          )!,
          sourceCardInstanceIds: ["clock-card"],
          sourceLearnedMiracleIds: [],
          sourceCardDefinitionIds: ["bronze-club"],
          element: "PHYSICAL",
          power: 2,
          hit: true
        },
        actionOwnerId: viewerId,
        targetPlayerIds: [
          snapshotState.turnOrder.find(
            (playerId) => playerId !== viewerId
          )!
        ],
        hitRate: 100,
        attackerGrantCount: 1,
        completion: "FINISH_TURN"
      }),
      event({
        type: "REACTION_DECLARED",
        eventSeq: 4,
        reactionId: "clock-reaction",
        playerId: snapshotState.turnOrder.find(
          (playerId) => playerId !== viewerId
        )!,
        defenseCardInstanceIds: [],
        defenseLearnedMiracleIds: []
      }),
      event({
        type: "DAMAGE_APPLIED",
        eventSeq: 5,
        attackId: "clock-attack",
        playerId: snapshotState.turnOrder.find(
          (playerId) => playerId !== viewerId
        )!,
        amount: 1,
        hpAfter: 39
      })
    ],
    snapshot,
    0
  );
  assert.equal(queue.activeStep?.step.kind, "GF_UPDATE");
  assert.equal(
    advancePresentationClock(queue, 499).activeStep?.step.kind,
    "GF_UPDATE"
  );
  const action = advancePresentationClock(queue, 500);
  assert.equal(action.activeStep?.step.kind, "ACTION");
  assert.equal(
    advancePresentationClock(action, 999).activeStep?.step.kind,
    "ACTION"
  );
  const target = advancePresentationClock(action, 1_000);
  assert.equal(target.activeStep?.step.kind, "TARGET");
  assert.equal(
    advancePresentationClock(target, 1_499).activeStep?.step.kind,
    "TARGET"
  );
  const reaction = advancePresentationClock(target, 1_500);
  assert.equal(reaction.activeStep?.step.kind, "REACTION");
  assert.equal(
    advancePresentationClock(reaction, 1_999).activeStep?.step.kind,
    "REACTION"
  );
  const damage = advancePresentationClock(reaction, 2_000);
  assert.equal(damage.activeStep?.step.kind, "DAMAGE_RESULT");
  assert.equal(
    advancePresentationClock(damage, 2_999).activeStep?.step.kind,
    "DAMAGE_RESULT"
  );
  assert.equal(
    isPresentationSettled(advancePresentationClock(damage, 3_000)),
    true
  );

  const actorView = projectGameView(snapshotState, viewerId);
  const initial = synchronizeUiState(initialUiState(), actorView);
  const actionChoice = actorView.self?.legalActions.find(
    (candidate) =>
      candidate.type === "DECLARE_ACTION" &&
      candidate.cardInstanceIds.length > 0
  );
  if (actionChoice?.type === "DECLARE_ACTION") {
    const selected = selectActionCard(
      initial,
      actionChoice.cardInstanceIds[0]!,
      actorView
    );
    assert.notEqual(selected, initial);
    assert.equal(actionPreview(selected, actorView).invalidReason, null);
  }
});

test("T-040 keeps training input after 30s and closes online input at 15s", () => {
  const training = createMatch({
    matchId: "t040-training-time",
    seed: "t040-training-time-seed",
    now: NOW,
    mode: "TRAINING",
    players: createPlayers(2)
  }).state;
  const trainingActor = training.activePlayerId;
  assert.ok(trainingActor);
  const trainingView = projectGameView(training, trainingActor);
  const trainingUi = synchronizeUiState(initialUiState(), trainingView);
  assert.equal(
    advanceUiClock(trainingUi, trainingView, Date.parse(NOW) + 30_000),
    trainingUi
  );
  assert.equal(
    processInputDeadline(
      training,
      "2026-07-26T00:00:30.000Z"
    ).state,
    training
  );

  const online = createMatch({
    matchId: "t040-online-time",
    seed: "t040-online-time-seed",
    now: NOW,
    mode: "ONLINE",
    players: createPlayers(2)
  }).state;
  const onlineActor = online.activePlayerId;
  assert.ok(onlineActor);
  const onlineView = projectGameView(online, onlineActor);
  const onlineUi = synchronizeUiState(initialUiState(), onlineView);
  assert.equal(
    advanceUiClock(
      onlineUi,
      onlineView,
      Date.parse(NOW) + 14_999
    ).mode,
    "COMPOSING_ACTION"
  );
  const expiredUi = advanceUiClock(
    onlineUi,
    onlineView,
    Date.parse(NOW) + 15_000
  );
  assert.equal(expiredUi.mode, "RESOLVING");
  assert.equal(expiredUi.inputDeadlineExpired, true);
  const timedOut = processInputDeadline(
    online,
    "2026-07-26T00:00:15.000Z"
  );
  assert.equal(timedOut.timedOutPlayerId, onlineActor);
  assert.equal(timedOut.state.players[onlineActor]?.controller, "CPU");
});
