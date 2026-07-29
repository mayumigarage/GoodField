import type { Calamity, Element } from "./card-types.ts";
import type { RandomEvent, RngState } from "./rng.ts";

export const RULESET_VERSION = "GOODFIELD_RULESET_2026_07_25";
export const INITIAL_HP = 40;
export const INITIAL_MP = 10;
export const INITIAL_MONEY = 20;
export const INITIAL_HAND_SIZE = 9;
export const MAX_HAND_SIZE = 18;
export const MAX_RESOURCE = 99;

export type GamePhase =
  | "LOBBY"
  | "INITIALIZING"
  | "INITIAL_GRANT"
  | "TURN_OPEN"
  | "ACTION_SELECTION"
  | "TARGET_SELECTION"
  | "ACTION_DECLARED"
  | "REACTION_SELECTION"
  | "TRADE_CONFIRMATION"
  | "ACTION_RESOLUTION"
  | "POST_ACTION_GRANT"
  | "TURN_CLOSE"
  | "POST_TURN_AUTOMATIC_EFFECTS"
  | "RESULT_CHECK"
  | "MATCH_ENDED";

export type MatchMode = "TRAINING" | "ONLINE";
export type Controller = "HUMAN" | "CPU";
export type EndTimeThreshold = 1 | 50 | 75 | 100 | 150;

export type CardInstance = {
  instanceId: string;
  cardDefinitionId: string;
  dreamDisguiseCardDefinitionId: string | null;
};

export type LearnedMiracle = {
  learnedMiracleId: string;
  cardDefinitionId: string;
};

export type CalamityState = Partial<Record<Calamity, true>>;

export type GuardianState = {
  guardianId: string;
  guardianName: string;
};

export type AttackKind =
  | "WEAPON"
  | "MIRACLE"
  | "GUARDIAN"
  | "PHENOMENON"
  | "TARGETED_CARD";
export type AttackCompletion =
  | "FINISH_TURN"
  | "RESUME_POST_TURN"
  | "RESUME_PHENOMENON";

export type PlayerState = {
  playerId: string;
  displayName: string;
  teamId: string | null;
  seat: number;
  controller: Controller;
  alive: boolean;
  hp: number;
  mp: number;
  money: number;
  hand: CardInstance[];
  learnedMiracles: LearnedMiracle[];
  calamities: CalamityState;
  guardian: GuardianState | null;
  disconnected: boolean;
};

export type AttackState = {
  attackId: string;
  reactionId: string;
  reactionDepth: number;
  seriesId: string;
  attackNumber: number;
  totalAttacks: number;
  targetIndex: number;
  totalTargets: number;
  attackKind: AttackKind;
  actorId: string;
  targetPlayerId: string;
  sourceCardInstanceIds: string[];
  sourceLearnedMiracleIds: string[];
  sourceCardDefinitionIds: string[];
  element: Element;
  power: number;
  hit: boolean | null;
};

export type DeferredTargetedCardEffect =
  | {
      kind: "DIRECT";
      definitionId: string;
    }
  | {
      kind: "SELL";
      productCardInstanceId: string;
      price: number;
      tradeId: string;
    }
  | {
      kind: "BUY";
      tradeId: string;
    }
  | {
      kind: "COUNTER";
      definitionIds: string[];
      receivedDamage: number;
      originalAttack: AttackState;
      originalTargetPlayerIds: string[];
      originalHitRate: number;
      originalCompletion: AttackCompletion;
    };

export type PendingAction =
  | {
      kind: "ATTACK";
      attack: AttackState;
      actionOwnerId: string;
      targetPlayerIds: string[];
      hitRate: number;
      attackerGrantCount: number;
      usedDefenseCardInstanceIds: string[];
      defenseGrantCounts: Record<string, number>;
      revivalGrantCounts: Record<string, number>;
      completion: AttackCompletion;
      deferredTargetedCardEffect: DeferredTargetedCardEffect | null;
    }
  | {
      kind: "TRADE_CONFIRMATION";
      tradeId: string;
      actorId: string;
      targetPlayerId: string;
      offeredCardInstanceId: string;
      price: number;
      canAfford: boolean;
    };

