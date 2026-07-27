import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specPath = path.join(root, "docs", "GAME_RULE_SPEC.md");
const outputPath = path.join(root, "packages", "shared", "src", "card-catalog.generated.ts");
const textOutputPath = path.join(root, "packages", "shared", "src", "card-text.ja.generated.ts");
const checkOnly = process.argv.includes("--check");

const CATEGORY_SECTIONS = [
  ["TRADE", "#### 8.6.1 取引", 5],
  ["WEAPON", "#### 8.6.2 武器", 107],
  ["ARMOR", "#### 8.6.3 防具", 78],
  ["GOODS", "#### 8.6.4 雑貨", 19],
  ["MIRACLE", "#### 8.6.5 奇跡", 30],
  ["DEMON", "#### 8.6.6 悪魔", 5],
  ["GUARDIAN_ACTION", "#### 8.6.7 守護神行動", 42],
  ["PHENOMENON", "#### 8.6.8 超常現象", 10]
];

const ELEMENTS = new Map([
  ["無属性", "PHYSICAL"],
  ["火属性", "FIRE"],
  ["水属性", "WATER"],
  ["木属性", "WOOD"],
  ["土属性", "EARTH"],
  ["光属性", "LIGHT"],
  ["闇属性", "DARK"]
]);

const CALAMITIES = new Map([
  ["風邪", "COLD"],
  ["熱病", "FEVER"],
  ["地獄病", "HELL_SICKNESS"],
  ["天国病", "HEAVEN_SICKNESS"],
  ["霧", "FOG"],
  ["閃光", "FLASH"],
  ["夢", "DREAM"],
  ["暗雲", "DARK_CLOUD"]
]);

function section(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`Missing section: ${heading}`);
  const bodyStart = markdown.indexOf("\n", start) + 1;
  const next = markdown.indexOf("\n#### ", bodyStart);
  const major = markdown.indexOf("\n## ", bodyStart);
  const candidates = [next, major].filter((value) => value >= 0);
  const end = candidates.length === 0 ? markdown.length : Math.min(...candidates);
  return markdown.slice(bodyStart, end);
}

function tableRows(markdownSection) {
  return markdownSection
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/u.test(cell)))
    .slice(1);
}

