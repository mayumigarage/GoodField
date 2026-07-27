import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalMatchTransport,
  parseStoredLocalActor,
  websocketUrl
} from "../packages/client/src/browser-app.ts";

test("T-050 local actor state is validated without placing its token in a URL", () => {
  const actor = parseStoredLocalActor(JSON.stringify({
    matchId: "match_local",
    playerId: "player_local",
    accessToken: "secret_token",
    lastEventSeq: 42
  }));
  assert.deepEqual(actor, {
    matchId: "match_local",
    playerId: "player_local",
    accessToken: "secret_token",
    lastEventSeq: 42
  });
  assert.equal(parseStoredLocalActor("{broken"), null);
  assert.equal(parseStoredLocalActor(JSON.stringify({
    matchId: "match",
    playerId: "player",
    accessToken: "token",
    lastEventSeq: -1
  })), null);
  assert.equal(
    websocketUrl({
      protocol: "https:",
      host: "play.example.test"
    } as Location),
    "wss://play.example.test/realtime"
  );
});

test("T-050 browser transport creates, restores, and commands through the runtime API", async () => {
  const requests: Array<{
    url: string;
    init: RequestInit | undefined;
  }> = [];
  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "/api/matches") {
      return Response.json({
        ok: true,
        matchId: "match_1",
        creator: {
          playerId: "player_1",
          accessToken: "actor_secret"
        },
        snapshot: { matchId: "match_1", revision: 1 }
      }, { status: 201 });
    }
    if (url.endsWith("/commands")) {
      return Response.json({
        ok: false,
        commandId: "command_1",
        code: "STALE_REVISION",
        message: "stale",
        eventSeq: 4,
        snapshot: { matchId: "match_1", revision: 2 }
      }, { status: 409 });
    }
    return Response.json({
      ok: true,
      playerId: "player_1",
      snapshot: { matchId: "match_1", revision: 1 }
    });
  };
  const transport = createLocalMatchTransport(fetcher);
  const created = await transport.createMatch("Alice", 2);
  const credential = {
    matchId: created.matchId,
    playerId: created.creator.playerId,
    accessToken: created.creator.accessToken,
    lastEventSeq: null
  };
  await transport.restoreMatch(credential);
  const response = await transport.sendCommand(credential, {
    type: "SURRENDER",
    matchId: "match_1",
    commandId: "command_1",
    actorId: "player_1",
    expectedRevision: 1
  });

  assert.equal(response.ok, false);
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "/api/matches",
      "/api/matches/match_1",
      "/api/matches/match_1/commands"
    ]
  );
  assert.equal(
    new Headers(requests[1]?.init?.headers).get("authorization"),
    "Bearer actor_secret"
  );
  assert.equal(requests.some(({ url }) => url.includes("actor_secret")), false);
});
