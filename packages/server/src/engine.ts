import type {
  Calamity,
  CardDefinition,
  EffectInstruction,
  Element,
  SpecialEffectOperation
} from "../../shared/src/card-types.ts";
import {
  CARD_DEFINITIONS_BY_ID,
  CARD_POOL_VERSION,
  DEMON_GRANT_POOL,
  NORMAL_GRANT_POOL,
  STANDARD_CARD_DEFINITIONS,
  instructionsOfKind
} from "../../shared/src/cards.ts";
import {
  INITIAL_HAND_SIZE,
  INITIAL_HP,
  INITIAL_MONEY,
  INITIAL_MP,
  MAX_HAND_SIZE,
  MAX_RESOURCE,
  RULESET_VERSION,
  clampResource
} from "../../shared/src/model.ts";
import type {
  AttackCompletion,
  AttackKind,
  CardInstance,
  CommandErrorCode,
  CommandFailure,
  CommandResult,
  Controller,
  CreateMatchInput,
  DomainEvent,
  DomainEventBase,
  EventVisibility,
  GameCommand,
  GrantObligation,
  MatchResult,
  MatchState,
  PlayerState
} from "../../shared/src/model.ts";
import {
  createRng,
  drawWeighted,
  shuffleDeterministically
} from "../../shared/src/rng.ts";
import type { RandomSelection } from "../../shared/src/rng.ts";

type WithoutEventMetadata<T> = T extends DomainEvent
  ? Omit<T, keyof DomainEventBase>
  : never;
type EventPayload = WithoutEventMetadata<DomainEvent>;

type EngineContext = {
  state: MatchState;
  events: DomainEvent[];
  occurredAt: string;
};

const PUBLIC_VISIBILITY: EventVisibility = { scope: "PUBLIC" };
const MAX_REACTION_CHAIN_DEPTH = 512;

export const HANDLED_EFFECT_INSTRUCTION_KINDS: ReadonlySet<
  EffectInstruction["kind"]
> = new Set([
  "ATTACK",
  "DEFENSE",
  "HIT_RATE",
  "BOOST_HP",
  "BOOST_MP",
  "BOOST_MONEY",
  "TAKE_MONEY",
  "COUNTER_BOOST_MP",
  "DEAL_DAMAGE",
  "ADD_CALAMITY",
  "REMOVE_CALAMITIES",
  "SET_ELEMENT",
  "SPECIAL"
]);

export const HANDLED_SPECIAL_EFFECT_OPERATIONS: ReadonlySet<
  SpecialEffectOperation
> = new Set([
  "DISCARD",
  "SACRIFICE",
  "EXCHANGE",
  "SELL",
  "BUY",
  "ADD_ITEM",
  "DOUBLE_ATTACK",
  "ATTACK_TWICE",
  "ATTACK_EVERY_ENEMY",
  "ATTACK_SOMEBODY",
  "ATTRACT_DANGER",
  "ATTACK_DYINGLY",
  "FILTER_ATTACK_ELEMENT",
  "BOUNCE_WEAPON",
  "REFLECT_WEAPON",
  "BLOCK_WEAPON",
  "BOUNCE_MIRACLE",
  "REFLECT_MIRACLE",
  "BLOCK_MIRACLE",
  "REFLECT_ANYTHING",
  "REVIVE",
  "SET_HP_OF_EVERYBODY",
  "ABSORB_HP",
  "DEAL_SAME_DAMAGE",
  "CONSUME_ALL_MP",
  "CUT_COST",
  "BOOST_SOMETHING",
  "SET_GUARDIAN",
  "SET_GUARDIAN_OF_EVERYBODY",
  "CONFUSE_EVERYBODY",
  "REMOVE_ITEMS",
  "REMOVE_USED_MIRACLES",
  "REMOVE_SOMETHING",
  "SHUFFLE_ITEMS_OF_EVERYBODY",
  "CALL_PHENOMENON",
  "COLLECT_MONEY_OF_EVERYBODY",
  "CATEGORY_WEAPON",
  "REDRAW_HAND"
]);

function fail(
  state: MatchState,
  code: CommandErrorCode,
  message: string
): CommandFailure {
  return { ok: false, state, code, message };
}

function assertIsoDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return value;
}

function deadlineFor(
  state: MatchState,
  playerId: string,
  occurredAt: string
): string | null {
  if (
    state.mode === "TRAINING" ||
    state.players[playerId]?.controller !== "HUMAN"
  ) {
    return null;
  }
  return new Date(Date.parse(occurredAt) + 15_000).toISOString();
}

function eventWithMetadata(
  state: MatchState,
  payload: EventPayload,
  occurredAt: string,
  visibility: EventVisibility
): DomainEvent {
  return {
    ...payload,
    eventSeq: state.eventSequence + 1,
    revision: state.revision + 1,
    occurredAt,
    visibility
  } as DomainEvent;
}

function emit(
  context: EngineContext,
  payload: EventPayload,
  visibility: EventVisibility = PUBLIC_VISIBILITY
): DomainEvent {
  const event = eventWithMetadata(
    context.state,
    payload,
    context.occurredAt,
    visibility
  );
  context.state = applyEvent(context.state, event);
  context.events.push(event);
  return event;
}

function replacePlayer(
  state: MatchState,
  playerId: string,
  update: (player: PlayerState) => PlayerState
): MatchState {
  const player = state.players[playerId];
  if (!player) throw new Error(`Unknown player ${playerId}`);
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: update(player)
    }
  };
}

function updatePendingAttack(
  state: MatchState,
  update: (
    pending: Extract<NonNullable<MatchState["pendingAction"]>, { kind: "ATTACK" }>
  ) => Extract<NonNullable<MatchState["pendingAction"]>, { kind: "ATTACK" }>
): MatchState {
  const pending = state.pendingAction;
  if (pending?.kind !== "ATTACK") throw new Error("No pending attack");
  return { ...state, pendingAction: update(pending) };
}

export function applyEvent(state: MatchState, event: DomainEvent): MatchState {
  let next: MatchState = {
    ...state,
    eventSequence: event.eventSeq,
    revision: event.revision
  };
  switch (event.type) {
    case "MATCH_STARTED":
      return {
        ...next,
        phase: "INITIAL_GRANT",
        turnOrder: [...event.turnOrder]
      };
    case "INITIAL_GRANT_COMPLETED":
      return { ...next, phase: "TURN_OPEN" };
    case "GF_COUNT_CHANGED":
      return {
        ...next,
        gfCount: event.gfCount,
        endTimeActive:
          next.endTimeThreshold !== null &&
          event.gfCount >= next.endTimeThreshold
      };
    case "TURN_OPENED":
      return {
        ...next,
        phase: "TURN_OPEN",
        activePlayerId: event.playerId,
        turnCursor: next.turnOrder.indexOf(event.playerId),
        pendingAction: null,
        postTurnAutomatic: null,
        defeatedThisTurn: []
      };
    case "ACTION_REQUESTED":
      return {
        ...next,
        phase: "ACTION_SELECTION",
        inputDeadlineAt: event.inputDeadlineAt
      };
    case "ACTION_DECLARED":
      return { ...next, phase: "ACTION_DECLARED", inputDeadlineAt: null };
    case "CARD_CONSUMED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hand: player.hand.filter(({ instanceId }) => instanceId !== event.cardInstanceId)
      }));
    case "MIRACLE_LEARNED":
      next = replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hand: player.hand.filter(({ instanceId }) => instanceId !== event.cardInstanceId),
        learnedMiracles: [...player.learnedMiracles, { ...event.miracle }]
      }));
      if (next.pendingAction?.kind === "ATTACK") {
        return updatePendingAttack(next, (pending) => ({
          ...pending,
          usedDefenseCardInstanceIds: [
            ...pending.usedDefenseCardInstanceIds,
            event.cardInstanceId
          ],
          defenseGrantCounts: {
            ...pending.defenseGrantCounts,
            [event.playerId]:
              (pending.defenseGrantCounts[event.playerId] ?? 0) + 1
          }
        }));
      }
      return next;
    case "MIRACLE_CAST":
      return next;
    case "MP_SPENT":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        mp: clampResource(event.mpAfter)
      }));
    case "RESOURCE_CHANGED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hp:
          event.resource === "HP"
            ? clampResource(event.valueAfter)
            : player.hp,
        mp:
          event.resource === "MP"
            ? clampResource(event.valueAfter)
            : player.mp,
        money:
          event.resource === "MONEY"
            ? clampResource(event.valueAfter)
            : player.money
      }));
    case "RESOURCES_EXCHANGED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hp: clampResource(event.hpAfter),
        mp: clampResource(event.mpAfter),
        money: clampResource(event.moneyAfter)
      }));
    case "TRADE_OFFERED":
      return {
        ...next,
        phase: "TRADE_CONFIRMATION",
        pendingAction: {
          kind: "TRADE_CONFIRMATION",
          tradeId: event.tradeId,
          actorId: event.actorId,
          targetPlayerId: event.targetPlayerId,
          offeredCardInstanceId: event.offeredCardInstanceId,
          price: event.price,
          canAfford: event.canAfford
        },
        inputDeadlineAt: event.inputDeadlineAt
      };
    case "TRADE_RESOLVED":
      return {
        ...next,
        phase: "ACTION_RESOLUTION",
        pendingAction: null,
        inputDeadlineAt: null
      };
    case "TRADE_PAYMENT_COLLECTED":
      next = replacePlayer(next, event.payerPlayerId, (player) => ({
        ...player,
        hp: clampResource(event.payerHpAfter),
        mp: clampResource(event.payerMpAfter),
        money: clampResource(event.payerMoneyAfter)
      }));
      return replacePlayer(next, event.recipientPlayerId, (player) => ({
        ...player,
        money: clampResource(event.recipientMoneyAfter)
      }));
    case "CARD_TRANSFERRED":
      next = replacePlayer(next, event.fromPlayerId, (player) => ({
        ...player,
        hand: player.hand.filter(
          ({ instanceId }) => instanceId !== event.card.instanceId
        )
      }));
      return replacePlayer(next, event.toPlayerId, (player) => ({
        ...player,
        hand: [...player.hand, { ...event.card }]
      }));
    case "CALAMITY_APPLIED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        calamities: {
          ...player.calamities,
          [event.calamity]: true
        }
      }));
    case "CALAMITIES_REMOVED":
      return replacePlayer(next, event.playerId, (player) => {
        const calamities = { ...player.calamities };
        for (const calamity of event.calamities) delete calamities[calamity];
        return { ...player, calamities };
      });
    case "ARTIFACT_REMOVED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hand: player.hand.filter(
          ({ instanceId }) => instanceId !== event.cardInstanceId
        )
      }));
    case "LEARNED_MIRACLE_REMOVED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        learnedMiracles: player.learnedMiracles.filter(
          ({ learnedMiracleId }) =>
            learnedMiracleId !== event.learnedMiracleId
        )
      }));
    case "ARTIFACT_HANDS_SHUFFLED":
      return {
        ...next,
        players: Object.fromEntries(
          Object.entries(next.players).map(([playerId, player]) => [
            playerId,
            {
              ...player,
              hand: event.hands[playerId]?.map((card) => ({ ...card })) ?? []
            }
          ])
        )
      };
    case "GUARDIAN_ASSIGNED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        guardian: { ...event.guardian }
      }));
    case "GUARDIAN_DEPARTED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        guardian:
          player.guardian?.guardianId === event.guardianId
            ? null
            : player.guardian
      }));
    case "POST_TURN_AUTOMATIC_EFFECTS_STARTED":
      return {
        ...next,
        phase: "POST_TURN_AUTOMATIC_EFFECTS",
        postTurnAutomatic: {
          turnActorId: event.turnActorId,
          guardianPlayerIds: [...event.guardianPlayerIds],
          nextGuardianIndex: 0
        }
      };
    case "GUARDIAN_CHECKED":
      if (!next.postTurnAutomatic) return next;
      return {
        ...next,
        phase: "POST_TURN_AUTOMATIC_EFFECTS",
        postTurnAutomatic: {
          ...next.postTurnAutomatic,
          nextGuardianIndex: next.postTurnAutomatic.nextGuardianIndex + 1
        }
      };
    case "GUARDIAN_ACTION_SELECTED":
    case "CALAMITY_WORSEN_CHECKED":
      return next;
    case "CALAMITY_WORSENED":
      return replacePlayer(next, event.playerId, (player) => {
        if (event.to === null) return player;
        const calamities = { ...player.calamities };
        delete calamities[event.from];
        calamities[event.to] = true;
        return { ...player, calamities };
      });
    case "POST_TURN_AUTOMATIC_EFFECTS_COMPLETED":
      return {
        ...next,
        phase: "RESULT_CHECK",
        pendingAction: null,
        postTurnAutomatic: null,
        inputDeadlineAt: null
      };
    case "ATTACK_CREATED":
      {
        const existing =
          next.pendingAction?.kind === "ATTACK" &&
          next.pendingAction.attack.seriesId === event.attack.seriesId
            ? next.pendingAction
            : null;
      return {
        ...next,
        phase: "ACTION_RESOLUTION",
        pendingAction: {
          kind: "ATTACK",
          attack: { ...event.attack },
          actionOwnerId: event.actionOwnerId,
          targetPlayerIds: [...event.targetPlayerIds],
          hitRate: event.hitRate,
          attackerGrantCount: event.attackerGrantCount,
          usedDefenseCardInstanceIds:
            existing?.usedDefenseCardInstanceIds ?? [],
          defenseGrantCounts: existing?.defenseGrantCounts ?? {},
          revivalGrantCounts: existing?.revivalGrantCounts ?? {},
          completion: event.completion,
          deferredTargetedCardEffect:
            event.deferredTargetedCardEffect ??
            existing?.deferredTargetedCardEffect ??
            null
        }
      };
      }
    case "HIT_ROLLED":
      return updatePendingAttack(next, (pending) => ({
        ...pending,
        attack: { ...pending.attack, hit: event.hit }
      }));
    case "ATTACK_ELEMENT_FILTERED":
      return updatePendingAttack(next, (pending) => ({
        ...pending,
        attack: { ...pending.attack, element: event.element }
      }));
    case "ATTACK_REDIRECTED":
      return updatePendingAttack(next, (pending) => ({
        ...pending,
        attack: {
          ...pending.attack,
          reactionId: event.reactionId,
          reactionDepth: event.reactionDepth,
          actorId: event.actorId,
          targetPlayerId: event.targetPlayerId
        }
      }));
    case "ATTACK_STOPPED":
      return { ...next, phase: "ACTION_RESOLUTION", inputDeadlineAt: null };
    case "REACTION_CHAIN_ABORTED":
      return { ...next, phase: "ACTION_RESOLUTION", inputDeadlineAt: null };
    case "REACTION_REQUESTED":
      return {
        ...next,
        phase: "REACTION_SELECTION",
        inputDeadlineAt: event.inputDeadlineAt
      };
    case "REACTION_DECLARED":
      return {
        ...next,
        phase: "ACTION_RESOLUTION",
        inputDeadlineAt: null
      };
    case "DEFENSE_COMMITTED":
      next = replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hand: player.hand.filter(({ instanceId }) => instanceId !== event.cardInstanceId)
      }));
      return updatePendingAttack(next, (pending) => ({
        ...pending,
        usedDefenseCardInstanceIds: [
          ...pending.usedDefenseCardInstanceIds,
          event.cardInstanceId
        ],
        defenseGrantCounts: {
          ...pending.defenseGrantCounts,
          [event.playerId]:
            (pending.defenseGrantCounts[event.playerId] ?? 0) + 1
        }
      }));
    case "DAMAGE_APPLIED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hp: clampResource(event.hpAfter)
      }));
    case "HP_REACHED_ZERO":
      return next;
    case "REVIVAL_RESOLVED":
      next = replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hp: clampResource(event.hpAfter)
      }));
      if (next.pendingAction?.kind === "ATTACK") {
        return updatePendingAttack(next, (pending) => ({
          ...pending,
          revivalGrantCounts: {
            ...pending.revivalGrantCounts,
            [event.playerId]:
              (pending.revivalGrantCounts[event.playerId] ?? 0) + 1
          }
        }));
      }
      return next;
    case "ASCENSION_BOW_TRIGGERED":
      return next;
    case "PLAYER_ASCENDED":
      next = replacePlayer(next, event.playerId, (player) => ({
        ...player,
        alive: false,
        hp: event.reason === "HP_ZERO" ? 0 : player.hp
      }));
      return {
        ...next,
        defeatedThisTurn: next.defeatedThisTurn.includes(event.playerId)
          ? next.defeatedThisTurn
          : [...next.defeatedThisTurn, event.playerId]
      };
    case "GRANT_REQUESTED":
      return {
        ...next,
        phase: next.phase === "INITIAL_GRANT" ? "INITIAL_GRANT" : "POST_ACTION_GRANT",
        pendingGrant: [...next.pendingGrant, event.obligation]
      };
    case "DEMON_APPEARED":
    case "DEMON_THEFT_RESOLVED":
      return next;
    case "DEMON_OBJECT_REMOVED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hand:
          event.objectType === "CARD"
            ? player.hand.filter(
                ({ instanceId }) => instanceId !== event.objectId
              )
            : player.hand,
        learnedMiracles:
          event.objectType === "LEARNED_MIRACLE"
            ? player.learnedMiracles.filter(
                ({ learnedMiracleId }) =>
                  learnedMiracleId !== event.objectId
              )
            : player.learnedMiracles
      }));
    case "GRANT_CANCELLED":
      return {
        ...next,
        pendingGrant: next.pendingGrant.filter(
          ({ obligationId }) => obligationId !== event.obligationId
        )
      };
    case "CARD_GRANTED":
      next = replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hand: [...player.hand, { ...event.card }]
      }));
      return {
        ...next,
        pendingGrant: next.pendingGrant.filter(
          ({ obligationId }) => obligationId !== event.obligationId
        )
      };
    case "HAND_LIMIT_DISCARD":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        hand: player.hand.filter(({ instanceId }) => instanceId !== event.cardInstanceId)
      }));
    case "PHENOMENON_SELECTED":
    case "CONFUSION_ACTION_SELECTED":
      return next;
    case "CONFUSION_ACTIONS_STARTED":
      return {
        ...next,
        phase: "ACTION_RESOLUTION",
        phenomenonAutomatic: {
          sourcePlayerId: event.sourcePlayerId,
          sourceGrantCount: event.sourceGrantCount,
          actionSlots: event.actionSlots.map((slot) => ({ ...slot })),
          nextActionIndex: 0
        }
      };
    case "CONFUSION_ACTION_COMPLETED":
      if (!next.phenomenonAutomatic) return next;
      return {
        ...next,
        phenomenonAutomatic: {
          ...next.phenomenonAutomatic,
          nextActionIndex: next.phenomenonAutomatic.nextActionIndex + 1
        }
      };
    case "CONFUSION_ACTIONS_COMPLETED":
      return {
        ...next,
        phenomenonAutomatic: null
      };
    case "INPUT_TIMED_OUT":
      next = replacePlayer(next, event.playerId, (player) => ({
        ...player,
        controller: "CPU",
        disconnected: true
      }));
      return {
        ...next,
        inputDeadlineAt: null
      };
    case "PLAYER_CONNECTION_CHANGED":
      return replacePlayer(next, event.playerId, (player) => ({
        ...player,
        disconnected: event.connectionState === "DISCONNECTED"
      }));
    case "TURN_CLOSED":
      return {
        ...next,
        phase: "TURN_CLOSE",
        pendingAction: null,
        inputDeadlineAt: null
      };
    case "MATCH_ENDED":
      return {
        ...next,
        phase: "MATCH_ENDED",
        activePlayerId: null,
        pendingAction: null,
        postTurnAutomatic: null,
        phenomenonAutomatic: null,
        pendingGrant: [],
        inputDeadlineAt: null,
        result: event.result
      };
    default:
      return next;
  }
}

