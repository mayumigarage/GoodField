import { CARD_DEFINITIONS_BY_ID } from "../../shared/src/cards.ts";
import type { DomainEvent } from "../../shared/src/model.ts";
import type { PresentationStep } from "./presentation-queue.ts";
import { soundVolume } from "./sound-control.ts";

export const SOUND_EFFECT_FILES = {
  alert: "alert.mp3",
  assistantAdd: "assistant_add.mp3",
  assistantRemove: "assistant_remove.mp3",
  block: "block.mp3",
  bookTab: "book_tab_down.mp3",
  button: "button_down.mp3",
  card: "card.mp3",
  clientTurn: "client_turn.mp3",
  counter: "counter.mp3",
  damage: "damage.mp3",
  damageDark: "damage_dark.mp3",
  dead: "dead.mp3",
  defenseHarm: "defense_harm.mp3",
  disease: "disease.mp3",
  draw: "game_draw.mp3",
  dyingAttack: "dying_attack.mp3",
  exchange: "exchange.mp3",
  flick: "flick.mp3",
  gameStart: "game_start.mp3",
  harmAdd: "harm_add.mp3",
  harmRemove: "harm_remove.mp3",
  healHp: "hp_increase.mp3",
  // The effect recording's 22.MP回復 is assistant.mp3, not mp_increase.mp3.
  healMp: "assistant.mp3",
  hit: "hit.mp3",
  illusionItem: "illusion_item.mp3",
  itemRemove: "item_remove.mp3",
  miss: "miss.mp3",
  mortar: "mortar.mp3",
  mystery: "mystery.mp3",
  noChange: "no_change.mp3",
  openCover: "open_cover.mp3",
  reflect: "reflect.mp3",
  revive: "revive.mp3",
  seizure: "seizure.mp3",
  target: "target.mp3",
  toggle: "toggle_down.mp3",
  win: "game_win.mp3",
  winner: "winner.mp3",
  worse: "worse.mp3",
  yenAbsorb: "yen_absorb.mp3",
  yenIncrease: "yen_increase.mp3"
} as const;

export type SoundEffect = keyof typeof SOUND_EFFECT_FILES;

// The action card sound already covers a replacement card granted by the same
// command, and the grant is heard when the concealed card is revealed instead.
// A completed trade conceals its replacement card in the same way.
export function immediateSoundEvents(
  events: readonly DomainEvent[]
): DomainEvent[] {
  const declaresAction = events.some(
    ({ type }) =>
      type === "ACTION_DECLARED" || type === "TRADE_PAYMENT_COLLECTED"
  );
  return declaresAction
    ? events.filter(({ type }) => type !== "CARD_GRANTED")
    : [...events];
}

type DamageAppliedEvent = Extract<DomainEvent, { type: "DAMAGE_APPLIED" }>;
type AttackState = Extract<
  DomainEvent,
  { type: "ATTACK_CREATED" }
>["attack"];

// The dangerous pestle always lands as an undefendable 99 on a mortar holder.
const DANGEROUS_MORTAR_DAMAGE = 99;

// Events that start a new action, so an earlier defense no longer applies.
const ACTION_BOUNDARY_TYPES = new Set<DomainEvent["type"]>([
  "TURN_OPENED",
  "ACTION_DECLARED",
  "ATTACK_CREATED",
  "POST_TURN_AUTOMATIC_EFFECTS_STARTED",
  "GUARDIAN_ACTION_SELECTED",
  "PHENOMENON_SELECTED",
  "CONFUSION_ACTION_SELECTED"
]);

function attackOfDamage(
  damage: DamageAppliedEvent,
  priorEvents: readonly DomainEvent[]
): AttackState | null {
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const event = priorEvents[index];
    if (
      event?.type === "ATTACK_CREATED" &&
      event.attack.attackId === damage.attackId
    ) {
      return event.attack;
    }
  }
  return null;
}

