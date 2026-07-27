import process from "node:process";

import type {
  OnlineStatePersistence
} from "./durable-store.ts";
import type { MatchPersistence } from "./persistence.ts";
import {
  createGoodFieldServerFromEnvironment,
  type GoodFieldServer
} from "./runtime-server.ts";

type RuntimeDurableStore =
  MatchPersistence &
  OnlineStatePersistence & {
    close?: () => Promise<void> | void;
  };

let server: GoodFieldServer;
let shutdownPromise: Promise<void> | null = null;

async function loadDurableStore(): Promise<RuntimeDurableStore | null> {
  const specifier = process.env.GOODFIELD_DURABLE_STORE_MODULE;
  if (!specifier) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Production requires GOODFIELD_DURABLE_STORE_MODULE"
      );
    }
    return null;
  }
  const loaded = await import(specifier) as {
    createGoodFieldDurableStore?: () =>
      RuntimeDurableStore | Promise<RuntimeDurableStore>;
  };
  if (typeof loaded.createGoodFieldDurableStore !== "function") {
    throw new Error(
      "Durable store module must export createGoodFieldDurableStore()"
    );
  }
  const store = await loaded.createGoodFieldDurableStore();
  if (
    typeof store.saveMatchCreated !== "function" ||
    typeof store.saveTransition !== "function" ||
    typeof store.loadMatch !== "function" ||
    typeof store.saveOnlineState !== "function" ||
    typeof store.loadOnlineState !== "function" ||
    typeof store.deleteExpired !== "function"
  ) {
    throw new Error("Durable store module returned an invalid adapter");
  }
  return store;
}

async function shutdown(
  reason: string,
  error?: unknown
): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  if (error !== undefined) {
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`GoodField ${reason}: ${detail}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`GoodField stopping (${reason}).\n`);
  }
  shutdownPromise = server.stop().catch((stopError: unknown) => {
    const detail =
      stopError instanceof Error
        ? stopError.stack ?? stopError.message
        : String(stopError);
    process.stderr.write(`GoodField shutdown failed: ${detail}\n`);
    process.exitCode = 1;
  });
  return shutdownPromise;
}

const durableStore = await loadDurableStore();
server = createGoodFieldServerFromEnvironment({
  ...(durableStore === null
    ? {}
    : {
        persistence: durableStore,
        onlinePersistence: durableStore
      }),
  onFatalError(error) {
    void shutdown("runtime failure", error);
  }
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("uncaughtException", (error) => {
  void shutdown("uncaught exception", error);
});
process.once("unhandledRejection", (reason) => {
  void shutdown("unhandled rejection", reason);
});

try {
  const address = await server.start();
  process.stdout.write(`GoodField listening at ${address.url}\n`);
} catch (error) {
  const detail =
    error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`GoodField startup failed: ${detail}\n`);
  process.exitCode = 1;
}
