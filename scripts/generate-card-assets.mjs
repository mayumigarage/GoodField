import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

const legacyAssetRoot = path.resolve(
  "godfield-flash/client-files/static.godfield.net/images/card"
);
const outputAssetRoot = path.resolve("packages/client/public/images/cards");
const outputCatalogPath = path.resolve(
  "packages/client/src/card-images.generated.ts"
);

async function imageFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await imageFiles(entryPath)));
    } else if (entry.name.endsWith(".png")) {
      files.push(entryPath);
    }
  }
  return files;
}

function comparable(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

// These names changed between the archived Flash catalog and the current rules.
// Only visually equivalent pairs are listed; new cards keep the category mark.
const renamedLegacyFiles = {
  crossbow: "bowgun",
  "plate-of-strike": "toushi_no_teppan",
  "bouncing-sword": "randamuken",
  "warrior-s-bow": "kenshi_no_yumi",
  "dragon-claws": "dragon_claw",
  "wind-talons": "sunakaze_no_tsume",
  "sword-ware": "tsurugiyaki",
  "mature-rubber-bow": "gom_no_yumi",
  "fire-crossbow": "fire_bowgun",
  "abyss-dart": "kage_no_dart",
  "neolithic-tomahawk": "kyuusekki_tomahawk",
  "shadow-hand": "demon_hand",
  "plant-cup": "shinrinhai",
  "rock-cup": "daichihai",
  "oversize-snowball": "yukidama_gorogoro",
  "rain-deity-s-saber": "gouu_no_saber",
  "sparkle-glove": "hibana_no_kote",
  "burning-shield": "burn_shield",
  "burning-jacket": "burn_jacket",
  "energy-armor": "energy_wear",
  "strength-powder": "weapon_ko",
  dream: "genkaku",
  flash: "eikou",
  mudflow: "dosekiryuu",
  tone: "neiro",
  release: "kaihou"
};

const assistantActionFiles = [
  "empa2",
  "empa3",
  "empa4",
  "empa5",
  "empa6",
  "kirisame",
  "kiri_no_iki",
  "mizushibuki",
  "awa",
  "arare",
  "eda",
  "nekko",
  "shokushu",
  "kouyou",
  "ochiba_no_mai",
  "koishi",
  "chuuishi",
  "ooishi",
  "taiatari",
  "diamond_axe",
  "temmetsu",
  "dengeki",
  "gokou",
  "shukufuku",
  "laser_beam",
  "shikou",
  "mabataki",
  "fukitsuna_yokan",
  "sekibarai",
  "kyoshu",
  "sazanami_no_oto",
  "ushiojiru",
  "iso_no_kaori",
  "assaritoshita_ushiojiru",
  "sawayakana_iso_no_kaori",
  "kozeni_baramaki",
  "wairo",
  "bakkin",
  "tsumaranai_mono",
  "goukana_accessory",
  "morasu",
  "mangetsutou"
];

const phenomenonFiles = [
  "yuuyake",
  "noumu",
  "kinoko_daihassei",
  "sabaku_tatsumaki",
  "kyodaina_tarai",
  "black_hole",
  "danryuu",
  "kinzan_hakken",
  "jikiarashi",
  "nisshoku"
];

const legacyFiles = await imageFiles(legacyAssetRoot);
const legacyPathByBasename = new Map(
  legacyFiles.map((file) => [path.basename(file, ".png"), file])
);
const swf = await readFile(
  "godfield-flash/client-files/www.godfield.net/game/godfield.swf"
);
if (swf.toString("ascii", 0, 3) !== "CWS") {
  throw new Error("Expected a zlib-compressed legacy SWF");
}
const decompressed = inflateSync(swf.subarray(8)).toString("utf8");
const runs = [];
let run = [];
for (const line of decompressed.split(/\r?\n/u)) {
  if (legacyPathByBasename.has(line.split(",")[0])) {
    run.push(line);
  } else if (run.length > 0) {
    runs.push(run);
    run = [];
  }
}
const japaneseRun = runs.find(
  (candidate) =>
    candidate.length === 245 && candidate[0]?.startsWith("suteru,捨てる,")
);
const englishRun = runs.find(
  (candidate) =>
    candidate.length === 245 && candidate[0]?.startsWith("suteru,Discard,")
);
if (!japaneseRun || !englishRun) {
  throw new Error("The embedded legacy card catalogs were not found");
}
const legacyCards = japaneseRun.map((line, index) => ({
  file: line.split(",")[0],
  japaneseName: line.split(",")[1],
  englishName: englishRun[index].split(",")[1]
}));

const currentSource = await readFile(
  "packages/shared/src/card-text.ja.generated.ts",
  "utf8"
);
const currentCards = [
  ...currentSource.matchAll(/"card\.([^"]+)": \{\s*"name": "([^"]+)"/gu)
].map((match) => ({ id: match[1], name: match[2] }));
const standardCards = currentCards.filter(
  ({ id }) =>
    id !== "sacrifice" &&
    !id.startsWith("demon-") &&
    !id.startsWith("guardian-action-") &&
    !id.startsWith("phenomenon-")
);
const guardianActions = currentCards.filter(({ id }) =>
  id.startsWith("guardian-action-")
);
const phenomena = currentCards.filter(({ id }) => id.startsWith("phenomenon-"));
if (
  guardianActions.length !== assistantActionFiles.length ||
  phenomena.length !== phenomenonFiles.length
) {
  throw new Error("The guardian action or phenomenon catalog size changed");
}

const legacyByJapaneseName = new Map(
  legacyCards.map((legacy) => [legacy.japaneseName, legacy])
);
const legacyByEnglishName = new Map(
  legacyCards.map((legacy) => [comparable(legacy.englishName), legacy])
);
const assignments = standardCards.flatMap((current) => {
  const legacy =
    legacyByJapaneseName.get(current.name) ??
    legacyByEnglishName.get(comparable(current.id));
  const legacyFile = renamedLegacyFiles[current.id] ?? legacy?.file;
  if (!legacyFile) {
    if (process.argv.includes("--verbose")) {
      console.log(`No archived image: ${current.id}\t${current.name}`);
    }
    return [];
  }
  return [{ id: current.id, legacyFile }];
});
assignments.push(
  ...guardianActions.map(({ id }, index) => ({
    id,
    legacyFile: assistantActionFiles[index]
  })),
  ...phenomena.map(({ id }, index) => ({
    id,
    legacyFile: phenomenonFiles[index]
  }))
);

await rm(outputAssetRoot, { recursive: true, force: true });
await mkdir(outputAssetRoot, { recursive: true });
for (const { id, legacyFile } of assignments) {
  const source = legacyPathByBasename.get(legacyFile);
  if (!source) throw new Error(`Missing legacy card image: ${legacyFile}`);
  await copyFile(source, path.join(outputAssetRoot, `${id}.png`));
}

const generatedSource = `// Generated by scripts/generate-card-assets.mjs.
// The files are normalized to card definition IDs under public/images/cards.
export const CARD_IMAGE_IDS: ReadonlySet<string> = new Set(${JSON.stringify(
  assignments.map(({ id }) => id),
  null,
  2
)} as const);
`;
await writeFile(outputCatalogPath, generatedSource);
console.log(`Generated ${assignments.length} card image assignments.`);
