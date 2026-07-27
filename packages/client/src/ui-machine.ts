import type { Element } from "../../shared/src/card-types.ts";
import { CARD_DEFINITIONS_BY_ID } from "../../shared/src/cards.ts";
import type { GameCommand } from "../../shared/src/model.ts";
import type {
  CardInstanceView,
  GameViewState,
  LearnedMiracleView,
  LegalActionView
} from "../../shared/src/protocol.ts";

export type UiMode =
  | "MATCH_SETUP"
  | "MATCH_INTRO"
  | "WAITING"
  | "COMPOSING_ACTION"
  | "CHOOSING_TARGET"
  | "COMPOSING_REACTION"
  | "CONFIRMING_TRADE"
  | "RESOLVING"
  | "SPECTATING"
  | "MATCH_RESULT";

export type UiInteractionState = {
  mode: UiMode;
  selectedActionCardIds: string[];
  selectedLearnedMiracleIds: string[];
  selectedDefenseCardIds: string[];
  selectedDefenseLearnedMiracleIds: string[];
  selectedTargetIds: string[];
  lastSelectedTargetId: string | null;
  activeReactionId: string | null;
  awaitingCommandId: string | null;
  inputDeadlineAt: string | null;
  inputDeadlineExpired: boolean;
  interactionLocked: boolean;
  selectionInvalidReason: string | null;
  revision: number;
};

export type ActionPreview = {
  attackPower: number | null;
  element: Element | null;
  requiredMp: number;
  targetPlayerIds: string[];
  canSubmit: boolean;
  invalidReason: string | null;
};

export type ActionSourceStatus = {
  selectable: boolean;
  selected: boolean;
  invalidReason: string | null;
};

export type ReactionPreview = {
  reactionId: string | null;
  totalDefense: number;
  requiredMp: number;
  hasSelection: boolean;
  canSubmit: boolean;
  invalidReason: string | null;
};

export type TradePaymentPreview = {
  tradeId: string;
  price: number;
  money: number;
  mp: number;
  hp: number;
  canAfford: boolean;
};

type DeclareActionView = Extract<
  LegalActionView,
  { type: "DECLARE_ACTION" }
>;

type DeclareReactionView = Extract<
  LegalActionView,
  { type: "DECLARE_REACTION" }
>;

export type PreparedCommand = {
  ui: UiInteractionState;
  command: GameCommand;
};

export function initialUiState(): UiInteractionState {
  return {
    mode: "MATCH_SETUP",
    selectedActionCardIds: [],
    selectedLearnedMiracleIds: [],
    selectedDefenseCardIds: [],
    selectedDefenseLearnedMiracleIds: [],
    selectedTargetIds: [],
    lastSelectedTargetId: null,
    activeReactionId: null,
    awaitingCommandId: null,
    inputDeadlineAt: null,
    inputDeadlineExpired: false,
    interactionLocked: false,
    selectionInvalidReason: null,
    revision: -1
  };
}

const HUMAN_INPUT_MODES: ReadonlySet<UiMode> = new Set([
  "COMPOSING_ACTION",
  "CHOOSING_TARGET",
  "COMPOSING_REACTION",
  "CONFIRMING_TRADE"
]);

export function isHumanInputMode(mode: UiMode): boolean {
  return HUMAN_INPUT_MODES.has(mode);
}

function deriveMode(view: GameViewState): UiMode {
  if (view.phase === "MATCH_ENDED") return "MATCH_RESULT";
  const self = view.self;
  if (!self) return "SPECTATING";
  const selfPlayer = view.players.find(
    ({ playerId }) => playerId === self?.playerId
  );
  if (selfPlayer && !selfPlayer.alive) return "SPECTATING";
  if (selfPlayer?.controller === "CPU") return "WAITING";
  if (
    view.phase === "TRADE_CONFIRMATION" &&
    self?.legalActions.some(({ type }) => type === "CONFIRM_BUY")
  ) {
    return "CONFIRMING_TRADE";
  }
  if (
    view.phase === "REACTION_SELECTION" &&
    self?.legalActions.some(({ type }) => type === "DECLARE_REACTION")
  ) {
    return "COMPOSING_REACTION";
  }
  if (
    view.phase === "ACTION_SELECTION" &&
    view.activePlayerId === self?.playerId
  ) {
    return "COMPOSING_ACTION";
  }
  if (
    view.phase === "ACTION_DECLARED" ||
    view.phase === "ACTION_RESOLUTION" ||
    view.phase === "POST_ACTION_GRANT" ||
    view.phase === "REACTION_SELECTION" ||
    view.phase === "TRADE_CONFIRMATION"
  ) {
    return "RESOLVING";
  }
  return "WAITING";
}

