import type { CardDefinition } from "../../shared/src/card-types.ts";
import {
  CARD_DEFINITIONS_BY_ID,
  instructionsOfKind
} from "../../shared/src/cards.ts";
import type {
  CardInstance,
  DomainEvent,
  MatchState,
  PlayerState
} from "../../shared/src/model.ts";
import type {
  GameViewState,
  LegalActionView,
  PlayerPublicView,
  SelfPrivateView
} from "../../shared/src/protocol.ts";
import {
  canDefenseBlock,
  canPray,
  hasCounterOrFilterEffect,
  isSupportedDirectAction,
  reactionEffectFor
} from "./engine.ts";

function definitionFor(card: CardInstance): CardDefinition {
  const definition = CARD_DEFINITIONS_BY_ID.get(card.cardDefinitionId);
  if (!definition) throw new Error(`Missing definition ${card.cardDefinitionId}`);
  return definition;
}

function isEnemy(actor: PlayerState, target: PlayerState): boolean {
  if (actor.playerId === target.playerId || !target.alive) return false;
  return actor.teamId === null || target.teamId === null || actor.teamId !== target.teamId;
}

function publicPlayer(player: PlayerState): PlayerPublicView {
  return {
    playerId: player.playerId,
    displayName: player.displayName,
    teamId: player.teamId,
    seatIndex: player.seat,
    controller: player.controller,
    connectionState: player.disconnected ? "DISCONNECTED" : "CONNECTED",
    hp: player.hp,
    mp: player.mp,
    money: player.money,
    alive: player.alive,
    calamities: { ...player.calamities },
    guardian: player.guardian ? { ...player.guardian } : null,
    handCount: player.hand.length,
    learnedMiracleCount: player.learnedMiracles.length
  };
}

function visibleOwnCard(card: CardInstance): CardInstance {
  if (!card.dreamDisguiseCardDefinitionId) {
    return { ...card, dreamDisguiseCardDefinitionId: null };
  }
  return {
    ...card,
    cardDefinitionId: card.dreamDisguiseCardDefinitionId,
    dreamDisguiseCardDefinitionId: null
  };
}

function canViewEvent(
  event: DomainEvent,
  viewerPlayerId: string | null
): boolean {
  if (event.visibility.scope === "SERVER") return false;
  if (event.visibility.scope === "PUBLIC") return true;
  return event.visibility.playerId === viewerPlayerId;
}

export function projectDomainEvent(
  event: DomainEvent,
  viewerPlayerId: string | null
): DomainEvent | null {
  if (!canViewEvent(event, viewerPlayerId)) return null;
  if (event.type === "CARD_GRANTED") {
    return {
      ...structuredClone(event),
      card: visibleOwnCard(event.card)
    };
  }
  if (event.type === "CARD_TRANSFERRED") {
    return {
      ...structuredClone(event),
      card: visibleOwnCard(event.card)
    };
  }
  return structuredClone(event);
}

function discardable(card: CardInstance): boolean {
  const definition = definitionFor(card);
  return (
    definition.category !== "WEAPON" &&
    definition.cardDefinitionId !== "sun-amulet" &&
    definition.cardDefinitionId !== "dangerous-mortar"
  );
}

function composesWithPrimaryAttack(definition: CardDefinition): boolean {
  const attack = instructionsOfKind(definition, "ATTACK")[0];
  if (attack?.additive) return true;
  return instructionsOfKind(definition, "SPECIAL").some(
    ({ operation }) =>
      operation === "ATTACK_EVERY_ENEMY" ||
      operation === "DOUBLE_ATTACK" ||
      operation === "CUT_COST"
  );
}

function isPureCostCutter(definition: CardDefinition): boolean {
  return (
    instructionsOfKind(definition, "SPECIAL").some(
      ({ operation }) => operation === "CUT_COST"
    ) &&
    instructionsOfKind(definition, "ATTACK").length === 0
  );
}

function minimumActionCards(
  definition: CardDefinition,
  player: PlayerState,
  primaryCardInstanceIds: readonly string[],
  costCutterCardInstanceIds: readonly string[]
): {
  cardInstanceIds: string[];
  additiveCardInstanceIds: string[];
} {
  const requiredCostCutter =
    definition.category === "MIRACLE" &&
    (definition.mpCost ?? 0) > player.mp
      ? costCutterCardInstanceIds[0]
      : undefined;
  return {
    cardInstanceIds: requiredCostCutter
      ? [...primaryCardInstanceIds, requiredCostCutter]
      : [...primaryCardInstanceIds],
    additiveCardInstanceIds: costCutterCardInstanceIds.filter(
      (instanceId) => instanceId !== requiredCostCutter
    )
  };
}

