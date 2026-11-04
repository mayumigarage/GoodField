import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { renderBattleScreen } from "../packages/client/src/battle-screen.ts";
import {
  advancePresentationClock,
  CONFUSION_NOTICE_HOLD_MS,
  createPresentationQueue,
  enqueuePresentationEvents,
  OFFICIAL_WEB_2026_07_26,
  presentationStepsForEvent
} from "../packages/client/src/presentation-queue.ts";
import {
  SOUND_EFFECT_FILES,
  soundEffectForEvent,
  soundEffectForPresentationStep
} from "../packages/client/src/sound-effects.ts";
import {
  initialUiState,
  synchronizeUiState
} from "../packages/client/src/ui-machine.ts";
import { createMatch } from "../packages/server/src/engine.ts";
import { projectGameView } from "../packages/server/src/projection.ts";
import type { DomainEvent } from "../packages/shared/src/model.ts";

const base = {
  revision: 1,
  occurredAt: "2026-11-05T00:00:00.000Z",
  visibility: { scope: "PUBLIC" as const }
};

function attackCreated(
  eventSeq: number,
  overrides: {
    actorId?: string;
    targetPlayerId?: string;
    sourceCardDefinitionIds?: string[];
    element?: "PHYSICAL" | "DARK" | "LIGHT";
    power?: number;
  } = {}
): DomainEvent {
  const actorId = overrides.actorId ?? "p1";
  const targetPlayerId = overrides.targetPlayerId ?? "p2";
  return {
    ...base,
    eventSeq,
    type: "ATTACK_CREATED",
    attack: {
      attackId: `attack-${eventSeq}`,
      reactionId: `attack-${eventSeq}:reaction:0`,
      reactionDepth: 0,
      seriesId: `series-${eventSeq}`,
      attackNumber: 1,
      totalAttacks: 1,
      targetIndex: 0,
      totalTargets: 1,
      attackKind: "WEAPON",
      actorId,
      targetPlayerId,
      sourceCardInstanceIds: ["source-card"],
      sourceLearnedMiracleIds: [],
      sourceCardDefinitionIds: overrides.sourceCardDefinitionIds ?? [
        "severe-gale-sword"
      ],
      element: overrides.element ?? "PHYSICAL",
      power: overrides.power ?? 5,
      hit: true
    },
    actionOwnerId: actorId,
    targetPlayerIds: [targetPlayerId],
    hitRate: 100,
    attackerGrantCount: 1,
    completion: "FINISH_TURN"
  } as DomainEvent;
}

function damageApplied(
  eventSeq: number,
  attackSeq: number,
  amount: number,
  playerId = "p2"
): DomainEvent {
  return {
    ...base,
    eventSeq,
    type: "DAMAGE_APPLIED",
    attackId: `attack-${attackSeq}`,
    playerId,
    amount,
    hpAfter: Math.max(0, 40 - amount)
  };
}

function dreamHatReaction(eventSeq: number, playerId = "p2"): DomainEvent {
  return {
    ...base,
    eventSeq,
    type: "REACTION_DECLARED",
    reactionId: "attack-1:reaction:0",
    playerId,
    defenseCardInstanceIds: ["hat"],
    defenseLearnedMiracleIds: [],
    defenseCardDefinitionIds: ["dreaming-hat"],
    defensePower: 14
  };
}

