import type {
  DomainEvent,
  GameCommand,
  MatchState
} from "../../shared/src/model.ts";
import type {
  MatchPersistence,
  PersistedMatch
} from "./persistence.ts";

export const DURABLE_STORE_SCHEMA_VERSION = 1 as const;

export type OnlineStateCheckpoint = {
  schemaVersion: typeof DURABLE_STORE_SCHEMA_VERSION;
  storedAt: string;
  rooms: unknown;
  sessions: unknown;
  reconnectCursors: Readonly<Record<string, number>>;
};

export type VersionedOnlineState = {
  version: number;
  checkpoint: OnlineStateCheckpoint;
};

export type OnlineStatePersistence = {
  loadOnlineState(): VersionedOnlineState | null;
  saveOnlineState(
    expectedVersion: number | null,
    checkpoint: OnlineStateCheckpoint
  ): number;
  deleteExpired(before: string): {
    rooms: number;
    matches: number;
  };
};

export type SqlQueryResult = {
  rows: readonly Readonly<Record<string, unknown>>[];
  rowCount: number;
};

/**
 * A deliberately small synchronous transaction port. The authoritative engine
 * only publishes a transition after persistence succeeds, so production
 * bindings must keep the callback on one PostgreSQL transaction/connection.
 */
export type TransactionalSqlClient = {
  transaction<T>(operation: (client: TransactionalSqlClient) => T): T;
  query(
    statement: string,
    parameters?: readonly unknown[]
  ): SqlQueryResult;
};

export const POSTGRES_DURABLE_STORE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS goodfield_matches (
    match_id text PRIMARY KEY,
    revision bigint NOT NULL,
    event_sequence bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS goodfield_online_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS goodfield_matches_expires_at_idx
    ON goodfield_matches (expires_at)`
] as const;

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

function isoDate(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO date`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return JSON.parse(value) as unknown;
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchPayload(
  state: MatchState,
  commands: readonly GameCommand[],
  events: readonly DomainEvent[],
  createdAt: string,
  updatedAt: string
): PersistedMatch {
  return {
    schemaVersion: 1,
    metadata: {
      matchId: state.matchId,
      rulesetVersion: state.rulesetVersion,
      cardPoolVersion: state.cardPoolVersion,
      mode: state.mode,
      endTimeThreshold: state.endTimeThreshold,
      playerCount: Object.keys(state.players).length,
      createdAt,
      updatedAt,
      phase: state.phase
    },
    seed: state.rng.seed,
    commands: clone([...commands]),
    events: clone([...events]),
    state: clone(state)
  };
}

function parsePersistedMatch(value: unknown): PersistedMatch {
  const parsed = record(jsonValue(value), "match payload");
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.seed !== "string" ||
    !Array.isArray(parsed.commands) ||
    !Array.isArray(parsed.events)
  ) {
    throw new Error("Stored match payload is incompatible");
  }
  record(parsed.metadata, "match metadata");
  record(parsed.state, "match state");
  return clone(parsed as PersistedMatch);
}

function parseCheckpoint(value: unknown): OnlineStateCheckpoint {
  const parsed = record(jsonValue(value), "online checkpoint");
  if (
    parsed.schemaVersion !== DURABLE_STORE_SCHEMA_VERSION ||
    typeof parsed.storedAt !== "string"
  ) {
    throw new Error("Stored online checkpoint is incompatible");
  }
  isoDate(parsed.storedAt, "storedAt");
  const cursors = record(parsed.reconnectCursors, "reconnectCursors");
  for (const [key, cursor] of Object.entries(cursors)) {
    if (key.length === 0) throw new Error("Reconnect cursor key is empty");
    integer(cursor, `reconnectCursors.${key}`);
  }
  return clone(parsed as OnlineStateCheckpoint);
}

export class DurableStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableStoreConflictError";
  }
}

export type PostgresGoodFieldStoreOptions = {
  client: TransactionalSqlClient;
  clock?: () => string;
  retentionMs?: number;
  migrate?: boolean;
};

