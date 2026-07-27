import assert from "node:assert/strict";
import test from "node:test";

import { GameCommandApi } from "../packages/server/src/command-api.ts";
import {
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import {
  connectRealtimeSocket,
  parseMatchSyncRequest,
  RealtimeMatchHub
} from "../packages/server/src/realtime.ts";
import { processInputDeadline } from "../packages/server/src/session.ts";
import type {
  CardInstance,
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";
import type {
  RealtimeEventBatch,
  RealtimeFullSnapshot,
  RealtimeMatchMessage
} from "../packages/shared/src/protocol.ts";

const NOW = "2026-07-26T03:00:00.000Z";
const DEADLINE = "2026-07-26T03:00:15.000Z";

function createdMatch(playerCount = 3) {
  return createMatch({
    matchId: `realtime-${playerCount}`,
    seed: `realtime-seed-${playerCount}`,
    mode: "ONLINE",
    players: Array.from({ length: playerCount }, (_, index) => ({
      playerId: `player-${index}`,
      displayName: `Player ${index}`
    })),
    now: NOW
  });
}

function eventBatch(
  message: RealtimeMatchMessage
): RealtimeEventBatch {
  assert.equal(message.type, "EVENT_BATCH");
  if (message.type !== "EVENT_BATCH") {
    throw new Error("Expected an event batch");
  }
  return message;
}

function fullSnapshot(
  message: RealtimeMatchMessage
): RealtimeFullSnapshot {
  assert.equal(message.type, "FULL_SNAPSHOT");
  if (message.type !== "FULL_SNAPSHOT") {
    throw new Error("Expected a full snapshot");
  }
  return message;
}

function assertStrictlyOrdered(events: readonly DomainEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(
      (events[index - 1]?.eventSeq ?? 0) <
        (events[index]?.eventSeq ?? 0)
    );
  }
}

test("realtime synchronization filters events by viewer while preserving the global cursor", () => {
  const created = createdMatch();
  const hub = new RealtimeMatchHub();
  hub.registerMatch(created.state, created.events);

  const player = eventBatch(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: 0
    },
    { kind: "PLAYER", playerId: "player-0" }
  ));
  const spectator = eventBatch(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: 0
    },
    { kind: "SPECTATOR" }
  ));

  assert.equal(player.eventSeq, created.state.eventSequence);
  assert.equal(spectator.eventSeq, created.state.eventSequence);
  assert.equal(
    player.events.filter(({ type }) => type === "CARD_GRANTED").length,
    9
  );
  assert.equal(
    player.events
      .filter(({ type }) => type === "CARD_GRANTED")
      .every(
        (event) =>
          event.type === "CARD_GRANTED" &&
          event.playerId === "player-0"
      ),
    true
  );
  assert.equal(
    spectator.events.some(({ type }) => type === "CARD_GRANTED"),
    false
  );
  assertStrictlyOrdered(player.events);
  assertStrictlyOrdered(spectator.events);

  const serialized = JSON.stringify({ player, spectator });
  assert.equal(serialized.includes(created.state.rng.seed), false);
  assert.equal(serialized.includes("\"rng\""), false);
  assert.equal(serialized.includes("processedCommands"), false);
  assert.equal(serialized.includes("randomLog"), false);
});

test("dream card events and snapshots expose only the fixed disguise", () => {
  const created = createdMatch(2);
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const dreamCard: CardInstance = {
    instanceId: "dream-card",
    cardDefinitionId: "sun-amulet",
    dreamDisguiseCardDefinitionId: "leather-cap"
  };
  const event: DomainEvent = {
    type: "CARD_GRANTED",
    eventSeq: created.state.eventSequence + 1,
    revision: created.state.revision + 1,
    occurredAt: NOW,
    visibility: { scope: "PLAYER", playerId: actorId },
    obligationId: "dream-grant",
    playerId: actorId,
    card: dreamCard
  };
  const state: MatchState = {
    ...created.state,
    revision: event.revision,
    eventSequence: event.eventSeq,
    players: {
      ...created.state.players,
      [actorId]: {
        ...created.state.players[actorId]!,
        hand: [...created.state.players[actorId]!.hand, dreamCard]
      }
    }
  };
  const hub = new RealtimeMatchHub();
  hub.registerMatch(created.state);
  hub.publish(state, [event]);

  const player = eventBatch(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: state.matchId,
      lastEventSeq: created.state.eventSequence
    },
    { kind: "PLAYER", playerId: actorId }
  ));
  const granted = player.events.find(
    ({ type }) => type === "CARD_GRANTED"
  );
  assert.ok(granted?.type === "CARD_GRANTED");
  assert.equal(granted.card.cardDefinitionId, "leather-cap");
  assert.equal(granted.card.dreamDisguiseCardDefinitionId, null);
  assert.equal(
    player.snapshot.self?.hand.find(
      ({ instanceId }) => instanceId === dreamCard.instanceId
    )?.cardDefinitionId,
    "leather-cap"
  );
  assert.equal(JSON.stringify(player).includes("sun-amulet"), false);

  const spectator = eventBatch(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: state.matchId,
      lastEventSeq: created.state.eventSequence
    },
    { kind: "SPECTATOR" }
  ));
  assert.deepEqual(spectator.events, []);
  assert.equal(spectator.eventSeq, state.eventSequence);
});

