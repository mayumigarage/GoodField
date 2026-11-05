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
  createPresentationQueue,
  presentationStepsForEvent,
  tradePresentationStage
} from "./presentation-queue.ts";
import type {
  PresentationQueueState,
  PresentationStageKind,
  TradePresentationStage
} from "./presentation-queue.ts";
import { renderSoundControl } from "./sound-control.ts";
import {
  immediateSoundEvents,
  isDangerousMortarDamage,
  isDarkDamage,
  isDefensePenalty,
  SoundEffectPlayer,
  soundEffectForEvent,
  soundEffectForPresentationStep,
  type SoundEffect
} from "./sound-effects.ts";
import {
  actionCardStatus,
  canSubmitTrade,
  actionPreview,
  advanceUiClock,
  defenseCardStatus,
  defenseMiracleStatus,
  INPUT_DEADLINE_TOTAL_MS,
  inputDeadlineRemainingSeconds,
  isHumanInputMode,
  learnedMiracleStatus,
  prepareHandActionSubmission,
  prepareBuyConfirmation,
  prepareDeclareActionSubmission,
  prepareExchangeSubmission,
  prepareTradeSubmission,
  preparePraySubmission,
  prepareReactionSubmission,
  reactionPreview,
  releaseCommandLock,
  selectActionCard,
  selectDefenseCard,
  selectDefenseMiracle,
  selectLearnedMiracle,
  selectTarget,
  toggleExchangeDraft,
  toggleTradeDraft,
  toggleTradeProduct,
  toggleHandActionCard,
  toggleHandActionMode,
  updateExchangeDraft,
  synchronizeUiState,
  tradeActionForDraft,
  tradePaymentPreview
} from "./ui-machine.ts";
import type {
  ExchangeAllocation,
  ExchangeDraft,
  TradeDraft,
  UiInteractionState,
  UiMode
} from "./ui-machine.ts";
import { CARD_IMAGE_IDS } from "./card-images.generated.ts";

