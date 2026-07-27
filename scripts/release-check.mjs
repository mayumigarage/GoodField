import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const requiredFiles = [
  "docs/RELEASE_NOTES.md",
  "docs/OPERATIONS.md",
  "docs/RELEASE_READINESS.md"
];

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
assert.equal(nodeMajor, 24, "Release verification requires Node.js 24");

for (const file of requiredFiles) {
  const contents = await readFile(file, "utf8");
  assert.equal(contents.trim().length > 0, true, `${file} must not be empty`);
}

const tasks = await readFile("docs/IMPLEMENTATION_TASKS.md", "utf8");
const releaseScope = tasks.split("## 9. 保留バックログ")[0] ?? tasks;
assert.equal(
  /^- \[ \]/mu.test(releaseScope),
  false,
  "Release-scope implementation tasks contain unchecked items"
);
assert.match(tasks, /T-046 `\[P2\]` リリース判定/u);

const model = await readFile("packages/shared/src/model.ts", "utf8");
const cards = await readFile("packages/shared/src/cards.ts", "utf8");
assert.match(model, /GOODFIELD_RULESET_2026_07_25/u);
assert.match(cards, /OFFICIAL_WEB_2026_07_24/u);

console.log("Release gate passed for GoodField 0.1.0.");