export type GrantReason =
  | "INITIAL"
  | "CARD_USED"
  | "DEFENSE_USED"
  | "PRAY"
  | "SACRIFICE"
  | "CARD_EFFECT";

export type GrantObligation = {
  obligationId: string;
  playerId: string;
  reason: GrantReason;
};

export type MatchResult =
  | {
      kind: "WIN";
      winnerPlayerIds: string[];
      winnerTeamId: string | null;
    }
  | {
      kind: "DRAW";
      winnerPlayerIds: [];
      winnerTeamId: null;
    };

export type CommandResultCache = {
  commandFingerprint: string;
  revision: number;
  eventSequence: number;
  events: DomainEvent[];
};

export type PostTurnAutomaticState = {
  turnActorId: string;
  guardianPlayerIds: string[];
  nextGuardianIndex: number;
};

export type ConfusionActionSlot = {
  playerId: string;
  round: number;
};

export type PhenomenonAutomaticState = {
  sourcePlayerId: string;
  sourceGrantCount: number;
  actionSlots: ConfusionActionSlot[];
  nextActionIndex: number;
};

export type MatchState = {
  matchId: string;
  rulesetVersion: string;
  cardPoolVersion: string;
  mode: MatchMode;
  phase: GamePhase;
  revision: number;
  gfCount: number;
  endTimeThreshold: EndTimeThreshold | null;
  endTimeActive: boolean;
  activePlayerId: string | null;
  turnOrder: string[];
  turnCursor: number;
  players: Record<string, PlayerState>;
  pendingAction: PendingAction | null;
  postTurnAutomatic: PostTurnAutomaticState | null;
  phenomenonAutomatic: PhenomenonAutomaticState | null;
  pendingGrant: GrantObligation[];
  eventSequence: number;
  rng: RngState;
  randomLog: RandomEvent[];
  result: MatchResult | null;
  inputDeadlineAt: string | null;
  processedCommands: Record<string, CommandResultCache>;
  nextEntitySequence: number;
  defeatedThisTurn: string[];
};

export type PlayerSetup = {
  playerId: string;
  displayName: string;
  teamId?: string | null;
  controller?: Controller;
};

export type CreateMatchInput = {
  matchId: string;
  seed: string;
  players: PlayerSetup[];
  mode?: MatchMode;
  endTimeThreshold?: EndTimeThreshold | null;
  now?: string;
};

export type EventVisibility =
  | { scope: "PUBLIC" }
  | { scope: "PLAYER"; playerId: string }
  | { scope: "SERVER" };

export type DomainEventBase = {
  type: string;
  eventSeq: number;
  revision: number;
  occurredAt: string;
  visibility: EventVisibility;
};

