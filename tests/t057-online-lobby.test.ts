import assert from "node:assert/strict";
import test from "node:test";

import {
  createOnlineRoomTransport
} from "../packages/client/src/online-lobby.ts";
import {
  parseStoredOnlineCredential
} from "../packages/client/src/browser-app.ts";

test("T-057 lobby transport uses cookie credentials and CSRF", async () => {
  const requests: Array<{
    input: string;
    init: RequestInit | undefined;
  }> = [];
  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({
      ok: true,
      room: {
        roomId: "room_online",
        status: "OPEN",
        seatCount: 2,
        allowSpectators: false,
        createdAt: "2026-07-26T00:00:00.000Z",
        expiresAt: "2026-07-26T02:00:00.000Z",
        matchId: null,
        seats: [],
        canStart: false
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const transport = createOnlineRoomTransport(fetcher);
  await transport.ready("room_online", "csrf-secret", true);
  const request = requests[0];
  assert.equal(request?.input, "/api/rooms/room_online/ready");
  assert.equal(request?.init?.credentials, "same-origin");
  assert.equal(
    (request?.init?.headers as Record<string, string>)
      ["x-goodfield-csrf"],
    "csrf-secret"
  );
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { ready: true });
});

test("T-057 hidden brawl transport joins by passphrase without exposing a room id", async () => {
  const requests: Array<{
    input: string;
    init: RequestInit | undefined;
  }> = [];
  const transport = createOnlineRoomTransport(async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({
      ok: true,
      room: {
        roomId: "room_hidden",
        accessMode: "PASSPHRASE",
        status: "OPEN",
        seatCount: 2,
        allowSpectators: false,
        createdAt: "2026-07-26T00:00:00.000Z",
        expiresAt: "2026-07-26T02:00:00.000Z",
        matchId: null,
        seats: [],
        canStart: false
      },
      participantId: "participant_hidden",
      csrfToken: "csrf-hidden"
    });
  });

  await transport.join({
    displayName: "参加者",
    passphrase: "秘密の花園",
    requestId: "browser-passphrase-join"
  });
  await transport.setTeam("room_hidden", "csrf-hidden", "TEAM_3");
  await transport.shuffleTeams("room_hidden", "csrf-hidden");
  await transport.setEndTime("room_hidden", "csrf-hidden", 150);

  assert.equal(requests[0]?.input, "/api/rooms/join");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    displayName: "参加者",
    passphrase: "秘密の花園",
    requestId: "browser-passphrase-join"
  });
  assert.equal(
    requests[0]?.input.includes("秘密の花園"),
    false
  );
  assert.deepEqual(
    requests.slice(1).map(({ input }) => input),
    [
      "/api/rooms/room_hidden/team",
      "/api/rooms/room_hidden/shuffle-teams",
      "/api/rooms/room_hidden/end-time"
    ]
  );
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
    teamId: "TEAM_3"
  });
  assert.deepEqual(JSON.parse(String(requests[3]?.init?.body)), {
    endTimeThreshold: 150
  });
});

test("T-057 persisted admission never accepts malformed browser state", () => {
  const valid = {
    roomId: "room_online",
    participantId: "participant_online",
    rejoinToken: "rejoin-token",
    csrfToken: "csrf-token",
    inviteUrl: null,
    matchId: null,
    lastEventSeq: 12
  };
  assert.deepEqual(
    parseStoredOnlineCredential(JSON.stringify(valid)),
    valid
  );
  assert.equal(
    parseStoredOnlineCredential(JSON.stringify({
      ...valid,
      lastEventSeq: -1
    })),
    null
  );
  assert.equal(
    parseStoredOnlineCredential('{"roomId":"room","csrfToken":1}'),
    null
  );
});
