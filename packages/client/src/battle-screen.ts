import type {
  Calamity,
  CardCategory,
  CardTextCatalog
} from "../../shared/src/card-types.ts";
import {
  CARD_DEFINITIONS_BY_ID,
  JA_CARD_TEXT
} from "../../shared/src/cards.ts";
import type {
  CardInstanceView,
  GameViewState,
  LearnedMiracleView,
  PlayerPublicView,
  RealtimeMatchMessage
} from "../../shared/src/protocol.ts";
import type { DomainEvent, GameCommand } from "../../shared/src/model.ts";
import {
  advancePresentationClock,
  applyRealtimePresentationMessage,
  createPresentationQueue
} from "./presentation-queue.ts";
import type {
  PresentationQueueState,
  PresentationStageKind
} from "./presentation-queue.ts";
import {
  actionCardStatus,
  actionPreview,
  advanceUiClock,
  defenseCardStatus,
  defenseMiracleStatus,
  inputDeadlineRemainingSeconds,
  isHumanInputMode,
  learnedMiracleStatus,
  lockForCommand,
  prepareBuyConfirmation,
  prepareDeclareActionSubmission,
  preparePraySubmission,
  prepareReactionSubmission,
  reactionPreview,
  releaseCommandLock,
  selectActionCard,
  selectDefenseCard,
  selectDefenseMiracle,
  selectLearnedMiracle,
  selectTarget,
  synchronizeUiState,
  tradePaymentPreview
} from "./ui-machine.ts";
import type { UiInteractionState, UiMode } from "./ui-machine.ts";
import { CARD_IMAGE_IDS } from "./card-images.generated.ts";

export type BattleScreenLinks = {
  backHref?: string;
  rulebookHref?: string;
  exitHref?: string;
};

const CALAMITY_LABELS: Readonly<Record<Calamity, string>> = {
  COLD: "風邪",
  FEVER: "熱病",
  HELL_SICKNESS: "地獄病",
  HEAVEN_SICKNESS: "天国病",
  FOG: "霧",
  FLASH: "閃光",
  DREAM: "夢",
  DARK_CLOUD: "暗雲"
};

const UI_MODE_LABELS: Readonly<Record<UiMode, string>> = {
  MATCH_SETUP: "対戦準備中",
  MATCH_INTRO: "対戦開始",
  WAITING: "相手の行動を待っています",
  COMPOSING_ACTION: "行動を選んでください",
  CHOOSING_TARGET: "対象を選んでください",
  COMPOSING_REACTION: "防御を選んでください",
  CONFIRMING_TRADE: "購入を確認してください",
  RESOLVING: "行動を解決しています",
  SPECTATING: "観戦中",
  MATCH_RESULT: "対戦終了"
};

const ELEMENT_LABELS = {
  PHYSICAL: "物理",
  FIRE: "火",
  WATER: "水",
  WOOD: "木",
  EARTH: "土",
  LIGHT: "光",
  DARK: "闇"
} as const;

const CARD_CATEGORY_MARKS: Readonly<Record<CardCategory, string>> = {
  TRADE: "▦",
  WEAPON: "⚔",
  ARMOR: "◈",
  GOODS: "✦",
  MIRACLE: "✧",
  DEMON: "♠",
  GUARDIAN_ACTION: "♜",
  PHENOMENON: "◎"
};

const cardTexts: CardTextCatalog = JA_CARD_TEXT;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://")
  ) {
    return escapeHtml(trimmed);
  }
  return fallback;
}

function playerById(
  view: GameViewState,
  playerId: string | null
): PlayerPublicView | null {
  return (
    view.players.find((player) => player.playerId === playerId) ?? null
  );
}

function cardText(cardDefinitionId: string): {
  name: string;
  effect: string;
} {
  const definition = CARD_DEFINITIONS_BY_ID.get(cardDefinitionId);
  const textKey =
    definition?.nameTextKey.replace(/\.name$/u, "") ??
    `card.${cardDefinitionId}`;
  return (
    cardTexts[textKey] ?? {
      name: cardDefinitionId,
      effect: ""
    }
  );
}

function renderCardArt(
  cardDefinitionId: string,
  fallback: string,
  imageClass: string
): string {
  if (!CARD_IMAGE_IDS.has(cardDefinitionId)) return escapeHtml(fallback);
  return `<img
    class="${imageClass}"
    src="/images/cards/${encodeURIComponent(cardDefinitionId)}.png"
    alt=""
  >`;
}

function renderStatusPills(player: PlayerPublicView): string {
  const statuses: string[] = [];
  if (!player.alive) statuses.push("昇天");
  if (player.controller === "CPU") statuses.push("CPU代行");
  if (player.connectionState === "DISCONNECTED") statuses.push("切断");
  if (player.guardian) statuses.push(player.guardian.guardianName);
  statuses.push(
    ...Object.keys(player.calamities)
      .filter(
        (calamity): calamity is Calamity =>
          player.calamities[calamity as Calamity] === true
      )
      .map((calamity) => CALAMITY_LABELS[calamity])
  );
  if (statuses.length === 0) {
    return '<span class="gf-status-pill gf-status-pill--neutral">平常</span>';
  }
  return statuses
    .map(
      (status) =>
        `<span class="gf-status-pill">${escapeHtml(status)}</span>`
    )
    .join("");
}

function renderPlayerMarkers(
  active: boolean,
  acting: boolean,
  targeted: boolean,
  alive: boolean
): string {
  const markers = [
    active
      ? '<span class="gf-player-marker gf-player-marker--active" data-player-marker="ACTIVE">手番</span>'
      : "",
    acting
      ? '<span class="gf-player-marker gf-player-marker--acting" data-player-marker="ACTING">行動者</span>'
      : "",
    targeted
      ? '<span class="gf-player-marker gf-player-marker--targeted" data-player-marker="TARGETED">対象</span>'
      : "",
    !alive
      ? '<span class="gf-player-marker gf-player-marker--ascended" data-player-marker="ASCENDED">昇天</span>'
      : ""
  ].filter((marker) => marker.length > 0);
  return markers.length > 0
    ? `<div class="gf-player__markers" aria-label="盤面上の役割">${markers.join("")}</div>`
    : "";
}

function renderPlayer(
  player: PlayerPublicView,
  view: GameViewState,
  targetCandidateIds: readonly string[],
  highlightedTargetIds: readonly string[],
  interactionLocked: boolean
): string {
  const active = player.playerId === view.activePlayerId;
  const acting = player.playerId === view.actingPlayerId;
  const targeted = highlightedTargetIds.includes(player.playerId);
  const self = player.playerId === view.self?.playerId;
  const stateDescription = [
    self ? "あなた" : null,
    active ? "手番" : null,
    acting ? "行動中" : null,
    targeted ? "対象" : null,
    !player.alive ? "昇天" : null
  ].filter((label): label is string => label !== null);
  const stateLabel =
    stateDescription.length > 0 ? stateDescription.join("、") : "待機中";
  return `
    <li class="gf-player-list__item">
      <article
        class="gf-player"
        aria-label="${escapeHtml(`${player.displayName}、${stateLabel}`)}"
        data-player-id="${escapeHtml(player.playerId)}"
        data-active="${String(active)}"
        data-acting="${String(acting)}"
        data-targeted="${String(targeted)}"
        data-alive="${String(player.alive)}"
        data-self="${String(self)}"
        data-controller="${player.controller}"
        data-guardian="${String(Boolean(player.guardian))}"
        ${player.guardian ? `title="守護神: ${escapeHtml(player.guardian.guardianName)}"` : ""}
      >
        <header class="gf-player__header">
          <span class="gf-player__seat" aria-label="席 ${player.seatIndex + 1}">
            ${player.seatIndex + 1}
          </span>
          <h3 class="gf-player__name">${escapeHtml(player.displayName)}</h3>
          <span class="gf-player__state">${escapeHtml(stateLabel)}</span>
        </header>
        ${renderPlayerMarkers(active, acting, targeted, player.alive)}
        <dl class="gf-resources" aria-label="公開リソース">
          <div><dt>HP</dt><dd>${player.hp}</dd></div>
          <div><dt>MP</dt><dd>${player.mp}</dd></div>
          <div><dt>所持金</dt><dd>¥${player.money}</dd></div>
        </dl>
        <div class="gf-player__statuses" aria-label="状態">
          ${renderStatusPills(player)}
        </div>
        <p class="gf-player__counts">
          手札 ${player.handCount}枚 ・ 奇跡 ${player.learnedMiracleCount}
        </p>
        ${
          targetCandidateIds.includes(player.playerId)
            ? `<button
                type="button"
                class="gf-player__target-control"
                data-select-target="${escapeHtml(player.playerId)}"
                aria-pressed="${String(targeted)}"
                ${interactionLocked ? "disabled" : ""}
              >${targeted ? "対象に選択中" : "対象に選ぶ"}</button>`
            : ""
        }
      </article>
    </li>`;
}

function renderCard(
  card: CardInstanceView,
  ui: UiInteractionState,
  view: GameViewState
): string {
  const text = cardText(card.cardDefinitionId);
  const definition = CARD_DEFINITIONS_BY_ID.get(card.cardDefinitionId);
  const composingReaction = ui.mode === "COMPOSING_REACTION";
  const status = composingReaction
    ? defenseCardStatus(ui, view, card.instanceId)
    : actionCardStatus(ui, view, card.instanceId);
  const selectionAttribute = composingReaction
    ? `data-select-defense-card="${escapeHtml(card.instanceId)}"`
    : `data-select-card="${escapeHtml(card.instanceId)}"`;
  const reason = status.invalidReason
    ? `<span class="gf-card__reason">${escapeHtml(status.invalidReason)}</span>`
    : "";
  return `
    <li
      class="gf-card"
      data-selected="${String(status.selected)}"
      data-card-category="${definition?.category ?? "GOODS"}"
      data-card-element="${definition?.element ?? "PHYSICAL"}"
    >
      <button
        type="button"
        class="gf-card__button"
        ${selectionAttribute}
        aria-pressed="${String(status.selected)}"
        ${status.selectable ? "" : "disabled"}
        ${status.invalidReason ? `title="${escapeHtml(status.invalidReason)}"` : ""}
      >
        <span class="gf-card__mark" aria-hidden="true">${renderCardArt(
          card.cardDefinitionId,
          CARD_CATEGORY_MARKS[definition?.category ?? "GOODS"],
          "gf-card__image"
        )}</span>
        <span class="gf-card__name">${escapeHtml(text.name)}</span>
        <span class="gf-card__effect">${escapeHtml(text.effect)}</span>
        ${reason}
      </button>
    </li>`;
}

function renderMiracle(
  miracle: LearnedMiracleView,
  ui: UiInteractionState,
  view: GameViewState
): string {
  const text = cardText(miracle.cardDefinitionId);
  const definition = CARD_DEFINITIONS_BY_ID.get(miracle.cardDefinitionId);
  const composingReaction = ui.mode === "COMPOSING_REACTION";
  const status = composingReaction
    ? defenseMiracleStatus(ui, view, miracle.learnedMiracleId)
    : learnedMiracleStatus(ui, view, miracle.learnedMiracleId);
  const selectionAttribute = composingReaction
    ? `data-select-defense-miracle="${escapeHtml(miracle.learnedMiracleId)}"`
    : `data-select-miracle="${escapeHtml(miracle.learnedMiracleId)}"`;
  const reason = status.invalidReason
    ? `<span class="gf-card__reason">${escapeHtml(status.invalidReason)}</span>`
    : "";
  return `
    <li
      class="gf-card gf-card--miracle"
      data-selected="${String(status.selected)}"
      data-card-category="${definition?.category ?? "MIRACLE"}"
      data-card-element="${definition?.element ?? "LIGHT"}"
    >
      <button
        type="button"
        class="gf-card__button"
        ${selectionAttribute}
        aria-pressed="${String(status.selected)}"
        ${status.selectable ? "" : "disabled"}
        ${status.invalidReason ? `title="${escapeHtml(status.invalidReason)}"` : ""}
      >
        <span class="gf-card__mark" aria-hidden="true">${renderCardArt(
          miracle.cardDefinitionId,
          CARD_CATEGORY_MARKS[definition?.category ?? "MIRACLE"],
          "gf-card__image"
        )}</span>
        <span class="gf-card__name">${escapeHtml(text.name)}</span>
        <span class="gf-card__effect">${escapeHtml(text.effect)}</span>
        ${reason}
      </button>
    </li>`;
}

function emptyState(message: string): string {
  return `<li class="gf-empty">${escapeHtml(message)}</li>`;
}

function selectedActionDefinitionIds(
  view: GameViewState,
  ui: UiInteractionState
): string[] {
  const pendingAttackIds =
    view.pendingAttack?.sourceCardDefinitionIds ?? [];
  if (!view.self) return [...pendingAttackIds];
  const cardIds = view.self.hand
    .filter(({ instanceId }) => ui.selectedActionCardIds.includes(instanceId))
    .map(({ cardDefinitionId }) => cardDefinitionId);
  const miracleIds = view.self.learnedMiracles
    .filter(({ learnedMiracleId }) =>
      ui.selectedLearnedMiracleIds.includes(learnedMiracleId)
    )
    .map(({ cardDefinitionId }) => cardDefinitionId);
  const selectedIds = [...cardIds, ...miracleIds];
  return selectedIds.length > 0 ? selectedIds : [...pendingAttackIds];
}

function renderFieldCard(
  cardDefinitionId: string,
  modifier = ""
): string {
  const definition = CARD_DEFINITIONS_BY_ID.get(cardDefinitionId);
  const text = cardText(cardDefinitionId);
  const category = definition?.category ?? "GOODS";
  const price = definition?.price;
  const mpCost = definition?.mpCost;
  return `
    <article
      class="gf-field-card${modifier ? ` ${modifier}` : ""}"
      data-card-category="${category}"
      data-card-element="${definition?.element ?? "PHYSICAL"}"
    >
      <span class="gf-field-card__art" aria-hidden="true">${renderCardArt(
        cardDefinitionId,
        CARD_CATEGORY_MARKS[category],
        "gf-field-card__image"
      )}</span>
      <strong class="gf-field-card__name">${escapeHtml(text.name)}</strong>
      <span class="gf-field-card__effect">${escapeHtml(text.effect)}</span>
      ${
        price === undefined
          ? ""
          : `<span class="gf-field-card__price">¥${price}</span>`
      }
      ${
        mpCost === undefined
          ? ""
          : `<span class="gf-field-card__cost">MP${mpCost}</span>`
      }
    </article>`;
}

type AttackCreatedEvent = Extract<DomainEvent, { type: "ATTACK_CREATED" }>;
type HitRolledEvent = Extract<DomainEvent, { type: "HIT_ROLLED" }>;
type ReactionDeclaredEvent = Extract<
  DomainEvent,
  { type: "REACTION_DECLARED" }
>;
type DamageAppliedEvent = Extract<DomainEvent, { type: "DAMAGE_APPLIED" }>;
type ResourceChangedEvent = Extract<
  DomainEvent,
  { type: "RESOURCE_CHANGED" }
>;
type AttackCalamityEvent = Extract<
  DomainEvent,
  { type: "CALAMITY_APPLIED" | "CALAMITY_WORSENED" }
>;
type GuardianActionEvent = Extract<
  DomainEvent,
  { type: "GUARDIAN_ACTION_SELECTED" }
>;

type AttackPresentationScene = {
  attackEvent: AttackCreatedEvent;
  actorId: string;
  targetPlayerId: string;
  reaction: ReactionDeclaredEvent | null;
  hitRoll: HitRolledEvent | null;
  damage: DamageAppliedEvent | null;
  calamity: AttackCalamityEvent | null;
  stageKind: PresentationStageKind;
  stageIndex: number;
};

type RecentCardUseScene = {
  actorId: string;
  activityPlayerId: string;
  targetPlayerId: string | null;
  activityLabel: string;
  actionCardDefinitionIds: string[];
  defenseCardDefinitionIds: string[];
  defensePower: number | null;
  attack: AttackCreatedEvent["attack"] | null;
  recovery: ResourceChangedEvent | null;
};