function consumeSelection<T>(
  context: EngineContext,
  selection: RandomSelection<T>
): T {
  context.state = {
    ...context.state,
    rng: selection.state,
    randomLog: [...context.state.randomLog, selection.audit]
  };
  return selection.value;
}

function playerVisibility(playerId: string): EventVisibility {
  return { scope: "PLAYER", playerId };
}

function makeGrantObligation(
  context: EngineContext,
  playerId: string,
  reason: GrantObligation["reason"]
): GrantObligation {
  return {
    obligationId: `${context.state.matchId}:grant:${context.state.eventSequence + 1}`,
    playerId,
    reason
  };
}

function grantStandardArtifact(
  context: EngineContext,
  playerId: string,
  obligation: GrantObligation
): void {
  const player = context.state.players[playerId];
  if (!player) return;
  const oldHandIds = player.hand.map(({ instanceId }) => instanceId);
  const selection = drawWeighted(
    context.state.rng,
    NORMAL_GRANT_POOL,
    "CARD_GRANT",
    context.state.eventSequence + 1
  );
  const definition = consumeSelection(context, selection);
  const card: CardInstance = {
    instanceId: `${context.state.matchId}:card:${context.state.eventSequence + 1}`,
    cardDefinitionId: definition.cardDefinitionId,
    dreamDisguiseCardDefinitionId: null
  };
  emit(
    context,
    {
      type: "CARD_GRANTED",
      obligationId: obligation.obligationId,
      playerId,
      card
    },
    playerVisibility(playerId)
  );

  const currentPlayer = context.state.players[playerId];
  if (currentPlayer && currentPlayer.hand.length > MAX_HAND_SIZE) {
    const discardSelection = drawWeighted(
      context.state.rng,
      oldHandIds.map((instanceId) => ({
        key: instanceId,
        weight: 1,
        value: instanceId
      })),
      "HAND_LIMIT_DISCARD",
      context.state.eventSequence + 1
    );
    const cardInstanceId = consumeSelection(context, discardSelection);
    emit(context, {
      type: "HAND_LIMIT_DISCARD",
      playerId,
      cardInstanceId
    });
  }
}

type DemonRemovableObject = {
  objectType: "CARD" | "LEARNED_MIRACLE";
  objectId: string;
  cardDefinitionId: string;
};

function demonRemovableObjects(player: PlayerState): DemonRemovableObject[] {
  return [
    ...player.hand.map(
      ({ instanceId, cardDefinitionId }): DemonRemovableObject => ({
        objectType: "CARD",
        objectId: instanceId,
        cardDefinitionId
      })
    ),
    ...player.learnedMiracles.map(
      ({ learnedMiracleId, cardDefinitionId }): DemonRemovableObject => ({
        objectType: "LEARNED_MIRACLE",
        objectId: learnedMiracleId,
        cardDefinitionId
      })
    )
  ];
}

function resolveDemonEffect(
  context: EngineContext,
  playerId: string,
  definition: CardDefinition
): void {
  let handled = false;
  for (const instruction of instructionsOfKind(definition, "DEAL_DAMAGE")) {
    handled = true;
    const player = context.state.players[playerId];
    if (!player?.alive) break;
    const amount = Math.min(player.hp, instruction.amount);
    emit(context, {
      type: "RESOURCE_CHANGED",
      playerId,
      resource: "HP",
      delta: -amount,
      valueAfter: clampResource(player.hp - instruction.amount),
      reason: "DEMON"
    });
    resolveHpZero(context, playerId);
    maybeDepartGuardianAfterHpLoss(context, playerId, amount);
  }

  if (hasSpecialEffect(definition, "REMOVE_SOMETHING")) {
    handled = true;
    let removedCount = 0;
    for (let index = 0; index < 2; index += 1) {
      const player = context.state.players[playerId];
      if (!player?.alive) break;
      const candidates = demonRemovableObjects(player);
      if (candidates.length === 0) break;
      const selection = drawWeighted(
        context.state.rng,
        candidates.map((object) => ({
          key: `${object.objectType}:${object.objectId}`,
          weight: 1,
          value: object
        })),
        "DEMON_EFFECT",
        context.state.eventSequence + 1
      );
      const removed = consumeSelection(context, selection);
      emit(
        context,
        {
          type: "DEMON_OBJECT_REMOVED",
          playerId,
          objectType: removed.objectType,
          objectId: removed.objectId,
          cardDefinitionId: removed.cardDefinitionId
        },
        playerVisibility(playerId)
      );
      removedCount += 1;
    }
    emit(context, {
      type: "DEMON_THEFT_RESOLVED",
      playerId,
      removedCount
    });
  }

  if (hasSpecialEffect(definition, "BOOST_SOMETHING")) {
    handled = true;
    const boostInstructions = definition.instructions.filter(
      (
        instruction
      ): instruction is Extract<
        CardDefinition["instructions"][number],
        { kind: "BOOST_HP" | "BOOST_MP" | "BOOST_MONEY" }
      > =>
        instruction.kind === "BOOST_HP" ||
        instruction.kind === "BOOST_MP" ||
        instruction.kind === "BOOST_MONEY"
    );
    const selection = drawWeighted(
      context.state.rng,
      boostInstructions.map((instruction) => ({
        key: instruction.kind,
        weight: 1,
        value: instruction
      })),
      "DEMON_EFFECT",
      context.state.eventSequence + 1
    );
    const boost = consumeSelection(context, selection);
    const player = context.state.players[playerId];
    if (player?.alive) {
      const resource =
        boost.kind === "BOOST_HP"
          ? "HP"
          : boost.kind === "BOOST_MP"
            ? "MP"
            : "MONEY";
      const current =
        resource === "HP"
          ? player.hp
          : resource === "MP"
            ? player.mp
            : player.money;
      const valueAfter = clampResource(current + boost.amount);
      emit(context, {
        type: "RESOURCE_CHANGED",
        playerId,
        resource,
        delta: valueAfter - current,
        valueAfter,
        reason: "DEMON"
      });
    }
  }

  if (!handled) {
    throw new Error(`Unsupported demon effect ${definition.cardDefinitionId}`);
  }
}

function resolveNormalGrant(
  context: EngineContext,
  playerId: string,
  reason: GrantObligation["reason"]
): void {
  const player = context.state.players[playerId];
  if (!player) return;
  if (!player.alive && reason !== "INITIAL") return;
  const obligation = makeGrantObligation(context, playerId, reason);
  emit(context, { type: "GRANT_REQUESTED", obligation });

  if (!context.state.endTimeActive) {
    grantStandardArtifact(context, playerId, obligation);
    return;
  }

  while (context.state.players[playerId]?.alive) {
    const outcomeSelection = drawWeighted<CardDefinition | null>(
      context.state.rng,
      [
        {
          key: "STANDARD_ARTIFACT",
          weight: 75,
          value: null
        },
        ...DEMON_GRANT_POOL.map(({ key, weight, value }) => ({
          key,
          weight,
          value
        }))
      ],
      "END_TIME_GRANT",
      context.state.eventSequence + 1
    );
    const outcome = consumeSelection(context, outcomeSelection);
    if (outcome === null) {
      grantStandardArtifact(context, playerId, obligation);
      return;
    }
    emit(context, {
      type: "DEMON_APPEARED",
      obligationId: obligation.obligationId,
      playerId,
      demonCardDefinitionId: outcome.cardDefinitionId
    });
    resolveDemonEffect(context, playerId, outcome);
  }

  emit(context, {
    type: "GRANT_CANCELLED",
    obligationId: obligation.obligationId,
    playerId,
    reason: "PLAYER_ASCENDED"
  });
}

function emptyState(input: CreateMatchInput): MatchState {
  const mode = input.mode ?? "TRAINING";
  const players: Record<string, PlayerState> = {};
  for (const [seat, setup] of input.players.entries()) {
    players[setup.playerId] = {
      playerId: setup.playerId,
      displayName: setup.displayName,
      teamId: setup.teamId ?? null,
      seat,
      controller: setup.controller ?? "HUMAN",
      alive: true,
      hp: INITIAL_HP,
      mp: INITIAL_MP,
      money: INITIAL_MONEY,
      hand: [],
      learnedMiracles: [],
      calamities: {},
      guardian: null,
      disconnected: false
    };
  }
  return {
    matchId: input.matchId,
    rulesetVersion: RULESET_VERSION,
    cardPoolVersion: CARD_POOL_VERSION,
    mode,
    phase: "INITIALIZING",
    revision: 0,
    gfCount: 0,
    endTimeThreshold: input.endTimeThreshold ?? null,
    endTimeActive: false,
    activePlayerId: null,
    turnOrder: [],
    turnCursor: -1,
    players,
    pendingAction: null,
    postTurnAutomatic: null,
    phenomenonAutomatic: null,
    pendingGrant: [],
    eventSequence: 0,
    rng: createRng(input.seed),
    randomLog: [],
    result: null,
    inputDeadlineAt: null,
    processedCommands: {},
    nextEntitySequence: 0,
    defeatedThisTurn: []
  };
}

export function createMatch(
  input: CreateMatchInput
): { state: MatchState; events: DomainEvent[] } {
  if (input.players.length < 2 || input.players.length > 9) {
    throw new Error("A match requires 2 to 9 players");
  }
  if (new Set(input.players.map(({ playerId }) => playerId)).size !== input.players.length) {
    throw new Error("playerId values must be unique");
  }
  if (!input.matchId || !input.seed) {
    throw new Error("matchId and seed are required");
  }
  if (
    input.endTimeThreshold !== undefined &&
    input.endTimeThreshold !== null &&
    !([1, 50, 75, 100, 150] as const).includes(input.endTimeThreshold)
  ) {
    throw new Error("End-time threshold must be 1, 50, 75, 100, 150, or null");
  }
  const occurredAt = assertIsoDate(input.now ?? "1970-01-01T00:00:00.000Z");
  const context: EngineContext = {
    state: emptyState(input),
    events: [],
    occurredAt
  };
  const shuffle = shuffleDeterministically(
    context.state.rng,
    input.players.map((player, seat) => ({
      key: `${String(seat).padStart(2, "0")}:${player.playerId}`,
      value: player.playerId
    })),
    "TURN_ORDER",
    context.state.eventSequence + 1
  );
  context.state = {
    ...context.state,
    rng: shuffle.state,
    randomLog: [...context.state.randomLog, ...shuffle.audits]
  };
  emit(context, { type: "MATCH_STARTED", turnOrder: shuffle.values });

  // Project decision: initial grants consume RNG one card per seat for nine rounds.
  const seatOrder = Object.values(context.state.players).sort(
    (left, right) => left.seat - right.seat
  );
  for (let round = 0; round < INITIAL_HAND_SIZE; round += 1) {
    for (const player of seatOrder) {
      resolveNormalGrant(context, player.playerId, "INITIAL");
    }
  }
  emit(context, { type: "INITIAL_GRANT_COMPLETED" });
  emit(context, { type: "GF_COUNT_CHANGED", gfCount: 1 });
  const firstPlayerId = context.state.turnOrder[0];
  if (!firstPlayerId) throw new Error("Turn order is empty");
  emit(context, { type: "TURN_OPENED", playerId: firstPlayerId });
  emit(context, {
    type: "ACTION_REQUESTED",
    playerId: firstPlayerId,
    inputDeadlineAt: deadlineFor(context.state, firstPlayerId, occurredAt)
  });
  return { state: context.state, events: context.events };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pendingInputPlayerId(state: MatchState): string | null {
  if (
    state.phase === "ACTION_SELECTION" ||
    state.phase === "TARGET_SELECTION"
  ) {
    return state.activePlayerId;
  }
  if (
    state.phase === "REACTION_SELECTION" &&
    state.pendingAction?.kind === "ATTACK"
  ) {
    return state.pendingAction.attack.targetPlayerId;
  }
  if (
    state.phase === "TRADE_CONFIRMATION" &&
    state.pendingAction?.kind === "TRADE_CONFIRMATION"
  ) {
    return state.pendingAction.actorId;
  }
  return null;
}

function baseCommandValidation(
  state: MatchState,
  command: GameCommand,
  authority: Controller,
  occurredAt: string
): CommandFailure | null {
  if (command.matchId !== state.matchId) {
    return fail(state, "MATCH_ID_MISMATCH", "Command belongs to another match");
  }
  const actor = state.players[command.actorId];
  if (!actor) {
    return fail(state, "INVALID_ACTOR", "Unknown actor");
  }
  if (!actor.alive) {
    return fail(state, "PLAYER_ASCENDED", "Ascended players cannot act");
  }
  if (actor.controller !== authority) {
    return fail(
      state,
      "CONTROLLER_MISMATCH",
      `The player is controlled by ${actor.controller}`
    );
  }
  if (command.expectedRevision !== state.revision) {
    return fail(state, "STALE_REVISION", "Expected revision does not match current state");
  }
  if (
    authority === "HUMAN" &&
    pendingInputPlayerId(state) === command.actorId &&
    state.inputDeadlineAt !== null &&
    Date.parse(occurredAt) >= Date.parse(state.inputDeadlineAt)
  ) {
    return fail(
      state,
      "INPUT_DEADLINE_EXPIRED",
      "The server input deadline has expired"
    );
  }
  return null;
}

function requireActiveActionPhase(
  state: MatchState,
  actorId: string
): CommandFailure | null {
  if (state.phase !== "ACTION_SELECTION") {
    return fail(state, "INVALID_PHASE", "The match is not accepting an action");
  }
  if (state.activePlayerId !== actorId) {
    return fail(state, "NOT_ACTIVE_PLAYER", "Only the active player can act");
  }
  return null;
}

function getCard(
  state: MatchState,
  playerId: string,
  instanceId: string
): { instance: CardInstance; definition: CardDefinition } | null {
  const instance = state.players[playerId]?.hand.find(
    (card) => card.instanceId === instanceId
  );
  if (!instance) return null;
  const definition = CARD_DEFINITIONS_BY_ID.get(instance.cardDefinitionId);
  if (!definition) throw new Error(`Unknown card definition ${instance.cardDefinitionId}`);
  return { instance, definition };
}

function primaryAttackAmount(
  definition: CardDefinition,
  currentMp: number
): number | null {
  const attack = instructionsOfKind(definition, "ATTACK")[0];
  if (!attack) return null;
  if (attack.amount === "CURRENT_MP_X2") return currentMp * 2;
  return typeof attack.amount === "number" ? attack.amount : null;
}

export function canPray(state: MatchState, playerId: string): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  return !player.hand.some((instance) => {
    const definition = CARD_DEFINITIONS_BY_ID.get(instance.cardDefinitionId);
    return (
      definition?.category === "WEAPON" &&
      primaryAttackAmount(definition, player.mp) !== null
    );
  });
}

function isEnemy(actor: PlayerState, target: PlayerState): boolean {
  if (actor.playerId === target.playerId || !target.alive) return false;
  return actor.teamId === null || target.teamId === null || actor.teamId !== target.teamId;
}

function areOpponents(left: PlayerState, right: PlayerState): boolean {
  if (left.playerId === right.playerId) return false;
  return (
    left.teamId === null ||
    right.teamId === null ||
    left.teamId !== right.teamId
  );
}

function combineElements(elements: readonly Element[]): Element {
  const unique = [...new Set(elements)];
  if (unique.length === 0) return "PHYSICAL";
  if (unique.length === 1) return unique[0] ?? "PHYSICAL";
  if (unique.includes("PHYSICAL")) return "PHYSICAL";
  if (unique.includes("DARK")) return "PHYSICAL";
  const nonLight = unique.filter((element) => element !== "LIGHT");
  if (nonLight.length === 1) return nonLight[0] ?? "LIGHT";
  return "PHYSICAL";
}

export function canDefenseBlock(
  defenseElement: Element,
  attackElement: Element
): boolean {
  if (attackElement === "DARK") return true;
  if (attackElement === "LIGHT") return false;
  if (attackElement === "PHYSICAL") return true;
  if (defenseElement === "LIGHT") return true;
  const opposite: Partial<Record<Element, Element>> = {
    FIRE: "WATER",
    WATER: "FIRE",
    WOOD: "EARTH",
    EARTH: "WOOD"
  };
  return defenseElement === opposite[attackElement];
}