export type DomainEvent =
  | (DomainEventBase & { type: "MATCH_STARTED"; turnOrder: string[] })
  | (DomainEventBase & { type: "INITIAL_GRANT_COMPLETED" })
  | (DomainEventBase & { type: "GF_COUNT_CHANGED"; gfCount: number })
  | (DomainEventBase & { type: "TURN_OPENED"; playerId: string })
  | (DomainEventBase & {
      type: "ACTION_REQUESTED";
      playerId: string;
      inputDeadlineAt: string | null;
    })
  | (DomainEventBase & {
      type: "ACTION_DECLARED";
      playerId: string;
      actionType: GameCommand["type"];
      targetPlayerId: string | null;
      actionCardDefinitionIds?: string[];
    })
  | (DomainEventBase & {
      type: "CARD_CONSUMED";
      playerId: string;
      cardInstanceId: string;
    })
  | (DomainEventBase & {
      type: "MIRACLE_LEARNED";
      playerId: string;
      cardInstanceId: string;
      miracle: LearnedMiracle;
    })
  | (DomainEventBase & {
      type: "MIRACLE_CAST";
      playerId: string;
      learnedMiracleId: string;
      cardDefinitionId: string;
    })
  | (DomainEventBase & {
      type: "MP_SPENT";
      playerId: string;
      amount: number;
      mpAfter: number;
    })
  | (DomainEventBase & {
      type: "RESOURCE_CHANGED";
      playerId: string;
      resource: "HP" | "MP" | "MONEY";
      delta: number;
      valueAfter: number;
      reason:
        | "MIRACLE"
        | "CARD_EFFECT"
        | "ABSORPTION"
        | "SELF_DAMAGE"
        | "COUNTER"
        | "CALAMITY"
        | "GUARDIAN"
        | "DEMON"
        | "PHENOMENON";
    })
  | (DomainEventBase & {
      type: "RESOURCES_EXCHANGED";
      playerId: string;
      hpAfter: number;
      mpAfter: number;
      moneyAfter: number;
    })
  | (DomainEventBase & {
      type: "TRADE_OFFERED";
      tradeId: string;
      actorId: string;
      targetPlayerId: string;
      offeredCardInstanceId: string;
      price: number;
      canAfford: boolean;
      inputDeadlineAt: string | null;
    })
  | (DomainEventBase & {
      type: "TRADE_RESOLVED";
      tradeId: string;
      actorId: string;
      targetPlayerId: string;
      offeredCardInstanceId: string;
      resolution: "ACCEPTED" | "DECLINED" | "INSUFFICIENT_RESOURCES";
    })
  | (DomainEventBase & {
      type: "TRADE_PAYMENT_COLLECTED";
      payerPlayerId: string;
      recipientPlayerId: string;
      price: number;
      moneyPaid: number;
      mpPaid: number;
      hpPaid: number;
      payerMoneyAfter: number;
      payerMpAfter: number;
      payerHpAfter: number;
      recipientMoneyAfter: number;
    })
  | (DomainEventBase & {
      type: "CARD_TRANSFERRED";
      fromPlayerId: string;
      toPlayerId: string;
      card: CardInstance;
    })
  | (DomainEventBase & {
      type: "CALAMITY_APPLIED";
      playerId: string;
      calamity: Calamity;
    })
  | (DomainEventBase & {
      type: "CALAMITIES_REMOVED";
      playerId: string;
      calamities: Calamity[];
    })
  | (DomainEventBase & {
      type: "ARTIFACT_REMOVED";
      playerId: string;
      cardInstanceId: string;
      cardDefinitionId: string;
      reason: "CARD_EFFECT" | "HAND_REDRAW";
    })
  | (DomainEventBase & {
      type: "LEARNED_MIRACLE_REMOVED";
      playerId: string;
      learnedMiracleId: string;
      cardDefinitionId: string;
    })
  | (DomainEventBase & {
      type: "ARTIFACT_HANDS_SHUFFLED";
      hands: Record<string, CardInstance[]>;
    })
  | (DomainEventBase & {
      type: "GUARDIAN_ASSIGNED";
      playerId: string;
      guardian: GuardianState;
    })
  | (DomainEventBase & {
      type: "GUARDIAN_DEPARTED";
      playerId: string;
      guardianId: string;
      reason: "HOST_HP_LOSS";
    })
  | (DomainEventBase & {
      type: "POST_TURN_AUTOMATIC_EFFECTS_STARTED";
      turnActorId: string;
      guardianPlayerIds: string[];
    })
  | (DomainEventBase & {
      type: "GUARDIAN_CHECKED";
      playerId: string;
      acted: boolean;
    })
  | (DomainEventBase & {
      type: "GUARDIAN_ACTION_SELECTED";
      playerId: string;
      guardianId: string;
      actionCardDefinitionId: string;
      targetPlayerId: string | null;
    })
  | (DomainEventBase & {
      type: "CALAMITY_WORSEN_CHECKED";
      playerId: string;
      disease: Calamity;
      worsened: boolean;
    })
  | (DomainEventBase & {
      type: "CALAMITY_WORSENED";
      playerId: string;
      from: Calamity;
      to: Calamity | null;
    })
  | (DomainEventBase & {
      type: "POST_TURN_AUTOMATIC_EFFECTS_COMPLETED";
      turnActorId: string;
    })
  | (DomainEventBase & {
      type: "ATTACK_CREATED";
      attack: AttackState;
      actionOwnerId: string;
      targetPlayerIds: string[];
      hitRate: number;
      attackerGrantCount: number;
      completion: AttackCompletion;
      deferredTargetedCardEffect?: DeferredTargetedCardEffect | null;
    })
  | (DomainEventBase & {
      type: "HIT_ROLLED";
      attackId: string;
      hit: boolean;
      hitRate: number;
    })
  | (DomainEventBase & {
      type: "ATTACK_ELEMENT_FILTERED";
      attackId: string;
      element: "PHYSICAL";
    })
  | (DomainEventBase & {
      type: "ATTACK_REDIRECTED";
      attackId: string;
      reactionId: string;
      actorId: string;
      targetPlayerId: string;
      reactionDepth: number;
      redirectType: "REFLECT" | "BOUNCE";
    })
  | (DomainEventBase & {
      type: "ATTACK_STOPPED";
      attackId: string;
      playerId: string;
    })
  | (DomainEventBase & {
      type: "REACTION_CHAIN_ABORTED";
      attackId: string;
      maxDepth: number;
    })
  | (DomainEventBase & {
      type: "REACTION_REQUESTED";
      reactionId: string;
      attackId: string;
      playerId: string;
      inputDeadlineAt: string | null;
    })
  | (DomainEventBase & {
      type: "REACTION_DECLARED";
      reactionId: string;
      playerId: string;
      defenseCardInstanceIds: string[];
      defenseLearnedMiracleIds: string[];
      defenseCardDefinitionIds?: string[];
      defenseLearnedMiracleDefinitionIds?: string[];
      defensePower?: number;
    })
  | (DomainEventBase & {
      type: "DEFENSE_COMMITTED";
      playerId: string;
      cardInstanceId: string;
    })
  | (DomainEventBase & {
      type: "DAMAGE_APPLIED";
      attackId: string;
      playerId: string;
      amount: number;
      hpAfter: number;
    })
  | (DomainEventBase & { type: "HP_REACHED_ZERO"; playerId: string })
  | (DomainEventBase & {
      type: "REVIVAL_RESOLVED";
      playerId: string;
      cardInstanceId: string;
      hpAfter: number;
    })
  | (DomainEventBase & {
      type: "ASCENSION_BOW_TRIGGERED";
      playerId: string;
      targetPlayerId: string;
      cardInstanceId: string;
      hit: boolean;
    })
  | (DomainEventBase & {
      type: "PLAYER_ASCENDED";
      playerId: string;
      reason: "HP_ZERO" | "SURRENDER";
    })
  | (DomainEventBase & { type: "GRANT_REQUESTED"; obligation: GrantObligation })
  | (DomainEventBase & {
      type: "DEMON_APPEARED";
      obligationId: string;
      playerId: string;
      demonCardDefinitionId: string;
    })
  | (DomainEventBase & {
      type: "DEMON_OBJECT_REMOVED";
      playerId: string;
      objectType: "CARD" | "LEARNED_MIRACLE";
      objectId: string;
      cardDefinitionId: string;
    })
  | (DomainEventBase & {
      type: "DEMON_THEFT_RESOLVED";
      playerId: string;
      removedCount: number;
    })
  | (DomainEventBase & {
      type: "GRANT_CANCELLED";
      obligationId: string;
      playerId: string;
      reason: "PLAYER_ASCENDED";
    })
  | (DomainEventBase & {
      type: "CARD_GRANTED";
      obligationId: string;
      playerId: string;
      card: CardInstance;
    })
  | (DomainEventBase & {
      type: "HAND_LIMIT_DISCARD";
      playerId: string;
      cardInstanceId: string;
    })
  | (DomainEventBase & {
      type: "PHENOMENON_SELECTED";
      playerId: string;
      phenomenonCardDefinitionId: string;
    })
  | (DomainEventBase & {
      type: "CONFUSION_ACTIONS_STARTED";
      sourcePlayerId: string;
      sourceGrantCount: number;
      actionSlots: ConfusionActionSlot[];
    })
  | (DomainEventBase & {
      type: "CONFUSION_ACTION_SELECTED";
      playerId: string;
      round: number;
      actionType: "ATTACK" | "DIRECT" | "PRAY" | "DISCARD" | "PASS";
      sourceCardDefinitionId: string | null;
      targetPlayerId: string | null;
    })
  | (DomainEventBase & {
      type: "CONFUSION_ACTION_COMPLETED";
      playerId: string;
      round: number;
    })
  | (DomainEventBase & {
      type: "CONFUSION_ACTIONS_COMPLETED";
      sourcePlayerId: string;
    })
  | (DomainEventBase & {
      type: "INPUT_TIMED_OUT";
      playerId: string;
      inputDeadlineAt: string;
    })
  | (DomainEventBase & {
      type: "PLAYER_CONNECTION_CHANGED";
      playerId: string;
      connectionState: "CONNECTED" | "DISCONNECTED";
    })
  | (DomainEventBase & { type: "TURN_CLOSED"; playerId: string })
  | (DomainEventBase & { type: "MATCH_ENDED"; result: MatchResult });

