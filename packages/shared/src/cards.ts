import type {
  CardDefinition,
  CardTextCatalog,
  EffectInstruction
} from "./card-types.ts";
import {
  STANDARD_CARD_DEFINITIONS
} from "./card-catalog.generated.ts";
import { JA_CARD_TEXT } from "./card-text.ja.generated.ts";

export { JA_CARD_TEXT, STANDARD_CARD_DEFINITIONS };

export const CARD_POOL_VERSION = "OFFICIAL_WEB_2026_07_24";

export const CARD_DEFINITIONS_BY_ID: ReadonlyMap<string, CardDefinition> = new Map(
  STANDARD_CARD_DEFINITIONS.map((definition) => [
    definition.cardDefinitionId,
    definition
  ])
);

export const NORMAL_GRANT_POOL = STANDARD_CARD_DEFINITIONS
  .filter(
    (definition): definition is typeof definition & { grantWeight: number } =>
      "grantWeight" in definition && definition.grantWeight !== undefined
  )
  .map((definition) => ({
    key: definition.cardDefinitionId,
    weight: definition.grantWeight,
    value: definition
  }));

export const DEMON_GRANT_POOL = STANDARD_CARD_DEFINITIONS
  .filter(
    (
      definition
    ): definition is typeof definition & { absoluteRatePercent: number } =>
      definition.category === "DEMON" &&
      "absoluteRatePercent" in definition &&
      definition.absoluteRatePercent !== undefined
  )
  .map((definition) => ({
    key: definition.cardDefinitionId,
    weight: definition.absoluteRatePercent,
    value: definition
  }));

export function instructionsOfKind<K extends EffectInstruction["kind"]>(
  definition: CardDefinition,
  kind: K
): Extract<EffectInstruction, { kind: K }>[] {
  return definition.instructions.filter(
    (instruction): instruction is Extract<EffectInstruction, { kind: K }> =>
      instruction.kind === kind
  );
}

export function validateStandardCatalog(): string[] {
  const errors: string[] = [];
  if (STANDARD_CARD_DEFINITIONS.length !== 296) {
    errors.push(`Expected 296 definitions, got ${STANDARD_CARD_DEFINITIONS.length}`);
  }
  if (CARD_DEFINITIONS_BY_ID.size !== STANDARD_CARD_DEFINITIONS.length) {
    errors.push("cardDefinitionId values must be unique");
  }
  if (NORMAL_GRANT_POOL.length !== 237) {
    errors.push(`Expected 237 grantable definitions, got ${NORMAL_GRANT_POOL.length}`);
  }
  const totalWeight = NORMAL_GRANT_POOL.reduce(
    (sum, candidate) => sum + candidate.weight,
    0
  );
  if (totalWeight !== 500) {
    errors.push(`Expected grant weight 500, got ${totalWeight}`);
  }
  if (DEMON_GRANT_POOL.length !== 5) {
    errors.push(`Expected 5 demon definitions, got ${DEMON_GRANT_POOL.length}`);
  }
  const totalDemonRate = DEMON_GRANT_POOL.reduce(
    (sum, candidate) => sum + candidate.weight,
    0
  );
  if (totalDemonRate !== 25) {
    errors.push(`Expected total demon rate 25, got ${totalDemonRate}`);
  }
  for (const definition of STANDARD_CARD_DEFINITIONS) {
    const textCatalog: CardTextCatalog = JA_CARD_TEXT;
    if (!textCatalog[definition.nameTextKey.replace(/\.name$/u, "")]) {
      errors.push(`Missing text for ${definition.cardDefinitionId}`);
    }
  }
  return errors;
}