function actionActivityLabel(actionType: GameCommand["type"]): string {
  switch (actionType) {
    case "DECLARE_ACTION":
      return "神器・奇跡を使用";
    case "DISCARD":
      return "神器を捨てた";
    case "SACRIFICE":
      return "神器をささげた";
    case "EXCHANGE_RESOURCES":
      return "両替した";
    case "SELL_CARD":
      return "神器を売った";
    case "DECLARE_BUY":
      return "神器を買った";
    default:
      return "行動した";
  }
}

function latestRecentCardUseScene(
  presentation: PresentationQueueState | null
): RecentCardUseScene | null {
  const active = presentation?.activeStep?.step;
  if (!active) return null;
  const events = presentation.recentEvents.filter(
    ({ eventSeq }) => eventSeq <= active.eventSeq
  );
  const cardUse = [...events]
    .reverse()
    .find(
      (
        event
      ): event is Extract<
        DomainEvent,
        { type: "ACTION_DECLARED" | "REACTION_DECLARED" }
      > =>
        (event.type === "ACTION_DECLARED" &&
          (event.actionCardDefinitionIds?.length ?? 0) > 0) ||
        (event.type === "REACTION_DECLARED" &&
          ((event.defenseCardDefinitionIds?.length ?? 0) > 0 ||
            (event.defenseLearnedMiracleDefinitionIds?.length ?? 0) > 0))
    );
  if (!cardUse) return null;
  if (cardUse.type === "ACTION_DECLARED") {
    const recovery =
      active.event.type === "RESOURCE_CHANGED" &&
      active.event.delta > 0 &&
      (active.event.resource === "HP" || active.event.resource === "MP") &&
      (active.event.reason === "CARD_EFFECT" ||
        active.event.reason === "MIRACLE")
        ? active.event
        : null;
    return {
      actorId: cardUse.playerId,
      activityPlayerId: cardUse.playerId,
      targetPlayerId: cardUse.targetPlayerId,
      activityLabel: actionActivityLabel(cardUse.actionType),
      actionCardDefinitionIds: [...(cardUse.actionCardDefinitionIds ?? [])],
      defenseCardDefinitionIds: [],
      defensePower: null,
      attack: null,
      recovery
    };
  }
  const request = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "REACTION_REQUESTED" &&
        event.reactionId === cardUse.reactionId
    );
  const attackEvent =
    request?.type === "REACTION_REQUESTED"
      ? [...events]
          .reverse()
          .find(
            (event): event is AttackCreatedEvent =>
              event.type === "ATTACK_CREATED" &&
              event.attack.attackId === request.attackId
          ) ?? null
      : null;
  const redirect = events.find(
    (event) =>
      event.type === "ATTACK_REDIRECTED" &&
      event.reactionId === cardUse.reactionId
  );
  return {
    actorId: attackEvent?.attack.actorId ?? cardUse.playerId,
    activityPlayerId: cardUse.playerId,
    targetPlayerId: attackEvent?.attack.targetPlayerId ?? cardUse.playerId,
    activityLabel:
      redirect?.type === "ATTACK_REDIRECTED"
        ? redirect.redirectType === "REFLECT"
          ? "跳ね返した"
          : "受け流した"
        : "防御した",
    actionCardDefinitionIds: [
      ...(attackEvent?.attack.sourceCardDefinitionIds ?? [])
    ],
    defenseCardDefinitionIds: [
      ...(cardUse.defenseCardDefinitionIds ?? []),
      ...(cardUse.defenseLearnedMiracleDefinitionIds ?? [])
    ],
    defensePower: cardUse.defensePower ?? null,
    attack: attackEvent?.attack ?? null,
    recovery: null
  };
}

function presentationAttackScene(
  presentation: PresentationQueueState | null
): AttackPresentationScene | null {
  const active = presentation?.activeStep?.step;
  if (
    !active ||
    ![
      "TARGET",
      "HIT_RESULT",
      "REACTION_REQUEST",
      "REACTION",
      "DAMAGE_RESULT",
      "HP_UPDATE",
      "CALAMITY"
    ].includes(active.kind)
  ) {
    return null;
  }
  const activeEvent = active.event;
  const events = presentation.recentEvents.filter(
    ({ eventSeq }) => eventSeq <= active.eventSeq
  );
  const latestCalamityDamage =
    activeEvent.type === "CALAMITY_APPLIED" ||
    activeEvent.type === "CALAMITY_WORSENED"
      ? [...events]
          .reverse()
          .find(
            (event): event is DamageAppliedEvent =>
              event.type === "DAMAGE_APPLIED" &&
              event.playerId === activeEvent.playerId
          ) ?? null
      : null;
  const calamitySeparatedFromAttack =
    latestCalamityDamage !== null &&
    events.some(
      (event) =>
        event.eventSeq > latestCalamityDamage.eventSeq &&
        event.eventSeq < active.eventSeq &&
        (event.type === "ACTION_DECLARED" ||
          event.type === "ATTACK_CREATED" ||
          event.type === "POST_TURN_AUTOMATIC_EFFECTS_STARTED" ||
          event.type === "GUARDIAN_ACTION_SELECTED" ||
          event.type === "PHENOMENON_SELECTED")
    );
  const relatedCalamityDamage = calamitySeparatedFromAttack
    ? null
    : latestCalamityDamage;
  const directAttackId =
    activeEvent.type === "ATTACK_CREATED"
      ? activeEvent.attack.attackId
      : activeEvent.type === "ATTACK_REDIRECTED" ||
          activeEvent.type === "HIT_ROLLED" ||
          activeEvent.type === "REACTION_REQUESTED" ||
          activeEvent.type === "DAMAGE_APPLIED"
        ? activeEvent.attackId
        : relatedCalamityDamage?.attackId ?? null;
  const directReactionId =
    activeEvent.type === "REACTION_DECLARED"
      ? activeEvent.reactionId
      : activeEvent.type === "REACTION_REQUESTED" ||
          activeEvent.type === "ATTACK_REDIRECTED"
        ? activeEvent.reactionId
        : null;
  const directReactionRequest = directReactionId
    ? [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "REACTION_REQUESTED" &&
            event.reactionId === directReactionId
        )
    : null;
  const resolvedDirectAttackId =
    directAttackId ??
    (directReactionRequest?.type === "REACTION_REQUESTED"
      ? directReactionRequest.attackId
      : null);
  const attackEvents = events.filter(
    (event): event is AttackCreatedEvent => event.type === "ATTACK_CREATED"
  );
  const attackEvent =
    [...attackEvents]
      .reverse()
      .find(({ attack }) =>
        resolvedDirectAttackId
          ? attack.attackId === resolvedDirectAttackId
          : directReactionId
            ? attack.reactionId === directReactionId
            : false
      ) ?? null;
  if (!attackEvent) return null;
  const redirect = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "ATTACK_REDIRECTED" &&
        event.attackId === attackEvent.attack.attackId
    );
  const reaction =
    [...events]
      .reverse()
      .find(
        (event): event is ReactionDeclaredEvent =>
          event.type === "REACTION_DECLARED" &&
          (directReactionId
            ? event.reactionId === directReactionId
            : events.some(
                (request) =>
                  request.type === "REACTION_REQUESTED" &&
                  request.reactionId === event.reactionId &&
                  request.attackId === attackEvent.attack.attackId
              ))
      ) ?? null;
  const hitRoll =
    [...events]
      .reverse()
      .find(
        (event): event is HitRolledEvent =>
          event.type === "HIT_ROLLED" &&
          event.attackId === attackEvent.attack.attackId
      ) ?? null;
  const damage =
    [...events]
      .reverse()
      .find(
        (event): event is DamageAppliedEvent =>
          event.type === "DAMAGE_APPLIED" &&
          event.attackId === attackEvent.attack.attackId
      ) ?? null;
  return {
    attackEvent,
    actorId:
      redirect?.type === "ATTACK_REDIRECTED"
        ? redirect.actorId
        : attackEvent.attack.actorId,
    targetPlayerId:
      redirect?.type === "ATTACK_REDIRECTED"
        ? redirect.targetPlayerId
        : attackEvent.attack.targetPlayerId,
    reaction,
    hitRoll,
    damage,
    calamity:
      activeEvent.type === "CALAMITY_APPLIED" ||
      activeEvent.type === "CALAMITY_WORSENED"
        ? activeEvent
        : null,
    stageKind: active.kind,
    stageIndex: active.stageIndex
  };
}

function presentationGuardianAction(
  presentation: PresentationQueueState | null
): GuardianActionEvent | null {
  const active = presentation?.activeStep?.step;
  return active?.kind === "GUARDIAN" &&
    active.event.type === "GUARDIAN_ACTION_SELECTED"
    ? active.event
    : null;
}

function renderActionRegion(
  view: GameViewState,
  ui: UiInteractionState,
  presentation: PresentationQueueState | null
): string {
  const pendingAttack = view.pendingAttack;
  const activePresentationKind =
    presentation?.activeStep?.step.kind ?? null;
  const queuedPresentedAttack = presentationAttackScene(presentation);
  const presentedAttack = queuedPresentedAttack;
  const locksPresentedAttack =
    presentedAttack !== null &&
    ["HIT_RESULT", "REACTION", "DAMAGE_RESULT", "HP_UPDATE", "CALAMITY"].includes(
      presentedAttack.stageKind
    );
  const authoritativePendingAttack = pendingAttack;
  const guardianAction = presentationGuardianAction(presentation);
  const recentCardUseCandidate =
    !presentedAttack &&
    !guardianAction &&
    (!pendingAttack || activePresentationKind === "ACTION") &&
    ui.selectedActionCardIds.length === 0 &&
    ui.selectedLearnedMiracleIds.length === 0
      ? latestRecentCardUseScene(presentation)
      : null;
  const recentCardUse = recentCardUseCandidate;
  const actorId =
    (locksPresentedAttack ? presentedAttack.actorId : null) ??
    authoritativePendingAttack?.actorId ??
    presentedAttack?.actorId ??
    guardianAction?.playerId ??
    recentCardUse?.actorId ??
    pendingAttack?.actorId ??
    view.actingPlayerId;
  const selectedTargetId =
    (locksPresentedAttack ? presentedAttack.targetPlayerId : null) ??
    authoritativePendingAttack?.targetPlayerId ??
    presentedAttack?.targetPlayerId ??
    guardianAction?.targetPlayerId ??
    (recentCardUse
      ? recentCardUse.targetPlayerId
      : ui.selectedTargetIds[0] ??
        pendingAttack?.targetPlayerId ??
        view.targetPlayerIds[0] ??
        null);
  const actor = playerById(view, actorId);
  const target = playerById(view, selectedTargetId);
  const actionCardDefinitionIds = locksPresentedAttack
    ? [...presentedAttack.attackEvent.attack.sourceCardDefinitionIds]
    : authoritativePendingAttack
      ? [...authoritativePendingAttack.sourceCardDefinitionIds]
      : presentedAttack
        ? [...presentedAttack.attackEvent.attack.sourceCardDefinitionIds]
        : guardianAction
          ? [guardianAction.actionCardDefinitionId]
          : recentCardUse
            ? [...recentCardUse.actionCardDefinitionIds]
            : selectedActionDefinitionIds(view, ui);
  const preview = actionPreview(ui, view);
  const reaction = reactionPreview(ui, view);
  const allDefenseDefinitionIds = locksPresentedAttack
    ? [
        ...(presentedAttack.reaction?.defenseCardDefinitionIds ?? []),
        ...(presentedAttack.reaction
          ?.defenseLearnedMiracleDefinitionIds ?? [])
      ]
    : ui.mode === "COMPOSING_REACTION"
      ? [
          ...(view.self?.hand
            .filter(({ instanceId }) =>
              ui.selectedDefenseCardIds.includes(instanceId)
            )
            .map(({ cardDefinitionId }) => cardDefinitionId) ?? []),
          ...(view.self?.learnedMiracles
            .filter(({ learnedMiracleId }) =>
              ui.selectedDefenseLearnedMiracleIds.includes(learnedMiracleId)
            )
            .map(({ cardDefinitionId }) => cardDefinitionId) ?? [])
        ]
      : [
          ...(presentedAttack?.reaction?.defenseCardDefinitionIds ??
            recentCardUse?.defenseCardDefinitionIds ??
            []),
          ...(presentedAttack?.reaction
            ?.defenseLearnedMiracleDefinitionIds ?? [])
        ];
  const selectedDefenseDefinitionIds =
    presentedAttack?.stageKind === "TARGET"
      ? []
      : allDefenseDefinitionIds;
  const showForgive =
    presentedAttack?.stageKind === "REACTION" &&
    presentedAttack.reaction !== null &&
    allDefenseDefinitionIds.length === 0;
  const attackPower =
    (locksPresentedAttack
      ? presentedAttack.attackEvent.attack.power
      : null) ??
    authoritativePendingAttack?.power ??
    presentedAttack?.attackEvent.attack.power ??
    recentCardUse?.attack?.power ??
    pendingAttack?.power ??
    preview.attackPower;
  const defensePower =
    locksPresentedAttack
      ? presentedAttack.reaction?.defensePower ?? null
      : ui.mode === "COMPOSING_REACTION"
      ? reaction.totalDefense
      : presentedAttack?.reaction?.defensePower ??
        recentCardUse?.defensePower ??
        null;
  const displayedAttack =
    (locksPresentedAttack
      ? presentedAttack.attackEvent.attack
      : null) ??
    authoritativePendingAttack ??
    presentedAttack?.attackEvent.attack ??
    recentCardUse?.attack ??
    pendingAttack;
  const direction = actor && target
    ? `${actor.displayName} から ${target.displayName}`
    : actor
      ? `${actor.displayName} の行動`
      : "行動待ち";
  const showRoute = !(
    activePresentationKind === "ACTION" &&
    recentCardUse !== null
  );
  return `
    <section
      class="gf-panel gf-action"
      data-region="action"
      data-attack-id="${escapeHtml(displayedAttack?.attackId ?? "")}"
      data-attack-target-index="${displayedAttack ? displayedAttack.targetIndex + 1 : ""}"
      data-attack-target-count="${displayedAttack?.totalTargets ?? ""}"
      data-presentation-scene="${presentedAttack ? "attack" : guardianAction ? "guardian" : recentCardUse ? "recent-card-use" : "none"}"
      data-presentation-stage="${activePresentationKind ?? "NONE"}"
      data-has-defense="${String(selectedDefenseDefinitionIds.length > 0 || defensePower !== null)}"
      data-has-route="${String(showRoute && Boolean(actor && target))}"
      aria-labelledby="gf-action-title"
      aria-live="polite"
    >
      <div class="gf-section-heading">
        <p class="gf-section-heading__eyebrow">Action</p>
        <h2 id="gf-action-title">行動</h2>
      </div>
      ${
        showRoute
          ? `<div class="gf-action__route" aria-hidden="true">
              <span class="gf-action__actor">${
                guardianAction
                  ? escapeHtml(actor?.guardian?.guardianName ?? "守護神")
                  : escapeHtml(actor?.displayName ?? "行動待ち")
              }</span>
              <span class="gf-action__arrow">➜</span>
              <span class="gf-action__target">${escapeHtml(target?.displayName ?? "対象を選択")}</span>
            </div>`
          : ""
      }
      <p class="gf-action__direction sr-only">${escapeHtml(direction)}</p>
      ${
        recentCardUse
          ? `<p class="gf-action__activity" role="status">${escapeHtml(
              `${eventPlayerName(view, recentCardUse.activityPlayerId)}が${recentCardUse.activityLabel}`
            )}</p>`
          : ""
      }
      ${
        displayedAttack && displayedAttack.totalTargets > 1
          ? `<p class="gf-action__progress" aria-live="polite">
              全体攻撃の対象 ${displayedAttack.targetIndex + 1} / ${displayedAttack.totalTargets}
            </p>`
          : ""
      }
      <div class="gf-action__content" aria-label="攻防プレビュー">
        <div
          class="gf-action__stack gf-action__stack--attack"
          data-card-lane="action"
          aria-label="使用したカード"
        >
          ${
            actionCardDefinitionIds.length > 0
              ? actionCardDefinitionIds
                  .map((cardDefinitionId) => renderFieldCard(cardDefinitionId))
                  .join("")
              : '<span class="gf-empty-inline">使用する神器・奇跡はまだありません</span>'
          }
        </div>
        <div
          class="gf-action__stack gf-action__stack--defense"
          data-card-lane="defense"
          aria-label="防御に使用したカード"
        >
          ${selectedDefenseDefinitionIds
            .map((cardDefinitionId) =>
              renderFieldCard(cardDefinitionId, "gf-field-card--defense")
            )
            .join("")}
          ${
            showForgive
              ? '<strong class="gf-action__forgive" role="status">許す</strong>'
              : ""
          }
        </div>
        ${
          presentedAttack?.stageKind === "HIT_RESULT" &&
          presentedAttack.hitRoll
            ? `<div
                class="gf-action__result"
                data-result="${presentedAttack.hitRoll.hit ? "hit" : "miss"}"
                role="status"
              ><strong>${presentedAttack.hitRoll.hit ? "命中" : "外れた"}</strong></div>`
            : ""
        }
        ${
          presentedAttack?.damage && !presentedAttack.calamity
            ? `<div
                class="gf-action__result"
                data-result="${presentedAttack.damage.amount === 0 ? "safe" : "damage"}"
                role="status"
              >${
                presentedAttack.damage.amount === 0
                  ? "<strong>無事</strong>"
                  : `<strong>${presentedAttack.damage.amount}</strong><span>ダメージ</span>`
              }</div>`
            : ""
        }
        ${
          recentCardUse?.recovery
            ? `<div
                class="gf-action__result"
                data-result="recovery"
                data-resource="${recentCardUse.recovery.resource.toLowerCase()}"
                role="status"
              ><strong>+${recentCardUse.recovery.delta}</strong><span>${recentCardUse.recovery.resource.toLowerCase()}</span></div>`
            : ""
        }
        ${
          presentedAttack?.calamity
            ? `<div
                class="gf-action__effect"
                data-effect="calamity"
                role="status"
              ><strong>${escapeHtml(
                presentedAttack.calamity.type === "CALAMITY_APPLIED"
                  ? CALAMITY_LABELS[presentedAttack.calamity.calamity]
                  : presentedAttack.calamity.to
                    ? CALAMITY_LABELS[presentedAttack.calamity.to]
                    : CALAMITY_LABELS[presentedAttack.calamity.from]
              )}</strong><span>${
                presentedAttack.calamity.type === "CALAMITY_WORSENED" &&
                presentedAttack.calamity.to === null
                  ? "が悪化"
                  : "になった"
              }</span></div>`
            : ""
        }
      </div>
      <dl class="gf-action__summary" aria-label="選択中の行動値">
        <div>
          <dt>合計攻撃</dt>
          <dd>${attackPower ?? "—"}</dd>
        </div>
        <div>
          <dt>属性</dt>
          <dd>${
            displayedAttack
              ? ELEMENT_LABELS[displayedAttack.element]
              : preview.element
                ? ELEMENT_LABELS[preview.element]
                : "—"
          }</dd>
        </div>
        <div>
          <dt>必要MP</dt>
          <dd>${preview.requiredMp}</dd>
        </div>
      </dl>
      ${
        ui.mode === "COMPOSING_REACTION" ||
        presentedAttack?.stageKind === "REACTION" ||
        presentedAttack?.stageKind === "DAMAGE_RESULT" ||
        presentedAttack?.stageKind === "CALAMITY" ||
        (recentCardUse?.defensePower ?? null) !== null
          ? `<dl class="gf-action__defense-summary" aria-label="選択中の防御値">
              <div><dt>合計防御</dt><dd>${defensePower ?? 0}</dd></div>
            </dl>`
          : ""
      }
    </section>`;
}

