import type { DomainEvent } from "../../shared/src/model.ts";

export const SOUND_EFFECT_FILES = {
  alert: "alert.mp3",
  assistant: "assistant.mp3",
  assistantAdd: "assistant_add.mp3",
  assistantRemove: "assistant_remove.mp3",
  block: "block.mp3",
  button: "button_down.mp3",
  card: "card.mp3",
  clientTurn: "client_turn.mp3",
  counter: "counter.mp3",
  damage: "damage.mp3",
  dead: "dead.mp3",
  defense: "defense_harm.mp3",
  disease: "disease.mp3",
  draw: "game_draw.mp3",
  exchange: "exchange.mp3",
  gameStart: "game_start.mp3",
  harmAdd: "harm_add.mp3",
  harmRemove: "harm_remove.mp3",
  healHp: "hp_increase.mp3",
  healMp: "mp_increase.mp3",
  hit: "hit.mp3",
  itemRemove: "item_remove.mp3",
  miss: "miss.mp3",
  mystery: "mystery.mp3",
  noChange: "no_change.mp3",
  reflect: "reflect.mp3",
  revive: "revive.mp3",
  target: "target.mp3",
  toggle: "toggle_down.mp3",
  win: "game_win.mp3",
  winner: "winner.mp3",
  worse: "worse.mp3",
  yenIncrease: "yen_increase.mp3"
} as const;

export type SoundEffect = keyof typeof SOUND_EFFECT_FILES;

export function soundEffectForEvent(
  event: DomainEvent,
  selfPlayerId: string | null
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
      if (event.delta < 0) return null;
      if (event.resource === "HP") return "healHp";
      if (event.resource === "MP") return "healMp";
      return "yenIncrease";
    case "RESOURCES_EXCHANGED":
    case "TRADE_PAYMENT_COLLECTED":
    case "CARD_TRANSFERRED":
      return "exchange";
    case "CALAMITY_APPLIED":
      return "harmAdd";
    case "CALAMITIES_REMOVED":
      return "harmRemove";
    case "CALAMITY_WORSEN_CHECKED":
      return event.worsened ? "worse" : "noChange";
    case "CALAMITY_WORSENED":
      return "disease";
    case "ARTIFACT_REMOVED":
    case "LEARNED_MIRACLE_REMOVED":
    case "DEMON_OBJECT_REMOVED":
      return "itemRemove";
    case "GUARDIAN_ASSIGNED":
      return "assistantAdd";
    case "GUARDIAN_DEPARTED":
      return "assistantRemove";
    case "GUARDIAN_ACTION_SELECTED":
      return "assistant";
    case "DEMON_APPEARED":
    case "PHENOMENON_SELECTED":
      return "mystery";
    case "HIT_ROLLED":
      return event.hit ? "hit" : "miss";
    case "ATTACK_REDIRECTED":
      return event.redirectType === "REFLECT" ? "reflect" : "counter";
    case "ATTACK_STOPPED":
      return "block";
    case "REACTION_DECLARED":
    case "DEFENSE_COMMITTED":
      return "defense";
    case "DAMAGE_APPLIED":
      return event.amount > 0 ? "damage" : "noChange";
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
  private volume = 0.55;

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
    try {
      const audio = this.createAudio(
        `${this.basePath}/${SOUND_EFFECT_FILES[effect]}`
      );
      audio.volume = this.volume;
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

  playEvents(events: readonly DomainEvent[], selfPlayerId: string | null): void {
    for (const event of events) {
      const effect = soundEffectForEvent(event, selfPlayerId);
      if (effect) this.play(effect);
    }
  }
}
