import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustExchangeAllocation,
  BATTLE_SCREEN_STYLES,
  mountBattleScreen,
  renderBattleScreen
} from "../packages/client/src/battle-screen.ts";
import {
  advancePresentationClock,
  createPresentationQueue,
  enqueuePresentationEvents
} from "../packages/client/src/presentation-queue.ts";
import {
  initialUiState,
  selectActionCard,
  selectDefenseCard,
  prepareExchangeSubmission,
  prepareHandActionSubmission,
  synchronizeUiState,
  toggleExchangeDraft,
  toggleHandActionCard,
  toggleHandActionMode,
  updateExchangeDraft
} from "../packages/client/src/ui-machine.ts";
import { createMatch, handleCommand } from "../packages/server/src/engine.ts";
import {
  projectDomainEvent,
  projectGameView
} from "../packages/server/src/projection.ts";
import type {
  DomainEvent,
  MatchState
} from "../packages/shared/src/model.ts";

const REGION_NAMES = [
  "header",
  "players",
  "action",
  "response",
  "miracles",
  "hand",
  "controls",
  "result"
] as const;

function renderMatch(state: MatchState, viewerPlayerId: string): string {
  const view = projectGameView(state, viewerPlayerId);
  const ui = synchronizeUiState(initialUiState(), view);
  return renderBattleScreen(view, ui, {
    backHref: "/training",
    rulebookHref: "/rulebook"
  });
}

