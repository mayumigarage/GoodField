import type { DomainEvent } from "../../shared/src/model.ts";
import type {
  GameViewState,
  RealtimeMatchMessage
} from "../../shared/src/protocol.ts";

export type PresentationTimingProfile = {
  profileId: string;
  introHoldMs: number;
  stageGapMs: number;
  attackStageMs: number;
  attackResultMs: number;
  deflectHoldMs: number;
  redirectMoveMs: number;
  hitResultMs: number;
  resolutionHoldMs: number;
  healingHoldMs: number;
  exchangeHoldMs: number;
  saleRevealMs: number;
  saleRouteMs: number;
  tradeOfferHoldMs: number;
  tradeSwapMs: number;
  tradeSettleMs: number;
  exitHoldMs: number;
  localSelectionDelayMs: number;
};

export const DANGEROUS_PESTLE_HOLD_MS = 2_000;
// Measured on the original recording (2026-11-04): the orange 夢 card stays
// ~1.7 s; 夢見る帽子 flashes ~1 s before 「神器一新」 holds ~1.9 s.
export const DREAM_NOTICE_HOLD_MS = 1_700;
export const HAND_REDRAW_LEAD_MS = 1_000;
export const HAND_REDRAW_HOLD_MS = 1_900;
// The original 御乱心 badge stays up for ~1.5 s before the first confused act.
export const CONFUSION_NOTICE_HOLD_MS = 1_500;

export const OFFICIAL_WEB_2026_07_25: PresentationTimingProfile = {
  profileId: "OFFICIAL_WEB_2026_07_25",
  introHoldMs: 6_000,
  stageGapMs: 500,
  attackStageMs: 500,
  attackResultMs: 1_000,
  deflectHoldMs: 1_000,
  redirectMoveMs: 1_000,
  hitResultMs: 1_000,
  resolutionHoldMs: 1_000,
  healingHoldMs: 1_000,
  exchangeHoldMs: 1_000,
  saleRevealMs: 400,
  saleRouteMs: 600,
  tradeOfferHoldMs: 1_500,
  tradeSwapMs: 1_600,
  tradeSettleMs: 150,
  exitHoldMs: 1_500,
  localSelectionDelayMs: 0
};

export const OFFICIAL_WEB_2026_07_26: PresentationTimingProfile = {
  profileId: "OFFICIAL_WEB_2026_07_26",
  introHoldMs: 6_000,
  stageGapMs: 500,
  attackStageMs: 500,
  attackResultMs: 1_000,
  deflectHoldMs: 1_000,
  redirectMoveMs: 1_000,
  hitResultMs: 750,
  resolutionHoldMs: 500,
  healingHoldMs: 1_000,
  exchangeHoldMs: 1_500,
  saleRevealMs: 400,
  saleRouteMs: 600,
  tradeOfferHoldMs: 1_500,
  tradeSwapMs: 1_600,
  tradeSettleMs: 150,
  exitHoldMs: 500,
  localSelectionDelayMs: 0
};

export type PresentationStageKind =
  | "INTRO"
  | "GF_UPDATE"
  | "ACTION"
  | "TARGET"
  | "HIT_RESULT"
  | "REACTION_REQUEST"
  | "REACTION"
  | "DAMAGE_RESULT"
  | "HP_UPDATE"
  | "EXCHANGE"
  | "REVIVAL"
  | "ASCENSION"
  | "GRANT"
  | "DEMON"
  | "DEMON_EFFECT"
  | "GUARDIAN"
  | "CALAMITY"
  | "AUTOMATIC_EFFECT"
  | "TRADE"
  | "RESULT"
  | "SYSTEM";

export type TradePresentationStage =
  | "OFFER"
  | "CLEAR"
  | "STAMP"
  | "PRICE"
  | "SWAP"
  | "SETTLE";

