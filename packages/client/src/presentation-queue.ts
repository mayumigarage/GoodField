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
  resolutionHoldMs: number;
  healingHoldMs: number;
  exchangeHoldMs: number;
  exitHoldMs: number;
  localSelectionDelayMs: number;
};

export const OFFICIAL_WEB_2026_07_25: PresentationTimingProfile = {
  profileId: "OFFICIAL_WEB_2026_07_25",
  introHoldMs: 6_000,
  stageGapMs: 500,
  attackStageMs: 500,
  attackResultMs: 1_000,
  resolutionHoldMs: 1_000,
  healingHoldMs: 1_000,
  exchangeHoldMs: 1_000,
  exitHoldMs: 1_500,
  localSelectionDelayMs: 0
};

export const OFFICIAL_WEB_2026_07_26: PresentationTimingProfile = {
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
    lastQueuedEventSeq: 0,
    lastCompletedEventSeq: 0
  };
}

function definitionsForEvent(
  event: DomainEvent,
  profile: PresentationTimingProfile
): StepDefinition[] {
  switch (event.type) {
    case "MATCH_STARTED":
      return [{ kind: "INTRO", durationMs: profile.introHoldMs }];
    case "GF_COUNT_CHANGED":
      return [{ kind: "GF_UPDATE", durationMs: profile.stageGapMs }];
    case "ACTION_DECLARED":
      return [
        {
          kind: "ACTION",
          durationMs:
            event.actionType === "DECLARE_ACTION"
              ? profile.attackStageMs
              : profile.stageGapMs
        }
      ];
    case "ATTACK_CREATED":
    case "ATTACK_REDIRECTED":
      return [{ kind: "TARGET", durationMs: profile.attackStageMs }];
    case "HIT_ROLLED":
      return event.hitRate < 100
        ? [{ kind: "HIT_RESULT", durationMs: profile.attackResultMs }]
        : [];
    case "REACTION_REQUESTED":
      return [];
    case "REACTION_DECLARED": {
      return [{
        kind: "REACTION",
        durationMs: profile.attackStageMs
      }];
    }
    case "DAMAGE_APPLIED":
      return [
        {
          kind: "DAMAGE_RESULT",
          durationMs: profile.attackResultMs
        }
      ];
    case "RESOURCE_CHANGED":
      if (
        (event.resource === "HP" || event.resource === "MP") &&
        event.delta > 0
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
        {
          kind: "HP_UPDATE",
          durationMs: profile.exchangeHoldMs
        }
      ];
    case "TRADE_PAYMENT_COLLECTED":
      return [
        {
          kind: "HP_UPDATE",
          durationMs: profile.stageGapMs
        }
      ];
    case "REVIVAL_RESOLVED":
      return [
        {
          kind: "REVIVAL",
          durationMs: profile.resolutionHoldMs
        }
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
    case "GUARDIAN_DEPARTED":
    case "POST_TURN_AUTOMATIC_EFFECTS_STARTED":
    case "GUARDIAN_CHECKED":
    case "GUARDIAN_ACTION_SELECTED":
      return [{ kind: "GUARDIAN", durationMs: profile.stageGapMs }];
    case "CALAMITY_APPLIED":
    case "CALAMITY_WORSENED":
      return [{ kind: "CALAMITY", durationMs: profile.attackStageMs }];
    case "CALAMITIES_REMOVED":
    case "CALAMITY_WORSEN_CHECKED":
      return [{ kind: "CALAMITY", durationMs: profile.stageGapMs }];
    case "POST_TURN_AUTOMATIC_EFFECTS_COMPLETED":
    case "PHENOMENON_SELECTED":
    case "CONFUSION_ACTIONS_STARTED":
    case "CONFUSION_ACTION_SELECTED":
    case "CONFUSION_ACTION_COMPLETED":
    case "CONFUSION_ACTIONS_COMPLETED":
      return [
        { kind: "AUTOMATIC_EFFECT", durationMs: profile.stageGapMs }
      ];
    case "TRADE_OFFERED":
    case "TRADE_RESOLVED":
    case "CARD_TRANSFERRED":
      return [{ kind: "TRADE", durationMs: profile.stageGapMs }];
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
  profile: PresentationTimingProfile = OFFICIAL_WEB_2026_07_26
): PresentationStep[] {
  const definitions = definitionsForEvent(event, profile);
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

export function advancePresentationClock(
  state: PresentationQueueState,
  nowMs: number
): PresentationQueueState {
  const started = state.activeStep ? state : startNextStep(state, nowMs);
  if (!started.activeStep || nowMs < started.activeStep.endsAtMs) {
    return started;
  }
  return startNextStep(completeActiveStep(started), nowMs);
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
  const pendingSteps = [
    ...advanced.pendingSteps,
    ...newEvents.flatMap((event) =>
      presentationStepsForEvent(event, advanced.profile)
    )
  ];
  const queued: PresentationQueueState = {
    ...advanced,
    latestSnapshot: snapshot,
    recentEvents: [...advanced.recentEvents, ...newEvents].slice(-128),
    pendingSteps,
    lastQueuedEventSeq:
      newEvents.at(-1)?.eventSeq ?? advanced.lastQueuedEventSeq
  };
  return startNextStep(queued, nowMs);
}

export function replacePresentationFromSnapshot(
  state: PresentationQueueState,
  recentEvents: readonly DomainEvent[],
  snapshot: GameViewState,
  nowMs: number
): PresentationQueueState {
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
  if (!started.activeStep) return started;
  return startNextStep(completeActiveStep(started), nowMs);
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
