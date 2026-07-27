import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import type {
  DomainEvent,
  GameCommand,
  MatchState
} from "../../shared/src/model.ts";

export const MATCH_JOURNAL_SCHEMA_VERSION = 1;
export const OPERATIONAL_AUDIT_SCHEMA_VERSION = 1;

export type PersistedMatchMetadata = {
  matchId: string;
  rulesetVersion: string;
  cardPoolVersion: string;
  mode: MatchState["mode"];
  endTimeThreshold: MatchState["endTimeThreshold"];
  playerCount: number;
  createdAt: string;
  updatedAt: string;
  phase: MatchState["phase"];
};

export type PersistedMatch = {
  schemaVersion: typeof MATCH_JOURNAL_SCHEMA_VERSION;
  metadata: PersistedMatchMetadata;
  seed: string;
  commands: GameCommand[];
  events: DomainEvent[];
  state: MatchState;
};

type MatchCreatedJournalEntry = {
  schemaVersion: typeof MATCH_JOURNAL_SCHEMA_VERSION;
  type: "MATCH_CREATED";
  storedAt: string;
  metadata: PersistedMatchMetadata;
  seed: string;
  events: DomainEvent[];
  state: MatchState;
};

type TransitionCommittedJournalEntry = {
  schemaVersion: typeof MATCH_JOURNAL_SCHEMA_VERSION;
  type: "TRANSITION_COMMITTED";
  storedAt: string;
  commands: GameCommand[];
  events: DomainEvent[];
  state: MatchState;
};

type MatchJournalEntry =
  | MatchCreatedJournalEntry
  | TransitionCommittedJournalEntry;

export type MatchPersistence = {
  saveMatchCreated(
    state: MatchState,
    events: readonly DomainEvent[]
  ): void;
  saveTransition(
    state: MatchState,
    commands: readonly GameCommand[],
    events: readonly DomainEvent[]
  ): void;
  loadMatch(matchId: string): PersistedMatch | null;
};

type AuditBase = {
  schemaVersion: typeof OPERATIONAL_AUDIT_SCHEMA_VERSION;
  occurredAt: string;
  matchRef: string;
};

export type OperationalAuditRecord =
  | (AuditBase & {
      category: "COMMAND_REJECTED";
      actorRef: string | null;
      commandRef: string | null;
      code: string;
      revision: number | null;
      eventSeq: number | null;
    })
  | (AuditBase & {
      category: "SYNC_FAILURE";
      viewerKind: "PLAYER" | "SPECTATOR" | "UNKNOWN";
      viewerRef: string | null;
      code: string;
      eventSeq: number | null;
    })
  | (AuditBase & {
      category: "EFFECT_CHAIN_ABORTED";
      attackRef: string;
      maxDepth: number;
      revision: number;
      eventSeq: number;
    });

export type OperationalAuditLog = {
  record(entry: OperationalAuditRecord): void;
};

export type FileMatchPersistenceOptions = {
  directory: string;
  clock?: () => string;
};

export type FileOperationalAuditLogOptions = {
  file: string;
};

function requireIsoDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return value;
}

function reference(value: string, namespace: string): string {
  return createHash("sha256")
    .update(`${namespace}\u0000${value}`, "utf8")
    .digest("hex");
}

