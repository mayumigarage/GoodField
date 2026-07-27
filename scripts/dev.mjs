import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const tsc = path.resolve(
  "node_modules",
  "typescript",
  "bin",
  "tsc"
);

function start(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    ...options
  });
}

const initialBuild = start(
  process.execPath,
  [tsc, "-p", "tsconfig.build.json"]
);
const initialBuildExitCode = await new Promise((resolve, reject) => {
  initialBuild.once("error", reject);
  initialBuild.once("exit", (code) => resolve(code ?? 1));
});
if (initialBuildExitCode !== 0) {
  process.exitCode = initialBuildExitCode;
} else {
  const environment = {
    ...process.env,
    GOODFIELD_STATIC_DIR: path.resolve("packages/client/public"),
    GOODFIELD_ASSET_DIR: path.resolve("dist/packages")
  };
  const compiler = start(
    process.execPath,
    [
      tsc,
      "-p",
      "tsconfig.build.json",
      "--watch",
      "--preserveWatchOutput"
    ]
  );
  const server = start(
    process.execPath,
    [
      "--enable-source-maps",
      "--watch",
      "--watch-preserve-output",
      "dist/packages/server/src/runtime-entry.js"
    ],
    { env: environment }
  );
  const children = [compiler, server];
  let stopping = false;

  function stop(signal = "SIGTERM") {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  }

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  for (const child of children) {
    child.once("error", (error) => {
      process.stderr.write(`Development process failed: ${error.message}\n`);
      process.exitCode = 1;
      stop();
    });
    child.once("exit", (code, signal) => {
      if (stopping) return;
      process.stderr.write(
        `Development process exited (${code ?? signal ?? "unknown"}).\n`
      );
      process.exitCode = code ?? 1;
      stop();
    });
  }
}
