import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DurableStoreConflictError,
  type OnlineStateCheckpoint,
  type OnlineStatePersistence,
  PostgresGoodFieldStore,
  type SqlQueryResult,
  type TransactionalSqlClient,
  type VersionedOnlineState
} from "../packages/server/src/durable-store.ts";
import { createMatch } from "../packages/server/src/engine.ts";
import { GameCommandApi } from "../packages/server/src/command-api.ts";
import { OnlineRoomService } from "../packages/server/src/online-room.ts";
import { OnlineSessionStore } from "../packages/server/src/online-session.ts";
import { RealtimeMatchHub } from "../packages/server/src/realtime.ts";
import { FileMatchPersistence } from "../packages/server/src/persistence.ts";
import { RuntimeMatchService } from "../packages/server/src/runtime-match.ts";
import { GoodFieldServer } from "../packages/server/src/runtime-server.ts";
import type {
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";

class MemoryPostgresClient implements TransactionalSqlClient {
  match: {
    revision: number;
    eventSequence: number;
    expiresAt: string;
    payload: string;
  } | null = null;
  online: {
    version: number;
    expiresAt: string;
    payload: string;
  } | null = null;

  transaction<T>(operation: (client: TransactionalSqlClient) => T): T {
    return operation(this);
  }

  query(statement: string, parameters: readonly unknown[] = []): SqlQueryResult {
    const sql = statement.replace(/\s+/gu, " ").trim();
    if (sql.startsWith("CREATE ") || sql.startsWith("CREATE INDEX")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO goodfield_matches")) {
      if (this.match) return { rows: [], rowCount: 0 };
      this.match = {
        revision: Number(parameters[1]),
        eventSequence: Number(parameters[2]),
        expiresAt: String(parameters[3]),
        payload: String(parameters[4])
      };
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes("FROM goodfield_matches") &&
      sql.includes("FOR UPDATE")
    ) {
      return {
        rows: this.match
          ? [{
              revision: this.match.revision,
              event_sequence: this.match.eventSequence,
              payload: this.match.payload
            }]
          : [],
        rowCount: this.match ? 1 : 0
      };
    }
    if (sql.startsWith("UPDATE goodfield_matches")) {
      if (
        !this.match ||
        this.match.revision !== Number(parameters[6]) ||
        this.match.eventSequence !== Number(parameters[7])
      ) {
        return { rows: [], rowCount: 0 };
      }
      this.match = {
        revision: Number(parameters[1]),
        eventSequence: Number(parameters[2]),
        expiresAt: String(parameters[3]),
        payload: String(parameters[4])
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT payload") && sql.includes("goodfield_matches")) {
      return {
        rows: this.match ? [{ payload: this.match.payload }] : [],
        rowCount: this.match ? 1 : 0
      };
    }
    if (
      sql.startsWith("SELECT version") &&
      sql.includes("FOR UPDATE")
    ) {
      return {
        rows: this.online ? [{ version: this.online.version }] : [],
        rowCount: this.online ? 1 : 0
      };
    }
    if (sql.startsWith("INSERT INTO goodfield_online_state")) {
      if (this.online) return { rows: [], rowCount: 0 };
      this.online = {
        version: Number(parameters[0]),
        expiresAt: String(parameters[1]),
        payload: String(parameters[2])
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE goodfield_online_state")) {
      if (!this.online || this.online.version !== Number(parameters[4])) {
        return { rows: [], rowCount: 0 };
      }
      this.online = {
        version: Number(parameters[0]),
        expiresAt: String(parameters[1]),
        payload: String(parameters[2])
      };
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.startsWith("SELECT version, payload") &&
      sql.includes("goodfield_online_state")
    ) {
      return {
        rows: this.online
          ? [{ version: this.online.version, payload: this.online.payload }]
          : [],
        rowCount: this.online ? 1 : 0
      };
    }
    if (sql.startsWith("DELETE FROM goodfield_online_state")) {
      const deleted = this.online ? 1 : 0;
      this.online = null;
      return { rows: [], rowCount: deleted };
    }
    if (sql.startsWith("DELETE FROM goodfield_matches")) {
      const deleted = this.match ? 1 : 0;
      this.match = null;
      return { rows: [], rowCount: deleted };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class MemoryOnlinePersistence implements OnlineStatePersistence {
  state: VersionedOnlineState | null = null;

  loadOnlineState(): VersionedOnlineState | null {
    return structuredClone(this.state);
  }

  saveOnlineState(
    expectedVersion: number | null,
    checkpoint: OnlineStateCheckpoint
  ): number {
    assert.equal(this.state?.version ?? null, expectedVersion);
    const version = (expectedVersion ?? 0) + 1;
    this.state = { version, checkpoint: structuredClone(checkpoint) };
    return version;
  }

  deleteExpired(_before: string): { rooms: number; matches: number } {
    return { rooms: 0, matches: 0 };
  }
}

function roomServices(clock: () => string): {
  rooms: OnlineRoomService;
  sessions: OnlineSessionStore;
  matches: RuntimeMatchService;
} {
  let counter = 0;
  const random = (size: number): Uint8Array => {
    counter += 1;
    return Uint8Array.from(
      { length: size },
      (_, index) => (counter * 17 + index) % 256
    );
  };
  const matches = new RuntimeMatchService({
    commandApi: new GameCommandApi(clock),
    realtimeHub: new RealtimeMatchHub({ clock }),
    clock,
    random
  });
  const sessions = new OnlineSessionStore({
    clock,
    random,
    secret: "s".repeat(32)
  });
  return {
    matches,
    sessions,
    rooms: new OnlineRoomService({
      matchService: matches,
      sessions,
      clock,
      random,
      secret: "r".repeat(32)
    })
  };
}

test("T-056 PostgreSQL adapter serializes revisions and checkpoints", () => {
  const now = "2026-07-26T00:00:00.000Z";
  const client = new MemoryPostgresClient();
  const store = new PostgresGoodFieldStore({
    client,
    clock: () => now
  });
  const created = createMatch({
    matchId: "durable-match",
    seed: "durable-seed",
    players: [
      { playerId: "p1", displayName: "One" },
      { playerId: "p2", displayName: "Two" }
    ],
    now
  });
  store.saveMatchCreated(created.state, created.events);
  assert.deepEqual(store.loadMatch(created.state.matchId)?.state, created.state);

  const state: MatchState = {
    ...created.state,
    revision: created.state.revision + 1,
    eventSequence: created.state.eventSequence + 1,
    gfCount: created.state.gfCount + 1
  };
  const event: DomainEvent = {
    type: "GF_COUNT_CHANGED",
    eventSeq: state.eventSequence,
    revision: state.revision,
    occurredAt: now,
    visibility: { scope: "PUBLIC" },
    gfCount: state.gfCount
  };
  store.saveTransition(state, [], [event]);
  assert.equal(store.loadMatch(state.matchId)?.state.revision, state.revision);
  assert.throws(
    () => store.saveTransition(state, [], [event]),
    DurableStoreConflictError
  );

  const checkpoint = {
    schemaVersion: 1 as const,
    storedAt: now,
    rooms: { schemaVersion: 1, rooms: [] },
    sessions: { schemaVersion: 1, sessions: [] },
    reconnectCursors: { [state.matchId]: state.eventSequence }
  };
  assert.equal(store.saveOnlineState(null, checkpoint), 1);
  assert.deepEqual(store.loadOnlineState(), {
    version: 1,
    checkpoint
  });
  assert.throws(
    () => store.saveOnlineState(null, checkpoint),
    DurableStoreConflictError
  );
});

test("T-056 room and hashed session snapshots survive service restart", () => {
  const now = "2026-07-26T00:00:00.000Z";
  const first = roomServices(() => now);
  const created = first.rooms.create({
    displayName: "Host",
    seatCount: 2,
    requestId: "durable-room"
  });
  const cookie = created.session.cookie.split(";")[0] ?? "";
  const roomSnapshot = first.rooms.exportState();
  const sessionSnapshot = first.sessions.exportState();
  first.matches.close();

  const restored = roomServices(() => now);
  restored.sessions.restoreState(sessionSnapshot);
  restored.rooms.restoreState(roomSnapshot);
  const session = restored.sessions.authenticateCookieHeader(cookie);
  assert.ok(session);
  assert.equal(
    restored.rooms.view(session).roomId,
    created.room.roomId
  );
  assert.equal(
    JSON.stringify(sessionSnapshot).includes(created.rejoinToken ?? ""),
    false
  );
  restored.matches.close();
});

test("T-056 running server restores a started match and reconnect cursor", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goodfield-t056-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const online = new MemoryOnlinePersistence();
  const secret = "restart-secret".padEnd(32, "x");
  const persistence = new FileMatchPersistence({ directory });
  const first = new GoodFieldServer({
    host: "127.0.0.1",
    port: 0,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages"),
    persistence,
    onlinePersistence: online,
    sessionSecret: secret,
    roomSecret: secret,
    schedulerIntervalMs: 10
  });
  const firstAddress = await first.start();
  const createResponse = await fetch(`${firstAddress.url}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: firstAddress.url
    },
    body: JSON.stringify({
      displayName: "Host",
      seatCount: 2,
      cpuCount: 1,
      requestId: "restart-create"
    })
  });
  const created = await createResponse.json() as {
    room: { roomId: string };
    csrfToken: string;
  };
  const cookie = createResponse.headers.get("set-cookie")
    ?.split(";")[0] ?? "";
  await fetch(
    `${firstAddress.url}/api/rooms/${created.room.roomId}/ready`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: firstAddress.url,
        "x-goodfield-csrf": created.csrfToken
      },
      body: JSON.stringify({ ready: true })
    }
  );
  const startResponse = await fetch(
    `${firstAddress.url}/api/rooms/${created.room.roomId}/start`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: firstAddress.url,
        "x-goodfield-csrf": created.csrfToken
      },
      body: JSON.stringify({ requestId: "restart-start" })
    }
  );
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json() as {
    matchId: string;
    snapshot: { revision: number };
  };
  await first.stop();

  const second = new GoodFieldServer({
    host: "127.0.0.1",
    port: 0,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages"),
    persistence: new FileMatchPersistence({ directory }),
    onlinePersistence: online,
    sessionSecret: secret,
    roomSecret: secret,
    schedulerIntervalMs: 10
  });
  context.after(async () => {
    await second.stop();
  });
  const secondAddress = await second.start();
  const restoredResponse = await fetch(
    `${secondAddress.url}/api/rooms/${created.room.roomId}/match`,
    {
      headers: {
        cookie,
        origin: secondAddress.url
      }
    }
  );
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json() as {
    snapshot: { matchId: string; revision: number };
  };
  assert.equal(restored.snapshot.matchId, started.matchId);
  assert.ok(restored.snapshot.revision >= started.snapshot.revision);
  assert.equal(
    online.state?.checkpoint.reconnectCursors[started.matchId] !== undefined,
    true
  );
});
