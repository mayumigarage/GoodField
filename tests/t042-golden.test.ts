import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GOLDEN_SCENARIO_SPECS,
  generateAllGoldenScenarios
} from "../packages/server/src/golden-scenario.ts";
import type {
  GoldenScenarioFixture
} from "../packages/server/src/golden-scenario.ts";

function storedFixture(scenarioId: string): GoldenScenarioFixture {
  return JSON.parse(readFileSync(
    new URL(
      `./fixtures/golden/${scenarioId}.json`,
      import.meta.url
    ),
    "utf8"
  )) as GoldenScenarioFixture;
}

test("T-042 stores the three required fixed-seed golden scenarios", () => {
  assert.deepEqual(
    GOLDEN_SCENARIO_SPECS.map((spec) => ({
      playerCount: spec.playerCount,
      endTimeThreshold: spec.endTimeThreshold
    })),
    [
      { playerCount: 2, endTimeThreshold: null },
      { playerCount: 2, endTimeThreshold: 1 },
      { playerCount: 4, endTimeThreshold: 1 }
    ]
  );

  const generated = generateAllGoldenScenarios();
  for (const fixture of generated) {
    assert.deepEqual(storedFixture(fixture.scenarioId), fixture);
    assert.equal(fixture.finalState.phase, "MATCH_ENDED");
    assert.equal(fixture.commands.length > 0, true);
    assert.equal(fixture.randomLog.length > 0, true);
    assert.equal(
      fixture.events.at(-1)?.eventSeq,
      fixture.finalState.eventSequence
    );
    assert.equal(
      fixture.rulesetVersion,
      fixture.finalState.rulesetVersion
    );
    assert.equal(
      fixture.cardPoolVersion,
      fixture.finalState.cardPoolVersion
    );
  }
});