function directActionTargetsEnemy(definition: CardDefinition): boolean {
  return (
    instructionsOfKind(definition, "ADD_CALAMITY").some(
      ({ timing }) => timing === "IMMEDIATE"
    ) ||
    instructionsOfKind(definition, "SPECIAL").some(
      ({ operation }) =>
        operation === "REMOVE_ITEMS" ||
        operation === "REMOVE_USED_MIRACLES"
    )
  );
}

export function legalActionsFor(
  state: MatchState,
  playerId: string
): LegalActionView[] {
  const player = state.players[playerId];
  if (!player?.alive || state.phase === "MATCH_ENDED") return [];
  const actions: LegalActionView[] = [];

  if (
    state.phase === "TRADE_CONFIRMATION" &&
    state.pendingAction?.kind === "TRADE_CONFIRMATION" &&
    state.pendingAction.actorId === playerId
  ) {
    return [
      {
        type: "CONFIRM_BUY",
        tradeId: state.pendingAction.tradeId,
        offeredCardInstanceId: state.pendingAction.offeredCardInstanceId,
        price: state.pendingAction.price,
        canAfford: state.pendingAction.canAfford
      }
    ];
  }

  if (
    state.phase === "REACTION_SELECTION" &&
    state.pendingAction?.kind === "ATTACK" &&
    state.pendingAction.attack.targetPlayerId === playerId
  ) {
    const attack = state.pendingAction.attack;
    const canFilterElement = player.hand.some((card) =>
      instructionsOfKind(definitionFor(card), "SPECIAL").some(
        ({ operation }) => operation === "FILTER_ATTACK_ELEMENT"
      )
    );
    const effectiveAttackElement = canFilterElement
      ? "PHYSICAL"
      : attack.element;
    const defenseCardInstanceIds = player.hand
      .filter((card) => {
        const definition = definitionFor(card);
        const defense = instructionsOfKind(definition, "DEFENSE")[0];
        const reactionEffect = reactionEffectFor(
          definition,
          attack.attackKind,
          effectiveAttackElement
        );
        if (attack.attackKind === "TARGETED_CARD") {
          return (
            reactionEffect === "REFLECT" &&
            (definition.category !== "MIRACLE" ||
              (definition.mpCost ?? 0) <= player.mp)
          );
        }
        return (
          ((defense !== undefined &&
            canDefenseBlock(definition.element, effectiveAttackElement)) ||
            reactionEffect !== null ||
            hasCounterOrFilterEffect(definition)) &&
          (definition.category !== "MIRACLE" ||
            (definition.mpCost ?? 0) <= player.mp)
        );
      })
      .map(({ instanceId }) => instanceId);
    const defenseValueByCardInstanceId = Object.fromEntries(
      player.hand
        .filter(({ instanceId }) =>
          defenseCardInstanceIds.includes(instanceId)
        )
        .map((card) => {
          const definition = definitionFor(card);
          const defense = instructionsOfKind(definition, "DEFENSE")[0];
          return [
            card.instanceId,
            defense &&
            canDefenseBlock(definition.element, effectiveAttackElement)
              ? defense.amount
              : 0
          ];
        })
    );
    const defenseLearnedMiracleIds = player.learnedMiracles
      .filter((miracle) => {
        const definition = CARD_DEFINITIONS_BY_ID.get(
          miracle.cardDefinitionId
        );
        return (
          definition !== undefined &&
          (attack.attackKind === "TARGETED_CARD"
            ? reactionEffectFor(
                definition,
                attack.attackKind,
                effectiveAttackElement
              ) === "REFLECT"
            : reactionEffectFor(
                  definition,
                  attack.attackKind,
                  effectiveAttackElement
                ) !== null ||
              hasCounterOrFilterEffect(definition)) &&
          (definition.mpCost ?? 0) <= player.mp
        );
      })
      .map(({ learnedMiracleId }) => learnedMiracleId);
    return [
      {
        type: "DECLARE_REACTION",
        reactionId: attack.reactionId,
        defenseCardInstanceIds,
        defenseValueByCardInstanceId,
        defenseLearnedMiracleIds,
        maxDefenseCards: player.calamities.FLASH ? 1 : null,
        canForgive: true
      }
    ];
  }

  if (state.phase !== "ACTION_SELECTION" || state.activePlayerId !== playerId) {
    return [];
  }
  actions.push({ type: "SURRENDER" });
  const targetPlayerIds = Object.values(state.players)
    .filter((target) => isEnemy(player, target))
    .sort((left, right) => left.seat - right.seat)
    .map(({ playerId: targetId }) => targetId);
  const additiveCardInstanceIds = player.hand
    .filter((card) => {
      const definition = definitionFor(card);
      return (
        (definition.category === "WEAPON" ||
          definition.category === "MIRACLE" ||
          definition.category === "GOODS") &&
        composesWithPrimaryAttack(definition) &&
        (definition.mpCost ?? 0) <= player.mp
      );
    })
    .map(({ instanceId }) => instanceId);
  const additiveLearnedMiracleIds = player.learnedMiracles
    .filter((miracle) => {
      const definition = CARD_DEFINITIONS_BY_ID.get(miracle.cardDefinitionId);
      return (
        definition !== undefined &&
        composesWithPrimaryAttack(definition) &&
        (definition.mpCost ?? 0) <= player.mp
      );
    })
    .map(({ learnedMiracleId }) => learnedMiracleId);
  const costCutterCardInstanceIds = player.hand
    .filter((card) => isPureCostCutter(definitionFor(card)))
    .map(({ instanceId }) => instanceId);
  for (const card of player.hand) {
    const definition = definitionFor(card);
    const attack = instructionsOfKind(definition, "ATTACK")[0];
    if (
      (definition.category === "WEAPON" ||
        definition.category === "MIRACLE") &&
      attack &&
      !attack.additive &&
      ((definition.mpCost ?? 0) <= player.mp ||
        (definition.category === "MIRACLE" &&
          costCutterCardInstanceIds.length > 0))
    ) {
      const minimum = minimumActionCards(
        definition,
        player,
        [card.instanceId],
        costCutterCardInstanceIds
      );
      actions.push({
        type: "DECLARE_ACTION",
        cardInstanceIds: minimum.cardInstanceIds,
        learnedMiracleIds: [],
        additiveCardInstanceIds: [
          ...additiveCardInstanceIds.filter(
            (instanceId) =>
              !minimum.cardInstanceIds.includes(instanceId)
          ),
          ...minimum.additiveCardInstanceIds.filter(
            (instanceId) =>
              !additiveCardInstanceIds.includes(instanceId)
          )
        ],
        additiveLearnedMiracleIds,
        targetPlayerIds
      });
    } else if (
      isSupportedDirectAction(definition) &&
      ((definition.mpCost ?? 0) <= player.mp ||
        (definition.category === "MIRACLE" &&
          costCutterCardInstanceIds.length > 0))
    ) {
      const minimum = minimumActionCards(
        definition,
        player,
        [card.instanceId],
        costCutterCardInstanceIds
      );
      actions.push({
        type: "DECLARE_ACTION",
        cardInstanceIds: minimum.cardInstanceIds,
        learnedMiracleIds: [],
        additiveCardInstanceIds:
          definition.category === "MIRACLE"
            ? minimum.additiveCardInstanceIds
            : [],
        additiveLearnedMiracleIds: [],
        targetPlayerIds: directActionTargetsEnemy(definition)
          ? targetPlayerIds
          : [playerId]
      });
    } else if (definition.cardDefinitionId === "exchange") {
      actions.push({
        type: "EXCHANGE_RESOURCES",
        cardInstanceIds: [card.instanceId],
        resourceTotal: player.hp + player.mp + player.money
      });
    } else if (definition.cardDefinitionId === "sell") {
      actions.push({
        type: "SELL_CARD",
        cardInstanceIds: [card.instanceId],
        productCardInstanceIds: player.hand
          .filter(({ instanceId }) => instanceId !== card.instanceId)
          .map(({ instanceId }) => instanceId),
        targetPlayerIds
      });
    } else if (definition.cardDefinitionId === "buy") {
      actions.push({
        type: "DECLARE_BUY",
        cardInstanceIds: [card.instanceId],
        targetPlayerIds: Object.values(state.players)
          .filter(
            (target) => isEnemy(player, target) && target.hand.length > 0
          )
          .sort((left, right) => left.seat - right.seat)
          .map(({ playerId: targetId }) => targetId)
      });
    }
  }
  for (const miracle of player.learnedMiracles) {
    const definition = CARD_DEFINITIONS_BY_ID.get(miracle.cardDefinitionId);
    const attack = definition
      ? instructionsOfKind(definition, "ATTACK")[0]
      : undefined;
    if (
      definition?.category === "MIRACLE" &&
      attack &&
      !attack.additive &&
      ((definition.mpCost ?? 0) <= player.mp ||
        costCutterCardInstanceIds.length > 0)
    ) {
      const minimum = minimumActionCards(
        definition,
        player,
        [],
        costCutterCardInstanceIds
      );
      actions.push({
        type: "DECLARE_ACTION",
        cardInstanceIds: minimum.cardInstanceIds,
        learnedMiracleIds: [miracle.learnedMiracleId],
        additiveCardInstanceIds: [
          ...additiveCardInstanceIds.filter(
            (instanceId) =>
              !minimum.cardInstanceIds.includes(instanceId)
          ),
          ...minimum.additiveCardInstanceIds.filter(
            (instanceId) =>
              !additiveCardInstanceIds.includes(instanceId)
          )
        ],
        additiveLearnedMiracleIds,
        targetPlayerIds
      });
    } else if (
      definition !== undefined &&
      isSupportedDirectAction(definition) &&
      ((definition.mpCost ?? 0) <= player.mp ||
        costCutterCardInstanceIds.length > 0)
    ) {
      const minimum = minimumActionCards(
        definition,
        player,
        [],
        costCutterCardInstanceIds
      );
      actions.push({
        type: "DECLARE_ACTION",
        cardInstanceIds: minimum.cardInstanceIds,
        learnedMiracleIds: [miracle.learnedMiracleId],
        additiveCardInstanceIds: minimum.additiveCardInstanceIds,
        additiveLearnedMiracleIds: [],
        targetPlayerIds: directActionTargetsEnemy(definition)
          ? targetPlayerIds
          : [playerId]
      });
    }
  }
  if (state.endTimeActive) {
    actions.push({
      type: "SACRIFICE",
      cardInstanceIds: player.hand.map(({ instanceId }) => instanceId)
    });
  } else {
    const cardInstanceIds = player.hand
      .filter(discardable)
      .map(({ instanceId }) => instanceId);
    if (cardInstanceIds.length > 0) {
      actions.push({ type: "DISCARD", cardInstanceIds });
    }
  }
  if (canPray(state, playerId)) actions.push({ type: "PRAY" });
  return actions;
}

