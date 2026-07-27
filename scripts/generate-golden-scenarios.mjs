import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateAllGoldenScenarios
} from "../packages/server/src/golden-scenario.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "golden"
);
const checkOnly = process.argv.includes("--check");
const fixtures = generateAllGoldenScenarios();
const failures = [];

if (!checkOnly) mkdirSync(fixtureDirectory, { recursive: true });

for (const fixture of fixtures) {
  const file = join(fixtureDirectory, `${fixture.scenarioId}.json`);
  const contents = `${JSON.stringify(fixture, null, 2)}\n`;
  if (checkOnly) {
    if (!existsSync(file)) {
      failures.push(`${fixture.scenarioId}: fixture is missing`);
      continue;
    }
    if (readFileSync(file, "utf8") !== contents) {
      failures.push(`${fixture.scenarioId}: fixture is out of date`);
    }
  } else {
    writeFileSync(file, contents, "utf8");
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.stderr.write(
    "Run npm run generate:golden and review the fixture diff.\n"
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    checkOnly
      ? `Checked ${fixtures.length} golden scenarios.\n`
      : `Generated ${fixtures.length} golden scenarios.\n`
  );
}
