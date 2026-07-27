export type CardCategory =
  | "TRADE"
  | "WEAPON"
  | "ARMOR"
  | "GOODS"
  | "MIRACLE"
  | "DEMON"
  | "GUARDIAN_ACTION"
  | "PHENOMENON";

export type Element =
  | "PHYSICAL"
  | "FIRE"
  | "WATER"
  | "WOOD"
  | "EARTH"
  | "LIGHT"
  | "DARK";

export type Calamity =
  | "COLD"
  | "FEVER"
  | "HELL_SICKNESS"
  | "HEAVEN_SICKNESS"
  | "FOG"
  | "FLASH"
  | "DREAM"
  | "DARK_CLOUD";

export type EffectInstruction =
  | {
      kind: "ATTACK";
      amount: number | "CURRENT_MP_X2" | "DAMAGE" | "DAMAGE_X2";
      additive: boolean;
    }
  | { kind: "DEFENSE"; amount: number }
  | { kind: "HIT_RATE"; percent: number }
  | { kind: "BOOST_HP" | "BOOST_MP" | "BOOST_MONEY"; amount: number }
  | { kind: "TAKE_MONEY"; amount: number | "DAMAGE" }
  | { kind: "COUNTER_BOOST_MP"; multiplier: 2 }
  | { kind: "DEAL_DAMAGE"; amount: number }
  | { kind: "ADD_CALAMITY"; calamity: Calamity; timing: "IMMEDIATE" | "ON_DAMAGE" | "SELF" | "COUNTER" }
  | { kind: "REMOVE_CALAMITIES"; scope: "MILD" | "ALL" }
  | { kind: "SET_ELEMENT"; element: Element }
  | { kind: "SPECIAL"; operation: SpecialEffectOperation };

export type SpecialEffectOperation =
  | "DISCARD"
  | "SACRIFICE"
  | "EXCHANGE"
  | "SELL"
  | "BUY"
  | "ADD_ITEM"
  | "DOUBLE_ATTACK"
  | "ATTACK_TWICE"
  | "ATTACK_EVERY_ENEMY"
  | "ATTACK_SOMEBODY"
  | "ATTRACT_DANGER"
  | "ATTACK_DYINGLY"
  | "FILTER_ATTACK_ELEMENT"
  | "BOUNCE_WEAPON"
  | "REFLECT_WEAPON"
  | "BLOCK_WEAPON"
  | "BOUNCE_MIRACLE"
  | "REFLECT_MIRACLE"
  | "BLOCK_MIRACLE"
  | "REFLECT_ANYTHING"
  | "REVIVE"
  | "SET_HP_OF_EVERYBODY"
  | "ABSORB_HP"
  | "DEAL_SAME_DAMAGE"
  | "CONSUME_ALL_MP"
  | "CUT_COST"
  | "BOOST_SOMETHING"
  | "SET_GUARDIAN"
  | "SET_GUARDIAN_OF_EVERYBODY"
  | "CONFUSE_EVERYBODY"
  | "REMOVE_ITEMS"
  | "REMOVE_USED_MIRACLES"
  | "REMOVE_SOMETHING"
  | "SHUFFLE_ITEMS_OF_EVERYBODY"
  | "CALL_PHENOMENON"
  | "COLLECT_MONEY_OF_EVERYBODY"
  | "CATEGORY_WEAPON"
  | "REDRAW_HAND"
  | "UNKNOWN_OFFICIAL_EFFECT";

export type CardDefinition = {
  cardDefinitionId: string;
  category: CardCategory;
  element: Element;
  nameTextKey: string;
  effectTextKey: string;
  price?: number;
  mpCost?: number;
  grantWeight?: number;
  absoluteRatePercent?: number;
  guardianName?: string;
  actionName?: string;
  actionWeight?: number;
  instructions: EffectInstruction[];
};

export type CardTextCatalog = Record<
  string,
  {
    name: string;
    effect: string;
  }
>;