function legalTargetIds(view: GameViewState): string[] {
  if (!view.self) return [];
  return view.self.legalActions.flatMap((action) => {
    if (
      action.type === "DECLARE_ACTION" ||
      action.type === "SELL_CARD" ||
      action.type === "DECLARE_BUY"
    ) {
      return action.targetPlayerIds;
    }
    return [];
  });
}

function declareActions(view: GameViewState): DeclareActionView[] {
  return (
    view.self?.legalActions.filter(
      (action): action is DeclareActionView =>
        action.type === "DECLARE_ACTION"
    ) ?? []
  );
}

function declareReaction(view: GameViewState): DeclareReactionView | null {
  return (
    view.self?.legalActions.find(
      (action): action is DeclareReactionView =>
        action.type === "DECLARE_REACTION"
    ) ?? null
  );
}

function hasSelection(current: UiInteractionState): boolean {
  return (
    current.selectedActionCardIds.length > 0 ||
    current.selectedLearnedMiracleIds.length > 0
  );
}

function actionMatchesSelection(
  action: DeclareActionView,
  cardIds: readonly string[],
  miracleIds: readonly string[]
): boolean {
  const allowedCardIds = new Set([
    ...action.cardInstanceIds,
    ...action.additiveCardInstanceIds
  ]);
  const allowedMiracleIds = new Set([
    ...action.learnedMiracleIds,
    ...action.additiveLearnedMiracleIds
  ]);
  return (
    action.cardInstanceIds.every((id) => cardIds.includes(id)) &&
    action.learnedMiracleIds.every((id) => miracleIds.includes(id)) &&
    cardIds.every((id) => allowedCardIds.has(id)) &&
    miracleIds.every((id) => allowedMiracleIds.has(id))
  );
}

function selectedDeclareAction(
  current: UiInteractionState,
  view: GameViewState
): DeclareActionView | null {
  if (!hasSelection(current)) return null;
  return (
    declareActions(view).find((action) =>
      actionMatchesSelection(
        action,
        current.selectedActionCardIds,
        current.selectedLearnedMiracleIds
      )
    ) ?? null
  );
}

function targetForAction(
  current: UiInteractionState,
  action: DeclareActionView
): string | null {
  if (
    current.lastSelectedTargetId &&
    action.targetPlayerIds.includes(current.lastSelectedTargetId)
  ) {
    return current.lastSelectedTargetId;
  }
  return action.targetPlayerIds[0] ?? null;
}

function withSelectedAction(
  current: UiInteractionState,
  action: DeclareActionView
): UiInteractionState {
  const targetPlayerId = targetForAction(current, action);
  const needsTargetChoice = action.targetPlayerIds.length > 1;
  return {
    ...current,
    mode: needsTargetChoice ? "CHOOSING_TARGET" : "COMPOSING_ACTION",
    selectedActionCardIds: [...action.cardInstanceIds],
    selectedLearnedMiracleIds: [...action.learnedMiracleIds],
    selectedTargetIds: targetPlayerId ? [targetPlayerId] : [],
    lastSelectedTargetId: targetPlayerId,
    selectionInvalidReason: null
  };
}

function clearSelectedAction(
  current: UiInteractionState,
  reason: string | null = null
): UiInteractionState {
  return {
    ...current,
    mode: "COMPOSING_ACTION",
    selectedActionCardIds: [],
    selectedLearnedMiracleIds: [],
    selectedTargetIds: [],
    selectionInvalidReason: reason
  };
}

