import { answer, frame, ready, type MatchRuntime } from "../src/match/runtime";
import type { TacticalOption } from "../src/tactics/moments";
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

/**
 * Drive an answer-only runtime to full time the way the screen would: `ready()` once a question is
 * open, then one answer per moment chosen by `pick` (default: the first displayed option).
 * Returns the number of moments answered.
 */
export function playToFullTime(rt: MatchRuntime, pick: (options: readonly TacticalOption[]) => TacticalOption = (o) => o[0]!, frameMs = 1000): number {
  let answered = 0;
  for (let i = 0; i < 2_000_000; i++) {
    const r = frame(rt, frameMs);
    if (rt.phase === "question") {
      ready(rt);
      if (answer(rt, pick(rt.active!.moment.options).id)) answered++;
    }
    if (r.finished) return answered;
  }
  throw new Error("match did not finish");
}