const BUY_TRADE_STAGES: readonly TradePresentationStage[] = [
  "OFFER",
  "CLEAR",
  "STAMP",
  "SWAP",
  "SETTLE"
];
// Every other ¥ transfer (sale, bounced sale, guardian theft) shows the coin
// at the payer first, then moves it to the recipient.
const COIN_TRADE_STAGES: readonly TradePresentationStage[] = [
  "PRICE",
  "SWAP",
  "SETTLE"
];

export function tradePresentationStage(
  step: Pick<PresentationStep, "stageIndex" | "stageCount">
): TradePresentationStage {
  const stages =
    step.stageCount === BUY_TRADE_STAGES.length
      ? BUY_TRADE_STAGES
      : COIN_TRADE_STAGES;
  return stages[step.stageIndex] ?? "SETTLE";
}

function tradeStageDuration(
  stage: TradePresentationStage,
  profile: PresentationTimingProfile
): number {
  return stage === "OFFER"
    ? profile.tradeOfferHoldMs
    : stage === "SWAP"
      ? profile.tradeSwapMs
      : stage === "SETTLE"
        ? profile.tradeSettleMs
        : profile.stageGapMs;
}

function isPhenomenonMoneyChange(event: DomainEvent | undefined): boolean {
  return (
    event?.type === "RESOURCE_CHANGED" &&
    event.resource === "MONEY" &&
    event.reason === "PHENOMENON"
  );
}

export type PresentationStep = {
  stepId: string;
  eventSeq: number;
  event: DomainEvent;
  kind: PresentationStageKind;
  stageIndex: number;
  stageCount: number;
  durationMs: number;
};

export type ActivePresentationStep = {
  step: PresentationStep;
  startedAtMs: number;
  endsAtMs: number;
};

export type PresentationQueueState = {
  profile: PresentationTimingProfile;
  latestSnapshot: GameViewState | null;
  recentEvents: DomainEvent[];
  activeStep: ActivePresentationStep | null;
  pendingSteps: PresentationStep[];
  concealedCardInstanceIds: string[];
  lastQueuedEventSeq: number;
  lastCompletedEventSeq: number;
};

type StepDefinition = {
  kind: PresentationStageKind;
  durationMs: number;
};

export function createPresentationQueue(
  profile: PresentationTimingProfile = OFFICIAL_WEB_2026_07_26
): PresentationQueueState {
  return {
    profile,
    latestSnapshot: null,
    recentEvents: [],
    activeStep: null,
    pendingSteps: [],
    concealedCardInstanceIds: [],
    lastQueuedEventSeq: 0,
    lastCompletedEventSeq: 0
  };
}

function isBuyTrade(
  event: Extract<DomainEvent, { type: "TRADE_PAYMENT_COLLECTED" }>,
  priorEvents: readonly DomainEvent[]
): boolean {
  const declared = [...priorEvents]
    .reverse()
    .find(
      (candidate) =>
        candidate.eventSeq < event.eventSeq &&
        candidate.type === "ACTION_DECLARED"
    );
  return (
    declared?.type === "ACTION_DECLARED" &&
    declared.actionType === "DECLARE_BUY"
  );
}

// Multi-card stacks reveal one card per stage, so each card joins the stack
// on its own beat instead of the whole stack appearing at once.
function stagedCardReveal(
  cardCount: number,
  durationMs: number,
  kind: "ACTION" | "REACTION" = "ACTION"
): StepDefinition[] {
  return Array.from({ length: Math.max(1, cardCount) }, () => ({
    kind,
    durationMs
  }));
}