export function synchronizeUiState(
  current: UiInteractionState,
  view: GameViewState
): UiInteractionState {
  if (view.revision < current.revision) return current;
  const serverMode = deriveMode(view);
  const legalTargets = legalTargetIds(view);
  const preservedTarget =
    current.lastSelectedTargetId &&
    legalTargets.includes(current.lastSelectedTargetId)
      ? current.lastSelectedTargetId
      : legalTargets[0] ?? null;
  const revisionChanged = current.revision !== view.revision;
  const reactionId = declareReaction(view)?.reactionId ?? null;
  const reactionChanged = current.activeReactionId !== reactionId;
  const awaitingTimeoutSnapshot =
    current.inputDeadlineExpired &&
    current.revision === view.revision &&
    current.inputDeadlineAt !== null &&
    current.inputDeadlineAt === view.inputDeadlineAt &&
    isHumanInputMode(serverMode);
  const mode = awaitingTimeoutSnapshot ? "RESOLVING" : serverMode;
  const modeChanged = current.mode !== mode;
  const synchronized: UiInteractionState = {
    ...current,
    mode,
    selectedActionCardIds:
      mode === "COMPOSING_ACTION" ? current.selectedActionCardIds : [],
    selectedLearnedMiracleIds:
      mode === "COMPOSING_ACTION" ? current.selectedLearnedMiracleIds : [],
    selectedDefenseCardIds:
      mode === "COMPOSING_REACTION" && !reactionChanged
        ? current.selectedDefenseCardIds
        : [],
    selectedDefenseLearnedMiracleIds:
      mode === "COMPOSING_REACTION" && !reactionChanged
        ? current.selectedDefenseLearnedMiracleIds
        : [],
    selectedTargetIds: preservedTarget ? [preservedTarget] : [],
    lastSelectedTargetId: preservedTarget,
    activeReactionId: reactionId,
    awaitingCommandId:
      revisionChanged || awaitingTimeoutSnapshot
        ? null
        : current.awaitingCommandId,
    inputDeadlineAt: view.inputDeadlineAt,
    inputDeadlineExpired: awaitingTimeoutSnapshot,
    interactionLocked: awaitingTimeoutSnapshot
      ? true
      : revisionChanged
        ? false
        : current.interactionLocked,
    selectionInvalidReason:
      modeChanged ||
      reactionChanged ||
      (revisionChanged && current.interactionLocked)
        ? null
        : current.selectionInvalidReason,
    revision: view.revision
  };
  if (
    mode === "COMPOSING_ACTION" &&
    hasSelection(synchronized) &&
    !selectedDeclareAction(synchronized, view)
  ) {
    return clearSelectedAction(
      synchronized,
      "サーバーの状態が更新されたため、選択を解除しました"
    );
  }
  return synchronized;
}

export function inputDeadlineRemainingSeconds(
  current: UiInteractionState,
  nowMs: number
): number | null {
  if (current.inputDeadlineAt === null) return null;
  const deadlineMs = Date.parse(current.inputDeadlineAt);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
}

export function advanceUiClock(
  current: UiInteractionState,
  view: GameViewState,
  nowMs: number
): UiInteractionState {
  const remainingSeconds = inputDeadlineRemainingSeconds(current, nowMs);
  const selfPlayer = view.players.find(
    ({ playerId }) => playerId === view.self?.playerId
  );
  if (
    remainingSeconds === null ||
    remainingSeconds > 0 ||
    current.inputDeadlineExpired ||
    !isHumanInputMode(current.mode) ||
    selfPlayer?.controller !== "HUMAN"
  ) {
    return current;
  }
  return {
    ...current,
    mode: "RESOLVING",
    selectedActionCardIds: [],
    selectedLearnedMiracleIds: [],
    selectedDefenseCardIds: [],
    selectedDefenseLearnedMiracleIds: [],
    selectedTargetIds: [],
    lastSelectedTargetId: null,
    activeReactionId: null,
    awaitingCommandId: null,
    inputDeadlineExpired: true,
    interactionLocked: true,
    selectionInvalidReason: null
  };
}

export function selectTarget(
  current: UiInteractionState,
  targetPlayerId: string,
  view: GameViewState
): UiInteractionState {
  if (
    current.interactionLocked ||
    (current.mode !== "COMPOSING_ACTION" &&
      current.mode !== "CHOOSING_TARGET")
  ) {
    return current;
  }
  const action = selectedDeclareAction(current, view);
  const selectableTargets = action?.targetPlayerIds ?? legalTargetIds(view);
  if (!selectableTargets.includes(targetPlayerId)) return current;
  return {
    ...current,
    mode: "COMPOSING_ACTION",
    selectedTargetIds: [targetPlayerId],
    lastSelectedTargetId: targetPlayerId,
    selectionInvalidReason: null
  };
}

