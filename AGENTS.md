# Repository Guidelines

## Project Structure & Module Organization

GoodField is a strict TypeScript implementation of a deterministic, server-authoritative web battle game.

- `packages/shared/src/`: shared models, protocol types, card catalog, and seeded RNG.
- `packages/server/src/`: game engine, sessions, persistence, projections, HTTP/WebSocket runtime, and CPU logic.
- `packages/client/src/`: browser application, UI state machine, battle screen, lobby, and presentation queue.
- `packages/client/public/`: HTML, CSS, card images, and sound assets copied into builds.
- `tests/`: Node test-runner suites; numbered `t0xx-*.test.ts` files cover staged integration and release behavior.
- `docs/`: normative game, battle, UI, architecture, operations, and release specifications.
- `scripts/`: development, generation, lint, smoke-test, and release-check tooling.

Treat `docs/GAME_RULE_SPEC.md`, `docs/BATTLE_SYSTEM_SPEC.md`, and `docs/GAME_UI_FLOW_SPEC.md` as authoritative when behavior is ambiguous.

## Build, Test, and Development Commands

Use Node.js 24 and npm 11.

- `npm ci`: install the lockfile-defined dependencies.
- `npm run dev`: watch-compile the client and start the local server.
- `npm run build`: compile TypeScript and copy static assets to `dist/`.
- `npm start`: serve the built application at `http://127.0.0.1:3000`.
- `npm test`: run all `tests/*.test.ts` suites with Node's test runner.
- `npm run check`: verify generated files, types, lint, tests, build, and smoke behavior.
- `npm run release:check`: run the same gate used by CI.
- `npm run test:online`: run online session, room, multibrowser, and load suites.

## Coding Style & Naming Conventions

Use ESM and explicit `.js` extensions in TypeScript imports. Follow existing two-space indentation, double quotes, semicolons, and trailing commas. Use `camelCase` for values/functions, `PascalCase` for types/classes, and kebab-case filenames such as `runtime-server.ts`. Keep shared contracts in `packages/shared`; do not duplicate protocol shapes.

Run `npm run lint` and `npm run typecheck` before committing. Tabs, trailing whitespace, unused declarations, and `Math.random()` are rejected. Use the seeded RNG for deterministic game logic.

## Testing Guidelines

Add focused `*.test.ts` coverage for every behavior change. Preserve fixed seeds and assert player-specific secrecy as well as state transitions. Update generated catalogs or golden fixtures only through `npm run generate:cards` or `npm run generate:golden`, then validate with `npm run check:generated`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Support counter reactions...` and `Conceal replacement cards...`. Keep each commit scoped to one coherent change. Pull requests should explain player-visible and protocol effects, link the relevant issue/spec, list verification commands, and include screenshots for UI changes. Note configuration, migration, rollback, or generated-file impacts explicitly.