function definitionsForEvent(
  event: DomainEvent,
  profile: PresentationTimingProfile,
  priorEvents: readonly DomainEvent[]
): StepDefinition[] {
  switch (event.type) {
    case "MATCH_STARTED":
      return [{ kind: "INTRO", durationMs: profile.introHoldMs }];
    case "GF_COUNT_CHANGED":
      return [{ kind: "GF_UPDATE", durationMs: profile.stageGapMs }];
    case "ACTION_DECLARED":
      if (event.actionType === "SELL_CARD") {
        return [
          { kind: "ACTION", durationMs: profile.saleRevealMs },
          { kind: "ACTION", durationMs: profile.saleRouteMs }
        ];
      }
      if (event.actionType === "DISCARD" || event.actionType === "SACRIFICE") {
        // The discard card appears first, then each removed card joins the
        // stack one stage at a time.
        return stagedCardReveal(
          (event.actionCardDefinitionIds?.length ?? 0) + 1,
          profile.stageGapMs
        );
      }
      if (event.actionType === "DECLARE_ACTION") {
        const stages = stagedCardReveal(
          event.actionCardDefinitionIds?.length ?? 0,
          profile.attackStageMs
        );
        if (event.actionCardDefinitionIds?.includes("dangerous-pestle")) {
          // A heavy blow: keep the pestle on screen before the attack moves on.
          const last = stages[stages.length - 1];
          if (last) {
            last.durationMs = Math.max(
              last.durationMs,
              DANGEROUS_PESTLE_HOLD_MS
            );
          }
        }
        return stages;
      }
      return [{ kind: "ACTION", durationMs: profile.stageGapMs }];
    case "ATTACK_CREATED":
      return [{ kind: "TARGET", durationMs: profile.attackStageMs }];
    case "ATTACK_REDIRECTED":
      // The defender's card stays up under the "deflected" notice, then the
      // attack card slides to the new actor's side.
      return [
        { kind: "REACTION", durationMs: profile.deflectHoldMs },
        { kind: "TARGET", durationMs: profile.redirectMoveMs }
      ];
    case "HIT_ROLLED":
      return event.hitRate < 100
        ? [{ kind: "HIT_RESULT", durationMs: profile.hitResultMs }]
        : [];
    case "REACTION_REQUESTED":
      return [];
    case "REACTION_DECLARED":
      return stagedCardReveal(
        (event.defenseCardDefinitionIds?.length ?? 0) +
          (event.defenseLearnedMiracleDefinitionIds?.length ?? 0),
        profile.attackStageMs,
        "REACTION"
      );
    case "ATTACK_STOPPED":
      // A wall-style block: show the "stopped" notice like a damage result.
      return [
        {
          kind: "DAMAGE_RESULT",
          durationMs: profile.attackResultMs
        }
      ];
    case "DAMAGE_APPLIED":
      return [
        {
          kind: "DAMAGE_RESULT",
          durationMs: profile.attackResultMs
        }
      ];
    case "RESOURCE_CHANGED":
      if (
        event.resource === "MONEY" &&
        event.reason === "GUARDIAN" &&
        event.delta < 0
      ) {
        return COIN_TRADE_STAGES.map((stage) => ({
          kind: "TRADE",
          durationMs: tradeStageDuration(stage, profile)
        }));
      }
      if (isPhenomenonMoneyChange(event)) {
        // Everybody's money is collected at once: one notice for the whole
        // collection, then every balance changes together.
        const previous = priorEvents.find(
          ({ eventSeq }) => eventSeq === event.eventSeq - 1
        );
        return [
          {
            kind: "AUTOMATIC_EFFECT",
            durationMs: isPhenomenonMoneyChange(previous)
              ? 0
              : profile.resolutionHoldMs
          }
        ];
      }
      if (
        (event.resource === "HP" || event.resource === "MP") &&
        event.delta !== 0 &&
        !(
          event.delta < 0 &&
          (event.reason === "DEMON" || event.reason === "GUARDIAN")
        )
      ) {
        return [
          {
            kind: "HP_UPDATE",
            durationMs: profile.healingHoldMs
          }
        ];
      }
      if (event.reason === "DEMON") {
        return [
          {
            kind: "DEMON_EFFECT",
            durationMs: profile.resolutionHoldMs
          }
        ];
      }
      if (event.reason === "GUARDIAN") {
        return [{ kind: "GUARDIAN", durationMs: profile.stageGapMs }];
      }
      if (event.reason === "CALAMITY") {
        return [{ kind: "CALAMITY", durationMs: profile.stageGapMs }];
      }
      return [
        {
          kind: "HP_UPDATE",
          durationMs: profile.stageGapMs
        }
      ];
    case "RESOURCES_EXCHANGED":
      return [
        { kind: "EXCHANGE", durationMs: profile.stageGapMs },
        { kind: "EXCHANGE", durationMs: profile.stageGapMs },
        { kind: "EXCHANGE", durationMs: profile.exchangeHoldMs }
      ];
    case "TRADE_PAYMENT_COLLECTED": {
      const stages = isBuyTrade(event, priorEvents)
        ? BUY_TRADE_STAGES
        : COIN_TRADE_STAGES;
      return stages.map((stage) => ({
        kind: "TRADE",
        durationMs: tradeStageDuration(stage, profile)
      }));
    }
    case "REVIVAL_RESOLVED":
      return [
        {
          kind: "REVIVAL",
          durationMs: profile.resolutionHoldMs
        }
      ];
    case "ASCENSION_BOW_TRIGGERED":
      // The dying player's 昇天弓 appears, then its 75% roll is shown.
      return [
        { kind: "ASCENSION", durationMs: profile.attackStageMs },
        { kind: "ASCENSION", durationMs: profile.hitResultMs }
      ];
    case "PLAYER_ASCENDED":
      return [
        {
          kind: "ASCENSION",
          durationMs:
            event.reason === "SURRENDER"
              ? profile.exitHoldMs
              : profile.resolutionHoldMs
        }
      ];
    case "GRANT_REQUESTED":
    case "CARD_GRANTED":
    case "CARD_TRANSFERRED":
      return [];
    case "GRANT_CANCELLED":
    case "HAND_LIMIT_DISCARD":
      return [{ kind: "GRANT", durationMs: profile.stageGapMs }];
    case "DEMON_APPEARED":
      return [{ kind: "DEMON", durationMs: profile.resolutionHoldMs }];
    case "DEMON_OBJECT_REMOVED":
    case "DEMON_THEFT_RESOLVED":
      return [{ kind: "DEMON_EFFECT", durationMs: profile.stageGapMs }];
    case "GUARDIAN_ASSIGNED":
      return [
        {
          kind: "GUARDIAN",
          durationMs: profile.resolutionHoldMs + profile.stageGapMs
        }
      ];
    case "GUARDIAN_CHECKED":
      return event.acted
        ? [{ kind: "GUARDIAN", durationMs: profile.stageGapMs }]
        : [];
    case "GUARDIAN_DEPARTED":
    case "POST_TURN_AUTOMATIC_EFFECTS_STARTED":
    case "GUARDIAN_ACTION_SELECTED":
      return [{ kind: "GUARDIAN", durationMs: profile.stageGapMs }];
    case "CALAMITY_APPLIED":
      return [
        {
          kind: "CALAMITY",
          durationMs:
            event.calamity === "DREAM"
              ? DREAM_NOTICE_HOLD_MS
              : profile.attackStageMs
        }
      ];
    case "CALAMITY_WORSENED":
      return [{ kind: "CALAMITY", durationMs: profile.attackStageMs }];
    case "HAND_REDRAWN":
      // Stage 0 flashes the defense card, stage 1 shows 「神器一新」.
      return [
        { kind: "CALAMITY", durationMs: HAND_REDRAW_LEAD_MS },
        { kind: "CALAMITY", durationMs: HAND_REDRAW_HOLD_MS }
      ];
    case "CALAMITIES_REMOVED":
    case "CALAMITY_WORSEN_CHECKED":
      return [{ kind: "CALAMITY", durationMs: profile.stageGapMs }];
    case "CONFUSION_ACTIONS_STARTED":
      return [
        { kind: "AUTOMATIC_EFFECT", durationMs: CONFUSION_NOTICE_HOLD_MS }
      ];
    case "POST_TURN_AUTOMATIC_EFFECTS_COMPLETED":
    case "PHENOMENON_SELECTED":
    case "CONFUSION_ACTION_SELECTED":
    case "CONFUSION_ACTION_COMPLETED":
    case "CONFUSION_ACTIONS_COMPLETED":
      return [
        { kind: "AUTOMATIC_EFFECT", durationMs: profile.stageGapMs }
      ];
    case "TRADE_OFFERED":
      return [{ kind: "TRADE", durationMs: profile.stageGapMs }];
    case "TRADE_RESOLVED":
      // 「買わない」「貧乏」 stay up long enough for every viewer to read.
      return [
        {
          kind: "TRADE",
          durationMs:
            event.resolution === "ACCEPTED"
              ? profile.stageGapMs
              : profile.tradeOfferHoldMs
        }
      ];
    case "MATCH_ENDED":
      return [
        {
          kind: "RESULT",
          durationMs: profile.resolutionHoldMs
        }
      ];
    default:
      return [{ kind: "SYSTEM", durationMs: 0 }];
  }
}