function renderResponseRegion(
  view: GameViewState,
  ui: UiInteractionState
): string {
  const reaction = reactionPreview(ui, view);
  const target = playerById(view, view.targetPlayerIds[0] ?? null);
  const trade = view.self?.tradeConfirmation ?? null;
  const payment = tradePaymentPreview(view);
  let content = '<span class="gf-empty-inline">応答待ち</span>';

  if (ui.mode === "COMPOSING_REACTION") {
    const selectedCards =
      view.self?.hand.filter(({ instanceId }) =>
        ui.selectedDefenseCardIds.includes(instanceId)
      ) ?? [];
    const selectedMiracles =
      view.self?.learnedMiracles.filter(({ learnedMiracleId }) =>
        ui.selectedDefenseLearnedMiracleIds.includes(learnedMiracleId)
      ) ?? [];
    const selectedDefinitionIds = [...selectedCards, ...selectedMiracles].map(
      ({ cardDefinitionId }) => cardDefinitionId
    );
    content = `
      <p class="gf-response__subject">
        ${escapeHtml(target?.displayName ?? "あなた")}への攻撃
      </p>
      <div class="gf-response__selection">
        ${
          selectedDefinitionIds.length > 0
            ? selectedDefinitionIds
                .map((cardDefinitionId) =>
                  renderFieldCard(cardDefinitionId, "gf-field-card--defense")
                )
                .join("")
            : '<span class="gf-response__forgive">防具を使わず「許す」こともできます</span>'
        }
      </div>
      <dl class="gf-response__summary" aria-label="選択中の防御値">
        <div><dt>合計防御</dt><dd>${reaction.totalDefense}</dd></div>
        <div><dt>必要MP</dt><dd>${reaction.requiredMp}</dd></div>
      </dl>
      <div class="gf-response__actions">
        <button
          type="button"
          data-submit-reaction
          ${reaction.hasSelection && reaction.canSubmit ? "" : "disabled"}
        >防御を確定</button>
        <button
          type="button"
          data-submit-forgive
          ${reaction.canSubmit ? "" : "disabled"}
        >許す</button>
      </div>
      ${
        reaction.invalidReason
          ? `<p class="gf-controls__reason" role="status">${escapeHtml(reaction.invalidReason)}</p>`
          : ""
      }`;
  } else if (ui.mode === "CONFIRMING_TRADE" && trade && payment) {
    const offeredText = cardText(trade.offeredCard.cardDefinitionId);
    const seller = playerById(view, trade.targetPlayerId);
    content = `
      <article class="gf-trade-offer" data-trade-id="${escapeHtml(trade.tradeId)}">
        <p class="gf-response__subject">
          ${escapeHtml(seller?.displayName ?? "相手")}からの商品
        </p>
        <strong class="gf-trade-offer__name">${escapeHtml(offeredText.name)}</strong>
        <p class="gf-trade-offer__effect">${escapeHtml(offeredText.effect)}</p>
        <dl class="gf-response__summary" aria-label="購入時の支払い見込み">
          <div><dt>価格</dt><dd>¥${payment.price}</dd></div>
          <div><dt>所持金</dt><dd>${payment.money}</dd></div>
          <div><dt>MP</dt><dd>${payment.mp}</dd></div>
          <div><dt>HP</dt><dd>${payment.hp}</dd></div>
        </dl>
        <p class="gf-trade-offer__payment">
          支払い順: 所持金 → MP → HP
        </p>
        ${
          payment.canAfford
            ? ""
            : '<p class="gf-controls__reason" role="alert">支払いできません</p>'
        }
        <div class="gf-response__actions">
          <button
            type="button"
            data-confirm-buy
            ${payment.canAfford && !ui.interactionLocked ? "" : "disabled"}
          >購入する</button>
          <button
            type="button"
            data-decline-buy
            ${ui.interactionLocked ? "disabled" : ""}
          >断る</button>
        </div>
      </article>`;
  } else if (
    view.phase === "REACTION_SELECTION" &&
    target?.controller === "CPU"
  ) {
    content = `
      <p class="gf-response__subject">
        ${escapeHtml(target.displayName)}（CPU）が防御を選択しています
      </p>`;
  } else if (view.phase === "REACTION_SELECTION" && target) {
    content = `
      <p class="gf-response__subject">
        ${escapeHtml(target.displayName)}の防御を待っています
      </p>`;
  }
  return `
    <section
      class="gf-panel gf-response"
      data-region="response"
      aria-labelledby="gf-response-title"
      aria-live="polite"
    >
      <div class="gf-section-heading">
        <p class="gf-section-heading__eyebrow">Reaction</p>
        <h2 id="gf-response-title">応答</h2>
      </div>
      <div class="gf-response__content">${content}</div>
    </section>`;
}

function renderResultRegion(
  view: GameViewState,
  links: BattleScreenLinks
): string {
  if (!view.result) {
    return `
      <section
        class="gf-result"
        data-region="result"
        aria-labelledby="gf-result-title"
        hidden
      >
        <h2 id="gf-result-title">対戦結果</h2>
      </section>`;
  }
  const winnerNames = view.result.winnerPlayerIds
    .map((playerId) => playerById(view, playerId)?.displayName ?? playerId)
    .join("、");
  const resultTitle = view.result.kind === "DRAW" ? "引き分け" : "勝利";
  const exitHref = safeHref(
    links.exitHref ?? links.backHref,
    view.matchMode === "TRAINING" ? "/training" : "/"
  );
  return `
    <section
      class="gf-result"
      data-region="result"
      data-result-kind="${view.result.kind}"
      data-winner-player-ids="${escapeHtml(view.result.winnerPlayerIds.join(","))}"
      aria-labelledby="gf-result-title"
      aria-describedby="gf-result-description"
      role="dialog"
      aria-modal="true"
    >
      <p class="gf-section-heading__eyebrow">Result</p>
      <h2 id="gf-result-title">${resultTitle}</h2>
      ${
        view.result.kind === "DRAW"
          ? `<p id="gf-result-description" class="gf-result__description">
              勝者なし
            </p>`
          : `<div id="gf-result-description" class="gf-result__description">
              <span class="gf-result__winner-label">勝者</span>
              <strong class="gf-result__winner">${escapeHtml(winnerNames)}</strong>
            </div>`
      }
      <a
        class="gf-primary-link"
        data-exit-match
        href="${exitHref}"
      >戦いを終わる</a>
    </section>`;
}

function renderInputStatus(
  view: GameViewState,
  ui: UiInteractionState,
  nowMs: number
): string {
  const selfPlayer = playerById(view, view.self?.playerId ?? null);
  if (!selfPlayer) return "";
  if (ui.inputDeadlineExpired) {
    return `
      <p class="gf-input-status gf-input-status--warning" role="alert">
        入力期限が切れました。サーバーのCPU代行状態を同期しています。
      </p>`;
  }
  if (selfPlayer.controller === "CPU") {
    const message =
      selfPlayer.connectionState === "DISCONNECTED"
        ? "接続が切れたため、CPUが操作を代行しています。"
        : "再接続済みですが、操作権はCPUのままです。";
    return `
      <p
        class="gf-input-status gf-input-status--cpu"
        data-controller-status="CPU"
        role="status"
      >${message}</p>`;
  }
  if (selfPlayer.connectionState === "DISCONNECTED") {
    return `
      <p class="gf-input-status gf-input-status--warning" role="alert">
        サーバーとの接続が切れています。
      </p>`;
  }
  const remainingSeconds = inputDeadlineRemainingSeconds(ui, nowMs);
  if (remainingSeconds === null || !isHumanInputMode(ui.mode)) return "";
  return `
    <p
      class="gf-input-status gf-input-status--deadline"
      data-input-deadline="${escapeHtml(ui.inputDeadlineAt ?? "")}"
      data-remaining-seconds="${remainingSeconds}"
      role="timer"
      aria-live="polite"
    >
      <span>入力期限</span>
      <time datetime="${escapeHtml(ui.inputDeadlineAt ?? "")}">
        残り ${remainingSeconds}秒
      </time>
      <small>時間切れ後はCPUが代行します</small>
    </p>`;
}

function cardOption(
  view: GameViewState,
  instanceId: string
): string {
  const card = view.self?.hand.find(
    (candidate) => candidate.instanceId === instanceId
  );
  const label = card
    ? cardText(card.cardDefinitionId).name
    : instanceId;
  return `<option value="${escapeHtml(instanceId)}">${escapeHtml(label)}</option>`;
}

function renderUtilityCardChoices(
  view: GameViewState,
  instanceIds: readonly string[],
  inputName = "cardInstanceId"
): string {
  return `<fieldset class="gf-utility-card-choices">
    <legend>神器を選択</legend>
    ${instanceIds
      .map((instanceId, index) => {
        const card = view.self?.hand.find(
          (candidate) => candidate.instanceId === instanceId
        );
        const definition = card
          ? CARD_DEFINITIONS_BY_ID.get(card.cardDefinitionId)
          : null;
        const text = card
          ? cardText(card.cardDefinitionId)
          : { name: instanceId, effect: "" };
        return `
          <label class="gf-utility-card-choice">
            <input
              type="radio"
              name="${escapeHtml(inputName)}"
              value="${escapeHtml(instanceId)}"
              ${index === 0 ? "checked" : ""}
            >
            <span class="gf-utility-card-choice__mark" aria-hidden="true">${
              CARD_CATEGORY_MARKS[definition?.category ?? "GOODS"]
            }</span>
            <strong>${escapeHtml(text.name)}</strong>
            <small>${escapeHtml(text.effect)}</small>
            <span class="gf-utility-card-choice__price">¥${definition?.price ?? 0}</span>
          </label>`;
      })
      .join("")}
  </fieldset>`;
}

function playerOption(
  view: GameViewState,
  playerId: string
): string {
  const label = playerById(view, playerId)?.displayName ?? playerId;
  return `<option value="${escapeHtml(playerId)}">${escapeHtml(label)}</option>`;
}

function renderUtilityActions(
  view: GameViewState,
  ui: UiInteractionState
): string {
  if (
    !view.self ||
    ui.mode !== "COMPOSING_ACTION" ||
    ui.interactionLocked ||
    ui.inputDeadlineExpired
  ) {
    return "";
  }
  const actions = view.self.legalActions;
  const forms: string[] = [];
  const discard = actions.find(({ type }) => type === "DISCARD");
  if (discard?.type === "DISCARD") {
    forms.push(`
      <form class="gf-utility-action" data-utility-form="DISCARD">
        <div class="gf-utility-action__lead" data-utility-kind="discard">
          <span aria-hidden="true">▤</span>
          <strong>捨てる</strong>
          <small>神器を捨てる（新しい神器は授からない）</small>
        </div>
        ${renderUtilityCardChoices(view, discard.cardInstanceIds)}
        <button type="submit">選んだ神器を捨てる</button>
      </form>`);
  }
  const sacrifice = actions.find(({ type }) => type === "SACRIFICE");
  if (sacrifice?.type === "SACRIFICE") {
    forms.push(`
      <form class="gf-utility-action" data-utility-form="SACRIFICE">
        <div class="gf-utility-action__lead" data-utility-kind="sacrifice">
          <span aria-hidden="true">✧</span>
          <strong>ささげる</strong>
          <small>神器をささげて奇跡を習得する</small>
        </div>
        ${renderUtilityCardChoices(view, sacrifice.cardInstanceIds)}
        <button type="submit">選んだ神器をささげる</button>
      </form>`);
  }
  const exchange = actions.find(
    ({ type }) => type === "EXCHANGE_RESOURCES"
  );
  if (exchange?.type === "EXCHANGE_RESOURCES") {
    const selfPlayer = playerById(view, view.self.playerId);
    forms.push(`
      <form class="gf-utility-action" data-utility-form="EXCHANGE_RESOURCES">
        <div class="gf-utility-action__lead" data-utility-kind="exchange">
          <span aria-hidden="true">▦</span>
          <strong>両替</strong>
          <small>HP・MP・¥を同じ合計のまま再配分する</small>
        </div>
        <select class="sr-only" name="cardInstanceId" aria-label="両替神器">${exchange.cardInstanceIds
          .map((id) => cardOption(view, id)).join("")}</select>
        <div class="gf-exchange" data-exchange-total="${exchange.resourceTotal}">
          <div class="gf-exchange__buttons" data-resource="hp">
            <button type="button" data-exchange-adjust="hp:10">+10</button>
            <button type="button" data-exchange-adjust="hp:1">+1</button>
          </div>
          <div class="gf-exchange__buttons" data-resource="mp">
            <button type="button" data-exchange-adjust="mp:10">+10</button>
            <button type="button" data-exchange-adjust="mp:1">+1</button>
          </div>
          <div class="gf-exchange__readout" aria-live="polite">
            <span>HP <output data-exchange-output="hp">${selfPlayer?.hp ?? 0}</output></span>
            <span>MP <output data-exchange-output="mp">${selfPlayer?.mp ?? 0}</output></span>
            <span>¥ <output data-exchange-output="money">${selfPlayer?.money ?? 0}</output></span>
          </div>
          <div class="gf-exchange__buttons" data-resource="hp">
            <button type="button" data-exchange-adjust="hp:-1">-1</button>
            <button type="button" data-exchange-adjust="hp:-10">-10</button>
          </div>
          <div class="gf-exchange__buttons" data-resource="mp">
            <button type="button" data-exchange-adjust="mp:-1">-1</button>
            <button type="button" data-exchange-adjust="mp:-10">-10</button>
          </div>
          <input name="hp" type="hidden" value="${selfPlayer?.hp ?? 0}">
          <input name="mp" type="hidden" value="${selfPlayer?.mp ?? 0}">
          <input name="money" type="hidden" value="${selfPlayer?.money ?? 0}">
        </div>
        <small class="gf-exchange__total">合計 ${exchange.resourceTotal}</small>
        <button type="submit">両替する</button>
      </form>`);
  }
  const sell = actions.find(({ type }) => type === "SELL_CARD");
  if (sell?.type === "SELL_CARD") {
    forms.push(`
      <form class="gf-utility-action" data-utility-form="SELL_CARD">
        <label>取引神器
          <select name="cardInstanceId">${sell.cardInstanceIds
            .map((id) => cardOption(view, id)).join("")}</select>
        </label>
        <label>売る商品
          <select name="productCardInstanceId">${sell.productCardInstanceIds
            .map((id) => cardOption(view, id)).join("")}</select>
        </label>
        <label>売り先
          <select name="targetPlayerId">${sell.targetPlayerIds
            .map((id) => playerOption(view, id)).join("")}</select>
        </label>
        <button type="submit">売る</button>
      </form>`);
  }
  const buy = actions.find(({ type }) => type === "DECLARE_BUY");
  if (buy?.type === "DECLARE_BUY") {
    forms.push(`
      <form class="gf-utility-action" data-utility-form="DECLARE_BUY">
        <label>取引神器
          <select name="cardInstanceId">${buy.cardInstanceIds
            .map((id) => cardOption(view, id)).join("")}</select>
        </label>
        <label>購入先
          <select name="targetPlayerId">${buy.targetPlayerIds
            .map((id) => playerOption(view, id)).join("")}</select>
        </label>
        <button type="submit">商品を見る</button>
      </form>`);
  }
  if (actions.some(({ type }) => type === "SURRENDER")) {
    forms.push(`
      <form class="gf-utility-action" data-utility-form="SURRENDER">
        <p>この試合を降参します。</p>
        <button type="submit" class="gf-utility-action__danger">降参する</button>
      </form>`);
  }
  return forms.length === 0
    ? ""
    : `<details class="gf-utility-actions">
        <summary>その他の行動</summary>
        ${forms.join("")}
      </details>`;
}