test("each action found in the effect recording plays its own sound", () => {
  const bounce: DomainEvent = {
    ...base,
    eventSeq: 2,
    type: "ATTACK_REDIRECTED",
    attackId: "attack-1",
    reactionId: "attack-1:reaction:1",
    actorId: "p2",
    targetPlayerId: "p1",
    reactionDepth: 1,
    redirectType: "BOUNCE"
  };
  assert.equal(soundEffectForEvent(bounce, "p1"), "flick");

  assert.equal(
    soundEffectForEvent(
      {
        ...base,
        eventSeq: 3,
        type: "ASCENSION_BOW_TRIGGERED",
        playerId: "p2",
        targetPlayerId: "p1",
        cardInstanceId: "bow",
        hit: true
      },
      "p1"
    ),
    "dyingAttack"
  );
  assert.equal(
    soundEffectForEvent(
      {
        ...base,
        eventSeq: 4,
        type: "CALAMITY_WORSENED",
        playerId: "p2",
        from: "HEAVEN_SICKNESS",
        to: null
      },
      "p1"
    ),
    "seizure"
  );
  assert.equal(
    soundEffectForEvent(
      {
        ...base,
        eventSeq: 5,
        type: "CALAMITY_WORSENED",
        playerId: "p2",
        from: "COLD",
        to: "FEVER"
      },
      "p1"
    ),
    "disease"
  );
  assert.equal(
    soundEffectForEvent(
      {
        ...base,
        eventSeq: 6,
        type: "CONFUSION_ACTIONS_STARTED",
        sourcePlayerId: "p1",
        sourceGrantCount: 1,
        actionSlots: []
      },
      "p1"
    ),
    "illusionItem"
  );
});

test("damage sounds follow the attack that dealt them", () => {
  const dark = attackCreated(1, { element: "DARK", power: 2 });
  assert.equal(
    soundEffectForEvent(damageApplied(2, 1, 29), "p1", [dark]),
    "damageDark"
  );
  assert.equal(
    soundEffectForEvent(damageApplied(2, 1, 0), "p1", [dark]),
    "noChange"
  );

  const pestle = attackCreated(1, {
    sourceCardDefinitionIds: ["dangerous-pestle"],
    element: "LIGHT",
    power: 30
  });
  assert.equal(
    soundEffectForEvent(damageApplied(2, 1, 99), "p1", [pestle]),
    "mortar"
  );
  assert.equal(
    soundEffectForEvent(damageApplied(2, 1, 30), "p1", [pestle]),
    "damage"
  );
  // Without the attack in view the plain damage sound still plays.
  assert.equal(soundEffectForEvent(damageApplied(2, 1, 99), "p1"), "damage");
});

test("a defense card's own penalty sounds apart from an attack's calamity", () => {
  const dreamFromHat: DomainEvent = {
    ...base,
    eventSeq: 4,
    type: "CALAMITY_APPLIED",
    playerId: "p2",
    calamity: "DREAM"
  };
  const history = [attackCreated(1), dreamHatReaction(2), damageApplied(3, 1, 0)];
  assert.equal(soundEffectForEvent(dreamFromHat, "p1", history), "defenseHarm");
  assert.equal(
    soundEffectForEvent(dreamFromHat, "p1", [attackCreated(1), damageApplied(3, 1, 5)]),
    "harmAdd"
  );
  // A new action ends the defense's reach.
  assert.equal(
    soundEffectForEvent(dreamFromHat, "p1", [
      dreamHatReaction(1),
      attackCreated(2)
    ]),
    "harmAdd"
  );

  const redraw: DomainEvent = {
    ...base,
    eventSeq: 5,
    type: "HAND_REDRAWN",
    playerId: "p2",
    cardCount: 6
  };
  assert.equal(soundEffectForEvent(redraw, "p1"), "defenseHarm");
  assert.equal(
    soundEffectForPresentationStep({ event: redraw, stageIndex: 0 }, "p1"),
    "defenseHarm"
  );
  assert.equal(
    soundEffectForPresentationStep({ event: redraw, stageIndex: 1 }, "p1"),
    null
  );
});

test("counter damage and the ascension bow's arrow sound differently", () => {
  const counterLoss = (eventSeq: number): DomainEvent => ({
    ...base,
    eventSeq,
    type: "RESOURCE_CHANGED",
    playerId: "p1",
    resource: "HP",
    delta: -10,
    valueAfter: 20,
    reason: "COUNTER"
  });
  const bow: DomainEvent = {
    ...base,
    eventSeq: 4,
    type: "ASCENSION_BOW_TRIGGERED",
    playerId: "p2",
    targetPlayerId: "p1",
    cardInstanceId: "bow",
    hit: true
  };
  assert.equal(
    soundEffectForEvent(counterLoss(3), "p1", [damageApplied(2, 1, 10)]),
    "counter"
  );
  assert.equal(soundEffectForEvent(counterLoss(5), "p1", [bow]), "damage");
  assert.equal(
    soundEffectForPresentationStep({ event: bow, stageIndex: 0 }, "p1"),
    "dyingAttack"
  );
  assert.equal(
    soundEffectForPresentationStep({ event: bow, stageIndex: 1 }, "p1"),
    "hit"
  );
  assert.equal(
    soundEffectForPresentationStep(
      { event: { ...bow, hit: false }, stageIndex: 1 },
      "p1"
    ),
    "miss"
  );
});

