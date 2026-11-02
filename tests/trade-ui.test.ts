import assert from "node:assert/strict";
import test from "node:test";

import type { DomainEvent, MatchState } from "../packages/shared/src/model.ts";
import { createMatch, handleCommand } from "../packages/server/src/engine.ts";
import {
  projectDomainEvent,
  projectGameView
} from "../packages/server/src/projection.ts";
import { renderBattleScreen } from "../packages/client/src/battle-screen.ts";
import {
  createPresentationQueue,
  enqueuePresentationEvents,
  presentationStepsForEvent,
  tradePresentationStage
} from "../packages/client/src/presentation-queue.ts";
import {
  immediateSoundEvents,
  soundEffectForEvent
} from "../packages/client/src/sound-effects.ts";
import {
  canSubmitTrade,
  initialUiState,
  prepareTradeSubmission,
  synchronizeUiState,
  toggleTradeDraft,
  toggleTradeProduct
} from "../packages/client/src/ui-machine.ts";

function tradeState(): MatchState {
  const { state } = createMatch({
    matchId: "trade-ui",
    seed: "trade-ui-seed",
    players: [
      { playerId: "seller", displayName: "Seller" },
      { playerId: "buyer", displayName: "Buyer" }
    ]
  });
  const card = (instanceId: string, cardDefinitionId: string) => ({
    instanceId,
    cardDefinitionId,
    dreamDisguiseCardDefinitionId: null
  });
  return {
    ...state,
    activePlayerId: "seller",
    turnCursor: state.turnOrder.indexOf("seller"),
    phase: "ACTION_SELECTION",
    players: {
      ...state.players,
      seller: {
        ...state.players.seller!,
        money: 0,
        hand: [
          card("sell-card", "sell"),
          card("buy-card", "buy"),
          card("product", "sword-shield")
        ]
      },
      buyer: {
        ...state.players.buyer!,
        money: 30,
        hand: [card("buyer-buy", "buy"), card("buyer-goods", "sword-shield")]
      }
    }
  };
}