export function selectActionCard(
  current: UiInteractionState,
  cardInstanceId: string,
  view: GameViewState
): UiInteractionState {
  if (
    current.interactionLocked ||
    (current.mode !== "COMPOSING_ACTION" &&
      current.mode !== "CHOOSING_TARGET")
  ) {
    return current;
  }
  const actions = declareActions(view);
  const activeAction = selectedDeclareAction(current, view);
  const isRequiredByActive =
    activeAction?.cardInstanceIds.includes(cardInstanceId) ?? false;
  const isAdditiveForActive =
    activeAction?.additiveCardInstanceIds.includes(cardInstanceId) ?? false;
  if (activeAction && isAdditiveForActive && !isRequiredByActive) {
    const selected = current.selectedActionCardIds.includes(cardInstanceId);
    return {
      ...current,
      selectedActionCardIds: selected
        ? current.selectedActionCardIds.filter((id) => id !== cardInstanceId)
        : [...current.selectedActionCardIds, cardInstanceId],
      selectionInvalidReason: null
    };
  }
  const primaryAction = actions.find(
    (action) => action.cardInstanceIds[0] === cardInstanceId
  );
  if (!primaryAction) {
    return {
      ...current,
      selectionInvalidReason: "この神器は現在の行動には使用できません"
    };
  }
  if (
    isRequiredByActive &&
    activeAction?.cardInstanceIds[0] === cardInstanceId
  ) {
    return clearSelectedAction(current);
  }
  return withSelectedAction(current, primaryAction);
}

export function selectLearnedMiracle(
  current: UiInteractionState,
  learnedMiracleId: string,
  view: GameViewState
): UiInteractionState {
  if (
    current.interactionLocked ||
    (current.mode !== "COMPOSING_ACTION" &&
      current.mode !== "CHOOSING_TARGET")
  ) {
    return current;
  }
  const actions = declareActions(view);
  const activeAction = selectedDeclareAction(current, view);
  const isRequiredByActive =
    activeAction?.learnedMiracleIds.includes(learnedMiracleId) ?? false;
  const isAdditiveForActive =
    activeAction?.additiveLearnedMiracleIds.includes(learnedMiracleId) ??
    false;
  if (activeAction && isAdditiveForActive && !isRequiredByActive) {
    const selected =
      current.selectedLearnedMiracleIds.includes(learnedMiracleId);
    return {
      ...current,
      selectedLearnedMiracleIds: selected
        ? current.selectedLearnedMiracleIds.filter(
            (id) => id !== learnedMiracleId
          )
        : [...current.selectedLearnedMiracleIds, learnedMiracleId],
      selectionInvalidReason: null
    };
  }
  const primaryAction = actions.find(
    (action) => action.learnedMiracleIds[0] === learnedMiracleId
  );
  if (!primaryAction) {
    return {
      ...current,
      selectionInvalidReason: "この奇跡は現在の行動には使用できません"
    };
  }
  if (
    isRequiredByActive &&
    activeAction?.learnedMiracleIds[0] === learnedMiracleId
  ) {
    return clearSelectedAction(current);
  }
  return withSelectedAction(current, primaryAction);
}

function visibleDefinition(
  source: CardInstanceView | LearnedMiracleView
) {
  return CARD_DEFINITIONS_BY_ID.get(source.cardDefinitionId);
}

function selectedDefinitions(
  current: UiInteractionState,
  view: GameViewState
) {
  const cards =
    view.self?.hand.filter(({ instanceId }) =>
      current.selectedActionCardIds.includes(instanceId)
    ) ?? [];
  const miracles =
    view.self?.learnedMiracles.filter(({ learnedMiracleId }) =>
      current.selectedLearnedMiracleIds.includes(learnedMiracleId)
    ) ?? [];
  return [...cards, ...miracles]
    .map(visibleDefinition)
    .filter((definition) => definition !== undefined);
}

function combineElements(elements: readonly Element[]): Element {
  const unique = [...new Set(elements)];
  if (unique.length === 0) return "PHYSICAL";
  if (unique.length === 1) return unique[0] ?? "PHYSICAL";
  if (unique.includes("PHYSICAL") || unique.includes("DARK")) {
    return "PHYSICAL";
  }
  const nonLight = unique.filter((element) => element !== "LIGHT");
  return nonLight.length === 1 ? nonLight[0] ?? "LIGHT" : "PHYSICAL";
}

