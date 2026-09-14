import { createMatch, type MatchConfig } from "../src/sim/engine";
import { U11_9V9, type Rules } from "../src/sim/rules";
import { generateSquad } from "../src/sim/squad";
import type { MatchState } from "../src/sim/types";

export function testConfig(seed = 7, rules: Rules = U11_9V9, overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    matchId: `test-${seed}`,
    seed,
    rules,
    home: { side: "home", name: "Home FC", shortName: "HOM", squad: generateSquad(seed * 10 + 1, "h", 55) },
    away: { side: "away", name: "Away SC", shortName: "AWY", squad: generateSquad(seed * 10 + 2, "a", 55) },
    ...overrides,
  };
}

export function freshMatch(seed = 7, rules: Rules = U11_9V9): MatchState {
  return createMatch(testConfig(seed, rules));
}

export const player = (s: MatchState, id: string) => {
  const p = s.players.find((q) => q.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p;
};