const RESOURCE_LABELS = {
  HP: "HP",
  MP: "MP",
  MONEY: "所持金"
} as const;

function eventPlayerName(
  view: GameViewState,
  playerId: string
): string {
  return playerById(view, playerId)?.displayName ?? playerId;
}

function presentationCopy(
  view: GameViewState,
  presentation: PresentationQueueState
): { eyebrow: string; title: string; detail: string } | null {
  const active = presentation.activeStep?.step;
  if (!active) return null;
  const event = active.event;

  switch (event.type) {
    case "HAND_LIMIT_DISCARD":
      return {
        eyebrow: "Hand limit",
        title: `${eventPlayerName(view, event.playerId)}の手札が満杯です`,
        detail: "新しい神器を取得した後、元の手札から1枚を破棄しました"
      };
    case "GRANT_CANCELLED":
      return {
        eyebrow: "Grant",
        title: `${eventPlayerName(view, event.playerId)}への授与を終了`,
        detail: "昇天したため残りの授与はありません"
      };
    case "DEMON_APPEARED": {
      const text = cardText(event.demonCardDefinitionId);
      return {
        eyebrow: "Demon",
        title: `${eventPlayerName(view, event.playerId)}に悪魔が出現`,
        detail: text.name
      };
    }
    case "DEMON_OBJECT_REMOVED": {
      const text = cardText(event.cardDefinitionId);
      return {
        eyebrow: "Demon effect",
        title: `${eventPlayerName(view, event.playerId)}から破棄`,
        detail: text.name
      };
    }
    case "DEMON_THEFT_RESOLVED":
      return {
        eyebrow: "Demon effect",
        title: "イタズラマンの効果",
        detail: `${eventPlayerName(view, event.playerId)}から${event.removedCount}個を破棄しました`
      };
    case "RESOURCE_CHANGED": {
      const sign = event.delta > 0 ? "+" : "";
      const reasonLabel =
        event.reason === "DEMON"
          ? "悪魔の効果"
          : event.reason === "GUARDIAN"
            ? "守護神の効果"
            : event.reason === "CALAMITY"
              ? "病の効果"
              : "リソース変化";
      return {
        eyebrow: reasonLabel,
        title: `${eventPlayerName(view, event.playerId)} ${RESOURCE_LABELS[event.resource]} ${sign}${event.delta}`,
        detail: `${RESOURCE_LABELS[event.resource]} ${event.valueAfter}`
      };
    }
    case "PLAYER_ASCENDED":
      return {
        eyebrow: "Ascension",
        title: `${eventPlayerName(view, event.playerId)}が昇天`,
        detail:
          event.reason === "HP_ZERO"
            ? "HP 0・昇天"
            : "降参しました"
      };
    case "GUARDIAN_ASSIGNED":
      return {
        eyebrow: "Guardian",
        title: `${event.guardian.guardianName}が宿りました`,
        detail: eventPlayerName(view, event.playerId)
      };
    case "GUARDIAN_DEPARTED":
      return {
        eyebrow: "Guardian",
        title: `${eventPlayerName(view, event.playerId)}の守護神が離脱`,
        detail: "宿主のHP減少により去りました"
      };
    case "GUARDIAN_CHECKED": {
      const guardian =
        playerById(view, event.playerId)?.guardian?.guardianName ??
        "守護神";
      return {
        eyebrow: "Guardian",
        title: `${eventPlayerName(view, event.playerId)}の${guardian}`,
        detail: event.acted ? "行動します" : "今回は行動しません"
      };
    }
    case "GUARDIAN_ACTION_SELECTED": {
      const text = cardText(event.actionCardDefinitionId);
      const target = event.targetPlayerId
        ? ` → ${eventPlayerName(view, event.targetPlayerId)}`
        : "";
      return {
        eyebrow: "Guardian action",
        title: text.name,
        detail: `${eventPlayerName(view, event.playerId)}${target}`
      };
    }
    case "CALAMITY_APPLIED":
      return {
        eyebrow: "Calamity",
        title: `${eventPlayerName(view, event.playerId)}に${CALAMITY_LABELS[event.calamity]}`,
        detail: "災いが付与されました"
      };
    case "CALAMITY_WORSEN_CHECKED":
      return {
        eyebrow: "Disease",
        title: `${eventPlayerName(view, event.playerId)}の${CALAMITY_LABELS[event.disease]}`,
        detail: event.worsened ? "病が悪化します" : "悪化しませんでした"
      };
    case "CALAMITY_WORSENED":
      return {
        eyebrow: "Disease",
        title: `${CALAMITY_LABELS[event.from]}が悪化`,
        detail: event.to
          ? `${eventPlayerName(view, event.playerId)}は${CALAMITY_LABELS[event.to]}になりました`
          : `${eventPlayerName(view, event.playerId)}のHPが0になりました`
      };
    case "CALAMITIES_REMOVED":
      return {
        eyebrow: "Calamity",
        title: `${eventPlayerName(view, event.playerId)}の災いを解除`,
        detail: event.calamities
          .map((calamity) => CALAMITY_LABELS[calamity])
          .join("、")
      };
    case "PHENOMENON_SELECTED": {
      const text = cardText(event.phenomenonCardDefinitionId);
      return {
        eyebrow: "Phenomenon",
        title: "超常現象",
        detail: text.name
      };
    }
    case "CONFUSION_ACTION_SELECTED": {
      const action =
        event.sourceCardDefinitionId === null
          ? event.actionType
          : cardText(event.sourceCardDefinitionId).name;
      return {
        eyebrow: `Automatic action ${event.round}/3`,
        title: eventPlayerName(view, event.playerId),
        detail: action
      };
    }
    default:
      return null;
  }
}

export function renderPresentationRegion(
  view: GameViewState,
  presentation: PresentationQueueState | null
): string {
  if (!presentation?.activeStep) return "";
  if (
    presentationAttackScene(presentation) ||
    presentationGuardianAction(presentation)
  ) {
    return "";
  }
  const copy = presentationCopy(view, presentation);
  if (!copy) return "";
  const { step } = presentation.activeStep;
  const central =
    step.kind === "DEMON" || step.kind === "DEMON_EFFECT";
  return `
  <aside
    class="gf-presentation"
    data-region="presentation"
    data-presentation-kind="${step.kind}"
    data-event-seq="${step.eventSeq}"
    data-central="${String(central)}"
    role="status"
    aria-live="assertive"
    aria-atomic="true"
  >
    <p class="gf-presentation__eyebrow">${escapeHtml(copy.eyebrow)}</p>
    <strong class="gf-presentation__title">${escapeHtml(copy.title)}</strong>
    <p class="gf-presentation__detail">${escapeHtml(copy.detail)}</p>
  </aside>`;
}

export function renderBattleScreen(
  view: GameViewState,
  ui: UiInteractionState,
  links: BattleScreenLinks = {},
  presentation: PresentationQueueState | null = null,
  nowMs = Date.now()
): string {
  const renderedUi = advanceUiClock(ui, view, nowMs);
  const visiblePresentation = presentation;
  const presentationIsPlaying =
    visiblePresentation?.activeStep !== null &&
    visiblePresentation?.activeStep !== undefined;
  const presentationLockedUi: UiInteractionState =
    renderedUi.mode === "COMPOSING_REACTION" &&
    ["ACTION", "HIT_RESULT"].includes(
      visiblePresentation?.activeStep?.step.kind ?? ""
    )
      ? { ...renderedUi, mode: "WAITING" }
      : renderedUi;
  const displayedUi: UiInteractionState =
    presentationIsPlaying &&
    presentationLockedUi.mode !== "MATCH_RESULT" &&
    !presentationLockedUi.interactionLocked
      ? { ...presentationLockedUi, interactionLocked: true }
      : presentationLockedUi;
  const activePlayer = playerById(view, view.activePlayerId);
  const modeName = view.matchMode === "TRAINING" ? "修行" : "オンライン対戦";
  const displayedEndTimeAt =
    view.endTimeAt ?? (view.matchMode === "TRAINING" ? 75 : null);
  const endTimeLabel =
    displayedEndTimeAt === null
      ? "終末なし"
      : `終末 G.F.${displayedEndTimeAt}`;
  const hand = view.self?.hand ?? [];
  const miracles = view.self?.learnedMiracles ?? [];
  const preview = actionPreview(displayedUi, view);
  const selfPlayer = playerById(view, view.self?.playerId ?? null);
  const viewerRole =
    view.self === null
      ? "SPECTATOR"
      : selfPlayer?.alive === false
        ? "ASCENDED_PLAYER"
        : "PLAYER";
  const hasLocalActionSelection =
    displayedUi.selectedActionCardIds.length > 0 ||
    displayedUi.selectedLearnedMiracleIds.length > 0;
  const highlightedTargetIds = hasLocalActionSelection
    ? displayedUi.selectedTargetIds
    : view.targetPlayerIds;
  const canPray =
    !displayedUi.interactionLocked &&
    displayedUi.mode === "COMPOSING_ACTION" &&
    !hasLocalActionSelection &&
    (view.self?.legalActions.some(({ type }) => type === "PRAY") ?? false);
  const playerMarkup = [...view.players]
    .sort((left, right) => left.seatIndex - right.seatIndex)
    .map((player) =>
      renderPlayer(
        player,
        view,
        preview.targetPlayerIds,
        highlightedTargetIds,
        displayedUi.interactionLocked
      )
    )
    .join("");
  const handMarkup =
    hand.length > 0
      ? hand
          .map((card) => renderCard(card, displayedUi, view))
          .join("")
      : emptyState(view.self ? "手札はありません" : "観戦者には手札は表示されません");
  const miracleMarkup =
    miracles.length > 0
      ? miracles
          .map((miracle) => renderMiracle(miracle, displayedUi, view))
          .join("")
      : emptyState("習得済みの奇跡はありません");

  return `
<main
  class="gf-battle-screen"
  data-player-count="${view.players.length}"
  data-ui-mode="${displayedUi.mode}"
  data-viewer-role="${viewerRole}"
  data-self-controller="${selfPlayer?.controller ?? "SPECTATOR"}"
  data-self-connection="${selfPlayer?.connectionState ?? "SPECTATOR"}"
  data-game-input-disabled="${String(
    displayedUi.mode === "MATCH_RESULT" || displayedUi.interactionLocked
  )}"
  aria-label="GoodField 対戦画面"
>
  <style>${BATTLE_SCREEN_STYLES}</style>
  <header class="gf-header" data-region="header">
    <a
      class="gf-header__link"
      href="${safeHref(links.backHref, "/")}"
      aria-label="対戦画面から戻る"
    >←</a>
    <div class="gf-header__identity">
      <span class="gf-header__mode">${modeName}</span>
      <strong class="gf-header__gf" aria-live="polite">
        G.F.${view.gfCount}${
          displayedEndTimeAt === null
            ? ""
            : ` <span aria-hidden="true">/${displayedEndTimeAt}</span>`
        }
      </strong>
      <span class="gf-header__end-time">${endTimeLabel}</span>
    </div>
    <div class="gf-header__turn">
      <span>手番</span>
      <strong>${escapeHtml(activePlayer?.displayName ?? "なし")}</strong>
    </div>
    <a
      class="gf-header__link"
      href="${safeHref(links.rulebookHref, "/rulebook")}"
      aria-label="教典を開く"
    >▣&nbsp; 教典</a>
  </header>

  ${renderPresentationRegion(view, visiblePresentation)}

  <section
    class="gf-panel gf-players"
    data-region="players"
    aria-labelledby="gf-players-title"
  >
    <div class="gf-section-heading">
      <p class="gf-section-heading__eyebrow">Players</p>
      <h2 id="gf-players-title">プレイヤー</h2>
      <span class="gf-count">${view.players.length}人</span>
    </div>
    <ol class="gf-player-list">${playerMarkup}</ol>
  </section>

  ${renderActionRegion(view, displayedUi, visiblePresentation)}
  ${renderResponseRegion(view, displayedUi)}

  <section
    class="gf-panel gf-miracles"
    data-region="miracles"
    aria-labelledby="gf-miracles-title"
  >
    <div class="gf-section-heading">
      <p class="gf-section-heading__eyebrow">Miracles</p>
      <h2 id="gf-miracles-title">習得済み奇跡</h2>
    </div>
    <ul class="gf-card-list gf-card-list--compact">${miracleMarkup}</ul>
  </section>

  <section
    class="gf-panel gf-hand"
    data-region="hand"
    aria-labelledby="gf-hand-title"
  >
    <div class="gf-section-heading">
      <p class="gf-section-heading__eyebrow">Hand</p>
      <h2 id="gf-hand-title">手札</h2>
      <span class="gf-count">${hand.length}枚</span>
    </div>
    <ul class="gf-card-list">${handMarkup}</ul>
  </section>

  <section
    class="gf-panel gf-controls"
    data-region="controls"
    aria-labelledby="gf-controls-title"
  >
    <div class="gf-section-heading">
      <p class="gf-section-heading__eyebrow">Controls</p>
      <h2 id="gf-controls-title">操作</h2>
    </div>
    <p class="gf-controls__prompt" role="status">
      ${escapeHtml(UI_MODE_LABELS[displayedUi.mode])}
    </p>
    ${renderInputStatus(view, displayedUi, nowMs)}
    ${
      displayedUi.mode === "SPECTATING"
        ? `<p class="gf-controls__observer-note">
            ${
              viewerRole === "ASCENDED_PLAYER"
                ? "昇天後も手札を確認しながら、残りの対戦を観戦できます。"
                : "観戦者として対戦を表示しています。"
            }
          </p>`
        : ""
    }
    <div class="gf-controls__actions" aria-label="ゲーム操作">
      <button
        type="button"
        data-submit-pray
        ${canPray ? "" : "disabled"}
        title="${canPray ? "神器を1枚授与されます" : "使用可能な武器があるか、現在は行動できません"}"
      >祈る</button>
      <button
        type="button"
        data-focus-targets
        ${preview.targetPlayerIds.length > 1 && !displayedUi.interactionLocked ? "" : "disabled"}
      >対象を選ぶ</button>
      <button
        type="button"
        class="gf-controls__submit"
        data-submit-action
        ${preview.canSubmit ? "" : "disabled"}
        ${preview.invalidReason ? `title="${escapeHtml(preview.invalidReason)}"` : ""}
      >行動を確定</button>
    </div>
    ${renderUtilityActions(view, displayedUi)}
    ${
      preview.invalidReason
        ? `<p class="gf-controls__reason" role="status">${escapeHtml(preview.invalidReason)}</p>`
        : ""
    }
  </section>

  <footer class="gf-battle-footer" aria-label="プレイヤーと音量">
    <span class="gf-battle-footer__name">${
      escapeHtml(selfPlayer?.displayName ?? "観戦者")
    }</span>
    <span class="gf-battle-footer__sound" aria-label="音量">
      <span aria-hidden="true">◀</span>
      ${Array.from(
        { length: 10 },
        (_, index) =>
          `<i aria-hidden="true" data-level="${index + 1}"></i>`
      ).join("")}
    </span>
  </footer>

  ${renderResultRegion(view, links)}
</main>`;
}