export function presentationStepsForEvent(
  event: DomainEvent,
  profile: PresentationTimingProfile = OFFICIAL_WEB_2026_07_26,
  priorEvents: readonly DomainEvent[] = []
): PresentationStep[] {
  const definitions = definitionsForEvent(event, profile, priorEvents);
  return definitions.map(({ kind, durationMs }, stageIndex) => ({
    stepId: `${event.eventSeq}:${stageIndex}:${kind}`,
    eventSeq: event.eventSeq,
    event,
    kind,
    stageIndex,
    stageCount: definitions.length,
    durationMs
  }));
}

function completeActiveStep(
  state: PresentationQueueState
): PresentationQueueState {
  const activeStep = state.activeStep;
  if (!activeStep) return state;
  const completedEventSeq =
    activeStep.step.stageIndex === activeStep.step.stageCount - 1
      ? activeStep.step.eventSeq
      : state.lastCompletedEventSeq;
  return {
    ...state,
    activeStep: null,
    lastCompletedEventSeq: Math.max(
      state.lastCompletedEventSeq,
      completedEventSeq
    )
  };
}

function startNextStep(
  state: PresentationQueueState,
  nowMs: number
): PresentationQueueState {
  let nextState = state;
  while (!nextState.activeStep && nextState.pendingSteps.length > 0) {
    const step = nextState.pendingSteps[0];
    if (!step) break;
    nextState = {
      ...nextState,
      activeStep: {
        step,
        startedAtMs: nowMs,
        endsAtMs: nowMs + step.durationMs
      },
      pendingSteps: nextState.pendingSteps.slice(1)
    };
    if (step.durationMs === 0) {
      nextState = completeActiveStep(nextState);
    }
  }
  return nextState;
}