export type CommandBase = {
  matchId: string;
  commandId: string;
  actorId: string;
  expectedRevision: number;
  occurredAt?: string;
};

export type GameCommand =
  | (CommandBase & { type: "PRAY" })
  | (CommandBase & { type: "SURRENDER" })
  | (CommandBase & {
      type: "DECLARE_ACTION";
      cardInstanceIds: string[];
      learnedMiracleIds?: string[];
      targetPlayerId: string;
    })
  | (CommandBase & {
      type: "DECLARE_REACTION";
      reactionId: string;
      defenseCardInstanceIds: string[];
      defenseLearnedMiracleIds?: string[];
    })
  | (CommandBase & {
      type: "DISCARD";
      cardInstanceId: string;
    })
  | (CommandBase & {
      type: "SACRIFICE";
      cardInstanceId: string;
    })
  | (CommandBase & {
      type: "EXCHANGE_RESOURCES";
      cardInstanceId: string;
      hp: number;
      mp: number;
      money: number;
    })
  | (CommandBase & {
      type: "SELL_CARD";
      cardInstanceId: string;
      productCardInstanceId: string;
      targetPlayerId: string;
    })
  | (CommandBase & {
      type: "DECLARE_BUY";
      cardInstanceId: string;
      targetPlayerId: string;
    })
  | (CommandBase & {
      type: "CONFIRM_BUY";
      tradeId: string;
      accept: boolean;
    });

