import assert from "node:assert/strict";
import test from "node:test";

import {
  GameCommandApi,
  measureLoadScenario,
  RealtimeMatchHub,
  ReliableRealtimeReplica
} from "../packages/server/src/index.ts";
import {
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import { advanceCpuControllers } from "../packages/server/src/session.ts";
import type {
  CardInstance,
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";
import type {
  RealtimeMatchMessage
} from "../packages/shared/src/protocol.ts";
import { createRng } from "../packages/shared/src/rng.ts";

const NOW = "2026-07-26T06:00:00.000Z";

function players(count: number, controller: "HUMAN" | "CPU" = "CPU") {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `load-player-${index + 1}`,
    displayName: `Load Player ${index + 1}`,
    controller
  }));
}

function card(
  instanceId: string,
  cardDefinitionId: string
): CardInstance {
  return {
    instanceId,
    cardDefinitionId,
    dreamDisguiseCardDefinitionId: null
  };
}

test("T-044 completes and measures a nine-player CPU match", {
  timeout: 30_000
}, () => {
  const measured = measureLoadScenario("nine-player-cpu", () => {
    const created = createMatch({
      matchId: "t044-nine-player",
      seed: "t044-nine-player-seed",
      mode: "TRAINING",
      endTimeThreshold: 1,
      now: NOW,
      players: players(9)
    });
    const advanced = advanceCpuControllers(created.state, NOW, 30_000);
    assert.equal(advanced.decisionLimitReached, false);
    assert.equal(advanced.state.phase, "MATCH_ENDED");
    const events = [...created.events, ...advanced.events];
    const hub = new RealtimeMatchHub({
      eventHistoryLimit: Math.max(1, events.length)
    });
    hub.registerMatch(advanced.state, events);
    const transmittedMessages: RealtimeMatchMessage[] = [
      ...players(9).map(({ playerId }) =>
        hub.synchronize({
          type: "SYNC_MATCH",
          matchId: advanced.state.matchId,
          lastEventSeq: null
        }, { kind: "PLAYER", playerId })
      ),
      hub.synchronize({
        type: "SYNC_MATCH",
        matchId: advanced.state.matchId,
        lastEventSeq: null
      }, { kind: "SPECTATOR" })
    ];
    return { state: advanced.state, events, transmittedMessages };
  });

  assert.equal(measured.metrics.eventCount > 100, true);
  assert.equal(measured.metrics.eventBytes > 0, true);
  assert.equal(measured.metrics.stateBytes > 0, true);
  assert.equal(measured.metrics.transmittedBytes > 0, true);
  assert.equal(measured.metrics.durationMs >= 0, true);
  assert.equal(measured.metrics.cpuUserMicros >= 0, true);
});

test("T-044 repeatedly resolves deterministic end-time demon chains", () => {
  const measured = measureLoadScenario("end-time-demon-chain-stress", () => {
    let lastState: MatchState | null = null;
    const events: DomainEvent[] = [];
    for (let index = 0; index < 250; index += 1) {
      const created = createMatch({
        matchId: `t044-demon-${index}`,
        seed: `t044-demon-initial-${index}`,
        mode: "TRAINING",
        endTimeThreshold: 1,
        now: NOW,
        players: players(2, "HUMAN")
      });
      const actorId = created.state.activePlayerId;
      assert.ok(actorId);
      const sacrifice = card(`sacrifice-${index}`, "leather-cap");
      const state: MatchState = {
        ...created.state,
        endTimeActive: true,
        rng: createRng("demon-seed-23"),
        randomLog: [],
        players: {
          ...created.state.players,
          [actorId]: {
            ...created.state.players[actorId]!,
            hp: 99,
            hand: [sacrifice]
          }
        }
      };
      const result = handleCommand(state, {
        type: "SACRIFICE",
        matchId: state.matchId,
        commandId: `stress-demon-${index}`,
        actorId,
        expectedRevision: state.revision,
        cardInstanceId: sacrifice.instanceId
      });
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.equal(
        result.events.filter(({ type }) => type === "DEMON_APPEARED").length,
        2
      );
      lastState = result.state;
      events.push(...result.events);
    }
    assert.ok(lastState);
    return { state: lastState, events };
  });

  assert.equal(measured.metrics.eventCount >= 1_000, true);
  assert.equal(measured.metrics.eventBytes > measured.metrics.stateBytes, true);
});

