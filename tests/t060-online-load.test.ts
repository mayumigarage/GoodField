import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { GameCommandApi } from "../packages/server/src/command-api.ts";
import { OnlineRoomService } from "../packages/server/src/online-room.ts";
import { OnlineSessionStore } from "../packages/server/src/online-session.ts";
import { RealtimeMatchHub } from "../packages/server/src/realtime.ts";
import { RuntimeMatchService } from "../packages/server/src/runtime-match.ts";

test("T-060 target admission load covers 100 rooms and 900 online sessions", () => {
  const now = "2026-07-26T00:00:00.000Z";
  const clock = (): string => now;
  const sessions = new OnlineSessionStore({
    clock,
    secret: "session-load-secret".padEnd(32, "s")
  });
  const matches = new RuntimeMatchService({
    commandApi: new GameCommandApi(clock),
    realtimeHub: new RealtimeMatchHub({ clock }),
    clock
  });
  const rooms = new OnlineRoomService({
    matchService: matches,
    sessions,
    clock,
    secret: "room-load-secret".padEnd(32, "r")
  });
  const memoryBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  let admissions = 0;
  for (let roomIndex = 0; roomIndex < 100; roomIndex += 1) {
    const created = rooms.create({
      displayName: `Host ${roomIndex}`,
      seatCount: 9,
      allowSpectators: true,
      requestId: `load-room-${roomIndex}`
    });
    for (let guestIndex = 0; guestIndex < 8; guestIndex += 1) {
      const guest = rooms.join(created.room.roomId, {
        displayName: `Guest ${roomIndex}-${guestIndex}`,
        inviteCode: created.inviteCode,
        requestId: `load-guest-${roomIndex}-${guestIndex}`
      });
      assert.equal(guest.snapshot, null);
      admissions += 1;
    }
    admissions += 1;
  }
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuBefore);
  const heapGrowthBytes = process.memoryUsage().heapUsed - memoryBefore;
  const serializedBytes = Buffer.byteLength(JSON.stringify({
    rooms: rooms.exportState(),
    sessions: sessions.exportState()
  }));
  assert.equal(rooms.exportState().rooms.length, 100);
  assert.equal(sessions.exportState().sessions.length, 900);
  assert.equal(admissions, 900);
  assert.ok(elapsedMs < 10_000, `admission load took ${elapsedMs}ms`);
  assert.ok(
    heapGrowthBytes < 256 * 1024 * 1024,
    `admission load grew heap by ${heapGrowthBytes} bytes`
  );
  assert.ok(
    cpu.user + cpu.system < 10_000_000,
    `admission load used ${cpu.user + cpu.system}µs CPU`
  );
  assert.ok(
    serializedBytes < 16 * 1024 * 1024,
    `checkpoint payload was ${serializedBytes} bytes`
  );
  matches.close();
});