export type ReactionEffect = "BLOCK" | "REFLECT" | "BOUNCE";

export function reactionEffectFor(
  definition: CardDefinition,
  attackKind: AttackKind,
  attackElement: Element
): ReactionEffect | null {
  if (hasSpecialEffect(definition, "REFLECT_ANYTHING")) return "REFLECT";
  if (attackKind === "WEAPON" && attackElement === "PHYSICAL") {
    if (hasSpecialEffect(definition, "BLOCK_WEAPON")) return "BLOCK";
    if (hasSpecialEffect(definition, "REFLECT_WEAPON")) return "REFLECT";
    if (hasSpecialEffect(definition, "BOUNCE_WEAPON")) return "BOUNCE";
  }
  if (attackKind === "MIRACLE") {
    if (hasSpecialEffect(definition, "BLOCK_MIRACLE")) return "BLOCK";
    if (hasSpecialEffect(definition, "REFLECT_MIRACLE")) return "REFLECT";
    if (hasSpecialEffect(definition, "BOUNCE_MIRACLE")) return "BOUNCE";
  }
  return null;
}

export function hasCounterOrFilterEffect(
  definition: CardDefinition
): boolean {
  return (
    instructionsOfKind(definition, "ATTACK").some(
      ({ amount }) => amount === "DAMAGE" || amount === "DAMAGE_X2"
    ) ||
    instructionsOfKind(definition, "ADD_CALAMITY").some(
      ({ timing }) => timing === "COUNTER"
    ) ||
    instructionsOfKind(definition, "COUNTER_BOOST_MP").length > 0 ||
    instructionsOfKind(definition, "TAKE_MONEY").some(
      ({ amount }) => amount === "DAMAGE"
    ) ||
    hasSpecialEffect(definition, "FILTER_ATTACK_ELEMENT")
  );
}

function currentMatchResult(state: MatchState): MatchResult | null {
  if (state.defeatedThisTurn.length >= 2) {
    return { kind: "DRAW", winnerPlayerIds: [], winnerTeamId: null };
  }
  const alive = Object.values(state.players).filter(({ alive }) => alive);
  if (alive.length === 0) {
    return { kind: "DRAW", winnerPlayerIds: [], winnerTeamId: null };
  }
  const teamIds = new Set(alive.map(({ teamId, playerId }) => teamId ?? playerId));
  if (teamIds.size !== 1) return null;
  const winnerTeamId = alive[0]?.teamId ?? null;
  return {
    kind: "WIN",
    winnerPlayerIds: alive.map(({ playerId }) => playerId),
    winnerTeamId
  };
}

function maybeEndMatch(context: EngineContext): boolean {
  const result = currentMatchResult(context.state);
  if (!result) return false;
  emit(context, { type: "MATCH_ENDED", result });
  return true;
}

function openNextTurnOrEnd(context: EngineContext): void {
  if (maybeEndMatch(context)) return;
  const count = context.state.turnOrder.length;
  let nextPlayerId: string | undefined;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (context.state.turnCursor + offset) % count;
    const candidate = context.state.turnOrder[index];
    if (candidate && context.state.players[candidate]?.alive) {
      nextPlayerId = candidate;
      break;
    }
  }
  if (!nextPlayerId) {
    const result: MatchResult = {
      kind: "DRAW",
      winnerPlayerIds: [],
      winnerTeamId: null
    };
    emit(context, { type: "MATCH_ENDED", result });
    return;
  }
  emit(context, {
    type: "GF_COUNT_CHANGED",
    gfCount: context.state.gfCount + 1
  });
  emit(context, { type: "TURN_OPENED", playerId: nextPlayerId });
  emit(context, {
    type: "ACTION_REQUESTED",
    playerId: nextPlayerId,
    inputDeadlineAt: deadlineFor(
      context.state,
      nextPlayerId,
      context.occurredAt
    )
  });
}

function finishTurn(context: EngineContext, actorId: string): void {
  emit(context, { type: "TURN_CLOSED", playerId: actorId });
  const turnActor = context.state.players[actorId];
  const guardianPlayerIds = turnActor
    ? Object.values(context.state.players)
        .filter(
          (player) =>
            player.alive &&
            player.guardian !== null &&
            areOpponents(player, turnActor)
        )
        .sort((left, right) => left.seat - right.seat)
        .map(({ playerId }) => playerId)
    : [];
  emit(context, {
    type: "POST_TURN_AUTOMATIC_EFFECTS_STARTED",
    turnActorId: actorId,
    guardianPlayerIds
  });
  continuePostTurnAutomaticEffects(context);
}

function resolveHpZero(
  context: EngineContext,
  playerId: string,
  sourcePlayerId: string | null = null
): void {
  const player = context.state.players[playerId];
  if (!player || player.hp > 0) return;
  emit(context, { type: "HP_REACHED_ZERO", playerId });
  const amulet = player.hand.find(
    ({ cardDefinitionId }) => cardDefinitionId === "sun-amulet"
  );
  if (amulet) {
    emit(context, {
      type: "CARD_CONSUMED",
      playerId,
      cardInstanceId: amulet.instanceId
    });
    emit(context, {
      type: "REVIVAL_RESOLVED",
      playerId,
      cardInstanceId: amulet.instanceId,
      hpAfter: 10
    });
    return;
  }
  const ascensionBow =
    sourcePlayerId && sourcePlayerId !== playerId
      ? player.hand.find(
          ({ cardDefinitionId }) =>
            cardDefinitionId === "ascension-bow"
        )
      : undefined;
  if (ascensionBow && sourcePlayerId) {
    emit(context, {
      type: "CARD_CONSUMED",
      playerId,
      cardInstanceId: ascensionBow.instanceId
    });
    const hit = consumeSelection(
      context,
      drawWeighted(
        context.state.rng,
        [
          { key: "HIT", weight: 75, value: true },
          { key: "MISS", weight: 25, value: false }
        ],
        "HIT_CHECK",
        context.state.eventSequence + 1
      )
    );
    emit(context, {
      type: "ASCENSION_BOW_TRIGGERED",
      playerId,
      targetPlayerId: sourcePlayerId,
      cardInstanceId: ascensionBow.instanceId,
      hit
    });
    const target = context.state.players[sourcePlayerId];
    if (hit && target?.alive) {
      const hpLoss = Math.min(target.hp, 30);
      emit(context, {
        type: "RESOURCE_CHANGED",
        playerId: sourcePlayerId,
        resource: "HP",
        delta: -hpLoss,
        valueAfter: clampResource(target.hp - 30),
        reason: "COUNTER"
      });
      resolveHpZero(context, sourcePlayerId);
      maybeDepartGuardianAfterHpLoss(
        context,
        sourcePlayerId,
        hpLoss
      );
    }
  }
  emit(context, { type: "PLAYER_ASCENDED", playerId, reason: "HP_ZERO" });
}

function completeAttack(
  context: EngineContext,
  actionOwnerId: string,
  attackerGrantCount: number,
  defenseGrantCounts: Readonly<Record<string, number>>,
  revivalGrantCounts: Readonly<Record<string, number>>,
  completion: AttackCompletion
): void {
  for (let index = 0; index < attackerGrantCount; index += 1) {
    resolveNormalGrant(context, actionOwnerId, "CARD_USED");
  }
  for (const [playerId, grantCount] of Object.entries(defenseGrantCounts)) {
    for (let index = 0; index < grantCount; index += 1) {
      resolveNormalGrant(context, playerId, "DEFENSE_USED");
    }
  }
  for (const [playerId, grantCount] of Object.entries(revivalGrantCounts)) {
    for (let index = 0; index < grantCount; index += 1) {
      resolveNormalGrant(context, playerId, "CARD_USED");
    }
  }
  if (completion === "RESUME_POST_TURN") {
    continuePostTurnAutomaticEffects(context);
  } else if (completion === "RESUME_PHENOMENON") {
    const automatic = context.state.phenomenonAutomatic;
    const slot =
      automatic?.actionSlots[automatic.nextActionIndex];
    if (slot) {
      completeConfusionAction(
        context,
        slot.playerId,
        slot.round
      );
    }
  } else {
    finishTurn(context, actionOwnerId);
  }
}

function handlePray(context: EngineContext, command: Extract<GameCommand, { type: "PRAY" }>): CommandFailure | null {
  const phaseError = requireActiveActionPhase(context.state, command.actorId);
  if (phaseError) return phaseError;
  if (!canPray(context.state, command.actorId)) {
    return fail(context.state, "PRAY_NOT_ALLOWED", "A usable weapon prevents praying");
  }
  emit(context, {
    type: "ACTION_DECLARED",
    playerId: command.actorId,
    actionType: command.type,
    targetPlayerId: null,
    actionCardDefinitionIds: []
  });
  resolveNormalGrant(context, command.actorId, "PRAY");
  finishTurn(context, command.actorId);
  return null;
}

function handleDiscard(
  context: EngineContext,
  command: Extract<GameCommand, { type: "DISCARD" | "SACRIFICE" }>
): CommandFailure | null {
  const phaseError = requireActiveActionPhase(context.state, command.actorId);
  if (phaseError) return phaseError;
  const isSacrifice = command.type === "SACRIFICE";
  if (isSacrifice !== context.state.endTimeActive) {
    return fail(context.state, "INVALID_PHASE", "Discard mode does not match end-time state");
  }
  const selected = getCard(context.state, command.actorId, command.cardInstanceId);
  if (!selected) return fail(context.state, "CARD_NOT_FOUND", "Card is not in the actor hand");
  if (
    !isSacrifice &&
    (selected.definition.category === "WEAPON" ||
      selected.definition.cardDefinitionId === "sun-amulet" ||
      selected.definition.cardDefinitionId === "dangerous-mortar")
  ) {
    return fail(context.state, "INVALID_CARD_SELECTION", "This card cannot be discarded");
  }
  emit(context, {
    type: "ACTION_DECLARED",
    playerId: command.actorId,
    actionType: command.type,
    targetPlayerId: null,
    actionCardDefinitionIds: [selected.definition.cardDefinitionId]
  });
  emit(context, {
    type: "CARD_CONSUMED",
    playerId: command.actorId,
    cardInstanceId: command.cardInstanceId
  });
  if (isSacrifice) resolveNormalGrant(context, command.actorId, "SACRIFICE");
  finishTurn(context, command.actorId);
  return null;
}

function tradeCard(
  state: MatchState,
  playerId: string,
  cardInstanceId: string,
  operation: "EXCHANGE" | "SELL" | "BUY"
): ReturnType<typeof getCard> {
  const selected = getCard(state, playerId, cardInstanceId);
  if (
    !selected ||
    selected.definition.category !== "TRADE" ||
    !hasSpecialEffect(selected.definition, operation)
  ) {
    return null;
  }
  return selected;
}

function canPayPrice(player: PlayerState, price: number): boolean {
  return player.money + player.mp + player.hp >= price;
}

function collectTradePayment(
  context: EngineContext,
  payerPlayerId: string,
  recipientPlayerId: string,
  price: number
): number {
  const payer = context.state.players[payerPlayerId];
  const recipient = context.state.players[recipientPlayerId];
  if (!payer || !recipient) throw new Error("Trade payment player disappeared");
  const moneyPaid = Math.min(payer.money, price);
  const afterMoney = price - moneyPaid;
  const mpPaid = Math.min(payer.mp, afterMoney);
  const hpPaid = afterMoney - mpPaid;
  const payerHpAfter = clampResource(payer.hp - hpPaid);
  emit(context, {
    type: "TRADE_PAYMENT_COLLECTED",
    payerPlayerId,
    recipientPlayerId,
    price,
    moneyPaid,
    mpPaid,
    hpPaid,
    payerMoneyAfter: payer.money - moneyPaid,
    payerMpAfter: payer.mp - mpPaid,
    payerHpAfter,
    recipientMoneyAfter: clampResource(recipient.money + price)
  });
  return payer.hp - payerHpAfter;
}

function transferTradeCard(
  context: EngineContext,
  fromPlayerId: string,
  toPlayerId: string,
  card: CardInstance
): void {
  const previousRecipientCardIds =
    context.state.players[toPlayerId]?.hand.map(({ instanceId }) => instanceId) ?? [];
  emit(context, {
    type: "CARD_TRANSFERRED",
    fromPlayerId,
    toPlayerId,
    card
  });
  const recipient = context.state.players[toPlayerId];
  if (recipient && recipient.hand.length > MAX_HAND_SIZE) {
    const selection = drawWeighted(
      context.state.rng,
      previousRecipientCardIds.map((instanceId) => ({
        key: instanceId,
        weight: 1,
        value: instanceId
      })),
      "HAND_LIMIT_DISCARD",
      context.state.eventSequence + 1
    );
    emit(context, {
      type: "HAND_LIMIT_DISCARD",
      playerId: toPlayerId,
      cardInstanceId: consumeSelection(context, selection)
    });
  }
}

function finishTradeAction(
  context: EngineContext,
  actorId: string,
  hpZeroCandidateId: string | null,
  hpLoss: number
): void {
  let usedRevival = false;
  if (hpZeroCandidateId) {
    const payer = context.state.players[hpZeroCandidateId];
    usedRevival =
      payer?.hp === 0 &&
      payer.hand.some(
        ({ cardDefinitionId }) => cardDefinitionId === "sun-amulet"
      );
    resolveHpZero(context, hpZeroCandidateId);
    if (hpLoss > 0) {
      maybeDepartGuardianAfterHpLoss(context, hpZeroCandidateId, hpLoss);
    }
  }
  if (maybeEndMatch(context)) return;
  resolveNormalGrant(context, actorId, "CARD_USED");
  if (usedRevival && hpZeroCandidateId) {
    resolveNormalGrant(context, hpZeroCandidateId, "CARD_USED");
  }
  finishTurn(context, actorId);
}

function handleExchangeResources(
  context: EngineContext,
  command: Extract<GameCommand, { type: "EXCHANGE_RESOURCES" }>
): CommandFailure | null {
  const phaseError = requireActiveActionPhase(context.state, command.actorId);
  if (phaseError) return phaseError;
  const selected = tradeCard(
    context.state,
    command.actorId,
    command.cardInstanceId,
    "EXCHANGE"
  );
  if (!selected) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "The selected card cannot exchange resources"
    );
  }
  const values = [command.hp, command.mp, command.money];
  if (
    values.some(
      (value) =>
        !Number.isInteger(value) || value < 0 || value > MAX_RESOURCE
    )
  ) {
    return fail(
      context.state,
      "INVALID_RESOURCE_ALLOCATION",
      "Exchanged resources must be integers from 0 to 99"
    );
  }
  const actor = context.state.players[command.actorId];
  if (!actor) return fail(context.state, "INVALID_ACTOR", "Actor does not exist");
  if (command.hp + command.mp + command.money !== actor.hp + actor.mp + actor.money) {
    return fail(
      context.state,
      "INVALID_RESOURCE_ALLOCATION",
      "Exchange must preserve the total resource value"
    );
  }

  emit(context, {
    type: "ACTION_DECLARED",
    playerId: command.actorId,
    actionType: command.type,
    targetPlayerId: command.actorId,
    actionCardDefinitionIds: [selected.definition.cardDefinitionId]
  });
  emit(context, {
    type: "CARD_CONSUMED",
    playerId: command.actorId,
    cardInstanceId: selected.instance.instanceId
  });
  emit(context, {
    type: "RESOURCES_EXCHANGED",
    playerId: command.actorId,
    hpAfter: command.hp,
    mpAfter: command.mp,
    moneyAfter: command.money
  });
  finishTradeAction(
    context,
    command.actorId,
    command.actorId,
    Math.max(0, actor.hp - command.hp)
  );
  return null;
}

function handleSellCard(
  context: EngineContext,
  command: Extract<GameCommand, { type: "SELL_CARD" }>
): CommandFailure | null {
  const phaseError = requireActiveActionPhase(context.state, command.actorId);
  if (phaseError) return phaseError;
  const source = tradeCard(
    context.state,
    command.actorId,
    command.cardInstanceId,
    "SELL"
  );
  if (!source) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "The selected card cannot sell an artifact"
    );
  }
  if (command.productCardInstanceId === command.cardInstanceId) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "The sell card cannot sell itself"
    );
  }
  const product = getCard(
    context.state,
    command.actorId,
    command.productCardInstanceId
  );
  if (!product) {
    return fail(context.state, "CARD_NOT_FOUND", "The sold artifact is not in hand");
  }
  const actor = context.state.players[command.actorId];
  const target = context.state.players[command.targetPlayerId];
  if (!actor || !target || !isEnemy(actor, target)) {
    return fail(context.state, "INVALID_TARGET", "Trade target must be a living enemy");
  }
  const price = product.definition.price ?? 0;
  emit(context, {
    type: "ACTION_DECLARED",
    playerId: command.actorId,
    actionType: command.type,
    targetPlayerId: command.targetPlayerId,
    actionCardDefinitionIds: [source.definition.cardDefinitionId]
  });
  emit(context, {
    type: "CARD_CONSUMED",
    playerId: command.actorId,
    cardInstanceId: source.instance.instanceId
  });
  startTargetedCardReaction(context, {
    seriesId: command.commandId,
    actionOwnerId: command.actorId,
    targetPlayerId: command.targetPlayerId,
    sourceCardInstanceIds: [source.instance.instanceId],
    sourceLearnedMiracleIds: [],
    sourceCardDefinitionIds: [source.definition.cardDefinitionId],
    attackerGrantCount: 1,
    deferredTargetedCardEffect: {
      kind: "SELL",
      productCardInstanceId: product.instance.instanceId,
      price,
      tradeId: command.commandId
    }
  });
  return null;
}

