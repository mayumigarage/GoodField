import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import {
  GoodFieldServer
} from "../packages/server/src/runtime-server.ts";

type CreatedMatchResponse = {
  ok: true;
  matchId: string;
  creator: {
    playerId: string;
    accessToken: string;
  };
  snapshot: {
    revision: number;
    phase: string;
    pendingAttack: { reactionId: string } | null;
    self: {
      tradeConfirmation: { tradeId: string } | null;
    } | null;
  };
};

function messageQueue(socket: WebSocket): {
  next: (predicate: (value: unknown) => boolean) => Promise<unknown>;
} {
  const values: unknown[] = [];
  const waiters: Array<{
    predicate: (value: unknown) => boolean;
    resolve: (value: unknown) => void;
  }> = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString()) as unknown;
    const waiterIndex = waiters.findIndex(({ predicate }) =>
      predicate(value)
    );
    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      waiter?.resolve(value);
    } else {
      values.push(value);
    }
  });
  return {
    next(predicate) {
      const existingIndex = values.findIndex(predicate);
      if (existingIndex >= 0) {
        return Promise.resolve(values.splice(existingIndex, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for WebSocket message"));
        }, 5_000);
        waiters.push({
          predicate,
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          }
        });
      });
    }
  };
}

function messageType(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("type" in value) || typeof value.type !== "string") return null;
  return value.type;
}

test("one process serves static assets, match APIs, commands, and realtime events", async (context) => {
  const server = new GoodFieldServer({
    host: "127.0.0.1",
    port: 0,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages"),
    schedulerIntervalMs: 10,
    heartbeatIntervalMs: 1_000
  });
  context.after(async () => {
    await server.stop();
  });
  const address = await server.start();

  const health = await fetch(`${address.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, status: "ready" });

  const page = await fetch(address.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /GoodField/u);

  const creation = await fetch(`${address.url}/api/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Local Player", cpuCount: 1 })
  });
  assert.equal(creation.status, 201);
  const created = await creation.json() as CreatedMatchResponse;
  assert.equal(created.ok, true);
  const authorization = `Bearer ${created.creator.accessToken}`;

  const joined = await fetch(
    `${address.url}/api/matches/${created.matchId}`,
    { headers: { authorization } }
  );
  assert.equal(joined.status, 200);
  const joinedBody = await joined.json() as {
    ok: boolean;
    playerId: string;
  };
  assert.equal(joinedBody.ok, true);
  assert.equal(joinedBody.playerId, created.creator.playerId);

  const wrongToken = await fetch(
    `${address.url}/api/matches/${created.matchId}`,
    { headers: { authorization: "Bearer invalid-token" } }
  );
  assert.equal(wrongToken.status, 401);

  const socketUrl = address.url.replace(/^http/u, "ws");
  const socket = new WebSocket(`${socketUrl}/realtime`, {
    headers: { authorization }
  });
  const messages = messageQueue(socket);
  await once(socket, "open");
  await messages.next((value) => messageType(value) === "CONNECTED");
  socket.send(JSON.stringify({
    type: "SYNC_MATCH",
    matchId: created.matchId,
    lastEventSeq: null
  }));
  const initial = await messages.next(
    (value) => messageType(value) === "FULL_SNAPSHOT"
  ) as { eventSeq: number };
  const commandPayload =
    created.snapshot.phase === "REACTION_SELECTION"
      ? {
          type: "DECLARE_REACTION",
          reactionId: created.snapshot.pendingAttack?.reactionId,
          defenseCardInstanceIds: []
        }
      : created.snapshot.phase === "TRADE_CONFIRMATION"
        ? {
            type: "CONFIRM_BUY",
            tradeId: created.snapshot.self?.tradeConfirmation?.tradeId,
            accept: false
          }
        : { type: "SURRENDER" };

  const command = await fetch(
    `${address.url}/api/matches/${created.matchId}/commands`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...commandPayload,
        matchId: created.matchId,
        commandId: "runtime-server-surrender",
        actorId: created.creator.playerId,
        expectedRevision: created.snapshot.revision
      })
    }
  );
  assert.equal(command.status, 200);
  const commandBody = await command.json() as {
    ok: boolean;
    eventSeq: number;
  };
  assert.equal(commandBody.ok, true);
  assert.ok(commandBody.eventSeq > initial.eventSeq);

  const update = await messages.next(
    (value) => messageType(value) === "EVENT_BATCH"
  ) as {
    eventSeq: number;
    events: Array<{ type: string }>;
  };
  assert.equal(update.eventSeq, commandBody.eventSeq);
  assert.ok(update.events.length > 0);
  socket.close();
  await once(socket, "close");
});

test("realtime upgrade rejects an unissued actor token", async (context) => {
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
  const socketUrl = address.url.replace(/^http/u, "ws");
  const socket = new WebSocket(`${socketUrl}/realtime`, {
    headers: { authorization: "Bearer not-issued" }
  });
  socket.on("error", () => {});
  const [, response] = await once(socket, "unexpected-response");
  assert.equal(
    (response as { statusCode?: number }).statusCode,
    401
  );
  (response as { resume?: () => void }).resume?.();
  socket.terminate();
});

test("port conflicts fail startup with an explicit error", async (context) => {
  const first = new GoodFieldServer({
    host: "127.0.0.1",
    port: 0,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages")
  });
  const firstAddress = await first.start();
  const second = new GoodFieldServer({
    host: "127.0.0.1",
    port: firstAddress.port,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages")
  });
  context.after(async () => {
    await Promise.all([first.stop(), second.stop()]);
  });

  await assert.rejects(
    second.start(),
    /could not listen.*EADDRINUSE/u
  );
});