function sellTradeEvents(): { state: MatchState; events: DomainEvent[] } {
  const state = tradeState();
  const view = projectGameView(state, "seller");
  const ui = toggleTradeProduct(
    toggleTradeDraft(
      synchronizeUiState(initialUiState(), view),
      "SELL_CARD",
      "sell-card",
      view
    ),
    "product",
    view
  );
  const prepared = prepareTradeSubmission(ui, view, () => "sell-command");
  assert.ok(prepared);
  const sold = handleCommand(state, prepared.command);
  assert.ok(sold.ok && sold.state.pendingAction?.kind === "ATTACK");
  const allowed = handleCommand(sold.state, {
    type: "DECLARE_REACTION",
    matchId: sold.state.matchId,
    commandId: "buyer-allows",
    actorId: "buyer",
    expectedRevision: sold.state.revision,
    reactionId: sold.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.ok(allowed.ok);
  return {
    state: allowed.state,
    events: [...sold.events, ...allowed.events]
  };
}

test("selling is composed on the battlefield and shows hand prices", () => {
  const view = projectGameView(tradeState(), "seller");
  const idle = synchronizeUiState(initialUiState(), view);
  assert.doesNotMatch(
    renderBattleScreen(view, idle),
    /data-utility-form="(?:SELL_CARD|DECLARE_BUY)"/u
  );

  const draft = toggleTradeDraft(idle, "SELL_CARD", "sell-card", view);
  assert.deepEqual(draft.selectedTargetIds, ["buyer"]);
  assert.equal(canSubmitTrade(draft, view), false);
  const draftHtml = renderBattleScreen(view, draft);
  assert.match(draftHtml, /data-trade-price>¥15</u);
  assert.match(draftHtml, /data-select-trade-product="product"/u);
  assert.doesNotMatch(draftHtml, /data-select-trade-product="sell-card"/u);
  assert.match(draftHtml, /data-submit-trade\s+disabled/u);

  const ready = toggleTradeProduct(draft, "product", view);
  assert.equal(canSubmitTrade(ready, view), true);
  assert.equal(
    toggleTradeProduct(ready, "product", view).tradeDraft
      ?.productCardInstanceId,
    null
  );
  assert.equal(
    toggleTradeDraft(ready, "SELL_CARD", "sell-card", view).tradeDraft,
    null
  );

  const prepared = prepareTradeSubmission(ready, view, () => "sell-command");
  assert.deepEqual(prepared?.command, {
    matchId: view.matchId,
    commandId: "sell-command",
    actorId: "seller",
    expectedRevision: view.revision,
    cardInstanceId: "sell-card",
    targetPlayerId: "buyer",
    type: "SELL_CARD",
    productCardInstanceId: "product"
  });
});

test("the sold artifact is public to every viewer while the buyer answers", () => {
  const state = tradeState();
  const sold = handleCommand(state, {
    type: "SELL_CARD",
    matchId: state.matchId,
    commandId: "public-sale",
    actorId: "seller",
    expectedRevision: state.revision,
    cardInstanceId: "sell-card",
    productCardInstanceId: "product",
    targetPlayerId: "buyer"
  });
  assert.ok(sold.ok);
  const declared = sold.events.find(({ type }) => type === "ACTION_DECLARED");
  assert.ok(declared?.type === "ACTION_DECLARED");
  assert.equal(declared.visibility.scope, "PUBLIC");
  assert.equal(declared.saleProductCardDefinitionId, "sword-shield");

  for (const viewerId of ["seller", "buyer", null]) {
    const view = projectGameView(sold.state, viewerId);
    assert.deepEqual(view.pendingAttack?.saleProduct, {
      cardInstanceId: "product",
      cardDefinitionId: "sword-shield"
    });
    const html = renderBattleScreen(
      view,
      synchronizeUiState(initialUiState(), view)
    );
    assert.match(html, /gf-field-card__name">ソードシールド</u);
  }
  const buyerView = projectGameView(sold.state, "buyer");
  assert.equal(
    buyerView.self?.hand.some(({ instanceId }) => instanceId === "product"),
    false
  );
});

test("a sale reveals its product in two timed stages", () => {
  const declared = {
    type: "ACTION_DECLARED",
    actionType: "SELL_CARD",
    eventSeq: 1
  } as unknown as DomainEvent;
  assert.deepEqual(
    presentationStepsForEvent(declared).map(({ kind, durationMs }) => [
      kind,
      durationMs
    ]),
    [
      ["ACTION", 400],
      ["ACTION", 600]
    ]
  );
});

test("buying needs no product and targets the only enemy", () => {
  const view = projectGameView(tradeState(), "seller");
  const draft = toggleTradeDraft(
    synchronizeUiState(initialUiState(), view),
    "DECLARE_BUY",
    "buy-card",
    view
  );
  assert.equal(canSubmitTrade(draft, view), true);
  assert.equal(
    prepareTradeSubmission(draft, view, () => "buy-command")?.command.type,
    "DECLARE_BUY"
  );
});

test("a sale plays the crossing swap and one payment sound", () => {
  const { state, events } = sellTradeEvents();
  const payment = events.find(
    ({ type }) => type === "TRADE_PAYMENT_COLLECTED"
  );
  assert.ok(payment);
  const steps = presentationStepsForEvent(payment, undefined, events);
  assert.deepEqual(steps.map(tradePresentationStage), [
    "PRICE",
    "SWAP",
    "SETTLE"
  ]);

  const transfer = events.find(({ type }) => type === "CARD_TRANSFERRED");
  assert.ok(transfer);
  assert.deepEqual(presentationStepsForEvent(transfer), []);
  assert.equal(soundEffectForEvent(transfer, "seller"), null);
  assert.equal(soundEffectForEvent(payment, "seller"), "yenAbsorb");

  const projected = events.flatMap(
    (event) => projectDomainEvent(event, "seller") ?? []
  );
  const replacement = projected.find(({ type }) => type === "CARD_GRANTED");
  assert.ok(replacement);
  assert.ok(!immediateSoundEvents(projected).includes(replacement));

  const view = projectGameView(state, "seller");
  let queue = enqueuePresentationEvents(
    createPresentationQueue(),
    projected,
    view,
    0
  );
  while (queue.activeStep?.step.event.type !== "TRADE_PAYMENT_COLLECTED") {
    assert.ok(queue.activeStep);
    queue = enqueuePresentationEvents(
      queue,
      [],
      view,
      queue.activeStep.endsAtMs
    );
  }
  const priceHtml = renderBattleScreen(
    view,
    synchronizeUiState(initialUiState(), view),
    {},
    queue,
    queue.activeStep.startedAtMs
  );
  assert.match(priceHtml, /data-trade-stage="PRICE"/u);
  assert.match(priceHtml, /gf-trade-swap__coin">¥15</u);
  queue = enqueuePresentationEvents(queue, [], view, queue.activeStep.endsAtMs);
  assert.ok(queue.activeStep);
  const html = renderBattleScreen(
    view,
    synchronizeUiState(initialUiState(), view),
    {},
    queue,
    queue.activeStep.startedAtMs
  );
  assert.match(html, /data-trade-kind="SELL"/u);
  assert.match(html, /data-trade-stage="SWAP"/u);
  assert.match(html, /gf-trade-swap__coin">¥15</u);
  assert.match(html, /<dd>¥0<\/dd>/u);
  assert.match(html, /<dd>¥30<\/dd>/u);
});

test("a purchase stamps the decision before the swap", () => {
  const payment = {
    type: "TRADE_PAYMENT_COLLECTED",
    eventSeq: 5
  } as unknown as DomainEvent;
  const declared = {
    type: "ACTION_DECLARED",
    actionType: "DECLARE_BUY",
    eventSeq: 1
  } as unknown as DomainEvent;
  assert.deepEqual(
    presentationStepsForEvent(payment, undefined, [declared]).map(
      tradePresentationStage
    ),
    ["OFFER", "CLEAR", "STAMP", "SWAP", "SETTLE"]
  );
});

function buyOfferEvents(
  sellerHand: MatchState["players"][string]["hand"],
  actorHp = 40
): { state: MatchState; events: DomainEvent[] } {
  const base = tradeState();
  const state: MatchState = {
    ...base,
    players: {
      ...base.players,
      seller: { ...base.players.seller!, mp: 0, hp: actorHp },
      buyer: { ...base.players.buyer!, hand: sellerHand }
    }
  };
  const declared = handleCommand(state, {
    type: "DECLARE_BUY",
    matchId: state.matchId,
    commandId: "buy-command",
    actorId: "seller",
    expectedRevision: state.revision,
    cardInstanceId: "buy-card",
    targetPlayerId: "buyer"
  });
  assert.ok(declared.ok && declared.state.pendingAction?.kind === "ATTACK");
  const allowed = handleCommand(declared.state, {
    type: "DECLARE_REACTION",
    matchId: declared.state.matchId,
    commandId: "offer-allowed",
    actorId: "buyer",
    expectedRevision: declared.state.revision,
    reactionId: declared.state.pendingAction.attack.reactionId,
    defenseCardInstanceIds: []
  });
  assert.ok(allowed.ok);
  return {
    state: allowed.state,
    events: [...declared.events, ...allowed.events]
  };
}

test("a buy offer and its refusal are shown to every viewer", () => {
  const { state, events } = buyOfferEvents([
    {
      instanceId: "offered",
      cardDefinitionId: "sword-shield",
      dreamDisguiseCardDefinitionId: "leather-cap"
    }
  ]);
  const offer = events.find(({ type }) => type === "TRADE_OFFERED");
  assert.ok(offer?.type === "TRADE_OFFERED");
  assert.equal(offer.visibility.scope, "PUBLIC");
  assert.equal(offer.offeredCardDefinitionId, "sword-shield");
  assert.equal(offer.dreamRevealed, true);
  assert.equal(
    state.players.buyer?.hand[0]?.dreamDisguiseCardDefinitionId,
    null
  );

  for (const viewerId of ["seller", "buyer", null]) {
    const view = projectGameView(state, viewerId);
    assert.deepEqual(view.pendingTrade, {
      tradeId: "buy-command",
      actorId: "seller",
      targetPlayerId: "buyer",
      offeredCardDefinitionId: "sword-shield",
      price: 15
    });
    const html = renderBattleScreen(
      view,
      synchronizeUiState(initialUiState(), view)
    );
    assert.match(html, /gf-trade-swap__product[^>]*>[\s\S]*?ソードシールド/u);
  }

  const buyerView = projectGameView(state, "seller");
  const confirmHtml = renderBattleScreen(
    buyerView,
    synchronizeUiState(initialUiState(), buyerView)
  );
  assert.match(confirmHtml, /data-confirm-buy/u);
  assert.doesNotMatch(confirmHtml, /gf-trade-offer__effect|支払い順/u);

  const declined = handleCommand(state, {
    type: "CONFIRM_BUY",
    matchId: state.matchId,
    commandId: "decline",
    actorId: "seller",
    expectedRevision: state.revision,
    tradeId: "buy-command",
    accept: false
  });
  assert.ok(declined.ok);
  const resolution = declined.events.find(
    ({ type }) => type === "TRADE_RESOLVED"
  );
  assert.ok(resolution);
  const spectator = projectGameView(declined.state, null);
  assert.equal(spectator.pendingTrade, null);
  const projected = [...events, ...declined.events].flatMap(
    (event) => projectDomainEvent(event, null) ?? []
  );
  let queue = enqueuePresentationEvents(
    createPresentationQueue(),
    projected,
    spectator,
    0
  );
  while (
    queue.activeStep &&
    queue.activeStep.step.event.eventSeq !== resolution.eventSeq
  ) {
    queue = enqueuePresentationEvents(
      queue,
      [],
      spectator,
      queue.activeStep.endsAtMs
    );
  }
  assert.ok(queue.activeStep);
  const html = renderBattleScreen(
    spectator,
    synchronizeUiState(initialUiState(), spectator),
    {},
    queue,
    queue.activeStep.startedAtMs
  );
  assert.match(html, /data-result="trade-notice"[\s\S]*?<strong>買わない<\/strong>/u);
});

test("an unaffordable buy offer closes with 貧乏 for everyone", () => {
  const base = buyOfferEvents([
    {
      instanceId: "offered",
      cardDefinitionId: "sword-shield",
      dreamDisguiseCardDefinitionId: null
    }
  ], 5);
  const resolved = base.events.find(({ type }) => type === "TRADE_RESOLVED");
  assert.ok(resolved?.type === "TRADE_RESOLVED");
  assert.equal(resolved.visibility.scope, "PUBLIC");
  assert.equal(resolved.resolution, "INSUFFICIENT_RESOURCES");
  const view = projectGameView(base.state, "buyer");
  let queue = enqueuePresentationEvents(
    createPresentationQueue(),
    base.events.flatMap((event) => projectDomainEvent(event, "buyer") ?? []),
    view,
    0
  );
  while (
    queue.activeStep &&
    queue.activeStep.step.event.type !== "TRADE_RESOLVED"
  ) {
    queue = enqueuePresentationEvents(
      queue,
      [],
      view,
      queue.activeStep.endsAtMs
    );
  }
  assert.ok(queue.activeStep);
  const html = renderBattleScreen(
    view,
    synchronizeUiState(initialUiState(), view),
    {},
    queue,
    queue.activeStep.startedAtMs
  );
  assert.match(html, /<strong>貧乏<\/strong>/u);
  assert.match(html, /ソードシールド/u);
});

test("guardian theft moves a coin and a money phenomenon collects at once", () => {
  const guardianTheft = {
    type: "RESOURCE_CHANGED",
    playerId: "buyer",
    resource: "MONEY",
    delta: -5,
    valueAfter: 25,
    reason: "GUARDIAN",
    eventSeq: 3
  } as unknown as DomainEvent;
  assert.deepEqual(
    presentationStepsForEvent(guardianTheft).map((step) => [
      step.kind,
      tradePresentationStage(step)
    ]),
    [
      ["TRADE", "PRICE"],
      ["TRADE", "SWAP"],
      ["TRADE", "SETTLE"]
    ]
  );

  const collected = [10, 11, 12].map(
    (eventSeq) =>
      ({
        type: "RESOURCE_CHANGED",
        playerId: `p${eventSeq}`,
        resource: "MONEY",
        delta: eventSeq === 12 ? 40 : -20,
        valueAfter: eventSeq === 12 ? 60 : 0,
        reason: "PHENOMENON",
        eventSeq
      }) as unknown as DomainEvent
  );
  assert.deepEqual(
    collected.map(
      (event) =>
        presentationStepsForEvent(event, undefined, collected)[0]?.durationMs
    ),
    [500, 0, 0]
  );
});
