import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";

import { WebSocket } from "ws";

const entryPoint = path.resolve(
  "dist/packages/server/src/runtime-entry.js"
);
const child = spawn(
  process.execPath,
  ["--enable-source-maps", entryPoint],
  {
    env: {
      ...process.env,
      GOODFIELD_HOST: "127.0.0.1",
      GOODFIELD_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const address = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error(`Timed out waiting for GoodField startup.\n${stderr}`));
  }, 10_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    reject(new Error(
      `GoodField exited before startup (${code ?? signal ?? "unknown"}).\n` +
        stderr
    ));
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const match = /GoodField listening at (http:\/\/\S+)/u.exec(chunk);
    if (!match?.[1]) return;
    clearTimeout(timeout);
    resolve(match[1]);
  });
});

try {
  const health = await fetch(`${address}/health`);
  if (!health.ok) {
    throw new Error(`Health endpoint returned HTTP ${health.status}`);
  }
  const page = await fetch(address);
  if (!page.ok || !(await page.text()).includes("GoodField")) {
    throw new Error("Static application page was not served");
  }
  const browserEntry = await fetch(
    `${address}/assets/client/src/browser-entry.js`
  );
  const browserApp = await fetch(
    `${address}/assets/client/src/browser-app.js`
  );
  if (
    !browserEntry.ok ||
    !browserApp.ok ||
    !(await browserApp.text()).includes("data-local-match-form")
  ) {
    throw new Error("Built browser application was not served");
  }

  const creation = await fetch(`${address}/api/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Smoke Player",
      cpuCount: 1,
      mode: "TRAINING"
    })
  });
  if (!creation.ok) {
    throw new Error(`Match creation returned HTTP ${creation.status}`);
  }
  const created = await creation.json();
  const accessToken = created.creator?.accessToken;
  const playerId = created.creator?.playerId;
  if (
    typeof created.matchId !== "string" ||
    typeof accessToken !== "string" ||
    typeof playerId !== "string" ||
    !created.snapshot
  ) {
    throw new Error("Match creation did not return local actor state");
  }
  const authorization = `Bearer ${accessToken}`;
  const socket = new WebSocket(
    `${address.replace(/^http/u, "ws")}/realtime`,
    {
      headers: { authorization }
    }
  );
  await once(socket, "open");
  let synchronized;
  const synchronizedPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for initial realtime sync"));
    }, 5_000);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "FULL_SNAPSHOT") return;
      clearTimeout(timeout);
      resolve(message);
    });
  });
  socket.send(JSON.stringify({
    type: "SYNC_MATCH",
    matchId: created.matchId,
    lastEventSeq: null
  }));
  synchronized = await synchronizedPromise;
  let snapshot = synchronized.snapshot;
  let commandResult = null;
  for (let attempt = 0; attempt < 200 && !snapshot.result; attempt += 1) {
    const legalActions = snapshot.self?.legalActions ?? [];
    const reaction = legalActions.find(
      ({ type }) => type === "DECLARE_REACTION"
    );
    const trade = legalActions.find(
      ({ type }) => type === "CONFIRM_BUY"
    );
    const surrender = legalActions.find(
      ({ type }) => type === "SURRENDER"
    );
    const action = reaction
      ? {
          type: "DECLARE_REACTION",
          reactionId: reaction.reactionId,
          defenseCardInstanceIds: []
        }
      : trade
        ? {
            type: "CONFIRM_BUY",
            tradeId: trade.tradeId,
            accept: false
          }
        : surrender
          ? { type: "SURRENDER" }
          : null;
    if (!action) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const refresh = await fetch(
        `${address}/api/matches/${created.matchId}`,
        { headers: { authorization } }
      );
      const refreshed = await refresh.json();
      if (!refresh.ok || !refreshed.snapshot) {
        throw new Error("Playable smoke could not refresh match state");
      }
      snapshot = refreshed.snapshot;
      continue;
    }
    const command = await fetch(
      `${address}/api/matches/${created.matchId}/commands`,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...action,
          matchId: created.matchId,
          commandId: `built-smoke-command-${attempt}`,
          actorId: playerId,
          expectedRevision: snapshot.revision
        })
      }
    );
    commandResult = await command.json();
    if (!command.ok || commandResult.ok !== true) {
      throw new Error(
        `Playable command path failed: ${JSON.stringify(commandResult)}`
      );
    }
    snapshot = commandResult.snapshot;
  }
  if (!snapshot.result || !commandResult) {
    throw new Error("Playable smoke did not reach the result screen");
  }
  const reload = await fetch(
    `${address}/api/matches/${created.matchId}`,
    { headers: { authorization } }
  );
  const restored = await reload.json();
  if (
    !reload.ok ||
    restored.snapshot?.result === null ||
    restored.playerId !== playerId
  ) {
    throw new Error("Actor reload did not restore the finished match");
  }
  const publicPayload = JSON.stringify({
    creation: created.snapshot,
    command: snapshot,
    restored: restored.snapshot
  });
  if (
    publicPayload.includes('"rng"') ||
    publicPayload.includes('"randomLog"') ||
    publicPayload.includes(accessToken)
  ) {
    throw new Error("Browser transport exposed server-only state");
  }
  socket.close();
  await once(socket, "close");
  process.stdout.write(`Built server smoke passed at ${address}\n`);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