test("every shipped sound file is mapped except the unverified countdown", () => {
  const shipped = readdirSync(
    new URL("../packages/client/public/sounds/", import.meta.url)
  ).filter((name) => name.endsWith(".mp3"));
  const mapped = new Set<string>(Object.values(SOUND_EFFECT_FILES));
  for (const file of mapped) {
    assert.ok(shipped.includes(file), `${file} is missing`);
  }
  assert.deepEqual(
    shipped.filter((name) => !mapped.has(name)),
    ["game_start_number.mp3"]
  );
});

test("the ascension bow and 御乱心 get presentation stages of their own", () => {
  const bowSteps = presentationStepsForEvent({
    ...base,
    eventSeq: 9,
    type: "ASCENSION_BOW_TRIGGERED",
    playerId: "p2",
    targetPlayerId: "p1",
    cardInstanceId: "bow",
    hit: false
  });
  assert.deepEqual(
    bowSteps.map(({ kind, durationMs }) => [kind, durationMs]),
    [
      ["ASCENSION", OFFICIAL_WEB_2026_07_26.attackStageMs],
      ["ASCENSION", OFFICIAL_WEB_2026_07_26.hitResultMs]
    ]
  );
  const confusion = presentationStepsForEvent({
    ...base,
    eventSeq: 10,
    type: "CONFUSION_ACTIONS_STARTED",
    sourcePlayerId: "p1",
    sourceGrantCount: 1,
    actionSlots: []
  });
  assert.equal(confusion[0]?.durationMs, CONFUSION_NOTICE_HOLD_MS);
});

function battleFixture() {
  const state = createMatch({
    matchId: "action-sounds",
    seed: "action-sounds-seed",
    players: [
      { playerId: "attacker", displayName: "Attacker" },
      { playerId: "defender", displayName: "Defender" }
    ]
  }).state;
  const actorId = state.activePlayerId;
  assert.ok(actorId);
  const targetId = state.turnOrder.find((playerId) => playerId !== actorId);
  assert.ok(targetId);
  const view = projectGameView(state, actorId);
  const ui = synchronizeUiState(initialUiState(), view);
  const render = (events: DomainEvent[], atMs: number): string => {
    let presentation = enqueuePresentationEvents(
      createPresentationQueue(),
      events,
      view,
      0
    );
    // The clock moves one stage per tick, as the screen's timer does.
    for (let nowMs = 0; nowMs <= atMs; nowMs += 50) {
      presentation = advancePresentationClock(presentation, nowMs);
    }
    return renderBattleScreen(view, ui, {}, presentation, atMs);
  };
  return { actorId, targetId, render };
}

test("dark damage shows a violet damage card on a darkened field", () => {
  const { actorId, targetId, render } = battleFixture();
  const html = render(
    [
      attackCreated(1, {
        actorId,
        targetPlayerId: targetId,
        element: "DARK",
        power: 2
      }),
      damageApplied(2, 1, 29, targetId)
    ],
    600
  );
  assert.match(
    html,
    /data-result="damage"\s+data-element="DARK"/u
  );
  assert.match(html, /<strong>29<\/strong><span>ダメージ<\/span>/u);
});