function handleDeclareBuy(
  context: EngineContext,
  command: Extract<GameCommand, { type: "DECLARE_BUY" }>
): CommandFailure | null {
  const phaseError = requireActiveActionPhase(context.state, command.actorId);
  if (phaseError) return phaseError;
  const source = tradeCard(
    context.state,
    command.actorId,
    command.cardInstanceId,
    "BUY"
  );
  if (!source) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "The selected card cannot buy an artifact"
    );
  }
  const actor = context.state.players[command.actorId];
  const target = context.state.players[command.targetPlayerId];
  if (!actor || !target || !isEnemy(actor, target) || target.hand.length === 0) {
    return fail(
      context.state,
      "INVALID_TARGET",
      "Buy target must be a living enemy with an artifact"
    );
  }
  emit(context, {
    type: "ACTION_DECLARED",
    playerId: command.actorId,
    actionType: command.type,
    targetPlayerId: command.targetPlayerId,
    actionCardDefinitionIds: [source.definition.cardDefinitionId]
  });
  emit(context, {
    type: "CARD_CONSUMED",
    playerId: command.actorId,
    cardInstanceId: source.instance.instanceId
  });
  startTargetedCardReaction(context, {
    seriesId: command.commandId,
    actionOwnerId: command.actorId,
    targetPlayerId: command.targetPlayerId,
    sourceCardInstanceIds: [source.instance.instanceId],
    sourceLearnedMiracleIds: [],
    sourceCardDefinitionIds: [source.definition.cardDefinitionId],
    attackerGrantCount: 1,
    deferredTargetedCardEffect: {
      kind: "BUY",
      tradeId: command.commandId
    }
  });
  return null;
}

function handleConfirmBuy(
  context: EngineContext,
  command: Extract<GameCommand, { type: "CONFIRM_BUY" }>
): CommandFailure | null {
  const pending = context.state.pendingAction;
  if (
    context.state.phase !== "TRADE_CONFIRMATION" ||
    pending?.kind !== "TRADE_CONFIRMATION" ||
    pending.tradeId !== command.tradeId ||
    pending.actorId !== command.actorId
  ) {
    return fail(context.state, "INVALID_TRADE", "Trade confirmation is not current");
  }
  const offered = getCard(
    context.state,
    pending.targetPlayerId,
    pending.offeredCardInstanceId
  );
  if (!offered) {
    return fail(context.state, "INVALID_TRADE", "The offered artifact no longer exists");
  }
  if (!command.accept) {
    emit(
      context,
      {
        type: "TRADE_RESOLVED",
        tradeId: pending.tradeId,
        actorId: pending.actorId,
        targetPlayerId: pending.targetPlayerId,
        offeredCardInstanceId: pending.offeredCardInstanceId,
        resolution: "DECLINED"
      },
      playerVisibility(command.actorId)
    );
    resolveNormalGrant(context, command.actorId, "CARD_USED");
    finishTurn(context, command.actorId);
    return null;
  }
  const buyer = context.state.players[command.actorId];
  if (!buyer || !pending.canAfford || !canPayPrice(buyer, pending.price)) {
    return fail(
      context.state,
      "INSUFFICIENT_RESOURCES",
      "The offered artifact cannot be paid for"
    );
  }
  const hpLoss = collectTradePayment(
    context,
    command.actorId,
    pending.targetPlayerId,
    pending.price
  );
  transferTradeCard(
    context,
    pending.targetPlayerId,
    command.actorId,
    offered.instance
  );
  emit(context, {
    type: "TRADE_RESOLVED",
    tradeId: pending.tradeId,
    actorId: pending.actorId,
    targetPlayerId: pending.targetPlayerId,
    offeredCardInstanceId: pending.offeredCardInstanceId,
    resolution: "ACCEPTED"
  });
  finishTradeAction(context, command.actorId, command.actorId, hpLoss);
  return null;
}

type ActionSource = {
  definition: CardDefinition;
  cardInstance: CardInstance | null;
  learnedMiracleId: string | null;
};

type AttackSeriesPlan = {
  seriesId: string;
  actionOwnerId: string;
  targetPlayerIds: string[];
  sourceCardInstanceIds: string[];
  sourceLearnedMiracleIds: string[];
  sourceCardDefinitionIds: string[];
  element: Element;
  power: number;
  hitRate: number;
  attackKind: AttackKind;
  totalAttacks: number;
  attackerGrantCount: number;
  completion: AttackCompletion;
};

function startTargetedCardReaction(
  context: EngineContext,
  options: {
    seriesId: string;
    actionOwnerId: string;
    targetPlayerId: string;
    sourceCardInstanceIds: string[];
    sourceLearnedMiracleIds: string[];
    sourceCardDefinitionIds: string[];
    attackerGrantCount: number;
    deferredTargetedCardEffect: NonNullable<
      Extract<
        NonNullable<MatchState["pendingAction"]>,
        { kind: "ATTACK" }
      >["deferredTargetedCardEffect"]
    >;
  }
): void {
  const attackId = `${options.seriesId}:targeted-card`;
  const reactionId = `${attackId}:reaction:1`;
  emit(context, {
    type: "ATTACK_CREATED",
    attack: {
      attackId,
      reactionId,
      reactionDepth: 1,
      seriesId: options.seriesId,
      attackNumber: 1,
      totalAttacks: 1,
      targetIndex: 0,
      totalTargets: 1,
      attackKind: "TARGETED_CARD",
      actorId: options.actionOwnerId,
      targetPlayerId: options.targetPlayerId,
      sourceCardInstanceIds: [...options.sourceCardInstanceIds],
      sourceLearnedMiracleIds: [...options.sourceLearnedMiracleIds],
      sourceCardDefinitionIds: [...options.sourceCardDefinitionIds],
      element: "LIGHT",
      power: 0,
      hit: true
    },
    actionOwnerId: options.actionOwnerId,
    targetPlayerIds: [options.targetPlayerId],
    hitRate: 100,
    attackerGrantCount: options.attackerGrantCount,
    completion: "FINISH_TURN",
    deferredTargetedCardEffect: options.deferredTargetedCardEffect
  });
  emit(context, {
    type: "REACTION_REQUESTED",
    reactionId,
    attackId,
    playerId: options.targetPlayerId,
    inputDeadlineAt: deadlineFor(
      context.state,
      options.targetPlayerId,
      context.occurredAt
    )
  });
}

function hasSpecialEffect(
  definition: CardDefinition,
  operation: SpecialEffectOperation
): boolean {
  return instructionsOfKind(definition, "SPECIAL").some(
    (instruction) => instruction.operation === operation
  );
}

function attackSourceAmount(
  definition: CardDefinition,
  currentMp: number
): number | null {
  return primaryAttackAmount(definition, currentMp);
}

function startAttackSeriesStep(
  context: EngineContext,
  plan: AttackSeriesPlan,
  startTargetIndex: number,
  startAttackNumber: number
): boolean {
  for (let targetIndex = startTargetIndex; targetIndex < plan.targetPlayerIds.length; targetIndex += 1) {
    const targetPlayerId = plan.targetPlayerIds[targetIndex];
    if (!targetPlayerId || !context.state.players[targetPlayerId]?.alive) continue;
    const firstAttackNumber =
      targetIndex === startTargetIndex ? startAttackNumber : 1;
    for (
      let attackNumber = firstAttackNumber;
      attackNumber <= plan.totalAttacks;
      attackNumber += 1
    ) {
      const attackId =
        plan.targetPlayerIds.length === 1
          ? `${plan.seriesId}:attack:${attackNumber}`
          : `${plan.seriesId}:target:${targetIndex + 1}:attack:${attackNumber}`;
      const reactionId = `${attackId}:reaction:1`;
      emit(context, {
        type: "ATTACK_CREATED",
        attack: {
          attackId,
          reactionId,
          reactionDepth: 1,
          seriesId: plan.seriesId,
          attackNumber,
          totalAttacks: plan.totalAttacks,
          targetIndex,
          totalTargets: plan.targetPlayerIds.length,
          attackKind: plan.attackKind,
          actorId: plan.actionOwnerId,
          targetPlayerId,
          sourceCardInstanceIds: [...plan.sourceCardInstanceIds],
          sourceLearnedMiracleIds: [...plan.sourceLearnedMiracleIds],
          sourceCardDefinitionIds: [...plan.sourceCardDefinitionIds],
          element: plan.element,
          power: plan.power,
          hit: null
        },
        actionOwnerId: plan.actionOwnerId,
        targetPlayerIds: [...plan.targetPlayerIds],
        hitRate: plan.hitRate,
        attackerGrantCount: plan.attackerGrantCount,
        completion: plan.completion
      });
      let hit =
        context.state.players[targetPlayerId]?.calamities.DARK_CLOUD === true;
      if (!hit && plan.hitRate < 100) {
        const selection = drawWeighted(
          context.state.rng,
          [
            { key: "HIT", weight: plan.hitRate, value: true },
            { key: "MISS", weight: 100 - plan.hitRate, value: false }
          ],
          "HIT_CHECK",
          context.state.eventSequence + 1
        );
        hit = consumeSelection(context, selection);
      } else if (!hit) {
        hit = true;
      }
      emit(context, {
        type: "HIT_ROLLED",
        attackId,
        hit,
        hitRate: plan.hitRate
      });
      if (hit) {
        emit(context, {
          type: "REACTION_REQUESTED",
          reactionId,
          attackId,
          playerId: targetPlayerId,
          inputDeadlineAt: deadlineFor(
            context.state,
            targetPlayerId,
            context.occurredAt
          )
        });
        return true;
      }
    }
  }
  return false;
}

function seriesPlanFromPending(
  pending: Extract<NonNullable<MatchState["pendingAction"]>, { kind: "ATTACK" }>
): AttackSeriesPlan {
  return {
    seriesId: pending.attack.seriesId,
    actionOwnerId: pending.actionOwnerId,
    targetPlayerIds: [...pending.targetPlayerIds],
    sourceCardInstanceIds: [...pending.attack.sourceCardInstanceIds],
    sourceLearnedMiracleIds: [...pending.attack.sourceLearnedMiracleIds],
    sourceCardDefinitionIds: [...pending.attack.sourceCardDefinitionIds],
    element: pending.attack.element,
    power: pending.attack.power,
    hitRate: pending.hitRate,
    attackKind: pending.attack.attackKind,
    totalAttacks: pending.attack.totalAttacks,
    attackerGrantCount: pending.attackerGrantCount,
    completion: pending.completion
  };
}

function resolvePendingAttackDamage(
  context: EngineContext,
  pending: Extract<NonNullable<MatchState["pendingAction"]>, { kind: "ATTACK" }>,
  targetPlayerId: string,
  totalDefense: number
): number {
  const defender = context.state.players[targetPlayerId];
  if (!defender?.alive) return 0;
  const dangerousMortarTriggered =
    pending.attack.sourceCardDefinitionIds.includes(
      "dangerous-pestle"
    ) &&
    defender.hand.some(
      ({ cardDefinitionId }) =>
        cardDefinitionId === "dangerous-mortar"
    );
  const effectivePower = dangerousMortarTriggered
    ? 99
    : pending.attack.power;
  const residual = Math.max(0, effectivePower - totalDefense);
  const amount =
    pending.attack.element === "DARK" && residual > 0
      ? defender.hp
      : residual;
  emit(context, {
    type: "DAMAGE_APPLIED",
    attackId: pending.attack.attackId,
    playerId: targetPlayerId,
    amount,
    hpAfter: clampResource(defender.hp - amount)
  });
  resolveHpZero(
    context,
    targetPlayerId,
    pending.attack.actorId
  );
  maybeDepartGuardianAfterHpLoss(
    context,
    targetPlayerId,
    Math.min(amount, defender.hp)
  );
  if (amount > 0) {
    const sourceDefinitions = pending.attack.sourceCardDefinitionIds.map(
      (cardDefinitionId) => {
        const definition = CARD_DEFINITIONS_BY_ID.get(cardDefinitionId);
        if (!definition) {
          throw new Error(`Unknown attack source ${cardDefinitionId}`);
        }
        return definition;
      }
    );
    for (const definition of sourceDefinitions) {
      for (const instruction of instructionsOfKind(
        definition,
        "ADD_CALAMITY"
      )) {
        if (instruction.timing === "ON_DAMAGE") {
          applyCalamityEffect(
            context,
            targetPlayerId,
            instruction.calamity
          );
        }
      }
    }
    if (
      sourceDefinitions.some((definition) =>
        hasSpecialEffect(definition, "ABSORB_HP")
      )
    ) {
      const absorber = context.state.players[pending.attack.actorId];
      if (absorber?.alive) {
        emit(context, {
          type: "RESOURCE_CHANGED",
          playerId: absorber.playerId,
          resource: "HP",
          delta: amount,
          valueAfter: clampResource(absorber.hp + amount),
          reason: "ABSORPTION"
        });
      }
    }
    if (
      sourceDefinitions.some((definition) =>
        hasSpecialEffect(definition, "DEAL_SAME_DAMAGE")
      )
    ) {
      const owner = context.state.players[pending.actionOwnerId];
      if (owner?.alive) {
        const selfDamage = pending.attack.power;
        emit(context, {
          type: "RESOURCE_CHANGED",
          playerId: owner.playerId,
          resource: "HP",
          delta: -selfDamage,
          valueAfter: clampResource(owner.hp - selfDamage),
          reason: "SELF_DAMAGE"
        });
        resolveHpZero(context, owner.playerId);
        maybeDepartGuardianAfterHpLoss(
          context,
          owner.playerId,
          Math.min(selfDamage, owner.hp)
        );
      }
    }
  }
  return amount;
}

function applyCounterEffects(
  context: EngineContext,
  pending: Extract<NonNullable<MatchState["pendingAction"]>, { kind: "ATTACK" }>,
  defenderId: string,
  definitions: readonly CardDefinition[],
  receivedDamage: number
): void {
  if (receivedDamage <= 0) return;
  for (const definition of definitions) {
    const attacker = context.state.players[pending.attack.actorId];
    for (const instruction of instructionsOfKind(definition, "ATTACK")) {
      if (
        instruction.amount !== "DAMAGE" &&
        instruction.amount !== "DAMAGE_X2"
      ) continue;
      let hit = true;
      const hitRate =
        instructionsOfKind(definition, "HIT_RATE")[0]?.percent ?? 100;
      if (hitRate < 100) {
        const selection = drawWeighted(
          context.state.rng,
          [
            { key: "HIT", weight: hitRate, value: true },
            { key: "MISS", weight: 100 - hitRate, value: false }
          ],
          "HIT_CHECK",
          context.state.eventSequence + 1
        );
        hit = consumeSelection(context, selection);
      }
      if (hit && attacker?.alive) {
        const counterDamage =
          receivedDamage * (instruction.amount === "DAMAGE_X2" ? 2 : 1);
        emit(context, {
          type: "RESOURCE_CHANGED",
          playerId: attacker.playerId,
          resource: "HP",
          delta: -counterDamage,
          valueAfter: clampResource(attacker.hp - counterDamage),
          reason: "COUNTER"
        });
        resolveHpZero(context, attacker.playerId);
        maybeDepartGuardianAfterHpLoss(
          context,
          attacker.playerId,
          Math.min(counterDamage, attacker.hp)
        );
      }
    }
    for (const instruction of instructionsOfKind(
      definition,
      "ADD_CALAMITY"
    )) {
      if (instruction.timing === "COUNTER" && attacker?.alive) {
        applyCalamityEffect(
          context,
          attacker.playerId,
          instruction.calamity
        );
      }
    }
    for (const instruction of instructionsOfKind(
      definition,
      "COUNTER_BOOST_MP"
    )) {
      const defender = context.state.players[defenderId];
      if (defender?.alive) {
        const boost = receivedDamage * instruction.multiplier;
        emit(context, {
          type: "RESOURCE_CHANGED",
          playerId: defender.playerId,
          resource: "MP",
          delta: boost,
          valueAfter: clampResource(defender.mp + boost),
          reason: "COUNTER"
        });
      }
    }
    for (const instruction of instructionsOfKind(definition, "TAKE_MONEY")) {
      const currentAttacker = context.state.players[pending.attack.actorId];
      if (instruction.amount === "DAMAGE" && currentAttacker?.alive) {
        const taken = Math.min(currentAttacker.money, receivedDamage);
        emit(context, {
          type: "RESOURCE_CHANGED",
          playerId: currentAttacker.playerId,
          resource: "MONEY",
          delta: -taken,
          valueAfter: currentAttacker.money - taken,
          reason: "COUNTER"
        });
        const defender = context.state.players[defenderId];
        if (defender?.alive && taken > 0) {
          emit(context, {
            type: "RESOURCE_CHANGED",
            playerId: defender.playerId,
            resource: "MONEY",
            delta: taken,
            valueAfter: clampResource(defender.money + taken),
            reason: "COUNTER"
          });
        }
      }
    }
  }
}

