import type {
  AttackState,
  CardInstance,
  CommandErrorCode,
  DomainEvent,
  GamePhase,
  LearnedMiracle,
  MatchResult,
  MatchState,
  PlayerState
} from "./model.ts";

export type LegalActionView =
  | { type: "PRAY" }
  | { type: "SURRENDER" }
  | {
      type: "DECLARE_ACTION";
      cardInstanceIds: string[];
      learnedMiracleIds: string[];
      additiveCardInstanceIds: string[];
      additiveLearnedMiracleIds: string[];
      targetPlayerIds: string[];
    }
  | { type: "DISCARD"; cardInstanceIds: string[] }
  | { type: "SACRIFICE"; cardInstanceIds: string[] }
  | {
      type: "EXCHANGE_RESOURCES";
      cardInstanceIds: string[];
      resourceTotal: number;
    }
  | {
      type: "SELL_CARD";
      cardInstanceIds: string[];
      productCardInstanceIds: string[];
      targetPlayerIds: string[];
    }
  | {
      type: "DECLARE_BUY";
      cardInstanceIds: string[];
      targetPlayerIds: string[];
    }
  | {
      type: "CONFIRM_BUY";
      tradeId: string;
      offeredCardInstanceId: string;
      price: number;
      canAfford: boolean;
    }
  | {
      type: "DECLARE_REACTION";
      reactionId: string;
      defenseCardInstanceIds: string[];
      defenseValueByCardInstanceId: Record<string, number>;
      defenseLearnedMiracleIds: string[];
      maxDefenseCards: number | null;
      canForgive: true;
    };

export type CardInstanceView = CardInstance;
export type LearnedMiracleView = LearnedMiracle;

export type PlayerPublicView = Pick<
  PlayerState,
  | "playerId"
  | "displayName"
  | "teamId"
  | "hp"
  | "mp"
  | "money"
  | "alive"
  | "calamities"
  | "guardian"
> & {
  seatIndex: number;
  controller: PlayerState["controller"];
  connectionState: "CONNECTED" | "DISCONNECTED";
  handCount: number;
  learnedMiracleCount: number;
};

export type SelfPrivateView = {
  playerId: string;
  hand: CardInstanceView[];
  learnedMiracles: LearnedMiracleView[];
  legalActions: LegalActionView[];
  tradeConfirmation: {
    tradeId: string;
    targetPlayerId: string;
    offeredCard: CardInstanceView;
    price: number;
    canAfford: boolean;
  } | null;
};

export type MatchResultView = MatchResult;

export type PendingAttackView = Pick<
  AttackState,
  | "attackId"
  | "reactionId"
  | "seriesId"
  | "attackNumber"
  | "totalAttacks"
  | "targetIndex"
  | "totalTargets"
  | "attackKind"
  | "actorId"
  | "targetPlayerId"
  | "sourceCardDefinitionIds"
  | "element"
  | "power"
  | "hit"
>;

export type GameViewState = {
  matchId: string;
  matchMode: MatchState["mode"];
  revision: number;
  phase: GamePhase;
  gfCount: number;
  endTimeAt: number | null;
  activePlayerId: string | null;
  actingPlayerId: string | null;
  targetPlayerIds: string[];
  pendingAttack: PendingAttackView | null;
  players: PlayerPublicView[];
  self: SelfPrivateView | null;
  result: MatchResultView | null;
  inputDeadlineAt: string | null;
};

export type CommandApiTransportErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "MATCH_NOT_FOUND"
  | "RATE_LIMITED";

export type CommandApiErrorCode =
  | CommandErrorCode
  | CommandApiTransportErrorCode;

export type GameCommandApiSuccess = {
  ok: true;
  commandId: string;
  duplicate: boolean;
  eventSeq: number;
  snapshot: GameViewState;
};

export type GameCommandApiFailure = {
  ok: false;
  commandId: string | null;
  code: CommandApiErrorCode;
  message: string;
  eventSeq: number | null;
  snapshot: GameViewState | null;
};

export type GameCommandApiResponse =
  | GameCommandApiSuccess
  | GameCommandApiFailure;

export type MatchSyncRequest = {
  type: "SYNC_MATCH";
  matchId: string;
  lastEventSeq: number | null;
};

export type RealtimeViewer =
  | { kind: "PLAYER"; playerId: string }
  | { kind: "SPECTATOR" };

export type RealtimeEventBatch = {
  type: "EVENT_BATCH";
  matchId: string;
  afterEventSeq: number;
  eventSeq: number;
  events: DomainEvent[];
  snapshot: GameViewState;
};

export type FullSnapshotReason =
  | "INITIAL_SYNC"
  | "EVENT_HISTORY_UNAVAILABLE"
  | "CLIENT_AHEAD";

export type RealtimeFullSnapshot = {
  type: "FULL_SNAPSHOT";
  matchId: string;
  eventSeq: number;
  reason: FullSnapshotReason;
  recentEvents: DomainEvent[];
  snapshot: GameViewState;
};

export type RealtimeSyncErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "MATCH_NOT_FOUND"
  | "VIEWER_NOT_ALLOWED";

export type RealtimeSyncError = {
  type: "SYNC_ERROR";
  matchId: string | null;
  code: RealtimeSyncErrorCode;
  message: string;
};

export type RealtimeMatchMessage =
  | RealtimeEventBatch
  | RealtimeFullSnapshot
  | RealtimeSyncError;

export type PublicMatchState = Omit<
  MatchState,
  | "players"
  | "rng"
  | "randomLog"
  | "processedCommands"
  | "postTurnAutomatic"
  | "phenomenonAutomatic"
  | "pendingAction"
>;