export function actionPreview(
  current: UiInteractionState,
  view: GameViewState
): ActionPreview {
  const action = selectedDeclareAction(current, view);
  const definitions = selectedDefinitions(current, view);
  const attackInstructions = definitions.flatMap((definition) =>
    definition.instructions.filter(
      (instruction) => instruction.kind === "ATTACK"
    )
  );
  let attackPower = 0;
  let variableAttack = false;
  const selfPlayer = view.players.find(
    ({ playerId }) => playerId === view.self?.playerId
  );
  for (const instruction of attackInstructions) {
    if (typeof instruction.amount === "number") {
      attackPower += instruction.amount;
    } else if (instruction.amount === "CURRENT_MP_X2") {
      attackPower += (selfPlayer?.mp ?? 0) * 2;
    } else {
      variableAttack = true;
    }
  }
  if (
    definitions.some((definition) =>
      definition.instructions.some(
        (instruction) =>
          instruction.kind === "SPECIAL" &&
          instruction.operation === "DOUBLE_ATTACK"
      )
    )
  ) {
    attackPower *= 2;
  }
  const cutsCost = definitions.some((definition) =>
    definition.instructions.some(
      (instruction) =>
        instruction.kind === "SPECIAL" &&
        instruction.operation === "CUT_COST"
    )
  );
  const consumesAllMp = definitions.some((definition) =>
    definition.instructions.some(
      (instruction) =>
        instruction.kind === "SPECIAL" &&
        instruction.operation === "CONSUME_ALL_MP"
    )
  );
  const requiredMp = cutsCost
    ? 0
    : consumesAllMp
      ? selfPlayer?.mp ?? 0
      : definitions
          .filter(({ category }) => category === "MIRACLE")
          .reduce((sum, definition) => sum + (definition.mpCost ?? 0), 0);
  const paintedElement = definitions
    .flatMap((definition) =>
      definition.instructions.filter(
        (instruction) => instruction.kind === "SET_ELEMENT"
      )
    )
    .at(-1)?.element;
  const targetPlayerId = current.selectedTargetIds[0] ?? null;
  const invalidReason =
    current.selectionInvalidReason ??
    (!hasSelection(current)
      ? "使用する神器または奇跡を選んでください"
      : !action
        ? "選択した組み合わせは現在使用できません"
        : !targetPlayerId ||
            !action.targetPlayerIds.includes(targetPlayerId)
          ? "対象を選んでください"
          : current.interactionLocked
            ? "コマンドを送信中です"
            : null);
  return {
    attackPower:
      attackInstructions.length === 0 || variableAttack
        ? null
        : attackPower,
    element:
      attackInstructions.length === 0
        ? null
        : (paintedElement ??
          combineElements(definitions.map(({ element }) => element))),
    requiredMp,
    targetPlayerIds: action?.targetPlayerIds ?? [],
    canSubmit: invalidReason === null,
    invalidReason
  };
}

export function actionCardStatus(
  current: UiInteractionState,
  view: GameViewState,
  cardInstanceId: string
): ActionSourceStatus {
  const selected = current.selectedActionCardIds.includes(cardInstanceId);
  if (current.interactionLocked) {
    return {
      selectable: false,
      selected,
      invalidReason: "コマンドを送信中です"
    };
  }
  const activeAction = selectedDeclareAction(current, view);
  const selectable = declareActions(view).some(
    (action) => action.cardInstanceIds[0] === cardInstanceId
  ) || (activeAction?.additiveCardInstanceIds.includes(cardInstanceId) ?? false);
  return {
    selectable,
    selected,
    invalidReason: selectable ? null : "現在は使用できません"
  };
}

export function learnedMiracleStatus(
  current: UiInteractionState,
  view: GameViewState,
  learnedMiracleId: string
): ActionSourceStatus {
  const selected =
    current.selectedLearnedMiracleIds.includes(learnedMiracleId);
  if (current.interactionLocked) {
    return {
      selectable: false,
      selected,
      invalidReason: "コマンドを送信中です"
    };
  }
  const activeAction = selectedDeclareAction(current, view);
  const selectable = declareActions(view).some(
    (action) => action.learnedMiracleIds[0] === learnedMiracleId
  ) ||
    (activeAction?.additiveLearnedMiracleIds.includes(
      learnedMiracleId
    ) ??
      false);
  return {
    selectable,
    selected,
    invalidReason: selectable ? null : "現在は使用できません"
  };
}

