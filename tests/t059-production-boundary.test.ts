import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type {
  OnlineStateCheckpoint,
  OnlineStatePersistence,
  VersionedOnlineState
} from "../packages/server/src/durable-store.ts";
import { GoodFieldServer } from "../packages/server/src/runtime-server.ts";

class FailingOnlinePersistence implements OnlineStatePersistence {
  loadOnlineState(): VersionedOnlineState | null {
    return null;
  }

  saveOnlineState(
    _expectedVersion: number | null,
    _checkpoint: OnlineStateCheckpoint
  ): number {
    throw new Error("database unavailable");
  }

  deleteExpired(_before: string): { rooms: number; matches: number } {
    return { rooms: 0, matches: 0 };
  }
}

test("T-059 health, metrics, security headers, draining, and fail-closed storage", async (context) => {
  const failures: Error[] = [];
  const server = new GoodFieldServer({
    host: "127.0.0.1",
    port: 0,
    staticDirectory: path.resolve("packages/client/public"),
    assetDirectory: path.resolve("dist/packages"),
    schedulerIntervalMs: 60_000,
    onlinePersistence: new FailingOnlinePersistence(),
    onFatalError(error) {
      failures.push(error);
    }
  });
  context.after(async () => {
    await server.stop();
  });
  const address = await server.start();

  const live = await fetch(`${address.url}/health/live`);
  assert.equal(live.status, 200);
  assert.match(
    live.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/u
  );
  assert.equal(live.headers.get("x-content-type-options"), "nosniff");

  const create = await fetch(`${address.url}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: address.url
    },
    body: JSON.stringify({
      displayName: "Host",
      seatCount: 2,
      requestId: "failing-store"
    })
  });
  assert.equal(create.status, 503);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.readiness().durabilityHealthy, false);
  assert.ok(failures.some((error) => /database unavailable/u.test(error.message)));

  const rejected = await fetch(`${address.url}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: address.url
    },
    body: JSON.stringify({
      displayName: "Second",
      seatCount: 2,
      requestId: "failing-store-second"
    })
  });
  assert.equal(rejected.status, 503);
  assert.equal(
    (await rejected.json() as { code: string }).code,
    "PERSISTENCE_UNAVAILABLE"
  );

  const metrics = await (await fetch(`${address.url}/metrics`)).text();
  assert.match(metrics, /goodfield_persistence_failures_total 1/u);
  server.beginDrain();
  const ready = await fetch(`${address.url}/health/ready`);
  assert.equal(ready.status, 503);
  const draining = await fetch(`${address.url}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: address.url
    },
    body: JSON.stringify({
      displayName: "Drained",
      seatCount: 2,
      requestId: "drained"
    })
  });
  assert.equal(draining.status, 503);
});
