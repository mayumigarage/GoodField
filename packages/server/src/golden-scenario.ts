import type {
  CreateMatchInput,
  DomainEvent,
  GameCommand,
  MatchState
} from "../../shared/src/model.ts";
import type { RandomEvent } from "../../shared/src/rng.ts";
import { createMatch } from "./engine.ts";
import { advanceCpuControllers } from "./session.ts";

export const GOLDEN_SCENARIO_SCHEMA_VERSION = 1;
export const GOLDEN_SCENARIO_OCCURRED_AT =
  "2026-07-26T00:00:00.000Z";

export type GoldenScenarioSpec = {
  scenarioId: string;
  description: string;
  matchId: string;
  seed: string;
  playerCount: 2 | 4;
  endTimeThreshold: 1 | null;
};

export type GoldenScenarioFixture = {
  schemaVersion: typeof GOLDEN_SCENARIO_SCHEMA_VERSION;
  scenarioId: string;
  description: string;
  input: CreateMatchInput;
  rulesetVersion: string;
  cardPoolVersion: string;
  commands: GameCommand[];
  randomLog: RandomEvent[];
  events: DomainEvent[];
  finalState: MatchState;
};

export const GOLDEN_SCENARIO_SPECS: readonly GoldenScenarioSpec[] = [
  {
    scenarioId: "normal-2p",
    description: "通常の2人戦",
    matchId: "golden-normal-2p",
    seed: "goodfield-golden-normal-2p-v1",
    playerCount: 2,
    endTimeThreshold: null
  },
  {
    scenarioId: "end-time-gf1-2p",
    description: "終末GF.1の2人戦",
    matchId: "golden-end-time-gf1-2p",
    seed: "goodfield-golden-end-time-gf1-2p-v1",
    playerCount: 2,
    endTimeThreshold: 1
  },
  {
    scenarioId: "end-time-gf1-4p",
    description: "終末GF.1の4人戦",
    matchId: "golden-end-time-gf1-4p",
    seed: "goodfield-golden-end-time-gf1-4p-v1",
    playerCount: 4,
    endTimeThreshold: 1
  }
] as const;

function inputFor(spec: GoldenScenarioSpec): CreateMatchInput {
  return {
    matchId: spec.matchId,
    seed: spec.seed,
    mode: "TRAINING",
    endTimeThreshold: spec.endTimeThreshold,
    now: GOLDEN_SCENARIO_OCCURRED_AT,
    players: Array.from({ length: spec.playerCount }, (_, index) => ({
      playerId: `player-${index + 1}`,
      displayName: `Player ${index + 1}`,
      controller: "CPU"
    }))
  };
}

export function generateGoldenScenario(
  spec: GoldenScenarioSpec
): GoldenScenarioFixture {
  const input = inputFor(spec);
  const created = createMatch(input);
  const advanced = advanceCpuControllers(
    created.state,
    GOLDEN_SCENARIO_OCCURRED_AT,
    20_000
  );
  if (advanced.decisionLimitReached || advanced.state.phase !== "MATCH_ENDED") {
    throw new Error(`Golden scenario ${spec.scenarioId} did not finish`);
  }
  const events = [...created.events, ...advanced.events];
  if (
    events.at(-1)?.eventSeq !== advanced.state.eventSequence ||
    events.some(
      (event, index) =>
        index > 0 &&
        event.eventSeq !== (events[index - 1]?.eventSeq ?? 0) + 1
    )
  ) {
    throw new Error(`Golden scenario ${spec.scenarioId} has an invalid event log`);
  }
  return {
    schemaVersion: GOLDEN_SCENARIO_SCHEMA_VERSION,
    scenarioId: spec.scenarioId,
    description: spec.description,
    input,
    rulesetVersion: advanced.state.rulesetVersion,
    cardPoolVersion: advanced.state.cardPoolVersion,
    commands: structuredClone(advanced.commands),
    randomLog: structuredClone(advanced.state.randomLog),
    events: structuredClone(events),
    finalState: structuredClone(advanced.state)
  };
}

export function generateAllGoldenScenarios(): GoldenScenarioFixture[] {
  return GOLDEN_SCENARIO_SPECS.map(generateGoldenScenario);
}
