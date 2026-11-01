import assert from "node:assert/strict";
import test from "node:test";
import {
  renderSoundControl,
  setSoundLevel,
  setSoundMuted,
  soundVolume
} from "../packages/client/src/sound-control.ts";
import { SoundEffectPlayer } from "../packages/client/src/sound-effects.ts";

function playedVolumes(): number[] {
  const volumes: number[] = [];
  const player = new SoundEffectPlayer(() => ({
    set volume(value: number) {
      volumes.push(value);
    },
    get volume() {
      return 0;
    },
    play: () => undefined
  }));
  player.play("damage");
  return volumes;
}

test("the chosen sound level sets the volume of played effects", (t) => {
  t.after(() => setSoundLevel(6));

  setSoundLevel(3);

  assert.equal(soundVolume(), 0.3);
  assert.deepEqual(playedVolumes(), [0.3]);
});

test("sound levels stay inside the meter", (t) => {
  t.after(() => setSoundLevel(6));

  setSoundLevel(99);
  assert.equal(soundVolume(), 1);

  setSoundLevel(-1);
  assert.equal(soundVolume(), 0.1);
});

test("muting silences effects and keeps the chosen level", (t) => {
  t.after(() => setSoundLevel(6));
  setSoundLevel(4);

  setSoundMuted(true);
  assert.deepEqual(playedVolumes(), []);

  setSoundMuted(false);
  assert.equal(soundVolume(), 0.4);
});

test("changing the level clears mute", (t) => {
  t.after(() => setSoundLevel(6));
  setSoundMuted(true);

  setSoundLevel(2);

  assert.equal(soundVolume(), 0.2);
});

test("the control renders the current level and mute state", (t) => {
  t.after(() => setSoundLevel(6));
  setSoundLevel(2);
  setSoundMuted(true);

  const markup = renderSoundControl("extra");

  assert.match(markup, /class="gf-sound-control extra"/);
  assert.match(markup, /data-muted="true"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /aria-valuenow="2"/);
  assert.equal(markup.match(/<i data-active="true">/g)?.length, 2);
  assert.equal(markup.match(/<i data-active="false">/g)?.length, 8);
});