const SPECIAL_REACTION_OPERATIONS = new Set([
  "BOUNCE_WEAPON",
  "REFLECT_WEAPON",
  "BLOCK_WEAPON",
  "BOUNCE_MIRACLE",
  "REFLECT_MIRACLE",
  "BLOCK_MIRACLE",
  "REFLECT_ANYTHING"
]);

function isSpecialReaction(cardDefinitionId: string): boolean {
  return (
    CARD_DEFINITIONS_BY_ID.get(cardDefinitionId)?.instructions.some(
      (instruction) =>
        instruction.kind === "SPECIAL" &&
        SPECIAL_REACTION_OPERATIONS.has(instruction.operation)
    ) ?? false
  );
}

function selectedReactionSources(
  current: UiInteractionState,
  view: GameViewState
): Array<CardInstanceView | LearnedMiracleView> {
  const cards =
    view.self?.hand.filter(({ instanceId }) =>
      current.selectedDefenseCardIds.includes(instanceId)
    ) ?? [];
  const miracles =
    view.self?.learnedMiracles.filter(({ learnedMiracleId }) =>
      current.selectedDefenseLearnedMiracleIds.includes(learnedMiracleId)
    ) ?? [];
  return [...cards, ...miracles];
}

function hasSelectedSpecialReaction(
  current: UiInteractionState,
  view: GameViewState
): boolean {
  return selectedReactionSources(current, view).some(({ cardDefinitionId }) =>
    isSpecialReaction(cardDefinitionId)
  );
}

export function defenseCardStatus(
  current: UiInteractionState,
  view: GameViewState,
  cardInstanceId: string
): ActionSourceStatus {
  const selected = current.selectedDefenseCardIds.includes(cardInstanceId);
  const reaction = declareReaction(view);
  if (current.interactionLocked) {
    return {
      selectable: false,
      selected,
      invalidReason: "コマンドを送信中です"
    };
  }
  const selectable =
    current.mode === "COMPOSING_REACTION" &&
    (reaction?.defenseCardInstanceIds.includes(cardInstanceId) ?? false);
  return {
    selectable,
    selected,
    invalidReason: selectable ? null : "この攻撃の防御には使用できません"
  };
}

export function defenseMiracleStatus(
  current: UiInteractionState,
  view: GameViewState,
  learnedMiracleId: string
): ActionSourceStatus {
  const selected =
    current.selectedDefenseLearnedMiracleIds.includes(learnedMiracleId);
  const reaction = declareReaction(view);
  if (current.interactionLocked) {
    return {
      selectable: false,
      selected,
      invalidReason: "コマンドを送信中です"
    };
  }
  const selectable =
    current.mode === "COMPOSING_REACTION" &&
    (reaction?.defenseLearnedMiracleIds.includes(learnedMiracleId) ?? false);
  return {
    selectable,
    selected,
    invalidReason: selectable ? null : "この攻撃の防御には使用できません"
  };
}

export function selectDefenseCard(
  current: UiInteractionState,
  cardInstanceId: string,
  view: GameViewState
): UiInteractionState {
  if (current.interactionLocked || current.mode !== "COMPOSING_REACTION") {
    return current;
  }
  const reaction = declareReaction(view);
  if (!reaction?.defenseCardInstanceIds.includes(cardInstanceId)) {
    return {
      ...current,
      selectionInvalidReason: "この神器は今回の防御には使用できません"
    };
  }
  if (current.selectedDefenseCardIds.includes(cardInstanceId)) {
    return {
      ...current,
      selectedDefenseCardIds: current.selectedDefenseCardIds.filter(
        (id) => id !== cardInstanceId
      ),
      selectionInvalidReason: null
    };
  }
  if (
    reaction.maxDefenseCards !== null &&
    current.selectedDefenseCardIds.length >= reaction.maxDefenseCards
  ) {
    return {
      ...current,
      selectionInvalidReason: `防具は最大${reaction.maxDefenseCards}枚までです`
    };
  }
  const card = view.self?.hand.find(
    ({ instanceId }) => instanceId === cardInstanceId
  );
  if (
    card &&
    isSpecialReaction(card.cardDefinitionId) &&
    hasSelectedSpecialReaction(current, view)
  ) {
    return {
      ...current,
      selectionInvalidReason:
        "停止・反射・弾きの効果は1つだけ選択できます"
    };
  }
  return {
    ...current,
    selectedDefenseCardIds: [
      ...current.selectedDefenseCardIds,
      cardInstanceId
    ],
    selectionInvalidReason: null
  };
}

