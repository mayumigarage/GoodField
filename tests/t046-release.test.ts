import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BATTLE_SCREEN_STYLES,
  renderBattleScreen
} from "../packages/client/src/battle-screen.ts";
import {
  initialUiState,
  synchronizeUiState
} from "../packages/client/src/ui-machine.ts";
import {
  CARD_POOL_VERSION
} from "../packages/shared/src/cards.ts";
import {
  RULESET_VERSION
} from "../packages/shared/src/model.ts";
import { createMatch } from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";

const NOW = "2026-07-26T08:00:00.000Z";

test("T-046 release scope has no unchecked implementation tasks", async () => {
  const tasks = await readFile("docs/IMPLEMENTATION_TASKS.md", "utf8");
  const releaseScope = tasks.split("## 9. 保留バックログ")[0] ?? tasks;
  assert.doesNotMatch(releaseScope, /^- \[ \]/mu);
  assert.equal(RULESET_VERSION, "GOODFIELD_RULESET_2026_07_25");
  assert.equal(CARD_POOL_VERSION, "OFFICIAL_WEB_2026_07_24");
});

test("T-046 ships release notes, migration, rollback, and ruleset pinning", async () => {
  const releaseNotes = await readFile("docs/RELEASE_NOTES.md", "utf8");
  const operations = await readFile("docs/OPERATIONS.md", "utf8");
  const readiness = await readFile("docs/RELEASE_READINESS.md", "utf8");
  assert.match(releaseNotes, /既知の差異/u);
  assert.match(releaseNotes, /2～9人の個人戦/u);
  assert.match(operations, /マイグレーション/u);
  assert.match(operations, /ロールバック/u);
  assert.match(operations, /rulesetVersion/u);
  assert.match(readiness, /Chrome \/ Edge/u);
  assert.match(readiness, /Firefox/u);
  assert.match(readiness, /Safari/u);
});

test("T-046 renders browser-neutral desktop and mobile smoke fixtures", () => {
  for (const playerCount of [2, 4, 9]) {
    const state = createMatch({
      matchId: `t046-browser-${playerCount}`,
      seed: `t046-browser-seed-${playerCount}`,
      now: NOW,
      players: Array.from({ length: playerCount }, (_, index) => ({
        playerId: `browser-player-${index}`,
        displayName: `Browser Player ${index}`
      }))
    }).state;
    const viewerId = state.activePlayerId;
    assert.ok(viewerId);
    const view = projectGameView(state, viewerId);
    const html = renderBattleScreen(
      view,
      synchronizeUiState(initialUiState(), view)
    );
    assert.match(html, /<main[\s\S]*aria-label="GoodField 対戦画面"/u);
    assert.match(html, /data-region="header"/u);
    assert.match(html, /data-region="players"/u);
    assert.match(html, /data-region="hand"/u);
    assert.equal(
      html.match(/class="gf-player-list__item"/gu)?.length,
      playerCount
    );
  }
  assert.match(BATTLE_SCREEN_STYLES, /@media \(max-width: 64rem\)/u);
  assert.match(BATTLE_SCREEN_STYLES, /@media \(max-width: 44rem\)/u);
  assert.match(BATTLE_SCREEN_STYLES, /overflow-x: auto/u);
  assert.doesNotMatch(BATTLE_SCREEN_STYLES, /-webkit-|@supports not/u);
});