export type BattleScreenLinks = {
  backHref?: string;
  rulebookHref?: string;
  exitHref?: string;
  modeLabel?: string;
  exitAction?: boolean;
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

const CALAMITY_SLOTS: readonly (readonly Calamity[])[] = [
  ["DARK_CLOUD"],
  ["FOG"],
  ["DREAM"],
  ["FLASH"],
  ["COLD", "FEVER", "HELL_SICKNESS", "HEAVEN_SICKNESS"]
];

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

// No dedicated guardian portraits ship yet, so each guardian is shown with the
// art of its first action card.
function guardianPortraitId(guardianName: string): string | null {
  const marker = `-${guardianName}-`;
  const matches = [...CARD_IMAGE_IDS]
    .filter((id) => id.startsWith("guardian-action-") && id.includes(marker))
    .sort();
  return matches[0] ?? null;
}

function renderGuardianChip(
  player: PlayerPublicView,
  introStyle: string | null
): string {
  const guardian = player.guardian;
  if (!guardian) return "";
  const portraitId = guardianPortraitId(guardian.guardianName);
  const art = portraitId
    ? renderCardArt(portraitId, "♜", "gf-player__guardian-art")
    : '<span class="gf-player__guardian-art" aria-hidden="true">♜</span>';
  return `<span
      class="gf-player__guardian"
      aria-label="守護神 ${escapeHtml(guardian.guardianName)}"
      ${introStyle === null ? "" : `data-intro="true" style="${introStyle}"`}
    >${art}<span class="gf-player__guardian-name">${escapeHtml(guardian.guardianName)}</span></span>`;
}

function renderStatusPills(player: PlayerPublicView): string {
  const statuses: string[] = [];
  if (!player.alive) statuses.push("昇天");
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

function renderNameCalamities(player: PlayerPublicView): string {
  const active = (Object.keys(player.calamities) as Calamity[]).filter(
    (calamity) => player.calamities[calamity] === true
  );
  if (active.length === 0) return "";
  // Each slot has a fixed column; the four diseases share the last one.
  const slots = CALAMITY_SLOTS.map((members, slot) => {
    const calamity = members.find((member) => active.includes(member));
    return calamity === undefined
      ? `<span class="gf-calamity-slot" data-slot="${slot}"></span>`
      : `<span class="gf-calamity-slot" data-slot="${slot}"><span class="gf-calamity-chip" data-calamity="${calamity}">${escapeHtml(CALAMITY_LABELS[calamity])}</span></span>`;
  });
  return `<span class="gf-player__calamities" aria-label="災い">${slots.join("")}</span>`;
}

// Full-width characters count double so long names shrink to fit the name column.
function nameSizeTier(name: string): number {
  let units = 0;
  for (const char of name) units += (char.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  if (units <= 13) return 0;
  if (units <= 16) return 1;
  if (units <= 19) return 2;
  return 3;
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

function renderCastMiracle(player: PlayerPublicView): string {
  const definitionId = player.lastMiracleCardDefinitionId ?? null;
  if (definitionId === null) {
    return '<div class="gf-cast-miracle" data-empty="true" aria-label="起こした奇跡なし"></div>';
  }
  const text = cardText(definitionId);
  const definition = CARD_DEFINITIONS_BY_ID.get(definitionId);
  return `<div class="gf-cast-miracle" title="${escapeHtml(text.name)}" aria-label="${escapeHtml(`起こした奇跡: ${text.name}`)}">${renderCardArt(
    definitionId,
    CARD_CATEGORY_MARKS[definition?.category ?? "MIRACLE"],
    "gf-cast-miracle__image"
  )}</div>`;
}

function renderPlayer(
  player: PlayerPublicView,
  view: GameViewState,
  targetCandidateIds: readonly string[],
  highlightedTargetIds: readonly string[],
  interactionLocked: boolean,
  guardianIntroStyle: string | null = null,
  showCastMiracles = false
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
          <h3 class="gf-player__name" data-name-size="${nameSizeTier(player.displayName)}">${escapeHtml(player.displayName)}</h3>
          ${renderGuardianChip(player, guardianIntroStyle)}
          ${renderNameCalamities(player)}
          <span class="gf-player__state">${escapeHtml(stateLabel)}</span>
        </header>
        ${renderPlayerMarkers(active, acting, targeted, player.alive)}
        ${
          showCastMiracles
            ? renderCastMiracle(player)
            : ""
        }
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

// The hand cards are narrow, so the effect line is condensed to a short form
// such as "50%攻9", "攻15/守10", "反射" or "弾く".
function shortCardEffect(effect: string): string {
  const parts = effect
    .replace(/\s*\([^)]*\)/g, "")
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) =>
      part
        .replace(/^両替する$/, "両替")
        .replace(/奇跡を/g, "")
        .replace(/無属性武器を/g, "無")
        .replace(/何でもはね返す/g, "全反射")
        .replace(/をはね返す|はね返す/g, "反射")
        .replace(/を止める/g, "停止")
        .replace(/を弾く/g, "弾く")
        .replace(/止める/g, "停止")
    );
  const hitIndex = parts.findIndex((part) => /^命中\d+%$/.test(part));
  if (hitIndex >= 0) {
    const hit = (parts[hitIndex] ?? "").replace("命中", "");
    parts.splice(hitIndex, 1);
    if (parts.length > 0) parts[0] = `${hit}${parts[0]}`;
    else parts.push(hit);
  }
  return parts.join("/");
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
  const handAction =
    !composingReaction &&
    ui.mode === "COMPOSING_ACTION" &&
    ui.handActionMode !== null &&
    !ui.interactionLocked &&
    !ui.inputDeadlineExpired
      ? view.self?.legalActions.find(
          (action) =>
            action.type === ui.handActionMode &&
            action.cardInstanceIds.includes(card.instanceId)
        )
      : null;
  const utilityAction =
    !composingReaction &&
    ui.mode === "COMPOSING_ACTION" &&
    !ui.interactionLocked &&
    !ui.inputDeadlineExpired
      ? view.self?.legalActions.find(
          (action) =>
            (
              action.type === "EXCHANGE_RESOURCES" ||
              action.type === "SELL_CARD" ||
              action.type === "DECLARE_BUY"
            ) &&
            action.cardInstanceIds.includes(card.instanceId)
        )
      : null;
  const handActionType =
    handAction?.type === "DISCARD" || handAction?.type === "SACRIFICE"
      ? handAction.type
      : null;
  const utilityActionType =
    utilityAction?.type === "EXCHANGE_RESOURCES" ||
    utilityAction?.type === "SELL_CARD" ||
    utilityAction?.type === "DECLARE_BUY"
      ? utilityAction.type
      : null;
  const selectingHandAction = ui.handActionMode !== null;
  const exchangeOpen =
    ui.exchangeDraft?.cardInstanceId === card.instanceId;
  const tradeDraft = activeTradeDraft(view, ui);
  const tradeAction = tradeActionForDraft(tradeDraft, view);
  const isTradeCard = tradeDraft?.cardInstanceId === card.instanceId;
  const isTradeProductCandidate =
    tradeAction?.type === "SELL_CARD" &&
    !isTradeCard &&
    tradeAction.productCardInstanceIds.includes(card.instanceId);
  const tradeSelected =
    isTradeCard || tradeDraft?.productCardInstanceId === card.instanceId;
  const handActionSelected =
    handActionType !== null &&
    ui.selectedHandActionCardIds.includes(card.instanceId);
  const selectable = tradeDraft
    ? isTradeCard || isTradeProductCandidate
    : selectingHandAction
      ? handActionType !== null
      : utilityActionType !== null || status.selectable;
  const invalidReason = tradeDraft
    ? null
    : selectingHandAction && handActionType === null
      ? "この神器は対象外です"
      : handActionType !== null || utilityActionType !== null
      ? null
      : status.invalidReason;
  const selectionAttribute = isTradeProductCandidate
    ? `data-select-trade-product="${escapeHtml(card.instanceId)}"`
    : handActionType
    ? `data-select-hand-action-card="${escapeHtml(card.instanceId)}"`
    : utilityActionType
      ? `data-open-utility="${utilityActionType}" data-utility-card-instance="${escapeHtml(card.instanceId)}"`
    : composingReaction
      ? `data-select-defense-card="${escapeHtml(card.instanceId)}"`
      : `data-select-card="${escapeHtml(card.instanceId)}"`;
  const reason = invalidReason
    ? `<span class="gf-card__reason">${escapeHtml(invalidReason)}</span>`
    : "";
  return `
    <li
      class="gf-card"
      data-card-definition-id="${escapeHtml(card.cardDefinitionId)}"
      data-selected="${String(status.selected || tradeSelected || handActionSelected)}"
      data-card-category="${definition?.category ?? "GOODS"}"
      data-card-element="${definition?.element ?? "PHYSICAL"}"
    >
      <button
        type="button"
        class="gf-card__button"
        ${selectionAttribute}
        aria-pressed="${String(status.selected || exchangeOpen || tradeSelected || handActionSelected)}"
        ${selectable ? "" : "disabled"}
        ${handActionType ? `title="${handActionType === "DISCARD" ? "この神器を捨てる" : "この神器をささげる"}"` : utilityActionType ? 'title="専用画面を開く"' : invalidReason ? `title="${escapeHtml(invalidReason)}"` : ""}
      >
        <span class="gf-card__mark" aria-hidden="true">${renderCardArt(
          card.cardDefinitionId,
          CARD_CATEGORY_MARKS[definition?.category ?? "GOODS"],
          "gf-card__image"
        )}</span>
        <span class="gf-card__name">${escapeHtml(text.name)}</span>
        ${
          tradeDraft
            ? `<span class="gf-card__effect" data-trade-price>${
                definition?.price === undefined ? "" : `¥${definition.price}`
              }</span>`
            : `<span class="gf-card__effect" title="${escapeHtml(text.effect)}">${escapeHtml(shortCardEffect(text.effect))}</span>`
        }
        ${reason}
      </button>
    </li>`;
}

function renderConcealedCard(): string {
  return `
    <li
      class="gf-card gf-card--concealed"
      data-card-concealed="true"
    >
      <button
        type="button"
        class="gf-card__button"
        aria-label="ドローしたカード。戦闘演出の終了後に公開されます"
        disabled
      >
        <span class="gf-card__back" aria-hidden="true"></span>
      </button>
    </li>`;
}

function renderMiracle(
  miracle: LearnedMiracleView,
  ui: UiInteractionState,
  view: GameViewState,
  index: number
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
      style="--gf-miracle-slot: ${index}"
      data-card-definition-id="${escapeHtml(miracle.cardDefinitionId)}"
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

function redrawsHand(cardDefinitionId: string): boolean {
  return (
    CARD_DEFINITIONS_BY_ID.get(cardDefinitionId)?.instructions.some(
      (instruction) =>
        instruction.kind === "SPECIAL" &&
        instruction.operation === "REDRAW_HAND"
    ) ?? false
  );
}

// 昇天弓 always shoots 30 at 75%, whatever else boosted the original attack.
const ASCENSION_BOW_POWER = 30;

function inflictsOwnCalamity(
  cardDefinitionId: string,
  calamity: Calamity
): boolean {
  return (
    CARD_DEFINITIONS_BY_ID.get(cardDefinitionId)?.instructions.some(
      (instruction) =>
        instruction.kind === "ADD_CALAMITY" &&
        instruction.timing === "SELF" &&
        instruction.calamity === calamity
    ) ?? false
  );
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
      data-card-definition-id="${escapeHtml(cardDefinitionId)}"
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
type HandRedrawnEvent = Extract<DomainEvent, { type: "HAND_REDRAWN" }>;
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
  // 「神器一新」 shown over the defense after the attack's outcome.
  handRedraw: HandRedrawnEvent | null;
  // True while the redrawing defense card flashes before 「神器一新」.
  handRedrawLead: boolean;
  // Set while the defender's card is held under the "deflected" notice.
  deflectNotice: Extract<DomainEvent, { type: "ATTACK_REDIRECTED" }> | null;
  // True while the "stopped" notice (wall block) is shown.
  stopped: boolean;
  // True while the attack card slides over to the redirected actor's side.
  redirectMove: boolean;
  reactionDepth: number;
  stageKind: PresentationStageKind;
  stageIndex: number;
  // The damage is from a dark attack, which takes all remaining HP.
  darkDamage: boolean;
  // 「あぶないキネ」 struck a holder of 「あぶないウス」.
  dangerousMortar: boolean;
  // The calamity on screen comes from the defender's own defense card.
  defensePenalty: boolean;
};

// 「昇天弓」: an ascending player's last shot at whoever brought them down.
type AscensionBowScene = {
  event: Extract<DomainEvent, { type: "ASCENSION_BOW_TRIGGERED" }>;
  showsHitResult: boolean;
  damage: ResourceChangedEvent | null;
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

type ResourcesExchangedEvent = Extract<
  DomainEvent,
  { type: "RESOURCES_EXCHANGED" }
>;

type ExchangePresentationScene = {
  event: ResourcesExchangedEvent;
  stageIndex: number | null;
};

type TradePaymentEvent = Extract<
  DomainEvent,
  { type: "TRADE_PAYMENT_COLLECTED" }
>;

type TradeTransferEvent = Extract<DomainEvent, { type: "CARD_TRANSFERRED" }>;

type TradePresentationScene = {
  kind: "SELL" | "BUY" | "GUARDIAN";
  stage: TradePresentationStage;
  // A guardian theft moves only the coin, towards the guardian's portrait.
  cardDefinitionId: string | null;
  guardianPortraitId: string | null;
  price: number;
  leftPlayerId: string;
  rightPlayerId: string;
  rightLabel: string | null;
  elapsedMs: number;
};

type TradeOfferedEvent = Extract<DomainEvent, { type: "TRADE_OFFERED" }>;

// A buy offer, shown to every viewer while the buyer decides and while
// 「買わない」 or 「貧乏」 closes it.
type TradeOfferScene = {
  actorId: string;
  targetPlayerId: string;
  cardDefinitionId: string;
  notice: "DECLINED" | "INSUFFICIENT_RESOURCES" | null;
  dreamRevealed: boolean;
};

function actionActivityLabel(actionType: GameCommand["type"]): string {
  switch (actionType) {
    case "DECLARE_ACTION":
      return "神器・奇跡を使用";
    case "PRAY":
      return "祈った";
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
          (event.actionType === "PRAY" ||
            (event.actionCardDefinitionIds?.length ?? 0) > 0)) ||
        (event.type === "REACTION_DECLARED" &&
          ((event.defenseCardDefinitionIds?.length ?? 0) > 0 ||
            (event.defenseLearnedMiracleDefinitionIds?.length ?? 0) > 0))
    );
  if (!cardUse) return null;
  if (cardUse.type === "ACTION_DECLARED") {
    const tradeResolved = events.find(
      (event) =>
        event.type === "TRADE_RESOLVED" && event.eventSeq > cardUse.eventSeq
    );
    if (tradeResolved) return null;
    if (
      cardUse.actionType === "EXCHANGE_RESOURCES" &&
      !presentationExchange(presentation)
    ) {
      return null;
    }
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
      actionCardDefinitionIds: [
        ...(cardUse.actionType === "DISCARD" ||
        cardUse.actionType === "SACRIFICE"
          ? [handActionCardDefinitionId(cardUse.actionType)]
          : []),
        ...(cardUse.actionCardDefinitionIds ?? [])
      ],
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
          : "弾いた"
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
    activeEvent.type === "CALAMITY_WORSENED" ||
    activeEvent.type === "HAND_REDRAWN"
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
  const latestAttackDamage =
    activeEvent.type === "RESOURCE_CHANGED" &&
    ["ABSORPTION", "SELF_DAMAGE", "COUNTER"].includes(activeEvent.reason)
      ? [...events]
          .reverse()
          .find(
            (event): event is DamageAppliedEvent =>
              event.type === "DAMAGE_APPLIED" &&
              !events.some(
                (boundary) =>
                  boundary.eventSeq > event.eventSeq &&
                  boundary.eventSeq < active.eventSeq &&
                  (boundary.type === "ACTION_DECLARED" ||
                    boundary.type === "ATTACK_CREATED" ||
                    boundary.type === "ASCENSION_BOW_TRIGGERED" ||
                    boundary.type === "POST_TURN_AUTOMATIC_EFFECTS_STARTED" ||
                    boundary.type === "GUARDIAN_ACTION_SELECTED" ||
                    boundary.type === "PHENOMENON_SELECTED")
              )
          ) ?? null
      : null;
  const directAttackId =
    activeEvent.type === "ATTACK_CREATED"
      ? activeEvent.attack.attackId
      : activeEvent.type === "ATTACK_REDIRECTED" ||
          activeEvent.type === "HIT_ROLLED" ||
          activeEvent.type === "REACTION_REQUESTED" ||
          activeEvent.type === "ATTACK_STOPPED" ||
          activeEvent.type === "DAMAGE_APPLIED"
        ? activeEvent.attackId
        : relatedCalamityDamage?.attackId ??
          latestAttackDamage?.attackId ??
          null;
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
  const deflectNotice =
    activeEvent.type === "ATTACK_REDIRECTED" && active.stageIndex === 0
      ? activeEvent
      : null;
  const redirect = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "ATTACK_REDIRECTED" &&
        event.attackId === attackEvent.attack.attackId &&
        event.eventSeq !== deflectNotice?.eventSeq
    );
  const reaction =
    [...events]
      .reverse()
      .find(
        (event): event is ReactionDeclaredEvent =>
          event.type === "REACTION_DECLARED" &&
          (deflectNotice
            ? event.playerId === deflectNotice.actorId &&
              event.eventSeq < deflectNotice.eventSeq
            : directReactionId
            ? event.reactionId === directReactionId
            : event.reactionId === attackEvent.attack.reactionId ||
              events.some(
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
    handRedraw:
      activeEvent.type === "HAND_REDRAWN" && active.stageIndex === 1
        ? activeEvent
        : null,
    handRedrawLead:
      activeEvent.type === "HAND_REDRAWN" && active.stageIndex === 0,
    deflectNotice,
    stopped: activeEvent.type === "ATTACK_STOPPED",
    redirectMove:
      activeEvent.type === "ATTACK_REDIRECTED" && active.stageIndex === 1,
    reactionDepth:
      redirect?.type === "ATTACK_REDIRECTED"
        ? redirect.reactionDepth
        : attackEvent.attack.reactionDepth,
    stageKind: active.kind,
    stageIndex: active.stageIndex,
    darkDamage: damage !== null && isDarkDamage(damage, events),
    dangerousMortar: damage !== null && isDangerousMortarDamage(damage, events),
    defensePenalty:
      (activeEvent.type === "CALAMITY_APPLIED" ||
        activeEvent.type === "HAND_REDRAWN") &&
      isDefensePenalty(activeEvent, events)
  };
}

function presentationAscensionBow(
  presentation: PresentationQueueState | null
): AscensionBowScene | null {
  const active = presentation?.activeStep?.step;
  if (!active) return null;
  if (active.event.type === "ASCENSION_BOW_TRIGGERED") {
    return {
      event: active.event,
      showsHitResult: active.stageIndex > 0,
      damage: null
    };
  }
  // The arrow's damage stays on the bow's scene.
  const damage = active.event;
  if (
    active.kind !== "HP_UPDATE" ||
    damage.type !== "RESOURCE_CHANGED" ||
    damage.reason !== "COUNTER"
  ) {
    return null;
  }
  const previous = presentation.recentEvents.findLast(
    ({ eventSeq }) => eventSeq < damage.eventSeq
  );
  return previous?.type === "ASCENSION_BOW_TRIGGERED" &&
    previous.targetPlayerId === damage.playerId
    ? { event: previous, showsHitResult: false, damage }
    : null;
}

function hasPendingAttackOutcome(
  presentation: PresentationQueueState,
  scene: AttackPresentationScene
): boolean {
  for (const step of presentation.pendingSteps) {
    if (
      step.kind === "ACTION" ||
      step.kind === "GF_UPDATE" ||
      step.kind === "GUARDIAN" ||
      step.kind === "AUTOMATIC_EFFECT" ||
      step.kind === "DEMON" ||
      step.kind === "TRADE" ||
      step.kind === "RESULT" ||
      (step.kind === "TARGET" &&
        step.event.type === "ATTACK_CREATED" &&
        step.event.attack.attackId !== scene.attackEvent.attack.attackId)
    ) {
      return false;
    }
    if (
      step.kind === "REACTION" ||
      (step.kind === "DAMAGE_RESULT" &&
        step.event.type === "DAMAGE_APPLIED" &&
        step.event.attackId === scene.attackEvent.attack.attackId) ||
      (step.kind === "HP_UPDATE" &&
        step.event.type === "RESOURCE_CHANGED" &&
        ["ABSORPTION", "SELF_DAMAGE", "COUNTER"].includes(
          step.event.reason
        )) ||
      (step.kind === "CALAMITY" &&
        "playerId" in step.event &&
        step.event.playerId === scene.targetPlayerId) ||
      ((step.kind === "REVIVAL" || step.kind === "ASCENSION") &&
        "playerId" in step.event &&
        step.event.playerId === scene.targetPlayerId)
    ) {
      return true;
    }
  }
  return false;
}

function presentationTurnPlayerId(
  presentation: PresentationQueueState | null
): string | null {
  const active = presentation?.activeStep?.step;
  if (!active) return null;
  if (
    active.kind === "ACTION" &&
    active.event.type === "ACTION_DECLARED"
  ) {
    return active.event.playerId;
  }
  const scene = presentationAttackScene(presentation);
  if (!scene) return null;
  const isOutcomeStage = [
    "HIT_RESULT",
    "REACTION",
    "DAMAGE_RESULT",
    "HP_UPDATE",
    "CALAMITY"
  ].includes(scene.stageKind);
  return !isOutcomeStage || hasPendingAttackOutcome(presentation, scene)
    ? scene.actorId
    : null;
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

function presentationGuardianAssigned(
  presentation: PresentationQueueState | null
): Extract<DomainEvent, { type: "GUARDIAN_ASSIGNED" }> | null {
  const active = presentation?.activeStep?.step;
  return active?.kind === "GUARDIAN" && active.event.type === "GUARDIAN_ASSIGNED"
    ? active.event
    : null;
}

function presentationResourceEffect(
  presentation: PresentationQueueState | null
): ResourceChangedEvent | null {
  const active = presentation?.activeStep?.step;
  return active?.kind === "HP_UPDATE" &&
    active.event.type === "RESOURCE_CHANGED" &&
    (active.event.resource === "HP" || active.event.resource === "MP") &&
    active.event.delta !== 0
    ? active.event
    : null;
}

function heldTradePayment(
  presentation: PresentationQueueState | null
): TradePaymentEvent | null {
  if (!presentation) return null;
  const steps = [
    ...(presentation.activeStep ? [presentation.activeStep.step] : []),
    ...presentation.pendingSteps
  ];
  const step = steps.find(
    ({ event }) => event.type === "TRADE_PAYMENT_COLLECTED"
  );
  return step?.event.type === "TRADE_PAYMENT_COLLECTED" &&
    tradePresentationStage(step) !== "SETTLE"
    ? step.event
    : null;
}

// A guardian theft reaches the player list when its coin arrives, and a
// phenomenon's money collection once its notice ends.
function heldMoneyDeltas(
  presentation: PresentationQueueState | null
): Map<string, number> {
  const held = new Map<string, number>();
  if (!presentation) return held;
  const steps = [
    ...(presentation.activeStep ? [presentation.activeStep.step] : []),
    ...presentation.pendingSteps
  ];
  const seen = new Set<number>();
  for (const step of steps) {
    const { event } = step;
    if (
      seen.has(event.eventSeq) ||
      event.type !== "RESOURCE_CHANGED" ||
      event.resource !== "MONEY"
    ) {
      continue;
    }
    const heldUntilSettled =
      event.reason === "GUARDIAN" &&
      step.kind === "TRADE" &&
      tradePresentationStage(step) !== "SETTLE";
    if (heldUntilSettled || event.reason === "PHENOMENON") {
      seen.add(event.eventSeq);
      held.set(event.playerId, (held.get(event.playerId) ?? 0) + event.delta);
    }
  }
  return held;
}

function withHeldTradeResources(
  player: PlayerPublicView,
  payment: TradePaymentEvent
): PlayerPublicView {
  if (player.playerId === payment.payerPlayerId) {
    return {
      ...player,
      hp: player.hp + payment.hpPaid,
      mp: player.mp + payment.mpPaid,
      money: player.money + payment.moneyPaid
    };
  }
  return player.playerId === payment.recipientPlayerId
    ? { ...player, money: Math.max(0, player.money - payment.price) }
    : player;
}

function exchangeBeforeAllocation(
  event: ResourcesExchangedEvent
): ExchangeAllocation {
  return {
    hp: event.hpBefore,
    mp: event.mpBefore,
    money: event.moneyBefore
  };
}

function presentationExchange(
  presentation: PresentationQueueState | null
): ExchangePresentationScene | null {
  const active = presentation?.activeStep?.step;
  if (!active) return null;
  if (
    active.kind === "EXCHANGE" &&
    active.event.type === "RESOURCES_EXCHANGED"
  ) {
    return { event: active.event, stageIndex: active.stageIndex };
  }
  if (
    active.kind !== "ACTION" ||
    active.event.type !== "ACTION_DECLARED" ||
    active.event.actionType !== "EXCHANGE_RESOURCES"
  ) {
    return null;
  }
  const { playerId } = active.event;
  const event = presentation.pendingSteps
    .map((step) => step.event)
    .find(
      (candidate): candidate is ResourcesExchangedEvent =>
        candidate.type === "RESOURCES_EXCHANGED" &&
        candidate.playerId === playerId
    );
  return event ? { event, stageIndex: null } : null;
}

function transferAfterEvent(
  presentation: PresentationQueueState,
  eventSeq: number
): TradeTransferEvent | null {
  return (
    presentation.recentEvents.find(
      (event): event is TradeTransferEvent =>
        event.type === "CARD_TRANSFERRED" && event.eventSeq > eventSeq
    ) ?? null
  );
}

function guardianHostBefore(
  presentation: PresentationQueueState,
  eventSeq: number
): string | null {
  const action = [...presentation.recentEvents]
    .reverse()
    .find(
      (event): event is GuardianActionEvent =>
        event.type === "GUARDIAN_ACTION_SELECTED" && event.eventSeq < eventSeq
    );
  return action?.playerId ?? null;
}

function presentationTrade(
  view: GameViewState,
  presentation: PresentationQueueState | null,
  nowMs: number
): TradePresentationScene | null {
  const active = presentation?.activeStep;
  if (!active || active.step.kind !== "TRADE") return null;
  const { event } = active.step;
  const stage = tradePresentationStage(active.step);
  const elapsedMs = Math.max(0, nowMs - active.startedAtMs);
  if (event.type === "RESOURCE_CHANGED") {
    const hostId = guardianHostBefore(presentation, event.eventSeq);
    if (!hostId) return null;
    const guardianName =
      playerById(view, hostId)?.guardian?.guardianName ?? null;
    return {
      kind: "GUARDIAN",
      stage,
      cardDefinitionId: null,
      guardianPortraitId:
        guardianName === null ? null : guardianPortraitId(guardianName),
      price: -event.delta,
      leftPlayerId: event.playerId,
      rightPlayerId: hostId,
      rightLabel: guardianName ?? "守護神",
      elapsedMs
    };
  }
  if (event.type !== "TRADE_PAYMENT_COLLECTED") return null;
  const transfer = transferAfterEvent(presentation, active.step.eventSeq);
  if (!transfer) return null;
  const kind = active.step.stageCount > 3 ? "BUY" : "SELL";
  // The buyer pays from the left lane; a sale's seller stays on the left and
  // the coin comes in from the (possibly bounced) payer on the right.
  return {
    kind,
    stage,
    cardDefinitionId: transfer.card.cardDefinitionId,
    guardianPortraitId: null,
    price: event.price,
    leftPlayerId:
      kind === "BUY" ? event.payerPlayerId : event.recipientPlayerId,
    rightPlayerId:
      kind === "BUY" ? event.recipientPlayerId : event.payerPlayerId,
    rightLabel: null,
    elapsedMs
  };
}

function presentationTradeOffer(
  view: GameViewState,
  presentation: PresentationQueueState | null
): TradeOfferScene | null {
  const active = presentation?.activeStep?.step;
  if (!active) {
    const pending = view.pendingTrade;
    return pending
      ? {
          actorId: pending.actorId,
          targetPlayerId: pending.targetPlayerId,
          cardDefinitionId: pending.offeredCardDefinitionId,
          notice: null,
          dreamRevealed: false
        }
      : null;
  }
  if (active.kind !== "TRADE") return null;
  const { event } = active;
  const offer =
    event.type === "TRADE_OFFERED"
      ? event
      : event.type === "TRADE_RESOLVED" && event.resolution !== "ACCEPTED"
        ? presentation.recentEvents.find(
            (candidate): candidate is TradeOfferedEvent =>
              candidate.type === "TRADE_OFFERED" &&
              candidate.tradeId === event.tradeId
          ) ?? null
        : null;
  if (!offer) return null;
  return {
    actorId: offer.actorId,
    targetPlayerId: offer.targetPlayerId,
    cardDefinitionId: offer.offeredCardDefinitionId,
    notice:
      event.type === "TRADE_RESOLVED" && event.resolution !== "ACCEPTED"
        ? event.resolution
        : null,
    dreamRevealed: event.type === "TRADE_OFFERED" && offer.dreamRevealed
  };
}

function activeSaleProductDefinitionId(
  view: GameViewState,
  presentation: PresentationQueueState | null
): string | null {
  const active = presentation?.activeStep?.step;
  if (active?.kind === "TRADE") return null;
  if (active?.kind === "ACTION" && active.event.type === "ACTION_DECLARED") {
    return active.stageIndex > 0
      ? active.event.saleProductCardDefinitionId ?? null
      : null;
  }
  if (!presentation || !active) {
    return view.pendingAttack?.saleProduct?.cardDefinitionId ?? null;
  }
  const declared = [...presentation.recentEvents]
    .reverse()
    .find(
      (event) =>
        event.eventSeq <= active.eventSeq && event.type === "ACTION_DECLARED"
    );
  return declared?.type === "ACTION_DECLARED"
    ? declared.saleProductCardDefinitionId ?? null
    : null;
}

function presentationTradeFinished(
  presentation: PresentationQueueState | null
): boolean {
  const active = presentation?.activeStep?.step;
  if (!presentation || !active) return false;
  const latest = [...presentation.recentEvents]
    .reverse()
    .find(
      ({ eventSeq, type }) =>
        eventSeq <= active.eventSeq &&
        (type === "ACTION_DECLARED" || type === "TRADE_RESOLVED")
    );
  return latest?.type === "TRADE_RESOLVED";
}

function renderTradeSwap(scene: TradePresentationScene): string {
  const { kind, stage } = scene;
  const showsCoin =
    stage === "PRICE" || stage === "SWAP" || stage === "SETTLE";
  return `
    <div
      class="gf-trade-swap"
      data-trade-kind="${kind}"
      data-trade-stage="${stage}"
      style="--gf-trade-delay: ${-scene.elapsedMs}ms"
    >
      ${
        scene.cardDefinitionId === null
          ? ""
          : renderFieldCard(scene.cardDefinitionId, "gf-trade-swap__product")
      }
      ${
        kind === "GUARDIAN"
          ? scene.guardianPortraitId
            ? renderCardArt(scene.guardianPortraitId, "♜", "gf-trade-swap__guardian")
            : '<span class="gf-trade-swap__guardian" aria-hidden="true">♜</span>'
          : ""
      }
      ${showsCoin ? `<strong class="gf-trade-swap__coin">¥${scene.price}</strong>` : ""}
      ${stage === "STAMP" ? '<strong class="gf-trade-swap__stamp" role="status">買う</strong>' : ""}
      ${kind === "SELL" ? '<strong class="gf-action__forgive gf-action__forgive--trade" role="status">許す</strong>' : ""}
    </div>`;
}

const TRADE_OFFER_NOTICES = {
  DECLINED: "買わない",
  INSUFFICIENT_RESOURCES: "貧乏"
} as const;

function renderTradeOffer(offer: TradeOfferScene, effectDelayStyle: string): string {
  return `
    <div class="gf-trade-swap" data-trade-kind="BUY" data-trade-stage="OFFER">
      ${renderFieldCard(offer.cardDefinitionId, "gf-trade-swap__product")}
      ${
        offer.dreamRevealed
          ? `<div
              class="gf-action__result"
              data-result="trade-notice"
              data-placement="target"
              style="${effectDelayStyle}"
              role="status"
            ><strong>夢が覚めた</strong></div>`
          : ""
      }
      ${
        offer.notice
          ? `<div
              class="gf-action__result"
              data-result="trade-notice"
              data-placement="actor"
              style="${effectDelayStyle}"
              role="status"
            ><strong>${TRADE_OFFER_NOTICES[offer.notice]}</strong></div>`
          : ""
      }
    </div>`;
}

function presentationEffectDelayStyle(
  presentation: PresentationQueueState | null,
  nowMs: number
): string {
  const startedAtMs = presentation?.activeStep?.startedAtMs ?? nowMs;
  return `--gf-effect-delay: ${-Math.max(0, nowMs - startedAtMs)}ms`;
}

function renderResourceEffectLabel(effect: ResourceChangedEvent): string {
  if (effect.delta > 0) {
    return `<strong>${effect.resource}${effect.delta}</strong>`;
  }
  return effect.resource === "HP"
    ? `<strong>${-effect.delta}</strong><span>ダメージ</span>`
    : `<strong>${effect.delta}${effect.resource.toLowerCase()}</strong>`;
}

function isTradeAttack(sourceCardDefinitionIds: readonly string[]): boolean {
  return sourceCardDefinitionIds.some(
    (cardDefinitionId) =>
      cardDefinitionId === "sell" || cardDefinitionId === "buy"
  );
}

function renderActionRegion(
  view: GameViewState,
  ui: UiInteractionState,
  presentation: PresentationQueueState | null,
  nowMs: number
): string {
  const pendingAttack = view.pendingAttack;
  const activePresentationKind =
    presentation?.activeStep?.step.kind ?? null;
  const queuedPresentedAttack = presentationAttackScene(presentation);
  const presentedAttack = queuedPresentedAttack;
  const locksPresentedAttack =
    presentedAttack !== null &&
    (presentedAttack.redirectMove ||
      ["HIT_RESULT", "REACTION", "DAMAGE_RESULT", "HP_UPDATE", "CALAMITY"].includes(
        presentedAttack.stageKind
      ));
  const activeEvent = presentation?.activeStep?.step.event;
  const pendingMatchesActivePresentation =
    pendingAttack !== null &&
    (
      presentedAttack?.attackEvent.attack.attackId ===
        pendingAttack.attackId ||
      (
        activeEvent?.type === "ACTION_DECLARED" &&
        activeEvent.actionType === "DECLARE_ACTION" &&
        activeEvent.playerId === pendingAttack.actorId &&
        activeEvent.targetPlayerId === pendingAttack.targetPlayerId
      )
    );
  // A realtime batch can already contain the following CPU attack while an
  // earlier attack is still being presented. Only use the authoritative
  // pending attack when it belongs to the presentation currently on screen.
  const authoritativePendingAttack =
    activePresentationKind === null || pendingMatchesActivePresentation
      ? pendingAttack
      : null;
  const guardianAction = presentationGuardianAction(presentation);
  const ascensionBow = presentationAscensionBow(presentation);
  const confusionStarted =
    activeEvent?.type === "CONFUSION_ACTIONS_STARTED";
  const activeResourceEffect = presentationResourceEffect(presentation);
  const exchangeScene = presentationExchange(presentation);
  const exchangeDraft = activeExchangeDraft(view, ui);
  const showsExchange = exchangeScene !== null || exchangeDraft !== null;
  const tradeDraft = activeTradeDraft(view, ui);
  const handActionDraft = activeHandActionDraft(view, ui);
  const tradeScene = presentationTrade(view, presentation, nowMs);
  const offeredTrade = presentationTradeOffer(view, presentation);
  const saleProductDefinitionId = activeSaleProductDefinitionId(
    view,
    presentation
  );
  const resourceEffectUsesRecentCard =
    activeResourceEffect === null ||
    activeResourceEffect.reason === "CARD_EFFECT" ||
    activeResourceEffect.reason === "MIRACLE";
  const recentCardUseCandidate =
    !presentedAttack &&
    !guardianAction &&
    !ascensionBow &&
    resourceEffectUsesRecentCard &&
    (!pendingAttack || activePresentationKind === "ACTION") &&
    ui.selectedActionCardIds.length === 0 &&
    ui.selectedLearnedMiracleIds.length === 0 &&
    ui.handActionMode === null
      ? latestRecentCardUseScene(presentation)
      : null;
  const recentCardUse = recentCardUseCandidate;
  const actorId =
    tradeScene?.leftPlayerId ??
    offeredTrade?.actorId ??
    (locksPresentedAttack ? presentedAttack.actorId : null) ??
    authoritativePendingAttack?.actorId ??
    presentedAttack?.actorId ??
    ascensionBow?.event.playerId ??
    guardianAction?.playerId ??
    recentCardUse?.actorId ??
    pendingAttack?.actorId ??
    view.actingPlayerId;
  const selectedTargetId =
    tradeScene?.rightPlayerId ??
    offeredTrade?.targetPlayerId ??
    (locksPresentedAttack ? presentedAttack.targetPlayerId : null) ??
    authoritativePendingAttack?.targetPlayerId ??
    presentedAttack?.targetPlayerId ??
    ascensionBow?.event.targetPlayerId ??
    guardianAction?.targetPlayerId ??
    activeResourceEffect?.playerId ??
    (recentCardUse
      ? recentCardUse.targetPlayerId
      : ui.selectedTargetIds[0] ??
        pendingAttack?.targetPlayerId ??
        view.targetPlayerIds[0] ??
        null);
  const actor = playerById(view, actorId);
  const target = playerById(view, selectedTargetId);
  const presentedCardDefinitionIds = locksPresentedAttack
    ? [...presentedAttack.attackEvent.attack.sourceCardDefinitionIds]
    : authoritativePendingAttack
      ? [...authoritativePendingAttack.sourceCardDefinitionIds]
      : presentedAttack
        ? [...presentedAttack.attackEvent.attack.sourceCardDefinitionIds]
        : ascensionBow
          ? ["ascension-bow"]
        : guardianAction
          ? [guardianAction.actionCardDefinitionId]
          : recentCardUse
            ? [...recentCardUse.actionCardDefinitionIds]
            : handActionDraft
              ? handActionDefinitionIds(view, ui, handActionDraft)
              : exchangeDraft
              ? exchangeCardDefinitionIds(view, exchangeDraft)
              : tradeDraft
                ? tradeDraftDefinitionIds(view, tradeDraft)
                : selectedActionDefinitionIds(view, ui);
  const actionCardDefinitionIds = revealStagedCards(
    (tradeScene?.kind === "BUY" && tradeScene.stage !== "OFFER") ||
      tradeScene?.kind === "GUARDIAN"
      ? []
      : saleProductDefinitionId !== null &&
          presentedCardDefinitionIds.includes("sell")
        ? [...presentedCardDefinitionIds, saleProductDefinitionId]
        : presentedCardDefinitionIds,
    presentation,
    "ACTION_DECLARED"
  );
  const preview = actionPreview(ui, view);
  const canPray =
    !ui.interactionLocked &&
    ui.mode === "COMPOSING_ACTION" &&
    ui.selectedActionCardIds.length === 0 &&
    ui.selectedLearnedMiracleIds.length === 0 &&
    exchangeDraft === null &&
    tradeDraft === null &&
    handActionDraft === null &&
    (view.self?.legalActions.some(({ type }) => type === "PRAY") ?? false);
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
      : revealStagedCards(
          allDefenseDefinitionIds,
          presentation,
          "REACTION_DECLARED"
        );
  // The mortar holder's 「あぶないウス」 is drawn beside the pestle that found it.
  const showsDangerousMortar =
    presentedAttack !== null &&
    presentedAttack.dangerousMortar &&
    ["DAMAGE_RESULT", "HP_UPDATE", "CALAMITY"].includes(
      presentedAttack.stageKind
    );
  const showForgive =
    presentedAttack !== null &&
    !showsDangerousMortar &&
    ["REACTION", "DAMAGE_RESULT", "HP_UPDATE", "CALAMITY"].includes(
      presentedAttack.stageKind
    ) &&
    presentedAttack.reaction !== null &&
    allDefenseDefinitionIds.length === 0;
  const attackPower =
    (locksPresentedAttack
      ? presentedAttack.attackEvent.attack.power
      : null) ??
    authoritativePendingAttack?.power ??
    presentedAttack?.attackEvent.attack.power ??
    (ascensionBow ? ASCENSION_BOW_POWER : null) ??
    recentCardUse?.attack?.power ??
    pendingAttack?.power ??
    preview.attackPower;
  const defensePower = revealStagedDefensePower(
    locksPresentedAttack
      ? presentedAttack.reaction?.defensePower ?? null
      : ui.mode === "COMPOSING_REACTION"
      ? reaction.totalDefense
      : presentedAttack?.reaction?.defensePower ??
        recentCardUse?.defensePower ??
        null,
    presentation
  );
  const displayedAttack =
    (locksPresentedAttack
      ? presentedAttack.attackEvent.attack
      : null) ??
    authoritativePendingAttack ??
    presentedAttack?.attackEvent.attack ??
    recentCardUse?.attack ??
    pendingAttack;
  // Every render rebuilds the DOM, so overlays resume from the elapsed step time
  // instead of replaying their entrance.
  const effectDelayStyle = presentationEffectDelayStyle(presentation, nowMs);
  // The attacker's cards always sit in the left column; defense and reflect
  // cards take the right one. A deflected attack slides back in from the right.
  const attackSide = "left";
  const redirectMoveStyle = presentedAttack?.redirectMove
    ? `${effectDelayStyle}; --gf-redirect-ms: ${presentation?.profile.redirectMoveMs ?? 0}ms`
    : "";
  const direction = actor && target
    ? `${actor.displayName} から ${target.displayName}`
    : actor
      ? `${actor.displayName} の行動`
      : "行動待ち";
  const showRoute = showsExchange || !(
    presentationTradeFinished(presentation) ||
    (activePresentationKind === "ACTION" &&
      recentCardUse !== null) ||
    (activeResourceEffect !== null &&
      presentedAttack === null &&
      (recentCardUse === null ||
        (recentCardUse.targetPlayerId ?? recentCardUse.actorId) ===
          recentCardUse.actorId))
  );
  const displayedResourceEffect =
    activeResourceEffect ?? recentCardUse?.recovery ?? null;
  return `
    <section
      class="gf-panel gf-action"
      data-region="action"
      data-attack-id="${escapeHtml(displayedAttack?.attackId ?? "")}"
      data-attack-target-index="${displayedAttack ? displayedAttack.targetIndex + 1 : ""}"
      data-attack-target-count="${displayedAttack?.totalTargets ?? ""}"
      data-presentation-scene="${presentedAttack ? "attack" : ascensionBow ? "ascension-bow" : guardianAction ? "guardian" : recentCardUse ? "recent-card-use" : "none"}"
      data-presentation-stage="${activePresentationKind ?? "NONE"}"
      data-has-defense="${String(selectedDefenseDefinitionIds.length > 0 || defensePower !== null)}"
      data-has-route="${String(showRoute && Boolean(actor && (target || showsExchange)))}"
      data-exchange="${String(showsExchange)}"
      data-hand-action="${String(
        handActionDraft !== null ||
          actionCardDefinitionIds[0] === "discard" ||
          actionCardDefinitionIds[0] === "sacrifice"
      )}"
      data-trade="${String(
        tradeScene !== null ||
          offeredTrade !== null ||
          isTradeAttack(actionCardDefinitionIds)
      )}"
      aria-labelledby="gf-action-title"
      aria-live="polite"
    >
      <div class="gf-section-heading">
        <p class="gf-section-heading__eyebrow">Action</p>
        <h2 id="gf-action-title">行動</h2>
      </div>
      ${
        showRoute
          ? `<div
              class="gf-action__route"
              ${presentedAttack?.redirectMove ? 'data-route-staged="true"' : ""}
              style="${redirectMoveStyle}"
              aria-hidden="true"
            >
              <span class="gf-action__actor">${
                guardianAction
                  ? escapeHtml(actor?.guardian?.guardianName ?? "守護神")
                  : escapeHtml(actor?.displayName ?? "行動待ち")
              }</span>
              ${
                showsExchange
                  ? ""
                  : `<span class="gf-action__arrow">➜</span>
              <span class="gf-action__target">${escapeHtml(tradeScene?.rightLabel ?? target?.displayName ?? "対象を選択")}</span>`
              }
            </div>`
          : ""
      }
      <p class="gf-action__direction sr-only">${escapeHtml(direction)}</p>
      ${
        recentCardUse
          ? `<p class="gf-action__activity${showsExchange || isTradeAttack(recentCardUse.actionCardDefinitionIds) ? " sr-only" : ""}" role="status">${escapeHtml(
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
      <div
        class="gf-action__content"
        data-attack-side="${attackSide}"
        aria-label="攻防プレビュー"
      >
        <div
          class="gf-action__stack gf-action__stack--attack"
          ${presentedAttack?.redirectMove ? 'data-redirect-move="true"' : ""}
          style="${redirectMoveStyle}"
          ${actionCardDefinitionIds.length > 3 ? 'data-stacked="true"' : ""}
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
        ${
          exchangeDraft
            ? '<button type="button" class="gf-action__confirm" data-submit-exchange>両替する</button>'
            : handActionDraft
              ? `<button
          type="button"
          class="gf-action__confirm"
          data-submit-hand-action
          ${ui.selectedHandActionCardIds.length > 0 ? "" : "disabled"}
        >${handActionDraft === "DISCARD" ? "選んだ神器を捨てる" : "選んだ神器をささげる"}</button>`
            : tradeDraft
              ? `<button
          type="button"
          class="gf-action__confirm"
          data-submit-trade
          ${canSubmitTrade(ui, view) ? "" : "disabled"}
        >${tradeDraft.type === "SELL_CARD" ? "売る" : "買う"}</button>`
              : `<button
          type="button"
          class="gf-action__confirm"
          data-submit-action
          ${preview.canSubmit ? "" : "disabled"}
          ${preview.invalidReason ? `title="${escapeHtml(preview.invalidReason)}"` : ""}
        >行動を確定</button>`
        }
        <button
          type="button"
          class="gf-action__pray"
          data-submit-pray
          ${canPray ? "" : "disabled"}
          title="${canPray ? "神器を1枚授与されます" : "使用可能な武器があるか、現在は行動できません"}"
        >祈る</button>
        <div
          class="gf-action__stack gf-action__stack--defense"
          data-card-lane="defense"
          ${selectedDefenseDefinitionIds.length > 3 ? 'data-stacked="true"' : ""}
          aria-label="防御に使用したカード"
        >
          ${selectedDefenseDefinitionIds
            .map((cardDefinitionId) =>
              renderFieldCard(
                cardDefinitionId,
                (presentedAttack?.handRedrawLead &&
                  redrawsHand(cardDefinitionId)) ||
                  (presentedAttack?.defensePenalty &&
                    presentedAttack.calamity?.type === "CALAMITY_APPLIED" &&
                    inflictsOwnCalamity(
                      cardDefinitionId,
                      presentedAttack.calamity.calamity
                    ))
                  ? "gf-field-card--defense gf-field-card--effect-source"
                  : "gf-field-card--defense"
              )
            )
            .join("")}
          ${
            showsDangerousMortar
              ? renderFieldCard(
                  "dangerous-mortar",
                  "gf-field-card--defense gf-field-card--mortar"
                )
              : ""
          }
          ${
            showForgive
              ? `<strong class="gf-action__forgive${
                  isTradeAttack(
                    presentedAttack.attackEvent.attack.sourceCardDefinitionIds
                  )
                    ? " gf-action__forgive--trade"
                    : ""
                }" data-polarity="negative" role="status">許す</strong>`
              : ""
          }
        </div>
        ${exchangeDraft ? renderExchangePanel(view, exchangeDraft) : ""}
        ${exchangeScene ? renderExchangeResult(exchangeScene) : ""}
        ${
          tradeScene
            ? renderTradeSwap(tradeScene)
            : offeredTrade
              ? renderTradeOffer(offeredTrade, effectDelayStyle)
              : ""
        }
        ${
          presentedAttack?.deflectNotice
            ? `<div
                class="gf-action__result"
                data-result="deflect"
                data-placement="defense-${attackSide === "left" ? "right" : "left"}"
                style="${effectDelayStyle}"
                role="status"
              ><strong>${
                presentedAttack.deflectNotice.redirectType === "REFLECT"
                  ? "跳ね返した"
                  : "弾いた"
              }</strong></div>`
            : ""
        }
        ${
          presentedAttack?.stopped
            ? `<div
                class="gf-action__result"
                data-result="stopped"
                data-polarity="neutral"
                style="${effectDelayStyle}"
                role="status"
              ><strong>止めた</strong></div>`
            : ""
        }
        ${
          presentedAttack?.stageKind === "HIT_RESULT" &&
          presentedAttack.hitRoll
            ? `<div
                class="gf-action__result"
                data-result="${presentedAttack.hitRoll.hit ? "hit" : "miss"}"
                style="${effectDelayStyle}"
                role="status"
              ><strong>${presentedAttack.hitRoll.hit ? "命中" : "外れた"}</strong></div>`
            : ""
        }
        ${
          ascensionBow?.showsHitResult
            ? `<div
                class="gf-action__result"
                data-result="${ascensionBow.event.hit ? "hit" : "miss"}"
                style="${effectDelayStyle}"
                role="status"
              ><strong>${ascensionBow.event.hit ? "命中" : "外れた"}</strong></div>`
            : ""
        }
        ${
          presentedAttack?.stageKind === "DAMAGE_RESULT" &&
          presentedAttack.damage &&
          !presentedAttack.calamity
            ? `<div
                class="gf-action__result"
                data-result="${presentedAttack.damage.amount === 0 ? "safe" : "damage"}"
                ${presentedAttack.darkDamage ? 'data-element="DARK"' : ""}
                data-polarity="${presentedAttack.damage.amount === 0 ? "neutral" : "negative"}"
                style="${effectDelayStyle}"
                role="status"
              >${
                presentedAttack.damage.amount === 0
                  ? "<strong>無事</strong>"
                  : `<strong>${presentedAttack.damage.amount}</strong><span>ダメージ</span>`
              }</div>`
            : ""
        }
        ${
          displayedResourceEffect
            ? `<div
                class="gf-action__result"
                data-result="${displayedResourceEffect.delta > 0 ? "recovery" : "damage"}"
                data-polarity="${displayedResourceEffect.delta > 0 ? "positive" : "negative"}"
                data-resource="${displayedResourceEffect.resource.toLowerCase()}"
                data-player-id="${escapeHtml(displayedResourceEffect.playerId)}"
                data-placement="${recentCardUse !== null && !showRoute ? "actor" : "target"}"
                style="${effectDelayStyle}"
                role="status"
              >${renderResourceEffectLabel(displayedResourceEffect)}</div>`
            : ""
        }
        ${
          confusionStarted
            ? `<div
                class="gf-action__effect"
                data-effect="confusion"
                style="${effectDelayStyle}"
                role="status"
              ><strong>御乱心</strong></div>`
            : ""
        }
        ${
          presentedAttack?.handRedraw
            ? `<div
                class="gf-action__effect"
                data-effect="hand-redraw"
                data-player-id="${escapeHtml(presentedAttack.handRedraw.playerId)}"
                style="${effectDelayStyle}"
                role="status"
              ><strong>神器一新</strong></div>`
            : ""
        }
        ${
          presentedAttack?.calamity
            ? `<div
                class="gf-action__effect"
                data-effect="calamity"
                data-calamity="${
                  presentedAttack.calamity.type === "CALAMITY_APPLIED"
                    ? presentedAttack.calamity.calamity
                    : presentedAttack.calamity.to ?? presentedAttack.calamity.from
                }"
                style="${effectDelayStyle}"
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
      <dl class="gf-action__summary" aria-label="選択中の行動値" data-element="${
        displayedAttack?.element ?? preview.element ?? "NONE"
      }">
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
        !showForgive &&
        (ui.mode === "COMPOSING_REACTION" ||
          presentedAttack?.stageKind === "REACTION" ||
          presentedAttack?.stageKind === "DAMAGE_RESULT" ||
          presentedAttack?.stageKind === "CALAMITY" ||
          (recentCardUse?.defensePower ?? null) !== null)
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
    // The offered card itself is shown on the field, so only the buttons are
    // visible here; the subject and payment stay for screen readers.
    content = `
      <article class="gf-trade-offer" data-trade-id="${escapeHtml(trade.tradeId)}">
        <p class="gf-response__subject">
          ${escapeHtml(seller?.displayName ?? "相手")}からの商品 ${escapeHtml(offeredText.name)}
        </p>
        <dl class="gf-response__summary" aria-label="購入時の支払い見込み">
          <div><dt>価格</dt><dd>¥${payment.price}</dd></div>
          <div><dt>所持金</dt><dd>${payment.money}</dd></div>
          <div><dt>MP</dt><dd>${payment.mp}</dd></div>
          <div><dt>HP</dt><dd>${payment.hp}</dd></div>
        </dl>
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

// The result appears once every effect, ascension included, has played; only
// the closing RESULT beat itself may still be running.
function presentationHoldsResult(
  presentation: PresentationQueueState | null
): boolean {
  if (!presentation) return false;
  const blocking = (step: { kind: string }): boolean => step.kind !== "RESULT";
  return (
    (presentation.activeStep !== null &&
      blocking(presentation.activeStep.step)) ||
    presentation.pendingSteps.some(blocking)
  );
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
  if (ui.inputDeadlineExpired) return "";
  const remainingSeconds = inputDeadlineRemainingSeconds(ui, nowMs);
  if (remainingSeconds === null || !isHumanInputMode(ui.mode)) return "";
  const remainingMs = Math.max(
    0,
    Date.parse(ui.inputDeadlineAt ?? "") - nowMs
  );
  const elapsedMs = Math.min(
    INPUT_DEADLINE_TOTAL_MS,
    Math.max(0, INPUT_DEADLINE_TOTAL_MS - remainingMs)
  );
  return `
    <div
      class="gf-input-status gf-input-status--deadline"
      data-input-deadline="${escapeHtml(ui.inputDeadlineAt ?? "")}"
      data-remaining-seconds="${remainingSeconds}"
      role="timer"
      aria-label="残り ${remainingSeconds}秒"
    >
      <span
        class="gf-input-status__bar"
        style="--gf-deadline-total: ${INPUT_DEADLINE_TOTAL_MS}ms; --gf-deadline-elapsed: -${Math.round(elapsedMs)}ms"
      ></span>
    </div>`;
}

type AdjustableExchangeResource = "mp" | "money";

export function adjustExchangeAllocation(
  current: ExchangeAllocation,
  resourceTotal: number,
  resource: AdjustableExchangeResource,
  delta: number
): ExchangeAllocation | null {
  if (
    !Number.isInteger(resourceTotal) ||
    !Number.isInteger(delta) ||
    ![current.hp, current.mp, current.money].every(Number.isInteger)
  ) {
    return null;
  }
  const mp = resource === "mp" ? current.mp + delta : current.mp;
  const money =
    resource === "money" ? current.money + delta : current.money;
  const hp = resourceTotal - mp - money;
  if (
    [hp, mp, money].some(
      (value) => value < 0 || value > 99
    )
  ) {
    return null;
  }
  return { hp, mp, money };
}

function renderExchangeAdjustButton(
  allocation: ExchangeAllocation,
  resourceTotal: number,
  resource: AdjustableExchangeResource,
  delta: number
): string {
  const resourceLabel = resource === "mp" ? "MP" : "所持金";
  const directionLabel = delta > 0 ? "増やす" : "減らす";
  const disabled =
    adjustExchangeAllocation(
      allocation,
      resourceTotal,
      resource,
      delta
    ) === null;
  return `<button
    type="button"
    class="gf-exchange__adjust"
    data-exchange-adjust="${resource}:${delta}"
    data-exchange-row="${delta > 0 ? (delta === 10 ? 1 : 2) : delta === -1 ? 4 : 5}"
    data-exchange-column="${resource === "mp" ? 1 : 2}"
    aria-label="${resourceLabel}を${Math.abs(delta)}${directionLabel}"
    ${disabled ? "disabled" : ""}
  >${delta > 0 ? "+" : ""}${delta}</button>`;
}

function renderExchangeReadout(
  allocation: ExchangeAllocation,
  row: "before" | "after",
  outputs = false
): string {
  const value = (name: keyof ExchangeAllocation): string =>
    outputs
      ? `<output data-exchange-output="${name}">${allocation[name]}</output>`
      : `<b>${allocation[name]}</b>`;
  return `<div class="gf-exchange__readout" data-exchange-row="${row}">
    <span>HP ${value("hp")}</span>
    <span>MP ${value("mp")}</span>
    <span>¥ ${value("money")}</span>
  </div>`;
}

function activeTradeDraft(
  view: GameViewState,
  ui: UiInteractionState
): TradeDraft | null {
  return view.self &&
    ui.mode === "COMPOSING_ACTION" &&
    !ui.interactionLocked &&
    !ui.inputDeadlineExpired
    ? ui.tradeDraft
    : null;
}

function tradeDraftDefinitionIds(
  view: GameViewState,
  draft: TradeDraft
): string[] {
  return [draft.cardInstanceId, draft.productCardInstanceId].flatMap(
    (instanceId) =>
      view.self?.hand
        .filter((card) => card.instanceId === instanceId)
        .map(({ cardDefinitionId }) => cardDefinitionId) ?? []
  );
}

function activeExchangeDraft(
  view: GameViewState,
  ui: UiInteractionState
): ExchangeDraft | null {
  return view.self &&
    ui.mode === "COMPOSING_ACTION" &&
    !ui.interactionLocked &&
    !ui.inputDeadlineExpired
    ? ui.exchangeDraft
    : null;
}

// While a multi-card declaration is on screen, only the cards whose stage has
// started are shown; each later stage adds the next card to the stack.
function revealStagedCards(
  cardDefinitionIds: string[],
  presentation: PresentationQueueState | null,
  eventType: "ACTION_DECLARED" | "REACTION_DECLARED"
): string[] {
  const active = presentation?.activeStep?.step;
  if (
    !active ||
    active.event.type !== eventType ||
    active.stageCount < 2 ||
    (active.event.type === "ACTION_DECLARED" &&
      active.event.actionType === "SELL_CARD")
  ) {
    return cardDefinitionIds;
  }
  return cardDefinitionIds.slice(0, active.stageIndex + 1);
}

// The defense total climbs with the staged defense stack instead of showing
// the final value before every card has joined it.
function revealStagedDefensePower(
  defensePower: number | null,
  presentation: PresentationQueueState | null
): number | null {
  const active = presentation?.activeStep?.step;
  if (
    defensePower === null ||
    !active ||
    active.event.type !== "REACTION_DECLARED" ||
    active.stageCount < 2 ||
    !active.event.defenseValues
  ) {
    return defensePower;
  }
  return active.event.defenseValues
    .slice(0, active.stageIndex + 1)
    .reduce((total, value) => total + value, 0);
}

function activeHandActionDraft(
  view: GameViewState,
  ui: UiInteractionState
): "DISCARD" | "SACRIFICE" | null {
  if (
    ui.mode !== "COMPOSING_ACTION" ||
    ui.interactionLocked ||
    ui.inputDeadlineExpired ||
    ui.handActionMode === null
  ) {
    return null;
  }
  return view.self?.legalActions.some(({ type }) => type === ui.handActionMode)
    ? ui.handActionMode
    : null;
}

function handActionCardDefinitionId(type: "DISCARD" | "SACRIFICE"): string {
  return type === "DISCARD" ? "discard" : "sacrifice";
}

function handActionDefinitionIds(
  view: GameViewState,
  ui: UiInteractionState,
  type: "DISCARD" | "SACRIFICE"
): string[] {
  return [
    handActionCardDefinitionId(type),
    ...ui.selectedHandActionCardIds.flatMap(
      (instanceId) =>
        view.self?.hand
          .filter((card) => card.instanceId === instanceId)
          .map(({ cardDefinitionId }) => cardDefinitionId) ?? []
    )
  ];
}

function exchangeCardDefinitionIds(
  view: GameViewState,
  draft: ExchangeDraft
): string[] {
  const card = view.self?.hand.find(
    ({ instanceId }) => instanceId === draft.cardInstanceId
  );
  return card ? [card.cardDefinitionId] : [];
}

function renderExchangePanel(
  view: GameViewState,
  draft: ExchangeDraft
): string {
  const action = view.self?.legalActions.find(
    ({ type }) => type === "EXCHANGE_RESOURCES"
  );
  if (action?.type !== "EXCHANGE_RESOURCES") return "";
  const total = action.resourceTotal;
  const adjustments: [AdjustableExchangeResource, number][] = [
    ["mp", 10],
    ["money", 10],
    ["mp", 1],
    ["money", 1],
    ["mp", -1],
    ["money", -1],
    ["mp", -10],
    ["money", -10]
  ];
  return `
    <div
      class="gf-exchange"
      data-exchange-total="${total}"
      role="group"
      aria-label="両替"
      aria-live="polite"
    >
      ${renderExchangeReadout(draft, "before", true)}
      ${adjustments
        .map(([resource, delta]) =>
          renderExchangeAdjustButton(draft, total, resource, delta)
        )
        .join("")}
    </div>`;
}

function renderExchangeResult(scene: ExchangePresentationScene): string {
  const { event, stageIndex } = scene;
  if (stageIndex === null) return "";
  return `
    <div class="gf-exchange" data-exchange-result-stage="${stageIndex}" role="status">
      ${renderExchangeReadout(exchangeBeforeAllocation(event), "before")}
      ${stageIndex >= 1 ? '<span class="gf-exchange__arrow" aria-hidden="true"></span>' : ""}
      ${
        stageIndex >= 2
          ? renderExchangeReadout(
              {
                hp: event.hpAfter,
                mp: event.mpAfter,
                money: event.moneyAfter
              },
              "after"
            )
          : ""
      }
    </div>`;
}

function renderHandActionToggle(
  view: GameViewState,
  ui: UiInteractionState
): string {
  if (
    !view.self ||
    ui.mode !== "COMPOSING_ACTION" ||
    ui.interactionLocked ||
    ui.inputDeadlineExpired ||
    ui.tradeDraft !== null
  ) {
    return "";
  }
  const action = view.self.legalActions.find(
    ({ type }) => type === "DISCARD" || type === "SACRIFICE"
  );
  if (action?.type !== "DISCARD" && action?.type !== "SACRIFICE") return "";
  const active = ui.handActionMode === action.type;
  const label = action.type === "DISCARD" ? "捨てる" : "ささげる";
  return `<button
    type="button"
    class="gf-hand-action-toggle"
    data-toggle-hand-action="${action.type}"
    aria-pressed="${String(active)}"
    aria-label="${label}"
    title="${active ? `${label}カードを選択中` : `${label}モードに切り替える`}"
  ><svg class="gf-hand-action-toggle__icon" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="11" y="7" width="18" height="26" />
      <path d="M11 15.67h18M11 24.33h18" />
    </svg></button>`;
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
      if (event.resource === "MONEY" && event.reason === "PHENOMENON") {
        return { eyebrow: "Phenomenon", title: "全員円没収", detail: "" };
      }
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
      if (!event.acted) return null;
      const guardian =
        playerById(view, event.playerId)?.guardian?.guardianName ??
        "守護神";
      return {
        eyebrow: "Guardian",
        title: `${eventPlayerName(view, event.playerId)}の${guardian}`,
        detail: "行動します"
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
        title: CALAMITY_LABELS[event.disease],
        detail: eventPlayerName(view, event.playerId)
      };
    case "CALAMITY_WORSENED":
      return {
        eyebrow: "Disease",
        title: event.to ? CALAMITY_LABELS[event.to] : "HP0",
        detail: eventPlayerName(view, event.playerId)
      };
    case "HAND_REDRAWN":
      return {
        eyebrow: "Renewal",
        title: "神器一新",
        detail: eventPlayerName(view, event.playerId)
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

function renderGuardianSummon(
  presentation: PresentationQueueState,
  event: Extract<DomainEvent, { type: "GUARDIAN_ASSIGNED" }>
): string {
  const portraitId = guardianPortraitId(event.guardian.guardianName);
  if (!portraitId) return "";
  const delay = presentationEffectDelayStyle(presentation, Date.now());
  return `<div
      class="gf-guardian-summon"
      data-guardian-summon="${escapeHtml(event.playerId)}"
      style="--gf-summon-ms: ${presentation.activeStep?.step.durationMs ?? 0}ms; ${delay}"
      aria-hidden="true"
    >${renderCardArt(portraitId, "♜", "gf-guardian-summon__art")}</div>`;
}

export function renderPresentationRegion(
  view: GameViewState,
  presentation: PresentationQueueState | null
): string {
  if (!presentation?.activeStep) return "";
  const summon = presentationGuardianAssigned(presentation);
  if (summon) {
    const copy = presentationCopy(view, presentation);
    return `${renderGuardianSummon(presentation, summon)}
    <aside
      class="gf-presentation"
      data-region="presentation"
      data-presentation-kind="GUARDIAN"
      data-event-seq="${presentation.activeStep.step.eventSeq}"
      data-central="false"
      role="status"
      aria-live="assertive"
      aria-atomic="true"
    >
      <p class="gf-presentation__eyebrow">${escapeHtml(copy?.eyebrow ?? "Guardian")}</p>
      <strong class="gf-presentation__title">${escapeHtml(copy?.title ?? "")}</strong>
      <p class="gf-presentation__detail">${escapeHtml(copy?.detail ?? "")}</p>
    </aside>`;
  }
  if (presentationResourceEffect(presentation)) return "";
  if (presentation.activeStep.step.kind === "TRADE") return "";
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
  nowMs = Date.now(),
  hoveredCardDefinitionId: string | null = null,
  showCastMiracles = false
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
  const heldTurnPlayerId = presentationTurnPlayerId(visiblePresentation);
  const presentedExchange = presentationExchange(visiblePresentation);
  const presentedPayment = heldTradePayment(visiblePresentation);
  const turnHeldView =
    heldTurnPlayerId === null
      ? view
      : {
          ...view,
          activePlayerId: heldTurnPlayerId,
          actingPlayerId: heldTurnPlayerId
        };
  // The exchanged resources reach the player list once the staged reveal ends.
  const exchangeHeldView = presentedExchange
    ? {
        ...turnHeldView,
        players: turnHeldView.players.map((player) =>
          player.playerId === presentedExchange.event.playerId
            ? {
                ...player,
                ...exchangeBeforeAllocation(presentedExchange.event)
              }
            : player
        )
      }
    : turnHeldView;
  // A trade reaches the player list when the coin arrives at the recipient.
  const paymentHeldView = presentedPayment
    ? {
        ...exchangeHeldView,
        players: exchangeHeldView.players.map((player) =>
          withHeldTradeResources(player, presentedPayment)
        )
      }
    : exchangeHeldView;
  const heldMoney = heldMoneyDeltas(visiblePresentation);
  const displayedView =
    heldMoney.size > 0
      ? {
          ...paymentHeldView,
          players: paymentHeldView.players.map((player) => {
            const delta = heldMoney.get(player.playerId);
            return delta === undefined
              ? player
              : { ...player, money: Math.max(0, player.money - delta) };
          })
        }
      : paymentHeldView;
  const activePlayer = playerById(
    displayedView,
    displayedView.activePlayerId
  );
  const modeName =
    links.modeLabel ??
    (view.matchMode === "TRAINING" ? "修行" : "オンライン対戦");
  const displayedEndTimeAt =
    view.endTimeAt ?? (view.matchMode === "TRAINING" ? 75 : null);
  const endTimeLabel =
    displayedEndTimeAt === null
      ? "終末なし"
      : `終末 G.F.${displayedEndTimeAt}`;
  const soldCardInstanceId =
    view.pendingAttack?.actorId === view.self?.playerId
      ? view.pendingAttack?.saleProduct?.cardInstanceId ?? null
      : null;
  const hand = [
    ...(view.self?.hand ?? []).filter(
      ({ instanceId }) => instanceId !== soldCardInstanceId
    ),
    ...(view.self?.hand ?? []).filter(
      ({ instanceId }) => instanceId === soldCardInstanceId
    )
  ];
  const concealedCardInstanceIds = new Set([
    ...(visiblePresentation?.concealedCardInstanceIds ?? []),
    ...(soldCardInstanceId === null ? [] : [soldCardInstanceId])
  ]);
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
  const presentedTargetId =
    presentationAttackScene(visiblePresentation)?.targetPlayerId ?? null;
  const tradeDraft = activeTradeDraft(view, displayedUi);
  const targetCandidateIds =
    tradeActionForDraft(tradeDraft, view)?.targetPlayerIds ??
    preview.targetPlayerIds;
  const highlightedTargetIds =
    presentedTargetId !== null
      ? [presentedTargetId]
      : visiblePresentation?.activeStep?.step.kind === "ACTION"
        ? []
        : hasLocalActionSelection || tradeDraft
          ? displayedUi.selectedTargetIds
          : view.targetPlayerIds;
  const guardianIntro = presentationGuardianAssigned(visiblePresentation);
  const playerMarkup = [...displayedView.players]
    .sort((left, right) => left.seatIndex - right.seatIndex)
    .map((player) =>
      renderPlayer(
        player,
        displayedView,
        targetCandidateIds,
        highlightedTargetIds,
        displayedUi.interactionLocked,
        player.playerId === guardianIntro?.playerId
          ? `--gf-summon-ms: ${visiblePresentation?.activeStep?.step.durationMs ?? 0}ms; ${presentationEffectDelayStyle(visiblePresentation, nowMs)}`
          : null,
        showCastMiracles
      )
    )
    .join("");
  const handMarkup =
    hand.length > 0
      ? hand
          .map((card) =>
            concealedCardInstanceIds.has(card.instanceId)
              ? renderConcealedCard()
              : renderCard(card, displayedUi, view)
          )
          .join("")
      : emptyState(view.self ? "手札はありません" : "観戦者には手札は表示されません");
  const miracleMarkup = miracles
    .map((miracle, index) => renderMiracle(miracle, displayedUi, view, index))
    .join("");

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
      ${links.exitAction ? "data-exit-battle" : ""}
      aria-label="${links.exitAction ? "対戦から切断してロビーへ戻る" : "対戦画面から戻る"}"
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
      data-rulebook-link
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

  ${renderActionRegion(view, displayedUi, visiblePresentation, nowMs)}
  ${renderResponseRegion(view, displayedUi)}

  <section
    class="gf-panel gf-miracles"
    data-region="miracles"
    aria-labelledby="gf-miracles-title"
  >
    <div class="gf-section-heading">
      <p class="gf-section-heading__eyebrow">Miracles</p>
      <h2 id="gf-miracles-title">
        <button
          type="button"
          class="gf-miracles__toggle"
          data-toggle-cast-miracles
          aria-pressed="${String(showCastMiracles)}"
        >起こした奇跡</button>
      </h2>
    </div>
    ${
      hoveredCardDefinitionId !== null &&
      CARD_DEFINITIONS_BY_ID.has(hoveredCardDefinitionId)
        ? `<div class="gf-card-detail" data-card-detail aria-live="polite">${renderFieldCard(hoveredCardDefinitionId)}</div>`
        : ""
    }
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
    <ul class="gf-card-list">${handMarkup}${miracleMarkup}</ul>
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
        data-focus-targets
        ${targetCandidateIds.length > 1 && !displayedUi.interactionLocked ? "" : "disabled"}
      >対象を選ぶ</button>
    </div>
    ${renderHandActionToggle(view, displayedUi)}
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
    ${renderSoundControl("gf-battle-footer__sound")}
  </footer>

  ${renderResultRegion(
    presentationHoldsResult(visiblePresentation) ? { ...view, result: null } : view,
    links
  )}
</main>`;
}

export type BattleScreenInteractions = {
  createCommandId?: () => string;
  onCommand?: (command: GameCommand) => void;
  onUiStateChange?: (ui: UiInteractionState) => void;
  onExit?: () => void;
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
  let exitConfirmOpen = false;
  // The last hovered card stays in the detail slot until another is hovered.
  let hoveredCardDefinitionId: string | null = null;
  let showCastMiracles = false;
  const sounds = new SoundEffectPlayer();
  const soundedStepIds = new Set<string>();
  let mutedSoundEventSeqThrough = 0;
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
      renderNow,
      hoveredCardDefinitionId,
      showCastMiracles
    );
    renderedDeadlineSeconds = inputDeadlineRemainingSeconds(
      currentUi,
      renderNow
    );
    const battleRoot = container.querySelector<HTMLElement>(
      ".gf-battle-screen"
    );
    const openExitConfirm = (): void => {
      if (!battleRoot || battleRoot.querySelector("[data-exit-confirm]")) return;
      exitConfirmOpen = true;
      const overlay = container.ownerDocument.createElement("div");
      overlay.className = "gf-exit-confirm";
      overlay.dataset.exitConfirm = "";
      overlay.innerHTML =
        '<div class="gf-exit-confirm__panel" role="dialog" aria-label="戦いをあきらめますか">' +
        '<button type="button" class="gf-exit-confirm__button" data-exit-confirm-accept>戦いをあきらめる</button>' +
        "</div>";
      const close = (): void => {
        exitConfirmOpen = false;
        overlay.remove();
      };
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
      });
      overlay
        .querySelector("[data-exit-confirm-accept]")
        ?.addEventListener("click", () => {
          close();
          interactions.onExit?.();
        });
      battleRoot.append(overlay);
    };
    battleRoot
      ?.querySelector<HTMLElement>("[data-exit-battle]")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        openExitConfirm();
      });
    if (exitConfirmOpen) openExitConfirm();
    for (const button of container.querySelectorAll<HTMLElement>(
      "[data-select-card]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectCard;
        if (id) update(selectActionCard(currentUi, id, currentView));
      });
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      "[data-toggle-hand-action]"
    )) {
      button.addEventListener("click", () => {
        const type = button.dataset.toggleHandAction;
        if (type === "DISCARD" || type === "SACRIFICE") {
          update(toggleHandActionMode(currentUi, type));
        }
      });
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      "[data-select-hand-action-card]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectHandActionCard;
        if (id) update(toggleHandActionCard(currentUi, id, currentView));
      });
    }
    container.querySelector("[data-submit-hand-action]")?.addEventListener(
      "click",
      () => {
        const prepared = prepareHandActionSubmission(
          currentUi,
          currentView,
          createCommandId
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      }
    );
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      "[data-open-utility]"
    )) {
      button.addEventListener("click", () => {
        const type = button.dataset.openUtility;
        if (!type) return;
        const exchangeCardId = button.dataset.utilityCardInstance;
        if (type === "EXCHANGE_RESOURCES" && exchangeCardId) {
          update(toggleExchangeDraft(currentUi, exchangeCardId, currentView));
          return;
        }
        if ((type === "SELL_CARD" || type === "DECLARE_BUY") && exchangeCardId) {
          update(toggleTradeDraft(currentUi, type, exchangeCardId, currentView));
        }
      });
    }
    for (const button of container.querySelectorAll<HTMLElement>(
      "[data-select-trade-product]"
    )) {
      button.addEventListener("click", () => {
        const id = button.dataset.selectTradeProduct;
        if (id) update(toggleTradeProduct(currentUi, id, currentView));
      });
    }
    container.querySelector("[data-submit-trade]")?.addEventListener(
      "click",
      () => {
        const prepared = prepareTradeSubmission(
          currentUi,
          currentView,
          createCommandId
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      }
    );
    container
      .querySelector<HTMLElement>("[data-toggle-cast-miracles]")
      ?.addEventListener("click", () => {
        showCastMiracles = !showCastMiracles;
        renderAndBind();
      });
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
        const adjustment = button.dataset.exchangeAdjust ?? "";
        const [resource, deltaText] = adjustment.split(":");
        const total = Number(
          button.closest<HTMLElement>("[data-exchange-total]")?.dataset
            .exchangeTotal
        );
        const draft = currentUi.exchangeDraft;
        if (!draft || (resource !== "mp" && resource !== "money")) return;
        const next = adjustExchangeAllocation(
          draft,
          total,
          resource,
          Number(deltaText)
        );
        if (!next) return;
        update(updateExchangeDraft(currentUi, next));
        (
          container.querySelector<HTMLElement>(
            `[data-exchange-adjust="${adjustment}"]:not(:disabled)`
          ) ??
          container.querySelector<HTMLElement>(
            "[data-exchange-adjust]:not(:disabled)"
          )
        )?.focus();
      });
    }
    container.querySelector("[data-submit-exchange]")?.addEventListener(
      "click",
      () => {
        const prepared = prepareExchangeSubmission(
          currentUi,
          currentView,
          createCommandId
        );
        if (!prepared) return;
        update(prepared.ui);
        interactions.onCommand?.(prepared.command);
      }
    );
  };

  const playInteractionSound = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    // The declared action plays the card sound for these confirmations.
    if (button.matches("[data-submit-exchange], [data-submit-trade]")) return;
    // The server's reaction event plays the answer's own sound.
    if (button.matches("[data-submit-forgive], [data-submit-reaction]")) return;
    if (
      button.matches(
        "[data-select-card], [data-select-miracle], [data-select-defense-card], [data-select-defense-miracle], [data-select-trade-product], [data-open-utility='EXCHANGE_RESOURCES']"
      )
    ) {
      sounds.play("card");
    } else if (
      button.matches(
        "[data-select-target], [data-open-utility='SELL_CARD'], [data-open-utility='DECLARE_BUY']"
      )
    ) {
      sounds.play("target");
    } else if (button.matches("[data-exchange-adjust]")) {
      sounds.play("toggle");
    } else {
      sounds.play("button");
    }
  };
  container.addEventListener("click", playInteractionSound);

  const playRulebookSound = (event: MouseEvent): void => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-rulebook-link]")
    ) {
      sounds.play("bookTab");
    }
  };
  container.addEventListener("click", playRulebookSound);

  const showCardDetail = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target
      .closest<HTMLElement>(".gf-hand .gf-card, .gf-miracles .gf-card")
      ?.dataset.cardDefinitionId;
    if (!id || id === hoveredCardDefinitionId) return;
    hoveredCardDefinitionId = id;
    renderAndBind();
  };
  container.addEventListener("mouseover", showCardDetail);
  container.addEventListener("focusin", showCardDetail);

  const playEventSound = (
    event: DomainEvent,
    stepId = `${event.eventSeq}`,
    effect: SoundEffect | null = soundEffectForEvent(
      event,
      currentView.self?.playerId ?? null,
      presentation.recentEvents
    )
  ): void => {
    if (
      event.eventSeq <= mutedSoundEventSeqThrough ||
      soundedStepIds.has(stepId)
    ) {
      return;
    }
    soundedStepIds.add(stepId);
    if (effect) sounds.play(effect);
  };

  const playCurrentPresentationSound = (): void => {
    const step = presentation.activeStep?.step;
    if (!step) return;
    if (
      step.event.type === "TRADE_PAYMENT_COLLECTED" ||
      (step.kind === "TRADE" && step.event.type === "RESOURCE_CHANGED")
    ) {
      const stage = tradePresentationStage(step);
      if (stage === "STAMP" && !soundedStepIds.has(step.stepId)) {
        soundedStepIds.add(step.stepId);
        sounds.play("button");
      }
      if (stage !== "SETTLE") return;
    }
    // A staged sale reveal is one declaration, so it sounds once.
    if (step.event.type === "ACTION_DECLARED" && step.stageIndex > 0) return;
    playEventSound(
      step.event,
      step.stepId,
      soundEffectForPresentationStep(
        step,
        currentView.self?.playerId ?? null,
        presentation.recentEvents
      )
    );
  };

  const setPresentation = (next: PresentationQueueState): void => {
    const revealedConcealedCards =
      presentation.concealedCardInstanceIds.length > 0 &&
      next.concealedCardInstanceIds.length === 0;
    presentation = next;
    if (revealedConcealedCards) sounds.play("openCover");
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
    setPresentation(nextPresentation);
    if (presentationChanged) playCurrentPresentationSound();
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
      currentView = message.snapshot;
      if (message.type === "FULL_SNAPSHOT") {
        mutedSoundEventSeqThrough = Math.max(
          mutedSoundEventSeqThrough,
          message.eventSeq
        );
      }
      setPresentation(
        applyRealtimePresentationMessage(presentation, message, nowMs)
      );
      if (message.type === "EVENT_BATCH") {
        for (const event of immediateSoundEvents(message.events)) {
          if (presentationStepsForEvent(event).length === 0) {
            playEventSound(event);
          }
        }
      }
      playCurrentPresentationSound();
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
      container.removeEventListener("click", playInteractionSound);
      container.removeEventListener("click", playRulebookSound);
      container.removeEventListener("mouseover", showCardDetail);
      container.removeEventListener("focusin", showCardDetail);
    },
    getUiState() {
      return currentUi;
    }
  };
}

export const BATTLE_SCREEN_STYLES = `
.gf-exit-confirm {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(0, 40, 30, 0.6);
}

.gf-exit-confirm__panel {
  inline-size: 44%;
  block-size: 40%;
  display: grid;
  place-items: center;
  border-radius: 1.5rem;
  background: #ffeeee;
}

.gf-exit-confirm__button {
  inline-size: 92%;
  padding: 0.6em 0.4em;
  border: 3px solid #f08080;
  border-radius: 0.8rem;
  color: #ffffff;
  background: #dd4444;
  font-size: clamp(16px, 3.4cqi, 40px);
  font-weight: 800;
  cursor: pointer;
}

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

.gf-response__subject {
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

.gf-input-status--deadline {
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
}

.gf-input-status__bar {
  display: block;
  block-size: 0.6rem;
  inline-size: 100%;
  transform-origin: left center;
  background: #1f9e6e;
  animation: gf-deadline-drain var(--gf-deadline-total, 30s) linear
    var(--gf-deadline-elapsed, 0s) forwards;
}

@keyframes gf-deadline-drain {
  from {
    transform: scaleX(1);
    background: #1f9e6e;
  }
  60% {
    background: #1f9e6e;
  }
  to {
    transform: scaleX(0);
    background: #e04848;
  }
}

.gf-input-status--warning {
  border-color: var(--gf-target);
  color: #ffd9d5;
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
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 2%;
}

.gf-player__calamities {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 2px;
  overflow: hidden;
}

.gf-calamity-slot {
  min-inline-size: 0;
  display: flex;
  justify-content: center;
}

.gf-player__guardian {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-inline-size: 0;
  padding: 1px 6px 1px 1px;
  border-radius: 999px;
  color: #6b5200;
  background: #f3e6a8;
  box-shadow: 0 0 0 1px #aa8800;
  font-size: clamp(7px, 1.2cqi, 13px);
  font-weight: 700;
  line-height: 1.2;
}

.gf-player__guardian-art {
  flex: none;
  inline-size: 2.6em;
  block-size: 2.6em;
  border-radius: 50%;
  object-fit: cover;
  text-align: center;
}

.gf-player__guardian-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Hidden while the summon art flies in, then pops into the name plate. */
.gf-player__guardian[data-intro="true"] {
  animation: gf-guardian-chip-in var(--gf-summon-ms, 1500ms) linear both;
  animation-delay: var(--gf-effect-delay, 0ms);
}

.gf-guardian-summon {
  position: absolute;
  z-index: 21;
  inset: 50% auto auto 50%;
  inline-size: 30%;
  aspect-ratio: 1;
  pointer-events: none;
  animation: gf-guardian-summon var(--gf-summon-ms, 1500ms) ease-in-out both;
  animation-delay: var(--gf-effect-delay, 0ms);
}

.gf-guardian-summon__art {
  inline-size: 100%;
  block-size: 100%;
  border: 6px solid #fff4;
  border-radius: 12px;
  box-shadow:
    0 0 2.5rem rgb(255 220 120 / 85%),
    0 12px 30px rgb(0 0 0 / 35%);
  object-fit: cover;
}

@keyframes gf-guardian-summon {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.2);
  }
  25% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  65% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.15);
  }
}

@keyframes gf-guardian-chip-in {
  0%,
  70% {
    opacity: 0;
    transform: scale(0.4);
  }
  85% {
    opacity: 1;
    transform: scale(1.15);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gf-guardian-summon,
  .gf-player__guardian[data-intro="true"] {
    animation: none;
  }

  .gf-guardian-summon {
    transform: translate(-50%, -50%);
  }
}

.gf-calamity-chip {
  padding: 0 4px;
  border-radius: 3px;
  color: #ffffff;
  background: #cc6644;
  font-size: clamp(6px, 1.0185cqi, 11px);
  font-weight: 700;
  line-height: 1.25;
  white-space: nowrap;
}

.gf-calamity-chip[data-calamity="HEAVEN_SICKNESS"] {
  background: #4488cc;
}

.gf-calamity-chip[data-calamity="HELL_SICKNESS"] {
  background: #884466;
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

.gf-player__name[data-name-size="1"] {
  font-size: clamp(8px, 1.8cqi, 20px);
}

.gf-player__name[data-name-size="2"] {
  font-size: clamp(7px, 1.4cqi, 15px);
}

.gf-player__name[data-name-size="3"] {
  font-size: clamp(7px, 1.2cqi, 13px);
}

.gf-player[data-self="true"] .gf-player__name[data-name-size="1"] {
  font-size: clamp(8px, 1.5cqi, 16px);
}

.gf-player[data-self="true"] .gf-player__name[data-name-size="2"],
.gf-player[data-self="true"] .gf-player__name[data-name-size="3"] {
  font-size: clamp(7px, 1.2cqi, 13px);
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

.gf-action__activity.sr-only {
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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

/* Past three cards the lane overflows, so cards overlap like a fanned stack:
   later cards sit on top and only each earlier card's title strip stays visible. */
.gf-action__stack[data-stacked="true"] {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: visible;
}

.gf-action__stack[data-stacked="true"] > .gf-field-card {
  flex: none;
  box-shadow: 0 -2px 4px rgb(0 0 0 / 25%);
}

.gf-action__stack[data-stacked="true"] > .gf-field-card + .gf-field-card {
  margin-block-start: -54px;
}

.gf-action__stack--defense:empty {
  visibility: hidden;
}

.gf-action__confirm,
.gf-action__pray {
  position: absolute;
  z-index: 6;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: 46.875%;
  block-size: 100%;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: transparent;
  background: transparent;
  cursor: pointer;
}

.gf-action__confirm:disabled,
.gf-action__pray:disabled {
  display: none;
}

.gf-action__confirm:hover,
.gf-action__pray:hover,
.gf-response__actions [data-submit-reaction]:not(:disabled):hover,
.gf-response__actions [data-submit-forgive]:not(:disabled):hover {
  background: rgb(238 255 238 / 18%);
  box-shadow: inset 0 0 0 2px rgb(238 255 238 / 28%);
}

.gf-action__confirm:active,
.gf-action__pray:active {
  background: rgb(0 40 30 / 40%);
}

.gf-action__confirm:focus-visible,
.gf-action__pray:focus-visible {
  outline: 4px solid #ffbb00;
  outline-offset: -4px;
}

.gf-action__pray::after {
  position: absolute;
  top: 105.1724%;
  left: 6.6667%;
  inline-size: 86.6667%;
  block-size: 13.7931%;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #eeffee;
  background: #008f83;
  box-shadow: 0 2px 0 rgb(125 105 60 / 28%);
  content: "祈る";
}

.gf-action__forgive {
  position: absolute;
  z-index: 7;
  top: 105.1724%;
  left: 56.25%;
  inline-size: 40.625%;
  block-size: 13.7931%;
  display: grid;
  place-content: center;
  border: 0;
  border-radius: 10px;
  color: #eeffee;
  background: #aa3344;
  box-shadow: 0 2px 0 rgb(125 105 60 / 28%);
  font-size: clamp(16px, 2.2222cqi, 24px);
  line-height: 1;
}

.gf-action__forgive--trade {
  position: absolute;
  z-index: 7;
  top: 105.1724%;
  left: 56.25%;
  inline-size: 40.625%;
  min-block-size: 0;
  block-size: 13.7931%;
  border: 0;
  border-radius: 10px;
  color: #eeffee;
  background: #aa3344;
  box-shadow: 0 2px 0 rgb(125 105 60 / 28%);
  font-size: clamp(11px, 2.0833cqi, 22px);
}

.gf-trade-swap {
  position: absolute;
  z-index: 7;
  inset: 0;
  pointer-events: none;
}

.gf-trade-swap .gf-trade-swap__product {
  position: absolute;
  top: 100px;
  left: 53.125%;
  inline-size: 46.875%;
  block-size: 90px;
  aspect-ratio: auto;
}

.gf-trade-swap[data-trade-stage="SWAP"][data-trade-kind="SELL"] .gf-trade-swap__product {
  animation: gf-trade-move-right 800ms cubic-bezier(0.61, 1, 0.88, 1) var(--gf-trade-delay) both;
}

.gf-trade-swap[data-trade-stage="SWAP"][data-trade-kind="BUY"] .gf-trade-swap__product {
  animation: gf-trade-move-left 800ms cubic-bezier(0.61, 1, 0.88, 1) var(--gf-trade-delay) both;
}

.gf-trade-swap__coin {
  position: absolute;
  top: 164px;
  inline-size: 157px;
  block-size: 157px;
  display: grid;
  place-items: center;
  border: 2px solid #eee8a8;
  border-radius: 50%;
  color: #333333;
  background: #ffffaa;
  font-size: clamp(32px, 5.9259cqi, 64px);
  line-height: 1;
}

.gf-trade-swap[data-trade-kind="SELL"] .gf-trade-swap__coin {
  left: calc(23.4375% - 78px);
}

.gf-trade-swap[data-trade-kind="BUY"] .gf-trade-swap__coin {
  left: calc(76.5625% - 78px);
}

.gf-trade-swap[data-trade-stage="SWAP"][data-trade-kind="SELL"] .gf-trade-swap__coin {
  animation: gf-trade-coin-left 800ms cubic-bezier(0.61, 1, 0.88, 1) var(--gf-trade-delay) both;
}

.gf-trade-swap[data-trade-stage="SWAP"][data-trade-kind="BUY"] .gf-trade-swap__coin {
  animation: gf-trade-coin-right 800ms cubic-bezier(0.61, 1, 0.88, 1) var(--gf-trade-delay) both;
}

.gf-trade-swap[data-trade-kind="BUY"][data-trade-stage="SETTLE"] .gf-trade-swap__product {
  left: 0;
}

/* Before a sale's coin moves, the product is still on the seller's side and
   the coin waits at the payer. */
.gf-trade-swap[data-trade-kind="SELL"][data-trade-stage="PRICE"] .gf-trade-swap__product {
  left: 0;
}

.gf-trade-swap[data-trade-kind="SELL"][data-trade-stage="PRICE"] .gf-trade-swap__coin {
  left: calc(76.5625% - 78px);
}

/* A guardian theft carries the coin from the robbed player to the guardian
   portrait in the right lane. */
.gf-trade-swap .gf-trade-swap__guardian {
  position: absolute;
  top: 152px;
  left: calc(76.5625% - 90px);
  inline-size: 180px;
  block-size: 180px;
  display: grid;
  place-items: center;
  border: 6px solid #fff4;
  border-radius: 12px;
  color: #ffffff;
  background: #335555;
  box-shadow:
    0 0 2.5rem rgb(255 220 120 / 85%),
    0 12px 30px rgb(0 0 0 / 35%);
  font-size: 64px;
  object-fit: cover;
}

.gf-trade-swap[data-trade-kind="GUARDIAN"] .gf-trade-swap__coin {
  z-index: 1;
  left: calc(76.5625% - 78px);
}

.gf-trade-swap[data-trade-kind="GUARDIAN"][data-trade-stage="PRICE"] .gf-trade-swap__coin {
  left: calc(23.4375% - 78px);
}

.gf-trade-swap[data-trade-stage="SWAP"][data-trade-kind="GUARDIAN"] .gf-trade-swap__coin {
  animation: gf-trade-coin-right 800ms cubic-bezier(0.61, 1, 0.88, 1) var(--gf-trade-delay) both;
}

.gf-action__result[data-result="trade-notice"] {
  --gf-effect-rest-y: -50%;
  top: 38%;
  inline-size: auto;
  min-inline-size: 30%;
  block-size: auto;
  padding: 2% 4%;
  border: 0;
  border-radius: 16px;
  color: #ffffff;
  background: #eebb00;
}

.gf-action__result[data-result="trade-notice"][data-placement="actor"] {
  left: 23.4375%;
}

.gf-action__result[data-result="trade-notice"] strong {
  font-size: clamp(28px, 5.5556cqi, 60px);
  line-height: 1;
  text-shadow: none;
  white-space: nowrap;
}

/* Centered on the buyer's card lane, like 許す and the damage result. */
.gf-trade-swap__stamp {
  position: absolute;
  top: 48%;
  left: 23.4375%;
  inline-size: 46.875%;
  block-size: 90px;
  display: grid;
  place-items: center;
  border: 3px solid #ffdde8;
  border-radius: 8px;
  color: #ffffff;
  background: #ee88aa;
  font-size: clamp(24px, 4.4444cqi, 48px);
  animation: gf-effect-overlay-enter 180ms ease-out var(--gf-trade-delay) both;
}

@keyframes gf-trade-move-right {
  from {
    left: 0;
  }

  to {
    left: 53.125%;
  }
}

@keyframes gf-trade-move-left {
  from {
    left: 53.125%;
  }

  to {
    left: 0;
  }
}

@keyframes gf-trade-coin-left {
  from {
    left: calc(76.5625% - 78px);
  }

  to {
    left: calc(23.4375% - 78px);
  }
}

@keyframes gf-trade-coin-right {
  from {
    left: calc(23.4375% - 78px);
  }

  to {
    left: calc(76.5625% - 78px);
  }
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
  animation: gf-effect-overlay-enter 180ms ease-out var(--gf-effect-delay, 0ms) both;
}

.gf-action__result {
  --gf-effect-rest-y: -50%;
  animation: gf-effect-drop-in 183ms ease-out var(--gf-effect-delay, 0ms) both;
}

.gf-action__result[data-result="hit"],
.gf-action__result[data-result="miss"] {
  --gf-effect-rest-y: 0%;
  top: -8px;
  block-size: 90px;
  animation-duration: 233ms;
}

.gf-action__result[data-result="deflect"] {
  --gf-effect-rest-y: -50%;
  top: 38%;
  inline-size: auto;
  min-inline-size: 30%;
  block-size: auto;
  padding: 2% 4%;
  border: 0;
  border-radius: 16px;
  color: #ffffff;
  background: #eebb00;
}

.gf-action__result[data-result="deflect"][data-placement="defense-left"] {
  left: 25%;
}

.gf-action__result[data-result="deflect"] strong {
  font-size: clamp(28px, 5.5556cqi, 60px);
  line-height: 1;
  text-shadow: none;
  white-space: nowrap;
}

.gf-action__content[data-attack-side="right"] > .gf-action__stack--attack {
  grid-column: 2;
}

.gf-action__content[data-attack-side="right"] > .gf-action__stack--defense {
  grid-column: 1;
}

/* A redirected attack names its new route one piece at a time:
   actor, arrow, target (the damage follows in the next stage). */
.gf-action__route[data-route-staged] .gf-action__arrow {
  animation: gf-route-arrow-reveal var(--gf-redirect-ms, 1000ms) linear var(--gf-effect-delay, 0ms) both;
}

.gf-action__route[data-route-staged] .gf-action__target {
  animation: gf-route-target-reveal var(--gf-redirect-ms, 1000ms) linear var(--gf-effect-delay, 0ms) both;
}

@keyframes gf-route-arrow-reveal {
  0%, 32.9% {
    visibility: hidden;
  }
  33%, 100% {
    visibility: visible;
  }
}

@keyframes gf-route-target-reveal {
  0%, 65.9% {
    visibility: hidden;
  }
  66%, 100% {
    visibility: visible;
  }
}

.gf-action__stack[data-redirect-move] {
  animation: gf-redirect-slide var(--gf-redirect-ms, 1000ms) ease-in-out var(--gf-effect-delay, 0ms) both;
}

.gf-action__content[data-attack-side="right"] > .gf-action__stack[data-redirect-move] {
  --gf-redirect-from: -113.3333%;
}

.gf-action__content[data-attack-side="left"] > .gf-action__stack[data-redirect-move] {
  --gf-redirect-from: 113.3333%;
}

@keyframes gf-redirect-slide {
  from {
    transform: translateX(var(--gf-redirect-from));
  }

  to {
    transform: translateX(0);
  }
}

.gf-action__result[data-placement="actor"] {
  top: 42%;
  left: 23.4375%;
}

.gf-action__result[data-polarity="positive"] {
  animation: gf-effect-rise-in 800ms cubic-bezier(0.16, 1, 0.3, 1) var(--gf-effect-delay, 0ms) both;
}

@keyframes gf-effect-overlay-enter {
  from {
    opacity: 0;
    transform: translate(-50%, calc(-50% + 24px));
  }

  to {
    opacity: 1;
    transform: translate(-50%, -50%);
  }
}

@keyframes gf-effect-drop-in {
  from {
    clip-path: inset(100% -24px -24px);
    transform: translate(-50%, calc(var(--gf-effect-rest-y) - 100%));
  }

  to {
    clip-path: inset(0 -24px -24px);
    transform: translate(-50%, var(--gf-effect-rest-y));
  }
}

@keyframes gf-effect-rise-in {
  from {
    opacity: 0;
    transform: translate(-50%, calc(var(--gf-effect-rest-y) + 40px));
  }

  8% {
    opacity: 1;
  }

  to {
    opacity: 1;
    transform: translate(-50%, var(--gf-effect-rest-y));
  }
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

/* 夢: a plain orange card with three bright bands above the name. */
.gf-action__effect[data-calamity="DREAM"] {
  border-color: #ff9900;
  color: #444444;
  background: #ff9900;
  animation: gf-effect-dream-enter 260ms ease-out var(--gf-effect-delay, 0ms) both;
}

.gf-action__effect[data-calamity="DREAM"]::before {
  content: "";
  justify-self: center;
  inline-size: 34%;
  block-size: clamp(10px, 2.4cqi, 26px);
  margin-block-end: 6%;
  border-radius: 3px;
  background: linear-gradient(
    to bottom,
    #fff2c0 0 22%,
    #ff9900 22% 39%,
    #ffffff 39% 61%,
    #ff9900 61% 78%,
    #fff2c0 78% 100%
  );
}

.gf-action__effect[data-calamity="DREAM"] strong {
  font-size: clamp(30px, 7.2cqi, 78px);
}

.gf-action__effect[data-calamity="DREAM"] span {
  display: none;
}

/* The card whose effect is about to resolve blinks orange. */
.gf-field-card--effect-source {
  animation: gf-field-card-effect-source 500ms steps(1, end) 2 both;
}

@keyframes gf-field-card-effect-source {
  0% {
    background: #ffb347;
    box-shadow: 0 0 0 3px #ff9900;
  }

  50% {
    background: inherit;
    box-shadow: none;
  }
}

/* 闇: the damage card turns violet, the number stays red. */
.gf-action__result[data-result="damage"][data-element="DARK"] {
  border-color: #8a3fc0;
  color: #cc0000;
  background: #b768e0;
  box-shadow: 0 0 22px rgb(90 30 140 / 55%);
}

.gf-action__result[data-result="damage"][data-element="DARK"] span {
  color: #4b136f;
}

/* The field sinks into a blue-violet dusk while dark damage is shown. */
.gf-battle-screen:has(.gf-action__result[data-element="DARK"]) {
  background:
    linear-gradient(rgb(128 134 236 / 88%), rgb(104 108 214 / 92%)),
    url("/images/goodfield-home.png") center / cover no-repeat,
    #8d95e6;
  background-blend-mode: color, normal, normal;
}

/* ウス: the mortar drops beside the pestle that found it, then blinks. */
.gf-field-card--mortar {
  animation:
    gf-field-card-mortar-drop 200ms ease-out var(--gf-effect-delay, 0ms) both,
    gf-field-card-effect-source 500ms steps(1, end) 200ms 2 both;
}

@keyframes gf-field-card-mortar-drop {
  from {
    opacity: 0;
    transform: translateY(-40%);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

/* 御乱心: orange lettering on white inside a double orange rim. */
.gf-action__effect[data-effect="confusion"] {
  top: 22%;
  left: 24%;
  inline-size: auto;
  block-size: auto;
  padding: 2% 5%;
  border: 6px solid #ff9900;
  border-radius: 18px;
  color: #ff8800;
  background: #ffffff;
  box-shadow:
    inset 0 0 0 4px #ffffff,
    inset 0 0 0 8px #ffb347,
    0 8px 18px rgb(0 0 0 / 18%);
  animation: gf-effect-dream-enter 260ms ease-out var(--gf-effect-delay, 0ms) both;
}

.gf-action__effect[data-effect="confusion"] strong {
  font-size: clamp(26px, 5.6cqi, 62px);
  white-space: nowrap;
  text-shadow: none;
}

/* 神器一新: peach card, thick orange rim, wiped in from the left. */
.gf-action__effect[data-effect="hand-redraw"] {
  border-color: #ff9900;
  border-width: 6px;
  color: #ffffff;
  background: #ffdcae;
  animation: gf-effect-redraw-enter 320ms ease-out var(--gf-effect-delay, 0ms) both;
}

.gf-action__effect[data-effect="hand-redraw"] strong {
  font-size: clamp(22px, 4.6cqi, 50px);
  letter-spacing: 0.04em;
  white-space: nowrap;
  text-shadow:
    -1px -1px 0 #ff9900,
    1px -1px 0 #ff9900,
    -1px 1px 0 #ff9900,
    1px 1px 0 #ff9900;
}

@keyframes gf-effect-dream-enter {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.86);
  }

  70% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.04);
  }

  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

@keyframes gf-effect-redraw-enter {
  from {
    opacity: 0;
    clip-path: inset(0 100% 0 0 round 20px);
  }

  to {
    opacity: 1;
    clip-path: inset(0 0 0 0 round 20px);
  }
}

.gf-action__result[data-result="safe"],
.gf-action__result[data-result="stopped"] {
  border-color: #009900;
  color: #009900;
  background: #eeffee;
}

.gf-action__result[data-result="hit"],
.gf-action__result[data-result="miss"] {
  padding: 0;
  border: 2px solid #990000;
  color: #990000;
  background: #ffc8cc;
}

.gf-action__result[data-result="miss"] {
  border-color: #660099;
  color: #660099;
  background: #e6c8ff;
}

.gf-action__result[data-result="hit"] strong,
.gf-action__result[data-result="miss"] strong {
  font-size: clamp(24px, 4.4444cqi, 48px);
  line-height: 1;
  text-shadow: none;
}

.gf-action__result[data-result="damage"] span {
  justify-self: end;
  font-style: italic;
}

.gf-action__result[data-polarity="positive"] {
  border-color: transparent;
  color: #ffffff;
  background: #1ddd7f;
}

.gf-action__result[data-polarity="positive"][data-resource="mp"] {
  background: #7b6cf0;
}

.gf-action__result[data-polarity="positive"] strong {
  font-size: clamp(28px, 5.5556cqi, 60px);
  line-height: 1;
  text-shadow: none;
}

.gf-action__result[data-result="safe"] strong,
.gf-action__result[data-result="stopped"] strong {
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

.gf-action[data-trade="true"] .gf-action__summary,
.gf-action[data-hand-action="true"] .gf-action__summary {
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

.gf-action__summary[data-element="FIRE"] div:first-child {
  border-color: #e5483a;
  background: #ffd9d4;
}

.gf-action__summary[data-element="FIRE"] div:first-child dd {
  color: #e5483a;
}

.gf-action__summary[data-element="WATER"] div:first-child {
  border-color: #2f7fe0;
  background: #d6e8ff;
}

.gf-action__summary[data-element="WATER"] div:first-child dd {
  color: #2f7fe0;
}

.gf-action__summary[data-element="WOOD"] div:first-child {
  border-color: #2fa44f;
  background: #d4f5da;
}

.gf-action__summary[data-element="WOOD"] div:first-child dd {
  color: #2fa44f;
}

.gf-action__summary[data-element="EARTH"] div:first-child {
  border-color: #b9812c;
  background: #f5e4c4;
}

.gf-action__summary[data-element="EARTH"] div:first-child dd {
  color: #b9812c;
}

.gf-action__summary[data-element="LIGHT"] div:first-child {
  border-color: #e6b800;
  background: #fff6c2;
}

.gf-action__summary[data-element="LIGHT"] div:first-child dd {
  color: #e6b800;
}

.gf-action__summary[data-element="DARK"] div:first-child {
  border-color: #7a3fb5;
  background: #e6d6f5;
}

.gf-action__summary[data-element="DARK"] div:first-child dd {
  color: #7a3fb5;
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

.gf-response__actions:has([data-submit-reaction]:not(:disabled)) {
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  grid-auto-columns: 100%;
  gap: 0;
}

.gf-response__actions:has([data-submit-forgive]:not(:disabled)) {
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  grid-auto-columns: 100%;
  gap: 0;
}

.gf-response__actions:has([data-submit-reaction]:not(:disabled)) [data-submit-reaction],
.gf-response__actions:has([data-submit-forgive]:not(:disabled)) [data-submit-forgive] {
  inline-size: 100%;
  block-size: 100%;
  border-radius: 8px;
}

.gf-response__actions:has([data-submit-reaction]:not(:disabled)) [data-submit-reaction]:focus-visible,
.gf-response__actions:has([data-submit-forgive]:not(:disabled)) [data-submit-forgive]:focus-visible {
  outline: 4px solid #ffbb00;
  outline-offset: -4px;
}

.gf-response__actions [data-submit-forgive] {
  position: relative;
  color: transparent;
  background: transparent;
  box-shadow: none;
}

.gf-response__actions [data-submit-forgive]::after {
  position: absolute;
  top: 98.3607%;
  left: 3.3333%;
  inline-size: 86.6667%;
  block-size: 13.1148%;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #eeffee;
  background: #bb4444;
  box-shadow: 0 2px 0 rgb(125 105 60 / 28%);
  content: "許す";
}

.gf-response__actions [data-submit-reaction],
.gf-action__confirm,
.gf-action__pray {
  color: transparent;
  background: transparent;
  box-shadow: none;
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

.gf-miracles__toggle {
  min-block-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.gf-miracles .gf-section-heading:has([aria-pressed="true"]) {
  background: #cccccc;
}

.gf-cast-miracle {
  min-inline-size: 0;
  block-size: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.gf-cast-miracle__image {
  block-size: 86%;
  aspect-ratio: 1;
  border: 2px solid #55bb99;
  border-radius: 4px;
  object-fit: cover;
}

.gf-player:has(.gf-cast-miracle) .gf-resources {
  display: none;
}

.gf-miracles .gf-card-detail {
  block-size: 39.1304%;
  margin-block-end: 4.3478%;
}

.gf-miracles .gf-card-detail .gf-field-card {
  block-size: 100%;
  aspect-ratio: auto;
}

.gf-miracles .gf-card-detail + .gf-card-list {
  max-block-size: 30.4348%;
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

.gf-hand .gf-card--concealed {
  border-color: #477f79;
  background: #70beb5;
  box-shadow:
    inset 0 0 0 2px rgb(225 255 247 / 22%),
    0 1px 2px rgb(0 65 58 / 22%);
}

.gf-hand .gf-card--concealed .gf-card__button {
  block-size: 100%;
  opacity: 1;
  cursor: default;
}

.gf-hand .gf-card__back {
  inline-size: 100%;
  block-size: 100%;
  display: block;
  border: 1px solid rgb(222 255 248 / 34%);
  background:
    linear-gradient(135deg, rgb(255 255 255 / 7%), transparent 45%),
    #69b5ad;
  box-shadow: inset 0 0 0 2px rgb(0 80 72 / 16%);
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

.gf-hand .gf-card[data-card-element="FIRE"] .gf-card__effect { color: #e5483a; }
.gf-hand .gf-card[data-card-element="WATER"] .gf-card__effect { color: #2f7fe0; }
.gf-hand .gf-card[data-card-element="WOOD"] .gf-card__effect { color: #2fa44f; }
.gf-hand .gf-card[data-card-element="EARTH"] .gf-card__effect { color: #b9812c; }
.gf-hand .gf-card[data-card-element="LIGHT"] .gf-card__effect { color: #c99a00; }
.gf-hand .gf-card[data-card-element="DARK"] .gf-card__effect { color: #7a3fb5; }

.gf-hand .gf-card .gf-card__effect[data-trade-price] {
  color: #4f5f2f;
  background: #ffffbb;
}

.gf-hand .gf-card__reason {
  display: none;
}

.gf-hand .gf-card__button:disabled {
  opacity: 0.62;
}

.gf-hand .gf-card.gf-card--miracle[data-card-category] {
  grid-row: 2;
  grid-column: calc(9 - var(--gf-miracle-slot, 0));
  background: #55bb99;
}

.gf-hand .gf-card--miracle::after {
  position: absolute;
  z-index: 1;
  top: 3%;
  right: 3%;
  inline-size: 26%;
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #ffffff;
  background: #33bb88;
  box-shadow: 0 0 0 1px #ffffff;
  content: "☀";
  font-size: clamp(7px, 1.4cqi, 16px);
  line-height: 1;
  pointer-events: none;
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

.gf-input-status.gf-input-status--deadline {
  right: auto;
  left: 0;
  bottom: 110%;
  inline-size: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.gf-input-status--deadline .gf-input-status__bar {
  block-size: clamp(4px, 1.1cqi, 10px);
}

/* Sits directly above the ninth hand slot, 8px clear of the hand row. */
.gf-hand-action-toggle {
  position: absolute;
  top: 16.6667%;
  left: 214.6154%;
  inline-size: 27.6923%;
  block-size: 120%;
  min-block-size: 0 !important;
  padding: 0 !important;
  display: grid;
  place-items: center;
  border: 5px solid #999999 !important;
  border-radius: 0 !important;
  background: #e6e6e6 !important;
  box-shadow: inset 0 0 0 2px #f4f4f4;
  cursor: pointer;
}

.gf-hand-action-toggle__icon {
  inline-size: 100%;
  block-size: 100%;
  fill: none;
  stroke: #999999;
  stroke-width: 1.6;
}

.gf-hand-action-toggle:hover {
  border-color: #888888 !important;
}

.gf-hand-action-toggle[aria-pressed="true"] {
  border-color: #ffbb00 !important;
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

.gf-action[data-exchange="true"] .gf-action__summary {
  display: none;
}

.gf-exchange {
  position: absolute;
  z-index: 5;
  inset: 0;
  pointer-events: none;
}

.gf-exchange__adjust {
  position: absolute;
  inline-size: 18.4375%;
  block-size: 16.5517%;
  padding: 0;
  border: 3px solid #f8f1b4;
  border-radius: 8px;
  color: #fef498;
  background: #c9be4c;
  font-size: clamp(14px, 3.1481cqi, 34px);
  font-weight: 700;
  line-height: 1;
  pointer-events: auto;
  cursor: pointer;
}

.gf-exchange__adjust[data-exchange-column="1"] {
  left: 56.25%;
}

.gf-exchange__adjust[data-exchange-column="2"] {
  left: 78.125%;
}

.gf-exchange__adjust[data-exchange-row="1"] {
  top: 0;
}

.gf-exchange__adjust[data-exchange-row="2"] {
  top: 20.6897%;
}

.gf-exchange__adjust[data-exchange-row="4"] {
  top: 62.069%;
}

.gf-exchange__adjust[data-exchange-row="5"] {
  top: 82.7586%;
}

.gf-exchange__adjust:not(:disabled):hover {
  background: #d7cd7b;
}

.gf-exchange__adjust:not(:disabled):active {
  background: #a89e3c;
}

.gf-exchange__adjust:disabled {
  border-color: #a99b5e;
  color: #8c8344;
  background: #665c24;
  opacity: 1;
  cursor: default;
}

.gf-exchange__readout {
  position: absolute;
  left: 28.125%;
  inline-size: 68.4375%;
  block-size: 16.5517%;
  padding-inline: 3.5% 4%;
  display: grid;
  grid-template-columns: 115fr 108fr 88fr;
  column-gap: 6%;
  align-items: center;
  border: 1px solid #cccccc;
  border-inline-end: 0;
  border-radius: 999px 0 0 999px;
  color: #667c7c;
  background: #efedee;
  font-size: clamp(11px, 2.5926cqi, 28px);
  font-weight: 700;
}

.gf-exchange__readout[data-exchange-row="before"] {
  top: 41.3793%;
}

.gf-exchange__readout[data-exchange-row="after"] {
  top: 82.7586%;
}

.gf-exchange__readout span {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.gf-exchange__readout span:last-child {
  margin-inline-start: 22%;
}

.gf-exchange__readout output,
.gf-exchange__readout b {
  color: #505154;
  font-size: 1.35em;
}

.gf-exchange__arrow {
  position: absolute;
  top: 64%;
  left: 55.5%;
  inline-size: 12.5%;
  block-size: 14.5%;
  background: #c9be4c;
  clip-path: polygon(
    26% 0,
    74% 0,
    74% 42%,
    100% 42%,
    50% 100%,
    0 42%,
    26% 42%
  );
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
  --gf-sound-bar: clamp(3px, 0.9259cqi, 10px);
  --gf-sound-icon: clamp(10px, 1.8519cqi, 20px);
  block-size: 66.6667%;
  padding-inline: 0;
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