test("command API commits are streamed once to players and spectators", () => {
  const created = createdMatch(2);
  const hub = new RealtimeMatchHub();
  const api = new GameCommandApi(() => NOW);
  api.onMatchEventsCommitted((state, events) => {
    hub.publish(state, events);
  });
  api.registerMatch(created.state);
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const playerMessages: RealtimeMatchMessage[] = [];
  const spectatorMessages: RealtimeMatchMessage[] = [];
  hub.subscribe({
    request: {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: created.state.eventSequence
    },
    viewer: { kind: "PLAYER", playerId: actorId },
    send: (message) => playerMessages.push(message)
  });
  hub.subscribe({
    request: {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: created.state.eventSequence
    },
    viewer: { kind: "SPECTATOR" },
    send: (message) => spectatorMessages.push(message)
  });
  const command = {
    type: "SURRENDER",
    matchId: created.state.matchId,
    commandId: "streamed-surrender",
    actorId,
    expectedRevision: created.state.revision
  } as const;

  const response = api.execute({
    authenticatedPlayerId: actorId,
    matchId: created.state.matchId,
    body: command
  });
  assert.equal(response.ok, true);
  assert.equal(playerMessages.length, 2);
  assert.equal(spectatorMessages.length, 2);
  const playerUpdate = eventBatch(playerMessages[1]!);
  const spectatorUpdate = eventBatch(spectatorMessages[1]!);
  assert.deepEqual(
    playerUpdate.events.map(({ type }) => type),
    spectatorUpdate.events.map(({ type }) => type)
  );
  assert.equal(
    playerUpdate.events.some(({ type }) => type === "ACTION_DECLARED"),
    true
  );
  assert.equal(
    playerUpdate.events.some(({ type }) => type === "PLAYER_ASCENDED"),
    true
  );
  assert.equal(
    playerUpdate.events.at(-1)?.type,
    "MATCH_ENDED"
  );
  assert.equal(playerUpdate.snapshot.self?.playerId, actorId);
  assert.equal(spectatorUpdate.snapshot.self, null);

  const retry = api.execute({
    authenticatedPlayerId: actorId,
    matchId: created.state.matchId,
    body: command
  });
  assert.deepEqual(retry, response);
  assert.equal(playerMessages.length, 2);
  assert.equal(spectatorMessages.length, 2);
});

test("reconnect returns a delta when retained history bridges the client cursor", () => {
  const created = createdMatch();
  const hub = new RealtimeMatchHub();
  hub.registerMatch(created.state, created.events);
  const lastEventSeq = created.state.eventSequence - 4;

  const delta = eventBatch(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq
    },
    { kind: "PLAYER", playerId: "player-1" }
  ));

  assert.equal(delta.afterEventSeq, lastEventSeq);
  assert.equal(delta.eventSeq, created.state.eventSequence);
  assert.equal(
    delta.events.every(({ eventSeq }) => eventSeq > lastEventSeq),
    true
  );
  assert.equal(delta.snapshot.revision, created.state.revision);
});

test("missing history and ahead cursors fall back to a current full snapshot", () => {
  const created = createdMatch();
  const hub = new RealtimeMatchHub({
    eventHistoryLimit: 3,
    recentImportantEventLimit: 2
  });
  hub.registerMatch(created.state, created.events);

  const missing = fullSnapshot(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: 0
    },
    { kind: "PLAYER", playerId: "player-0" }
  ));
  assert.equal(missing.reason, "EVENT_HISTORY_UNAVAILABLE");
  assert.equal(missing.snapshot.revision, created.state.revision);
  assert.ok(missing.recentEvents.length <= 2);
  assert.ok(missing.recentEvents.length < created.events.length);

  const initial = fullSnapshot(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: null
    },
    { kind: "SPECTATOR" }
  ));
  assert.equal(initial.reason, "INITIAL_SYNC");
  assert.equal(initial.snapshot.self, null);

  const ahead = fullSnapshot(hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: created.state.eventSequence + 1
    },
    { kind: "SPECTATOR" }
  ));
  assert.equal(ahead.reason, "CLIENT_AHEAD");
});

