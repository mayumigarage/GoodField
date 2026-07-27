import type {
  CommandBase,
  CommandResult,
  GameCommand,
  MatchState
} from "../../shared/src/model.ts";
import type {
  GameViewState,
  LegalActionView
} from "../../shared/src/protocol.ts";
import {
  createRng,
  drawWeighted,
  type RngState
} from "../../shared/src/rng.ts";
import { handleCommand } from "./engine.ts";
import { projectGameView } from "./projection.ts";

export type CpuDecisionOptions = {
  seed: string;
  commandId?: string;
  occurredAt?: string;
};

export type HandleCpuDecisionOptions = {
  seed?: string;
  commandId?: string;
  occurredAt?: string;
};

export type HandledCpuDecision = {
  command: GameCommand;
  result: CommandResult;
};

type DecisionCursor = {
  state: RngState;
};

function selectOne<T>(
  cursor: DecisionCursor,
  values: readonly T[],
  keyFor: (value: T, index: number) => string
): T | null {
  if (values.length === 0) return null;
  const selection = drawWeighted(
    cursor.state,
    values.map((value, index) => ({
      key: `${keyFor(value, index)}:${String(index).padStart(4, "0")}`,
      weight: 1,
      value
    })),
    "OTHER",
    0
  );
  cursor.state = selection.state;
  return selection.value;
}

function isExecutable(
  view: GameViewState,
  action: LegalActionView
): boolean {
  switch (action.type) {
    case "DECLARE_ACTION":
      return (
        action.cardInstanceIds.length + action.learnedMiracleIds.length > 0 &&
        action.targetPlayerIds.length > 0
      );
    case "DISCARD":
    case "SACRIFICE":
      return action.cardInstanceIds.length > 0;
    case "EXCHANGE_RESOURCES":
      return (
        action.cardInstanceIds.length > 0 &&
        view.players.some(({ playerId }) => playerId === view.self?.playerId)
      );
    case "SELL_CARD":
      return (
        action.cardInstanceIds.length > 0 &&
        action.productCardInstanceIds.length > 0 &&
        action.targetPlayerIds.length > 0
      );
    case "DECLARE_BUY":
      return (
        action.cardInstanceIds.length > 0 &&
        action.targetPlayerIds.length > 0
      );
    case "PRAY":
    case "SURRENDER":
    case "CONFIRM_BUY":
    case "DECLARE_REACTION":
      return true;
  }
}

function actionKey(action: LegalActionView): string {
  return `${action.type}:${JSON.stringify(action)}`;
}

function commandBase(
  view: GameViewState,
  options: CpuDecisionOptions
): CommandBase | null {
  if (!view.self) return null;
  const base: CommandBase = {
    matchId: view.matchId,
    commandId:
      options.commandId ?? `cpu:${view.self.playerId}:${view.revision}`,
    actorId: view.self.playerId,
    expectedRevision: view.revision
  };
  return options.occurredAt === undefined
    ? base
    : { ...base, occurredAt: options.occurredAt };
}