/** 「あぶないキネ」 falling on a holder of 「あぶないウス」. */
export function isDangerousMortarDamage(
  damage: DamageAppliedEvent,
  priorEvents: readonly DomainEvent[]
): boolean {
  return (
    damage.amount >= DANGEROUS_MORTAR_DAMAGE &&
    (attackOfDamage(damage, priorEvents)?.sourceCardDefinitionIds.includes(
      "dangerous-pestle"
    ) ??
      false)
  );
}

/** Dark attacks take all remaining HP once they get through. */
export function isDarkDamage(
  damage: DamageAppliedEvent,
  priorEvents: readonly DomainEvent[]
): boolean {
  return (
    damage.amount > 0 &&
    attackOfDamage(damage, priorEvents)?.element === "DARK"
  );
}

function selfCalamitiesOf(cardDefinitionId: string): string[] {
  return (
    CARD_DEFINITIONS_BY_ID.get(cardDefinitionId)?.instructions.flatMap(
      (instruction) =>
        instruction.kind === "ADD_CALAMITY" && instruction.timing === "SELF"
          ? [instruction.calamity]
          : []
    ) ?? []
  );
}

/**
 * 「防具使用ペナルティ」: a defense card that turns on its own user, such as
 * 夢見る帽子 giving its wearer 夢 and 神器一新 after the attack resolves.
 */
export function isDefensePenalty(
  event: DomainEvent,
  priorEvents: readonly DomainEvent[]
): boolean {
  // 神器一新 only ever comes from the defender's own card.
  if (event.type === "HAND_REDRAWN") return true;
  if (event.type !== "CALAMITY_APPLIED") return false;
  for (let index = priorEvents.length - 1; index >= 0; index -= 1) {
    const prior = priorEvents[index];
    if (!prior || prior.eventSeq >= event.eventSeq) continue;
    if (ACTION_BOUNDARY_TYPES.has(prior.type)) return false;
    if (
      prior.type === "REACTION_DECLARED" &&
      prior.playerId === event.playerId
    ) {
      return (prior.defenseCardDefinitionIds ?? []).some((id) =>
        selfCalamitiesOf(id).includes(event.calamity)
      );
    }
  }
  return false;
}

export function soundEffectForEvent(
  event: DomainEvent,
  selfPlayerId: string | null,
  priorEvents: readonly DomainEvent[] = []
): SoundEffect | null {
  switch (event.type) {
    case "MATCH_STARTED":
      return "gameStart";
    case "TURN_OPENED":
      return event.playerId === selfPlayerId ? "clientTurn" : null;
    case "ACTION_DECLARED":
    case "MIRACLE_CAST":
    case "CARD_GRANTED":
      return "card";
    case "MIRACLE_LEARNED":
      return "mystery";
    case "RESOURCE_CHANGED":
      if (event.delta === 0) return "noChange";
      if (event.delta < 0) {
        if (event.resource !== "HP" || event.reason !== "COUNTER") return null;
        // The ascension bow's arrow lands as ordinary damage; any other
        // COUNTER loss is a defense card's 反撃.
        return priorEvents.findLast(
          ({ eventSeq }) => eventSeq < event.eventSeq
        )?.type === "ASCENSION_BOW_TRIGGERED"
          ? "damage"
          : "counter";
      }
      if (event.resource === "HP") return "healHp";
      if (event.resource === "MP") return "healMp";
      return "yenIncrease";
    case "RESOURCES_EXCHANGED":
      return "exchange";
    // The product and the payment move together, so one sound covers both.
    case "TRADE_PAYMENT_COLLECTED":
      return "yenAbsorb";
    case "CALAMITY_APPLIED":
      return isDefensePenalty(event, priorEvents) ? "defenseHarm" : "harmAdd";
    case "HAND_REDRAWN":
      return "defenseHarm";
    case "CALAMITIES_REMOVED":
      return "harmRemove";
    case "CALAMITY_WORSEN_CHECKED":
      return event.worsened ? "worse" : "noChange";
    // Heaven sickness has nowhere left to worsen: the 発作 takes all HP.
    case "CALAMITY_WORSENED":
      return event.to === null ? "seizure" : "disease";
    case "CONFUSION_ACTIONS_STARTED":
      return "illusionItem";
    case "ARTIFACT_REMOVED":
    case "LEARNED_MIRACLE_REMOVED":
    case "DEMON_OBJECT_REMOVED":
      return "itemRemove";
    case "GUARDIAN_ASSIGNED":
      return "assistantAdd";
    case "GUARDIAN_DEPARTED":
      return "assistantRemove";
    case "DEMON_APPEARED":
    case "PHENOMENON_SELECTED":
      return "mystery";
    case "HIT_ROLLED":
      return event.hit ? "hit" : "miss";
    case "ATTACK_REDIRECTED":
      return event.redirectType === "REFLECT" ? "reflect" : "flick";
    case "ATTACK_STOPPED":
      return "block";
    case "DAMAGE_APPLIED":
      if (event.amount === 0) return "noChange";
      if (isDangerousMortarDamage(event, priorEvents)) return "mortar";
      return isDarkDamage(event, priorEvents) ? "damageDark" : "damage";
    case "ASCENSION_BOW_TRIGGERED":
      return "dyingAttack";
    case "REVIVAL_RESOLVED":
      return "revive";
    case "PLAYER_ASCENDED":
      return "dead";
    case "INPUT_TIMED_OUT":
      return "alert";
    case "MATCH_ENDED":
      if (event.result.kind === "DRAW") return "draw";
      return selfPlayerId !== null &&
        event.result.winnerPlayerIds.includes(selfPlayerId)
        ? "win"
        : "winner";
    default:
      return null;
  }
}

