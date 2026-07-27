import assert from "node:assert/strict";
import test from "node:test";

import {
  createPresentationQueue,
  enqueuePresentationEvents
} from "../packages/client/src/presentation-queue.ts";
import {
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import {
  projectDomainEvent,
  projectGameView
} from "../packages/server/src/projection.ts";
import { RealtimeMatchHub } from "../packages/server/src/realtime.ts";
import type {
  CardInstance,
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";

const NOW = "2026-07-26T00:00:00.000Z";

function card(
  instanceId: string,
  cardDefinitionId: string,
  dreamDisguiseCardDefinitionId: string | null = null
): CardInstance {
  return {
    instanceId,
    cardDefinitionId,
    dreamDisguiseCardDefinitionId
  };
}

function deterministicAttackTrace(seed: string): {
  state: MatchState;
  events: DomainEvent[];
} {
  const created = createMatch({
    matchId: "t039-deterministic",
    seed,
    now: NOW,
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" }
    ]
  });
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const targetId = created.state.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state: MatchState = {
    ...created.state,
    players: {
      ...created.state.players,
      [actorId]: {
        ...created.state.players[actorId]!,
        hand: [card("weapon", "bronze-club")]
      },
      [targetId]: {
        ...created.state.players[targetId]!,
        hand: [card("armor", "leather-cap")]
      }
    }
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "t039-action",
    actorId,
    expectedRevision: state.revision,
    occurredAt: NOW,
    cardInstanceIds: ["weapon"],
    targetPlayerId: targetId
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") {
    throw new Error("The deterministic attack did not request a reaction");
  }
  const reaction = handleCommand(action.state, {
    type: "DECLARE_REACTION",
    matchId: action.state.matchId,
    commandId: "t039-reaction",
    actorId: targetId,
    expectedRevision: action.state.revision,
    occurredAt: NOW,
    reactionId: action.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["armor"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) {
    throw new Error("The deterministic reaction was rejected");
  }
  return {
    state: reaction.state,
    events: [...created.events, ...action.events, ...reaction.events]
  };
}

test("T-039 replays the same seed and command trace byte-for-byte", () => {
  const first = deterministicAttackTrace("t039-seed");
  const second = deterministicAttackTrace("t039-seed");

  assert.equal(JSON.stringify(first.events), JSON.stringify(second.events));
  assert.equal(JSON.stringify(first.state), JSON.stringify(second.state));
});

test("T-039 deduplicates command retries and repeated presentation events", () => {
  const created = createMatch({
    matchId: "t039-idempotency",
    seed: "t039-idempotency-seed",
    now: NOW,
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" }
    ]
  });
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const command = {
    type: "SURRENDER" as const,
    matchId: created.state.matchId,
    commandId: "same-command",
    actorId,
    expectedRevision: created.state.revision,
    occurredAt: NOW
  };
  const first = handleCommand(created.state, command);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const retry = handleCommand(first.state, command);
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.duplicate, true);
  assert.deepEqual(retry.events, first.events);
  assert.deepEqual(retry.state, first.state);

  const snapshot = projectGameView(first.state, actorId);
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    first.events,
    snapshot,
    0
  );
  const repeated = enqueuePresentationEvents(
    queued,
    first.events,
    snapshot,
    0
  );
  assert.deepEqual(repeated, queued);
});

test("T-039 rejects stale revisions without changing authoritative state", () => {
  const created = createMatch({
    matchId: "t039-stale",
    seed: "t039-stale-seed",
    now: NOW,
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" }
    ]
  });
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const stale = handleCommand(created.state, {
    type: "SURRENDER",
    matchId: created.state.matchId,
    commandId: "stale-command",
    actorId,
    expectedRevision: created.state.revision - 1,
    occurredAt: NOW
  });

  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.code, "STALE_REVISION");
  assert.equal(stale.state, created.state);
});