test("battle screen renders every required region and match header values", () => {
  const state = createMatch({
    matchId: "screen",
    seed: "screen-seed",
    mode: "ONLINE",
    endTimeThreshold: 50,
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const html = renderMatch(state, actorId);

  for (const regionName of REGION_NAMES) {
    assert.match(html, new RegExp(`data-region="${regionName}"`, "u"));
  }
  assert.match(html, /オンライン対戦/u);
  assert.match(html, /G\.F\.1/u);
  assert.match(html, /終末 G\.F\.50/u);
  assert.match(html, /data-player-count="2"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /aria-labelledby="gf-players-title"/u);
  assert.match(html, /href="\/training"/u);
  assert.match(html, /aria-label="教典を開く"/u);
});

test("match result keeps the final board, shows the winner to a losing viewer, and disables game input", () => {
  const original = createMatch({
    matchId: "result-screen",
    seed: "result-screen-seed",
    mode: "TRAINING",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" },
      { playerId: "c", displayName: "Carol" },
      { playerId: "d", displayName: "Dave" }
    ]
  }).state;
  const viewerId = original.turnOrder[0]!;
  const winnerId = original.turnOrder.find(
    (playerId) => playerId !== viewerId
  )!;
  const winnerName = original.players[winnerId]!.displayName;
  const state: MatchState = {
    ...original,
    phase: "MATCH_ENDED",
    activePlayerId: null,
    pendingAction: null,
    inputDeadlineAt: null,
    result: {
      kind: "WIN",
      winnerPlayerIds: [winnerId],
      winnerTeamId: null
    },
    players: Object.fromEntries(
      Object.entries(original.players).map(([playerId, player]) => [
        playerId,
        {
          ...player,
          alive: playerId === winnerId,
          hp: playerId === winnerId ? 23 : 0,
          mp: playerId === viewerId ? 7 : player.mp,
          money: playerId === viewerId ? 11 : player.money,
          hand:
            playerId === viewerId
              ? [
                  {
                    instanceId: "final-keepsake",
                    cardDefinitionId: "leather-cap",
                    dreamDisguiseCardDefinitionId: null
                  }
                ]
              : player.hand
        }
      ])
    )
  };
  const view = projectGameView(state, viewerId);
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(view, ui, {
    backHref: "/training",
    exitHref: "/training/setup",
    rulebookHref: "/rulebook"
  });

  assert.equal(ui.mode, "MATCH_RESULT");
  assert.equal(view.players.find(({ playerId }) => playerId === viewerId)?.hp, 0);
  assert.equal(view.self?.hand[0]?.instanceId, "final-keepsake");
  assert.match(html, /data-game-input-disabled="true"/u);
  assert.match(html, /data-result-kind="WIN"/u);
  assert.match(html, /<h2 id="gf-result-title">勝利<\/h2>/u);
  assert.match(
    html,
    new RegExp(
      `<strong class="gf-result__winner">${winnerName}</strong>`,
      "u"
    )
  );
  assert.doesNotMatch(html, /敗北/u);
  assert.match(html, /data-player-id="[^"]+"[\s\S]*?<dt>HP<\/dt><dd>0<\/dd>/u);
  assert.match(html, /<dt>MP<\/dt><dd>7<\/dd>/u);
  assert.match(html, /<dt>所持金<\/dt><dd>¥11<\/dd>/u);
  assert.match(html, /data-select-card="final-keepsake"/u);
  assert.match(html, /data-exit-match[\s\S]*?href="\/training\/setup"/u);
  assert.match(html, />戦いを終わる<\/a>/u);
  for (const button of html.match(/<button[\s\S]*?<\/button>/gu) ?? []) {
    if (button.includes("data-sound-mute")) continue;
    if (button.includes("data-toggle-cast-miracles")) continue;
    assert.match(button, /\sdisabled(?:\s|>)/u);
  }
  assert.match(BATTLE_SCREEN_STYLES, /\.gf-result\s*\{[\s\S]*?position: fixed/u);
});

test("draw result is restored for a spectator without a winner name", () => {
  const original = createMatch({
    matchId: "draw-result-screen",
    seed: "draw-result-screen-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const state: MatchState = {
    ...original,
    phase: "MATCH_ENDED",
    activePlayerId: null,
    pendingAction: null,
    inputDeadlineAt: null,
    result: {
      kind: "DRAW",
      winnerPlayerIds: [],
      winnerTeamId: null
    },
    players: Object.fromEntries(
      Object.entries(original.players).map(([playerId, player]) => [
        playerId,
        { ...player, alive: false, hp: 0 }
      ])
    )
  };
  const view = projectGameView(state, null);
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(view, ui);

  assert.equal(ui.mode, "MATCH_RESULT");
  assert.match(html, /data-viewer-role="SPECTATOR"/u);
  assert.match(html, /data-result-kind="DRAW"/u);
  assert.match(html, /data-winner-player-ids=""/u);
  assert.match(html, /<h2 id="gf-result-title">引き分け<\/h2>/u);
  assert.match(html, /勝者なし/u);
  assert.doesNotMatch(html, /class="gf-result__winner"/u);
});

test("result stays hidden until the ascension presentation has finished", () => {
  const original = createMatch({
    matchId: "result-after-ascension",
    seed: "result-after-ascension-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const state: MatchState = {
    ...original,
    phase: "MATCH_ENDED",
    activePlayerId: null,
    pendingAction: null,
    inputDeadlineAt: null,
    result: { kind: "WIN", winnerPlayerIds: ["b"], winnerTeamId: null }
  };
  const view = projectGameView(state, "a");
  const ui = synchronizeUiState(initialUiState(), view);
  const events = [
    {
      type: "PLAYER_ASCENDED",
      eventSeq: 10,
      revision: 10,
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: { scope: "PUBLIC" },
      playerId: "a",
      reason: "DAMAGE"
    },
    {
      type: "MATCH_ENDED",
      eventSeq: 11,
      revision: 11,
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: { scope: "PUBLIC" },
      result: view.result
    }
  ] as unknown as DomainEvent[];
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    view,
    0
  );

  assert.equal(queued.activeStep?.step.kind, "ASCENSION");
  assert.match(
    renderBattleScreen(view, ui, {}, queued, 0),
    /<section\s+class="gf-result"\s+data-region="result"\s+aria-labelledby="gf-result-title"\s+hidden/u
  );
  const resultBeat = advancePresentationClock(queued, 500);
  assert.equal(resultBeat.activeStep?.step.kind, "RESULT");
  assert.match(
    renderBattleScreen(view, ui, {}, resultBeat, 500),
    /data-result-kind="WIN"/u
  );
});

test("online input renders the server deadline and closes at the boundary", () => {
  const state = createMatch({
    matchId: "screen-deadline",
    seed: "screen-deadline-seed",
    mode: "ONLINE",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const deadlineAt = "2026-07-26T00:00:15.000Z";
  const view = {
    ...projectGameView(state, actorId),
    inputDeadlineAt: deadlineAt
  };
  const ui = synchronizeUiState(initialUiState(), view);
  const beforeDeadline = renderBattleScreen(
    view,
    ui,
    {},
    null,
    Date.parse("2026-07-26T00:00:05.000Z")
  );

  assert.match(beforeDeadline, /data-input-deadline="2026-07-26T00:00:15.000Z"/u);
  assert.match(beforeDeadline, /data-remaining-seconds="10"/u);
  assert.match(beforeDeadline, /gf-input-status__bar/u);
  assert.match(beforeDeadline, /--gf-deadline-elapsed: -20000ms/u);
  assert.doesNotMatch(beforeDeadline, /<time/u);

  const atDeadline = renderBattleScreen(
    view,
    ui,
    {},
    null,
    Date.parse(deadlineAt)
  );
  assert.match(atDeadline, /data-ui-mode="RESOLVING"/u);
  assert.doesNotMatch(atDeadline, /入力期限が切れました/u);
  assert.doesNotMatch(atDeadline, /data-input-deadline=/u);
});

test("training input has no countdown and remains open beyond thirty seconds", () => {
  const state = createMatch({
    matchId: "screen-training-no-deadline",
    seed: "screen-training-no-deadline-seed",
    mode: "TRAINING",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(
    view,
    ui,
    {},
    null,
    Date.parse("2026-07-26T00:00:30.001Z")
  );

  assert.equal(view.inputDeadlineAt, null);
  assert.match(html, /data-ui-mode="COMPOSING_ACTION"/u);
  assert.doesNotMatch(html, /data-input-deadline=/u);
  assert.doesNotMatch(html, /CPUが代行します/u);
});

test("disconnected and reconnected CPU control are both explicit", () => {
  const state = createMatch({
    matchId: "screen-cpu-controller",
    seed: "screen-cpu-controller-seed",
    mode: "ONLINE",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const baseView = projectGameView(state, actorId);
  const cpuView = (connectionState: "CONNECTED" | "DISCONNECTED") => ({
    ...baseView,
    inputDeadlineAt: null,
    players: baseView.players.map((player) =>
      player.playerId === actorId
        ? {
            ...player,
            controller: "CPU" as const,
            connectionState
          }
        : player
    )
  });

  const disconnectedView = cpuView("DISCONNECTED");
  const disconnectedUi = synchronizeUiState(
    initialUiState(),
    disconnectedView
  );
  const disconnectedHtml = renderBattleScreen(
    disconnectedView,
    disconnectedUi
  );
  assert.match(disconnectedHtml, /data-self-controller="CPU"/u);
  assert.match(disconnectedHtml, /data-self-connection="DISCONNECTED"/u);
  assert.doesNotMatch(disconnectedHtml, /代行/u);
  assert.match(disconnectedHtml, /切断/u);

  const reconnectedView = cpuView("CONNECTED");
  const reconnectedUi = synchronizeUiState(
    disconnectedUi,
    {
      ...reconnectedView,
      revision: reconnectedView.revision + 1
    }
  );
  const reconnectedHtml = renderBattleScreen(
    {
      ...reconnectedView,
      revision: reconnectedView.revision + 1
    },
    reconnectedUi
  );
  assert.match(reconnectedHtml, /data-self-connection="CONNECTED"/u);
  assert.doesNotMatch(reconnectedHtml, /代行|CPUのまま/u);
  assert.doesNotMatch(reconnectedHtml, />切断</u);
  assert.match(reconnectedHtml, /data-ui-mode="WAITING"/u);
});

test("battle screen keeps opponent private cards out of its rendering input", () => {
  const original = createMatch({
    matchId: "private-screen",
    seed: "private-screen-seed",
    players: [
      { playerId: "viewer", displayName: "Viewer" },
      { playerId: "opponent", displayName: "Opponent" }
    ]
  }).state;
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      opponent: {
        ...original.players.opponent!,
        hand: [
          {
            instanceId: "private-card-instance",
            cardDefinitionId: "private-card-definition",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const html = renderMatch(state, "viewer");

  assert.equal(html.includes("private-card-instance"), false);
  assert.equal(html.includes("private-card-definition"), false);
  assert.match(html, /手札 1枚/u);
});

test("calamities are listed under the player name and long names pick a smaller size tier", () => {
  const state = createMatch({
    matchId: "calamity-name",
    seed: "calamity-name-seed",
    players: [
      { playerId: "a", displayName: "gay trickshot" },
      { playerId: "b", displayName: "あきひろTRICKSHOT長い名前" }
    ]
  }).state;
  const sick = state.players["a"];
  assert.ok(sick);
  sick.calamities = { ...sick.calamities, FEVER: true, FOG: true };
  const html = renderMatch(state, "a");

  assert.match(html, /data-calamity="FEVER">熱病</u);
  assert.match(html, /data-calamity="FOG">霧</u);
  assert.match(
    html,
    /data-slot="4"><span class="gf-calamity-chip" data-calamity="FEVER"/u
  );
  assert.match(html, /data-name-size="0">gay trickshot</u);
  assert.match(html, /data-name-size="3">あきひろTRICKSHOT長い名前</u);
});

test("battle screen escapes player names and rejects unsafe navigation URLs", () => {
  const state = createMatch({
    matchId: "safe-screen",
    seed: "safe-screen-seed",
    players: [
      {
        playerId: "safe",
        displayName: '<img src=x onerror="alert(1)">'
      },
      { playerId: "other", displayName: "Other" }
    ]
  }).state;
  const view = projectGameView(state, "safe");
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(view, ui, {
    backHref: "javascript:alert(1)",
    rulebookHref: "data:text/html,unsafe"
  });

  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u);
  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("data:text"), false);
});

test("nine-player layout remains seat ordered and exposes responsive overflow", () => {
  const state = createMatch({
    matchId: "nine-player-screen",
    seed: "nine-player-screen-seed",
    players: Array.from({ length: 9 }, (_, index) => ({
      playerId: `player-${index + 1}`,
      displayName: `Player ${index + 1}`
    }))
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const html = renderMatch(state, actorId);

  assert.match(html, /data-player-count="9"/u);
  assert.equal(html.match(/data-player-id="/gu)?.length, 9);
  assert.ok(html.indexOf("Player 1") < html.indexOf("Player 9"));
  assert.match(BATTLE_SCREEN_STYLES, /@media \(max-width: 64rem\)/u);
  assert.match(BATTLE_SCREEN_STYLES, /@media \(max-width: 44rem\)/u);
  assert.match(BATTLE_SCREEN_STYLES, /overflow-x: auto/u);
  assert.match(BATTLE_SCREEN_STYLES, /:focus-visible/u);
});

test("ascended players keep their hand, lose game inputs, and observe the shared board", () => {
  const original = createMatch({
    matchId: "ascended-spectator-screen",
    seed: "ascended-spectator-screen-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" },
      { playerId: "c", displayName: "Carol" },
      { playerId: "d", displayName: "Dave" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const otherIds = original.turnOrder.filter(
    (playerId) => playerId !== actorId
  );
  const targetId = otherIds[0]!;
  const viewerId = otherIds[2]!;
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: [
          {
            instanceId: "spectated-attack",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      [viewerId]: {
        ...original.players[viewerId]!,
        alive: false,
        hp: 0,
        hand: [
          {
            instanceId: "ascended-keepsake",
            cardDefinitionId: "leather-cap",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const attack = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "spectated-action",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["spectated-attack"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok) return;

  const view = projectGameView(attack.state, viewerId);
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(view, ui);

  assert.equal(ui.mode, "SPECTATING");
  assert.equal(view.players.length, 4);
  assert.equal(view.self?.hand[0]?.instanceId, "ascended-keepsake");
  assert.match(html, /data-viewer-role="ASCENDED_PLAYER"/u);
  assert.match(html, /data-ui-mode="SPECTATING"/u);
  assert.match(html, /昇天後も手札を確認しながら/u);
  assert.match(
    html,
    /data-select-card="ascended-keepsake"[\s\S]*?disabled/u
  );
  assert.doesNotMatch(html, /data-select-target=/u);
  assert.match(html, /data-player-marker="ACTIVE"/u);
  assert.match(html, /data-player-marker="ACTING"/u);
  assert.match(html, /data-player-marker="TARGETED"/u);
  assert.match(html, /data-player-marker="ASCENDED"/u);
  assert.equal(
    html.match(
      /data-player-id="[^"]+"[\s\S]{0,240}?data-targeted="true"/gu
    )?.length,
    1
  );
  assert.match(
    html,
    new RegExp(
      `${original.players[actorId]!.displayName} から ${original.players[targetId]!.displayName}`,
      "u"
    )
  );

  const spectatorView = projectGameView(attack.state, null);
  const spectatorUi = synchronizeUiState(initialUiState(), spectatorView);
  const spectatorHtml = renderBattleScreen(spectatorView, spectatorUi);
  assert.equal(spectatorUi.mode, "SPECTATING");
  assert.match(spectatorHtml, /data-viewer-role="SPECTATOR"/u);
  assert.match(spectatorHtml, /観戦者として対戦を表示しています/u);
  assert.match(spectatorHtml, /観戦者には手札は表示されません/u);
});

test("all-enemy attack targets are rendered one at a time in server order", () => {
  const original = createMatch({
    matchId: "all-targets-screen",
    seed: "all-targets-screen-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" },
      { playerId: "c", displayName: "Carol" },
      { playerId: "d", displayName: "Dave" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const enemyIds = original.turnOrder.filter(
    (playerId) => playerId !== actorId
  );
  const state: MatchState = {
    ...original,
    players: Object.fromEntries(
      Object.entries(original.players).map(([playerId, player]) => [
        playerId,
        {
          ...player,
          hand:
            playerId === actorId
              ? [
                  {
                    instanceId: "all-targets-sword",
                    cardDefinitionId: "god-sword",
                    dreamDisguiseCardDefinitionId: null
                  },
                  {
                    instanceId: "all-targets-mirage",
                    cardDefinitionId: "mirage",
                    dreamDisguiseCardDefinitionId: null
                  }
                ]
              : []
        }
      ])
    )
  };
  const action = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "all-targets-action",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["all-targets-sword", "all-targets-mirage"],
    targetPlayerId: enemyIds[0]!
  });
  assert.equal(action.ok, true);
  if (!action.ok || action.state.pendingAction?.kind !== "ATTACK") return;
  const serverTargetOrder = [...action.state.pendingAction.targetPlayerIds];
  let currentState = action.state;
  const renderedTargetOrder: string[] = [];

  for (let index = 0; index < serverTargetOrder.length; index += 1) {
    const pending = currentState.pendingAction;
    assert.equal(pending?.kind, "ATTACK");
    if (pending?.kind !== "ATTACK") return;
    const view = projectGameView(currentState, null);
    const ui = synchronizeUiState(initialUiState(), view);
    const html = renderBattleScreen(view, ui);
    const targetId = pending.attack.targetPlayerId;
    renderedTargetOrder.push(targetId);

    assert.equal(view.pendingAttack?.targetPlayerId, targetId);
    assert.equal(view.targetPlayerIds[0], targetId);
    assert.match(
      html,
      new RegExp(`data-attack-target-index="${index + 1}"`, "u")
    );
    assert.match(html, /data-attack-target-count="3"/u);
    assert.match(html, new RegExp(`全体攻撃の対象 ${index + 1} / 3`, "u"));
    assert.equal(
      html.match(
        /data-player-id="[^"]+"[\s\S]{0,240}?data-targeted="true"/gu
      )?.length,
      1
    );
    assert.match(
      html,
      new RegExp(
        `data-player-id="${targetId}"[\\s\\S]*?data-targeted="true"`,
        "u"
      )
    );

    const reaction = handleCommand(currentState, {
      type: "DECLARE_REACTION",
      matchId: currentState.matchId,
      commandId: `all-targets-reaction-${index}`,
      actorId: targetId,
      expectedRevision: currentState.revision,
      reactionId: pending.attack.reactionId,
      defenseCardInstanceIds: []
    });
    assert.equal(reaction.ok, true);
    if (!reaction.ok) return;
    currentState = reaction.state;
  }

  assert.deepEqual(renderedTargetOrder, serverTargetOrder);
});

test("action UI renders selectable sources, targets, preview values, and an enabled submit", () => {
  const original = createMatch({
    matchId: "action-screen",
    seed: "action-screen-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" },
      { playerId: "c", displayName: "Carol" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const actor = original.players[actorId];
  assert.ok(actor);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...actor,
        hand: [
          {
            instanceId: "screen-bronze",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          },
          {
            instanceId: "screen-blowgun",
            cardDefinitionId: "blowgun",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const view = projectGameView(state, actorId);
  let ui = synchronizeUiState(initialUiState(), view);
  const initialHtml = renderBattleScreen(view, ui);
  assert.doesNotMatch(initialHtml, /data-open-utility="SURRENDER"/u);
  assert.doesNotMatch(initialHtml, />降参<\/button>/u);
  ui = selectActionCard(ui, "screen-bronze", view);
  ui = selectActionCard(ui, "screen-blowgun", view);
  const html = renderBattleScreen(view, ui);

  assert.match(html, /data-select-card="screen-bronze"/u);
  assert.match(html, /data-select-card="screen-blowgun"/u);
  // Two enemies plus the actor (single-target attacks may be self-aimed).
  assert.equal(html.match(/data-select-target="/gu)?.length, 3);
  assert.match(html, /<dt>合計攻撃<\/dt>\s*<dd>2<\/dd>/u);
  assert.match(html, /<dt>属性<\/dt>\s*<dd>物理<\/dd>/u);
  assert.match(
    html,
    /class="gf-action__content"[\s\S]*?class="gf-action__confirm"[\s\S]*?data-submit-action/u
  );
  assert.match(html, /data-submit-action\s*>行動を確定/u);
  assert.doesNotMatch(html, /data-submit-action\s+disabled/u);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__confirm,\s*\.gf-action__pray\s*\{[\s\S]*?inline-size: 46\.875%;[\s\S]*?block-size: 100%;/u
  );
});

test("pray uses the full action staging lane and exposes its hover surface", () => {
  const original = createMatch({
    matchId: "pray-stage-screen",
    seed: "pray-stage-screen-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const actor = original.players[actorId];
  assert.ok(actor);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...actor,
        hand: []
      }
    }
  };
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(view, ui);

  assert.match(
    html,
    /class="gf-action__content"[\s\S]*?class="gf-action__pray"[\s\S]*?data-submit-pray/u
  );
  assert.doesNotMatch(html, /data-submit-pray\s+disabled/u);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__confirm:hover,[\s\S]*?\.gf-action__pray:hover,[\s\S]*?background: rgb\(238 255 238 \/ 18%\);/u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__pray::after\s*\{[\s\S]*?content: "祈る";/u
  );
});

test("discard mode stacks several eligible hand cards and confirms them together", () => {
  const original = createMatch({
    matchId: "discard-toggle-screen",
    seed: "discard-toggle-screen-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const actor = original.players[actorId];
  assert.ok(actor);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...actor,
        hand: [
          {
            instanceId: "discardable-cap",
            cardDefinitionId: "leather-cap",
            dreamDisguiseCardDefinitionId: null
          },
          {
            instanceId: "discardable-dew",
            cardDefinitionId: "smile-dew",
            dreamDisguiseCardDefinitionId: null
          },
          {
            instanceId: "kept-weapon",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const view = projectGameView(state, actorId);
  const initial = synchronizeUiState(initialUiState(), view);
  const initialHtml = renderBattleScreen(view, initial);

  assert.match(
    initialHtml,
    /data-toggle-hand-action="DISCARD"[\s\S]*?aria-pressed="false"/u
  );
  assert.doesNotMatch(initialHtml, /data-utility-form="DISCARD"/u);
  assert.doesNotMatch(initialHtml, /<summary>その他の行動<\/summary>/u);

  const active = toggleHandActionMode(initial, "DISCARD");
  const activeHtml = renderBattleScreen(view, active);
  assert.match(
    activeHtml,
    /data-toggle-hand-action="DISCARD"[\s\S]*?aria-pressed="true"/u
  );
  assert.match(activeHtml, /data-select-hand-action-card="discardable-cap"/u);
  assert.match(activeHtml, /data-select-hand-action-card="discardable-dew"/u);
  assert.doesNotMatch(activeHtml, /data-select-hand-action-card="kept-weapon"/u);
  assert.match(activeHtml, /data-submit-pray\s+disabled/u);
  assert.match(activeHtml, /data-card-definition-id="discard"/u);
  assert.match(activeHtml, /data-submit-hand-action\s+disabled/u);
  const weaponButton = (
    activeHtml.match(/<button[\s\S]*?<\/button>/gu) ?? []
  ).find((button) => button.includes('data-select-card="kept-weapon"'));
  assert.ok(weaponButton);
  assert.match(weaponButton, /\sdisabled(?:\s|>)/u);

  const ignored = toggleHandActionCard(active, "kept-weapon", view);
  assert.deepEqual(ignored.selectedHandActionCardIds, []);
  const both = toggleHandActionCard(
    toggleHandActionCard(active, "discardable-cap", view),
    "discardable-dew",
    view
  );
  assert.deepEqual(both.selectedHandActionCardIds, [
    "discardable-cap",
    "discardable-dew"
  ]);
  const bothHtml = renderBattleScreen(view, both);
  const stack = bothHtml.match(
    /data-card-lane="action"[\s\S]*?data-card-lane="defense"/u
  )?.[0];
  assert.ok(stack);
  assert.deepEqual(
    [...stack.matchAll(/data-card-definition-id="([^"]+)"/gu)].map(
      (match) => match[1]
    ),
    ["discard", "leather-cap", "smile-dew"]
  );
  assert.doesNotMatch(bothHtml, /data-submit-hand-action\s+disabled/u);

  const deselected = toggleHandActionCard(both, "discardable-cap", view);
  assert.deepEqual(deselected.selectedHandActionCardIds, ["discardable-dew"]);

  const prepared = prepareHandActionSubmission(both, view, () => "discard-both");
  assert.ok(prepared);
  assert.deepEqual(prepared.command, {
    type: "DISCARD",
    matchId: view.matchId,
    commandId: "discard-both",
    actorId,
    expectedRevision: view.revision,
    cardInstanceIds: ["discardable-cap", "discardable-dew"]
  });
  assert.equal(prepareHandActionSubmission(active, view, () => "none"), null);

  const discarded = handleCommand(state, prepared.command);
  assert.equal(discarded.ok, true);
  if (!discarded.ok) return;
  const afterView = projectGameView(discarded.state, actorId);
  const afterUi = synchronizeUiState(initialUiState(), afterView);
  let presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    discarded.events,
    afterView,
    0
  );
  const stackAt = (nowMs: number): (string | undefined)[] => {
    presentation = advancePresentationClock(presentation, nowMs);
    const html = renderBattleScreen(afterView, afterUi, {}, presentation, nowMs);
    const lane = html.match(
      /data-card-lane="action"[\s\S]*?data-card-lane="defense"/u
    )?.[0];
    assert.ok(lane);
    return [...lane.matchAll(/data-card-definition-id="([^"]+)"/gu)].map(
      (match) => match[1]
    );
  };
  assert.deepEqual(stackAt(0), ["discard"]);
  assert.deepEqual(stackAt(500), ["discard", "leather-cap"]);
  assert.deepEqual(stackAt(1000), ["discard", "leather-cap", "smile-dew"]);
});

test("exchange card opens its utility UI and reallocates MP and money from HP", () => {
  const original = createMatch({
    matchId: "exchange-screen",
    seed: "exchange-screen-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const actor = original.players[actorId];
  assert.ok(actor);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...actor,
        hp: 29,
        mp: 0,
        money: 10,
        hand: [
          {
            instanceId: "screen-exchange",
            cardDefinitionId: "exchange",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const closedHtml = renderBattleScreen(view, ui);

  assert.match(
    closedHtml,
    /data-open-utility="EXCHANGE_RESOURCES" data-utility-card-instance="screen-exchange"/u
  );
  assert.doesNotMatch(closedHtml, /data-exchange-adjust/u);
  const closedButtons =
    closedHtml.match(/<button[\s\S]*?<\/button>/gu) ?? [];
  const exchangeCardButton = closedButtons.find((button) =>
    button.includes('data-open-utility="EXCHANGE_RESOURCES"')
  );
  assert.ok(exchangeCardButton);
  assert.doesNotMatch(exchangeCardButton, /\sdisabled(?:\s|>)/u);

  const opened = toggleExchangeDraft(ui, "screen-exchange", view);
  const html = renderBattleScreen(view, opened);
  const renderedButtons = html.match(/<button[\s\S]*?<\/button>/gu) ?? [];
  assert.equal(
    toggleExchangeDraft(opened, "screen-exchange", view).exchangeDraft,
    null
  );
  assert.deepEqual(
    synchronizeUiState(opened, view).exchangeDraft,
    opened.exchangeDraft
  );
  assert.doesNotMatch(html, /data-utility-form="EXCHANGE_RESOURCES"/u);
  const prayButton = renderedButtons.find((button) =>
    button.includes("data-submit-pray")
  );
  assert.ok(prayButton);
  assert.match(prayButton, /\sdisabled(?:\s|>)/u);
  assert.match(html, /class="gf-action__confirm" data-submit-exchange/u);
  assert.match(html, /data-exchange-adjust="mp:10"/u);
  assert.match(html, /data-exchange-adjust="money:10"/u);
  assert.doesNotMatch(html, /data-exchange-adjust="hp:/u);
  const mpDecreaseButton = renderedButtons.find((button) =>
    button.includes('data-exchange-adjust="mp:-1"')
  );
  const moneyDecreaseButton = renderedButtons.find((button) =>
    button.includes('data-exchange-adjust="money:-1"')
  );
  assert.ok(mpDecreaseButton);
  assert.ok(moneyDecreaseButton);
  assert.match(mpDecreaseButton, /\sdisabled(?:\s|>)/u);
  assert.doesNotMatch(moneyDecreaseButton, /\sdisabled(?:\s|>)/u);
  assert.match(
    html,
    /HP <output data-exchange-output="hp">29<\/output>/
  );
  assert.match(
    html,
    /MP <output data-exchange-output="mp">0<\/output>/
  );
  assert.match(
    html,
    /¥ <output data-exchange-output="money">10<\/output>/
  );

  const adjusted = updateExchangeDraft(opened, {
    hp: 39,
    mp: 0,
    money: 0
  });
  assert.match(
    renderBattleScreen(view, adjusted),
    /HP <output data-exchange-output="hp">39<\/output>/
  );
  const prepared = prepareExchangeSubmission(
    adjusted,
    view,
    () => "exchange-command"
  );
  assert.ok(prepared);
  assert.equal(prepared.command.type, "EXCHANGE_RESOURCES");
  assert.deepEqual(
    prepared.command.type === "EXCHANGE_RESOURCES"
      ? [
          prepared.command.cardInstanceId,
          prepared.command.hp,
          prepared.command.mp,
          prepared.command.money
        ]
      : [],
    ["screen-exchange", 39, 0, 0]
  );
  assert.doesNotMatch(
    renderBattleScreen(view, prepared.ui),
    /data-exchange-adjust/u
  );

  assert.deepEqual(
    adjustExchangeAllocation(
      { hp: 29, mp: 0, money: 10 },
      39,
      "mp",
      10
    ),
    { hp: 19, mp: 10, money: 10 }
  );
  assert.deepEqual(
    adjustExchangeAllocation(
      { hp: 29, mp: 0, money: 10 },
      39,
      "money",
      -10
    ),
    { hp: 39, mp: 0, money: 0 }
  );
  assert.equal(
    adjustExchangeAllocation(
      { hp: 29, mp: 0, money: 10 },
      39,
      "mp",
      -1
    ),
    null
  );
});

test("defender sees defense choices, total defense, forgive, and a fresh reaction id", () => {
  const original = createMatch({
    matchId: "reaction-screen",
    seed: "reaction-screen-seed",
    players: [
      { playerId: "attacker", displayName: "Attacker" },
      { playerId: "defender", displayName: "Defender" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = actorId === "attacker" ? "defender" : "attacker";
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: [
          {
            instanceId: "screen-attack",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      [targetId]: {
        ...original.players[targetId]!,
        hand: [
          {
            instanceId: "screen-defense",
            cardDefinitionId: "saver-rod",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const attack = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "screen-open-reaction",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["screen-attack"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok) return;
  const view = projectGameView(attack.state, targetId);
  let ui = synchronizeUiState(initialUiState(), view);
  const forgiveHtml = renderBattleScreen(view, ui);
  assert.doesNotMatch(forgiveHtml, /data-submit-forgive\s+disabled/u);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-response__actions:has\(\[data-submit-forgive\]:not\(:disabled\)\)\s*\{[\s\S]*?inset: 0;[\s\S]*?inline-size: 100%;[\s\S]*?block-size: 100%;/u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-response__actions \[data-submit-forgive\]::after\s*\{[\s\S]*?content: "許す";/u
  );
  ui = selectDefenseCard(ui, "screen-defense", view);
  const html = renderBattleScreen(view, ui);

  assert.match(html, /data-select-defense-card="screen-defense"/u);
  assert.match(html, /<dt>合計防御<\/dt><dd>6<\/dd>/u);
  assert.match(html, /data-submit-reaction/u);
  assert.match(html, /data-submit-forgive/u);
  assert.match(html, />許す<\/button>/u);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-response__actions:has\(\[data-submit-reaction\]:not\(:disabled\)\)\s*\{[\s\S]*?inset: 0;[\s\S]*?inline-size: 100%;[\s\S]*?block-size: 100%;/u
  );
  assert.match(html, new RegExp(`data-ui-mode="${ui.mode}"`, "u"));
  assert.ok(ui.activeReactionId);

  const attackEvent = attack.events.find(
    (event) => event.type === "ATTACK_CREATED"
  );
  assert.ok(attackEvent?.type === "ATTACK_CREATED");
  if (attackEvent?.type !== "ATTACK_CREATED") return;
  const actionEvent = attack.events.find(
    (event) => event.type === "ACTION_DECLARED"
  );
  assert.ok(actionEvent?.type === "ACTION_DECLARED");
  if (actionEvent?.type !== "ACTION_DECLARED") return;
  const stagedDefensePresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [actionEvent, attackEvent],
    view,
    0
  );
  const attackCardOnlyHtml = renderBattleScreen(
    view,
    ui,
    {},
    stagedDefensePresentation
  );
  assert.match(attackCardOnlyHtml, /data-presentation-stage="ACTION"/u);
  assert.match(attackCardOnlyHtml, /data-ui-mode="WAITING"/u);
  assert.match(attackCardOnlyHtml, /銅のこん棒/u);
  assert.doesNotMatch(
    attackCardOnlyHtml,
    /<span class="gf-action__arrow">/u
  );
  assert.doesNotMatch(attackCardOnlyHtml, /data-select-defense-card/u);
  assert.doesNotMatch(attackCardOnlyHtml, /data-submit-forgive(?:\s|>)/u);

  const arrowAndDefensePresentation = advancePresentationClock(
    stagedDefensePresentation,
    500
  );
  const arrowAndDefenseHtml = renderBattleScreen(
    view,
    ui,
    {},
    arrowAndDefensePresentation
  );
  assert.match(arrowAndDefenseHtml, /data-presentation-stage="TARGET"/u);
  assert.match(arrowAndDefenseHtml, /data-ui-mode="COMPOSING_REACTION"/u);
  assert.match(
    arrowAndDefenseHtml,
    /<span class="gf-action__arrow">➜<\/span>/u
  );
  assert.match(
    arrowAndDefenseHtml,
    /data-select-defense-card="screen-defense"/u
  );
  assert.match(arrowAndDefenseHtml, /data-submit-forgive/u);

  const stalePresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      {
        ...attackEvent,
        attack: {
          ...attackEvent.attack,
          sourceCardDefinitionIds: ["chain-sickle"]
        }
      }
    ],
    view,
    0
  );
  const synchronizedHtml = renderBattleScreen(
    view,
    ui,
    {},
    stalePresentation
  );
  assert.match(synchronizedHtml, /data-presentation-scene="attack"/u);
  assert.match(synchronizedHtml, /data-presentation-stage="TARGET"/u);
  assert.match(
    synchronizedHtml,
    /<span class="gf-action__arrow">➜<\/span>/u
  );
  assert.match(synchronizedHtml, /銅のこん棒/u);
  assert.doesNotMatch(synchronizedHtml, /鎖ガマ/u);
  assert.match(
    synchronizedHtml,
    /data-select-defense-card="screen-defense"/u
  );
  assert.match(synchronizedHtml, /data-submit-reaction/u);
  assert.match(synchronizedHtml, /data-submit-forgive/u);

  const hitEvent = attack.events.find((event) => event.type === "HIT_ROLLED");
  assert.ok(hitEvent?.type === "HIT_ROLLED");
  if (hitEvent?.type !== "HIT_ROLLED") return;
  for (const hit of [true, false]) {
    const percentagePresentation = enqueuePresentationEvents(
      createPresentationQueue(),
      [
        { ...attackEvent, hitRate: 75 },
        { ...hitEvent, hit, hitRate: 75 }
      ],
      view,
      0
    );
    assert.equal(
      percentagePresentation.activeStep?.step.kind,
      "TARGET"
    );

    const resultPresentation = advancePresentationClock(
      percentagePresentation,
      500
    );
    const resultHtml = renderBattleScreen(
      view,
      ui,
      {},
      resultPresentation
    );
    assert.match(resultHtml, /data-presentation-stage="HIT_RESULT"/u);
    assert.match(
      resultHtml,
      new RegExp(`data-result="${hit ? "hit" : "miss"}"`, "u")
    );
    assert.match(resultHtml, new RegExp(hit ? "命中" : "外れた", "u"));
    assert.match(resultHtml, /data-ui-mode="WAITING"/u);
    assert.doesNotMatch(resultHtml, /data-select-defense-card/u);

    if (hit) {
      const defensePresentation = advancePresentationClock(
        resultPresentation,
        1_500
      );
      const defenseHtml = renderBattleScreen(
        view,
        ui,
        {},
        defensePresentation
      );
      assert.equal(defensePresentation.activeStep, null);
      assert.match(defenseHtml, /data-ui-mode="COMPOSING_REACTION"/u);
      assert.match(
        defenseHtml,
        /data-select-defense-card="screen-defense"/u
      );
    }
  }

  const attackerView = projectGameView(attack.state, actorId);
  const attackerUi = synchronizeUiState(initialUiState(), attackerView);
  const attackerHtml = renderBattleScreen(attackerView, attackerUi);
  assert.doesNotMatch(attackerHtml, /data-select-defense-card/u);
  assert.doesNotMatch(attackerHtml, /screen-defense/u);
});

test("self attacks match the recorded 500/1000ms combat sequence with one defense card per stage", () => {
  const original = createMatch({
    matchId: "persistent-combat-lane",
    seed: "persistent-combat-lane-seed",
    players: [
      { playerId: "attacker", displayName: "Attacker" },
      { playerId: "defender", displayName: "Defender" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = original.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: [
          {
            instanceId: "lane-attack",
            cardDefinitionId: "chain-sickle",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      [targetId]: {
        ...original.players[targetId]!,
        hand: [
          {
            instanceId: "lane-defense",
            cardDefinitionId: "leather-clothes",
            dreamDisguiseCardDefinitionId: null
          },
          {
            instanceId: "lane-defense-2",
            cardDefinitionId: "leather-cap",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const attack = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "lane-action",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["lane-attack"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok || attack.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(attack.state, {
    type: "DECLARE_REACTION",
    matchId: attack.state.matchId,
    commandId: "lane-reaction",
    actorId: targetId,
    expectedRevision: attack.state.revision,
    reactionId: attack.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: ["lane-defense", "lane-defense-2"]
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  const sceneEvents = [...attack.events, ...reaction.events].filter(
    (event) =>
      event.type === "ACTION_DECLARED" ||
      event.type === "ATTACK_CREATED" ||
      event.type === "REACTION_REQUESTED" ||
      event.type === "REACTION_DECLARED" ||
      event.type === "DAMAGE_APPLIED"
  );
  const view = projectGameView(reaction.state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const actionPresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    sceneEvents,
    view,
    0
  );
  const actionHtml = renderBattleScreen(view, ui, {}, actionPresentation);
  assert.match(actionHtml, /data-presentation-stage="ACTION"/u);
  assert.match(actionHtml, /鎖ガマ/u);
  assert.doesNotMatch(actionHtml, /<span class="gf-action__arrow">/u);
  assert.doesNotMatch(actionHtml, /革の服/u);
  assert.match(
    actionHtml,
    new RegExp(
      `data-player-id="${actorId}"[\\s\\S]*?data-active="true"`,
      "u"
    )
  );

  const targetPresentation = advancePresentationClock(
    actionPresentation,
    500
  );
  const targetHtml = renderBattleScreen(view, ui, {}, targetPresentation);
  assert.match(targetHtml, /data-presentation-stage="TARGET"/u);
  assert.match(targetHtml, /鎖ガマ/u);
  assert.match(targetHtml, /<span class="gf-action__arrow">➜<\/span>/u);
  assert.doesNotMatch(targetHtml, /革の服/u);

  const reactionPresentation = advancePresentationClock(
    targetPresentation,
    1_000
  );
  const reactionHtml = renderBattleScreen(
    view,
    ui,
    {},
    reactionPresentation
  );

  assert.match(reactionHtml, /data-presentation-scene="attack"/u);
  assert.match(reactionHtml, /data-presentation-stage="REACTION"/u);
  assert.match(reactionHtml, /鎖ガマ/u);
  assert.match(
    reactionHtml,
    /data-card-lane="defense"[\s\S]*革の服/u
  );
  assert.doesNotMatch(
    reactionHtml,
    /data-card-lane="defense"[\s\S]*革の帽子/u
  );
  assert.match(reactionHtml, /<dt>合計防御<\/dt><dd>2<\/dd>/u);

  const fullReactionPresentation = advancePresentationClock(
    reactionPresentation,
    1_500
  );
  const fullReactionHtml = renderBattleScreen(
    view,
    ui,
    {},
    fullReactionPresentation
  );
  assert.match(fullReactionHtml, /data-presentation-stage="REACTION"/u);
  assert.match(fullReactionHtml, /革の服/u);
  assert.match(fullReactionHtml, /革の帽子/u);
  assert.match(reactionHtml, /<span class="gf-action__arrow">➜<\/span>/u);
  assert.match(
    fullReactionHtml,
    /data-card-lane="action"[\s\S]*鎖ガマ[\s\S]*data-card-lane="defense"[\s\S]*革の服[\s\S]*革の帽子/u
  );
  assert.match(fullReactionHtml, /<dt>合計防御<\/dt><dd>3<\/dd>/u);
  assert.doesNotMatch(fullReactionHtml, /data-region="presentation"/u);

  const defenderView = projectGameView(reaction.state, targetId);
  const defenderUi = synchronizeUiState(initialUiState(), defenderView);
  const defenderReactionHtml = renderBattleScreen(
    defenderView,
    defenderUi,
    {},
    fullReactionPresentation
  );
  assert.match(defenderReactionHtml, /革の服/u);
  assert.match(defenderReactionHtml, /革の帽子/u);
  assert.match(defenderReactionHtml, /data-game-input-disabled="true"/u);

  const damagePresentation = advancePresentationClock(
    fullReactionPresentation,
    2_000
  );
  const damageHtml = renderBattleScreen(view, ui, {}, damagePresentation);
  assert.match(damageHtml, /鎖ガマ/u);
  assert.match(damageHtml, /革の服/u);
  assert.match(damageHtml, /革の帽子/u);
  assert.match(damageHtml, /<span class="gf-action__arrow">➜<\/span>/u);
  assert.match(damageHtml, /data-result="damage"/u);
  assert.match(damageHtml, /<strong>2<\/strong><span>ダメージ<\/span>/u);
  assert.match(
    damageHtml,
    new RegExp(
      `data-player-id="${view.activePlayerId ?? ""}"[\\s\\S]*?data-active="true"`,
      "u"
    )
  );
  const nextAttackView = {
    ...view,
    phase: "REACTION_SELECTION" as const,
    actingPlayerId: targetId,
    targetPlayerIds: [actorId],
    pendingAttack: {
      attackId: "next-attack",
      reactionId: "next-reaction",
      seriesId: "next-series",
      attackNumber: 1,
      totalAttacks: 1,
      targetIndex: 0,
      totalTargets: 1,
      attackKind: "WEAPON" as const,
      actorId: targetId,
      targetPlayerId: actorId,
      sourceCardDefinitionIds: ["god-sword"],
      element: "PHYSICAL" as const,
      power: 50,
      hit: null,
      saleProduct: null
    }
  };
  const overlappingDamageHtml = renderBattleScreen(
    nextAttackView,
    ui,
    {},
    damagePresentation
  );
  assert.match(overlappingDamageHtml, /data-attack-id="[^"]+"/u);
  assert.match(overlappingDamageHtml, /鎖ガマ/u);
  assert.match(overlappingDamageHtml, /革の服/u);
  assert.match(overlappingDamageHtml, /革の帽子/u);
  assert.match(
    overlappingDamageHtml,
    /<strong>2<\/strong><span>ダメージ<\/span>/u
  );
  assert.doesNotMatch(overlappingDamageHtml, /神の剣/u);
  assert.doesNotMatch(overlappingDamageHtml, /<dd>50<\/dd>/u);
  const defenderDamageHtml = renderBattleScreen(
    defenderView,
    defenderUi,
    {},
    damagePresentation
  );
  assert.match(defenderDamageHtml, /革の服/u);
  assert.match(
    defenderDamageHtml,
    /<strong>2<\/strong><span>ダメージ<\/span>/u
  );
  assert.match(defenderDamageHtml, /data-game-input-disabled="true"/u);

  const settledPresentation = advancePresentationClock(
    damagePresentation,
    3_000
  );
  const settledHtml = renderBattleScreen(
    view,
    ui,
    {},
    settledPresentation
  );
  assert.equal(settledPresentation.activeStep, null);
  assert.doesNotMatch(settledHtml, /data-presentation-scene="recent-card-use"/u);
  assert.doesNotMatch(settledHtml, /鎖ガマ/u);
  assert.doesNotMatch(settledHtml, /革の服/u);
  const settledDefenderHtml = renderBattleScreen(
    defenderView,
    defenderUi,
    {},
    settledPresentation
  );
  assert.match(settledDefenderHtml, /data-game-input-disabled="false"/u);
});

test("attack UI accumulates through an additional outcome overlay before the turn changes", () => {
  const original = createMatch({
    matchId: "accumulated-attack-presentation",
    seed: "accumulated-attack-presentation-seed",
    players: [
      { playerId: "attacker", displayName: "Attacker" },
      { playerId: "defender", displayName: "Defender" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = original.turnOrder.find(
    (playerId) => playerId !== actorId
  );
  assert.ok(targetId);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: [
          {
            instanceId: "absorbing-attack",
            cardDefinitionId: "ghost-sword",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      [targetId]: {
        ...original.players[targetId]!,
        hand: []
      }
    }
  };
  const attack = handleCommand(state, {
    type: "DECLARE_ACTION",
    matchId: state.matchId,
    commandId: "absorbing-action",
    actorId,
    expectedRevision: state.revision,
    cardInstanceIds: ["absorbing-attack"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok || attack.state.pendingAction?.kind !== "ATTACK") return;
  const reaction = handleCommand(attack.state, {
    type: "DECLARE_REACTION",
    matchId: attack.state.matchId,
    commandId: "absorbing-reaction",
    actorId: targetId,
    expectedRevision: attack.state.revision,
    reactionId: attack.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.equal(reaction.ok, true);
  if (!reaction.ok) return;
  const events = [...attack.events, ...reaction.events].filter(
    (event) =>
      event.type === "ACTION_DECLARED" ||
      event.type === "ATTACK_CREATED" ||
      event.type === "REACTION_DECLARED" ||
      event.type === "DAMAGE_APPLIED" ||
      (event.type === "RESOURCE_CHANGED" &&
        event.reason === "ABSORPTION")
  );
  const view = projectGameView(reaction.state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const actionPresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    view,
    0
  );
  const targetPresentation = advancePresentationClock(
    actionPresentation,
    500
  );
  const reactionPresentation = advancePresentationClock(
    targetPresentation,
    1_000
  );
  const damagePresentation = advancePresentationClock(
    reactionPresentation,
    1_500
  );
  const damageHtml = renderBattleScreen(
    view,
    ui,
    {},
    damagePresentation
  );

  assert.match(damageHtml, /ゴーストソード/u);
  assert.match(damageHtml, /<span class="gf-action__arrow">➜<\/span>/u);
  assert.match(damageHtml, />許す</u);
  assert.match(damageHtml, /<strong>7<\/strong><span>ダメージ<\/span>/u);
  assert.match(
    damageHtml,
    new RegExp(
      `data-player-id="${actorId}"[\\s\\S]*?data-active="true"`,
      "u"
    )
  );

  const absorptionPresentation = advancePresentationClock(
    damagePresentation,
    2_500
  );
  const absorptionHtml = renderBattleScreen(
    view,
    ui,
    {},
    absorptionPresentation
  );
  assert.match(absorptionHtml, /data-presentation-stage="HP_UPDATE"/u);
  assert.match(absorptionHtml, /ゴーストソード/u);
  assert.match(
    absorptionHtml,
    /<span class="gf-action__arrow">➜<\/span>/u
  );
  assert.match(absorptionHtml, />許す</u);
  assert.match(absorptionHtml, /<strong>HP7<\/strong>/u);
  assert.doesNotMatch(absorptionHtml, /<strong>7<\/strong><span>ダメージ<\/span>/u);
  assert.match(
    absorptionHtml,
    new RegExp(
      `data-player-id="${view.activePlayerId ?? ""}"[\\s\\S]*?data-active="true"`,
      "u"
    )
  );
});

test("self recovery shows the used card and recovered HP or MP while input is locked", () => {
  const state = createMatch({
    matchId: "self-recovery-presentation",
    seed: "self-recovery-presentation-seed",
    players: [
      { playerId: "healer", displayName: "Healer" },
      { playerId: "other", displayName: "Other" }
    ]
  }).state;
  const healerId = state.activePlayerId;
  assert.ok(healerId);
  const view = projectGameView(state, healerId);
  const ui = synchronizeUiState(initialUiState(), view);
  const baseEvent = {
    revision: 1,
    occurredAt: "2026-07-27T00:00:00.000Z",
    visibility: { scope: "PUBLIC" as const }
  };
  const events: DomainEvent[] = [
    {
      ...baseEvent,
      type: "ACTION_DECLARED",
      eventSeq: 1,
      playerId: healerId,
      actionType: "DECLARE_ACTION",
      targetPlayerId: healerId,
      actionCardDefinitionIds: ["smile-dew"]
    },
    {
      ...baseEvent,
      type: "RESOURCE_CHANGED",
      eventSeq: 2,
      playerId: healerId,
      resource: "HP",
      delta: 5,
      valueAfter: 45,
      reason: "CARD_EFFECT"
    }
  ];
  const actionPresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    view,
    0
  );
  const healingPresentation = advancePresentationClock(
    actionPresentation,
    500
  );
  const healingHtml = renderBattleScreen(
    view,
    ui,
    {},
    healingPresentation
  );

  assert.match(healingHtml, /スマイルのしずく/u);
  assert.match(healingHtml, /data-result="recovery"/u);
  assert.match(healingHtml, /data-polarity="positive"/u);
  assert.match(healingHtml, /<strong>HP5<\/strong>/u);
  assert.doesNotMatch(healingHtml, /<span>hp<\/span>/u);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /@keyframes gf-effect-overlay-enter\s*\{[\s\S]*?opacity: 0;[\s\S]*?calc\(-50% \+ 24px\)[\s\S]*?opacity: 1;/u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__result\[data-polarity="positive"\]\s*\{[\s\S]*?color: #ffffff;[\s\S]*?background: #1ddd7f;/u
  );
  assert.match(healingHtml, /data-game-input-disabled="true"/u);

  const healingStartedAtMs = healingPresentation.activeStep?.startedAtMs ?? 0;
  for (const elapsedMs of [0, 120, 640]) {
    assert.match(
      renderBattleScreen(
        view,
        ui,
        {},
        healingPresentation,
        healingStartedAtMs + elapsedMs
      ),
      new RegExp(
        `data-result="recovery"[\\s\\S]*?--gf-effect-delay: ${elapsedMs === 0 ? "0" : -elapsedMs}ms`,
        "u"
      )
    );
  }

  const settled = advancePresentationClock(healingPresentation, 1_500);
  const settledHtml = renderBattleScreen(view, ui, {}, settled);
  assert.match(settledHtml, /data-game-input-disabled="false"/u);
});

test("forgive and calamity follow the recorded combat timing", () => {
  const state = createMatch({
    matchId: "forgive-calamity-presentation",
    seed: "forgive-calamity-presentation-seed",
    players: [
      { playerId: "attacker", displayName: "Attacker" },
      { playerId: "defender", displayName: "Defender" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const targetId = state.turnOrder.find((playerId) => playerId !== actorId);
  assert.ok(targetId);
  const baseEvent = {
    revision: 1,
    occurredAt: "2026-07-27T00:00:00.000Z",
    visibility: { scope: "PUBLIC" as const }
  };
  const events = [
    {
      ...baseEvent,
      type: "ATTACK_CREATED",
      eventSeq: 1,
      attack: {
        attackId: "calamity-attack",
        reactionId: "calamity-reaction",
        reactionDepth: 0,
        seriesId: "calamity-series",
        attackNumber: 1,
        totalAttacks: 1,
        targetIndex: 0,
        totalTargets: 1,
        attackKind: "WEAPON",
        actorId,
        targetPlayerId: targetId,
        sourceCardInstanceIds: ["calamity-card"],
        sourceLearnedMiracleIds: [],
        sourceCardDefinitionIds: ["severe-gale-sword"],
        element: "AIR",
        power: 5,
        hit: true
      },
      actionOwnerId: actorId,
      targetPlayerIds: [targetId],
      hitRate: 100,
      attackerGrantCount: 1,
      completion: "FINISH_TURN"
    },
    {
      ...baseEvent,
      type: "REACTION_DECLARED",
      eventSeq: 2,
      reactionId: "calamity-reaction",
      playerId: targetId,
      defenseCardInstanceIds: [],
      defenseLearnedMiracleIds: []
    },
    {
      ...baseEvent,
      type: "DAMAGE_APPLIED",
      eventSeq: 3,
      attackId: "calamity-attack",
      playerId: targetId,
      amount: 5,
      hpAfter: 35
    },
    {
      ...baseEvent,
      type: "CALAMITY_APPLIED",
      eventSeq: 4,
      playerId: targetId,
      calamity: "COLD"
    }
  ] as DomainEvent[];
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const targetPresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    view,
    0
  );
  const forgivePresentation = advancePresentationClock(
    targetPresentation,
    500
  );
  const forgiveHtml = renderBattleScreen(
    view,
    ui,
    {},
    forgivePresentation
  );
  assert.match(forgiveHtml, /data-presentation-stage="REACTION"/u);
  assert.match(
    forgiveHtml,
    /class="gf-action__forgive" data-polarity="negative"[^>]*>許す</u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__forgive\s*\{[\s\S]*?color: #eeffee;[\s\S]*?background: #aa3344;/u
  );

  const damagePresentation = advancePresentationClock(
    forgivePresentation,
    1_000
  );
  const damageHtml = renderBattleScreen(view, ui, {}, damagePresentation);
  assert.match(damageHtml, /data-polarity="negative"/u);
  assert.match(damageHtml, /<strong>5<\/strong><span>ダメージ<\/span>/u);
  assert.match(
    damageHtml,
    /class="gf-action__forgive" data-polarity="negative"[^>]*>許す</u
  );

  const calamityPresentation = advancePresentationClock(
    damagePresentation,
    2_000
  );
  const calamityHtml = renderBattleScreen(
    view,
    ui,
    {},
    calamityPresentation
  );
  assert.match(calamityHtml, /data-presentation-stage="CALAMITY"/u);
  assert.match(calamityHtml, /<strong>風邪<\/strong><span>になった<\/span>/u);
  assert.doesNotMatch(calamityHtml, /data-region="presentation"/u);

  const settled = advancePresentationClock(calamityPresentation, 2_500);
  assert.equal(settled.activeStep, null);
});

test("夢見る帽子 shows 無事, then the orange 夢 card, then 神器一新", () => {
  const state = createMatch({
    matchId: "dream-hat-presentation",
    seed: "dream-hat-presentation-seed",
    players: [
      { playerId: "attacker", displayName: "Attacker" },
      { playerId: "defender", displayName: "Defender" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const targetId = state.turnOrder.find((playerId) => playerId !== actorId);
  assert.ok(targetId);
  const baseEvent = {
    revision: 1,
    occurredAt: "2026-11-04T00:00:00.000Z",
    visibility: { scope: "PUBLIC" as const }
  };
  const events = [
    {
      ...baseEvent,
      type: "ATTACK_CREATED",
      eventSeq: 1,
      attack: {
        attackId: "dream-attack",
        reactionId: "dream-reaction",
        reactionDepth: 0,
        seriesId: "dream-series",
        attackNumber: 1,
        totalAttacks: 1,
        targetIndex: 0,
        totalTargets: 1,
        attackKind: "WEAPON",
        actorId,
        targetPlayerId: targetId,
        sourceCardInstanceIds: ["club-card"],
        sourceLearnedMiracleIds: [],
        sourceCardDefinitionIds: ["bronze-club"],
        element: "PHYSICAL",
        power: 4,
        hit: true
      },
      actionOwnerId: actorId,
      targetPlayerIds: [targetId],
      hitRate: 100,
      attackerGrantCount: 1,
      completion: "FINISH_TURN"
    },
    {
      ...baseEvent,
      type: "REACTION_DECLARED",
      eventSeq: 2,
      reactionId: "dream-reaction",
      playerId: targetId,
      defenseCardInstanceIds: ["hat-card"],
      defenseLearnedMiracleIds: [],
      defenseCardDefinitionIds: ["dreaming-hat"],
      defenseLearnedMiracleDefinitionIds: [],
      defensePower: 14,
      defenseValues: [14]
    },
    {
      ...baseEvent,
      type: "DAMAGE_APPLIED",
      eventSeq: 3,
      attackId: "dream-attack",
      playerId: targetId,
      amount: 0,
      hpAfter: 40
    },
    {
      ...baseEvent,
      type: "CALAMITY_APPLIED",
      eventSeq: 4,
      playerId: targetId,
      calamity: "DREAM"
    },
    {
      ...baseEvent,
      type: "HAND_REDRAWN",
      eventSeq: 5,
      playerId: targetId,
      cardCount: 4
    }
  ] as DomainEvent[];
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  let presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    view,
    0
  );
  const seen: string[] = [];
  for (let elapsed = 0; elapsed < 12_000; elapsed += 100) {
    const html = renderBattleScreen(view, ui, {}, presentation);
    const label = html.includes("<strong>無事</strong>")
      ? "無事"
      : /data-calamity="DREAM"[^>]*><strong>夢<\/strong>/u.test(html)
        ? "夢"
        : /data-effect="hand-redraw"[^>]*><strong>神器一新<\/strong>/u.test(html)
          ? "神器一新"
          : null;
    if (label !== null && seen.at(-1) !== label) seen.push(label);
    presentation = advancePresentationClock(presentation, elapsed + 100);
  }
  assert.deepEqual(seen, ["無事", "夢", "神器一新"]);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__effect\[data-calamity="DREAM"\]\s*\{[\s\S]*?background: #ff9900;/u
  );
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__effect\[data-effect="hand-redraw"\]\s*\{[\s\S]*?border-color: #ff9900;/u
  );
});

test("a deflected attack shows the notice, then slides the attack card to the other side", () => {
  const state = createMatch({
    matchId: "deflect-presentation",
    seed: "deflect-presentation-seed",
    players: [
      { playerId: "attacker", displayName: "Attacker" },
      { playerId: "defender", displayName: "Defender" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const targetId = state.turnOrder.find((playerId) => playerId !== actorId);
  assert.ok(targetId);
  const baseEvent = {
    revision: 1,
    occurredAt: "2026-07-27T00:00:00.000Z",
    visibility: { scope: "PUBLIC" as const }
  };
  const events = [
    {
      ...baseEvent,
      type: "ATTACK_CREATED",
      eventSeq: 1,
      attack: {
        attackId: "deflect-attack",
        reactionId: "deflect-attack:reaction:0",
        reactionDepth: 0,
        seriesId: "deflect-series",
        attackNumber: 1,
        totalAttacks: 1,
        targetIndex: 0,
        totalTargets: 1,
        attackKind: "WEAPON",
        actorId,
        targetPlayerId: targetId,
        sourceCardInstanceIds: ["deflect-card"],
        sourceLearnedMiracleIds: [],
        sourceCardDefinitionIds: ["severe-gale-sword"],
        element: "AIR",
        power: 5,
        hit: true
      },
      actionOwnerId: actorId,
      targetPlayerIds: [targetId],
      hitRate: 100,
      attackerGrantCount: 1,
      completion: "FINISH_TURN"
    },
    {
      ...baseEvent,
      type: "REACTION_DECLARED",
      eventSeq: 2,
      reactionId: "deflect-attack:reaction:0",
      playerId: targetId,
      defenseCardInstanceIds: ["shield"],
      defenseLearnedMiracleIds: [],
      defenseCardDefinitionIds: ["leather-clothes"]
    },
    {
      ...baseEvent,
      type: "ATTACK_REDIRECTED",
      eventSeq: 3,
      attackId: "deflect-attack",
      reactionId: "deflect-attack:reaction:1",
      actorId: targetId,
      targetPlayerId: actorId,
      reactionDepth: 1,
      redirectType: "REFLECT"
    }
  ] as DomainEvent[];
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const queued = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    view,
    0
  );

  // Defense card appears on its own beat, with no notice yet.
  const cardPresentation = advancePresentationClock(queued, 500);
  const cardHtml = renderBattleScreen(view, ui, {}, cardPresentation);
  assert.match(cardHtml, /class="gf-action__content"\s+data-attack-side="left"/u);
  assert.match(cardHtml, /class="[^"]*gf-field-card--defense/u);
  assert.doesNotMatch(cardHtml, /<div\s+class="gf-action__result"\s+data-result="deflect"/u);

  // The notice sits on the defense column while the defender's card stays up.
  const noticePresentation = advancePresentationClock(cardPresentation, 1_000);
  const noticeHtml = renderBattleScreen(view, ui, {}, noticePresentation);
  assert.match(noticeHtml, /class="gf-action__content"\s+data-attack-side="left"/u);
  assert.match(noticeHtml, /data-result="deflect"\s+data-placement="defense-right"[^>]*>\s*<strong>跳ね返した<\/strong>/u);
  assert.match(noticeHtml, /class="[^"]*gf-field-card--defense/u);
  assert.doesNotMatch(noticeHtml, /data-redirect-move="true"/u);

  // The defense card is gone and the attack card slides to the new actor's side.
  const movePresentation = advancePresentationClock(noticePresentation, 2_000);
  const moveHtml = renderBattleScreen(view, ui, {}, movePresentation);
  assert.match(moveHtml, /class="gf-action__content"\s+data-attack-side="left"/u);
  assert.match(moveHtml, /data-redirect-move="true"/u);
  assert.doesNotMatch(moveHtml, /<div\s+class="gf-action__result"\s+data-result="deflect"/u);
  assert.doesNotMatch(moveHtml, /class="[^"]*gf-field-card--defense/u);
  assert.match(
    BATTLE_SCREEN_STYLES,
    /\.gf-action__stack\[data-redirect-move\]\s*\{[\s\S]*?gf-redirect-slide/u
  );
});

test("disease damage uses the target-side red HP delta overlay for 1,000ms", () => {
  const state = createMatch({
    matchId: "disease-delta-presentation",
    seed: "disease-delta-presentation-seed",
    players: [
      { playerId: "sick", displayName: "Sick" },
      { playerId: "viewer", displayName: "Viewer" }
    ]
  }).state;
  const sickId = state.activePlayerId;
  assert.ok(sickId);
  const viewerId = state.turnOrder.find((playerId) => playerId !== sickId);
  assert.ok(viewerId);
  const view = projectGameView(state, viewerId);
  const ui = synchronizeUiState(initialUiState(), view);
  const baseEvent = {
    revision: 1,
    occurredAt: "2026-07-27T00:00:00.000Z",
    visibility: { scope: "PUBLIC" as const }
  };
  const presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      {
        ...baseEvent,
        type: "ACTION_DECLARED",
        eventSeq: 1,
        playerId: viewerId,
        actionType: "DECLARE_ACTION",
        targetPlayerId: sickId,
        actionCardDefinitionIds: ["bronze-club"]
      },
      {
        ...baseEvent,
        type: "CALAMITY_WORSENED",
        eventSeq: 2,
        playerId: sickId,
        from: "COLD",
        to: "FEVER"
      },
      {
        ...baseEvent,
        type: "RESOURCE_CHANGED",
        eventSeq: 3,
        playerId: sickId,
        resource: "HP",
        delta: -2,
        valueAfter: 38,
        reason: "CALAMITY"
      }
    ],
    view,
    0
  );

  const calamityWorsened = advancePresentationClock(presentation, 500);
  const diseaseDamage = advancePresentationClock(calamityWorsened, 1_000);
  const html = renderBattleScreen(view, ui, {}, diseaseDamage);
  assert.equal(diseaseDamage.activeStep?.step.kind, "HP_UPDATE");
  assert.equal(diseaseDamage.activeStep?.step.durationMs, 1_000);
  assert.match(
    html,
    /data-card-lane="defense"[\s\S]*data-result="damage"[\s\S]*data-polarity="negative"/u
  );
  assert.match(html, /data-player-id="[^"]+"/u);
  assert.match(html, /<strong>2<\/strong><span>ダメージ<\/span>/u);
  assert.doesNotMatch(html, /青銅のこん棒/u);
  assert.doesNotMatch(html, /data-region="presentation"/u);
  assert.equal(
    advancePresentationClock(diseaseDamage, 1_999).activeStep?.step.kind,
    "HP_UPDATE"
  );
  assert.equal(
    advancePresentationClock(diseaseDamage, 2_000).activeStep,
    null
  );
});

test("another player's action remains visible and locks the viewer's new turn until it settles", () => {
  const original = createMatch({
    matchId: "persistent-exchange-card",
    seed: "persistent-exchange-card-seed",
    players: [
      { playerId: "exchanger", displayName: "Exchanger" },
      { playerId: "observer", displayName: "Observer" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const observerId = original.turnOrder.find((playerId) => playerId !== actorId);
  assert.ok(observerId);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        hand: [
          {
            instanceId: "screen-exchange",
            cardDefinitionId: "exchange",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const exchanged = handleCommand(state, {
    type: "EXCHANGE_RESOURCES",
    matchId: state.matchId,
    commandId: "screen-exchange-command",
    actorId,
    expectedRevision: state.revision,
    cardInstanceId: "screen-exchange",
    hp: 25,
    mp: 15,
    money: 30
  });
  assert.equal(exchanged.ok, true);
  if (!exchanged.ok) return;
  const view = projectGameView(exchanged.state, observerId);
  const ui = synchronizeUiState(initialUiState(), view);
  const presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    exchanged.events.filter(
      ({ type }) =>
        type === "ACTION_DECLARED" || type === "RESOURCES_EXCHANGED"
    ),
    view,
    0
  );
  const activeHtml = renderBattleScreen(view, ui, {}, presentation);
  const html = renderBattleScreen(view, ui, {}, {
    ...presentation,
    activeStep: null,
    pendingSteps: []
  });

  assert.equal(view.activePlayerId, observerId);
  assert.match(activeHtml, /data-presentation-scene="recent-card-use"/u);
  assert.match(activeHtml, /が両替した/u);
  assert.match(activeHtml, /data-game-input-disabled="true"/u);
  assert.doesNotMatch(html, /data-presentation-scene="recent-card-use"/u);
  assert.doesNotMatch(html, /が両替した/u);
  assert.doesNotMatch(html, /screen-exchange/u);
  assert.match(html, /data-game-input-disabled="false"/u);
});

test("exchange reveal stages before, arrow, and after while the player list holds", () => {
  const original = createMatch({
    matchId: "exchange-stages",
    seed: "exchange-stages-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const actor = original.players[actorId];
  assert.ok(actor);
  const state: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...actor,
        hp: 9,
        mp: 10,
        money: 20,
        hand: [
          {
            instanceId: "stage-exchange",
            cardDefinitionId: "exchange",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const exchanged = handleCommand(state, {
    type: "EXCHANGE_RESOURCES",
    matchId: state.matchId,
    commandId: "stage-exchange-command",
    actorId,
    expectedRevision: state.revision,
    cardInstanceId: "stage-exchange",
    hp: 29,
    mp: 0,
    money: 10
  });
  assert.equal(exchanged.ok, true);
  if (!exchanged.ok) return;
  const view = projectGameView(exchanged.state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  let presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    exchanged.events.filter(
      ({ type }) =>
        type === "ACTION_DECLARED" || type === "RESOURCES_EXCHANGED"
    ),
    view,
    0
  );
  const renderAt = (nowMs: number): string => {
    presentation = advancePresentationClock(presentation, nowMs);
    return renderBattleScreen(view, ui, {}, presentation, nowMs);
  };
  const playerList = (html: string): string =>
    html.slice(html.indexOf('data-region="players"'));

  const declared = renderAt(0);
  assert.doesNotMatch(declared, /data-exchange-result-stage/u);
  assert.match(playerList(declared), /<dt>HP<\/dt><dd>9<\/dd>/u);

  const before = renderAt(500);
  assert.match(before, /data-exchange-result-stage="0"/u);
  assert.match(before, /<b>9<\/b>/u);
  assert.doesNotMatch(before, /class="gf-exchange__arrow"/u);
  assert.doesNotMatch(before, /data-exchange-row="after">/u);

  const arrow = renderAt(1_000);
  assert.match(arrow, /class="gf-exchange__arrow"/u);
  assert.doesNotMatch(arrow, /data-exchange-row="after">/u);

  const after = renderAt(1_500);
  assert.match(after, /data-exchange-row="after">/u);
  assert.match(after, /<b>29<\/b>/u);
  assert.match(playerList(after), /<dt>HP<\/dt><dd>9<\/dd>/u);

  const settled = renderAt(3_000);
  assert.doesNotMatch(settled, /data-exchange-result-stage/u);
  assert.match(playerList(settled), /<dt>HP<\/dt><dd>29<\/dd>/u);
});

test("a following CPU attack stays hidden until the current attack presentation settles", () => {
  const state = createMatch({
    matchId: "deferred-cpu-attack",
    seed: "deferred-cpu-attack-seed",
    players: [
      { playerId: "human", displayName: "Human" },
      { playerId: "cpu", displayName: "CPU", controller: "CPU" }
    ]
  }).state;
  const view = projectGameView(state, "human");
  const ui = synchronizeUiState(initialUiState(), view);
  const currentAttack = {
    attackId: "human-attack",
    reactionId: "human-reaction",
    reactionDepth: 0,
    seriesId: "human-series",
    attackNumber: 1,
    totalAttacks: 1,
    targetIndex: 0,
    totalTargets: 1,
    attackKind: "WEAPON" as const,
    actorId: "human",
    targetPlayerId: "cpu",
    sourceCardInstanceIds: ["human-card"],
    sourceLearnedMiracleIds: [],
    sourceCardDefinitionIds: ["bronze-club"],
    element: "PHYSICAL" as const,
    power: 5,
    hit: null,
    saleProduct: null
  };
  const latestView = {
    ...view,
    activePlayerId: "cpu",
    actingPlayerId: "cpu",
    pendingAttack: {
      attackId: "cpu-attack",
      reactionId: "cpu-reaction",
      seriesId: "cpu-series",
      attackNumber: 1,
      totalAttacks: 1,
      targetIndex: 0,
      totalTargets: 1,
      attackKind: "WEAPON" as const,
      actorId: "cpu",
      targetPlayerId: "human",
      sourceCardDefinitionIds: ["crossbow"],
      element: "PHYSICAL" as const,
      power: 7,
      hit: null,
      saleProduct: null
    }
  };
  const baseEvent = {
    revision: 1,
    occurredAt: "2026-07-29T00:00:00.000Z",
    visibility: { scope: "PUBLIC" as const }
  };
  const presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      {
        ...baseEvent,
        type: "ACTION_DECLARED",
        eventSeq: 1,
        playerId: "human",
        actionType: "DECLARE_ACTION",
        targetPlayerId: "cpu",
        actionCardDefinitionIds: ["bronze-club"]
      },
      {
        ...baseEvent,
        revision: 2,
        type: "ATTACK_CREATED",
        eventSeq: 2,
        attack: currentAttack,
        actionOwnerId: "human",
        targetPlayerIds: ["cpu"],
        hitRate: 100,
        attackerGrantCount: 1,
        completion: "FINISH_TURN"
      }
    ],
    latestView,
    0
  );

  const currentActionHtml = renderBattleScreen(
    latestView,
    ui,
    {},
    presentation
  );
  assert.match(currentActionHtml, /銅のこん棒/u);
  assert.doesNotMatch(currentActionHtml, /クロスボウ/u);

  const currentTargetHtml = renderBattleScreen(
    latestView,
    ui,
    {},
    advancePresentationClock(presentation, 500)
  );
  assert.match(currentTargetHtml, /銅のこん棒/u);
  assert.doesNotMatch(currentTargetHtml, /クロスボウ/u);

  const settledHtml = renderBattleScreen(latestView, ui, {}, {
    ...presentation,
    activeStep: null,
    pendingSteps: []
  });
  assert.match(settledHtml, /クロスボウ/u);
});

test("another player's healing card shows for 500ms, then its recovery for 1,000ms before input unlocks", () => {
  const state = createMatch({
    matchId: "foreign-recovery-presentation",
    seed: "foreign-recovery-presentation-seed",
    players: [
      { playerId: "healer", displayName: "player2" },
      { playerId: "viewer", displayName: "Viewer" }
    ]
  }).state;
  const healerId = state.activePlayerId;
  assert.ok(healerId);
  const viewerId = state.turnOrder.find((playerId) => playerId !== healerId);
  assert.ok(viewerId);
  const viewerTurnState: MatchState = {
    ...state,
    activePlayerId: viewerId,
    turnCursor: state.turnOrder.indexOf(viewerId)
  };
  const view = projectGameView(viewerTurnState, viewerId);
  const ui = synchronizeUiState(initialUiState(), view);
  const baseEvent = {
    revision: 1,
    occurredAt: "2026-07-27T00:00:00.000Z",
    visibility: { scope: "PUBLIC" as const }
  };
  const presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      {
        ...baseEvent,
        type: "ACTION_DECLARED",
        eventSeq: 1,
        playerId: healerId,
        actionType: "DECLARE_ACTION",
        targetPlayerId: healerId,
        actionCardDefinitionIds: ["heart-dew"]
      },
      {
        ...baseEvent,
        type: "RESOURCE_CHANGED",
        eventSeq: 2,
        playerId: healerId,
        resource: "HP",
        delta: 10,
        valueAfter: 40,
        reason: "CARD_EFFECT"
      }
    ],
    view,
    0
  );

  const cardHtml = renderBattleScreen(view, ui, {}, presentation);
  assert.match(cardHtml, /data-presentation-stage="ACTION"/u);
  assert.match(cardHtml, /player2が神器・奇跡を使用/u);
  assert.match(cardHtml, /ハートのしずく/u);
  assert.match(cardHtml, /data-game-input-disabled="true"/u);

  const recovery = advancePresentationClock(presentation, 500);
  const recoveryHtml = renderBattleScreen(view, ui, {}, recovery);
  assert.match(recoveryHtml, /data-presentation-stage="HP_UPDATE"/u);
  assert.match(recoveryHtml, /ハートのしずく/u);
  assert.match(recoveryHtml, /data-polarity="positive"/u);
  assert.match(recoveryHtml, /<strong>HP10<\/strong>/u);
  assert.doesNotMatch(recoveryHtml, /<span>hp<\/span>/u);
  assert.match(recoveryHtml, /data-game-input-disabled="true"/u);

  const settled = advancePresentationClock(recovery, 1_500);
  const settledHtml = renderBattleScreen(view, ui, {}, settled);
  assert.equal(settled.activeStep, null);
  assert.match(settledHtml, /data-game-input-disabled="false"/u);
  assert.doesNotMatch(
    settledHtml,
    /data-presentation-scene="recent-card-use"/u
  );
});

test("CPU defense and private trade payment are rendered in the response region", () => {
  const original = createMatch({
    matchId: "response-screen",
    seed: "response-screen-seed",
    players: [
      { playerId: "buyer", displayName: "Buyer" },
      { playerId: "seller", displayName: "Seller", controller: "CPU" }
    ]
  }).state;
  const actorId = original.activePlayerId;
  assert.ok(actorId);
  const targetId = actorId === "buyer" ? "seller" : "buyer";
  const attackState: MatchState = {
    ...original,
    players: {
      ...original.players,
      [actorId]: {
        ...original.players[actorId]!,
        controller: "HUMAN",
        hand: [
          {
            instanceId: "cpu-attack",
            cardDefinitionId: "bronze-club",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      [targetId]: {
        ...original.players[targetId]!,
        controller: "CPU",
        hand: []
      }
    }
  };
  const attack = handleCommand(attackState, {
    type: "DECLARE_ACTION",
    matchId: attackState.matchId,
    commandId: "cpu-defense-screen",
    actorId,
    expectedRevision: attackState.revision,
    cardInstanceIds: ["cpu-attack"],
    targetPlayerId: targetId
  });
  assert.equal(attack.ok, true);
  if (!attack.ok) return;
  const observerView = projectGameView(attack.state, actorId);
  const observerUi = synchronizeUiState(initialUiState(), observerView);
  assert.match(
    renderBattleScreen(observerView, observerUi),
    /（CPU）が防御を選択しています/u
  );

  const buyState: MatchState = {
    ...original,
    activePlayerId: "buyer",
    turnCursor: original.turnOrder.indexOf("buyer"),
    players: {
      ...original.players,
      buyer: {
        ...original.players.buyer!,
        money: 3,
        mp: 2,
        hand: [
          {
            instanceId: "screen-buy",
            cardDefinitionId: "buy",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      },
      seller: {
        ...original.players.seller!,
        hand: [
          {
            instanceId: "screen-offer",
            cardDefinitionId: "sword-shield",
            dreamDisguiseCardDefinitionId: null
          }
        ]
      }
    }
  };
  const offer = handleCommand(buyState, {
    type: "DECLARE_BUY",
    matchId: buyState.matchId,
    commandId: "screen-buy-offer",
    actorId: "buyer",
    expectedRevision: buyState.revision,
    cardInstanceId: "screen-buy",
    targetPlayerId: "seller"
  });
  assert.equal(offer.ok, true);
  if (!offer.ok || offer.state.pendingAction?.kind !== "ATTACK") return;
  const allowed = handleCommand(
    offer.state,
    {
      type: "DECLARE_REACTION",
      matchId: offer.state.matchId,
      commandId: "screen-buy-allowed",
      actorId: "seller",
      expectedRevision: offer.state.revision,
      reactionId: offer.state.pendingAction.attack.reactionId,
      defenseCardInstanceIds: []
    },
    "CPU"
  );
  assert.equal(allowed.ok, true);
  if (!allowed.ok) return;
  const buyerView = projectGameView(allowed.state, "buyer");
  const buyerUi = synchronizeUiState(initialUiState(), buyerView);
  const tradeHtml = renderBattleScreen(buyerView, buyerUi);

  assert.match(tradeHtml, /ソードシールド/u);
  assert.match(tradeHtml, /<dt>価格<\/dt><dd>¥15<\/dd>/u);
  assert.match(tradeHtml, /<dt>所持金<\/dt><dd>3<\/dd>/u);
  assert.match(tradeHtml, /<dt>MP<\/dt><dd>2<\/dd>/u);
  assert.match(tradeHtml, /<dt>HP<\/dt><dd>10<\/dd>/u);
  assert.match(tradeHtml, /data-confirm-buy/u);
  assert.match(tradeHtml, /data-decline-buy/u);
});

test("presentation overlay does not render card grant notices", () => {
  const state = createMatch({
    matchId: "dream-presentation",
    seed: "dream-presentation-seed",
    players: [
      { playerId: "viewer", displayName: "Viewer" },
      { playerId: "other", displayName: "Other" }
    ]
  }).state;
  const view = projectGameView(state, "viewer");
  const rawEvent: DomainEvent = {
    type: "CARD_GRANTED",
    eventSeq: state.eventSequence + 1,
    revision: state.revision + 1,
    occurredAt: "2026-07-26T00:00:00.000Z",
    visibility: { scope: "PLAYER", playerId: "viewer" },
    obligationId: "dream-grant",
    playerId: "viewer",
    card: {
      instanceId: "dream-card",
      cardDefinitionId: "sun-amulet",
      dreamDisguiseCardDefinitionId: "leather-cap"
    }
  };
  const projectedEvent = projectDomainEvent(rawEvent, "viewer");
  assert.ok(projectedEvent);
  const presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [projectedEvent],
    view,
    0
  );
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(view, ui, {}, presentation);

  assert.equal(presentation.activeStep, null);
  assert.doesNotMatch(html, /data-region="presentation"/u);
  assert.equal(projectDomainEvent(rawEvent, "other"), null);
  assert.equal(projectDomainEvent(rawEvent, null), null);
  assert.equal(rawEvent.card.cardDefinitionId, "sun-amulet");
});

test("demon damage and ascension overlays use central and simultaneous result copy", () => {
  const state = createMatch({
    matchId: "demon-presentation",
    seed: "demon-presentation-seed",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const view = projectGameView(state, "a");
  const ui = synchronizeUiState(initialUiState(), view);
  const damage: DomainEvent = {
    type: "RESOURCE_CHANGED",
    eventSeq: 1,
    revision: 1,
    occurredAt: "2026-07-26T00:00:00.000Z",
    visibility: { scope: "PUBLIC" },
    playerId: "a",
    resource: "HP",
    delta: -40,
    valueAfter: 0,
    reason: "DEMON"
  };
  const damagePresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [damage],
    view,
    0
  );
  const damageHtml = renderBattleScreen(
    view,
    ui,
    {},
    damagePresentation
  );
  assert.match(damageHtml, /data-presentation-kind="DEMON_EFFECT"/u);
  assert.match(damageHtml, /data-central="true"/u);
  assert.match(damageHtml, /Alice HP -40/u);

  const ascension: DomainEvent = {
    type: "PLAYER_ASCENDED",
    eventSeq: 2,
    revision: 2,
    occurredAt: "2026-07-26T00:00:01.000Z",
    visibility: { scope: "PUBLIC" },
    playerId: "a",
    reason: "HP_ZERO"
  };
  const ascensionPresentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [ascension],
    view,
    0
  );
  const ascensionHtml = renderBattleScreen(
    view,
    ui,
    {},
    ascensionPresentation
  );
  assert.match(ascensionHtml, /Aliceが昇天/u);
  assert.match(ascensionHtml, /HP 0・昇天/u);
});

test("a replacement card stays face-down until the battle presentation settles", () => {
  const state = createMatch({
    matchId: "concealed-replacement-card",
    seed: "concealed-replacement-card-seed",
    players: [
      { playerId: "actor", displayName: "Actor" },
      { playerId: "target", displayName: "Target" }
    ]
  }).state;
  const baseView = projectGameView(state, "actor");
  assert.ok(baseView.self);
  const replacementCard = {
    instanceId: "replacement-card-instance",
    cardDefinitionId: "replacement-card-secret",
    dreamDisguiseCardDefinitionId: null
  };
  const view = {
    ...baseView,
    self: {
      ...baseView.self,
      hand: [...baseView.self.hand, replacementCard]
    }
  };
  const common = {
    revision: 1,
    occurredAt: "2026-07-29T00:00:00.000Z"
  };
  const events: DomainEvent[] = [
    {
      ...common,
      type: "ACTION_DECLARED",
      eventSeq: 1,
      visibility: { scope: "PUBLIC" },
      playerId: "actor",
      actionType: "DECLARE_ACTION",
      targetPlayerId: "target",
      actionCardDefinitionIds: ["bronze-club"]
    },
    {
      ...common,
      type: "GRANT_REQUESTED",
      eventSeq: 2,
      visibility: { scope: "PUBLIC" },
      obligation: {
        obligationId: "replacement-grant",
        playerId: "actor",
        reason: "CARD_USED"
      }
    },
    {
      ...common,
      type: "CARD_GRANTED",
      eventSeq: 3,
      visibility: { scope: "PLAYER", playerId: "actor" },
      obligationId: "replacement-grant",
      playerId: "actor",
      card: replacementCard
    }
  ];
  const presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    events,
    view,
    0
  );
  const ui = synchronizeUiState(initialUiState(), view);
  const activeHtml = renderBattleScreen(view, ui, {}, presentation);

  assert.deepEqual(presentation.concealedCardInstanceIds, [
    replacementCard.instanceId
  ]);
  assert.match(activeHtml, /data-card-concealed="true"/u);
  assert.match(activeHtml, /戦闘演出の終了後に公開されます/u);
  assert.doesNotMatch(activeHtml, /replacement-card-secret/u);

  const settled = advancePresentationClock(presentation, 500);
  const settledHtml = renderBattleScreen(view, ui, {}, settled);
  assert.equal(settled.activeStep, null);
  assert.deepEqual(settled.concealedCardInstanceIds, []);
  assert.doesNotMatch(settledHtml, /data-card-concealed="true"/u);
  assert.match(settledHtml, /replacement-card-secret/u);
});

test("deadline re-renders resume a result overlay instead of replaying it", () => {
  const state = createMatch({
    matchId: "overlay-deadline-rerender",
    seed: "overlay-deadline-rerender-seed",
    players: [
      { playerId: "healer", displayName: "Healer" },
      { playerId: "other", displayName: "Other" }
    ]
  }).state;
  const healerId = state.activePlayerId;
  assert.ok(healerId);
  const startMs = Date.parse("2026-07-27T00:00:00.000Z");
  const view = {
    ...projectGameView(state, healerId),
    inputDeadlineAt: "2026-07-27T00:00:30.500Z"
  };
  let clockMs = startMs;
  const renders: string[] = [];
  const container = {
    set innerHTML(html: string) {
      renders.push(html);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  } as unknown as HTMLElement;
  const screen = mountBattleScreen(
    container,
    view,
    synchronizeUiState(initialUiState(), view),
    {},
    { now: () => clockMs }
  );
  screen.applyRealtimeMessage(
    {
      type: "EVENT_BATCH",
      matchId: state.matchId,
      afterEventSeq: 0,
      eventSeq: 1,
      events: [
        {
          revision: 1,
          occurredAt: "2026-07-27T00:00:00.000Z",
          visibility: { scope: "PUBLIC" },
          type: "RESOURCE_CHANGED",
          eventSeq: 1,
          playerId: healerId,
          resource: "HP",
          delta: 5,
          valueAfter: 45,
          reason: "CARD_EFFECT"
        }
      ],
      snapshot: view
    },
    startMs
  );
  const rendersBeforeTick = renders.length;
  clockMs = startMs + 600;
  screen.tick(clockMs);
  screen.dispose();

  const overlayRenders = renders
    .slice(rendersBeforeTick)
    .filter((html) => /data-result="recovery"/u.test(html));
  assert.equal(overlayRenders.length, 1);
  assert.match(
    overlayRenders.at(-1) ?? "",
    /data-result="recovery"[\s\S]*?--gf-effect-delay: -\d+ms/u
  );
});

test("hidden brawl header shows its mode label and an exit action", () => {
  const { state } = createMatch({
    matchId: "hidden-header",
    seed: "hidden-header-seed",
    mode: "ONLINE",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  });
  const view = projectGameView(state, null);
  const ui = synchronizeUiState(initialUiState(), view);
  const html = renderBattleScreen(view, ui, {
    modeLabel: "隠れ乱闘",
    exitAction: true
  });

  assert.match(html, /gf-header__mode">隠れ乱闘</u);
  assert.match(html, /data-exit-battle/u);
  assert.doesNotMatch(renderBattleScreen(view, ui), /data-exit-battle/u);
});

test("guardian assignment shows summon art, then a portrait chip on the name plate", () => {
  const state = createMatch({
    matchId: "guardian-screen",
    seed: "guardian-screen-seed",
    mode: "TRAINING",
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const guardian = { guardianId: "g1", guardianName: "火星神" };
  const hosted: MatchState = {
    ...state,
    players: {
      ...state.players,
      a: { ...state.players.a!, guardian }
    }
  };
  const view = projectGameView(hosted, "a");
  const ui = synchronizeUiState(initialUiState(), view);
  const plain = renderBattleScreen(view, ui);
  assert.match(
    plain,
    /class="gf-player__guardian"[\s\S]*?gf-player__guardian-name">火星神</u
  );
  assert.doesNotMatch(plain, /data-guardian-summon=/u);

  const presentation = enqueuePresentationEvents(
    createPresentationQueue(),
    [
      {
        type: "GUARDIAN_ASSIGNED",
        eventSeq: 1,
        playerId: "a",
        guardian
      } as DomainEvent
    ],
    view,
    0
  );
  const html = renderBattleScreen(view, ui, {}, presentation);
  assert.match(html, /data-guardian-summon="a"/u);
  assert.match(html, /<img[^>]*class="gf-guardian-summon__art"/u);
  assert.match(html, /火星神が宿りました/u);
  assert.match(html, /class="gf-player__guardian"[^>]*data-intro="true"/u);
});

test("hovering a card shows its staged-size detail card in the right panel", () => {
  const state = createMatch({
    matchId: "hover-detail",
    seed: "hover-detail-seed",
    mode: "ONLINE",
    endTimeThreshold: 50,
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const cardDefinitionId = view.self?.hand[0]?.cardDefinitionId;
  assert.ok(cardDefinitionId);

  assert.doesNotMatch(renderBattleScreen(view, ui), /data-card-detail/u);
  const html = renderBattleScreen(
    view,
    ui,
    {},
    null,
    Date.now(),
    cardDefinitionId
  );
  const detail = html.slice(html.indexOf("<div class=\"gf-card-detail\""));
  assert.match(detail, /^<div class="gf-card-detail" data-card-detail[^>]*>[\r\n ]*<article/u);
  assert.ok(
    detail
      .slice(0, detail.indexOf("</div>"))
      .includes(`data-card-definition-id="${cardDefinitionId}"`)
  );
});

test("cast-miracle toggle shows every player's last invoked miracle instead of resources", () => {
  const state = createMatch({
    matchId: "cast-miracles",
    seed: "cast-miracles-seed",
    mode: "ONLINE",
    endTimeThreshold: 50,
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  state.players.a!.lastMiracleCardDefinitionId = "miracle-sun-amulet";
  const view = projectGameView(state, "b");
  const ui = synchronizeUiState(initialUiState(), view);
  const alice = view.players.find(({ playerId }) => playerId === "a");
  assert.equal(alice?.lastMiracleCardDefinitionId, "miracle-sun-amulet");
  assert.equal(
    view.players.find(({ playerId }) => playerId === "b")
      ?.lastMiracleCardDefinitionId,
    null
  );

  const off = renderBattleScreen(view, ui);
  assert.match(off, /data-toggle-cast-miracles\s+aria-pressed="false"/u);
  assert.doesNotMatch(off, /class="gf-cast-miracle"/u);

  const on = renderBattleScreen(view, ui, {}, null, Date.now(), null, true);
  assert.match(on, /data-toggle-cast-miracles\s+aria-pressed="true"/u);
  assert.equal(on.match(/class="gf-cast-miracle"/gu)?.length, 2);
  assert.equal(on.match(/class="gf-cast-miracle" data-empty/gu)?.length, 1);
});

test("learned miracles stay pinned in the hand's bottom-right cells", () => {
  const state = createMatch({
    matchId: "pinned-miracles",
    seed: "pinned-miracles-seed",
    mode: "ONLINE",
    endTimeThreshold: 50,
    players: [
      { playerId: "a", displayName: "Alice" },
      { playerId: "b", displayName: "Bob" }
    ]
  }).state;
  state.players.a!.learnedMiracles = [
    {
      learnedMiracleId: "m1:learned",
      cardDefinitionId: "miracle-sun-amulet",
      learnedAtEventSeq: 1
    } as never,
    {
      learnedMiracleId: "m2:learned",
      cardDefinitionId: "miracle-sun-amulet",
      learnedAtEventSeq: 2
    } as never
  ];
  const view = projectGameView(state, "a");
  const html = renderBattleScreen(view, synchronizeUiState(initialUiState(), view));
  const hand = html.slice(html.indexOf('data-region="hand"'));
  const handList = hand.slice(0, hand.indexOf("</ul>"));
  assert.equal(handList.match(/gf-card--miracle/gu)?.length, 2);
  assert.match(handList, /--gf-miracle-slot: 0/u);
  assert.match(handList, /--gf-miracle-slot: 1/u);
  assert.doesNotMatch(
    html.slice(html.indexOf('data-region="miracles"'), html.indexOf('data-region="hand"')),
    /gf-card--miracle/u
  );
});
