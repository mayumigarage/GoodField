import assert from "node:assert/strict";
import test from "node:test";

import {
  createRng,
  drawWeighted,
  shuffleDeterministically
} from "../packages/shared/src/rng.ts";
import { NORMAL_GRANT_POOL } from "../packages/shared/src/cards.ts";

test("weighted selection is deterministic and independent of candidate order", () => {
  const candidates = [
    { key: "c", weight: 10, value: "C" },
    { key: "a", weight: 1, value: "A" },
    { key: "b", weight: 4, value: "B" }
  ];
  const first = drawWeighted(createRng("same-seed"), candidates, "OTHER", 4);
  const second = drawWeighted(
    createRng("same-seed"),
    [...candidates].reverse(),
    "OTHER",
    4
  );
  assert.equal(first.value, second.value);
  assert.deepEqual(first.state, second.state);
  assert.deepEqual(first.audit, second.audit);
  assert.equal(first.audit.rngIndex, 0);
  assert.equal(first.state.index, 1);
});

test("normal grants draw with replacement and can repeat the same artifact", () => {
  const first = drawWeighted(
    createRng("repeat-36"),
    NORMAL_GRANT_POOL,
    "CARD_GRANT",
    1
  );
  const second = drawWeighted(
    first.state,
    NORMAL_GRANT_POOL,
    "CARD_GRANT",
    2
  );

  assert.equal(first.key, "final-tusk");
  assert.equal(second.key, first.key);
  assert.equal(first.audit.candidatesHash, second.audit.candidatesHash);
});

test("shuffle produces a stable permutation and records every random use", () => {
  const input = ["p3", "p1", "p2"].map((value) => ({ key: value, value }));
  const first = shuffleDeterministically(
    createRng("turn-order"),
    input,
    "TURN_ORDER",
    1
  );
  const second = shuffleDeterministically(
    createRng("turn-order"),
    input,
    "TURN_ORDER",
    1
  );
  assert.deepEqual(first, second);
  assert.deepEqual([...first.values].sort(), ["p1", "p2", "p3"]);
  assert.equal(first.audits.length, 3);
  assert.equal(first.state.index, 3);
});

test("invalid weights are rejected", () => {
  assert.throws(
    () =>
      drawWeighted(
        createRng("bad"),
        [{ key: "x", weight: 0, value: "X" }],
        "OTHER",
        1
      ),
    /Invalid weight/u
  );
});
