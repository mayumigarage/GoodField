export type RandomContext =
  | "TURN_ORDER"
  | "CARD_GRANT"
  | "END_TIME_GRANT"
  | "DEMON_EFFECT"
  | "HIT_CHECK"
  | "TARGET_SELECTION"
  | "CALAMITY_WORSEN"
  | "GUARDIAN_ASSIGNMENT"
  | "GUARDIAN_CHECK"
  | "GUARDIAN_ACTION"
  | "GUARDIAN_DEPARTURE"
  | "PHENOMENON"
  | "PHENOMENON_ACTION"
  | "CARD_REMOVAL"
  | "MIRACLE_REMOVAL"
  | "CARD_SHUFFLE"
  | "MONEY_TARGET"
  | "DREAM_DISGUISE"
  | "HAND_LIMIT_DISCARD"
  | "OTHER";

export type RngState = {
  readonly seed: string;
  readonly words: readonly [number, number, number, number];
  readonly index: number;
};

export type RandomEvent = {
  eventSequence: number;
  rngIndex: number;
  context: RandomContext;
  candidatesHash: string;
  selectedKey: string;
};

export type WeightedCandidate<T> = {
  key: string;
  weight: number;
  value: T;
};

export type RandomSelection<T> = {
  value: T;
  key: string;
  state: RngState;
  audit: RandomEvent;
};

function hashSeed(seed: string): [number, number, number, number] {
  let hash = 1_779_033_703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3_432_918_353);
    hash = (hash << 13) | (hash >>> 19);
  }
  const next = (): number => {
    hash = Math.imul(hash ^ (hash >>> 16), 2_246_822_507);
    hash = Math.imul(hash ^ (hash >>> 13), 3_266_489_909);
    return (hash ^= hash >>> 16) >>> 0;
  };
  const words: [number, number, number, number] = [next(), next(), next(), next()];
  if (words.every((word) => word === 0)) words[0] = 1;
  return words;
}

export function createRng(seed: string): RngState {
  if (seed.length === 0) throw new Error("RNG seed must not be empty");
  return { seed, words: hashSeed(seed), index: 0 };
}

export function nextUint32(state: RngState): { value: number; state: RngState } {
  const [a, b, c, d] = state.words;
  const result = Math.imul(((a + d) >>> 0), 9);
  const value = (((result << 7) | (result >>> 25)) + a) >>> 0;
  const t = (b << 9) >>> 0;
  const nextC = (c ^ a) >>> 0;
  const nextD = (d ^ b) >>> 0;
  const nextB = (b ^ nextC) >>> 0;
  const nextA = (a ^ nextD) >>> 0;
  const rotatedC = (nextC ^ t) >>> 0;
  const rotatedD = ((nextD << 11) | (nextD >>> 21)) >>> 0;
  return {
    value,
    state: {
      seed: state.seed,
      words: [nextA, nextB, rotatedC, rotatedD],
      index: state.index + 1
    }
  };
}

function fnv1a(input: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function drawWeighted<T>(
  state: RngState,
  candidates: readonly WeightedCandidate<T>[],
  context: RandomContext,
  eventSequence: number
): RandomSelection<T> {
  const normalized = [...candidates].sort((left, right) => left.key.localeCompare(right.key));
  if (normalized.length === 0) throw new Error("Cannot draw from an empty candidate set");
  if (new Set(normalized.map(({ key }) => key)).size !== normalized.length) {
    throw new Error("Candidate keys must be unique");
  }
  let totalWeight = 0;
  for (const candidate of normalized) {
    if (!Number.isSafeInteger(candidate.weight) || candidate.weight <= 0) {
      throw new Error(`Invalid weight for ${candidate.key}`);
    }
    totalWeight += candidate.weight;
  }
  if (!Number.isSafeInteger(totalWeight)) throw new Error("Total weight is not a safe integer");

  const next = nextUint32(state);
  const selectedIndex = Number(
    (BigInt(next.value) * BigInt(totalWeight)) >> 32n
  );
  let cursor = selectedIndex;
  let selected = normalized[normalized.length - 1];
  for (const candidate of normalized) {
    cursor -= candidate.weight;
    if (cursor < 0) {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw new Error("Weighted draw failed");
  return {
    value: selected.value,
    key: selected.key,
    state: next.state,
    audit: {
      eventSequence,
      rngIndex: state.index,
      context,
      candidatesHash: fnv1a(normalized.map(({ key, weight }) => `${key}:${weight}`).join("|")),
      selectedKey: selected.key
    }
  };
}

export function shuffleDeterministically<T>(
  state: RngState,
  candidates: readonly { key: string; value: T }[],
  context: RandomContext,
  eventSequence: number
): { values: T[]; state: RngState; audits: RandomEvent[] } {
  const remaining = [...candidates].sort((left, right) => left.key.localeCompare(right.key));
  const values: T[] = [];
  const audits: RandomEvent[] = [];
  let nextState = state;
  while (remaining.length > 0) {
    const selection = drawWeighted(
      nextState,
      remaining.map((candidate) => ({ ...candidate, weight: 1 })),
      context,
      eventSequence
    );
    const selectedIndex = remaining.findIndex(({ key }) => key === selection.key);
    const [selected] = remaining.splice(selectedIndex, 1);
    if (!selected) throw new Error("Shuffle selection disappeared");
    values.push(selected.value);
    audits.push(selection.audit);
    nextState = selection.state;
  }
  return { values, state: nextState, audits };
}