/**
 * The sound of one presentation stage. Multi-stage events sound on the stage
 * whose picture matches the effect: the ascension bow's hit roll follows the
 * bow card, and 「神器一新」 follows the flash of the defense card.
 */
export function soundEffectForPresentationStep(
  step: Pick<PresentationStep, "event" | "stageIndex">,
  selfPlayerId: string | null,
  priorEvents: readonly DomainEvent[] = []
): SoundEffect | null {
  const { event, stageIndex } = step;
  if (event.type === "ASCENSION_BOW_TRIGGERED" && stageIndex > 0) {
    return event.hit ? "hit" : "miss";
  }
  if (event.type === "HAND_REDRAWN" && stageIndex > 0) return null;
  return soundEffectForEvent(event, selfPlayerId, priorEvents);
}

type PlayableAudio = {
  volume: number;
  play: () => Promise<unknown> | unknown;
};

type AudioFactory = (source: string) => PlayableAudio;

function browserAudioFactory(source: string): PlayableAudio {
  return new Audio(source);
}

export class SoundEffectPlayer {
  private readonly createAudio: AudioFactory;
  private readonly basePath: string;

  constructor(
    createAudio: AudioFactory = browserAudioFactory,
    basePath = "/sounds"
  ) {
    this.createAudio = createAudio;
    this.basePath = basePath.replace(/\/$/, "");
  }

  play(effect: SoundEffect): void {
    if (typeof Audio === "undefined" && this.createAudio === browserAudioFactory) {
      return;
    }
    const volume = soundVolume();
    if (volume === 0) return;
    try {
      const audio = this.createAudio(
        `${this.basePath}/${SOUND_EFFECT_FILES[effect]}`
      );
      audio.volume = volume;
      const playback = audio.play();
      if (
        typeof playback === "object" &&
        playback !== null &&
        "catch" in playback
      ) {
        void (playback as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // Audio is optional: unsupported formats and autoplay restrictions
      // must never interrupt game input or realtime synchronization.
    }
  }

  playEvents(
    events: readonly DomainEvent[],
    selfPlayerId: string | null,
    priorEvents: readonly DomainEvent[] = []
  ): void {
    for (const event of events) {
      const effect = soundEffectForEvent(event, selfPlayerId, priorEvents);
      if (effect) this.play(effect);
    }
  }
}