function privateSelf(state: MatchState, playerId: string): SelfPrivateView | null {
  const player = state.players[playerId];
  if (!player) return null;
  const pendingTrade =
    state.pendingAction?.kind === "TRADE_CONFIRMATION" &&
    state.pendingAction.actorId === playerId
      ? state.pendingAction
      : null;
  const offeredCard = pendingTrade
    ? state.players[pendingTrade.targetPlayerId]?.hand.find(
        ({ instanceId }) =>
          instanceId === pendingTrade.offeredCardInstanceId
      )
    : undefined;
  return {
    playerId,
    hand: player.hand.map(visibleOwnCard),
    learnedMiracles: player.learnedMiracles.map((miracle) => ({ ...miracle })),
    legalActions: legalActionsFor(state, playerId),
    tradeConfirmation:
      pendingTrade && offeredCard
        ? {
            tradeId: pendingTrade.tradeId,
            targetPlayerId: pendingTrade.targetPlayerId,
            offeredCard: { ...offeredCard },
            price: pendingTrade.price,
            canAfford: pendingTrade.canAfford
          }
        : null
  };
}

export function projectGameView(
  state: MatchState,
  viewerPlayerId: string | null
): GameViewState {
  const pendingAttack =
    state.pendingAction?.kind === "ATTACK" ? state.pendingAction.attack : null;
  return {
    matchId: state.matchId,
    matchMode: state.mode,
    revision: state.revision,
    phase: state.phase,
    gfCount: state.gfCount,
    endTimeAt: state.endTimeThreshold,
    activePlayerId: state.activePlayerId,
    actingPlayerId: pendingAttack?.actorId ?? state.activePlayerId,
    targetPlayerIds: pendingAttack ? [pendingAttack.targetPlayerId] : [],
    pendingAttack: pendingAttack
      ? {
          attackId: pendingAttack.attackId,
          reactionId: pendingAttack.reactionId,
          seriesId: pendingAttack.seriesId,
          attackNumber: pendingAttack.attackNumber,
          totalAttacks: pendingAttack.totalAttacks,
          targetIndex: pendingAttack.targetIndex,
          totalTargets: pendingAttack.totalTargets,
          attackKind: pendingAttack.attackKind,
          actorId: pendingAttack.actorId,
          targetPlayerId: pendingAttack.targetPlayerId,
          sourceCardDefinitionIds: [
            ...pendingAttack.sourceCardDefinitionIds
          ],
          element: pendingAttack.element,
          power: pendingAttack.power,
          hit: pendingAttack.hit
        }
      : null,
    players: Object.values(state.players)
      .sort((left, right) => left.seat - right.seat)
      .map(publicPlayer),
    self: viewerPlayerId ? privateSelf(state, viewerPlayerId) : null,
    result: state.result ? structuredClone(state.result) : null,
    inputDeadlineAt: state.inputDeadlineAt
  };
}