function journalFileName(matchId: string): string {
  return `${reference(matchId, "goodfield-match-journal-v1")}.jsonl`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function eventLogIsContiguous(
  events: readonly DomainEvent[],
  afterEventSeq: number
): boolean {
  return events.every(
    (event, index) =>
      event.eventSeq ===
      (index === 0
        ? afterEventSeq + 1
        : (events[index - 1]?.eventSeq ?? afterEventSeq) + 1)
  );
}

function assertStateMatchesEvents(
  state: MatchState,
  events: readonly DomainEvent[],
  previousEventSeq: number
): void {
  if (
    events.length === 0 ||
    !eventLogIsContiguous(events, previousEventSeq) ||
    events.at(-1)?.eventSeq !== state.eventSequence
  ) {
    throw new Error("Persisted events must be contiguous and current");
  }
  if (events.some((event) => event.revision > state.revision)) {
    throw new Error("Persisted event revision is newer than match state");
  }
}

function metadataFor(
  state: MatchState,
  createdAt: string,
  updatedAt: string
): PersistedMatchMetadata {
  return {
    matchId: state.matchId,
    rulesetVersion: state.rulesetVersion,
    cardPoolVersion: state.cardPoolVersion,
    mode: state.mode,
    endTimeThreshold: state.endTimeThreshold,
    playerCount: Object.keys(state.players).length,
    createdAt,
    updatedAt,
    phase: state.phase
  };
}

function parseJournalLine(line: string, lineNumber: number): MatchJournalEntry {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Match journal line ${lineNumber} is not valid JSON`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== MATCH_JOURNAL_SCHEMA_VERSION ||
    !("type" in value) ||
    (value.type !== "MATCH_CREATED" &&
      value.type !== "TRANSITION_COMMITTED")
  ) {
    throw new Error(`Match journal line ${lineNumber} has an invalid schema`);
  }
  return value as MatchJournalEntry;
}

export class FileMatchPersistence implements MatchPersistence {
  readonly #directory: string;
  readonly #clock: () => string;

  constructor(options: FileMatchPersistenceOptions) {
    if (options.directory.length === 0) {
      throw new Error("Persistence directory must not be empty");
    }
    this.#directory = options.directory;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    mkdirSync(this.#directory, { recursive: true });
  }

  saveMatchCreated(
    state: MatchState,
    events: readonly DomainEvent[]
  ): void {
    assertStateMatchesEvents(state, events, 0);
    const file = this.#file(state.matchId);
    if (existsSync(file)) {
      throw new Error(`Match ${state.matchId} is already persisted`);
    }
    const storedAt = requireIsoDate(this.#clock());
    const createdAt = events[0]?.occurredAt ?? storedAt;
    const updatedAt = events.at(-1)?.occurredAt ?? storedAt;
    const entry: MatchCreatedJournalEntry = {
      schemaVersion: MATCH_JOURNAL_SCHEMA_VERSION,
      type: "MATCH_CREATED",
      storedAt,
      metadata: metadataFor(state, createdAt, updatedAt),
      seed: state.rng.seed,
      events: clone([...events]),
      state: clone(state)
    };
    writeFileSync(file, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
  }

  saveTransition(
    state: MatchState,
    commands: readonly GameCommand[],
    events: readonly DomainEvent[]
  ): void {
    const persisted = this.loadMatch(state.matchId);
    if (!persisted) {
      throw new Error(`Match ${state.matchId} is not persisted`);
    }
    if (
      persisted.metadata.rulesetVersion !== state.rulesetVersion ||
      persisted.metadata.cardPoolVersion !== state.cardPoolVersion ||
      persisted.seed !== state.rng.seed
    ) {
      throw new Error("Persisted match identity cannot change");
    }
    assertStateMatchesEvents(
      state,
      events,
      persisted.state.eventSequence
    );
    const entry: TransitionCommittedJournalEntry = {
      schemaVersion: MATCH_JOURNAL_SCHEMA_VERSION,
      type: "TRANSITION_COMMITTED",
      storedAt: requireIsoDate(this.#clock()),
      commands: clone([...commands]),
      events: clone([...events]),
      state: clone(state)
    };
    appendFileSync(this.#file(state.matchId), `${JSON.stringify(entry)}\n`, {
      encoding: "utf8"
    });
  }

  loadMatch(matchId: string): PersistedMatch | null {
    const file = this.#file(matchId);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      throw new Error(`Match journal for ${matchId} is empty`);
    }
    const entries = lines.map((line, index) =>
      parseJournalLine(line, index + 1)
    );
    const created = entries[0];
    if (created?.type !== "MATCH_CREATED") {
      throw new Error("Match journal must start with MATCH_CREATED");
    }
    if (
      created.metadata.matchId !== matchId ||
      created.state.matchId !== matchId
    ) {
      throw new Error("Match journal identity does not match its lookup key");
    }
    let state = created.state;
    const commands: GameCommand[] = [];
    const events = [...created.events];
    let updatedAt = created.metadata.updatedAt;
    for (const entry of entries.slice(1)) {
      if (entry.type !== "TRANSITION_COMMITTED") {
        throw new Error("MATCH_CREATED may only appear once");
      }
      if (
        entry.state.matchId !== matchId ||
        !eventLogIsContiguous(entry.events, state.eventSequence) ||
        entry.events.at(-1)?.eventSeq !== entry.state.eventSequence
      ) {
        throw new Error("Match journal transition is not contiguous");
      }
      commands.push(...entry.commands);
      events.push(...entry.events);
      state = entry.state;
      updatedAt = entry.events.at(-1)?.occurredAt ?? entry.storedAt;
    }
    return {
      schemaVersion: MATCH_JOURNAL_SCHEMA_VERSION,
      metadata: {
        ...created.metadata,
        updatedAt,
        phase: state.phase
      },
      seed: created.seed,
      commands: clone(commands),
      events: clone(events),
      state: clone(state)
    };
  }

  #file(matchId: string): string {
    if (matchId.length === 0) throw new Error("matchId must not be empty");
    return join(this.#directory, journalFileName(matchId));
  }
}

export class InMemoryOperationalAuditLog implements OperationalAuditLog {
  readonly entries: OperationalAuditRecord[] = [];

  record(entry: OperationalAuditRecord): void {
    this.entries.push(clone(entry));
  }
}

export class FileOperationalAuditLog implements OperationalAuditLog {
  readonly #file: string;

  constructor(options: FileOperationalAuditLogOptions) {
    if (options.file.length === 0) {
      throw new Error("Audit log file must not be empty");
    }
    this.#file = options.file;
    mkdirSync(dirname(this.#file), { recursive: true });
  }

  record(entry: OperationalAuditRecord): void {
    appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8"
    });
  }
}

export function commandRejectedAudit(input: {
  occurredAt: string;
  matchId: string;
  actorId: string | null;
  commandId: string | null;
  code: string;
  state: MatchState | null;
}): OperationalAuditRecord {
  return {
    schemaVersion: OPERATIONAL_AUDIT_SCHEMA_VERSION,
    occurredAt: requireIsoDate(input.occurredAt),
    category: "COMMAND_REJECTED",
    matchRef: reference(input.matchId, "match"),
    actorRef:
      input.actorId === null ? null : reference(input.actorId, "actor"),
    commandRef:
      input.commandId === null
        ? null
        : reference(input.commandId, "command"),
    code: input.code,
    revision: input.state?.revision ?? null,
    eventSeq: input.state?.eventSequence ?? null
  };
}

export function syncFailureAudit(input: {
  occurredAt: string;
  matchId: string;
  viewerKind: "PLAYER" | "SPECTATOR" | "UNKNOWN";
  viewerId: string | null;
  code: string;
  eventSeq: number | null;
}): OperationalAuditRecord {
  return {
    schemaVersion: OPERATIONAL_AUDIT_SCHEMA_VERSION,
    occurredAt: requireIsoDate(input.occurredAt),
    category: "SYNC_FAILURE",
    matchRef: reference(input.matchId, "match"),
    viewerKind: input.viewerKind,
    viewerRef:
      input.viewerId === null
        ? null
        : reference(input.viewerId, "viewer"),
    code: input.code,
    eventSeq: input.eventSeq
  };
}

export function effectChainAbortedAudit(
  matchId: string,
  event: Extract<DomainEvent, { type: "REACTION_CHAIN_ABORTED" }>
): OperationalAuditRecord {
  return {
    schemaVersion: OPERATIONAL_AUDIT_SCHEMA_VERSION,
    occurredAt: requireIsoDate(event.occurredAt),
    category: "EFFECT_CHAIN_ABORTED",
    matchRef: reference(matchId, "match"),
    attackRef: reference(event.attackId, "attack"),
    maxDepth: event.maxDepth,
    revision: event.revision,
    eventSeq: event.eventSeq
  };
}
