import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  renderBattleScreen
} from "../packages/client/src/battle-screen.ts";
import {
  OFFICIAL_WEB_2026_07_25,
  advancePresentationClock,
  createPresentationQueue,
  enqueuePresentationEvents
} from "../packages/client/src/presentation-queue.ts";
import {
  initialUiState,
  synchronizeUiState
} from "../packages/client/src/ui-machine.ts";
import {
  createMatch,
  handleCommand
} from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";
import { RealtimeMatchHub } from "../packages/server/src/realtime.ts";
import {
  advanceCpuControllers,
  processInputDeadline
} from "../packages/server/src/session.ts";
import type {
  CardInstance,
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";
import { createRng } from "../packages/shared/src/rng.ts";

const NOW = "2026-07-26T00:00:00.000Z";

type ObservationFixture = {
  source: string;
  profileId: string;
  expectedStageMs: number;
  toleranceMs: number;
  sequences: Array<{
    id: string;
    gfCount: number;
    playerName: string;
    viewerRole: "CPU" | "HUMAN";
    demonShownAtMs: number;
    centralDamageShownAtMs: number;
    ascensionShownAtMs: number;
    hpAfter: number;
    handRemainsVisible: boolean;
    matchResultShown: boolean;
  }>;
};

type EventInput = DomainEvent extends infer Event
  ? Event extends DomainEvent
    ? Omit<Event, "revision" | "occurredAt" | "visibility">
    : never
  : never;

function event(value: EventInput): DomainEvent {
  return {
    ...value,
    revision: value.eventSeq,
    occurredAt: NOW,
    visibility: { scope: "PUBLIC" }
  } as DomainEvent;
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

function players(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `p${index}`,
    displayName: `P${index}`
  }));
}

function acceptanceCaseIds(
  markdown: string,
  chapterHeading: string
): string[] {
  const chapterStart = markdown.indexOf(chapterHeading);
  assert.notEqual(chapterStart, -1);
  const chapter = markdown.slice(chapterStart + chapterHeading.length);
  const nextChapterOffset = chapter.search(/\n## \d+\./u);
  const body =
    nextChapterOffset === -1
      ? chapter
      : chapter.slice(0, nextChapterOffset);
  const ids: string[] = [];
  let section = "";
  for (const line of body.split(/\r?\n/u)) {
    const sectionMatch = /^### (\d+\.\d+)/u.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      continue;
    }
    const caseMatch = /^(\d+)\.\s/u.exec(line);
    if (caseMatch?.[1] && section) {
      ids.push(`${section}.${caseMatch[1]}`);
    }
  }
  return ids;
}

function tableCaseIds(markdown: string, prefix: string): string[] {
  const pattern = new RegExp(`^\\| (${prefix}-\\d+) \\|`, "gmu");
  return [...markdown.matchAll(pattern)].map((match) => match[1] ?? "");
}

