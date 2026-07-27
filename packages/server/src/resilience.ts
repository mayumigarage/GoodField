import type {
  DomainEvent,
  MatchState
} from "../../shared/src/model.ts";
import type {
  RealtimeEventBatch,
  RealtimeFullSnapshot,
  RealtimeMatchMessage
} from "../../shared/src/protocol.ts";

export type LoadScenarioSample = {
  state: MatchState;
  events: readonly DomainEvent[];
  transmittedMessages?: readonly RealtimeMatchMessage[];
};

export type LoadScenarioMetrics = {
  scenarioId: string;
  durationMs: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  heapDeltaBytes: number;
  stateBytes: number;
  eventCount: number;
  eventBytes: number;
  transmittedBytes: number;
};

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function measureLoadScenario(
  scenarioId: string,
  execute: () => LoadScenarioSample
): { sample: LoadScenarioSample; metrics: LoadScenarioMetrics } {
  if (!scenarioId) throw new Error("scenarioId is required");
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const startedAt = process.hrtime.bigint();
  const sample = execute();
  const durationMs =
    Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const cpu = process.cpuUsage(cpuBefore);
  const heapAfterBytes = process.memoryUsage().heapUsed;
  return {
    sample,
    metrics: {
      scenarioId,
      durationMs,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      heapBeforeBytes,
      heapAfterBytes,
      heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
      stateBytes: byteLength(sample.state),
      eventCount: sample.events.length,
      eventBytes: byteLength(sample.events),
      transmittedBytes: (sample.transmittedMessages ?? []).reduce(
        (total, message) => total + byteLength(message),
        0
      )
    }
  };
}

export type ReplicaDeliveryResult =
  | { kind: "APPLIED"; eventSeq: number }
  | { kind: "DUPLICATE"; eventSeq: number }
  | { kind: "RESYNC_REQUIRED"; lastEventSeq: number };

export class ReliableRealtimeReplica {
  #eventSeq: number | null = null;
  #snapshot: RealtimeEventBatch["snapshot"] | null = null;

  get eventSeq(): number | null {
    return this.#eventSeq;
  }

  get snapshot(): RealtimeEventBatch["snapshot"] | null {
    return this.#snapshot === null ? null : structuredClone(this.#snapshot);
  }

  receive(message: RealtimeMatchMessage): ReplicaDeliveryResult {
    if (message.type === "SYNC_ERROR") {
      return {
        kind: "RESYNC_REQUIRED",
        lastEventSeq: this.#eventSeq ?? 0
      };
    }
    if (message.type === "FULL_SNAPSHOT") {
      this.#applyFullSnapshot(message);
      return { kind: "APPLIED", eventSeq: message.eventSeq };
    }
    if (
      this.#eventSeq !== null &&
      message.eventSeq <= this.#eventSeq
    ) {
      return { kind: "DUPLICATE", eventSeq: this.#eventSeq };
    }
    if (
      this.#eventSeq === null ||
      message.afterEventSeq !== this.#eventSeq
    ) {
      return {
        kind: "RESYNC_REQUIRED",
        lastEventSeq: this.#eventSeq ?? 0
      };
    }
    this.#eventSeq = message.eventSeq;
    this.#snapshot = structuredClone(message.snapshot);
    return { kind: "APPLIED", eventSeq: message.eventSeq };
  }

  #applyFullSnapshot(message: RealtimeFullSnapshot): void {
    this.#eventSeq = message.eventSeq;
    this.#snapshot = structuredClone(message.snapshot);
  }
}
