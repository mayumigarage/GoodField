# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GoodField is a strict-TypeScript, deterministic, server-authoritative web battle game (2–9 seats, Human/CPU mixed, individual battle). Node.js 24 / npm 11, ESM, single runtime dependency (`ws`). Docs and README are largely in Japanese. See also `AGENTS.md` (style, testing, commit/PR rules).

## Commands

- `npm run dev` — watch-compile client + local server; `npm run build` then `npm start` serves `dist/` at http://127.0.0.1:3000 (`GOODFIELD_PORT` / `GOODFIELD_HOST` override).
- `npm test` — all `tests/*.test.ts` via `node --test` (TypeScript run directly by Node; no transpile step).
- Single test file: `node --test tests/t044-load-resilience.test.ts`; single test by name: `node --test --test-name-pattern="<regex>" tests/<file>.test.ts`.
- `npm run typecheck`, `npm run lint` (custom `scripts/lint.mjs`: rejects tabs, trailing whitespace, unused declarations, `Math.random()`).
- `npm run check` — generated-file check + typecheck + lint + tests + build/smoke. `release:check` and `online:check` (adds `test:online`) are the CI gates.
- `npm run generate:cards` / `generate:golden` regenerate catalogs and golden fixtures; validate with `npm run check:generated`. Never hand-edit `*.generated.ts` files.

## Architecture

npm-workspace-style monorepo under `packages/`, no cross-package build graph beyond imports:

- `shared` — models, protocol types (`protocol.ts`), card catalog, seeded RNG. The single home of contracts shared by client and server; don't duplicate protocol shapes. `card-catalog.generated.ts` is generated from the card table in `docs/GAME_RULE_SPEC.md`; Japanese display text (`card-text.ja.generated.ts`) is generated separately so it is swappable.
- `server` — `engine.ts` is the pure, deterministic rules engine (state + seeded RNG + commands → events); everything else wraps it: `command-api` (HTTP commands with `expectedRevision` optimistic locking), `projection` (per-player views that hide other players' hands/secrets), `realtime` (WebSocket event stream; `eventSeq` is a monotonic cursor across public/private/server events, so gaps are normal), `session`/`runtime-match`/`runtime-server` (local play and HTTP/WS runtime), `online-session`/`online-room` (passphrase-based invite rooms, guest sessions, host transfer, CPU takeover on timeout/disconnect), `durable-store`/`persistence` (Postgres-compatible store, revisioned), `cpu.ts` (CPU decisions), `security.ts`.
- `client` — `ui-machine.ts` (UI state machine), `battle-screen.ts` (battle rendering; very large), `presentation-queue.ts` (sequences animations/effects from events), `browser-app.ts`, `online-lobby.ts`. Static assets in `client/public/` are copied by `scripts/copy-static.mjs`.

Key invariants: all randomness goes through the seeded RNG so matches replay deterministically from seed + command log (golden fixtures depend on this); the server re-validates actor, revision, targets, card ownership, MP and phase on every command; clients only ever receive player-specific projections, so tests should assert secrecy as well as state transitions.

## Conventions worth knowing

- Imports use explicit `.ts` extensions in source (`from "./engine.ts"`); the build uses `rewriteRelativeImportExtensions`. (`AGENTS.md` says `.js`, but the existing code uses `.ts`—match the code.)
- Test files are numbered `t0xx-*.test.ts` by staged task; add focused coverage for every behavior change with fixed seeds.
- Specs are normative when behavior is ambiguous: `docs/GAME_RULE_SPEC.md`, `BATTLE_SYSTEM_SPEC.md`, `GAME_UI_FLOW_SPEC.md`; also `PROTOCOL.md` (commands/events/reconnect) and `ONLINE_MVP_ARCHITECTURE.md` (room lifecycle, trust boundary).
- `dist/` and `.goodfield/` are gitignored. `godfield-flash/` is a reference copy of the original Flash game, not part of the build.