function resolveDeferredTargetedCardEffect(
  context: EngineContext,
  pending: Extract<
    NonNullable<MatchState["pendingAction"]>,
    { kind: "ATTACK" }
  >
): void {
  const effect = pending.deferredTargetedCardEffect;
  if (!effect) return;
  const actionOwnerId = pending.actionOwnerId;
  const targetPlayerId = pending.attack.targetPlayerId;

  if (effect.kind === "DIRECT") {
    const definition = CARD_DEFINITIONS_BY_ID.get(effect.definitionId);
    if (!definition) {
      throw new Error(`Unknown deferred card definition ${effect.definitionId}`);
    }
    resolveDirectInstructions(
      context,
      actionOwnerId,
      targetPlayerId,
      definition
    );
    if (maybeEndMatch(context)) return;
  } else if (effect.kind === "SELL") {
    const product = getCard(
      context.state,
      actionOwnerId,
      effect.productCardInstanceId
    );
    if (!product) {
      throw new Error("Deferred sold artifact disappeared");
    }
    let hpLoss = 0;
    if (targetPlayerId !== actionOwnerId) {
      hpLoss = collectTradePayment(
        context,
        targetPlayerId,
        actionOwnerId,
        effect.price
      );
      transferTradeCard(
        context,
        actionOwnerId,
        targetPlayerId,
        product.instance
      );
    }
    emit(context, {
      type: "TRADE_RESOLVED",
      tradeId: effect.tradeId,
      actorId: actionOwnerId,
      targetPlayerId,
      offeredCardInstanceId: product.instance.instanceId,
      resolution: "ACCEPTED"
    });
    if (targetPlayerId !== actionOwnerId) {
      resolveHpZero(context, targetPlayerId);
      if (hpLoss > 0) {
        maybeDepartGuardianAfterHpLoss(
          context,
          targetPlayerId,
          hpLoss
        );
      }
      if (maybeEndMatch(context)) return;
    }
  } else {
    if (targetPlayerId === actionOwnerId) {
      completeAttack(
        context,
        actionOwnerId,
        pending.attackerGrantCount,
        pending.defenseGrantCounts,
        pending.revivalGrantCounts,
        pending.completion
      );
      return;
    }
    const target = context.state.players[targetPlayerId];
    const buyer = context.state.players[actionOwnerId];
    if (!target?.alive || !buyer?.alive || target.hand.length === 0) {
      completeAttack(
        context,
        actionOwnerId,
        pending.attackerGrantCount,
        pending.defenseGrantCounts,
        pending.revivalGrantCounts,
        pending.completion
      );
      return;
    }
    const offered = consumeSelection(
      context,
      drawWeighted(
        context.state.rng,
        target.hand.map((card) => ({
          key: card.instanceId,
          weight: 1,
          value: card
        })),
        "OTHER",
        context.state.eventSequence + 1
      )
    );
    const definition = CARD_DEFINITIONS_BY_ID.get(offered.cardDefinitionId);
    if (!definition) {
      throw new Error(`Unknown card definition ${offered.cardDefinitionId}`);
    }
    const price = definition.price ?? 0;
    const canAfford = canPayPrice(buyer, price);
    for (const [playerId, grantCount] of Object.entries(
      pending.defenseGrantCounts
    )) {
      for (let index = 0; index < grantCount; index += 1) {
        resolveNormalGrant(context, playerId, "DEFENSE_USED");
      }
    }
    emit(
      context,
      {
        type: "TRADE_OFFERED",
        tradeId: effect.tradeId,
        actorId: actionOwnerId,
        targetPlayerId,
        offeredCardInstanceId: offered.instanceId,
        price,
        canAfford,
        inputDeadlineAt: deadlineFor(
          context.state,
          actionOwnerId,
          context.occurredAt
        )
      },
      playerVisibility(actionOwnerId)
    );
    if (!canAfford) {
      emit(
        context,
        {
          type: "TRADE_RESOLVED",
          tradeId: effect.tradeId,
          actorId: actionOwnerId,
          targetPlayerId,
          offeredCardInstanceId: offered.instanceId,
          resolution: "INSUFFICIENT_RESOURCES"
        },
        playerVisibility(actionOwnerId)
      );
      resolveNormalGrant(context, actionOwnerId, "CARD_USED");
      finishTurn(context, actionOwnerId);
    }
    return;
  }

  completeAttack(
    context,
    actionOwnerId,
    pending.attackerGrantCount,
    pending.defenseGrantCounts,
    pending.revivalGrantCounts,
    pending.completion
  );
}

function advanceAfterAttackStep(
  context: EngineContext,
  resolvedPending: Extract<
    NonNullable<MatchState["pendingAction"]>,
    { kind: "ATTACK" }
  >
): void {
  if (resolvedPending.deferredTargetedCardEffect) {
    resolveDeferredTargetedCardEffect(context, resolvedPending);
    return;
  }
  const originalTargetPlayerId =
    resolvedPending.targetPlayerIds[resolvedPending.attack.targetIndex];
  const originalTargetStillAlive =
    originalTargetPlayerId !== undefined &&
    context.state.players[originalTargetPlayerId]?.alive === true;
  let nextTargetIndex = resolvedPending.attack.targetIndex;
  let nextAttackNumber = resolvedPending.attack.attackNumber + 1;
  if (
    !originalTargetStillAlive ||
    nextAttackNumber > resolvedPending.attack.totalAttacks
  ) {
    nextTargetIndex += 1;
    nextAttackNumber = 1;
  }
  if (nextTargetIndex < resolvedPending.attack.totalTargets) {
    const plan = seriesPlanFromPending(resolvedPending);
    if (
      startAttackSeriesStep(
        context,
        plan,
        nextTargetIndex,
        nextAttackNumber
      )
    ) {
      return;
    }
  }
  const completed = context.state.pendingAction;
  if (completed?.kind !== "ATTACK") {
    throw new Error("Attack state disappeared before grants");
  }
  completeAttack(
    context,
    completed.actionOwnerId,
    completed.attackerGrantCount,
    completed.defenseGrantCounts,
    completed.revivalGrantCounts,
    completed.completion
  );
}

const GUARDIAN_NAMES = [
  "火星神",
  "水星神",
  "木星神",
  "土星神",
  "天王神",
  "冥王神",
  "海王神",
  "金星神",
  "地球神",
  "月神"
] as const;

const DISEASE_ORDER: readonly Calamity[] = [
  "COLD",
  "FEVER",
  "HELL_SICKNESS",
  "HEAVEN_SICKNESS"
];

const GUARDIAN_ACTION_DEFINITIONS: readonly CardDefinition[] =
  STANDARD_CARD_DEFINITIONS.filter(
    (definition) => definition.category === "GUARDIAN_ACTION"
  );

const PHENOMENON_DEFINITIONS: readonly CardDefinition[] =
  STANDARD_CARD_DEFINITIONS.filter(
    (definition) => definition.category === "PHENOMENON"
  );

function currentDiseaseOf(player: PlayerState): Calamity | null {
  return (
    DISEASE_ORDER.findLast(
      (candidate) => player.calamities[candidate] === true
    ) ?? null
  );
}

function maybeDepartGuardianAfterHpLoss(
  context: EngineContext,
  playerId: string,
  hpLoss: number
): void {
  const guardian = context.state.players[playerId]?.guardian;
  if (!guardian || hpLoss <= 0) return;
  const selection = drawWeighted(
    context.state.rng,
    [
      { key: "DEPART", weight: 10, value: true },
      { key: "STAY", weight: 90, value: false }
    ],
    "GUARDIAN_DEPARTURE",
    context.state.eventSequence + 1
  );
  const departed = consumeSelection(context, selection);
  if (departed) {
    emit(context, {
      type: "GUARDIAN_DEPARTED",
      playerId,
      guardianId: guardian.guardianId,
      reason: "HOST_HP_LOSS"
    });
  }
}

function applyCalamityHpChange(
  context: EngineContext,
  playerId: string,
  delta: number
): void {
  const player = context.state.players[playerId];
  if (!player?.alive || delta === 0) return;
  const valueAfter = clampResource(player.hp + delta);
  emit(context, {
    type: "RESOURCE_CHANGED",
    playerId,
    resource: "HP",
    delta,
    valueAfter,
    reason: "CALAMITY"
  });
  if (valueAfter === 0) resolveHpZero(context, playerId);
  maybeDepartGuardianAfterHpLoss(
    context,
    playerId,
    Math.max(0, player.hp - valueAfter)
  );
}

function worsenDisease(
  context: EngineContext,
  playerId: string,
  disease: Calamity
): Calamity | null {
  const diseaseIndex = DISEASE_ORDER.indexOf(disease);
  const nextDisease = DISEASE_ORDER[diseaseIndex + 1] ?? null;
  emit(context, {
    type: "CALAMITY_WORSENED",
    playerId,
    from: disease,
    to: nextDisease
  });
  if (nextDisease === null) {
    const player = context.state.players[playerId];
    if (player?.alive) applyCalamityHpChange(context, playerId, -player.hp);
  }
  return nextDisease;
}

function applyCalamityEffect(
  context: EngineContext,
  playerId: string,
  calamity: Calamity
): void {
  const player = context.state.players[playerId];
  if (!player?.alive) return;
  if (!DISEASE_ORDER.includes(calamity)) {
    emit(context, { type: "CALAMITY_APPLIED", playerId, calamity });
    return;
  }
  const currentDisease = currentDiseaseOf(player);
  if (currentDisease === null) {
    emit(context, { type: "CALAMITY_APPLIED", playerId, calamity });
    return;
  }
  worsenDisease(context, playerId, currentDisease);
}

function resolveTurnEndDisease(
  context: EngineContext,
  playerId: string
): void {
  const player = context.state.players[playerId];
  if (!player?.alive) return;
  const disease = currentDiseaseOf(player);
  if (disease === null) return;
  const selection = drawWeighted(
    context.state.rng,
    [
      { key: "STABLE", weight: 95, value: false },
      { key: "WORSEN", weight: 5, value: true }
    ],
    "CALAMITY_WORSEN",
    context.state.eventSequence + 1
  );
  const worsened = consumeSelection(context, selection);
  emit(context, {
    type: "CALAMITY_WORSEN_CHECKED",
    playerId,
    disease,
    worsened
  });
  const effectiveDisease = worsened
    ? worsenDisease(context, playerId, disease)
    : disease;
  if (effectiveDisease === null) return;
  const hpDelta: Record<
    Extract<
      Calamity,
      "COLD" | "FEVER" | "HELL_SICKNESS" | "HEAVEN_SICKNESS"
    >,
    number
  > = {
    COLD: -1,
    FEVER: -2,
    HELL_SICKNESS: -5,
    HEAVEN_SICKNESS: 5
  };
  applyCalamityHpChange(
    context,
    playerId,
    hpDelta[
      effectiveDisease as keyof typeof hpDelta
    ]
  );
}

function removeCalamities(
  context: EngineContext,
  playerId: string,
  scope: "MILD" | "ALL"
): void {
  const player = context.state.players[playerId];
  if (!player) return;
  const mild: readonly Calamity[] = ["COLD", "FEVER", "FOG", "FLASH"];
  const calamities = (Object.keys(player.calamities) as Calamity[]).filter(
    (calamity) => scope === "ALL" || mild.includes(calamity)
  );
  if (calamities.length > 0) {
    emit(context, { type: "CALAMITIES_REMOVED", playerId, calamities });
  }
}

function assignRandomGuardian(
  context: EngineContext,
  playerId: string
): void {
  const occupiedNames = new Set(
    Object.values(context.state.players)
      .map(({ guardian }) => guardian?.guardianName)
      .filter((name) => name !== undefined)
  );
  const candidates = GUARDIAN_NAMES.filter((name) => !occupiedNames.has(name));
  if (candidates.length === 0) return;
  const selection = drawWeighted(
    context.state.rng,
    candidates.map((name) => ({ key: name, weight: 1, value: name })),
    "GUARDIAN_ASSIGNMENT",
    context.state.eventSequence + 1
  );
  const guardianName = consumeSelection(context, selection);
  emit(context, {
    type: "GUARDIAN_ASSIGNED",
    playerId,
    guardian: {
      guardianId: `${context.state.matchId}:guardian:${context.state.eventSequence + 1}`,
      guardianName
    }
  });
}

function alivePlayersInSeatOrder(state: MatchState): PlayerState[] {
  return Object.values(state.players)
    .filter(({ alive }) => alive)
    .sort((left, right) => left.seat - right.seat);
}

function selectRandomPlayerId(
  context: EngineContext,
  players: readonly PlayerState[],
  randomContext: "TARGET_SELECTION" | "MONEY_TARGET"
): string | null {
  if (players.length === 0) return null;
  const selection = drawWeighted(
    context.state.rng,
    players.map((player) => ({
      key: `${String(player.seat).padStart(2, "0")}:${player.playerId}`,
      weight: 1,
      value: player.playerId
    })),
    randomContext,
    context.state.eventSequence + 1
  );
  return consumeSelection(context, selection);
}

function removeRandomArtifacts(
  context: EngineContext,
  playerId: string,
  count: number,
  reason: "CARD_EFFECT" | "HAND_REDRAW"
): void {
  for (let index = 0; index < count; index += 1) {
    const hand = context.state.players[playerId]?.hand ?? [];
    if (hand.length === 0) return;
    const selected = consumeSelection(
      context,
      drawWeighted(
        context.state.rng,
        hand.map((card) => ({
          key: card.instanceId,
          weight: 1,
          value: card
        })),
        "CARD_REMOVAL",
        context.state.eventSequence + 1
      )
    );
    emit(
      context,
      {
        type: "ARTIFACT_REMOVED",
        playerId,
        cardInstanceId: selected.instanceId,
        cardDefinitionId: selected.cardDefinitionId,
        reason
      },
      playerVisibility(playerId)
    );
  }
}

function removeRandomLearnedMiracles(
  context: EngineContext,
  playerId: string,
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    const miracles =
      context.state.players[playerId]?.learnedMiracles ?? [];
    if (miracles.length === 0) return;
    const selected = consumeSelection(
      context,
      drawWeighted(
        context.state.rng,
        miracles.map((miracle) => ({
          key: miracle.learnedMiracleId,
          weight: 1,
          value: miracle
        })),
        "MIRACLE_REMOVAL",
        context.state.eventSequence + 1
      )
    );
    emit(
      context,
      {
        type: "LEARNED_MIRACLE_REMOVED",
        playerId,
        learnedMiracleId: selected.learnedMiracleId,
        cardDefinitionId: selected.cardDefinitionId
      },
      playerVisibility(playerId)
    );
  }
}

function redrawArtifactHand(
  context: EngineContext,
  playerId: string
): void {
  const cards = [
    ...(context.state.players[playerId]?.hand ?? [])
  ].sort((left, right) =>
    left.instanceId.localeCompare(right.instanceId)
  );
  for (const card of cards) {
    emit(
      context,
      {
        type: "ARTIFACT_REMOVED",
        playerId,
        cardInstanceId: card.instanceId,
        cardDefinitionId: card.cardDefinitionId,
        reason: "HAND_REDRAW"
      },
      playerVisibility(playerId)
    );
  }
  for (let index = 0; index < cards.length; index += 1) {
    resolveNormalGrant(context, playerId, "CARD_EFFECT");
  }
}

function shuffleArtifactsOfEverybody(context: EngineContext): void {
  const players = alivePlayersInSeatOrder(context.state);
  const counts = players.map((player) => ({
    playerId: player.playerId,
    count: player.hand.length
  }));
  const cards = players.flatMap((player) => player.hand);
  const shuffled = shuffleDeterministically(
    context.state.rng,
    cards.map((card) => ({
      key: card.instanceId,
      value: card
    })),
    "CARD_SHUFFLE",
    context.state.eventSequence + 1
  );
  context.state = {
    ...context.state,
    rng: shuffled.state,
    randomLog: [...context.state.randomLog, ...shuffled.audits]
  };
  const hands: Record<string, CardInstance[]> = {};
  let cursor = 0;
  for (const { playerId, count } of counts) {
    hands[playerId] = shuffled.values
      .slice(cursor, cursor + count)
      .map((card) => ({ ...card }));
    cursor += count;
  }
  emit(
    context,
    {
      type: "ARTIFACT_HANDS_SHUFFLED",
      hands
    },
    { scope: "SERVER" }
  );
}

function collectEverybodyMoney(context: EngineContext): void {
  const players = alivePlayersInSeatOrder(context.state);
  const recipientPlayerId = selectRandomPlayerId(
    context,
    players,
    "MONEY_TARGET"
  );
  if (!recipientPlayerId) return;
  const total = players.reduce((sum, player) => sum + player.money, 0);
  for (const player of players) {
    if (player.playerId === recipientPlayerId || player.money === 0) continue;
    emit(context, {
      type: "RESOURCE_CHANGED",
      playerId: player.playerId,
      resource: "MONEY",
      delta: -player.money,
      valueAfter: 0,
      reason: "PHENOMENON"
    });
  }
  const recipient = context.state.players[recipientPlayerId];
  if (!recipient) return;
  const valueAfter = clampResource(total);
  emit(context, {
    type: "RESOURCE_CHANGED",
    playerId: recipientPlayerId,
    resource: "MONEY",
    delta: valueAfter - recipient.money,
    valueAfter,
    reason: "PHENOMENON"
  });
}

function startConfusionActions(
  context: EngineContext,
  sourcePlayerId: string,
  sourceGrantCount: number
): void {
  const players = alivePlayersInSeatOrder(context.state);
  const actionSlots = Array.from({ length: 3 }, (_, roundIndex) =>
    players.map((player) => ({
      playerId: player.playerId,
      round: roundIndex + 1
    }))
  ).flat();
  emit(context, {
    type: "CONFUSION_ACTIONS_STARTED",
    sourcePlayerId,
    sourceGrantCount,
    actionSlots
  });
  continueConfusionActions(context);
}

type AutomaticActionCandidate =
  | {
      key: string;
      type: "ATTACK" | "DIRECT";
      source: ActionSource;
    }
  | {
      key: string;
      type: "DISCARD";
      card: CardInstance;
    }
  | { key: string; type: "PRAY" };

function automaticActionCandidates(
  state: MatchState,
  playerId: string
): AutomaticActionCandidate[] {
  const player = state.players[playerId];
  if (!player?.alive) return [];
  const candidates: AutomaticActionCandidate[] = [];
  for (const card of player.hand) {
    const definition = CARD_DEFINITIONS_BY_ID.get(card.cardDefinitionId);
    if (!definition) continue;
    const primaryAttack = instructionsOfKind(definition, "ATTACK")[0];
    if (
      primaryAttack &&
      !primaryAttack.additive &&
      (definition.mpCost ?? 0) <= player.mp
    ) {
      candidates.push({
        key: `ATTACK:CARD:${card.instanceId}`,
        type: "ATTACK",
        source: {
          definition,
          cardInstance: card,
          learnedMiracleId: null
        }
      });
    } else if (
      isSupportedDirectAction(definition) &&
      !hasSpecialEffect(definition, "CALL_PHENOMENON") &&
      (definition.mpCost ?? 0) <= player.mp
    ) {
      candidates.push({
        key: `DIRECT:CARD:${card.instanceId}`,
        type: "DIRECT",
        source: {
          definition,
          cardInstance: card,
          learnedMiracleId: null
        }
      });
    }
    if (
      definition.category !== "WEAPON" &&
      definition.cardDefinitionId !== "sun-amulet" &&
      definition.cardDefinitionId !== "dangerous-mortar"
    ) {
      candidates.push({
        key: `DISCARD:${card.instanceId}`,
        type: "DISCARD",
        card
      });
    }
  }
  for (const miracle of player.learnedMiracles) {
    const definition = CARD_DEFINITIONS_BY_ID.get(miracle.cardDefinitionId);
    if (!definition || (definition.mpCost ?? 0) > player.mp) continue;
    const source: ActionSource = {
      definition,
      cardInstance: null,
      learnedMiracleId: miracle.learnedMiracleId
    };
    const attack = instructionsOfKind(definition, "ATTACK")[0];
    if (attack && !attack.additive) {
      candidates.push({
        key: `ATTACK:MIRACLE:${miracle.learnedMiracleId}`,
        type: "ATTACK",
        source
      });
    } else if (
      isSupportedDirectAction(definition) &&
      !hasSpecialEffect(definition, "CALL_PHENOMENON")
    ) {
      candidates.push({
        key: `DIRECT:MIRACLE:${miracle.learnedMiracleId}`,
        type: "DIRECT",
        source
      });
    }
  }
  if (canPray(state, playerId)) {
    candidates.push({ key: "PRAY", type: "PRAY" });
  }
  return candidates;
}