export function selectDefenseMiracle(
  current: UiInteractionState,
  learnedMiracleId: string,
  view: GameViewState
): UiInteractionState {
  if (current.interactionLocked || current.mode !== "COMPOSING_REACTION") {
    return current;
  }
  const reaction = declareReaction(view);
  if (!reaction?.defenseLearnedMiracleIds.includes(learnedMiracleId)) {
    return {
      ...current,
      selectionInvalidReason: "この奇跡は今回の防御には使用できません"
    };
  }
  if (
    current.selectedDefenseLearnedMiracleIds.includes(learnedMiracleId)
  ) {
    return {
      ...current,
      selectedDefenseLearnedMiracleIds:
        current.selectedDefenseLearnedMiracleIds.filter(
          (id) => id !== learnedMiracleId
        ),
      selectionInvalidReason: null
    };
  }
  const miracle = view.self?.learnedMiracles.find(
    ({ learnedMiracleId: id }) => id === learnedMiracleId
  );
  if (
    miracle &&
    isSpecialReaction(miracle.cardDefinitionId) &&
    hasSelectedSpecialReaction(current, view)
  ) {
    return {
      ...current,
      selectionInvalidReason:
        "停止・反射・弾きの効果は1つだけ選択できます"
    };
  }
  return {
    ...current,
    selectedDefenseLearnedMiracleIds: [
      ...current.selectedDefenseLearnedMiracleIds,
      learnedMiracleId
    ],
    selectionInvalidReason: null
  };
}

export function reactionPreview(
  current: UiInteractionState,
  view: GameViewState
): ReactionPreview {
  const reaction = declareReaction(view);
  const sources = selectedReactionSources(current, view);
  const definitions = sources
    .map(visibleDefinition)
    .filter((definition) => definition !== undefined);
  const totalDefense = current.selectedDefenseCardIds.reduce(
    (total, instanceId) =>
      total + (reaction?.defenseValueByCardInstanceId[instanceId] ?? 0),
    0
  );
  const cutsCost = definitions.some((definition) =>
    definition.instructions.some(
      (instruction) =>
        instruction.kind === "SPECIAL" &&
        instruction.operation === "CUT_COST"
    )
  );
  const requiredMp = cutsCost
    ? 0
    : definitions
        .filter(({ category }) => category === "MIRACLE")
        .reduce((total, definition) => total + (definition.mpCost ?? 0), 0);
  const self = view.players.find(
    ({ playerId }) => playerId === view.self?.playerId
  );
  const invalidReason =
    current.selectionInvalidReason ??
    (!reaction || current.mode !== "COMPOSING_REACTION"
      ? "現在は防御を選択できません"
      : requiredMp > (self?.mp ?? 0)
        ? "MPが不足しています"
        : current.interactionLocked
          ? "コマンドを送信中です"
          : null);
  return {
    reactionId: reaction?.reactionId ?? null,
    totalDefense,
    requiredMp,
    hasSelection: sources.length > 0,
    canSubmit: invalidReason === null,
    invalidReason
  };
}

export function tradePaymentPreview(
  view: GameViewState
): TradePaymentPreview | null {
  const trade = view.self?.tradeConfirmation;
  if (!trade) return null;
  const self = view.players.find(
    ({ playerId }) => playerId === view.self?.playerId
  );
  let remaining = trade.price;
  const money = Math.min(self?.money ?? 0, remaining);
  remaining -= money;
  const mp = Math.min(self?.mp ?? 0, remaining);
  remaining -= mp;
  const hp = Math.min(self?.hp ?? 0, remaining);
  return {
    tradeId: trade.tradeId,
    price: trade.price,
    money,
    mp,
    hp,
    canAfford: trade.canAfford
  };
}

export function lockForCommand(
  current: UiInteractionState,
  commandId: string
): UiInteractionState {
  if (current.interactionLocked) return current;
  return {
    ...current,
    awaitingCommandId: commandId,
    interactionLocked: true
  };
}

