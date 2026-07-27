import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import { GoodFieldServer } from "../packages/server/src/runtime-server.ts";

type Credential = {
  cookie: string;
  csrfToken: string;
};

type Admission = {
  ok: true;
  room: { roomId: string };
  csrfToken: string;
  inviteUrl?: string;
};

function cookie(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function post(
  url: string,
  origin: string,
  body: unknown,
  credential?: Credential
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

type SynchronizedView = {
  eventSeq: number;
  snapshot: {
    revision: number;
    self: { playerId: string; hand: unknown[] };
    players: Array<{ playerId: string }>;
  };
};

async function synchronized(
  socket: WebSocket,
  matchId: string
): Promise<SynchronizedView> {
  const message = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for synchronization")),
      3_000
    );
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString()) as {
        type?: string;
      };
      if (value.type === "FULL_SNAPSHOT") {
        clearTimeout(timeout);
        resolve(value);
      }
    });
  });
  socket.send(JSON.stringify({
    type: "SYNC_MATCH",
    matchId,
    lastEventSeq: null
  }));
  return await message as SynchronizedView;
}

test("T-058 two browsers receive isolated views and converge after concurrent commands", async (context) => {
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
  const createdResponse = await post(
    `${address.url}/api/rooms`,
    address.url,
    {
      displayName: "Host",
      seatCount: 2,
      requestId: "multibrowser-create"
    }
  );
  const created = await createdResponse.json() as Admission;
  const host = {
    cookie: cookie(createdResponse),
    csrfToken: created.csrfToken
  };
  const invite = new URL(created.inviteUrl ?? "")
    .searchParams.get("invite");
  assert.ok(invite);
  const joinedResponse = await post(
    `${address.url}/api/rooms/${created.room.roomId}/join`,
    address.url,
    {
      displayName: "Guest",
      inviteCode: invite,
      requestId: "multibrowser-join"
    }
  );
  const joined = await joinedResponse.json() as Admission;
  const guest = {
    cookie: cookie(joinedResponse),
    csrfToken: joined.csrfToken
  };
  await Promise.all([host, guest].map((credential) =>
    post(
      `${address.url}/api/rooms/${created.room.roomId}/ready`,
      address.url,
      { ready: true },
      credential
    )
  ));
  const startResponse = await post(
    `${address.url}/api/rooms/${created.room.roomId}/start`,
    address.url,
    { requestId: "multibrowser-start" },
    host
  );
  const started = await startResponse.json() as {
    matchId: string;
  };

  const sockets = [host, guest].map((credential) =>
    new WebSocket(
      `${address.url.replace(/^http/u, "ws")}/realtime`,
      "goodfield",
      {
        headers: {
          cookie: credential.cookie,
          origin: address.url
        }
      }
    )
  );
  context.after(() => sockets.forEach((socket) => socket.terminate()));
  await Promise.all(sockets.map((socket) => once(socket, "open")));
  const [hostView, guestView] = await Promise.all(
    sockets.map((socket) => synchronized(socket, started.matchId))
  );
  assert.notEqual(
    hostView?.snapshot.self.playerId,
    guestView?.snapshot.self.playerId
  );
  assert.equal(hostView?.snapshot.self.hand.length, 9);
  assert.equal(guestView?.snapshot.self.hand.length, 9);
  const encodedHost = JSON.stringify(hostView);
  const encodedGuest = JSON.stringify(guestView);
  assert.equal(encodedHost.includes('"rng"'), false);
  assert.equal(encodedGuest.includes('"rng"'), false);

  const command = (
    view: SynchronizedView,
    suffix: string
  ) => ({
    type: "SURRENDER",
    matchId: started.matchId,
    commandId: `multibrowser-${suffix}`,
    actorId: view.snapshot.self.playerId,
    expectedRevision: view.snapshot.revision
  });
  const responses = await Promise.all([
    post(
      `${address.url}/api/matches/${started.matchId}/commands`,
      address.url,
      command(hostView, "host"),
      host
    ),
    post(
      `${address.url}/api/matches/${started.matchId}/commands`,
      address.url,
      command(guestView, "guest"),
      guest
    )
  ]);
  const bodies = await Promise.all(responses.map(
    (response) => response.json() as Promise<{ ok: boolean }>
  ));
  assert.equal(bodies.filter(({ ok }) => ok).length, 1);

  sockets[1]?.close();
  if (sockets[1]) await once(sockets[1], "close");
  const reconnected = new WebSocket(
    `${address.url.replace(/^http/u, "ws")}/realtime`,
    "goodfield",
    {
      headers: {
        cookie: guest.cookie,
        origin: address.url
      }
    }
  );
  context.after(() => reconnected.terminate());
  await once(reconnected, "open");
  const restored = await synchronized(reconnected, started.matchId);
  assert.ok(restored.snapshot.revision > guestView.snapshot.revision);
  assert.equal(JSON.stringify(restored).includes('"rng"'), false);
});