export type BattleScreenInteractions = {
  createCommandId?: () => string;
  onCommand?: (command: GameCommand) => void;
  onUiStateChange?: (ui: UiInteractionState) => void;
  now?: () => number;
};

export type BattleScreenMount = {
  updateView: (view: GameViewState) => void;
  applyRealtimeMessage: (
    message: RealtimeMatchMessage,
    nowMs?: number
  ) => void;
  rejectCommand: (view: GameViewState) => void;
  tick: (nowMs?: number) => void;
  dispose: () => void;
  getUiState: () => UiInteractionState;
};

let localCommandSequence = 0;

function defaultCommandId(): string {
  localCommandSequence += 1;
  return `ui-command-${Date.now()}-${localCommandSequence}`;
}

export function mountBattleScreen(
  container: HTMLElement,
  view: GameViewState,
  ui: UiInteractionState,
  links: BattleScreenLinks = {},
  interactions: BattleScreenInteractions = {}
): BattleScreenMount {
  let currentView = view;
  let currentUi = ui;
  let presentation: PresentationQueueState = {
    ...createPresentationQueue(),
    latestSnapshot: view
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let renderedDeadlineSeconds: number | null = null;
  let disposed = false;
  const createCommandId = interactions.createCommandId ?? defaultCommandId;
  const now = interactions.now ?? Date.now;
  const update = (next: UiInteractionState): void => {
    if (next === currentUi) return;
    currentUi = next;
    interactions.onUiStateChange?.(currentUi);
    renderAndBind();
  };
  const renderAndBind = (): void => {
    const renderNow = now();
    container.innerHTML = renderBattleScreen(
      currentView,
      currentUi,
      links,
      presentation,
      renderNow
    );
    renderedDeadlineSeconds = inputDeadlineRemainingSeconds(
      currentUi,
      renderNow
    );
    for (const button of container.querySelectorAll<HTMLElement>(
      "[data-select-card]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectCard;
        if (id) update(selectActionCard(currentUi, id, currentView));
      });
    }
    for (const button of container.querySelectorAll<HTMLElement>(
      "[data-select-miracle]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectMiracle;
        if (id) update(selectLearnedMiracle(currentUi, id, currentView));
      });
    }
    for (const button of container.querySelectorAll<HTMLElement>(
      "[data-select-defense-card]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectDefenseCard;
        if (id) update(selectDefenseCard(currentUi, id, currentView));
      });
    }
    for (const button of container.querySelectorAll<HTMLElement>(
      "[data-select-defense-miracle]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectDefenseMiracle;
        if (id) {
          update(selectDefenseMiracle(currentUi, id, currentView));
        }
      });
    }
    for (const button of container.querySelectorAll<HTMLElement>(
      "[data-select-target]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectTarget;
        if (id) update(selectTarget(currentUi, id, currentView));
      });
    }
    container.querySelector("[data-focus-targets]")?.addEventListener(
      "click",
      () => {
        container
          .querySelector<HTMLElement>("[data-select-target]")
          ?.focus();
      }
    );
    container.querySelector("[data-submit-action]")?.addEventListener(
      "click",
      () => {
        const prepared = prepareDeclareActionSubmission(
          currentUi,
          currentView,
          createCommandId
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      }
    );
    container.querySelector("[data-submit-pray]")?.addEventListener(
      "click",
      () => {
        const prepared = preparePraySubmission(
          currentUi,
          currentView,
          createCommandId
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      }
    );
    container.querySelector("[data-submit-reaction]")?.addEventListener(
      "click",
      () => {
        const prepared = prepareReactionSubmission(
          currentUi,
          currentView,
          createCommandId
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      }
    );
    container.querySelector("[data-submit-forgive]")?.addEventListener(
      "click",
      () => {
        const prepared = prepareReactionSubmission(
          currentUi,
          currentView,
          createCommandId,
          true
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      }
    );
    for (const [selector, accept] of [
      ["[data-confirm-buy]", true],
      ["[data-decline-buy]", false]
    ] as const) {
      container.querySelector(selector)?.addEventListener("click", () => {
        const prepared = prepareBuyConfirmation(
          currentUi,
          currentView,
          accept,
          createCommandId
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      });
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      "[data-exchange-adjust]"
    )) {
      button.addEventListener("click", () => {
        const form = button.closest<HTMLFormElement>(
          '[data-utility-form="EXCHANGE_RESOURCES"]'
        );
        const exchange = button.closest<HTMLElement>("[data-exchange-total]");
        if (!form || !exchange) return;
        const [resource, deltaText] = (
          button.dataset.exchangeAdjust ?? ""
        ).split(":");
        if (resource !== "hp" && resource !== "mp") return;
        const delta = Number(deltaText);
        const total = Number(exchange.dataset.exchangeTotal);
        const hpInput = form.querySelector<HTMLInputElement>(
          'input[name="hp"]'
        );
        const mpInput = form.querySelector<HTMLInputElement>(
          'input[name="mp"]'
        );
        const moneyInput = form.querySelector<HTMLInputElement>(
          'input[name="money"]'
        );
        if (
          !hpInput ||
          !mpInput ||
          !moneyInput ||
          !Number.isInteger(delta) ||
          !Number.isInteger(total)
        ) {
          return;
        }
        const hp = Number(hpInput.value);
        const mp = Number(mpInput.value);
        const nextHp = resource === "hp" ? hp + delta : hp;
        const nextMp = resource === "mp" ? mp + delta : mp;
        const nextMoney = total - nextHp - nextMp;
        if (
          [nextHp, nextMp, nextMoney].some(
            (value) =>
              !Number.isInteger(value) || value < 0 || value > 99
          )
        ) {
          return;
        }
        hpInput.value = String(nextHp);
        mpInput.value = String(nextMp);
        moneyInput.value = String(nextMoney);
        for (const [name, value] of [
          ["hp", nextHp],
          ["mp", nextMp],
          ["money", nextMoney]
        ] as const) {
          const output = form.querySelector<HTMLOutputElement>(
            `[data-exchange-output="${name}"]`
          );
          if (output) output.value = String(value);
        }
      });
    }
    for (const form of container.querySelectorAll<HTMLFormElement>(
      "[data-utility-form]"
    )) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (
          currentUi.interactionLocked ||
          currentUi.mode !== "COMPOSING_ACTION" ||
          currentUi.inputDeadlineExpired ||
          !currentView.self
        ) {
          return;
        }
        const type = form.dataset.utilityForm;
        const action = currentView.self.legalActions.find(
          (candidate) => candidate.type === type
        );
        if (!action) return;
        const values = new FormData(form);
        const cardInstanceId = String(
          values.get("cardInstanceId") ?? ""
        );
        const targetPlayerId = String(
          values.get("targetPlayerId") ?? ""
        );
        const productCardInstanceId = String(
          values.get("productCardInstanceId") ?? ""
        );
        const commandId =
          currentUi.awaitingCommandId ?? createCommandId();
        const base = {
          matchId: currentView.matchId,
          commandId,
          actorId: currentView.self.playerId,
          expectedRevision: currentView.revision
        };
        let command: GameCommand | null = null;
        switch (action.type) {
          case "DISCARD":
          case "SACRIFICE":
            if (action.cardInstanceIds.includes(cardInstanceId)) {
              command = { ...base, type: action.type, cardInstanceId };
            }
            break;
          case "EXCHANGE_RESOURCES": {
            const hp = Number(values.get("hp"));
            const mp = Number(values.get("mp"));
            const money = Number(values.get("money"));
            if (
              action.cardInstanceIds.includes(cardInstanceId) &&
              [hp, mp, money].every(
                (value) =>
                  Number.isInteger(value) && value >= 0 && value <= 99
              ) &&
              hp + mp + money === action.resourceTotal
            ) {
              command = {
                ...base,
                type: "EXCHANGE_RESOURCES",
                cardInstanceId,
                hp,
                mp,
                money
              };
            }
            break;
          }
          case "SELL_CARD":
            if (
              action.cardInstanceIds.includes(cardInstanceId) &&
              action.productCardInstanceIds.includes(
                productCardInstanceId
              ) &&
              action.targetPlayerIds.includes(targetPlayerId)
            ) {
              command = {
                ...base,
                type: "SELL_CARD",
                cardInstanceId,
                productCardInstanceId,
                targetPlayerId
              };
            }
            break;
          case "DECLARE_BUY":
            if (
              action.cardInstanceIds.includes(cardInstanceId) &&
              action.targetPlayerIds.includes(targetPlayerId)
            ) {
              command = {
                ...base,
                type: "DECLARE_BUY",
                cardInstanceId,
                targetPlayerId
              };
            }
            break;
          case "SURRENDER":
            command = { ...base, type: "SURRENDER" };
            break;
          default:
            break;
        }
        if (!command) return;
        update(lockForCommand(currentUi, commandId));
        interactions.onCommand?.(command);
      });
    }
  };

  const stopDeadlineTimer = (): void => {
    if (deadlineTimer === null) return;
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  };
  const shouldTickDeadline = (): boolean => {
    const selfPlayer = playerById(
      currentView,
      currentView.self?.playerId ?? null
    );
    return (
      !disposed &&
      (
        presentation.activeStep !== null ||
        presentation.pendingSteps.length > 0 ||
        (
          currentUi.inputDeadlineAt !== null &&
          !currentUi.inputDeadlineExpired &&
          isHumanInputMode(currentUi.mode) &&
          selfPlayer?.controller === "HUMAN"
        )
      )
    );
  };
  const scheduleDeadlineTick = (): void => {
    stopDeadlineTimer();
    if (!shouldTickDeadline()) return;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      tick();
    }, 250);
  };
  const tick = (nowMs = now()): void => {
    if (disposed) return;
    const nextPresentation = advancePresentationClock(
      presentation,
      nowMs
    );
    const presentationChanged = nextPresentation !== presentation;
    presentation = nextPresentation;
    const next = advanceUiClock(currentUi, currentView, nowMs);
    if (next !== currentUi) {
      update(next);
    } else {
      const nextSeconds = inputDeadlineRemainingSeconds(currentUi, nowMs);
      if (
        presentationChanged ||
        renderedDeadlineSeconds !== nextSeconds
      ) {
        renderAndBind();
      }
    }
    scheduleDeadlineTick();
  };

  renderAndBind();
  scheduleDeadlineTick();
  return {
    updateView(nextView) {
      if (disposed) return;
      currentView = nextView;
      const nextUi = synchronizeUiState(currentUi, currentView);
      if (nextUi === currentUi) {
        renderAndBind();
      } else {
        update(nextUi);
      }
      scheduleDeadlineTick();
    },
    applyRealtimeMessage(message, nowMs = now()) {
      if (disposed || message.type === "SYNC_ERROR") return;
      presentation = applyRealtimePresentationMessage(
        presentation,
        message,
        nowMs
      );
      currentView = message.snapshot;
      const nextUi = synchronizeUiState(currentUi, currentView);
      if (nextUi === currentUi) {
        renderAndBind();
      } else {
        update(nextUi);
      }
      scheduleDeadlineTick();
    },
    rejectCommand(nextView) {
      if (disposed) return;
      currentView = nextView;
      update(releaseCommandLock(currentUi, currentView));
      scheduleDeadlineTick();
    },
    tick,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopDeadlineTimer();
    },
    getUiState() {
      return currentUi;
    }
  };
}

