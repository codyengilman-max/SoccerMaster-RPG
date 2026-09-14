import type { SquadPlayer } from "./engine";
import { Rng } from "./rng";
import { ROLE_BY_NUMBER, ROLE_NUMBERS, type Attributes, type RoleNumber } from "./types";

const ATTR_KEYS: (keyof Attributes)[] = [
  "pace",
  "acceleration",
  "passing",
  "firstTouch",
  "dribbling",
  "shooting",
  "tackling",
  "positioning",
  "awareness",
  "stamina",
  "strength",
  "goalkeeping",
];

/** Role emphasis: which attributes get a boost for the role. */
const ROLE_BOOST: Record<RoleNumber, Partial<Record<keyof Attributes, number>>> = {
  1: { goalkeeping: 30, positioning: 8, shooting: -15, dribbling: -10 },
  2: { pace: 6, tackling: 8, positioning: 6, stamina: 6 },
  3: { pace: 6, tackling: 8, positioning: 6, stamina: 6 },
  4: { tackling: 10, positioning: 10, strength: 8, pace: -3 },
  6: { passing: 8, awareness: 8, tackling: 6, positioning: 6 },
  8: { passing: 10, awareness: 8, firstTouch: 6, stamina: 6 },
  7: { pace: 10, dribbling: 10, acceleration: 8 },
  9: { shooting: 12, firstTouch: 6, strength: 6, positioning: 4 },
  11: { pace: 10, dribbling: 10, acceleration: 8 },
};

/**
 * Generate a 9-player squad. `quality` (0..100) is the team's mean attribute level.
 * Deterministic for a given seed.
 */
export function generateSquad(seed: number, idPrefix: string, quality: number, names?: Partial<Record<RoleNumber, string>>): SquadPlayer[] {
  const rng = new Rng(seed);
  return ROLE_NUMBERS.map((role) => {
    const attrs = {} as Attributes;
    const boost = ROLE_BOOST[role];
    for (const k of ATTR_KEYS) {
      const base = quality + rng.gaussian() * 8 + (boost[k] ?? 0) - (k === "goalkeeping" && role !== 1 ? 25 : 0);
      attrs[k] = Math.round(Math.min(100, Math.max(5, base)));
    }
    return {
      id: `${idPrefix}-${role}`,
      name: names?.[role] ?? `${idPrefix.toUpperCase()} ${ROLE_BY_NUMBER[role]} #${role}`,
      role,
      attributes: attrs,
    };
  });
}
