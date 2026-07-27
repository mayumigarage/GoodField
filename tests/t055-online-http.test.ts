import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import {
  GoodFieldServer
} from "../packages/server/src/runtime-server.ts";

type Admission = {
  ok: true;
  room: {
    roomId: string;
    accessMode?: string;
    status: string;
    seatCount?: number;
    matchId: string | null;
  };
  participantId: string;
  rejoinToken: string;
  csrfToken: string;
  inviteUrl?: string;
};

function cookie(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function roomPost(
  url: string,
  origin: string,
  body: unknown,
  credential?: { cookie: string; csrfToken: string }
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(credential
        ? {
            cookie: credential.cookie,
            "x-goodfield-csrf": credential.csrfToken
          }
        : {})
    },
    body: JSON.stringify(body)
  });
}

test("T-055 HTTP lifecycle uses cookie sessions through room start and realtime sync", async (context) => {
  const server = new GoodFieldServer({
    host: "127.0.0.1",
    port: 0,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages"),
    schedulerIntervalMs: 10
  });
  context.after(async () => {
    await server.stop();
  });
  const address = await server.start();

  const createResponse = await roomPost(
    `${address.url}/api/rooms`,
    address.url,
    {
      displayName: "Host",
      seatCount: 2,
      allowSpectators: true,
      requestId: "http-create-room"
    }
  );
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as Admission;
  const host = {
    cookie: cookie(createResponse),
    csrfToken: created.csrfToken
  };
  const invitation = new URL(created.inviteUrl ?? "");
  const inviteCode = invitation.searchParams.get("invite");
  assert.ok(inviteCode);
  assert.equal(created.inviteUrl?.includes("goodfield_session"), false);

  const forgedOrigin = await roomPost(
    `${address.url}/api/rooms/${created.room.roomId}/join`,
    "https://evil.example",
    {
      displayName: "Mallory",
      inviteCode,
      requestId: "http-forged-origin"
    }
  );
  assert.equal(forgedOrigin.status, 403);

  const joinResponse = await roomPost(
    `${address.url}/api/rooms/${created.room.roomId}/join`,
    address.url,
    {
      displayName: "Guest",
      inviteCode,
      requestId: "http-join-room"
    }
  );
  assert.equal(joinResponse.status, 200);
  const joined = await joinResponse.json() as Admission;
  const guest = {
    cookie: cookie(joinResponse),
    csrfToken: joined.csrfToken
  };

  for (const credential of [host, guest]) {
    const ready = await roomPost(
      `${address.url}/api/rooms/${created.room.roomId}/ready`,
      address.url,
      { ready: true },
      credential
    );
    assert.equal(ready.status, 200);
  }
  const csrfFailure = await fetch(
    `${address.url}/api/rooms/${created.room.roomId}/ready`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: guest.cookie,
        origin: address.url
      },
      body: JSON.stringify({ ready: true })
    }
  );
  assert.equal(csrfFailure.status, 403);

  const startResponse = await roomPost(
    `${address.url}/api/rooms/${created.room.roomId}/start`,
    address.url,
    { requestId: "http-start-room" },
    host
  );
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json() as {
    ok: true;
    matchId: string;
    snapshot: {
      matchId: string;
      revision: number;
      self: { playerId: string };
    };
  };

  const socket = new WebSocket(
    `${address.url.replace(/^http/u, "ws")}/realtime`,
    "goodfield",
    {
      headers: {
        cookie: host.cookie,
        origin: address.url
      }
    }
  );
  context.after(() => socket.terminate());
  await once(socket, "open");
  const messages: unknown[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as unknown);
  });
  socket.send(JSON.stringify({
    type: "SYNC_MATCH",
    matchId: started.matchId,
    lastEventSeq: null
  }));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for room sync")),
      3_000
    );
    const poll = setInterval(() => {
      if (
        messages.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "FULL_SNAPSHOT"
        )
      ) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 5);
  });
  const synchronized = messages.find(
    (value): value is {
      type: "FULL_SNAPSHOT";
      snapshot: {
        revision: number;
        activePlayerId: string;
        self: { playerId: string };
      };
    } =>
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "FULL_SNAPSHOT" &&
      "snapshot" in value
  );
  assert.ok(synchronized);

  const commandWithoutCsrf = await fetch(
    `${address.url}/api/matches/${started.matchId}/commands`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: host.cookie,
        origin: address.url
      },
      body: JSON.stringify({
        type: "SURRENDER",
        matchId: started.matchId,
        commandId: "missing-csrf-command",
        actorId: synchronized.snapshot.self.playerId,
        expectedRevision: synchronized.snapshot.revision
      })
    }
  );
  assert.equal(commandWithoutCsrf.status, 401);

  const activeCredential =
    synchronized.snapshot.activePlayerId ===
    synchronized.snapshot.self.playerId
      ? {
          credential: host,
          snapshot: synchronized.snapshot
        }
      : {
          credential: guest,
          snapshot: (await (await fetch(
            `${address.url}/api/rooms/${created.room.roomId}/match`,
            {
              headers: {
                cookie: guest.cookie,
                origin: address.url
              }
            }
          )).json() as {
            snapshot: {
              revision: number;
              self: { playerId: string };
            };
          }).snapshot
        };
  const command = await fetch(
    `${address.url}/api/matches/${started.matchId}/commands`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: activeCredential.credential.cookie,
        origin: address.url,
        "x-goodfield-csrf": activeCredential.credential.csrfToken
      },
      body: JSON.stringify({
        type: "SURRENDER",
        matchId: started.matchId,
        commandId: "room-host-surrender",
        actorId: activeCredential.snapshot.self.playerId,
        expectedRevision: activeCredential.snapshot.revision
      })
    }
  );
  const commandBody = await command.json() as {
    ok: boolean;
    snapshot: { result: unknown };
    code?: string;
    message?: string;
  };
  assert.equal(
    command.status,
    200,
    JSON.stringify(commandBody)
  );
  assert.equal(commandBody.ok, true);
  assert.ok(commandBody.snapshot.result);
  assert.equal(JSON.stringify(commandBody).includes('"rng"'), false);
  socket.close();
  await once(socket, "close");
});

