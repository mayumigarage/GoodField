import assert from "node:assert/strict";
import test from "node:test";

import {
  GameCommandApi,
  parseGameCommandRequest
} from "../packages/server/src/command-api.ts";
import { createMatch } from "../packages/server/src/engine.ts";

const NOW = "2026-07-26T01:00:00.000Z";

function createApi(playerCount = 3): {
  api: GameCommandApi;
  playerIds: string[];
  matchId: string;
} {
  const matchId = `api-match-${playerCount}`;
  const playerIds = Array.from(
    { length: playerCount },
    (_, index) => `player-${index}`
  );
  const created = createMatch({
    matchId,
    seed: `api-seed-${playerCount}`,
    players: playerIds.map((playerId) => ({
      playerId,
      displayName: playerId
    })),
    now: NOW
  });
  const api = new GameCommandApi(() => NOW);
  api.registerMatch(created.state);
  return { api, playerIds, matchId };
}

test("command API parser accepts action, defense, prayer, surrender, and purchase confirmation", () => {
  const base = {
    matchId: "match",
    commandId: "command",
    actorId: "actor",
    expectedRevision: 4
  };
  const commands = [
    {
      ...base,
      type: "DECLARE_ACTION",
      cardInstanceIds: ["weapon"],
      learnedMiracleIds: [],
      targetPlayerId: "target"
    },
    {
      ...base,
      type: "DECLARE_REACTION",
      reactionId: "reaction",
      defenseCardInstanceIds: [],
      defenseLearnedMiracleIds: []
    },
    { ...base, type: "PRAY" },
    { ...base, type: "SURRENDER" },
    { ...base, type: "CONFIRM_BUY", tradeId: "trade", accept: true }
  ];

  for (const command of commands) {
    const parsed = parseGameCommandRequest(command);
    assert.equal(parsed.ok, true, command.type);
  }
});

test("command API rejects malformed payloads and client-controlled timestamps", () => {
  const malformed = parseGameCommandRequest({
    type: "PRAY",
    matchId: "match",
    commandId: "command",
    actorId: "actor",
    expectedRevision: 0,
    occurredAt: "1999-01-01T00:00:00.000Z"
  });
  assert.equal(malformed.ok, false);
  if (malformed.ok) return;
  assert.match(malformed.message, /unsupported fields/u);
});

test("command API applies a command and returns only the actor snapshot", () => {
  const { api, matchId } = createApi();
  const state = api.matchState(matchId);
  assert.ok(state?.activePlayerId);
  const actorId = state.activePlayerId;

  const response = api.execute({
    authenticatedPlayerId: actorId,
    matchId,
    body: {
      type: "SURRENDER",
      matchId,
      commandId: "first-surrender",
      actorId,
      expectedRevision: state.revision
    }
  });

  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.commandId, "first-surrender");
  assert.equal(response.duplicate, false);
  assert.equal(response.snapshot.self?.playerId, actorId);
  assert.equal(response.snapshot.players.find(
    ({ playerId }) => playerId === actorId
  )?.alive, false);
  assert.equal(response.eventSeq, api.matchState(matchId)?.eventSequence);
  assert.equal("rng" in response.snapshot, false);
  assert.equal("processedCommands" in response.snapshot, false);
});

test("command API authenticates the actor and returns the latest snapshot on rejection", () => {
  const { api, matchId, playerIds } = createApi();
  const state = api.matchState(matchId);
  assert.ok(state?.activePlayerId);
  const actorId = state.activePlayerId;
  const otherPlayerId = playerIds.find((playerId) => playerId !== actorId);
  assert.ok(otherPlayerId);

  const forged = api.execute({
    authenticatedPlayerId: otherPlayerId,
    matchId,
    body: {
      type: "SURRENDER",
      matchId,
      commandId: "forged-surrender",
      actorId,
      expectedRevision: state.revision
    }
  });
  assert.equal(forged.ok, false);
  if (forged.ok) return;
  assert.equal(forged.code, "INVALID_ACTOR");
  assert.equal(forged.snapshot?.revision, state.revision);
  assert.equal(forged.snapshot?.self?.playerId, otherPlayerId);
  assert.equal(api.matchState(matchId), state);

  const stale = api.execute({
    authenticatedPlayerId: actorId,
    matchId,
    body: {
      type: "SURRENDER",
      matchId,
      commandId: "stale-surrender",
      actorId,
      expectedRevision: state.revision - 1
    }
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.code, "STALE_REVISION");
  assert.equal(stale.snapshot?.revision, state.revision);
});

test("unauthenticated users and non-members cannot obtain a match snapshot", () => {
  const { api, matchId } = createApi();
  const state = api.matchState(matchId);
  assert.ok(state?.activePlayerId);
  const body = {
    type: "SURRENDER",
    matchId,
    commandId: "private-match",
    actorId: state.activePlayerId,
    expectedRevision: state.revision
  };

  const unauthenticated = api.execute({
    authenticatedPlayerId: null,
    matchId,
    body
  });
  assert.equal(unauthenticated.ok, false);
  if (unauthenticated.ok) return;
  assert.equal(unauthenticated.code, "UNAUTHENTICATED");
  assert.equal(unauthenticated.snapshot, null);

  const outsider = api.execute({
    authenticatedPlayerId: "not-a-member",
    matchId,
    body
  });
  assert.equal(outsider.ok, false);
  if (outsider.ok) return;
  assert.equal(outsider.code, "INVALID_ACTOR");
  assert.equal(outsider.snapshot, null);
});

test("identical command retries return the exact original result after the match advances", () => {
  const { api, matchId } = createApi(4);
  const initial = api.matchState(matchId);
  assert.ok(initial?.activePlayerId);
  const firstActorId = initial.activePlayerId;
  const firstCommand = {
    type: "SURRENDER",
    matchId,
    commandId: "retryable-surrender",
    actorId: firstActorId,
    expectedRevision: initial.revision
  };
  const first = api.execute({
    authenticatedPlayerId: firstActorId,
    matchId,
    body: firstCommand
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const advanced = api.matchState(matchId);
  assert.ok(advanced?.activePlayerId);
  const secondActorId = advanced.activePlayerId;
  const second = api.execute({
    authenticatedPlayerId: secondActorId,
    matchId,
    body: {
      type: "SURRENDER",
      matchId,
      commandId: "second-surrender",
      actorId: secondActorId,
      expectedRevision: advanced.revision
    }
  });
  assert.equal(second.ok, true);
  assert.notEqual(api.matchState(matchId)?.revision, first.snapshot.revision);

  const retry = api.execute({
    authenticatedPlayerId: firstActorId,
    matchId,
    body: firstCommand
  });
  assert.deepEqual(retry, first);

  const conflict = api.execute({
    authenticatedPlayerId: firstActorId,
    matchId,
    body: { ...firstCommand, expectedRevision: initial.revision + 1 }
  });
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.code, "DUPLICATE_COMMAND_CONFLICT");
  assert.equal(
    conflict.snapshot?.revision,
    api.matchState(matchId)?.revision
  );
});