export function releaseCommandLock(
  current: UiInteractionState,
  view: GameViewState
): UiInteractionState {
  return synchronizeUiState(
    {
      ...current,
      awaitingCommandId: null,
      interactionLocked: false
    },
    view
  );
}

export function prepareDeclareActionSubmission(
  current: UiInteractionState,
  view: GameViewState,
  createCommandId: () => string
): PreparedCommand | null {
  const preview = actionPreview(current, view);
  const actorId = view.self?.playerId;
  const targetPlayerId = current.selectedTargetIds[0];
  if (
    !actorId ||
    !targetPlayerId ||
    current.mode !== "COMPOSING_ACTION" &&
      current.mode !== "CHOOSING_TARGET" ||
    current.inputDeadlineExpired ||
    (!preview.canSubmit && current.awaitingCommandId === null)
  ) {
    return null;
  }
  const commandId = current.awaitingCommandId ?? createCommandId();
  return {
    ui: lockForCommand(current, commandId),
    command: {
      type: "DECLARE_ACTION",
      matchId: view.matchId,
      commandId,
      actorId,
      expectedRevision: view.revision,
      cardInstanceIds: [...current.selectedActionCardIds],
      learnedMiracleIds: [...current.selectedLearnedMiracleIds],
      targetPlayerId
    }
  };
}

export function preparePraySubmission(
  current: UiInteractionState,
  view: GameViewState,
  createCommandId: () => string
): PreparedCommand | null {
  const actorId = view.self?.playerId;
  const canPray =
    view.self?.legalActions.some(({ type }) => type === "PRAY") ?? false;
  if (
    !actorId ||
    (!canPray && current.awaitingCommandId === null) ||
    current.mode !== "COMPOSING_ACTION" ||
    current.inputDeadlineExpired
  ) {
    return null;
  }
  const commandId = current.awaitingCommandId ?? createCommandId();
  return {
    ui: lockForCommand(current, commandId),
    command: {
      type: "PRAY",
      matchId: view.matchId,
      commandId,
      actorId,
      expectedRevision: view.revision
    }
  };
}

export function prepareReactionSubmission(
  current: UiInteractionState,
  view: GameViewState,
  createCommandId: () => string,
  forgive = false
): PreparedCommand | null {
  const actorId = view.self?.playerId;
  const reaction = declareReaction(view);
  const preview = reactionPreview(current, view);
  if (
    !actorId ||
    !reaction ||
    current.mode !== "COMPOSING_REACTION" ||
    current.inputDeadlineExpired ||
    (!forgive && !preview.hasSelection) ||
    (!preview.canSubmit && current.awaitingCommandId === null)
  ) {
    return null;
  }
  const commandId = current.awaitingCommandId ?? createCommandId();
  return {
    ui: lockForCommand(current, commandId),
    command: {
      type: "DECLARE_REACTION",
      matchId: view.matchId,
      commandId,
      actorId,
      expectedRevision: view.revision,
      reactionId: reaction.reactionId,
      defenseCardInstanceIds: forgive
        ? []
        : [...current.selectedDefenseCardIds],
      defenseLearnedMiracleIds: forgive
        ? []
        : [...current.selectedDefenseLearnedMiracleIds]
    }
  };
}

export function prepareBuyConfirmation(
  current: UiInteractionState,
  view: GameViewState,
  accept: boolean,
  createCommandId: () => string
): PreparedCommand | null {
  const actorId = view.self?.playerId;
  const trade = view.self?.tradeConfirmation;
  const legalTrade = view.self?.legalActions.find(
    (action) =>
      action.type === "CONFIRM_BUY" && action.tradeId === trade?.tradeId
  );
  if (
    !actorId ||
    !trade ||
    legalTrade?.type !== "CONFIRM_BUY" ||
    current.mode !== "CONFIRMING_TRADE" ||
    current.inputDeadlineExpired ||
    (accept && !legalTrade.canAfford && current.awaitingCommandId === null)
  ) {
    return null;
  }
  const commandId = current.awaitingCommandId ?? createCommandId();
  return {
    ui: lockForCommand(current, commandId),
    command: {
      type: "CONFIRM_BUY",
      matchId: view.matchId,
      commandId,
      actorId,
      expectedRevision: view.revision,
      tradeId: trade.tradeId,
      accept
    }
  };
}
