import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GameCommandApi } from "../packages/server/src/command-api.ts";
import {
  applyEvent,
  createMatch
} from "../packages/server/src/engine.ts";
import {
  FileMatchPersistence,
  FileOperationalAuditLog
} from "../packages/server/src/persistence.ts";
import { RealtimeMatchHub } from "../packages/server/src/realtime.ts";
import type { DomainEvent } from "../packages/shared/src/model.ts";

const NOW = "2026-07-26T02:00:00.000Z";

function temporaryDirectory(
  cleanup: (callback: () => void) => void
): string {
  const directory = mkdtempSync(join(tmpdir(), "goodfield-t043-"));
  cleanup(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("T-043 persists metadata, ruleset, seed, commands, events, and restorable state", (context) => {
  const directory = temporaryDirectory((callback) => context.after(callback));
  const persistence = new FileMatchPersistence({
    directory: join(directory, "matches"),
    clock: () => NOW
  });
  const created = createMatch({
    matchId: "persisted-match",
    seed: "persisted-secret-seed",
    mode: "TRAINING",
    now: NOW,
    players: [
      {
        playerId: "private-player-a",
        displayName: "Private Player A"
      },
      {
        playerId: "private-player-b",
        displayName: "Private Player B"
      }
    ]
  });
  const api = new GameCommandApi({
    clock: () => NOW,
    persistence
  });
  api.registerMatch(created.state, created.events);
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const response = api.execute({
    authenticatedPlayerId: actorId,
    matchId: created.state.matchId,
    body: {
      type: "SURRENDER",
      matchId: created.state.matchId,
      commandId: "persisted-surrender",
      actorId,
      expectedRevision: created.state.revision
    }
  });
  assert.equal(response.ok, true);

  const persisted = persistence.loadMatch(created.state.matchId);
  assert.ok(persisted);
  assert.equal(persisted.metadata.matchId, created.state.matchId);
  assert.equal(persisted.metadata.playerCount, 2);
  assert.equal(
    persisted.metadata.rulesetVersion,
    created.state.rulesetVersion
  );
  assert.equal(
    persisted.metadata.cardPoolVersion,
    created.state.cardPoolVersion
  );
  assert.equal(persisted.seed, "persisted-secret-seed");
  assert.equal(persisted.commands.length, 1);
  assert.equal(persisted.commands[0]?.commandId, "persisted-surrender");
  assert.equal(persisted.commands[0]?.occurredAt, NOW);
  assert.deepEqual(
    persisted.events.map(({ eventSeq }) => eventSeq),
    Array.from(
      { length: persisted.state.eventSequence },
      (_, index) => index + 1
    )
  );
  assert.deepEqual(persisted.state, api.matchState(created.state.matchId));

  const restoredApi = new GameCommandApi({
    clock: () => NOW,
    persistence
  });
  assert.deepEqual(
    restoredApi.restoreMatch(created.state.matchId),
    persisted.state
  );
  assert.deepEqual(
    restoredApi.matchState(created.state.matchId),
    persisted.state
  );

  const journalFiles = readdirSync(join(directory, "matches"));
  assert.equal(journalFiles.length, 1);
  assert.equal(journalFiles[0]?.includes(created.state.matchId), false);
});

test("T-043 audit log tracks rejected commands, sync failures, and aborted chains without secrets", (context) => {
  const directory = temporaryDirectory((callback) => context.after(callback));
  const auditFile = join(directory, "operations", "audit.jsonl");
  const audit = new FileOperationalAuditLog({ file: auditFile });
  const created = createMatch({
    matchId: "secret-match-id",
    seed: "secret-seed",
    now: NOW,
    players: [
      {
        playerId: "secret-player-a",
        displayName: "alice@example.com"
      },
      {
        playerId: "secret-player-b",
        displayName: "Bob Secret"
      }
    ]
  });
  const api = new GameCommandApi({
    clock: () => NOW,
    audit
  });
  api.registerMatch(created.state);
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const targetId = created.state.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const rejection = api.execute({
    authenticatedPlayerId: actorId,
    matchId: created.state.matchId,
    body: {
      type: "DECLARE_ACTION",
      matchId: created.state.matchId,
      commandId: "secret-command-id",
      actorId,
      expectedRevision: created.state.revision,
      cardInstanceIds: ["secret-card-instance"],
      targetPlayerId: targetId
    }
  });
  assert.equal(rejection.ok, false);

  const abortedEvent: Extract<
    DomainEvent,
    { type: "REACTION_CHAIN_ABORTED" }
  > = {
    type: "REACTION_CHAIN_ABORTED",
    eventSeq: created.state.eventSequence + 1,
    revision: created.state.revision + 1,
    occurredAt: NOW,
    visibility: { scope: "PUBLIC" },
    attackId: "secret-attack-id",
    maxDepth: 512
  };
  api.commitMatchTransition(
    applyEvent(created.state, abortedEvent),
    [abortedEvent]
  );

  const hub = new RealtimeMatchHub({
    clock: () => NOW,
    audit
  });
  hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: null
    },
    {
      kind: "PLAYER",
      playerId: "secret-outsider"
    }
  );

  const auditText = readFileSync(auditFile, "utf8");
  for (const secret of [
    "secret-match-id",
    "secret-player-a",
    "secret-player-b",
    "alice@example.com",
    "Bob Secret",
    "secret-command-id",
    "secret-card-instance",
    "secret-attack-id",
    "secret-outsider",
    "secret-seed"
  ]) {
    assert.equal(auditText.includes(secret), false, secret);
  }
  const entries = auditText
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    entries.map(({ category }) => category),
    [
      "COMMAND_REJECTED",
      "EFFECT_CHAIN_ABORTED",
      "SYNC_FAILURE"
    ]
  );
  assert.equal(entries[0]?.code, "CARD_NOT_FOUND");
  assert.equal(entries[1]?.maxDepth, 512);
  assert.equal(entries[2]?.code, "MATCH_NOT_FOUND");
});
