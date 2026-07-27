import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTLE_SCREEN_STYLES,
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
  synchronizeUiState
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
  assert.match(beforeDeadline, /残り 10秒/u);
  assert.match(beforeDeadline, /時間切れ後はCPUが代行します/u);

  const atDeadline = renderBattleScreen(
    view,
    ui,
    {},
    null,
    Date.parse(deadlineAt)
  );
  assert.match(atDeadline, /data-ui-mode="RESOLVING"/u);
  assert.match(atDeadline, /入力期限が切れました/u);
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
  assert.match(disconnectedHtml, /CPU代行/u);
  assert.match(disconnectedHtml, /切断/u);
  assert.match(disconnectedHtml, /接続が切れたため、CPUが操作を代行しています/u);

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
  assert.match(reconnectedHtml, /再接続済みですが、操作権はCPUのままです/u);
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
  assert.match(initialHtml, /data-utility-form="SURRENDER"/u);
  assert.match(initialHtml, />降参する<\/button>/u);
  ui = selectActionCard(ui, "screen-bronze", view);
  ui = selectActionCard(ui, "screen-blowgun", view);
  const html = renderBattleScreen(view, ui);

  assert.match(html, /data-select-card="screen-bronze"/u);
  assert.match(html, /data-select-card="screen-blowgun"/u);
  assert.equal(html.match(/data-select-target="/gu)?.length, 2);
  assert.match(html, /<dt>合計攻撃<\/dt>\s*<dd>2<\/dd>/u);
  assert.match(html, /<dt>属性<\/dt>\s*<dd>物理<\/dd>/u);
  assert.match(html, /data-submit-action\s*>行動を確定/u);
  assert.doesNotMatch(html, /data-submit-action\s+disabled/u);
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
  ui = selectDefenseCard(ui, "screen-defense", view);
  const html = renderBattleScreen(view, ui);

  assert.match(html, /data-select-defense-card="screen-defense"/u);
  assert.match(html, /<dt>合計防御<\/dt><dd>6<\/dd>/u);
  assert.match(html, /data-submit-reaction/u);
  assert.match(html, /data-submit-forgive/u);
  assert.match(html, />許す<\/button>/u);
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

test("self attacks match the recorded 500/1000ms combat sequence", () => {
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

  const targetPresentation = advancePresentationClock(
    actionPresentation,
    500
  );
  const targetHtml = renderBattleScreen(view, ui, {}, targetPresentation);
  assert.match(targetHtml, /data-presentation-stage="TARGET"/u);
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
  assert.match(reactionHtml, /革の服/u);
  assert.match(reactionHtml, /革の帽子/u);
  assert.match(
    reactionHtml,
    /data-card-lane="action"[\s\S]*鎖ガマ[\s\S]*data-card-lane="defense"[\s\S]*革の服[\s\S]*革の帽子/u
  );
  assert.match(reactionHtml, /<dt>合計防御<\/dt><dd>3<\/dd>/u);
  assert.doesNotMatch(reactionHtml, /data-region="presentation"/u);

  const defenderView = projectGameView(reaction.state, targetId);
  const defenderUi = synchronizeUiState(initialUiState(), defenderView);
  const defenderReactionHtml = renderBattleScreen(
    defenderView,
    defenderUi,
    {},
    reactionPresentation
  );
  assert.match(defenderReactionHtml, /革の服/u);
  assert.match(defenderReactionHtml, /革の帽子/u);
  assert.match(defenderReactionHtml, /data-game-input-disabled="true"/u);

  const damagePresentation = advancePresentationClock(
    reactionPresentation,
    1_500
  );
  const damageHtml = renderBattleScreen(view, ui, {}, damagePresentation);
  assert.match(damageHtml, /data-result="damage"/u);
  assert.match(damageHtml, /<strong>2<\/strong><span>ダメージ<\/span>/u);
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
      hit: null
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
    2_500
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
  assert.match(healingHtml, /<strong>\+5<\/strong><span>hp<\/span>/u);
  assert.match(healingHtml, /data-game-input-disabled="true"/u);

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
  assert.match(forgiveHtml, /class="gf-action__forgive"[^>]*>許す</u);

  const damagePresentation = advancePresentationClock(
    forgivePresentation,
    1_000
  );
  const damageHtml = renderBattleScreen(view, ui, {}, damagePresentation);
  assert.match(damageHtml, /<strong>5<\/strong><span>ダメージ<\/span>/u);

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
  assert.match(recoveryHtml, /<strong>\+10<\/strong><span>hp<\/span>/u);
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