function revealConcealedCardsWhenSettled(
  state: PresentationQueueState
): PresentationQueueState {
  if (
    state.activeStep ||
    state.pendingSteps.length > 0 ||
    state.concealedCardInstanceIds.length === 0
  ) {
    return state;
  }
  return {
    ...state,
    concealedCardInstanceIds: []
  };
}

export function advancePresentationClock(
  state: PresentationQueueState,
  nowMs: number
): PresentationQueueState {
  const started = state.activeStep ? state : startNextStep(state, nowMs);
  if (!started.activeStep || nowMs < started.activeStep.endsAtMs) {
    return revealConcealedCardsWhenSettled(started);
  }
  return revealConcealedCardsWhenSettled(
    startNextStep(completeActiveStep(started), nowMs)
  );
}

export function enqueuePresentationEvents(
  state: PresentationQueueState,
  events: readonly DomainEvent[],
  snapshot: GameViewState,
  nowMs: number
): PresentationQueueState {
  const advanced = advancePresentationClock(state, nowMs);
  const newEvents = [...events]
    .sort((left, right) => left.eventSeq - right.eventSeq)
    .filter(({ eventSeq }) => eventSeq > advanced.lastQueuedEventSeq);
  const recentEvents = [...advanced.recentEvents, ...newEvents].slice(-128);
  const grantReasons = new Map(
    recentEvents
      .filter(
        (event): event is Extract<DomainEvent, { type: "GRANT_REQUESTED" }> =>
          event.type === "GRANT_REQUESTED"
      )
      .map(({ obligation }) => [obligation.obligationId, obligation.reason])
  );
  const newSteps = newEvents.flatMap((event) =>
    presentationStepsForEvent(event, advanced.profile, recentEvents)
  );
  const pendingSteps = [
    ...advanced.pendingSteps,
    ...newSteps
  ];
  const presentationWillPlay =
    advanced.activeStep !== null || pendingSteps.length > 0;
  const newlyConcealedCardInstanceIds = presentationWillPlay
    ? newEvents
        .filter(
          (
            event
          ): event is Extract<
            DomainEvent,
            { type: "CARD_GRANTED" | "CARD_TRANSFERRED" }
          > =>
            (event.type === "CARD_GRANTED" &&
              event.playerId === snapshot.self?.playerId &&
              grantReasons.get(event.obligationId) !== "INITIAL") ||
            (event.type === "CARD_TRANSFERRED" &&
              event.toPlayerId === snapshot.self?.playerId)
        )
        .map(({ card }) => card.instanceId)
    : [];
  const queued: PresentationQueueState = {
    ...advanced,
    latestSnapshot: snapshot,
    recentEvents,
    pendingSteps,
    concealedCardInstanceIds: [
      ...new Set([
        ...advanced.concealedCardInstanceIds,
        ...newlyConcealedCardInstanceIds
      ])
    ],
    lastQueuedEventSeq:
      newEvents.at(-1)?.eventSeq ?? advanced.lastQueuedEventSeq
  };
  return revealConcealedCardsWhenSettled(startNextStep(queued, nowMs));
}