function directEffectTargetsEnemy(definition: CardDefinition): boolean {
  return (
    instructionsOfKind(definition, "ADD_CALAMITY").some(
      ({ timing }) => timing === "IMMEDIATE"
    ) ||
    hasSpecialEffect(definition, "REMOVE_ITEMS") ||
    hasSpecialEffect(definition, "REMOVE_USED_MIRACLES")
  );
}

function commitAutomaticSource(
  context: EngineContext,
  playerId: string,
  source: ActionSource
): number {
  if (source.cardInstance && source.definition.category === "MIRACLE") {
    emit(context, {
      type: "MIRACLE_LEARNED",
      playerId,
      cardInstanceId: source.cardInstance.instanceId,
      miracle: {
        learnedMiracleId: `${source.cardInstance.instanceId}:learned`,
        cardDefinitionId: source.definition.cardDefinitionId
      }
    });
  } else if (source.cardInstance) {
    emit(context, {
      type: "CARD_CONSUMED",
      playerId,
      cardInstanceId: source.cardInstance.instanceId
    });
  } else if (source.learnedMiracleId) {
    emit(context, {
      type: "MIRACLE_CAST",
      playerId,
      learnedMiracleId: source.learnedMiracleId,
      cardDefinitionId: source.definition.cardDefinitionId
    });
  }
  const player = context.state.players[playerId];
  if (!player) return 0;
  const mpCost = hasSpecialEffect(source.definition, "CONSUME_ALL_MP")
    ? player.mp
    : (source.definition.mpCost ?? 0);
  if (mpCost > 0) {
    emit(context, {
      type: "MP_SPENT",
      playerId,
      amount: mpCost,
      mpAfter: player.mp - mpCost
    });
  }
  return source.cardInstance ? 1 : 0;
}

function completeConfusionAction(
  context: EngineContext,
  playerId: string,
  round: number
): void {
  if (context.state.phase === "MATCH_ENDED") return;
  emit(context, {
    type: "CONFUSION_ACTION_COMPLETED",
    playerId,
    round
  });
  continueConfusionActions(context);
}

function continueConfusionActions(context: EngineContext): void {
  while (context.state.phenomenonAutomatic) {
    const automatic = context.state.phenomenonAutomatic;
    const slot = automatic.actionSlots[automatic.nextActionIndex];
    if (!slot) {
      emit(context, {
        type: "CONFUSION_ACTIONS_COMPLETED",
        sourcePlayerId: automatic.sourcePlayerId
      });
      for (let index = 0; index < automatic.sourceGrantCount; index += 1) {
        resolveNormalGrant(
          context,
          automatic.sourcePlayerId,
          "CARD_USED"
        );
      }
      if (!maybeEndMatch(context)) {
        finishTurn(context, automatic.sourcePlayerId);
      }
      return;
    }
    const player = context.state.players[slot.playerId];
    if (!player?.alive) {
      emit(context, {
        type: "CONFUSION_ACTION_SELECTED",
        playerId: slot.playerId,
        round: slot.round,
        actionType: "PASS",
        sourceCardDefinitionId: null,
        targetPlayerId: null
      });
      emit(context, {
        type: "CONFUSION_ACTION_COMPLETED",
        playerId: slot.playerId,
        round: slot.round
      });
      continue;
    }
    emit(context, {
      type: "GF_COUNT_CHANGED",
      gfCount: context.state.gfCount + 1
    });
    const candidates = automaticActionCandidates(
      context.state,
      slot.playerId
    );
    if (candidates.length === 0) {
      emit(context, {
        type: "CONFUSION_ACTION_SELECTED",
        playerId: slot.playerId,
        round: slot.round,
        actionType: "PASS",
        sourceCardDefinitionId: null,
        targetPlayerId: null
      });
      emit(context, {
        type: "CONFUSION_ACTION_COMPLETED",
        playerId: slot.playerId,
        round: slot.round
      });
      continue;
    }
    const candidate = consumeSelection(
      context,
      drawWeighted(
        context.state.rng,
        candidates.map((value) => ({
          key: value.key,
          weight: 1,
          value
        })),
        "PHENOMENON_ACTION",
        context.state.eventSequence + 1
      )
    );
    if (candidate.type === "PRAY") {
      emit(context, {
        type: "CONFUSION_ACTION_SELECTED",
        playerId: slot.playerId,
        round: slot.round,
        actionType: "PRAY",
        sourceCardDefinitionId: null,
        targetPlayerId: slot.playerId
      });
      resolveNormalGrant(context, slot.playerId, "PRAY");
      emit(context, {
        type: "CONFUSION_ACTION_COMPLETED",
        playerId: slot.playerId,
        round: slot.round
      });
      continue;
    }
    if (candidate.type === "DISCARD") {
      emit(context, {
        type: "CONFUSION_ACTION_SELECTED",
        playerId: slot.playerId,
        round: slot.round,
        actionType: "DISCARD",
        sourceCardDefinitionId: candidate.card.cardDefinitionId,
        targetPlayerId: null
      });
      emit(context, {
        type: "CARD_CONSUMED",
        playerId: slot.playerId,
        cardInstanceId: candidate.card.instanceId
      });
      emit(context, {
        type: "CONFUSION_ACTION_COMPLETED",
        playerId: slot.playerId,
        round: slot.round
      });
      continue;
    }
    const actor = context.state.players[slot.playerId];
    if (!actor?.alive) continue;
    const needsEnemy =
      candidate.type === "ATTACK" ||
      directEffectTargetsEnemy(candidate.source.definition);
    const targets = needsEnemy
      ? alivePlayersInSeatOrder(context.state).filter((target) =>
          isEnemy(actor, target)
        )
      : [actor];
    const targetPlayerId = needsEnemy
      ? selectRandomPlayerId(context, targets, "TARGET_SELECTION")
      : actor.playerId;
    if (!targetPlayerId) {
      emit(context, {
        type: "CONFUSION_ACTION_SELECTED",
        playerId: slot.playerId,
        round: slot.round,
        actionType: "PASS",
        sourceCardDefinitionId:
          candidate.source.definition.cardDefinitionId,
        targetPlayerId: null
      });
      emit(context, {
        type: "CONFUSION_ACTION_COMPLETED",
        playerId: slot.playerId,
        round: slot.round
      });
      continue;
    }
    emit(context, {
      type: "CONFUSION_ACTION_SELECTED",
      playerId: slot.playerId,
      round: slot.round,
      actionType: candidate.type,
      sourceCardDefinitionId:
        candidate.source.definition.cardDefinitionId,
      targetPlayerId
    });
    const actorMpBefore = actor.mp;
    const grantCount = commitAutomaticSource(
      context,
      slot.playerId,
      candidate.source
    );
    if (candidate.type === "DIRECT") {
      resolveDirectInstructions(
        context,
        slot.playerId,
        targetPlayerId,
        candidate.source.definition
      );
      for (let index = 0; index < grantCount; index += 1) {
        resolveNormalGrant(context, slot.playerId, "CARD_USED");
      }
      if (maybeEndMatch(context)) return;
      emit(context, {
        type: "CONFUSION_ACTION_COMPLETED",
        playerId: slot.playerId,
        round: slot.round
      });
      continue;
    }
    const power = primaryAttackAmount(
      candidate.source.definition,
      actorMpBefore
    );
    if (power === null) {
      emit(context, {
        type: "CONFUSION_ACTION_COMPLETED",
        playerId: slot.playerId,
        round: slot.round
      });
      continue;
    }
    const plan: AttackSeriesPlan = {
      seriesId: `${context.state.matchId}:phenomenon-action:${context.state.eventSequence + 1}`,
      actionOwnerId: slot.playerId,
      targetPlayerIds: [targetPlayerId],
      sourceCardInstanceIds: candidate.source.cardInstance
        ? [candidate.source.cardInstance.instanceId]
        : [],
      sourceLearnedMiracleIds: candidate.source.learnedMiracleId
        ? [candidate.source.learnedMiracleId]
        : [],
      sourceCardDefinitionIds: [
        candidate.source.definition.cardDefinitionId
      ],
      element: candidate.source.definition.element,
      power,
      hitRate:
        instructionsOfKind(
          candidate.source.definition,
          "HIT_RATE"
        )[0]?.percent ?? 100,
      attackKind:
        candidate.source.definition.category === "MIRACLE"
          ? "MIRACLE"
          : "WEAPON",
      totalAttacks: 1,
      attackerGrantCount: grantCount,
      completion: "RESUME_PHENOMENON"
    };
    if (startAttackSeriesStep(context, plan, 0, 1)) return;
    completeAttack(
      context,
      slot.playerId,
      grantCount,
      {},
      {},
      "RESUME_PHENOMENON"
    );
    return;
  }
}

type PhenomenonResolution = "CONTINUE" | "OWNS_ACTION_COMPLETION";

function resolvePhenomenon(
  context: EngineContext,
  sourcePlayerId: string,
  sourceGrantCount: number
): PhenomenonResolution {
  const phenomenon = consumeSelection(
    context,
    drawWeighted(
      context.state.rng,
      PHENOMENON_DEFINITIONS.map((definition) => ({
        key: definition.cardDefinitionId,
        weight: 1,
        value: definition
      })),
      "PHENOMENON",
      context.state.eventSequence + 1
    )
  );
  emit(context, {
    type: "PHENOMENON_SELECTED",
    playerId: sourcePlayerId,
    phenomenonCardDefinitionId: phenomenon.cardDefinitionId
  });
  const players = alivePlayersInSeatOrder(context.state);
  for (const instruction of instructionsOfKind(
    phenomenon,
    "ADD_CALAMITY"
  )) {
    for (const player of players) {
      applyCalamityEffect(
        context,
        player.playerId,
        instruction.calamity
      );
    }
  }
  if (hasSpecialEffect(phenomenon, "SET_HP_OF_EVERYBODY")) {
    for (const player of players) {
      emit(context, {
        type: "RESOURCE_CHANGED",
        playerId: player.playerId,
        resource: "HP",
        delta: 1 - player.hp,
        valueAfter: 1,
        reason: "PHENOMENON"
      });
    }
  }
  for (const instruction of phenomenon.instructions) {
    if (instruction.kind !== "BOOST_HP") continue;
    for (const player of players) {
      const current = context.state.players[player.playerId];
      if (!current?.alive) continue;
      emit(context, {
        type: "RESOURCE_CHANGED",
        playerId: player.playerId,
        resource: "HP",
        delta: instruction.amount,
        valueAfter: clampResource(current.hp + instruction.amount),
        reason: "PHENOMENON"
      });
    }
  }
  if (
    hasSpecialEffect(phenomenon, "COLLECT_MONEY_OF_EVERYBODY")
  ) {
    collectEverybodyMoney(context);
  }
  if (
    hasSpecialEffect(phenomenon, "SHUFFLE_ITEMS_OF_EVERYBODY")
  ) {
    shuffleArtifactsOfEverybody(context);
  }
  if (
    hasSpecialEffect(phenomenon, "SET_GUARDIAN_OF_EVERYBODY")
  ) {
    for (const player of players) {
      assignRandomGuardian(context, player.playerId);
    }
  }
  if (hasSpecialEffect(phenomenon, "CONFUSE_EVERYBODY")) {
    startConfusionActions(
      context,
      sourcePlayerId,
      sourceGrantCount
    );
    return "OWNS_ACTION_COMPLETION";
  }
  const attackPower = primaryAttackAmount(
    phenomenon,
    context.state.players[sourcePlayerId]?.mp ?? 0
  );
  if (attackPower !== null) {
    const targetPlayerId = selectRandomPlayerId(
      context,
      alivePlayersInSeatOrder(context.state),
      "TARGET_SELECTION"
    );
    if (!targetPlayerId) return "CONTINUE";
    const plan: AttackSeriesPlan = {
      seriesId: `${context.state.matchId}:phenomenon:${context.state.eventSequence + 1}`,
      actionOwnerId: sourcePlayerId,
      targetPlayerIds: [targetPlayerId],
      sourceCardInstanceIds: [],
      sourceLearnedMiracleIds: [],
      sourceCardDefinitionIds: [phenomenon.cardDefinitionId],
      element: phenomenon.element,
      power: attackPower,
      hitRate:
        instructionsOfKind(phenomenon, "HIT_RATE")[0]?.percent ?? 100,
      attackKind: "PHENOMENON",
      totalAttacks: 1,
      attackerGrantCount: sourceGrantCount,
      completion: "FINISH_TURN"
    };
    if (!startAttackSeriesStep(context, plan, 0, 1)) {
      completeAttack(
        context,
        sourcePlayerId,
        sourceGrantCount,
        {},
        {},
        "FINISH_TURN"
      );
    }
    return "OWNS_ACTION_COMPLETION";
  }
  return "CONTINUE";
}

function guardianActionTargetPlayerId(
  definition: CardDefinition,
  guardianPlayerId: string,
  turnActorId: string
): string | null {
  if (definition.actionName === "小銭ばらまき") return null;
  if (
    instructionsOfKind(definition, "ATTACK").length > 0 ||
    instructionsOfKind(definition, "ADD_CALAMITY").length > 0 ||
    instructionsOfKind(definition, "TAKE_MONEY").length > 0 ||
    definition.actionName === "わいろ"
  ) {
    return turnActorId;
  }
  return guardianPlayerId;
}

function changeResourceByGuardian(
  context: EngineContext,
  playerId: string,
  resource: "HP" | "MP" | "MONEY",
  delta: number
): void {
  const player = context.state.players[playerId];
  if (!player?.alive) return;
  const current =
    resource === "HP"
      ? player.hp
      : resource === "MP"
        ? player.mp
        : player.money;
  emit(context, {
    type: "RESOURCE_CHANGED",
    playerId,
    resource,
    delta,
    valueAfter: clampResource(current + delta),
    reason: "GUARDIAN"
  });
}

function executeGuardianAction(
  context: EngineContext,
  guardianPlayerId: string,
  turnActorId: string,
  definition: CardDefinition
): boolean {
  const guardianPlayer = context.state.players[guardianPlayerId];
  const turnActor = context.state.players[turnActorId];
  if (!guardianPlayer?.alive) return false;
  const attackPower = primaryAttackAmount(definition, guardianPlayer.mp);
  if (attackPower !== null) {
    if (!turnActor?.alive) return false;
    const guardian = guardianPlayer.guardian;
    if (!guardian) return false;
    const plan: AttackSeriesPlan = {
      seriesId: `${guardian.guardianId}:automatic:${context.state.eventSequence + 1}`,
      actionOwnerId: guardianPlayerId,
      targetPlayerIds: [turnActorId],
      sourceCardInstanceIds: [],
      sourceLearnedMiracleIds: [],
      sourceCardDefinitionIds: [definition.cardDefinitionId],
      element: definition.element,
      power: attackPower,
      hitRate: instructionsOfKind(definition, "HIT_RATE")[0]?.percent ?? 100,
      attackKind: hasSpecialEffect(definition, "CATEGORY_WEAPON")
        ? "WEAPON"
        : "GUARDIAN",
      totalAttacks: 1,
      attackerGrantCount: 0,
      completion: "RESUME_POST_TURN"
    };
    return startAttackSeriesStep(context, plan, 0, 1);
  }

  for (const instruction of definition.instructions) {
    if (
      instruction.kind === "BOOST_HP" ||
      instruction.kind === "BOOST_MP" ||
      instruction.kind === "BOOST_MONEY"
    ) {
      const resource =
        instruction.kind === "BOOST_HP"
          ? "HP"
          : instruction.kind === "BOOST_MP"
            ? "MP"
            : "MONEY";
      if (definition.actionName === "小銭ばらまき") {
        for (const player of Object.values(context.state.players).sort(
          (left, right) => left.seat - right.seat
        )) {
          changeResourceByGuardian(
            context,
            player.playerId,
            resource,
            instruction.amount
          );
        }
      } else {
        const targetPlayerId =
          definition.actionName === "わいろ"
            ? turnActorId
            : guardianPlayerId;
        changeResourceByGuardian(
          context,
          targetPlayerId,
          resource,
          instruction.amount
        );
      }
    } else if (
      instruction.kind === "ADD_CALAMITY" &&
      instruction.timing === "IMMEDIATE"
    ) {
      applyCalamityEffect(context, turnActorId, instruction.calamity);
    } else if (instruction.kind === "REMOVE_CALAMITIES") {
      removeCalamities(context, guardianPlayerId, instruction.scope);
    } else if (
      instruction.kind === "TAKE_MONEY" &&
      typeof instruction.amount === "number"
    ) {
      const target = context.state.players[turnActorId];
      if (target?.alive) {
        const amount = Math.min(target.money, instruction.amount);
        changeResourceByGuardian(context, turnActorId, "MONEY", -amount);
      }
    } else if (
      instruction.kind === "SPECIAL" &&
      instruction.operation === "ADD_ITEM"
    ) {
      resolveNormalGrant(context, guardianPlayerId, "CARD_EFFECT");
    }
  }
  return false;
}