export const BATTLE_SCREEN_STYLES = `
:where(.gf-battle-screen, .gf-battle-screen *) {
  box-sizing: border-box;
}

.gf-battle-screen {
  --gf-bg: #78d9cf;
  --gf-panel: #eeffee;
  --gf-panel-strong: #dff5e8;
  --gf-line: #087b97;
  --gf-text: #063b3b;
  --gf-muted: #527d79;
  --gf-accent: #d6bc62;
  --gf-active: #008f6f;
  --gf-acting: #d6a53c;
  --gf-target: #dd6699;
  inline-size: 1080px;
  min-block-size: 720px;
  margin-inline: auto;
  padding: 30px 10px;
  display: grid;
  grid-template-columns: minmax(15rem, 0.8fr) minmax(20rem, 1.35fr) minmax(16rem, 0.85fr);
  grid-template-areas:
    "header header header"
    "players action miracles"
    "players response miracles"
    "players controls hand"
    "result result result";
  grid-template-rows: auto auto auto minmax(14rem, 1fr) auto;
  gap: 0.65rem;
  color: var(--gf-text);
  background:
    linear-gradient(rgb(238 255 238 / 22%), rgb(238 255 238 / 22%)),
    url("/images/goodfield-home.png") center / cover fixed,
    var(--gf-bg);
  font-family: Meiryo, "Yu Gothic", "Noto Sans JP", system-ui, sans-serif;
  line-height: 1.5;
}

.gf-header {
  grid-area: header;
  min-block-size: 30px;
  margin: -30px -10px 0;
  padding: 3px 10px;
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: 1rem;
  border: 0;
  border-radius: 0;
  color: #eeffee;
  background: #008f6f;
  box-shadow: none;
}

.gf-header__link,
.gf-primary-link {
  min-block-size: 24px;
  padding: 0 0.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  color: #008f6f;
  background: #eeffee;
  font-weight: 750;
  text-decoration: none;
}

.gf-header__identity {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.gf-header__mode,
.gf-header__end-time,
.gf-header__turn span {
  color: #eeffee;
  font-size: 0.82rem;
}

.gf-header__gf {
  color: #eeffee;
  font-size: 1.1rem;
  letter-spacing: 0.04em;
}

.gf-header__turn {
  display: grid;
  text-align: end;
}

.gf-presentation {
  position: fixed;
  z-index: 20;
  inset: 50% auto auto 50%;
  inline-size: min(32rem, calc(100vw - 2rem));
  padding: 1.25rem 1.5rem;
  border: 4px solid var(--gf-line);
  border-radius: 22px;
  color: var(--gf-text);
  background: rgb(238 255 238 / 97%);
  box-shadow:
    0 1.5rem 4rem rgb(0 80 65 / 30%),
    inset 0 0 2rem rgb(0 143 111 / 7%);
  text-align: center;
  transform: translate(-50%, -50%);
}

.gf-presentation[data-central="true"] {
  border-color: rgb(248 113 113 / 80%);
  box-shadow:
    0 1.5rem 5rem rgb(0 0 0 / 58%),
    inset 0 0 2.5rem rgb(248 113 113 / 14%);
}

.gf-presentation__eyebrow {
  margin: 0 0 0.4rem;
  color: var(--gf-accent);
  font-size: 0.72rem;
  font-weight: 850;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.gf-presentation__title {
  display: block;
  color: #006f8f;
  font-size: clamp(1.25rem, 5vw, 2rem);
}

.gf-presentation__detail {
  margin: 0.5rem 0 0;
  color: var(--gf-muted);
}

.gf-panel {
  min-inline-size: 0;
  padding: 0.75rem;
  border: 3px solid var(--gf-line);
  border-radius: 20px;
  background: rgb(238 255 238 / 94%);
  box-shadow: 0 0.6rem 1.5rem rgb(0 91 76 / 13%);
}

.gf-players { grid-area: players; }
.gf-action { grid-area: action; }
.gf-response { grid-area: response; }
.gf-miracles { grid-area: miracles; }
.gf-hand { grid-area: hand; }
.gf-controls { grid-area: controls; }

.gf-section-heading {
  margin-block-end: 0.8rem;
  display: flex;
  align-items: end;
  gap: 0.6rem;
}

.gf-section-heading h2 {
  margin: 0;
  font-size: 1rem;
}

.gf-section-heading__eyebrow {
  margin: 0;
  color: var(--gf-accent);
  font-size: 0.68rem;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.gf-count {
  margin-inline-start: auto;
  color: var(--gf-muted);
  font-size: 0.78rem;
}

.gf-player-list,
.gf-card-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.gf-player-list {
  max-block-size: calc(100vh - 8rem);
  display: grid;
  gap: 0.65rem;
  overflow: auto;
  scrollbar-gutter: stable;
}

.gf-player {
  padding: 0.8rem;
  border: 1px solid var(--gf-line);
  border-inline-start: 0.3rem solid transparent;
  border-radius: 0.75rem;
  background: rgb(248 255 245 / 92%);
}

.gf-player[data-active="true"] {
  border-inline-start-color: var(--gf-active);
}

.gf-player[data-acting="true"] {
  box-shadow: inset 0 0 0 2px var(--gf-acting);
}

.gf-player[data-targeted="true"] {
  border-color: var(--gf-target);
}

.gf-player[data-alive="false"] {
  filter: grayscale(0.82);
  opacity: 0.66;
}

.gf-player__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
}

.gf-player__seat {
  inline-size: 1.6rem;
  block-size: 1.6rem;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #063b3b;
  background: var(--gf-accent);
  font-size: 0.74rem;
  font-weight: 900;
}

.gf-player__name {
  margin: 0;
  overflow: hidden;
  font-size: 0.98rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gf-player__state {
  color: var(--gf-muted);
  font-size: 0.72rem;
  font-weight: 800;
}

.gf-player__markers {
  margin-block-start: 0.45rem;
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.gf-player-marker {
  padding: 0.08rem 0.4rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 0.65rem;
  font-weight: 850;
}

.gf-player-marker--active {
  color: var(--gf-active);
}

.gf-player-marker--acting {
  color: var(--gf-acting);
}

.gf-player-marker--targeted {
  color: var(--gf-target);
}

.gf-player-marker--ascended {
  color: var(--gf-muted);
}

.gf-resources {
  margin: 0.65rem 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.35rem;
}

.gf-resources div {
  padding: 0.35rem;
  border-radius: 0.45rem;
  border: 1px solid rgb(8 123 151 / 25%);
  background: #e3f5e8;
  text-align: center;
}

.gf-resources dt {
  color: var(--gf-muted);
  font-size: 0.65rem;
}

.gf-resources dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 850;
}

.gf-player__statuses {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.gf-status-pill {
  padding: 0.12rem 0.42rem;
  border: 1px solid #a87834;
  border-radius: 999px;
  color: #845c22;
  font-size: 0.67rem;
}

.gf-status-pill--neutral {
  border-color: var(--gf-line);
  color: var(--gf-muted);
}

.gf-player__counts {
  margin: 0.55rem 0 0;
  color: var(--gf-muted);
  font-size: 0.72rem;
}

.gf-player__target-control {
  inline-size: 100%;
  min-block-size: 2.35rem;
  margin-block-start: 0.6rem;
  border: 1px solid var(--gf-target);
  border-radius: 0.5rem;
  color: #9f285c;
  background: rgb(255 238 246 / 92%);
  font: inherit;
  font-size: 0.75rem;
  font-weight: 800;
}

.gf-player__target-control[aria-pressed="true"] {
  color: #211411;
  background: var(--gf-target);
}

.gf-action__direction {
  margin: 0 0 0.75rem;
  color: var(--gf-active);
  font-size: 1.05rem;
  font-weight: 800;
}

.gf-action__progress {
  margin: -0.4rem 0 0.75rem;
  color: var(--gf-target);
  font-size: 0.78rem;
  font-weight: 800;
}

.gf-action__activity {
  margin: -0.4rem 0 0.75rem;
  color: var(--gf-muted);
  font-size: 0.78rem;
  font-weight: 800;
}

.gf-action__content,
.gf-response__content {
  min-block-size: 3rem;
  padding: 0.7rem;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  border: 1px dashed var(--gf-line);
  border-radius: 0.7rem;
  background: rgb(248 255 245 / 88%);
}

.gf-action-token {
  padding: 0.3rem 0.55rem;
  border-radius: 0.5rem;
  color: #54431a;
  background: #ffeaa8;
  font-weight: 800;
}

.gf-action__summary {
  margin: 0.7rem 0 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
}

.gf-action__summary div {
  padding: 0.45rem;
  border-radius: 0.5rem;
  background: var(--gf-panel);
  text-align: center;
}

.gf-action__summary dt {
  color: var(--gf-muted);
  font-size: 0.67rem;
}

.gf-action__summary dd {
  margin: 0;
  font-weight: 850;
}

.gf-response__forgive {
  color: var(--gf-target);
  font-weight: 850;
}

.gf-response__subject,
.gf-trade-offer__payment {
  inline-size: 100%;
  margin: 0;
  color: var(--gf-muted);
  font-size: 0.78rem;
}

.gf-response__selection,
.gf-response__actions {
  inline-size: 100%;
  display: flex;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.gf-response__summary {
  inline-size: 100%;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(4rem, 1fr));
  gap: 0.4rem;
}

.gf-response__summary div {
  padding: 0.4rem;
  border-radius: 0.45rem;
  background: var(--gf-panel);
  text-align: center;
}

.gf-response__summary dt {
  color: var(--gf-muted);
  font-size: 0.65rem;
}

.gf-response__summary dd {
  margin: 0;
  font-weight: 850;
}

.gf-response__actions button {
  min-block-size: 2.5rem;
  flex: 1 1 7rem;
  border: 1px solid var(--gf-line);
  border-radius: 0.55rem;
  color: #006f8f;
  background: var(--gf-panel-strong);
  font: inherit;
  font-weight: 800;
}

.gf-response__actions button:not(:disabled) {
  cursor: pointer;
}

.gf-response__actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.gf-trade-offer {
  inline-size: 100%;
  display: grid;
  gap: 0.55rem;
}

.gf-trade-offer__name {
  color: var(--gf-accent);
  font-size: 1.05rem;
}

.gf-trade-offer__effect {
  margin: 0;
  font-size: 0.78rem;
}

.gf-card-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
  gap: 0.55rem;
  overflow: auto;
}

.gf-hand .gf-card-list {
  max-block-size: min(36vh, 22rem);
}

.gf-card-list--compact {
  max-block-size: min(48vh, 28rem);
}

.gf-card {
  min-block-size: 5.25rem;
  padding: 0;
  border: 1px solid var(--gf-line);
  border-radius: 0.65rem;
  background: rgb(255 252 224 / 96%);
}

.gf-card__button {
  inline-size: 100%;
  min-block-size: 5.25rem;
  padding: 0.65rem;
  display: grid;
  align-content: start;
  border: 0;
  border-radius: inherit;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: start;
}

.gf-card__button:not(:disabled) {
  cursor: pointer;
}

.gf-card__button:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.gf-card[data-selected="true"] {
  border-color: #d6a53c;
  box-shadow:
    inset 0 0 0 2px #fff8c9,
    0 0 0 2px #d6a53c;
}

.gf-card--miracle {
  background: rgb(245 238 255 / 96%);
}

.gf-card__name {
  font-size: 0.8rem;
  font-weight: 850;
}

.gf-card__effect {
  margin-block-start: 0.35rem;
  color: var(--gf-muted);
  font-size: 0.7rem;
}

.gf-card__reason,
.gf-controls__reason {
  margin-block-start: 0.4rem;
  color: #ffb0a8;
  font-size: 0.68rem;
}

.gf-empty,
.gf-empty-inline {
  color: var(--gf-muted);
  font-size: 0.78rem;
}

.gf-controls__prompt {
  margin: 0 0 0.75rem;
  font-weight: 750;
}

.gf-input-status {
  margin: -0.25rem 0 0.75rem;
  padding: 0.55rem 0.7rem;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.6rem;
  border: 1px solid var(--gf-line);
  border-radius: 0.6rem;
  background: rgb(248 255 245 / 92%);
  font-size: 0.78rem;
}

.gf-input-status time {
  justify-self: end;
  color: var(--gf-accent);
  font-variant-numeric: tabular-nums;
  font-weight: 850;
}

.gf-input-status small {
  grid-column: 1 / -1;
  color: var(--gf-muted);
}

.gf-input-status--warning {
  border-color: var(--gf-target);
  color: #ffd9d5;
}

.gf-input-status--cpu {
  border-color: var(--gf-acting);
  color: var(--gf-accent);
}

.gf-controls__observer-note {
  margin: -0.35rem 0 0.75rem;
  color: var(--gf-muted);
  font-size: 0.78rem;
}

.gf-controls__actions {
  display: flex;
  gap: 0.55rem;
  flex-wrap: wrap;
}

.gf-utility-actions {
  margin-block-start: 0.75rem;
  border-block-start: 1px solid var(--gf-line);
  padding-block-start: 0.75rem;
}

.gf-utility-actions summary {
  cursor: pointer;
  color: var(--gf-accent);
  font-weight: 700;
}

.gf-utility-action {
  display: grid;
  gap: 0.55rem;
  margin-block-start: 0.75rem;
  border: 1px solid var(--gf-line);
  border-radius: 0.55rem;
  padding: 0.7rem;
}

.gf-utility-action label {
  display: grid;
  gap: 0.3rem;
  color: var(--gf-muted);
  font-size: 0.85rem;
}

.gf-utility-action select,
.gf-utility-action input {
  min-inline-size: 0;
  border: 1px solid var(--gf-line);
  border-radius: 0.4rem;
  padding: 0.45rem;
  color: #006f8f;
  background: var(--gf-panel-strong);
}

.gf-utility-action__resources {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.45rem;
}

.gf-utility-action__danger {
  border-color: var(--gf-target);
  color: #ffd8d3;
}

.gf-controls button {
  min-block-size: 2.75rem;
  padding: 0.65rem 0.9rem;
  border: 1px solid var(--gf-line);
  border-radius: 0.65rem;
  color: #006f8f;
  background: var(--gf-panel-strong);
  font: inherit;
  font-weight: 750;
}

.gf-controls button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.gf-controls__submit:not(:disabled) {
  border-color: #d2b76e;
  color: #445;
  background: #ffeab0;
}

.gf-result {
  position: fixed;
  z-index: 30;
  inset: 50% auto auto 50%;
  max-inline-size: 32rem;
  inline-size: min(32rem, calc(100vw - 2rem));
  padding: clamp(1.5rem, 4vw, 2.5rem);
  border: 4px solid var(--gf-line);
  border-radius: 24px;
  color: var(--gf-text);
  background: rgb(238 255 238 / 98%);
  text-align: center;
  box-shadow:
    0 0 0 100vmax rgb(0 0 0 / 62%),
    0 1.5rem 4rem rgb(0 0 0 / 56%);
  transform: translate(-50%, -50%);
}

.gf-result h2 {
  margin: 0.25rem 0;
  font-size: clamp(2rem, 8vw, 3.5rem);
}

.gf-result__description {
  margin: 1rem 0 0;
}

.gf-result__winner-label,
.gf-result__winner {
  display: block;
}

.gf-result__winner-label {
  color: var(--gf-muted);
  font-size: 0.8rem;
}

.gf-result__winner {
  margin-block-start: 0.2rem;
  color: var(--gf-accent);
  font-size: clamp(1.25rem, 5vw, 2rem);
}

.gf-primary-link {
  margin-block-start: 0.75rem;
  border: 3px solid #d2b76e;
  color: #445;
  background: #ffeab0;
}

.gf-header__link:hover,
.gf-primary-link:hover {
  border-color: var(--gf-accent);
}

.gf-header__link:focus-visible,
.gf-primary-link:focus-visible,
.gf-controls button:focus-visible,
.gf-card__button:focus-visible,
.gf-player__target-control:focus-visible {
  outline: 0.2rem solid #ffffff;
  outline-offset: 0.2rem;
}

@media (max-width: 64rem) {
  .gf-battle-screen {
    grid-template-columns: minmax(14rem, 0.85fr) minmax(20rem, 1.4fr);
    grid-template-areas:
      "header header"
      "players action"
      "players response"
      "miracles hand"
      "controls controls"
      "result result";
    grid-template-rows: auto;
  }

  .gf-player-list {
    max-block-size: 40rem;
  }
}

@media (max-width: 44rem) {
  .gf-battle-screen {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "header"
      "players"
      "action"
      "response"
      "miracles"
      "hand"
      "controls"
      "result";
  }

  .gf-header {
    grid-template-columns: 1fr auto;
  }

  .gf-header__identity {
    grid-column: 1 / -1;
    grid-row: 1;
    order: -1;
  }

  .gf-header__turn {
    display: none;
  }

  .gf-player-list {
    max-block-size: none;
    grid-auto-columns: minmax(14rem, 78vw);
    grid-auto-flow: column;
    grid-template-columns: none;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scroll-snap-type: inline proximity;
  }

  .gf-player-list__item {
    scroll-snap-align: start;
  }

  .gf-card-list {
    grid-auto-columns: minmax(8.5rem, 42vw);
    grid-auto-flow: column;
    grid-template-columns: none;
    overflow-x: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gf-battle-screen {
    scroll-behavior: auto;
  }
}

/* Observed four-player training board, 1080 × 720 reference layout. */
.gf-battle-screen {
  --gf-bg: #78d9cf;
  --gf-panel: #eeffee;
  --gf-panel-strong: #ddffcc;
  --gf-line: #008f6f;
  --gf-text: #4f4f4f;
  --gf-muted: #668888;
  --gf-accent: #dd7799;
  position: relative;
  isolation: isolate;
  container-type: inline-size;
  inline-size: 1080px;
  min-block-size: 0;
  aspect-ratio: 3 / 2;
  margin-inline: auto;
  padding: 0;
  display: block;
  overflow: hidden;
  color: var(--gf-text);
  background:
    linear-gradient(rgb(102 224 214 / 38%), rgb(73 198 181 / 44%)),
    url("/images/goodfield-home.png") center / cover no-repeat,
    #73d7cc;
  background-blend-mode: color, normal, normal;
  font-family: Meiryo, "Yu Gothic", "Noto Sans JP", system-ui, sans-serif;
  line-height: 1.2;
  box-shadow: 0 0 0 1px rgb(0 91 76 / 20%);
}

.gf-battle-screen::before {
  position: absolute;
  z-index: -1;
  inset: 4.1667% 0;
  background:
    radial-gradient(circle at 48% 36%, rgb(238 255 238 / 28%), transparent 31%),
    linear-gradient(100deg, rgb(30 168 145 / 12%), rgb(238 255 238 / 8%));
  content: "";
  pointer-events: none;
}

.gf-header {
  position: absolute;
  z-index: 20;
  inset: 0 0 auto;
  block-size: 4.1667%;
  min-block-size: 0;
  margin: 0;
  padding: 0;
  display: block;
  border: 0;
  border-radius: 0;
  color: #eeffee;
  background: #008f6f;
  box-shadow: none;
}

.gf-header__link {
  position: absolute;
  top: 10%;
  inline-size: 9.2593%;
  block-size: 80%;
  min-block-size: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  color: #008f6f;
  background: #eeffee;
  font-size: clamp(13px, 2.7778cqi, 30px);
  font-weight: 400;
  line-height: 1;
}

.gf-header__link:first-child {
  left: 0.9259%;
}

.gf-header__link:last-child {
  right: 0.9259%;
  inline-size: 16.6667%;
  font-size: clamp(11px, 1.8519cqi, 20px);
}

.gf-header__identity {
  position: absolute;
  inset: 0;
  display: block;
}

.gf-header__mode {
  position: absolute;
  top: 10%;
  left: 12.037%;
  inline-size: 30.5556%;
  block-size: 80%;
  color: #eeffee;
  font-size: clamp(11px, 2.037cqi, 22px);
  font-weight: 700;
  line-height: 1.1;
}

.gf-header__gf {
  position: absolute;
  top: 3.3333%;
  left: 42.5926%;
  inline-size: 14.8148%;
  block-size: 93.3333%;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: #cc6644;
  background: #eeffee;
  font-size: clamp(11px, 1.8519cqi, 20px);
  font-weight: 800;
  letter-spacing: 0.03em;
  line-height: 1;
}

.gf-header__gf span {
  color: #dd7799;
}

.gf-header__end-time {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.gf-header__turn {
  display: none;
}

.gf-panel {
  min-inline-size: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.gf-section-heading {
  margin: 0;
}

.gf-players {
  position: absolute;
  z-index: 5;
  top: 9.7222%;
  left: 62.963%;
  inline-size: 31.4815%;
  block-size: 44.4444%;
}

.gf-players > .gf-section-heading {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.gf-player-list {
  max-block-size: none;
  block-size: 100%;
  display: grid;
  grid-template-rows: repeat(var(--gf-player-count, 4), minmax(0, 1fr));
  gap: 5.5556%;
  overflow: visible;
  scrollbar-gutter: auto;
}

.gf-battle-screen[data-player-count="2"] .gf-player-list {
  --gf-player-count: 2;
  grid-template-rows: repeat(2, 12.5%);
  gap: 25%;
}

.gf-battle-screen[data-player-count="3"] .gf-player-list {
  --gf-player-count: 3;
  grid-template-rows: repeat(3, 12.5%);
  gap: 12.5%;
}

.gf-battle-screen[data-player-count="4"] .gf-player-list {
  --gf-player-count: 4;
  grid-template-rows: repeat(4, 12.5%);
  gap: 12.5%;
}

.gf-battle-screen[data-player-count="5"] .gf-player-list {
  --gf-player-count: 5;
}

.gf-battle-screen[data-player-count="6"] .gf-player-list {
  --gf-player-count: 6;
}

.gf-battle-screen[data-player-count="7"] .gf-player-list {
  --gf-player-count: 7;
  gap: 2%;
}

.gf-battle-screen[data-player-count="8"] .gf-player-list {
  --gf-player-count: 8;
  gap: 1%;
}

.gf-battle-screen[data-player-count="9"] .gf-player-list {
  --gf-player-count: 9;
  gap: 0.75%;
}

.gf-player-list__item {
  min-block-size: 0;
}

.gf-player {
  position: relative;
  block-size: 100%;
  min-block-size: 0;
  padding: 0 1.4706% 0 8.8235%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 50%;
  align-items: center;
  border: 1px solid #aaaaaa;
  border-inline-start: 1px solid #aaaaaa;
  border-radius: 999px 0 0 999px;
  color: var(--gf-text);
  background: #eeeeee;
  box-shadow: none;
}

.gf-player[data-active="true"] {
  border-inline-start-color: #aaaaaa;
  box-shadow: inset 4px 0 0 #ffbb00;
}

.gf-player[data-acting="true"] {
  box-shadow: inset 4px 0 0 #ffbb00;
}

.gf-player[data-targeted="true"] {
  border-color: #dd7799;
  box-shadow:
    inset 4px 0 0 #dd7799,
    0 0 0 2px rgb(255 238 246 / 72%);
}

.gf-player[data-alive="false"] {
  filter: grayscale(0.9);
  opacity: 0.58;
}

.gf-player__header {
  min-inline-size: 0;
  display: block;
}

.gf-player__seat {
  position: absolute;
  top: 25%;
  left: 2.0588%;
  inline-size: 5.8824%;
  aspect-ratio: 1;
  display: block;
  overflow: hidden;
  border-radius: 50%;
  color: transparent;
  background: #aaaaaa;
  font-size: 0;
}

.gf-player[data-active="true"] .gf-player__seat,
.gf-player[data-acting="true"] .gf-player__seat {
  background: #ffbb00;
}

.gf-player[data-targeted="true"] .gf-player__seat {
  background: #dd7799;
}

.gf-player[data-guardian="true"] .gf-player__seat {
  background: #d6bc62;
  box-shadow:
    0 0 0 2px #eeffee,
    0 0 0 4px #aa8800;
}

.gf-player[data-guardian="true"] .gf-player__seat::after {
  position: absolute;
  inset: 50% auto auto 50%;
  color: #997700;
  content: "♜";
  font-size: clamp(10px, 1.6667cqi, 18px);
  line-height: 1;
  transform: translate(-50%, -50%);
}

.gf-player__name {
  margin: 0;
  overflow: hidden;
  color: #4444dd;
  font-size: clamp(10px, 2.3148cqi, 25px);
  font-weight: 700;
  line-height: 1;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gf-player[data-self="true"] .gf-player__name {
  color: #008f6f;
  font-size: clamp(9px, 1.7593cqi, 19px);
}

.gf-player__state,
.gf-player__markers,
.gf-player__statuses,
.gf-player__counts {
  display: none;
}

.gf-resources {
  min-inline-size: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2%;
}

.gf-resources div {
  min-inline-size: 0;
  padding: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: right;
}

.gf-resources dt {
  color: #668888;
  font-size: clamp(7px, 1.2963cqi, 14px);
  font-weight: 700;
}

.gf-resources dd {
  min-inline-size: 0;
  margin: 0;
  color: #4f4f4f;
  font-size: clamp(9px, 1.8519cqi, 20px);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  text-align: right;
}

.gf-resources div:last-child {
  grid-template-columns: 1fr;
}

.gf-resources div:last-child dt {
  display: none;
}

.gf-player__target-control {
  position: absolute;
  z-index: 2;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  min-block-size: 0;
  margin: 0;
  border: 0;
  border-radius: inherit;
  opacity: 0;
  cursor: pointer;
}

.gf-action {
  position: absolute;
  z-index: 4;
  top: 6.25%;
  left: 2.7778%;
  inline-size: 59.2593%;
  block-size: 55.5556%;
}

.gf-action > .gf-section-heading {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.gf-action__route {
  position: absolute;
  top: 0;
  left: 0;
  inline-size: 620px;
  block-size: 7.5%;
  display: grid;
  grid-template-columns: 280px 60px 280px;
  align-items: start;
}

.gf-action[data-has-route="false"] .gf-action__route {
  visibility: hidden;
}

.gf-action__actor,
.gf-action__target {
  min-inline-size: 0;
  min-block-size: 0;
  block-size: 30px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid #aaaaaa;
  border-radius: 999px;
  color: #4444dd;
  background: #eeeeee;
  font-size: clamp(10px, 1.8519cqi, 20px);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gf-action__target {
  color: #008f6f;
}

.gf-action__actor::before,
.gf-action__target::before {
  position: absolute;
  margin-inline-start: -24.5%;
  inline-size: 2.7778cqi;
  max-inline-size: 20px;
  aspect-ratio: 1;
  border-radius: 50%;
  background: #aaaaaa;
  content: "";
}

.gf-action__arrow {
  block-size: 60px;
  display: grid;
  place-items: center;
  color: #ff66aa;
  font-size: clamp(20px, 4.6296cqi, 50px);
  font-weight: 900;
  line-height: 1;
  text-align: center;
  transform: translateY(-15px);
}

.gf-action__progress {
  position: absolute;
  top: 9%;
  right: 0;
  margin: 0;
  color: #dd6699;
  font-size: clamp(8px, 1.2963cqi, 14px);
  font-weight: 800;
}

.gf-action__activity {
  position: absolute;
  top: 8%;
  left: 0;
  margin: 0;
  color: #668888;
  font-size: clamp(7px, 1.1111cqi, 12px);
  font-weight: 700;
  line-height: 1;
}

.gf-action__content {
  position: absolute;
  top: 11.25%;
  left: -1.5625%;
  inline-size: 100%;
  block-size: 72.5%;
  min-block-size: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, 46.875%);
  grid-template-rows: 100%;
  gap: 6.25%;
  align-items: start;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.gf-action__content > .gf-empty-inline {
  display: none;
}

.gf-action__stack > .gf-empty-inline {
  display: none;
}

.gf-action__stack {
  min-inline-size: 0;
  min-block-size: 0;
  display: grid;
  grid-auto-flow: row;
  grid-auto-columns: auto;
  grid-auto-rows: 90px;
  gap: 10px;
  align-content: start;
  overflow: hidden;
}

.gf-action__stack .gf-field-card {
  block-size: 90px;
  aspect-ratio: 10 / 3;
}

.gf-action__stack--defense:empty {
  visibility: hidden;
}

.gf-action__forgive {
  inline-size: 100%;
  min-block-size: 90px;
  display: grid;
  place-content: center;
  border: 5px solid #55bb99;
  border-radius: 6px;
  color: #009966;
  background: #eeffee;
  font-size: clamp(24px, 4.4444cqi, 48px);
}

.gf-action__result,
.gf-action__effect {
  position: absolute;
  z-index: 8;
  top: 48%;
  left: 75%;
  inline-size: 43.75%;
  min-block-size: 0;
  block-size: 51.7241%;
  padding: 3%;
  display: grid;
  place-content: center;
  border: 5px solid #4f4f4f;
  border-radius: 20px;
  color: #990000;
  background: #555555;
  box-shadow: 0 8px 18px rgb(0 0 0 / 18%);
  text-align: center;
  transform: translate(-50%, -50%);
}

.gf-action__result strong,
.gf-action__effect strong {
  display: block;
  font-size: clamp(34px, 8.3333cqi, 90px);
  line-height: 0.8;
  text-shadow:
    -1px -1px 0 #eeffee,
    1px -1px 0 #eeffee,
    -1px 1px 0 #eeffee,
    1px 1px 0 #eeffee;
}

.gf-action__result span,
.gf-action__effect span {
  display: block;
  margin-block-start: 6%;
  color: #bb0000;
  font-size: clamp(12px, 2.5926cqi, 28px);
  font-weight: 800;
  line-height: 1;
  text-shadow:
    -1px -1px 0 #eeffee,
    1px -1px 0 #eeffee,
    -1px 1px 0 #eeffee,
    1px 1px 0 #eeffee;
}

.gf-action__effect {
  border-color: #8b5cf6;
  color: #6d28d9;
  background: #f5f3ff;
}

.gf-action__effect strong {
  font-size: clamp(24px, 5.5556cqi, 60px);
  line-height: 1;
  text-shadow: none;
}

.gf-action__effect span {
  color: #6d28d9;
  text-shadow: none;
}

.gf-action__result[data-result="safe"] {
  border-color: #009900;
  color: #009900;
  background: #eeffee;
}

.gf-action__result[data-result="recovery"] {
  border-color: #009900;
  color: #009900;
  background: #eeffee;
}

.gf-action__result[data-result="recovery"] span {
  color: #009900;
  text-transform: lowercase;
  text-shadow: none;
}

.gf-action__result[data-result="recovery"] strong {
  text-shadow: none;
}

.gf-action__result[data-result="safe"] strong {
  font-size: clamp(28px, 5.5556cqi, 60px);
  line-height: 1;
  text-shadow: none;
}

.gf-field-card {
  position: relative;
  inline-size: 100%;
  aspect-ratio: 10 / 3;
  display: grid;
  grid-template-columns: 30% 70%;
  grid-template-rows: 38% 62%;
  overflow: hidden;
  border: 5px solid #55bb99;
  border-radius: 6px;
  color: #4f4f4f;
  background: #ddffcc;
  box-shadow: 0 0 0 1px #668888;
}

.gf-field-card__art {
  grid-row: 1 / 3;
  display: grid;
  place-items: center;
  border-inline-end: 2px solid #668888;
  color: rgb(238 255 238 / 92%);
  background:
    radial-gradient(circle at 35% 30%, rgb(255 255 255 / 75%), transparent 18%),
    repeating-conic-gradient(from 20deg, #6cb7b8 0 12deg, #4f879d 12deg 24deg);
  font-family: Georgia, serif;
  font-size: clamp(24px, 5.1852cqi, 56px);
  text-shadow: 0 2px 0 rgb(44 52 73 / 42%);
}

.gf-field-card__image,
.gf-card__image {
  inline-size: 100%;
  block-size: 100%;
  display: block;
  object-fit: contain;
}

.gf-field-card[data-card-category="WEAPON"] .gf-field-card__art {
  background:
    radial-gradient(circle, #fff 0 4%, transparent 5%),
    repeating-conic-gradient(#91d4d2 0 10deg, #4e7fa0 10deg 20deg);
}

.gf-field-card[data-card-category="ARMOR"] .gf-field-card__art {
  background: radial-gradient(circle at 50% 42%, #ddeeff, #6e8393 42%, #2e4858 72%);
}

.gf-field-card[data-card-category="TRADE"] .gf-field-card__art {
  background: repeating-linear-gradient(135deg, #ddcc11 0 12px, #aa9900 12px 24px);
}

.gf-field-card[data-card-category="MIRACLE"] .gf-field-card__art {
  background: radial-gradient(circle, #fff 0 8%, #ffff44 20%, #e5c500 45%, #779966 78%);
}

.gf-field-card[data-card-category="DEMON"] .gf-field-card__art {
  background: radial-gradient(circle, #f58b75, #7b2637 52%, #271b2c);
}

.gf-field-card__name {
  min-inline-size: 0;
  padding-inline: 2.5%;
  display: flex;
  align-items: center;
  overflow: hidden;
  border-block-end: 1px solid #668888;
  font-size: clamp(9px, 1.8519cqi, 20px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gf-field-card__effect {
  min-inline-size: 0;
  padding: 1% 2.5%;
  overflow: hidden;
  font-size: clamp(7px, 1.3889cqi, 15px);
}

.gf-field-card__price,
.gf-field-card__cost {
  position: absolute;
  right: 1.5%;
  bottom: 2%;
  min-inline-size: 14%;
  block-size: 47%;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #4f4f4f;
  background: #ffffaa;
  font-size: clamp(8px, 1.6667cqi, 18px);
}

.gf-field-card__cost {
  right: 17%;
  inline-size: auto;
  padding-inline: 2%;
  border-radius: 999px;
  color: #6688aa;
  background: #eeffee;
  font-size: clamp(7px, 1.1111cqi, 12px);
}

.gf-action__summary {
  position: absolute;
  top: 87.5%;
  left: 1.5625%;
  inline-size: 40.625%;
  block-size: 10%;
  margin: 0;
  display: block;
}

.gf-action__defense-summary {
  position: absolute;
  top: 87.5%;
  right: 4.6875%;
  inline-size: 40.625%;
  block-size: 10%;
  margin: 0;
}

.gf-action__defense-summary div {
  inline-size: 100%;
  block-size: 100%;
  padding: 0;
  display: grid;
  place-items: center;
  border: 4px solid #4f4f4f;
  border-radius: 11px;
  background: #ddffcc;
}

.gf-action__defense-summary dt {
  display: none;
}

.gf-action__defense-summary dd {
  margin: 0;
  color: #4f4f4f;
  font-size: clamp(13px, 2.5926cqi, 28px);
  font-weight: 700;
}

.gf-action__defense-summary dd::before {
  content: "守";
}

.gf-action[data-has-defense="false"] .gf-action__defense-summary {
  visibility: hidden;
}

.gf-action__summary div {
  display: none;
}

.gf-action__summary div:first-child {
  inline-size: 100%;
  block-size: 100%;
  padding: 0;
  display: grid;
  place-items: center;
  border: 4px solid #4f4f4f;
  border-radius: 11px;
  background: #ddffcc;
}

.gf-action__summary dt {
  display: none;
}

.gf-action__summary dd {
  margin: 0;
  color: #4f4f4f;
  font-size: clamp(13px, 2.5926cqi, 28px);
  font-weight: 700;
}

.gf-action__summary dd::before {
  content: "攻";
}

.gf-response {
  position: absolute;
  z-index: 7;
  top: 13.1944%;
  left: 34.2593%;
  inline-size: 27.7778%;
  block-size: 42.3611%;
  display: none;
}

.gf-battle-screen[data-ui-mode="COMPOSING_REACTION"] .gf-response,
.gf-battle-screen[data-ui-mode="CONFIRMING_TRADE"] .gf-response {
  display: block;
}

.gf-response > .gf-section-heading {
  display: none;
}

.gf-response__content {
  position: relative;
  min-block-size: 0;
  block-size: 100%;
  padding: 0;
  display: block;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.gf-response__subject,
.gf-response__summary,
.gf-response__forgive,
.gf-response .gf-controls__reason {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.gf-response__selection {
  display: none;
}

.gf-response__selection .gf-field-card {
  inline-size: 100%;
}

.gf-response__actions {
  position: absolute;
  top: 98.3607%;
  left: 3.3333%;
  inline-size: 86.6667%;
  block-size: 13.1148%;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 4%;
}

.gf-response__actions button,
.gf-controls__actions button {
  min-block-size: 0;
  border: 0;
  border-radius: 10px;
  color: #eeffee;
  background: #ffbb00;
  font: inherit;
  font-size: clamp(12px, 2.5926cqi, 28px);
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 2px 0 rgb(125 105 60 / 28%);
}

.gf-response__actions button:disabled,
.gf-controls__actions button:disabled {
  display: none;
}

.gf-response__actions:has([data-submit-reaction]:not(:disabled)) [data-submit-forgive] {
  display: none;
}

.gf-response__actions [data-submit-forgive] {
  background: #bb4444;
}

.gf-response__actions [data-submit-reaction],
.gf-controls__actions [data-submit-action] {
  color: transparent;
  background: transparent;
  box-shadow: none;
}

.gf-trade-offer {
  inline-size: 100%;
  min-block-size: 60%;
  padding: 4%;
  display: grid;
  align-content: center;
  gap: 3%;
  border: 5px solid #55bb99;
  border-radius: 8px;
  color: #4f4f4f;
  background: #ddffcc;
}

.gf-trade-offer__name {
  color: #4f4f4f;
  font-size: clamp(10px, 1.8519cqi, 20px);
}

.gf-trade-offer__effect,
.gf-trade-offer__payment {
  margin: 0;
  font-size: clamp(7px, 1.2963cqi, 14px);
}

.gf-miracles {
  position: absolute;
  z-index: 4;
  top: 54.1667%;
  left: 71.2963%;
  inline-size: 27.7778%;
  block-size: 31.9444%;
}

.gf-miracles > .gf-section-heading {
  inline-size: 83.3333%;
  block-size: 17.3913%;
  margin: 0 0 8.6957%;
  display: grid;
  place-items: center;
  border: 1px solid #aaaaaa;
  border-radius: 10px;
  color: #668888;
  background: #eeeeee;
}

.gf-miracles .gf-section-heading__eyebrow,
.gf-miracles .gf-count {
  display: none;
}

.gf-miracles .gf-section-heading h2 {
  margin: 0;
  font-size: clamp(13px, 2.7778cqi, 30px);
  font-weight: 400;
}

.gf-miracles .gf-section-heading h2::before {
  margin-inline-end: 0.25em;
  content: "☀";
}

.gf-miracles .gf-card-list {
  max-block-size: 73.913%;
  display: grid;
  grid-auto-rows: minmax(0, 39.1304%);
  grid-template-columns: 100%;
  gap: 4.3478%;
  overflow-y: auto;
  overflow-x: hidden;
}

.gf-miracles .gf-empty {
  display: none;
}

.gf-miracles .gf-card {
  min-block-size: 0;
  border: 5px solid #55bb99;
  border-radius: 6px;
  background: #ddffcc;
  box-shadow: 0 0 0 1px #668888;
}

.gf-miracles .gf-card__button {
  min-block-size: 0;
  block-size: 100%;
  padding: 0;
  display: grid;
  grid-template-columns: 27% 73%;
  grid-template-rows: 38% 62%;
}

.gf-miracles .gf-card__mark {
  grid-row: 1 / 3;
  display: grid;
  place-items: center;
  border-inline-end: 2px solid #668888;
  color: #eeffee;
  background: radial-gradient(circle, #fff, #f3df39 28%, #7fb352 72%);
  font-size: clamp(22px, 4.6296cqi, 50px);
}

.gf-miracles .gf-card__image {
  object-fit: cover;
}

.gf-miracles .gf-card__name {
  padding-inline: 2%;
  display: flex;
  align-items: center;
  border-block-end: 1px solid #668888;
  font-size: clamp(9px, 1.8519cqi, 20px);
}

.gf-miracles .gf-card__effect {
  margin: 0;
  padding: 1% 3%;
  color: #4f4f4f;
  font-size: clamp(8px, 1.6667cqi, 18px);
  font-weight: 700;
}

.gf-hand {
  position: absolute;
  z-index: 6;
  top: 67.3611%;
  left: 0.9259%;
  inline-size: 61.1111%;
  block-size: 27.7778%;
}

.gf-hand::before {
  position: absolute;
  top: -17.5%;
  left: -1.5152%;
  inline-size: 100%;
  block-size: 10%;
  border-radius: 0 5px 5px 0;
  background: #008f6f;
  content: "";
}

.gf-hand > .gf-section-heading {
  display: none;
}

.gf-hand .gf-card-list {
  max-block-size: none;
  block-size: 100%;
  display: grid;
  grid-auto-flow: row;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 0.303%;
  overflow: hidden;
  scrollbar-width: none;
}

.gf-hand .gf-card {
  position: relative;
  min-block-size: 0;
  block-size: 100%;
  overflow: visible;
  border: 0;
  border-radius: 0;
  color: #4f4f4f;
  background: #d7c10c;
  box-shadow: inset 0 0 0 2px rgb(79 79 79 / 22%);
}

.gf-hand .gf-card[data-card-category="WEAPON"] {
  background: #8fcac5;
}

.gf-hand .gf-card[data-card-category="ARMOR"] {
  background: #91a8b4;
}

.gf-hand .gf-card[data-card-category="GOODS"] {
  background: #d8b826;
}

.gf-hand .gf-card[data-card-category="MIRACLE"] {
  background: radial-gradient(circle, #ffff88, #f3df39 42%, #e8c400 72%);
}

.gf-hand .gf-card[data-card-category="DEMON"] {
  background: #7d2840;
}

.gf-hand .gf-card__button {
  position: relative;
  min-block-size: 0;
  block-size: 75%;
  padding: 0;
  display: grid;
  place-items: center;
  overflow: visible;
  border-radius: 0;
}

.gf-hand .gf-card__mark {
  inline-size: 100%;
  block-size: 100%;
  display: block;
  overflow: hidden;
  color: #eeffee;
  font-family: Georgia, serif;
  font-size: clamp(22px, 4.6296cqi, 50px);
  text-shadow: 0 2px 0 rgb(44 52 73 / 36%);
}

.gf-hand .gf-card__image {
  object-fit: cover;
}

.gf-hand .gf-card__name {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.gf-hand .gf-card__effect {
  position: absolute;
  top: 75%;
  left: 0;
  inline-size: 100%;
  min-block-size: 25%;
  margin: 0;
  padding: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #6688aa;
  background: rgb(238 255 238 / 90%);
  font-size: clamp(7px, 1.6667cqi, 18px);
  font-weight: 700;
  line-height: 1;
  text-align: center;
  white-space: nowrap;
}

.gf-hand .gf-card__reason {
  display: none;
}

.gf-hand .gf-card__button:disabled {
  opacity: 0.62;
}

.gf-hand .gf-card[data-selected="true"] {
  border-color: #ffbb00;
  box-shadow:
    0 0 0 4px #ffbb00,
    0 5px 0 rgb(0 80 65 / 24%);
  transform: none;
}

.gf-controls {
  position: absolute;
  z-index: 8;
  top: 54.8611%;
  left: 3.7037%;
  inline-size: 24.0741%;
  block-size: 8.3333%;
}

.gf-controls > .gf-section-heading,
.gf-controls__prompt,
.gf-controls__observer-note,
.gf-controls__reason {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.gf-controls__actions {
  inline-size: 100%;
  block-size: 66.6667%;
  display: block;
}

.gf-controls__actions button {
  inline-size: 100%;
  block-size: 100%;
  padding: 0;
}

.gf-controls__actions [data-focus-targets] {
  display: none !important;
}

.gf-controls__actions [data-submit-pray] {
  background: #008f83;
}

.gf-input-status {
  position: absolute;
  right: 0;
  bottom: 110%;
  inline-size: 160%;
  margin: 0;
  padding: 2%;
  border: 1px solid #668888;
  border-radius: 6px;
  color: #668888;
  background: rgb(238 255 238 / 88%);
  font-size: clamp(7px, 1.1111cqi, 12px);
}

.gf-utility-actions {
  position: absolute;
  top: 58%;
  right: -4%;
  inline-size: 18%;
  block-size: 66.6667%;
  margin: 0;
  border: 0;
  padding: 0;
  color: #668888;
  font-size: clamp(7px, 1.1111cqi, 12px);
}

.gf-utility-actions summary {
  inline-size: 100%;
  block-size: 100%;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 4px solid #999999;
  border-radius: 0;
  color: transparent;
  background: #eeeeee;
  font-size: 0;
  text-align: center;
}

.gf-utility-actions summary::before {
  color: #888888;
  content: "▤";
  font-size: clamp(15px, 3.3333cqi, 36px);
}

.gf-utility-action {
  position: relative;
  z-index: 20;
  right: 750%;
  inline-size: 850%;
  max-block-size: 24cqi;
  margin: 1% 0 0;
  overflow-y: auto;
  border-color: #668888;
  color: #4f4f4f;
  background: #eeffee;
}

.gf-utility-action__lead {
  min-block-size: 4.5cqi;
  display: grid;
  grid-template-columns: 15% minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  overflow: hidden;
  border: 4px solid #55bb99;
  border-radius: 6px;
  color: #4f4f4f;
  background: #ddffcc;
}

.gf-utility-action__lead > span {
  grid-row: 1 / 3;
  display: grid;
  place-items: center;
  border-inline-end: 2px solid #668888;
  color: #eeffee;
  background: #999999;
  font-size: clamp(18px, 4.4444cqi, 48px);
}

.gf-utility-action__lead[data-utility-kind="exchange"] > span {
  background: #c5ad14;
}

.gf-utility-action__lead > strong,
.gf-utility-action__lead > small {
  min-inline-size: 0;
  padding-inline: 2%;
}

.gf-utility-action__lead > strong {
  align-self: end;
  border-block-end: 1px solid #668888;
  font-size: clamp(10px, 1.8519cqi, 20px);
}

.gf-utility-action__lead > small {
  align-self: start;
  padding-block-start: 0.5%;
  font-size: clamp(7px, 1.2037cqi, 13px);
}

.gf-utility-card-choices {
  min-inline-size: 0;
  margin: 0;
  padding: 0.4cqi;
  display: flex;
  gap: 0.4cqi;
  overflow-x: auto;
  border: 0;
}

.gf-utility-card-choices legend {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.gf-utility-card-choice {
  position: relative;
  flex: 0 0 8.5cqi;
  min-block-size: 6.5cqi;
  padding: 0.25cqi;
  display: grid;
  grid-template-columns: 28% 1fr;
  grid-template-rows: auto 1fr auto;
  border: 2px solid #668888;
  border-radius: 4px;
  color: #4f4f4f;
  background: #ddffcc;
  cursor: pointer;
}

.gf-utility-card-choice:has(input:checked) {
  border-color: #ddbb22;
  box-shadow:
    0 0 0 2px #eeffee,
    0 0 0 4px #ddbb22;
}

.gf-utility-card-choice input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.gf-utility-card-choice__mark {
  grid-row: 1 / 4;
  display: grid;
  place-items: center;
  color: #eeffee;
  background: #668899;
  font-size: clamp(12px, 2.7778cqi, 30px);
}

.gf-utility-card-choice strong,
.gf-utility-card-choice small {
  min-inline-size: 0;
  padding-inline-start: 4%;
  overflow: hidden;
}

.gf-utility-card-choice strong {
  font-size: clamp(8px, 1.3889cqi, 15px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gf-utility-card-choice small {
  font-size: clamp(6px, 0.9259cqi, 10px);
}

.gf-utility-card-choice__price {
  justify-self: end;
  color: #665522;
  font-size: clamp(7px, 1.2037cqi, 13px);
}

.gf-exchange {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5cqi 1cqi;
}

.gf-exchange__buttons {
  display: grid;
  gap: 0.35cqi;
}

.gf-exchange__buttons button {
  min-block-size: 2.3cqi;
  padding: 0;
  border: 3px solid #fff0aa;
  border-radius: 8px;
  color: #eeffee;
  background: #c2a62d;
  font-size: clamp(12px, 2.7778cqi, 30px);
  line-height: 1;
}

.gf-exchange__readout {
  grid-column: 1 / -1;
  padding: 0.5cqi 1cqi;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid #aaaaaa;
  border-radius: 999px;
  background: #eeeeee;
  font-size: clamp(11px, 2.2222cqi, 24px);
  font-weight: 700;
  text-align: center;
}

.gf-exchange__total {
  color: #668888;
  text-align: center;
}

.gf-presentation {
  position: absolute;
  z-index: 18;
  top: 21.5278%;
  left: 2.7778%;
  inline-size: 27.7778%;
  padding: 1.5% 2%;
  border: 5px solid #55bb99;
  border-radius: 10px;
  color: #4f4f4f;
  background: rgb(221 255 204 / 97%);
  box-shadow: 0 8px 20px rgb(0 80 65 / 22%);
  transform: none;
}

.gf-presentation[data-central="true"] {
  border-color: #cc6677;
  background: rgb(255 238 238 / 97%);
  box-shadow: 0 10px 30px rgb(80 0 20 / 34%);
}

.gf-presentation__eyebrow {
  margin: 0;
  color: #668888;
  font-size: clamp(6px, 1.1111cqi, 12px);
}

.gf-presentation__title {
  color: #4f4f4f;
  font-size: clamp(14px, 3.7037cqi, 40px);
}

.gf-presentation__detail {
  margin: 1% 0 0;
  color: #668888;
  font-size: clamp(8px, 1.6667cqi, 18px);
}

.gf-battle-footer {
  position: absolute;
  z-index: 20;
  inset: auto 0 0;
  block-size: 4.1667%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-inline: 3.8889% 0.9259%;
  color: #eeffee;
  background: #008f6f;
}

.gf-battle-footer__name {
  inline-size: 18.5185%;
  overflow: hidden;
  font-size: clamp(10px, 1.8519cqi, 20px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gf-battle-footer__sound {
  block-size: 66.6667%;
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.gf-battle-footer__sound > span {
  display: grid;
  place-items: center;
  font-size: clamp(8px, 1.6667cqi, 18px);
}

.gf-battle-footer__sound i {
  inline-size: clamp(3px, 0.9259cqi, 10px);
  background: #eeffee;
}

.gf-battle-footer__sound i:nth-last-child(-n + 4) {
  opacity: 0.18;
}

.gf-result {
  z-index: 30;
  max-inline-size: none;
  inline-size: 46.2963%;
  padding: 3.7037%;
  border: 5px solid #008f6f;
  border-radius: 24px;
  color: #4f4f4f;
  background: rgb(238 255 238 / 98%);
}

.gf-result h2 {
  font-size: clamp(24px, 5.5556cqi, 60px);
}

.gf-primary-link {
  border-color: #d2b76e;
  color: #445555;
  background: #ffeab0;
}

.gf-header__link:focus-visible,
.gf-primary-link:focus-visible,
.gf-controls button:focus-visible,
.gf-card__button:focus-visible,
.gf-player__target-control:focus-visible {
  outline: 4px solid #fff3a0;
  outline-offset: 2px;
}

@media (max-width: 64rem) {
  .gf-battle-screen {
    grid-template-areas: none;
    grid-template-columns: none;
    grid-template-rows: none;
  }

  .gf-player-list {
    max-block-size: none;
  }
}

@media (max-width: 44rem) {
  .gf-battle-screen {
    grid-template-areas: none;
    grid-template-columns: none;
  }

  .gf-header {
    grid-template-columns: none;
  }

  .gf-header__identity {
    grid-column: auto;
    grid-row: auto;
  }

  .gf-player-list,
  .gf-card-list {
    grid-auto-flow: unset;
    grid-template-columns: unset;
    overflow-x: auto;
  }

  .gf-hand .gf-card-list {
    grid-auto-flow: row;
    grid-template-columns: repeat(9, minmax(0, 1fr));
  }
}
`;
