import assert from "node:assert/strict";
import test from "node:test";

import {
  CARD_DEFINITIONS_BY_ID,
  DEMON_GRANT_POOL,
  NORMAL_GRANT_POOL,
  STANDARD_CARD_DEFINITIONS,
  validateStandardCatalog
} from "../packages/shared/src/cards.ts";
import type { CardDefinition } from "../packages/shared/src/card-types.ts";
import {
  HANDLED_EFFECT_INSTRUCTION_KINDS,
  HANDLED_SPECIAL_EFFECT_OPERATIONS
} from "../packages/server/src/engine.ts";

test("official catalog contains all 296 entries and a weight-500 grant pool", () => {
  assert.deepEqual(validateStandardCatalog(), []);
  assert.equal(STANDARD_CARD_DEFINITIONS.length, 296);
  assert.equal(NORMAL_GRANT_POOL.length, 237);
  assert.equal(
    NORMAL_GRANT_POOL.reduce((sum, candidate) => sum + candidate.weight, 0),
    500
  );
  for (const candidate of NORMAL_GRANT_POOL) {
    assert.equal(
      CARD_DEFINITIONS_BY_ID.get(candidate.key),
      candidate.value,
      `grantable definition ${candidate.key} must be loadable by ID`
    );
  }
  assert.equal(DEMON_GRANT_POOL.length, 5);
  assert.equal(
    DEMON_GRANT_POOL.reduce((sum, candidate) => sum + candidate.weight, 0),
    25
  );
});

test("normal grant cards use the stable official IDs from the specification", () => {
  const ids = new Set(NORMAL_GRANT_POOL.map(({ key }) => key));
  assert.ok(ids.has("bronze-club"));
  assert.ok(ids.has("sun-amulet"));
  assert.ok(ids.has("release"));
  assert.equal(
    [...ids].some((id) => /^(weapon|armor|goods|miracle)-/u.test(id)),
    false
  );
});

test("every official entry has at least one machine-readable instruction", () => {
  const definitions: readonly CardDefinition[] = STANDARD_CARD_DEFINITIONS;
  assert.equal(
    definitions.some(
      ({ instructions }) =>
        instructions.length === 0 ||
        instructions.some(
          (instruction) =>
            instruction.kind === "SPECIAL" &&
            instruction.operation === "UNKNOWN_OFFICIAL_EFFECT"
        )
    ),
    false
  );
});

test("every instruction used by the official catalog has a registered engine handler", () => {
  for (const definition of STANDARD_CARD_DEFINITIONS) {
    for (const instruction of definition.instructions) {
      assert.equal(
        HANDLED_EFFECT_INSTRUCTION_KINDS.has(instruction.kind),
        true,
        `${definition.cardDefinitionId}: ${instruction.kind}`
      );
      if (instruction.kind === "SPECIAL") {
        assert.equal(
          HANDLED_SPECIAL_EFFECT_OPERATIONS.has(
            instruction.operation
          ),
          true,
          `${definition.cardDefinitionId}: ${instruction.operation}`
        );
      }
    }
  }
});