test("full synchronization restores CPU takeover and match result modes from server state", () => {
  const created = createdMatch(2);
  const timedOut = processInputDeadline(created.state, DEADLINE, 1);
  assert.ok(timedOut.timedOutPlayerId);
  const timeoutHub = new RealtimeMatchHub();
  timeoutHub.registerMatch(timedOut.state, timedOut.events);
  const timeoutSnapshot = fullSnapshot(timeoutHub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: timedOut.state.matchId,
      lastEventSeq: null
    },
    {
      kind: "PLAYER",
      playerId: timedOut.timedOutPlayerId
    }
  ));
  const timedOutPlayer = timeoutSnapshot.snapshot.players.find(
    ({ playerId }) => playerId === timedOut.timedOutPlayerId
  );
  assert.equal(timedOutPlayer?.controller, "CPU");
  assert.equal(timedOutPlayer?.connectionState, "DISCONNECTED");
  assert.deepEqual(
    timeoutSnapshot.snapshot.self?.legalActions,
    []
  );

  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const ended = handleCommand(created.state, {
    type: "SURRENDER",
    matchId: created.state.matchId,
    commandId: "ended-for-reconnect",
    actorId,
    expectedRevision: created.state.revision,
    occurredAt: NOW
  });
  assert.equal(ended.ok, true);
  if (!ended.ok) return;
  const resultHub = new RealtimeMatchHub();
  resultHub.registerMatch(ended.state, ended.events);
  const resultSnapshot = fullSnapshot(resultHub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: ended.state.matchId,
      lastEventSeq: null
    },
    { kind: "SPECTATOR" }
  ));
  assert.equal(resultSnapshot.snapshot.phase, "MATCH_ENDED");
  assert.deepEqual(resultSnapshot.snapshot.result, ended.state.result);
  assert.equal(resultSnapshot.snapshot.self, null);
});

test("external timeout transitions use the same realtime commit path", () => {
  const created = createdMatch(2);
  const hub = new RealtimeMatchHub();
  const api = new GameCommandApi(() => DEADLINE);
  api.onMatchEventsCommitted((state, events) => {
    hub.publish(state, events);
  });
  api.registerMatch(created.state);
  const messages: RealtimeMatchMessage[] = [];
  hub.subscribe({
    request: {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: created.state.eventSequence
    },
    viewer: { kind: "SPECTATOR" },
    send: (message) => messages.push(message)
  });
  const timedOut = processInputDeadline(created.state, DEADLINE, 1);
  api.commitMatchTransition(timedOut.state, timedOut.events);

  assert.equal(messages.length, 2);
  const update = eventBatch(messages[1]!);
  assert.equal(
    update.events.some(({ type }) => type === "INPUT_TIMED_OUT"),
    true
  );
  assert.equal(update.eventSeq, timedOut.state.eventSequence);
});

test("JSON socket adapter validates SYNC_MATCH without accepting viewer identity from payload", () => {
  assert.deepEqual(
    parseMatchSyncRequest({
      type: "SYNC_MATCH",
      matchId: "match",
      lastEventSeq: 10
    }),
    {
      type: "SYNC_MATCH",
      matchId: "match",
      lastEventSeq: 10
    }
  );
  assert.equal(
    parseMatchSyncRequest({
      type: "SYNC_MATCH",
      matchId: "match",
      lastEventSeq: 10,
      playerId: "forged"
    }),
    null
  );

  const sent: string[] = [];
  connectRealtimeSocket(new RealtimeMatchHub(), {
    request: {
      type: "SYNC_MATCH",
      matchId: "match",
      lastEventSeq: -1
    },
    viewer: { kind: "SPECTATOR" },
    socket: {
      send: (data) => sent.push(data)
    }
  });
  assert.equal(sent.length, 1);
  const error = JSON.parse(sent[0] ?? "{}") as RealtimeMatchMessage;
  assert.equal(error.type, "SYNC_ERROR");
  if (error.type !== "SYNC_ERROR") return;
  assert.equal(error.code, "INVALID_REQUEST");
});