test("T-041 acceptance inventory tracks every rule, battle, and UI specification case", () => {
  const ruleSpec = readFileSync(
    new URL("../docs/GAME_RULE_SPEC.md", import.meta.url),
    "utf8"
  );
  const battleSpec = readFileSync(
    new URL("../docs/BATTLE_SYSTEM_SPEC.md", import.meta.url),
    "utf8"
  );
  const uiSpec = readFileSync(
    new URL("../docs/GAME_UI_FLOW_SPEC.md", import.meta.url),
    "utf8"
  );
  const ruleIds = acceptanceCaseIds(
    ruleSpec,
    "## 13. 最低限の受け入れテスト"
  );
  const uiIds = acceptanceCaseIds(
    uiSpec,
    "## 12. 受け入れテスト"
  );
  const battleIds = tableCaseIds(battleSpec, "BTL");

  assert.deepEqual(
    ruleIds,
    [
      ...Array.from({ length: 10 }, (_, index) => `13.1.${index + 1}`),
      ...Array.from({ length: 8 }, (_, index) => `13.2.${index + 1}`),
      ...Array.from({ length: 6 }, (_, index) => `13.3.${index + 1}`),
      ...Array.from({ length: 3 }, (_, index) => `13.4.${index + 1}`),
      ...Array.from({ length: 4 }, (_, index) => `13.5.${index + 1}`),
      ...Array.from({ length: 5 }, (_, index) => `13.6.${index + 1}`)
    ]
  );
  assert.deepEqual(
    battleIds,
    Array.from(
      { length: 16 },
      (_, index) => `BTL-${String(index + 1).padStart(2, "0")}`
    )
  );
  assert.deepEqual(
    uiIds,
    [
      ...Array.from({ length: 6 }, (_, index) => `12.1.${index + 1}`),
      ...Array.from({ length: 8 }, (_, index) => `12.2.${index + 1}`),
      ...Array.from({ length: 4 }, (_, index) => `12.3.${index + 1}`),
      ...Array.from({ length: 6 }, (_, index) => `12.4.${index + 1}`),
      ...Array.from({ length: 6 }, (_, index) => `12.5.${index + 1}`),
      ...Array.from({ length: 8 }, (_, index) => `12.6.${index + 1}`),
      ...Array.from({ length: 4 }, (_, index) => `12.7.${index + 1}`)
    ]
  );
});

test("T-041 four-player human ascends, spectates, and receives the final CPU result", () => {
  const created = createMatch({
    matchId: "t041-four-player",
    seed: "t041-four-player-seed",
    now: NOW,
    mode: "TRAINING",
    players: players(4)
  });
  const humanId = created.state.activePlayerId;
  assert.ok(humanId);
  const playableState: MatchState = {
    ...created.state,
    players: Object.fromEntries(
      Object.entries(created.state.players).map(([playerId, player]) => [
        playerId,
        {
          ...player,
          controller: playerId === humanId ? "HUMAN" : "CPU",
          hp: playerId === humanId ? 40 : 1,
          hand:
            playerId === humanId
              ? [card("human-keepsake", "leather-cap")]
              : [card(`${playerId}-weapon`, "bronze-club")]
        }
      ])
    )
  };
  const hub = new RealtimeMatchHub();
  hub.registerMatch(playableState, created.events);
  const surrendered = handleCommand(playableState, {
    type: "SURRENDER",
    matchId: playableState.matchId,
    commandId: "human-surrenders",
    actorId: humanId,
    expectedRevision: playableState.revision,
    occurredAt: NOW
  });
  assert.equal(surrendered.ok, true);
  if (!surrendered.ok) return;
  hub.publish(surrendered.state, surrendered.events);

  const spectatingSync = hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: playableState.matchId,
      lastEventSeq: playableState.eventSequence
    },
    { kind: "PLAYER", playerId: humanId }
  );
  assert.equal(spectatingSync.type, "EVENT_BATCH");
  if (spectatingSync.type !== "EVENT_BATCH") return;
  const spectatingUi = synchronizeUiState(
    initialUiState(),
    spectatingSync.snapshot
  );
  assert.equal(spectatingUi.mode, "SPECTATING");
  assert.equal(spectatingSync.snapshot.self?.hand[0]?.instanceId, "human-keepsake");
  assert.equal(
    spectatingSync.snapshot.self?.legalActions.length,
    0
  );
  assert.equal(
    spectatingSync.snapshot.players.filter(({ alive }) => alive).length,
    3
  );

  const cpuFinish = advanceCpuControllers(
    surrendered.state,
    "2026-07-26T00:00:01.000Z",
    512
  );
  assert.equal(cpuFinish.decisionLimitReached, false);
  assert.equal(cpuFinish.state.phase, "MATCH_ENDED");
  assert.equal(cpuFinish.state.result?.kind, "WIN");
  assert.ok(cpuFinish.commands.length > 0);
  hub.publish(cpuFinish.state, cpuFinish.events);

  const finalSync = hub.synchronize(
    {
      type: "SYNC_MATCH",
      matchId: playableState.matchId,
      lastEventSeq: surrendered.state.eventSequence
    },
    { kind: "PLAYER", playerId: humanId }
  );
  assert.equal(finalSync.type, "EVENT_BATCH");
  if (finalSync.type !== "EVENT_BATCH") return;
  const finalUi = synchronizeUiState(
    spectatingUi,
    finalSync.snapshot
  );
  assert.equal(finalUi.mode, "MATCH_RESULT");
  assert.deepEqual(
    finalSync.snapshot.result,
    cpuFinish.state.result
  );
  const html = renderBattleScreen(finalSync.snapshot, finalUi);
  assert.match(html, /data-result-kind="WIN"/u);
  assert.match(html, />勝利<\/h2>/u);
  assert.match(html, /data-select-card="human-keepsake"/u);
  assert.match(html, />戦いを終わる<\/a>/u);
});