test("T-039 projections and events never expose another player's secrets", () => {
  const created = createMatch({
    matchId: "t039-privacy",
    seed: "never-publish-this-seed",
    now: NOW,
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" },
      { playerId: "c", displayName: "C" }
    ]
  });
  const secretState: MatchState = {
    ...created.state,
    players: {
      ...created.state.players,
      b: {
        ...created.state.players.b!,
        hand: [
          card("dream-card", "bronze-club", "leather-cap"),
          card("private-card", "evil-broadsword")
        ],
        learnedMiracles: [
          {
            learnedMiracleId: "private-miracle",
            cardDefinitionId: "full-heal"
          }
        ]
      }
    }
  };
  const opponentPayload = JSON.stringify(projectGameView(secretState, "a"));
  const spectatorPayload = JSON.stringify(projectGameView(secretState, null));
  for (const secret of [
    "dream-card",
    "private-card",
    "bronze-club",
    "evil-broadsword",
    "private-miracle",
    "full-heal",
    secretState.rng.seed
  ]) {
    assert.equal(opponentPayload.includes(secret), false);
    assert.equal(spectatorPayload.includes(secret), false);
  }

  const ownPayload = JSON.stringify(projectGameView(secretState, "b"));
  assert.equal(ownPayload.includes("leather-cap"), true);
  assert.equal(ownPayload.includes("bronze-club"), false);

  const privateGrant: DomainEvent = {
    type: "CARD_GRANTED",
    eventSeq: secretState.eventSequence + 1,
    revision: secretState.revision + 1,
    occurredAt: NOW,
    visibility: { scope: "PLAYER", playerId: "b" },
    obligationId: "private-obligation",
    playerId: "b",
    card: card("granted-dream", "bronze-club", "leather-cap")
  };
  assert.equal(projectDomainEvent(privateGrant, "a"), null);
  assert.equal(projectDomainEvent(privateGrant, null), null);
  const ownEvent = projectDomainEvent(privateGrant, "b");
  assert.ok(ownEvent?.type === "CARD_GRANTED");
  if (ownEvent?.type === "CARD_GRANTED") {
    assert.equal(ownEvent.card.cardDefinitionId, "leather-cap");
    assert.equal(ownEvent.card.dreamDisguiseCardDefinitionId, null);
  }
});

test("T-039 reconnect restores the same final state and winner", () => {
  const created = createMatch({
    matchId: "t039-reconnect",
    seed: "t039-reconnect-seed",
    now: NOW,
    players: [
      { playerId: "a", displayName: "A" },
      { playerId: "b", displayName: "B" }
    ]
  });
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const ended = handleCommand(created.state, {
    type: "SURRENDER",
    matchId: created.state.matchId,
    commandId: "finish-before-reconnect",
    actorId,
    expectedRevision: created.state.revision,
    occurredAt: NOW
  });
  assert.equal(ended.ok, true);
  if (!ended.ok) return;

  const hub = new RealtimeMatchHub();
  hub.registerMatch(
    ended.state,
    [...created.events, ...ended.events]
  );
  const expected = projectGameView(ended.state, actorId);
  const full = hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: ended.state.matchId,
      lastEventSeq: null
    },
    { kind: "PLAYER", playerId: actorId }
  );
  assert.equal(full.type, "FULL_SNAPSHOT");
  if (full.type !== "FULL_SNAPSHOT") return;
  assert.deepEqual(full.snapshot, expected);
  assert.deepEqual(full.snapshot.result, ended.state.result);

  const delta = hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: ended.state.matchId,
      lastEventSeq: created.state.eventSequence
    },
    { kind: "PLAYER", playerId: actorId }
  );
  assert.equal(delta.type, "EVENT_BATCH");
  if (delta.type !== "EVENT_BATCH") return;
  assert.deepEqual(delta.snapshot, expected);
  assert.equal(delta.events.at(-1)?.type, "MATCH_ENDED");
});
