import assert from "node:assert/strict";
import test from "node:test";

import { GameCommandApi } from "../packages/server/src/command-api.ts";
import { RealtimeMatchHub } from "../packages/server/src/realtime.ts";
import {
  parseCreateRuntimeMatchRequest,
  RuntimeMatchError,
  RuntimeMatchService
} from "../packages/server/src/runtime-match.ts";

const NOW = "2026-07-26T03:00:00.000Z";

function createService(): RuntimeMatchService {
  return new RuntimeMatchService({
    commandApi: new GameCommandApi(() => NOW),
    realtimeHub: new RealtimeMatchHub(),
    clock: () => NOW
  });
}

test("local match creation defaults to one human creator and one CPU", () => {
  const service = createService();
  const created = service.create({ displayName: "Alice" });

  assert.equal(created.mode, "TRAINING");
  assert.equal(created.participants.length, 2);
  assert.deepEqual(
    created.participants.map(({ displayName, controller }) => ({
      displayName,
      controller
    })),
    [
      { displayName: "Alice", controller: "HUMAN" },
      { displayName: "CPU 1", controller: "CPU" }
    ]
  );
  assert.match(created.matchId, /^match_[A-Za-z0-9_-]{20,}$/u);
  assert.match(created.creator.playerId, /^player_[A-Za-z0-9_-]{20,}$/u);
  assert.match(created.creator.accessToken, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(created.actors.length, 1);
  assert.equal(created.snapshot.self?.playerId, created.creator.playerId);
  assert.equal("seed" in created.snapshot, false);

  const joined = service.join(
    created.matchId,
    created.creator.accessToken
  );
  assert.equal(joined.playerId, created.creator.playerId);
  assert.equal(joined.snapshot.self?.playerId, created.creator.playerId);
  service.close();
});

test("explicit 2 to 9 player setup issues credentials only for human actors", () => {
  const service = createService();
  const created = service.create({
    mode: "ONLINE",
    players: [
      { displayName: "Host", controller: "HUMAN" },
      { displayName: "Guest", controller: "HUMAN" },
      { displayName: "CPU", controller: "CPU" }
    ]
  });

  assert.equal(created.mode, "ONLINE");
  assert.equal(created.participants.length, 3);
  assert.equal(created.actors.length, 2);
  assert.notEqual(
    created.actors[0]?.accessToken,
    created.actors[1]?.accessToken
  );
  for (const actor of created.actors) {
    const joined = service.join(created.matchId, actor.accessToken);
    assert.equal(joined.playerId, actor.playerId);
    assert.equal(joined.snapshot.self?.playerId, actor.playerId);
    assert.equal(
      joined.snapshot.players.every(
        (player) => !("hand" in player) && !("learnedMiracles" in player)
      ),
      true
    );
  }
  service.close();
});

test("runtime request validation rejects invalid counts, duplicate names, and a CPU creator", () => {
  assert.throws(
    () =>
      parseCreateRuntimeMatchRequest({
        players: [{ displayName: "Only", controller: "HUMAN" }]
      }),
    /2 to 9/u
  );
  assert.throws(
    () =>
      parseCreateRuntimeMatchRequest({
        players: [
          { displayName: "Ａlice", controller: "HUMAN" },
          { displayName: "Alice", controller: "CPU" }
        ]
      }),
    /unique/u
  );
  assert.throws(
    () =>
      parseCreateRuntimeMatchRequest({
        players: [
          { displayName: "CPU Host", controller: "CPU" },
          { displayName: "Human", controller: "HUMAN" }
        ]
      }),
    /creator must be HUMAN/u
  );
  assert.throws(
    () =>
      parseCreateRuntimeMatchRequest({
        displayName: "Host",
        cpuCount: 9
      }),
    /1 to 8/u
  );
});

test("join rejects unknown matches and tokens issued for another match", () => {
  const service = createService();
  const first = service.create({ displayName: "First" });
  const second = service.create({ displayName: "Second" });

  assert.throws(
    () => service.join("match_does_not_exist", first.creator.accessToken),
    (error: unknown) =>
      error instanceof RuntimeMatchError &&
      error.code === "MATCH_NOT_FOUND" &&
      error.status === 404
  );
  assert.throws(
    () => service.join(second.matchId, first.creator.accessToken),
    (error: unknown) =>
      error instanceof RuntimeMatchError &&
      error.code === "UNAUTHENTICATED" &&
      error.status === 401
  );
  service.close();
});