function parseNumber(value) {
  if (!value || value === "—") return undefined;
  const parsed = Number.parseInt(value.replace(/[^\d-]/gu, ""), 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function slug(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[＜＞「」『』()（）]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function standardIds(markdown) {
  const rows = tableRows(section(markdown, "#### 8.6.10 標準カードID"));
  return new Map(
    rows.map(([rawId, displayName]) => [
      displayName,
      rawId?.replaceAll("`", "")
    ])
  );
}

function special(operation) {
  return { kind: "SPECIAL", operation };
}

function parseInstructions(effect) {
  const compact = effect.replaceAll(" / ", " ");
  const instructions = [];

  for (const match of compact.matchAll(/(\+)?攻(\d+)/gu)) {
    instructions.push({
      kind: "ATTACK",
      amount: Number(match[2]),
      additive: match[1] === "+"
    });
  }
  if (/攻撃力=現在MP×2/u.test(compact)) {
    instructions.push({ kind: "ATTACK", amount: "CURRENT_MP_X2", additive: false });
  }
  if (/攻\{ダメージ×2\}/u.test(compact)) {
    instructions.push({ kind: "ATTACK", amount: "DAMAGE_X2", additive: false });
  } else if (/攻\{ダメージ\}/u.test(compact)) {
    instructions.push({ kind: "ATTACK", amount: "DAMAGE", additive: false });
  }
  for (const match of compact.matchAll(/守(\d+)/gu)) {
    instructions.push({ kind: "DEFENSE", amount: Number(match[1]) });
  }
  const hitRate = compact.match(/命中(\d+)%/u);
  if (hitRate) instructions.push({ kind: "HIT_RATE", percent: Number(hitRate[1]) });

  const boosts = [
    ["BOOST_HP", /\+HP(\d+)/gu],
    ["BOOST_MP", /\+MP(\d+)/gu],
    ["BOOST_MONEY", /\+¥(\d+)/gu]
  ];
  for (const [kind, expression] of boosts) {
    for (const match of compact.matchAll(expression)) {
      instructions.push({ kind, amount: Number(match[1]) });
    }
  }
  if (compact.includes("+MP{ダメージ×2}")) {
    instructions.push({ kind: "COUNTER_BOOST_MP", multiplier: 2 });
  }
  const takeMoney = compact.match(/¥(\d+) 没収/u);
  if (takeMoney) instructions.push({ kind: "TAKE_MONEY", amount: Number(takeMoney[1]) });
  if (compact.includes("¥{ダメージ} 没収")) {
    instructions.push({ kind: "TAKE_MONEY", amount: "DAMAGE" });
  }
  for (const match of compact.matchAll(/(?:^|\s)(\d+)ダメージ/gu)) {
    instructions.push({ kind: "DEAL_DAMAGE", amount: Number(match[1]) });
  }

  for (const [label, calamity] of CALAMITIES) {
    let timing;
    if (compact.includes(`ダメージで${label}`)) timing = "ON_DAMAGE";
    else if (compact.includes(`使用者に${label}`)) timing = "SELF";
    else if (compact.includes(`反撃で${label}`)) timing = "COUNTER";
    else if (
      compact === `${label}を付与` ||
      compact.includes(`みんなに${label}`) ||
      compact.includes(`${label}を付与`)
    ) timing = "IMMEDIATE";
    if (timing) instructions.push({ kind: "ADD_CALAMITY", calamity, timing });
  }

  if (compact.includes("すべての 災いを払う")) {
    instructions.push({ kind: "REMOVE_CALAMITIES", scope: "ALL" });
  } else if (compact.includes("の災いを払う")) {
    instructions.push({ kind: "REMOVE_CALAMITIES", scope: "MILD" });
  }

  const setElement = [...ELEMENTS.entries()].find(([label]) =>
    compact.includes(`${label}に染める`)
  );
  if (setElement) instructions.push({ kind: "SET_ELEMENT", element: setElement[1] });

  const specials = [
    ["神 器を捨てる", "DISCARD"],
    ["神器を捨てる", "DISCARD"],
    ["神器をささげる", "SACRIFICE"],
    ["両替する", "EXCHANGE"],
    ["神器を一個売る", "SELL"],
    ["神器を一個買う", "BUY"],
    ["神器を一個もらす", "ADD_ITEM"],
    ["攻撃力を倍にする", "DOUBLE_ATTACK"],
    ["二回攻撃する", "ATTACK_TWICE"],
    ["すべての敵に 攻撃する", "ATTACK_EVERY_ENEMY"],
    ["誰かに攻撃する", "ATTACK_SOMEBODY"],
    ["あぶないキネから 99ダメージ", "ATTRACT_DANGER"],
    ["昇天のとき75%攻30", "ATTACK_DYINGLY"],
    ["攻撃の属性を こし取る", "FILTER_ATTACK_ELEMENT"],
    ["無属性武器を弾く", "BOUNCE_WEAPON"],
    ["無属性武器をはね返す", "REFLECT_WEAPON"],
    ["無属性武器を止める", "BLOCK_WEAPON"],
    ["奇跡を弾く", "BOUNCE_MIRACLE"],
    ["奇跡をはね返す", "REFLECT_MIRACLE"],
    ["奇跡を止める", "BLOCK_MIRACLE"],
    ["何でもはね返す", "REFLECT_ANYTHING"],
    ["HP0になると", "REVIVE"],
    ["みんなのHPが", "SET_HP_OF_EVERYBODY"],
    ["HPを吸収する", "ABSORB_HP"],
    ["使用者に同じダメージ", "DEAL_SAME_DAMAGE"],
    ["MPをすべて消費する", "CONSUME_ALL_MP"],
    ["消費なしで奇跡を起こす", "CUT_COST"],
    ["+HP10 +MP10 または +¥10", "BOOST_SOMETHING"],
    ["守護神が宿る", "SET_GUARDIAN"],
    ["みんなに守護神が宿る", "SET_GUARDIAN_OF_EVERYBODY"],
    ["みんなが三回ずつ 勝手に行動する", "CONFUSE_EVERYBODY"],
    ["神器を 三個掃き飛ばす", "REMOVE_ITEMS"],
    ["起こした奇跡を 二個洗い流す", "REMOVE_USED_MIRACLES"],
    ["神器か起こした奇跡を 二個盗む", "REMOVE_SOMETHING"],
    ["みんなの神器が 無作為に入れ替わる", "SHUFFLE_ITEMS_OF_EVERYBODY"],
    ["超常現象が起こる", "CALL_PHENOMENON"],
    ["みんなの金が 誰かに集まる", "COLLECT_MONEY_OF_EVERYBODY"],
    ["武器扱い", "CATEGORY_WEAPON"],
    ["神器一新", "REDRAW_HAND"]
  ];
  for (const [phrase, operation] of specials) {
    if (compact.includes(phrase)) instructions.push(special(operation));
  }

  if (instructions.length === 0) {
    instructions.push(special("UNKNOWN_OFFICIAL_EFFECT"));
  }
  return instructions;
}

function createDefinition(category, row, index, idByName) {
  let name;
  let effect;
  let attribute = "無属性";
  let price;
  let mpCost;
  let grantWeight;
  let absoluteRatePercent;
  let guardianName;
  let actionName;
  let actionWeight;

  if (category === "TRADE") {
    [name, effect] = row;
    price = parseNumber(row[2]);
    grantWeight = parseNumber(row[3]);
  } else if (["WEAPON", "ARMOR", "GOODS"].includes(category)) {
    [name, attribute, effect] = row;
    price = parseNumber(row[3]);
    grantWeight = parseNumber(row[4]);
  } else if (category === "MIRACLE") {
    [name, attribute, effect] = row;
    mpCost = parseNumber(row[3]);
    grantWeight = parseNumber(row[4]);
  } else if (category === "DEMON") {
    [name, effect] = row;
    absoluteRatePercent = parseNumber(row[2]);
  } else if (category === "GUARDIAN_ACTION") {
    [guardianName, actionName, attribute, effect] = row;
    name = `${guardianName}:${actionName}`;
    actionWeight = parseNumber(row[4]);
  } else {
    [name, guardianName, attribute, effect] = row;
  }

  if (!name || !effect) throw new Error(`Invalid ${category} row ${index + 1}`);
  const officialId = idByName.get(name);
  const fallbackId = `${category.toLowerCase().replaceAll("_", "-")}-${String(index + 1).padStart(3, "0")}-${slug(name)}`;
  const cardDefinitionId = officialId ?? (
    name === "捨てる" ? "discard" : name === "ささげる" ? "sacrifice" : fallbackId
  );
  const textKey = `card.${cardDefinitionId}`;
  const definition = {
    cardDefinitionId,
    category,
    element: ELEMENTS.get(attribute) ?? "PHYSICAL",
    nameTextKey: `${textKey}.name`,
    effectTextKey: `${textKey}.effect`,
    instructions: parseInstructions(effect)
  };
  for (const [key, value] of Object.entries({
    price,
    mpCost,
    grantWeight,
    absoluteRatePercent,
    guardianName,
    actionName,
    actionWeight
  })) {
    if (value !== undefined) definition[key] = value;
  }
  return { definition, text: { name, effect } };
}

const markdown = await readFile(specPath, "utf8");
const idByName = standardIds(markdown);
const definitions = [];
const texts = {};

for (const [category, heading, expectedCount] of CATEGORY_SECTIONS) {
  const rows = tableRows(section(markdown, heading));
  if (rows.length !== expectedCount) {
    throw new Error(`${category}: expected ${expectedCount} rows, found ${rows.length}`);
  }
  for (const [index, row] of rows.entries()) {
    const { definition, text } = createDefinition(category, row, index, idByName);
    definitions.push(definition);
    texts[`card.${definition.cardDefinitionId}`] = text;
  }
}

const uniqueIds = new Set(definitions.map((card) => card.cardDefinitionId));
if (uniqueIds.size !== definitions.length) throw new Error("Duplicate cardDefinitionId");
if (definitions.length !== 296) throw new Error(`Expected 296 definitions, found ${definitions.length}`);
const grantable = definitions.filter((card) => card.grantWeight !== undefined);
const totalWeight = grantable.reduce((sum, card) => sum + card.grantWeight, 0);
if (grantable.length !== 237 || totalWeight !== 500) {
  throw new Error(`Invalid grant pool: ${grantable.length} cards, weight ${totalWeight}`);
}

const output = `// Generated from docs/GAME_RULE_SPEC.md by scripts/generate-card-catalog.mjs.
// Do not edit this file by hand.
import type { CardDefinition } from "./card-types.ts";

export const STANDARD_CARD_DEFINITIONS = ${JSON.stringify(definitions, null, 2)} as const satisfies readonly CardDefinition[];
`;

const textOutput = `// Generated from docs/GAME_RULE_SPEC.md by scripts/generate-card-catalog.mjs.
// Display text is intentionally separate from executable card definitions.
import type { CardTextCatalog } from "./card-types.ts";

export const JA_CARD_TEXT = ${JSON.stringify(texts, null, 2)} as const satisfies CardTextCatalog;
`;

if (checkOnly) {
  const [current, currentText] = await Promise.all([
    readFile(outputPath, "utf8").catch(() => ""),
    readFile(textOutputPath, "utf8").catch(() => "")
  ]);
  if (current !== output || currentText !== textOutput) {
    throw new Error("Generated card catalog is stale. Run npm run generate:cards.");
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await Promise.all([
    writeFile(outputPath, output, "utf8"),
    writeFile(textOutputPath, textOutput, "utf8")
  ]);
  process.stdout.write(`Generated ${definitions.length} definitions (${grantable.length} grantable, weight ${totalWeight}).\n`);
}
