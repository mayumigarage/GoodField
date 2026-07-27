import assert from "node:assert/strict";
import type {
  IncomingMessage,
  ServerResponse
} from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  assertNoServerSecrets,
  connectAuthorizedRealtimeSocket,
  createGameCommandHttpHandler,
  FixedWindowRateLimiter,
  GameCommandApi,
  MAX_COMMAND_BODY_BYTES,
  parseGameCommandRequest,
  RealtimeMatchHub
} from "../packages/server/src/index.ts";
import { createMatch } from "../packages/server/src/engine.ts";
import type { RealtimeMatchMessage } from "../packages/shared/src/protocol.ts";

const NOW = "2026-07-26T07:00:00.000Z";

function setup() {
  const created = createMatch({
    matchId: "t045-security",
    seed: "t045-security-seed",
    mode: "ONLINE",
    now: NOW,
    players: [
      { playerId: "alice", displayName: "Alice" },
      { playerId: "bob", displayName: "Bob" },
      { playerId: "charlie", displayName: "Charlie" }
    ]
  });
  const api = new GameCommandApi(() => NOW);
  api.registerMatch(created.state);
  return { created, api };
}

test("T-045 rejects actor spoofing, foreign cards, invalid targets, and MP fields", () => {
  const { created, api } = setup();
  const state = created.state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const otherPlayerId = state.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(otherPlayerId);
  const otherCardId = state.players[otherPlayerId]?.hand[0]?.instanceId;
  assert.ok(otherCardId);

  const forged = api.execute({
    authenticatedPlayerId: otherPlayerId,
    matchId: state.matchId,
    body: {
      type: "PRAY",
      matchId: state.matchId,
      commandId: "forged-actor",
      actorId,
      expectedRevision: state.revision
    }
  });
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.code, "INVALID_ACTOR");

  const foreignCard = api.execute({
    authenticatedPlayerId: actorId,
    matchId: state.matchId,
    body: {
      type: "DECLARE_ACTION",
      matchId: state.matchId,
      commandId: "foreign-card",
      actorId,
      expectedRevision: state.revision,
      cardInstanceIds: [otherCardId],
      targetPlayerId: otherPlayerId
    }
  });
  assert.equal(foreignCard.ok, false);
  if (!foreignCard.ok) assert.equal(foreignCard.code, "CARD_NOT_FOUND");

  const ownCardId = state.players[actorId]?.hand[0]?.instanceId;
  assert.ok(ownCardId);
  const invalidTarget = api.execute({
    authenticatedPlayerId: actorId,
    matchId: state.matchId,
    body: {
      type: "DECLARE_ACTION",
      matchId: state.matchId,
      commandId: "invalid-target",
      actorId,
      expectedRevision: state.revision,
      cardInstanceIds: [ownCardId],
      targetPlayerId: "not-a-player"
    }
  });
  assert.equal(invalidTarget.ok, false);
  if (!invalidTarget.ok) assert.equal(invalidTarget.code, "INVALID_TARGET");

  const mpTampering = parseGameCommandRequest({
    type: "PRAY",
    matchId: state.matchId,
    commandId: "mp-tampering",
    actorId,
    expectedRevision: state.revision,
    mp: 99
  });
  assert.equal(mpTampering.ok, false);
});