test("the pestle finding a mortar holder draws the mortar beside it", () => {
  const { actorId, targetId, render } = battleFixture();
  const events = [
    attackCreated(1, {
      actorId,
      targetPlayerId: targetId,
      sourceCardDefinitionIds: ["dangerous-pestle"],
      element: "LIGHT",
      power: 30
    }),
    damageApplied(2, 1, 99, targetId)
  ];
  const html = render(events, 600);
  assert.match(
    html,
    /class="gf-field-card gf-field-card--defense gf-field-card--mortar"\s+data-card-definition-id="dangerous-mortar"/u
  );
  assert.doesNotMatch(html, /<strong class="gf-action__forgive/u);

  // An ordinary pestle hit leaves the defense lane alone.
  const plain = render([events[0]!, damageApplied(2, 1, 30, targetId)], 600);
  assert.doesNotMatch(plain, /data-card-definition-id="dangerous-mortar"/u);
});

test("the ascension bow shows the dying player's last shot and its roll", () => {
  const { actorId, targetId, render } = battleFixture();
  const bow: DomainEvent = {
    ...base,
    eventSeq: 1,
    type: "ASCENSION_BOW_TRIGGERED",
    playerId: targetId,
    targetPlayerId: actorId,
    cardInstanceId: "bow",
    hit: true
  };
  const cardHtml = render([bow], 100);
  assert.match(cardHtml, /data-presentation-scene="ascension-bow"/u);
  assert.match(
    cardHtml,
    /data-card-lane="action"[\s\S]*?data-card-definition-id="ascension-bow"/u
  );
  assert.match(cardHtml, /<dt>合計攻撃<\/dt>\s*<dd>30<\/dd>/u);
  assert.doesNotMatch(cardHtml, /class="gf-action__result"\s+data-result="hit"/u);

  const rollHtml = render([bow], OFFICIAL_WEB_2026_07_26.attackStageMs + 100);
  assert.match(
    rollHtml,
    /class="gf-action__result"\s+data-result="hit"[^>]*>\s*<strong>命中<\/strong>/u
  );
});

test("御乱心 is announced over the field while it starts", () => {
  const { actorId, render } = battleFixture();
  const html = render(
    [
      {
        ...base,
        eventSeq: 1,
        type: "CONFUSION_ACTIONS_STARTED",
        sourcePlayerId: actorId,
        sourceGrantCount: 1,
        actionSlots: []
      }
    ],
    100
  );
  assert.match(html, /data-effect="confusion"[^>]*>\s*<strong>御乱心<\/strong>/u);
});

test("the defense card that dreams its wearer flashes with the penalty", () => {
  const { actorId, targetId, render } = battleFixture();
  const html = render(
    [
      attackCreated(1, { actorId, targetPlayerId: targetId }),
      dreamHatReaction(2, targetId),
      damageApplied(3, 1, 0, targetId),
      {
        ...base,
        eventSeq: 4,
        type: "CALAMITY_APPLIED",
        playerId: targetId,
        calamity: "DREAM"
      }
    ],
    // Attack stage, the hat's reveal and the 無事 result come first.
    OFFICIAL_WEB_2026_07_26.attackStageMs * 2 +
      OFFICIAL_WEB_2026_07_26.attackResultMs +
      100
  );
  assert.match(html, /data-calamity="DREAM"/u);
  assert.match(
    html,
    /gf-field-card--defense gf-field-card--effect-source"\s+data-card-definition-id="dreaming-hat"/u
  );
});

test("a flicked attack says 弾いた, matching the spec's 弾く", () => {
  const { actorId, targetId, render } = battleFixture();
  const html = render(
    [
      attackCreated(1, { actorId, targetPlayerId: targetId }),
      {
        ...base,
        eventSeq: 2,
        type: "REACTION_DECLARED",
        reactionId: "attack-1:reaction:0",
        playerId: targetId,
        defenseCardInstanceIds: ["sword"],
        defenseLearnedMiracleIds: [],
        defenseCardDefinitionIds: ["bouncing-sword"]
      },
      {
        ...base,
        eventSeq: 3,
        type: "ATTACK_REDIRECTED",
        attackId: "attack-1",
        reactionId: "attack-1:reaction:1",
        actorId: targetId,
        targetPlayerId: actorId,
        reactionDepth: 1,
        redirectType: "BOUNCE"
      }
    ],
    OFFICIAL_WEB_2026_07_26.attackStageMs * 2 + 100
  );
  assert.match(
    html,
    /data-result="deflect"[^>]*>\s*<strong>弾いた<\/strong>/u
  );
});