export function replacePresentationFromSnapshot(
  state: PresentationQueueState,
  recentEvents: readonly DomainEvent[],
  snapshot: GameViewState,
  nowMs: number
): PresentationQueueState {
  // A match that already ended (e.g. CPUs settled it while everyone was away)
  // is shown as its result at once, without replaying its events.
  if (snapshot.phase === "MATCH_ENDED") {
    const lastEventSeq = recentEvents.reduce(
      (max, { eventSeq }) => Math.max(max, eventSeq),
      0
    );
    return {
      ...createPresentationQueue(state.profile),
      latestSnapshot: snapshot,
      lastQueuedEventSeq: lastEventSeq,
      lastCompletedEventSeq: lastEventSeq
    };
  }
  return enqueuePresentationEvents(
    createPresentationQueue(state.profile),
    recentEvents,
    snapshot,
    nowMs
  );
}

export function applyRealtimePresentationMessage(
  state: PresentationQueueState,
  message: RealtimeMatchMessage,
  nowMs: number
): PresentationQueueState {
  switch (message.type) {
    case "EVENT_BATCH":
      return enqueuePresentationEvents(
        state,
        message.events,
        message.snapshot,
        nowMs
      );
    case "FULL_SNAPSHOT":
      return replacePresentationFromSnapshot(
        state,
        message.recentEvents,
        message.snapshot,
        nowMs
      );
    case "SYNC_ERROR":
      return state;
  }
}

export function skipCurrentPresentation(
  state: PresentationQueueState,
  nowMs: number
): PresentationQueueState {
  const started = state.activeStep ? state : startNextStep(state, nowMs);
  if (!started.activeStep) return revealConcealedCardsWhenSettled(started);
  return revealConcealedCardsWhenSettled(
    startNextStep(completeActiveStep(started), nowMs)
  );
}

export function presentationRemainingMs(
  state: PresentationQueueState,
  nowMs: number
): number {
  if (!state.activeStep) return 0;
  return Math.max(0, state.activeStep.endsAtMs - nowMs);
}

export function isPresentationSettled(
  state: PresentationQueueState
): boolean {
  return state.activeStep === null && state.pendingSteps.length === 0;
}