export type CommandErrorCode =
  | "MATCH_ID_MISMATCH"
  | "STALE_REVISION"
  | "DUPLICATE_COMMAND_CONFLICT"
  | "INVALID_ACTOR"
  | "INVALID_PHASE"
  | "NOT_ACTIVE_PLAYER"
  | "PLAYER_ASCENDED"
  | "CARD_NOT_FOUND"
  | "INVALID_CARD_SELECTION"
  | "INVALID_TARGET"
  | "INVALID_REACTION"
  | "INVALID_TRADE"
  | "INVALID_RESOURCE_ALLOCATION"
  | "INSUFFICIENT_RESOURCES"
  | "INSUFFICIENT_MP"
  | "PRAY_NOT_ALLOWED"
  | "CONTROLLER_MISMATCH"
  | "INPUT_DEADLINE_EXPIRED";

export type CommandSuccess = {
  ok: true;
  state: MatchState;
  events: DomainEvent[];
  duplicate: boolean;
};

export type CommandFailure = {
  ok: false;
  state: MatchState;
  code: CommandErrorCode;
  message: string;
};

export type CommandResult = CommandSuccess | CommandFailure;

export function clampResource(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Resource value must be finite");
  return Math.max(0, Math.min(MAX_RESOURCE, Math.trunc(value)));
}
