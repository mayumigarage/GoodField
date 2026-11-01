export const SOUND_LEVEL_MAX = 10;

const DEFAULT_SOUND_LEVEL = 6;
const SOUND_SETTINGS_STORAGE_KEY = "goodfield.sound";

type SoundSettings = {
  level: number;
  muted: boolean;
};

function clampSoundLevel(level: number): number {
  return Math.min(SOUND_LEVEL_MAX, Math.max(1, Math.round(level)));
}

function loadSoundSettings(): SoundSettings {
  try {
    const stored = JSON.parse(
      localStorage.getItem(SOUND_SETTINGS_STORAGE_KEY) ?? "null"
    ) as Partial<SoundSettings> | null;
    return {
      level:
        typeof stored?.level === "number" && Number.isFinite(stored.level)
          ? clampSoundLevel(stored.level)
          : DEFAULT_SOUND_LEVEL,
      muted: stored?.muted === true
    };
  } catch {
    return { level: DEFAULT_SOUND_LEVEL, muted: false };
  }
}

let settings = loadSoundSettings();

function applySoundSettings(next: SoundSettings): void {
  settings = next;
  try {
    localStorage.setItem(SOUND_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The choice still applies to this page when storage is unavailable.
  }
}

export function soundVolume(): number {
  return settings.muted ? 0 : settings.level / SOUND_LEVEL_MAX;
}

export function setSoundLevel(level: number): void {
  applySoundSettings({ level: clampSoundLevel(level), muted: false });
}

export function setSoundMuted(muted: boolean): void {
  applySoundSettings({ ...settings, muted });
}

function muteLabel(): string {
  return settings.muted ? "ミュートを解除" : "ミュート";
}

export function renderSoundControl(className = ""): string {
  const bars = Array.from(
    { length: SOUND_LEVEL_MAX },
    (_, index) =>
      `<i data-active="${index < settings.level}"></i>`
  ).join("");
  return `<span class="gf-sound-control ${className}" data-sound-control
    data-muted="${settings.muted}">
    <button type="button" class="gf-sound-control__mute" data-sound-mute
      aria-label="${muteLabel()}" aria-pressed="${settings.muted}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 9v6h4l5 5V4L7 9z"/>
        <path class="gf-sound-control__waves"
          d="M14 8.5a5 5 0 0 1 0 7M16 5a9.5 9.5 0 0 1 0 14"/>
        <path class="gf-sound-control__slash" d="m15 9 6 6m0-6-6 6"/>
      </svg>
    </button>
    <span class="gf-sound-control__meter" data-sound-slider role="slider"
      tabindex="0" aria-label="音量" aria-valuemin="1"
      aria-valuemax="${SOUND_LEVEL_MAX}"
      aria-valuenow="${settings.level}">${bars}</span>
  </span>`;
}

function syncSoundControls(root: Document): void {
  for (const control of root.querySelectorAll<HTMLElement>(
    "[data-sound-control]"
  )) {
    control.dataset.muted = String(settings.muted);
    const mute = control.querySelector("[data-sound-mute]");
    mute?.setAttribute("aria-label", muteLabel());
    mute?.setAttribute("aria-pressed", String(settings.muted));
    const slider = control.querySelector("[data-sound-slider]");
    slider?.setAttribute("aria-valuenow", String(settings.level));
    slider?.querySelectorAll("i").forEach((bar, index) => {
      bar.dataset.active = String(index < settings.level);
    });
  }
}

function closestInEvent(event: Event, selector: string): HTMLElement | null {
  return event.target instanceof Element
    ? event.target.closest<HTMLElement>(selector)
    : null;
}

function levelAtPointer(slider: HTMLElement, clientX: number): number {
  const bounds = slider.getBoundingClientRect();
  return Math.ceil(
    ((clientX - bounds.left) / bounds.width) * SOUND_LEVEL_MAX
  );
}

/**
 * Screens replace their markup on every render, so the controls are handled
 * by delegation and only need installing once per document.
 */
export function installSoundControls(root: Document): void {
  const changeLevelFromPointer = (event: PointerEvent): void => {
    const slider = closestInEvent(event, "[data-sound-slider]");
    if (!slider) return;
    setSoundLevel(levelAtPointer(slider, event.clientX));
    syncSoundControls(root);
  };
  root.addEventListener("click", (event) => {
    if (!closestInEvent(event, "[data-sound-mute]")) return;
    setSoundMuted(!settings.muted);
    syncSoundControls(root);
  });
  root.addEventListener("pointerdown", (event) => {
    closestInEvent(event, "[data-sound-slider]")
      ?.setPointerCapture(event.pointerId);
    changeLevelFromPointer(event);
  });
  root.addEventListener("pointermove", (event) => {
    if (event.buttons !== 0) changeLevelFromPointer(event);
  });
  root.addEventListener("keydown", (event) => {
    if (!closestInEvent(event, "[data-sound-slider]")) return;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    setSoundLevel(settings.level + step);
    syncSoundControls(root);
  });
}