test("T-045 bounds identifiers, selection count, request bytes, and rate", async () => {
  const oversizedId = "x".repeat(129);
  assert.equal(parseGameCommandRequest({
    type: "PRAY",
    matchId: "match",
    commandId: oversizedId,
    actorId: "actor",
    expectedRevision: 0
  }).ok, false);
  assert.equal(parseGameCommandRequest({
    type: "DECLARE_ACTION",
    matchId: "match",
    commandId: "too-many-cards",
    actorId: "actor",
    expectedRevision: 0,
    cardInstanceIds: Array.from({ length: 65 }, (_, index) => `card-${index}`),
    targetPlayerId: "target"
  }).ok, false);

  const { created, api } = setup();
  const actorId = created.state.activePlayerId!;
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({
    limit: 2,
    windowMs: 10_000,
    clock: () => now
  });
  const handler = createGameCommandHttpHandler(
    api,
    () => actorId,
    {
      maxRequestBodyBytes: MAX_COMMAND_BODY_BYTES,
      rateLimiter: limiter
    }
  );
  const body = JSON.stringify({
    type: "PRAY",
    matchId: created.state.matchId,
    commandId: "rate-limited-command",
    actorId,
    expectedRevision: created.state.revision
  });
  const invoke = async (payload: string) => {
    const request = Readable.from([payload]) as unknown as IncomingMessage;
    request.method = "POST";
    request.url = `/matches/${created.state.matchId}/commands`;
    const headers = new Map<string, string>();
    let responseBody = "";
    const response = {
      statusCode: 0,
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), String(value));
      },
      end(value: string) {
        responseBody = value;
      }
    } as unknown as ServerResponse;
    await handler(request, response);
    return {
      statusCode: response.statusCode,
      headers,
      body: JSON.parse(responseBody) as { code?: string }
    };
  };

  await invoke(body);
  await invoke(body);
  const limited = await invoke(body);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.equal(limited.headers.get("retry-after"), "10");

  now += 10_000;
  const oversized = await invoke(JSON.stringify({
    padding: "x".repeat(MAX_COMMAND_BODY_BYTES)
  }));
  assert.equal(oversized.statusCode, 413);
});

test("T-045 authenticates and authorizes player and spectator sockets", () => {
  const { created } = setup();
  const hub = new RealtimeMatchHub();
  hub.registerMatch(created.state, created.events);
  const connect = (
    credentials: unknown,
    authorizeSpectator: boolean
  ): RealtimeMatchMessage => {
    const sent: string[] = [];
    connectAuthorizedRealtimeSocket(hub, {
      request: {
        type: "SYNC_MATCH",
        matchId: created.state.matchId,
        lastEventSeq: null
      },
      credentials,
      socket: { send: (data) => sent.push(data) }
    }, {
      authenticate: (candidate) =>
        typeof candidate === "string"
          ? { subjectId: candidate }
          : null,
      authorize: (principal) => {
        if (created.state.players[principal.subjectId]) {
          return { kind: "PLAYER", playerId: principal.subjectId };
        }
        return authorizeSpectator && principal.subjectId === "spectator-1"
          ? { kind: "SPECTATOR" }
          : null;
      }
    });
    assert.equal(sent.length, 1);
    return JSON.parse(sent[0]!) as RealtimeMatchMessage;
  };

  const unauthenticated = connect(null, false);
  assert.equal(unauthenticated.type, "SYNC_ERROR");
  if (unauthenticated.type === "SYNC_ERROR") {
    assert.equal(unauthenticated.code, "UNAUTHENTICATED");
  }
  const outsider = connect("outsider", false);
  assert.equal(outsider.type, "SYNC_ERROR");
  if (outsider.type === "SYNC_ERROR") {
    assert.equal(outsider.code, "VIEWER_NOT_ALLOWED");
  }
  const player = connect("alice", false);
  assert.equal(player.type, "FULL_SNAPSHOT");
  if (player.type === "FULL_SNAPSHOT") {
    assert.equal(player.snapshot.self?.playerId, "alice");
  }
  const spectator = connect("spectator-1", true);
  assert.equal(spectator.type, "FULL_SNAPSHOT");
  if (spectator.type === "FULL_SNAPSHOT") {
    assert.equal(spectator.snapshot.self, null);
  }
});

test("T-045 rejects server secrets in public payloads", () => {
  assert.doesNotThrow(() =>
    assertNoServerSecrets({ snapshot: { revision: 1, players: [] } })
  );
  for (const key of [
    "seed",
    "rng",
    "rngState",
    "rngIndex",
    "randomLog",
    "processedCommands",
    "pendingAction"
  ]) {
    assert.throws(
      () => assertNoServerSecrets({ nested: { [key]: "secret" } }),
      /server-only field/u
    );
  }
});