test("T-041 end-time demon can end the match at the current GF through the full UI path", () => {
  const created = createMatch({
    matchId: "t041-demon",
    seed: "t041-demon-initial-seed",
    now: NOW,
    mode: "TRAINING",
    endTimeThreshold: 1,
    players: players(2)
  });
  const actorId = created.state.activePlayerId;
  assert.ok(actorId);
  const state: MatchState = {
    ...created.state,
    endTimeActive: true,
    rng: createRng("demon-seed-9"),
    randomLog: [],
    players: {
      ...created.state.players,
      [actorId]: {
        ...created.state.players[actorId]!,
        hp: 20,
        hand: [card("sacrifice", "leather-cap")]
      }
    }
  };
  const result = handleCommand(state, {
    type: "SACRIFICE",
    matchId: state.matchId,
    commandId: "t041-lethal-demon",
    actorId,
    expectedRevision: state.revision,
    occurredAt: NOW,
    cardInstanceId: "sacrifice"
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.gfCount, 1);
  assert.equal(result.state.phase, "MATCH_ENDED");
  assert.equal(result.state.players[actorId]?.alive, false);
  assert.equal(result.state.pendingGrant.length, 0);
  assert.equal(
    result.events.some(({ type }) => type === "DEMON_APPEARED"),
    true
  );
  assert.equal(
    result.events.some(({ type }) => type === "GRANT_CANCELLED"),
    true
  );
  assert.equal(
    result.events.some(({ type }) => type === "CARD_GRANTED"),
    false
  );

  const view = projectGameView(result.state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const queue = enqueuePresentationEvents(
    createPresentationQueue(),
    result.events,
    view,
    0
  );
  const html = renderBattleScreen(view, ui, {}, queue);
  assert.equal(ui.mode, "MATCH_RESULT");
  assert.match(html, /G\.F\.1/u);
  assert.match(html, /data-result-kind="WIN"/u);
  assert.equal(
    result.events.at(-1)?.type,
    "MATCH_ENDED"
  );
});

test("T-041 virtual server clock pairs online timeout with unlimited training input", () => {
  const online = createMatch({
    matchId: "t041-online-clock",
    seed: "t041-online-clock-seed",
    now: NOW,
    mode: "ONLINE",
    players: players(2)
  }).state;
  const onlineActor = online.activePlayerId;
  assert.ok(onlineActor);
  assert.equal(
    processInputDeadline(
      online,
      "2026-07-26T00:00:14.999Z"
    ).events.length,
    0
  );
  const timedOut = processInputDeadline(
    online,
    "2026-07-26T00:00:15.000Z"
  );
  assert.equal(timedOut.timedOutPlayerId, onlineActor);
  assert.equal(timedOut.events[0]?.type, "INPUT_TIMED_OUT");
  assert.equal(timedOut.state.players[onlineActor]?.controller, "CPU");

  const late = handleCommand(timedOut.state, {
    type: "SURRENDER",
    matchId: timedOut.state.matchId,
    commandId: "late-human-command",
    actorId: onlineActor,
    expectedRevision: timedOut.state.revision,
    occurredAt: "2026-07-26T00:00:15.001Z"
  });
  assert.equal(late.ok, false);
  if (late.ok) return;
  assert.equal(late.code, "CONTROLLER_MISMATCH");

  const training = createMatch({
    matchId: "t041-training-clock",
    seed: "t041-training-clock-seed",
    now: NOW,
    mode: "TRAINING",
    players: players(2)
  }).state;
  const trainingAfter = processInputDeadline(
    training,
    "2026-07-26T01:00:00.000Z"
  );
  assert.equal(training.inputDeadlineAt, null);
  assert.equal(trainingAfter.state, training);
  assert.deepEqual(trainingAfter.events, []);
});

test(
  "T-041 replays recorded 500/1000ms combat timing within ±120ms",
  { timeout: 15_000 },
  async () => {
    const created = createMatch({
      matchId: "t041-realtime-presentation",
      seed: "t041-realtime-presentation-seed",
      now: NOW,
      mode: "TRAINING",
      players: players(4)
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
          hand: [card("timed-weapon", "bronze-club")]
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
      commandId: "timed-action",
      actorId,
      expectedRevision: state.revision,
      occurredAt: NOW,
      cardInstanceIds: ["timed-weapon"],
      targetPlayerId: targetId
    });
    assert.equal(action.ok, true);
    if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") {
      return;
    }
    const reaction = handleCommand(action.state, {
      type: "DECLARE_REACTION",
      matchId: action.state.matchId,
      commandId: "timed-reaction",
      actorId: targetId,
      expectedRevision: action.state.revision,
      occurredAt: NOW,
      reactionId: action.state.pendingAction.attack.reactionId,
      defenseCardInstanceIds: []
    });
    assert.equal(reaction.ok, true);
    if (!reaction.ok) return;
    const timedTypes = new Set<DomainEvent["type"]>([
      "ACTION_DECLARED",
      "ATTACK_CREATED",
      "REACTION_REQUESTED",
      "REACTION_DECLARED",
      "DAMAGE_APPLIED"
    ]);
    const events = [...action.events, ...reaction.events].filter(
      ({ type }) => timedTypes.has(type)
    );
    const startMs = performance.now();
    let queue = enqueuePresentationEvents(
      createPresentationQueue(),
      events,
      projectGameView(reaction.state, actorId),
      startMs
    );
    const samples: Array<{
      kind: string;
      expectedMs: number;
      actualMs: number;
    }> = [];
    while (queue.activeStep) {
      const active = queue.activeStep;
      let finishedAtMs = performance.now();
      while (finishedAtMs < active.endsAtMs) {
        await new Promise<void>((resolve) => {
          setTimeout(
            resolve,
            Math.max(1, Math.ceil(active.endsAtMs - finishedAtMs))
          );
        });
        finishedAtMs = performance.now();
      }
      samples.push({
        kind: active.step.kind,
        expectedMs: active.step.durationMs,
        actualMs: finishedAtMs - active.startedAtMs
      });
      queue = advancePresentationClock(queue, finishedAtMs);
    }

    assert.deepEqual(
      samples.map(({ kind }) => kind),
      [
        "ACTION",
        "TARGET",
        "REACTION",
        "DAMAGE_RESULT"
      ]
    );
    for (const sample of samples) {
      assert.equal(
        sample.expectedMs,
        sample.kind === "DAMAGE_RESULT" ? 1_000 : 500
      );
      assert.ok(
        Math.abs(sample.actualMs - sample.expectedMs) <= 120,
        `${sample.kind}: expected ${sample.expectedMs}ms, got ${sample.actualMs}ms`
      );
    }
  }
);

test("T-041 fixtures the observed GF31 and GF38 demon ascension sequences", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/ui-observation-2026-07-25-manual-4p.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as ObservationFixture;
  assert.equal(fixture.profileId, OFFICIAL_WEB_2026_07_25.profileId);
  assert.match(fixture.source, /UI_OBSERVATION_2026-07-25_MANUAL_4P\.md/u);
  assert.deepEqual(
    fixture.sequences.map(({ gfCount }) => gfCount),
    [31, 38]
  );

  for (const sequence of fixture.sequences) {
    const demonDelta =
      sequence.centralDamageShownAtMs - sequence.demonShownAtMs;
    const ascensionDelta =
      sequence.ascensionShownAtMs - sequence.centralDamageShownAtMs;
    assert.ok(
      Math.abs(demonDelta - fixture.expectedStageMs) <= fixture.toleranceMs
    );
    assert.ok(
      Math.abs(ascensionDelta - fixture.expectedStageMs) <=
        fixture.toleranceMs
    );
    assert.equal(sequence.hpAfter, 0);
    assert.equal(sequence.matchResultShown, false);

    const created = createMatch({
      matchId: `t041-observation-${sequence.gfCount}`,
      seed: `t041-observation-seed-${sequence.gfCount}`,
      now: NOW,
      mode: "TRAINING",
      players: [
        { playerId: "observed", displayName: sequence.playerName },
        ...players(3)
      ]
    }).state;
    const activePlayerId = created.turnOrder.find(
      (playerId) => playerId !== "observed"
    );
    assert.ok(activePlayerId);
    const state: MatchState = {
      ...created,
      gfCount: sequence.gfCount,
      activePlayerId,
      turnCursor: created.turnOrder.indexOf(activePlayerId),
      players: {
        ...created.players,
        observed: {
          ...created.players.observed!,
          hp: 0,
          alive: false,
          hand: [card("observed-hand", "leather-cap")]
        }
      }
    };
    const viewerId =
      sequence.viewerRole === "HUMAN" ? "observed" : activePlayerId;
    const snapshot = projectGameView(state, viewerId);
    const queue = enqueuePresentationEvents(
      createPresentationQueue(OFFICIAL_WEB_2026_07_25),
      [
        event({
          type: "DEMON_APPEARED",
          eventSeq: 1,
          obligationId: `observation-${sequence.gfCount}`,
          playerId: "observed",
          demonCardDefinitionId: "demon-002-中悪魔"
        }),
        event({
          type: "RESOURCE_CHANGED",
          eventSeq: 2,
          playerId: "observed",
          resource: "HP",
          delta: -20,
          valueAfter: 0,
          reason: "DEMON"
        }),
        event({
          type: "PLAYER_ASCENDED",
          eventSeq: 3,
          playerId: "observed",
          reason: "HP_ZERO"
        })
      ],
      snapshot,
      0
    );
    assert.equal(queue.activeStep?.step.kind, "DEMON");
    assert.equal(
      advancePresentationClock(queue, 999).activeStep?.step.kind,
      "DEMON"
    );
    const centralDamage = advancePresentationClock(queue, 1_000);
    assert.equal(
      centralDamage.activeStep?.step.kind,
      "DEMON_EFFECT"
    );
    assert.equal(
      advancePresentationClock(
        centralDamage,
        1_999
      ).activeStep?.step.kind,
      "DEMON_EFFECT"
    );
    const ascension = advancePresentationClock(
      centralDamage,
      2_000
    );
    assert.equal(ascension.activeStep?.step.kind, "ASCENSION");
    assert.equal(ascension.latestSnapshot?.gfCount, sequence.gfCount);
    assert.equal(
      ascension.latestSnapshot?.players.find(
        ({ playerId }) => playerId === "observed"
      )?.hp,
      0
    );
    if (sequence.handRemainsVisible) {
      assert.equal(
        ascension.latestSnapshot?.self?.hand[0]?.instanceId,
        "observed-hand"
      );
      assert.equal(
        synchronizeUiState(
          initialUiState(),
          ascension.latestSnapshot!
        ).mode,
        "SPECTATING"
      );
    }
  }
});