export class PostgresGoodFieldStore
implements MatchPersistence, OnlineStatePersistence {
  readonly #client: TransactionalSqlClient;
  readonly #clock: () => string;
  readonly #retentionMs: number;

  constructor(options: PostgresGoodFieldStoreOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < 1) {
      throw new Error("retentionMs must be a positive integer");
    }
    if (options.migrate ?? true) {
      this.#client.transaction((client) => {
        for (const migration of POSTGRES_DURABLE_STORE_MIGRATIONS) {
          client.query(migration);
        }
      });
    }
  }

  saveMatchCreated(
    state: MatchState,
    events: readonly DomainEvent[]
  ): void {
    const storedAt = isoDate(this.#clock(), "clock");
    const expiresAt = new Date(
      Date.parse(storedAt) + this.#retentionMs
    ).toISOString();
    const payload = matchPayload(
      state,
      [],
      events,
      events[0]?.occurredAt ?? storedAt,
      events.at(-1)?.occurredAt ?? storedAt
    );
    this.#client.transaction((client) => {
      const inserted = client.query(
        `INSERT INTO goodfield_matches
          (match_id, revision, event_sequence, expires_at, payload, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (match_id) DO NOTHING`,
        [
          state.matchId,
          state.revision,
          state.eventSequence,
          expiresAt,
          JSON.stringify(payload),
          storedAt
        ]
      );
      if (inserted.rowCount !== 1) {
        throw new DurableStoreConflictError(
          `Match ${state.matchId} already exists`
        );
      }
    });
  }

  saveTransition(
    state: MatchState,
    commands: readonly GameCommand[],
    events: readonly DomainEvent[]
  ): void {
    const storedAt = isoDate(this.#clock(), "clock");
    const expiresAt = new Date(
      Date.parse(storedAt) + this.#retentionMs
    ).toISOString();
    this.#client.transaction((client) => {
      const selected = client.query(
        `SELECT revision, event_sequence, payload
           FROM goodfield_matches
          WHERE match_id = $1
          FOR UPDATE`,
        [state.matchId]
      );
      const row = selected.rows[0];
      if (!row) {
        throw new DurableStoreConflictError(
          `Match ${state.matchId} does not exist`
        );
      }
      const previousRevision = integer(row.revision, "revision");
      const previousEventSequence = integer(
        row.event_sequence,
        "event_sequence"
      );
      if (
        state.revision <= previousRevision ||
        state.eventSequence <= previousEventSequence
      ) {
        throw new DurableStoreConflictError(
          `Match ${state.matchId} transition is stale`
        );
      }
      const previous = parsePersistedMatch(row.payload);
      const payload = matchPayload(
        state,
        [...previous.commands, ...commands],
        [...previous.events, ...events],
        previous.metadata.createdAt,
        events.at(-1)?.occurredAt ?? storedAt
      );
      const updated = client.query(
        `UPDATE goodfield_matches
            SET revision = $2,
                event_sequence = $3,
                expires_at = $4,
                payload = $5::jsonb,
                updated_at = $6
          WHERE match_id = $1
            AND revision = $7
            AND event_sequence = $8`,
        [
          state.matchId,
          state.revision,
          state.eventSequence,
          expiresAt,
          JSON.stringify(payload),
          storedAt,
          previousRevision,
          previousEventSequence
        ]
      );
      if (updated.rowCount !== 1) {
        throw new DurableStoreConflictError(
          `Match ${state.matchId} was updated concurrently`
        );
      }
    });
  }

  loadMatch(matchId: string): PersistedMatch | null {
    const selected = this.#client.query(
      `SELECT payload
         FROM goodfield_matches
        WHERE match_id = $1
          AND expires_at > $2`,
      [matchId, isoDate(this.#clock(), "clock")]
    );
    const row = selected.rows[0];
    return row ? parsePersistedMatch(row.payload) : null;
  }

  loadOnlineState(): VersionedOnlineState | null {
    const selected = this.#client.query(
      `SELECT version, payload
         FROM goodfield_online_state
        WHERE singleton = true
          AND expires_at > $1`,
      [isoDate(this.#clock(), "clock")]
    );
    const row = selected.rows[0];
    return row
      ? {
          version: integer(row.version, "version"),
          checkpoint: parseCheckpoint(row.payload)
        }
      : null;
  }

  saveOnlineState(
    expectedVersion: number | null,
    checkpoint: OnlineStateCheckpoint
  ): number {
    const parsed = parseCheckpoint(checkpoint);
    const storedAt = isoDate(this.#clock(), "clock");
    const expiresAt = new Date(
      Date.parse(storedAt) + this.#retentionMs
    ).toISOString();
    return this.#client.transaction((client) => {
      const selected = client.query(
        `SELECT version
           FROM goodfield_online_state
          WHERE singleton = true
          FOR UPDATE`
      );
      const row = selected.rows[0];
      const currentVersion = row
        ? integer(row.version, "version")
        : null;
      if (currentVersion !== expectedVersion) {
        throw new DurableStoreConflictError(
          "Online state checkpoint was updated concurrently"
        );
      }
      const nextVersion = (currentVersion ?? 0) + 1;
      const written = row
        ? client.query(
            `UPDATE goodfield_online_state
                SET version = $1,
                    expires_at = $2,
                    payload = $3::jsonb,
                    updated_at = $4
              WHERE singleton = true
                AND version = $5`,
            [
              nextVersion,
              expiresAt,
              JSON.stringify(parsed),
              storedAt,
              currentVersion
            ]
          )
        : client.query(
            `INSERT INTO goodfield_online_state
              (singleton, version, expires_at, payload, updated_at)
             VALUES (true, $1, $2, $3::jsonb, $4)
             ON CONFLICT (singleton) DO NOTHING`,
            [
              nextVersion,
              expiresAt,
              JSON.stringify(parsed),
              storedAt
            ]
          );
      if (written.rowCount !== 1) {
        throw new DurableStoreConflictError(
          "Online state checkpoint could not be committed"
        );
      }
      return nextVersion;
    });
  }

  deleteExpired(before: string): {
    rooms: number;
    matches: number;
  } {
    const cutoff = isoDate(before, "before");
    return this.#client.transaction((client) => {
      const rooms = client.query(
        `DELETE FROM goodfield_online_state
          WHERE singleton = true
            AND expires_at <= $1`,
        [cutoff]
      ).rowCount;
      const matches = client.query(
        `DELETE FROM goodfield_matches
          WHERE expires_at <= $1`,
        [cutoff]
      ).rowCount;
      return { rooms, matches };
    });
  }
}
