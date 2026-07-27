import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const requiredFiles = [
  "deploy/Dockerfile",
  "deploy/nginx.conf",
  "docs/ONLINE_MVP_ARCHITECTURE.md",
  "docs/ONLINE_OPERATIONS.md",
  "docs/ONLINE_PUBLIC_LIMITATIONS.md",
  "docs/ONLINE_RELEASE_CHECKLIST.md",
  "packages/client/public/online.html"
];

for (const file of requiredFiles) {
  const contents = await readFile(file, "utf8");
  assert.ok(contents.trim().length > 0, `${file} must not be empty`);
}

const tasks = await readFile("docs/IMPLEMENTATION_TASKS.md", "utf8");
for (const task of ["T-056", "T-057", "T-058", "T-059", "T-060", "T-061"]) {
  assert.match(tasks, new RegExp(`### ${task} `, "u"));
}

const checklist = await readFile(
  "docs/ONLINE_RELEASE_CHECKLIST.md",
  "utf8"
);
assert.match(checklist, /ステージング/u);
assert.match(checklist, /本番/u);
assert.match(checklist, /ロールバック/u);

console.log(
  "Online implementation gate passed. " +
    "Staging and production sign-off remain manual release gates."
);
