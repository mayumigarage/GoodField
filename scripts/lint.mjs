import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function sourceFiles(directory = ".") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "node_modules", "coverage", "dist"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(file));
    else if (file.endsWith(".ts") || file.endsWith(".mjs")) files.push(file);
  }
  return files;
}

const files = await sourceFiles();

const failures = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  if (source.includes("\t")) failures.push(`${file}: tab character`);
  if (/[ \t]+$/mu.test(source)) failures.push(`${file}: trailing whitespace`);
  if (file.endsWith(".ts") && source.includes("Math.random(")) {
    failures.push(`${file}: Math.random() is forbidden in deterministic game code`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Linted ${files.length} files.\n`);
}