function continuePostTurnAutomaticEffects(context: EngineContext): void {
  while (context.state.postTurnAutomatic) {
    const automatic = context.state.postTurnAutomatic;
    const guardianPlayerId =
      automatic.guardianPlayerIds[automatic.nextGuardianIndex];
    if (guardianPlayerId !== undefined) {
      const guardianPlayer = context.state.players[guardianPlayerId];
      const guardian = guardianPlayer?.guardian;
      if (!guardianPlayer?.alive || !guardian) {
        emit(context, {
          type: "GUARDIAN_CHECKED",
          playerId: guardianPlayerId,
          acted: false
        });
        continue;
      }
      const checkSelection = drawWeighted(
        context.state.rng,
        [
          { key: "ACT", weight: 25, value: true },
          { key: "SKIP", weight: 75, value: false }
        ],
        "GUARDIAN_CHECK",
        context.state.eventSequence + 1
      );
      const acted = consumeSelection(context, checkSelection);
      emit(context, {
        type: "GUARDIAN_CHECKED",
        playerId: guardianPlayerId,
        acted
      });
      if (!acted) continue;

      const actions = GUARDIAN_ACTION_DEFINITIONS.filter(
        ({ guardianName }) => guardianName === guardian.guardianName
      );
      if (actions.length === 0) continue;
      const actionSelection = drawWeighted(
        context.state.rng,
        actions.map((definition) => ({
          key: definition.cardDefinitionId,
          weight: definition.actionWeight ?? 1,
          value: definition
        })),
        "GUARDIAN_ACTION",
        context.state.eventSequence + 1
      );
      const definition = consumeSelection(context, actionSelection);
      emit(context, {
        type: "GUARDIAN_ACTION_SELECTED",
        playerId: guardianPlayerId,
        guardianId: guardian.guardianId,
        actionCardDefinitionId: definition.cardDefinitionId,
        targetPlayerId: guardianActionTargetPlayerId(
          definition,
          guardianPlayerId,
          automatic.turnActorId
        )
      });
      if (
        executeGuardianAction(
          context,
          guardianPlayerId,
          automatic.turnActorId,
          definition
        )
      ) {
        return;
      }
      continue;
    }

    const turnActorId = automatic.turnActorId;
    resolveTurnEndDisease(context, turnActorId);
    emit(context, {
      type: "POST_TURN_AUTOMATIC_EFFECTS_COMPLETED",
      turnActorId
    });
    openNextTurnOrEnd(context);
    return;
  }
}

export function isSupportedDirectAction(definition: CardDefinition): boolean {
  if (definition.category !== "MIRACLE" && definition.category !== "GOODS") {
    return false;
  }
  const hasDirectEffect = definition.instructions.some(
    (instruction) =>
      instruction.kind === "BOOST_HP" ||
      instruction.kind === "BOOST_MP" ||
      instruction.kind === "BOOST_MONEY" ||
      instruction.kind === "REMOVE_CALAMITIES" ||
      (instruction.kind === "ADD_CALAMITY" &&
        (instruction.timing === "IMMEDIATE" || instruction.timing === "SELF")) ||
      (instruction.kind === "DEAL_DAMAGE" &&
        definition.cardDefinitionId === "thump-thump-tear") ||
      (instruction.kind === "SPECIAL" &&
        [
          "SET_GUARDIAN",
          "REMOVE_ITEMS",
          "REMOVE_USED_MIRACLES",
          "CALL_PHENOMENON"
        ].includes(instruction.operation))
  );
  return (
    hasDirectEffect &&
    definition.instructions.every(
      (instruction) =>
        instruction.kind === "BOOST_HP" ||
        instruction.kind === "BOOST_MP" ||
        instruction.kind === "BOOST_MONEY" ||
        instruction.kind === "REMOVE_CALAMITIES" ||
        (instruction.kind === "ADD_CALAMITY" &&
          (instruction.timing === "IMMEDIATE" || instruction.timing === "SELF")) ||
        (instruction.kind === "DEAL_DAMAGE" &&
          definition.cardDefinitionId === "thump-thump-tear") ||
        (instruction.kind === "SPECIAL" &&
          [
            "SET_GUARDIAN",
            "REMOVE_ITEMS",
            "REMOVE_USED_MIRACLES",
            "CALL_PHENOMENON"
          ].includes(instruction.operation))
    )
  );
}

function resolveDirectInstructions(
  context: EngineContext,
  actorPlayerId: string,
  targetPlayerId: string,
  definition: CardDefinition
): void {
  let instructions = definition.instructions;
  if (definition.cardDefinitionId === "thump-thump-tear") {
    const outcome = consumeSelection(
      context,
      drawWeighted(
        context.state.rng,
        definition.instructions.map((instruction) => ({
          key: instruction.kind,
          weight: 1,
          value: instruction
        })),
        "OTHER",
        context.state.eventSequence + 1
      )
    );
    instructions = [outcome];
  }

  for (const instruction of instructions) {
    if (
      instruction.kind === "BOOST_HP" ||
      instruction.kind === "BOOST_MP" ||
      instruction.kind === "BOOST_MONEY"
    ) {
      const player = context.state.players[actorPlayerId];
      if (!player) continue;
      const resource =
        instruction.kind === "BOOST_HP"
          ? "HP"
          : instruction.kind === "BOOST_MP"
            ? "MP"
            : "MONEY";
      const current =
        resource === "HP"
          ? player.hp
          : resource === "MP"
            ? player.mp
            : player.money;
      emit(context, {
        type: "RESOURCE_CHANGED",
        playerId: actorPlayerId,
        resource,
        delta: instruction.amount,
        valueAfter: clampResource(current + instruction.amount),
        reason:
          definition.category === "MIRACLE"
            ? "MIRACLE"
            : "CARD_EFFECT"
      });
    } else if (
      instruction.kind === "ADD_CALAMITY" &&
      (instruction.timing === "IMMEDIATE" ||
        instruction.timing === "SELF")
    ) {
      applyCalamityEffect(
        context,
        instruction.timing === "IMMEDIATE"
          ? targetPlayerId
          : actorPlayerId,
        instruction.calamity
      );
    } else if (instruction.kind === "REMOVE_CALAMITIES") {
      removeCalamities(
        context,
        actorPlayerId,
        instruction.scope
      );
    } else if (instruction.kind === "DEAL_DAMAGE") {
      const current = context.state.players[actorPlayerId];
      if (!current?.alive) continue;
      const hpLoss = Math.min(current.hp, instruction.amount);
      emit(context, {
        type: "RESOURCE_CHANGED",
        playerId: actorPlayerId,
        resource: "HP",
        delta: -hpLoss,
        valueAfter: clampResource(current.hp - instruction.amount),
        reason: "CARD_EFFECT"
      });
      resolveHpZero(context, actorPlayerId);
      maybeDepartGuardianAfterHpLoss(
        context,
        actorPlayerId,
        hpLoss
      );
    }
  }
  if (hasSpecialEffect(definition, "SET_GUARDIAN")) {
    assignRandomGuardian(context, actorPlayerId);
  }
  if (hasSpecialEffect(definition, "REMOVE_ITEMS")) {
    removeRandomArtifacts(
      context,
      targetPlayerId,
      3,
      "CARD_EFFECT"
    );
  }
  if (hasSpecialEffect(definition, "REMOVE_USED_MIRACLES")) {
    removeRandomLearnedMiracles(context, targetPlayerId, 2);
  }
}

function handleDirectAction(
  context: EngineContext,
  command: Extract<GameCommand, { type: "DECLARE_ACTION" }>,
  actor: PlayerState,
  sources: readonly ActionSource[]
): CommandFailure | null {
  const directSources = sources.filter(({ definition }) =>
    isSupportedDirectAction(definition)
  );
  const costCutters = sources.filter(({ definition }) =>
    hasSpecialEffect(definition, "CUT_COST")
  );
  if (
    directSources.length !== 1 ||
    !directSources[0] ||
    costCutters.length > 1 ||
    directSources.length + costCutters.length !== sources.length ||
    (costCutters.length > 0 &&
      directSources[0].definition.category !== "MIRACLE")
  ) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "Select one supported direct-use card and an optional miracle cost cutter"
    );
  }
  const source = directSources[0];
  const definition = source.definition;
  const mpCost =
    costCutters.length > 0
      ? 0
      : hasSpecialEffect(definition, "CONSUME_ALL_MP")
        ? actor.mp
        : (definition.mpCost ?? 0);
  if (mpCost > actor.mp) {
    return fail(context.state, "INSUFFICIENT_MP", "Not enough MP for this miracle");
  }
  const targetsEnemy = directEffectTargetsEnemy(definition);
  const target = targetsEnemy
    ? context.state.players[command.targetPlayerId]
    : actor;
  if (
    !target ||
    (targetsEnemy && !isEnemy(actor, target)) ||
    (!targetsEnemy && command.targetPlayerId !== actor.playerId)
  ) {
    return fail(context.state, "INVALID_TARGET", "Direct-use target is not legal");
  }

  emit(context, {
    type: "ACTION_DECLARED",
    playerId: actor.playerId,
    actionType: command.type,
    targetPlayerId: targetsEnemy ? target.playerId : actor.playerId,
    actionCardDefinitionIds: sources.map(
      ({ definition }) => definition.cardDefinitionId
    )
  });
  for (const actionSource of sources) {
    if (
      actionSource.cardInstance &&
      actionSource.definition.category === "MIRACLE"
    ) {
      emit(context, {
        type: "MIRACLE_LEARNED",
        playerId: actor.playerId,
        cardInstanceId: actionSource.cardInstance.instanceId,
        miracle: {
          learnedMiracleId: `${actionSource.cardInstance.instanceId}:learned`,
          cardDefinitionId: actionSource.definition.cardDefinitionId
        }
      });
    } else if (actionSource.cardInstance) {
      emit(context, {
        type: "CARD_CONSUMED",
        playerId: actor.playerId,
        cardInstanceId: actionSource.cardInstance.instanceId
      });
    } else if (actionSource.learnedMiracleId) {
      emit(context, {
        type: "MIRACLE_CAST",
        playerId: actor.playerId,
        learnedMiracleId: actionSource.learnedMiracleId,
        cardDefinitionId: actionSource.definition.cardDefinitionId
      });
    }
  }
  if (mpCost > 0) {
    emit(context, {
      type: "MP_SPENT",
      playerId: actor.playerId,
      amount: mpCost,
      mpAfter: actor.mp - mpCost
    });
  }

  if (targetsEnemy) {
    startTargetedCardReaction(context, {
      seriesId: command.commandId,
      actionOwnerId: actor.playerId,
      targetPlayerId: target.playerId,
      sourceCardInstanceIds: sources.flatMap(({ cardInstance }) =>
        cardInstance ? [cardInstance.instanceId] : []
      ),
      sourceLearnedMiracleIds: sources.flatMap(({ learnedMiracleId }) =>
        learnedMiracleId ? [learnedMiracleId] : []
      ),
      sourceCardDefinitionIds: sources.map(
        ({ definition: sourceDefinition }) =>
          sourceDefinition.cardDefinitionId
      ),
      attackerGrantCount: sources.filter(
        ({ cardInstance }) => cardInstance !== null
      ).length,
      deferredTargetedCardEffect: {
        kind: "DIRECT",
        definitionId: definition.cardDefinitionId
      }
    });
    return null;
  }

  resolveDirectInstructions(
    context,
    actor.playerId,
    target.playerId,
    definition
  );
  if (hasSpecialEffect(definition, "CALL_PHENOMENON")) {
    const completion = resolvePhenomenon(
      context,
      actor.playerId,
      sources.filter(({ cardInstance }) => cardInstance !== null)
        .length
    );
    if (completion === "OWNS_ACTION_COMPLETION") return null;
  }
  if (maybeEndMatch(context)) return null;
  for (const actionSource of sources) {
    if (actionSource.cardInstance) {
      resolveNormalGrant(context, actor.playerId, "CARD_USED");
    }
  }
  finishTurn(context, actor.playerId);
  return null;
}

function handleDeclareAction(
  context: EngineContext,
  command: Extract<GameCommand, { type: "DECLARE_ACTION" }>
): CommandFailure | null {
  const phaseError = requireActiveActionPhase(context.state, command.actorId);
  if (phaseError) return phaseError;
  const learnedMiracleIds = command.learnedMiracleIds ?? [];
  if (
    command.cardInstanceIds.length + learnedMiracleIds.length === 0 ||
    new Set(command.cardInstanceIds).size !== command.cardInstanceIds.length ||
    new Set(learnedMiracleIds).size !== learnedMiracleIds.length
  ) {
    return fail(context.state, "INVALID_CARD_SELECTION", "Select unique action sources");
  }
  const actor = context.state.players[command.actorId];
  if (!actor) {
    return fail(context.state, "INVALID_ACTOR", "Actor does not exist");
  }

  const selectedCards = command.cardInstanceIds.map((instanceId) =>
    getCard(context.state, command.actorId, instanceId)
  );
  if (selectedCards.some((card) => card === null)) {
    return fail(context.state, "CARD_NOT_FOUND", "A selected card is not in the actor hand");
  }
  const learnedMiracles = learnedMiracleIds.map((learnedMiracleId) =>
    actor.learnedMiracles.find(
      (miracle) => miracle.learnedMiracleId === learnedMiracleId
    )
  );
  if (learnedMiracles.some((miracle) => miracle === undefined)) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "A selected learned miracle does not exist"
    );
  }

  const sources: ActionSource[] = [
    ...selectedCards
      .filter((card) => card !== null)
      .map(({ instance, definition }) => ({
        definition,
        cardInstance: instance,
        learnedMiracleId: null
      })),
    ...learnedMiracles
      .filter((miracle) => miracle !== undefined)
      .map((miracle) => {
        const definition = CARD_DEFINITIONS_BY_ID.get(miracle.cardDefinitionId);
        if (!definition) {
          throw new Error(`Unknown miracle definition ${miracle.cardDefinitionId}`);
        }
        return {
          definition,
          cardInstance: null,
          learnedMiracleId: miracle.learnedMiracleId
        };
      })
  ];
  if (
    !sources.some(
      ({ definition }) =>
        instructionsOfKind(definition, "ATTACK").length > 0
    )
  ) {
    return handleDirectAction(context, command, actor, sources);
  }
  if (
    sources.some(
      ({ definition, learnedMiracleId }) =>
        (!["WEAPON", "MIRACLE"].includes(definition.category) &&
          !(
            definition.category === "GOODS" &&
            (instructionsOfKind(definition, "ATTACK").some(
              ({ additive }) => additive
            ) ||
              hasSpecialEffect(definition, "CUT_COST"))
          )) ||
        (learnedMiracleId !== null && definition.category !== "MIRACLE")
    )
  ) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "Only attack sources and supported goods can compose an attack"
    );
  }
  const target = context.state.players[command.targetPlayerId];
  if (!target || !isEnemy(actor, target)) {
    return fail(context.state, "INVALID_TARGET", "Target must be a living enemy");
  }
  const attacks = sources.map(({ definition }) =>
    instructionsOfKind(definition, "ATTACK")[0]
  );
  if (
    sources.some(
      ({ definition }, index) =>
        !attacks[index] &&
        !hasSpecialEffect(definition, "ATTACK_EVERY_ENEMY") &&
        !hasSpecialEffect(definition, "DOUBLE_ATTACK") &&
        !hasSpecialEffect(definition, "CUT_COST")
    )
  ) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "A selected source cannot compose this attack"
    );
  }
  const primaryCount = attacks.filter((attack) => attack && !attack.additive).length;
  if (primaryCount !== 1) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "Select exactly one primary attack and zero or more additive attacks"
    );
  }
  const primarySource = sources.find(({ definition }) => {
    const attack = instructionsOfKind(definition, "ATTACK")[0];
    return attack && !attack.additive;
  });
  if (!primarySource) {
    return fail(context.state, "INVALID_CARD_SELECTION", "Primary attack is missing");
  }

  let power = 0;
  for (const { definition } of sources) {
    const amount = attackSourceAmount(definition, actor.mp);
    if (
      amount === null &&
      !hasSpecialEffect(definition, "ATTACK_EVERY_ENEMY") &&
      !hasSpecialEffect(definition, "DOUBLE_ATTACK") &&
      !hasSpecialEffect(definition, "CUT_COST")
    ) {
      return fail(context.state, "INVALID_CARD_SELECTION", "Unsupported attack expression");
    }
    power += amount ?? 0;
  }
  if (sources.some(({ definition }) => hasSpecialEffect(definition, "DOUBLE_ATTACK"))) {
    power *= 2;
  }
  const miracleSources = sources.filter(
    ({ definition }) => definition.category === "MIRACLE"
  );
  const ignoresMiracleCost = sources.some(({ definition }) =>
    hasSpecialEffect(definition, "CUT_COST")
  );
  const consumesAllMp = sources.some(({ definition }) =>
    hasSpecialEffect(definition, "CONSUME_ALL_MP")
  );
  const mpCost = ignoresMiracleCost
    ? 0
    : consumesAllMp
      ? actor.mp
      : miracleSources.reduce(
          (total, { definition }) =>
            total + (definition.mpCost ?? 0),
          0
        );
  if (mpCost > actor.mp) {
    return fail(context.state, "INSUFFICIENT_MP", "Not enough MP for selected miracles");
  }
  const paintedElement = sources
    .flatMap(({ definition }) =>
      instructionsOfKind(definition, "SET_ELEMENT")
    )
    .at(-1)?.element;
  const element =
    paintedElement ??
    combineElements(
      sources.map(({ definition }) => definition.element)
    );
  const hitRate =
    sources
      .flatMap(({ definition }) => instructionsOfKind(definition, "HIT_RATE"))
      .at(0)?.percent ?? 100;
  const totalAttacks = sources.some(({ definition }) =>
    hasSpecialEffect(definition, "ATTACK_TWICE")
  )
    ? 2
    : 1;
  const enemyCandidates = Object.values(context.state.players)
    .filter((candidate) => isEnemy(actor, candidate))
    .sort((left, right) => left.seat - right.seat);
  const attacksEveryEnemy =
    sources.some(
      ({ definition }) =>
        instructionsOfKind(definition, "HIT_RATE").length > 0 ||
        hasSpecialEffect(definition, "ATTACK_EVERY_ENEMY")
    );
  let targetPlayerIds: string[];
  if (attacksEveryEnemy) {
    const shuffledTargets = shuffleDeterministically(
      context.state.rng,
      enemyCandidates.map((candidate) => ({
        key: `${String(candidate.seat).padStart(2, "0")}:${candidate.playerId}`,
        value: candidate.playerId
      })),
      "TARGET_SELECTION",
      context.state.eventSequence + 1
    );
    context.state = {
      ...context.state,
      rng: shuffledTargets.state,
      randomLog: [...context.state.randomLog, ...shuffledTargets.audits]
    };
    targetPlayerIds = shuffledTargets.values;
  } else if (actor.calamities.FOG) {
    const randomTarget = drawWeighted(
      context.state.rng,
      enemyCandidates.map((candidate) => ({
        key: `${String(candidate.seat).padStart(2, "0")}:${candidate.playerId}`,
        weight: 1,
        value: candidate.playerId
      })),
      "TARGET_SELECTION",
      context.state.eventSequence + 1
    );
    targetPlayerIds = [consumeSelection(context, randomTarget)];
  } else {
    targetPlayerIds = [command.targetPlayerId];
  }

  emit(context, {
    type: "ACTION_DECLARED",
    playerId: command.actorId,
    actionType: command.type,
    targetPlayerId: targetPlayerIds[0] ?? command.targetPlayerId,
    actionCardDefinitionIds: sources.map(
      ({ definition }) => definition.cardDefinitionId
    )
  });
  for (const source of sources) {
    if (source.cardInstance && source.definition.category === "MIRACLE") {
      emit(context, {
        type: "MIRACLE_LEARNED",
        playerId: command.actorId,
        cardInstanceId: source.cardInstance.instanceId,
        miracle: {
          learnedMiracleId: `${source.cardInstance.instanceId}:learned`,
          cardDefinitionId: source.definition.cardDefinitionId
        }
      });
    } else if (source.cardInstance) {
      emit(context, {
        type: "CARD_CONSUMED",
        playerId: command.actorId,
        cardInstanceId: source.cardInstance.instanceId
      });
    } else if (source.learnedMiracleId) {
      emit(context, {
        type: "MIRACLE_CAST",
        playerId: command.actorId,
        learnedMiracleId: source.learnedMiracleId,
        cardDefinitionId: source.definition.cardDefinitionId
      });
    }
  }
  if (mpCost > 0) {
    emit(context, {
      type: "MP_SPENT",
      playerId: command.actorId,
      amount: mpCost,
      mpAfter: actor.mp - mpCost
    });
  }
  const plan: AttackSeriesPlan = {
    seriesId: command.commandId,
    actionOwnerId: command.actorId,
    targetPlayerIds,
    sourceCardInstanceIds: [...command.cardInstanceIds],
    sourceLearnedMiracleIds: [...learnedMiracleIds],
    sourceCardDefinitionIds: sources.map(
      ({ definition }) => definition.cardDefinitionId
    ),
    element,
    power,
    hitRate,
    attackKind:
      primarySource.definition.category === "MIRACLE" ? "MIRACLE" : "WEAPON",
    totalAttacks,
    attackerGrantCount: selectedCards.length,
    completion: "FINISH_TURN"
  };
  if (!startAttackSeriesStep(context, plan, 0, 1)) {
    completeAttack(
      context,
      command.actorId,
      plan.attackerGrantCount,
      {},
      {},
      plan.completion
    );
  }
  return null;
}

