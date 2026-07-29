import assert from "node:assert/strict";
import test from "node:test";

import type { DomainEvent } from "../packages/shared/src/model.ts";
import {
  SoundEffectPlayer,
  soundEffectForEvent
} from "../packages/client/src/sound-effects.ts";

const eventBase = {
  eventSeq: 1,
  revision: 1,
  occurredAt: "2026-07-28T00:00:00.000Z",
  visibility: { scope: "PUBLIC" as const }
};

test("domain events select the matching original GoodField effects", () => {
  assert.equal(
    soundEffectForEvent(
      { ...eventBase, type: "HIT_ROLLED", attackId: "a1", hit: false, hitRate: 50 },
      "p1"
    ),
    "miss"
  );
  assert.equal(
    soundEffectForEvent(
      {
        ...eventBase,
        type: "RESOURCE_CHANGED",
        playerId: "p1",
        resource: "HP",
        delta: 10,
        valueAfter: 30,
        reason: "CARD_EFFECT"
      },
      "p1"
    ),
    "healHp"
  );
  assert.equal(
    soundEffectForEvent(
      {
        ...eventBase,
        type: "ATTACK_REDIRECTED",
        attackId: "a1",
        reactionId: "r1",
        actorId: "p2",
        targetPlayerId: "p1",
        reactionDepth: 1,
        redirectType: "REFLECT"
      },
      "p1"
    ),
    "reflect"
  );

  const resultEvent: DomainEvent = {
    ...eventBase,
    type: "MATCH_ENDED",
    result: {
      kind: "WIN",
      winnerPlayerIds: ["p1"],
      winnerTeamId: null
    }
  };
  assert.equal(soundEffectForEvent(resultEvent, "p1"), "win");
  assert.equal(soundEffectForEvent(resultEvent, "p2"), "winner");
});

test("sound player resolves public sound paths and applies its game volume", () => {
  const calls: Array<{ source: string; volume: number }> = [];
  const player = new SoundEffectPlayer((source) => {
    const call = { source, volume: 0 };
    calls.push(call);
    return {
      get volume() {
        return call.volume;
      },
      set volume(value: number) {
        call.volume = value;
      },
      play() {
        return undefined;
      }
    };
  });

  player.play("damage");

  assert.deepEqual(calls, [{ source: "/sounds/damage.mp3", volume: 0.55 }]);
});