test("T-044 terminates a 512-step reflection chain with an audit event", {
  timeout: 30_000
}, () => {
  const measured = measureLoadScenario("reflection-chain-limit", () => {
    const created = createMatch({
      matchId: "t044-reflection",
      seed: "t044-reflection-seed",
      now: NOW,
      players: players(2, "HUMAN")
    });
    const actorId = created.state.activePlayerId;
    assert.ok(actorId);
    const targetId = created.state.turnOrder.find(
      (playerId) => playerId !== actorId
    );
    assert.ok(targetId);
    let state: MatchState = {
      ...created.state,
      players: {
        ...created.state.players,
        [actorId]: {
          ...created.state.players[actorId]!,
          hand: [card("stress-weapon", "bronze-club")]
        },
        [targetId]: {
          ...created.state.players[targetId]!,
          hand: []
        }
      }
    };
    const action = handleCommand(state, {
      type: "DECLARE_ACTION",
      matchId: state.matchId,
      commandId: "stress-reflection-action",
      actorId,
      expectedRevision: state.revision,
      cardInstanceIds: ["stress-weapon"],
      targetPlayerId: targetId
    });
    assert.equal(action.ok, true);
    if (!action.ok) return { state, events: [] };
    state = action.state;
    const events: DomainEvent[] = [...action.events];
    let reflectionIndex = 0;
    while (state.pendingAction?.kind === "ATTACK") {
      const pendingAttack = state.pendingAction.attack;
      const defenderId = pendingAttack.targetPlayerId;
      const mirrorId = `stress-mirror-${reflectionIndex}`;
      state = {
        ...state,
        players: {
          ...state.players,
          [defenderId]: {
            ...state.players[defenderId]!,
            hand: [
              ...state.players[defenderId]!.hand,
              card(mirrorId, "super-mirror")
            ]
          }
        }
      };
      const reaction = handleCommand(state, {
        type: "DECLARE_REACTION",
        matchId: state.matchId,
        commandId: `stress-reflection-${reflectionIndex}`,
        actorId: defenderId,
        expectedRevision: state.revision,
        reactionId: pendingAttack.reactionId,
        defenseCardInstanceIds: [mirrorId]
      });
      assert.equal(reaction.ok, true);
      if (!reaction.ok) break;
      state = reaction.state;
      events.push(...reaction.events);
      reflectionIndex += 1;
      assert.equal(reflectionIndex <= 513, true);
    }
    assert.equal(reflectionIndex, 512);
    assert.equal(
      events.some(({ type }) => type === "REACTION_CHAIN_ABORTED"),
      true
    );
    return { state, events };
  });

  assert.equal(measured.metrics.eventCount > 1_000, true);
  assert.equal(measured.metrics.cpuUserMicros >= 0, true);
});

test("T-044 detects missing and duplicate delivery and recovers on reconnect", () => {
  const created = createMatch({
    matchId: "t044-delivery",
    seed: "t044-delivery-seed",
    now: NOW,
    players: players(4, "HUMAN")
  });
  const api = new GameCommandApi(() => NOW);
  const hub = new RealtimeMatchHub();
  api.registerMatch(created.state);
  hub.registerMatch(created.state, created.events);
  api.onMatchEventsCommitted((state, events) => hub.publish(state, events));
  const messages: RealtimeMatchMessage[] = [];
  const viewerId = created.state.turnOrder[0]!;
  const unsubscribe = hub.subscribe({
    request: {
      type: "SYNC_MATCH",
      matchId: created.state.matchId,
      lastEventSeq: null
    },
    viewer: { kind: "PLAYER", playerId: viewerId },
    send: (message) => messages.push(message)
  });
  for (let index = 0; index < 2; index += 1) {
    const state = api.matchState(created.state.matchId);
    assert.ok(state?.activePlayerId);
    const actorId = state.activePlayerId;
    const response = api.execute({
      authenticatedPlayerId: actorId,
      matchId: state.matchId,
      body: {
        type: "SURRENDER",
        matchId: state.matchId,
        commandId: `delivery-surrender-${index}`,
        actorId,
        expectedRevision: state.revision
      }
    });
    assert.equal(response.ok, true);
  }
  unsubscribe();
  assert.equal(messages.length, 3);

  const replica = new ReliableRealtimeReplica();
  assert.equal(replica.receive(messages[0]!).kind, "APPLIED");
  assert.equal(replica.receive(messages[2]!).kind, "RESYNC_REQUIRED");
  assert.equal(replica.receive(messages[1]!).kind, "APPLIED");
  assert.equal(replica.receive(messages[1]!).kind, "DUPLICATE");

  const reconnect = hub.synchronize({
    type: "SYNC_MATCH",
    matchId: created.state.matchId,
    lastEventSeq: replica.eventSeq
  }, { kind: "PLAYER", playerId: viewerId });
  assert.equal(replica.receive(reconnect).kind, "APPLIED");
  assert.equal(
    replica.eventSeq,
    api.matchState(created.state.matchId)?.eventSequence
  );
  assert.equal(
    replica.snapshot?.revision,
    api.matchState(created.state.matchId)?.revision
  );
});