test("T-055 hidden brawl joins by a Japanese passphrase without a room id or invite URL", async (context) => {
  const server = new GoodFieldServer({
    host: "127.0.0.1",
    port: 0,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages")
  });
  context.after(async () => {
    await server.stop();
  });
  const address = await server.start();

  const createResponse = await roomPost(
    `${address.url}/api/rooms/join`,
    address.url,
    {
      displayName: "部屋主",
      passphrase: "星降る夜",
      requestId: "http-passphrase-create"
    }
  );
  assert.equal(createResponse.status, 200);
  const created = await createResponse.json() as Admission;
  assert.equal(created.room.accessMode, "PASSPHRASE");
  assert.equal(created.room.seatCount, 9);
  assert.equal(created.inviteUrl, undefined);
  const host = {
    cookie: cookie(createResponse),
    csrfToken: created.csrfToken
  };

  const joinResponse = await roomPost(
    `${address.url}/api/rooms/join`,
    address.url,
    {
      displayName: "参加者",
      passphrase: "星降る夜",
      requestId: "http-passphrase-join"
    }
  );
  assert.equal(joinResponse.status, 200);
  const joined = await joinResponse.json() as Admission;
  assert.equal(joined.room.roomId, created.room.roomId);
  assert.notEqual(cookie(joinResponse), "");
  const guest = {
    cookie: cookie(joinResponse),
    csrfToken: joined.csrfToken
  };

  const hostTeam = await roomPost(
    `${address.url}/api/rooms/${created.room.roomId}/team`,
    address.url,
    { teamId: "TEAM_1" },
    host
  );
  const guestTeam = await roomPost(
    `${address.url}/api/rooms/${created.room.roomId}/team`,
    address.url,
    { teamId: "TEAM_2" },
    guest
  );
  assert.equal(hostTeam.status, 200);
  assert.equal(guestTeam.status, 200);

  const endTime = await roomPost(
    `${address.url}/api/rooms/${created.room.roomId}/end-time`,
    address.url,
    { endTimeThreshold: 150 },
    host
  );
  assert.equal(endTime.status, 200);

  const start = await roomPost(
    `${address.url}/api/rooms/${created.room.roomId}/start`,
    address.url,
    { requestId: "http-passphrase-start" },
    host
  );
  assert.equal(start.status, 200);
});