function commandForAction(
  view: GameViewState,
  action: LegalActionView,
  base: CommandBase,
  cursor: DecisionCursor
): GameCommand | null {
  switch (action.type) {
    case "PRAY":
    case "SURRENDER":
      return { ...base, type: action.type };
    case "DECLARE_ACTION": {
      const targetPlayerId = selectOne(
        cursor,
        action.targetPlayerIds,
        (playerId) => playerId
      );
      if (!targetPlayerId) return null;
      return {
        ...base,
        type: "DECLARE_ACTION",
        cardInstanceIds: [...action.cardInstanceIds],
        learnedMiracleIds: [...action.learnedMiracleIds],
        targetPlayerId
      };
    }
    case "DISCARD":
    case "SACRIFICE": {
      const cardInstanceId = selectOne(
        cursor,
        action.cardInstanceIds,
        (instanceId) => instanceId
      );
      if (!cardInstanceId) return null;
      return { ...base, type: action.type, cardInstanceId };
    }
    case "EXCHANGE_RESOURCES": {
      const cardInstanceId = selectOne(
        cursor,
        action.cardInstanceIds,
        (instanceId) => instanceId
      );
      const self = view.players.find(
        ({ playerId }) => playerId === view.self?.playerId
      );
      if (!cardInstanceId || !self) return null;
      return {
        ...base,
        type: "EXCHANGE_RESOURCES",
        cardInstanceId,
        hp: self.hp,
        mp: self.mp,
        money: self.money
      };
    }
    case "SELL_CARD": {
      const cardInstanceId = selectOne(
        cursor,
        action.cardInstanceIds,
        (instanceId) => instanceId
      );
      const productCardInstanceId = selectOne(
        cursor,
        action.productCardInstanceIds,
        (instanceId) => instanceId
      );
      const targetPlayerId = selectOne(
        cursor,
        action.targetPlayerIds,
        (playerId) => playerId
      );
      if (!cardInstanceId || !productCardInstanceId || !targetPlayerId) {
        return null;
      }
      return {
        ...base,
        type: "SELL_CARD",
        cardInstanceId,
        productCardInstanceId,
        targetPlayerId
      };
    }
    case "DECLARE_BUY": {
      const cardInstanceId = selectOne(
        cursor,
        action.cardInstanceIds,
        (instanceId) => instanceId
      );
      const targetPlayerId = selectOne(
        cursor,
        action.targetPlayerIds,
        (playerId) => playerId
      );
      if (!cardInstanceId || !targetPlayerId) return null;
      return {
        ...base,
        type: "DECLARE_BUY",
        cardInstanceId,
        targetPlayerId
      };
    }
    case "CONFIRM_BUY":
      return {
        ...base,
        type: "CONFIRM_BUY",
        tradeId: action.tradeId,
        accept: action.canAfford
      };
    case "DECLARE_REACTION": {
      const defenses = [
        ...action.defenseCardInstanceIds.map((instanceId) => ({
          kind: "CARD" as const,
          instanceId
        })),
        ...action.defenseLearnedMiracleIds.map((instanceId) => ({
          kind: "MIRACLE" as const,
          instanceId
        }))
      ];
      const defense = selectOne(
        cursor,
        defenses,
        ({ kind, instanceId }) => `${kind}:${instanceId}`
      );
      return {
        ...base,
        type: "DECLARE_REACTION",
        reactionId: action.reactionId,
        defenseCardInstanceIds:
          defense?.kind === "CARD" ? [defense.instanceId] : [],
        defenseLearnedMiracleIds:
          defense?.kind === "MIRACLE" ? [defense.instanceId] : []
      };
    }
  }
}

export function chooseCpuCommand(
  view: GameViewState,
  options: CpuDecisionOptions
): GameCommand | null {
  const base = commandBase(view, options);
  if (!base || !view.self) return null;
  const executable = view.self.legalActions.filter((action) =>
    isExecutable(view, action)
  );
  const nonSurrender = executable.filter(
    ({ type }) => type !== "SURRENDER"
  );
  const candidates = nonSurrender.length > 0 ? nonSurrender : executable;
  const cursor: DecisionCursor = { state: createRng(options.seed) };
  const action = selectOne(cursor, candidates, actionKey);
  return action ? commandForAction(view, action, base, cursor) : null;
}

export function handleCpuDecision(
  state: MatchState,
  playerId: string,
  options: HandleCpuDecisionOptions = {}
): HandledCpuDecision | null {
  const player = state.players[playerId];
  if (!player || player.controller !== "CPU") return null;
  const decisionOptions: CpuDecisionOptions = {
    seed:
      options.seed ??
      `${state.rng.seed}:cpu:${playerId}:${state.revision}`
  };
  if (options.commandId !== undefined) {
    decisionOptions.commandId = options.commandId;
  }
  if (options.occurredAt !== undefined) {
    decisionOptions.occurredAt = options.occurredAt;
  }
  const command = chooseCpuCommand(
    projectGameView(state, playerId),
    decisionOptions
  );
  return command
    ? { command, result: handleCommand(state, command, "CPU") }
    : null;
}
