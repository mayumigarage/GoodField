import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const sourceDirectory = path.resolve("packages/client/public");
const destinationDirectory = path.resolve("dist/public");

await rm(destinationDirectory, { recursive: true, force: true });
await mkdir(path.dirname(destinationDirectory), { recursive: true });
await cp(sourceDirectory, destinationDirectory, { recursive: true });