function handleReaction(
  context: EngineContext,
  command: Extract<GameCommand, { type: "DECLARE_REACTION" }>
): CommandFailure | null {
  if (context.state.phase !== "REACTION_SELECTION") {
    return fail(context.state, "INVALID_PHASE", "The match is not accepting a reaction");
  }
  const pending = context.state.pendingAction;
  if (
    pending?.kind !== "ATTACK" ||
    pending.attack.reactionId !== command.reactionId ||
    pending.attack.targetPlayerId !== command.actorId
  ) {
    return fail(context.state, "INVALID_REACTION", "Reaction does not match pending attack");
  }
  if (
    new Set(command.defenseCardInstanceIds).size !==
    command.defenseCardInstanceIds.length
  ) {
    return fail(context.state, "INVALID_CARD_SELECTION", "Defense cards must be unique");
  }
  const defenseLearnedMiracleIds = command.defenseLearnedMiracleIds ?? [];
  if (
    new Set(defenseLearnedMiracleIds).size !==
    defenseLearnedMiracleIds.length
  ) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "Defense miracles must be unique"
    );
  }
  const selected = command.defenseCardInstanceIds.map((instanceId) =>
    getCard(context.state, command.actorId, instanceId)
  );
  if (selected.some((card) => card === null)) {
    return fail(context.state, "CARD_NOT_FOUND", "A defense card is not in hand");
  }
  const cards = selected.filter((card) => card !== null);
  if (
    context.state.players[command.actorId]?.calamities.FLASH &&
    cards.length > 1
  ) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "Flash limits defense to one card"
    );
  }
  const defenderBefore = context.state.players[command.actorId];
  if (!defenderBefore) {
    return fail(context.state, "INVALID_ACTOR", "Defender does not exist");
  }
  const learnedMiracles = defenseLearnedMiracleIds.map((learnedMiracleId) =>
    defenderBefore.learnedMiracles.find(
      (miracle) => miracle.learnedMiracleId === learnedMiracleId
    )
  );
  if (learnedMiracles.some((miracle) => miracle === undefined)) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "A selected defense miracle does not exist"
    );
  }
  const learnedDefinitions = learnedMiracles
    .filter((miracle) => miracle !== undefined)
    .map((miracle) => {
      const definition = CARD_DEFINITIONS_BY_ID.get(miracle.cardDefinitionId);
      if (!definition) {
        throw new Error(`Unknown miracle definition ${miracle.cardDefinitionId}`);
      }
      return { miracle, definition };
    });
  const reactionDefinitions = [
    ...cards.map(({ definition }) => definition),
    ...learnedDefinitions.map(({ definition }) => definition)
  ];
  const filtersAttackElement = reactionDefinitions.some((definition) =>
    hasSpecialEffect(definition, "FILTER_ATTACK_ELEMENT")
  );
  const effectiveAttackElement = filtersAttackElement
    ? "PHYSICAL"
    : pending.attack.element;
  let totalDefense = 0;
  for (const { definition } of cards) {
    const defense = instructionsOfKind(definition, "DEFENSE")[0];
    const reactionEffect = reactionEffectFor(
      definition,
      pending.attack.attackKind,
      effectiveAttackElement
    );
    if (
      pending.attack.attackKind === "TARGETED_CARD" &&
      reactionEffect !== "REFLECT"
    ) {
      return fail(
        context.state,
        "INVALID_CARD_SELECTION",
        "Only an anything-reflection card can react to a non-attack card"
      );
    }
    const canDefend =
      defense && canDefenseBlock(definition.element, effectiveAttackElement);
    if (
      !canDefend &&
      !reactionEffect &&
      !hasCounterOrFilterEffect(definition)
    ) {
      return fail(
        context.state,
        "INVALID_CARD_SELECTION",
        "A selected card cannot defend this attack"
      );
    }
    if (canDefend) totalDefense += defense.amount;
  }
  for (const { definition } of learnedDefinitions) {
    const reactionEffect = reactionEffectFor(
      definition,
      pending.attack.attackKind,
      effectiveAttackElement
    );
    if (
      (pending.attack.attackKind === "TARGETED_CARD" &&
        reactionEffect !== "REFLECT") ||
      (pending.attack.attackKind !== "TARGETED_CARD" &&
        !reactionEffect &&
        !hasCounterOrFilterEffect(definition))
    ) {
      return fail(
        context.state,
        "INVALID_CARD_SELECTION",
        "A selected learned miracle cannot react to this attack"
      );
    }
  }
  const specialEffects = [
    ...cards.map(({ definition }) =>
      reactionEffectFor(
        definition,
        pending.attack.attackKind,
        effectiveAttackElement
      )
    ),
    ...learnedDefinitions.map(({ definition }) =>
      reactionEffectFor(
        definition,
        pending.attack.attackKind,
        effectiveAttackElement
      )
    )
  ].filter((effect): effect is ReactionEffect => effect !== null);
  if (specialEffects.length > 1) {
    return fail(
      context.state,
      "INVALID_CARD_SELECTION",
      "Select at most one stop, reflection, or bounce effect"
    );
  }
  const ignoresMiracleCost = reactionDefinitions.some((definition) =>
    hasSpecialEffect(definition, "CUT_COST")
  );
  const reactionMiracleCost = ignoresMiracleCost
    ? 0
    : reactionDefinitions.reduce(
        (total, definition) =>
          total +
          (definition.category === "MIRACLE" ? definition.mpCost ?? 0 : 0),
        0
      );
  if (reactionMiracleCost > defenderBefore.mp) {
    return fail(
      context.state,
      "INSUFFICIENT_MP",
      "Not enough MP for selected defense miracles"
    );
  }
  emit(context, {
    type: "REACTION_DECLARED",
    reactionId: command.reactionId,
    playerId: command.actorId,
    defenseCardInstanceIds: [...command.defenseCardInstanceIds],
    defenseLearnedMiracleIds: [...defenseLearnedMiracleIds],
    defenseCardDefinitionIds: cards.map(
      ({ definition }) => definition.cardDefinitionId
    ),
    defenseLearnedMiracleDefinitionIds: learnedDefinitions.map(
      ({ definition }) => definition.cardDefinitionId
    ),
    defensePower: totalDefense
  });
  if (filtersAttackElement && pending.attack.element !== "PHYSICAL") {
    emit(context, {
      type: "ATTACK_ELEMENT_FILTERED",
      attackId: pending.attack.attackId,
      element: "PHYSICAL"
    });
  }
  for (const { instance, definition } of cards) {
    if (definition.category === "MIRACLE") {
      emit(context, {
        type: "MIRACLE_LEARNED",
        playerId: command.actorId,
        cardInstanceId: instance.instanceId,
        miracle: {
          learnedMiracleId: `${instance.instanceId}:learned`,
          cardDefinitionId: definition.cardDefinitionId
        }
      });
    } else {
      emit(context, {
        type: "DEFENSE_COMMITTED",
        playerId: command.actorId,
        cardInstanceId: instance.instanceId
      });
    }
  }
  for (const { definition } of cards) {
    for (const instruction of instructionsOfKind(
      definition,
      "ADD_CALAMITY"
    )) {
      if (instruction.timing === "SELF") {
        applyCalamityEffect(
          context,
          command.actorId,
          instruction.calamity
        );
      }
    }
    if (hasSpecialEffect(definition, "REDRAW_HAND")) {
      redrawArtifactHand(context, command.actorId);
    }
  }
  for (const { miracle, definition } of learnedDefinitions) {
    emit(context, {
      type: "MIRACLE_CAST",
      playerId: command.actorId,
      learnedMiracleId: miracle.learnedMiracleId,
      cardDefinitionId: definition.cardDefinitionId
    });
  }
  if (reactionMiracleCost > 0) {
    emit(context, {
      type: "MP_SPENT",
      playerId: command.actorId,
      amount: reactionMiracleCost,
      mpAfter: defenderBefore.mp - reactionMiracleCost
    });
  }

  const effect = specialEffects[0] ?? null;
  const committedPending = context.state.pendingAction;
  if (committedPending?.kind !== "ATTACK") {
    throw new Error("Attack state disappeared during reaction");
  }
  if (effect === "BLOCK") {
    emit(context, {
      type: "ATTACK_STOPPED",
      attackId: pending.attack.attackId,
      playerId: command.actorId
    });
    advanceAfterAttackStep(context, committedPending);
    return null;
  }
  if (effect === "REFLECT" || effect === "BOUNCE") {
    if (pending.attack.reactionDepth >= MAX_REACTION_CHAIN_DEPTH) {
      emit(context, {
        type: "REACTION_CHAIN_ABORTED",
        attackId: pending.attack.attackId,
        maxDepth: MAX_REACTION_CHAIN_DEPTH
      });
      advanceAfterAttackStep(context, committedPending);
      return null;
    }
    let redirectedTargetPlayerId: string;
    if (effect === "REFLECT") {
      redirectedTargetPlayerId = pending.attack.actorId;
    } else {
      const alivePlayers = Object.values(context.state.players)
        .filter(({ alive }) => alive)
        .sort((left, right) => left.seat - right.seat);
      const selection = drawWeighted(
        context.state.rng,
        alivePlayers.map((player) => ({
          key: `${String(player.seat).padStart(2, "0")}:${player.playerId}`,
          weight: 1,
          value: player.playerId
        })),
        "TARGET_SELECTION",
        context.state.eventSequence + 1
      );
      redirectedTargetPlayerId = consumeSelection(context, selection);
    }
    const nextReactionDepth = pending.attack.reactionDepth + 1;
    const nextReactionId = `${pending.attack.attackId}:reaction:${nextReactionDepth}`;
    emit(context, {
      type: "ATTACK_REDIRECTED",
      attackId: pending.attack.attackId,
      reactionId: nextReactionId,
      actorId: command.actorId,
      targetPlayerId: redirectedTargetPlayerId,
      reactionDepth: nextReactionDepth,
      redirectType: effect
    });
    const redirectedPending = context.state.pendingAction;
    if (redirectedPending?.kind !== "ATTACK") {
      throw new Error("Redirected attack state disappeared");
    }
    if (
      redirectedTargetPlayerId === command.actorId ||
      !context.state.players[redirectedTargetPlayerId]?.alive
    ) {
      resolvePendingAttackDamage(
        context,
        redirectedPending,
        redirectedTargetPlayerId,
        0
      );
      const resolvedRedirect = context.state.pendingAction;
      if (resolvedRedirect?.kind !== "ATTACK") {
        throw new Error("Redirected attack state disappeared after damage");
      }
      advanceAfterAttackStep(context, resolvedRedirect);
      return null;
    }
    emit(context, {
      type: "REACTION_REQUESTED",
      reactionId: nextReactionId,
      attackId: pending.attack.attackId,
      playerId: redirectedTargetPlayerId,
      inputDeadlineAt: deadlineFor(
        context.state,
        redirectedTargetPlayerId,
        context.occurredAt
      )
    });
    return null;
  }

  const receivedDamage =
    pending.attack.attackKind === "TARGETED_CARD"
      ? 0
      : resolvePendingAttackDamage(
          context,
          committedPending,
          command.actorId,
          totalDefense
        );
  if (pending.attack.attackKind !== "TARGETED_CARD") {
    applyCounterEffects(
      context,
      committedPending,
      command.actorId,
      reactionDefinitions,
      receivedDamage
    );
  }
  const resolvedPending = context.state.pendingAction;
  if (resolvedPending?.kind !== "ATTACK") {
    throw new Error("Attack state disappeared after damage");
  }
  advanceAfterAttackStep(context, resolvedPending);
  return null;
}

function handleSurrender(
  context: EngineContext,
  command: Extract<GameCommand, { type: "SURRENDER" }>
): CommandFailure | null {
  const phaseError = requireActiveActionPhase(context.state, command.actorId);
  if (phaseError) return phaseError;
  emit(context, {
    type: "ACTION_DECLARED",
    playerId: command.actorId,
    actionType: command.type,
    targetPlayerId: null,
    actionCardDefinitionIds: []
  });
  emit(context, {
    type: "PLAYER_ASCENDED",
    playerId: command.actorId,
    reason: "SURRENDER"
  });
  finishTurn(context, command.actorId);
  return null;
}

export function handleCommand(
  state: MatchState,
  command: GameCommand,
  authority: Controller = "HUMAN"
): CommandResult {
  const fingerprint = stableStringify(command);
  const cached = state.processedCommands[command.commandId];
  if (cached) {
    if (cached.commandFingerprint !== fingerprint) {
      return fail(
        state,
        "DUPLICATE_COMMAND_CONFLICT",
        "commandId was already used with another payload"
      );
    }
    return { ok: true, state, events: cached.events, duplicate: true };
  }
  const occurredAt = assertIsoDate(command.occurredAt ?? "1970-01-01T00:00:00.000Z");
  const validationError = baseCommandValidation(
    state,
    command,
    authority,
    occurredAt
  );
  if (validationError) return validationError;
  const context: EngineContext = { state, events: [], occurredAt };
  let commandError: CommandFailure | null;
  switch (command.type) {
    case "PRAY":
      commandError = handlePray(context, command);
      break;
    case "SURRENDER":
      commandError = handleSurrender(context, command);
      break;
    case "DECLARE_ACTION":
      commandError = handleDeclareAction(context, command);
      break;
    case "DECLARE_REACTION":
      commandError = handleReaction(context, command);
      break;
    case "DISCARD":
    case "SACRIFICE":
      commandError = handleDiscard(context, command);
      break;
    case "EXCHANGE_RESOURCES":
      commandError = handleExchangeResources(context, command);
      break;
    case "SELL_CARD":
      commandError = handleSellCard(context, command);
      break;
    case "DECLARE_BUY":
      commandError = handleDeclareBuy(context, command);
      break;
    case "CONFIRM_BUY":
      commandError = handleConfirmBuy(context, command);
      break;
    default:
      commandError = fail(state, "INVALID_PHASE", "Unsupported command");
  }
  if (commandError) return commandError;
  const finalState: MatchState = {
    ...context.state,
    processedCommands: {
      ...context.state.processedCommands,
      [command.commandId]: {
        commandFingerprint: fingerprint,
        revision: context.state.revision,
        eventSequence: context.state.eventSequence,
        events: context.events
      }
    }
  };
  return {
    ok: true,
    state: finalState,
    events: context.events,
    duplicate: false
  };
}
