/* Run one AI-vs-AI match and print a statistics summary. Usage: npx tsx tools/headless.ts [seed] */
import { runHeadless, type MatchConfig } from "../src/sim/engine";
import { U11_9V9 } from "../src/sim/rules";
import { generateSquad } from "../src/sim/squad";
import type { MatchEventType } from "../src/sim/types";


const seed = Number(process.argv[2] ?? 42);
const cfg: MatchConfig = {
  matchId: `headless-${seed}`,
  seed,
  rules: U11_9V9,
  home: { side: "home", name: "FC Batavia", shortName: "BAT", squad: generateSquad(seed + 1, "bat", 55) },
  away: { side: "away", name: "Test Opponents", shortName: "OPP", squad: generateSquad(seed + 2, "opp", 55) },
};

let maxStep = 0;
let prev: Record<string, { x: number; y: number }> | null = null;
const t0 = performance.now();
const state = runHeadless(cfg, (s) => {
  if (s.phase.kind !== "open_play") {
    prev = null;
    return;
  }
  const cur: Record<string, { x: number; y: number }> = {};
  for (const p of s.players) {
    cur[p.id] = { ...p.pos };
    const q = prev?.[p.id];
    if (q) maxStep = Math.max(maxStep, Math.hypot(p.pos.x - q.x, p.pos.y - q.y));
  }
  prev = cur;
});
const ms = performance.now() - t0;

const counts: Partial<Record<MatchEventType, number>> = {};
for (const e of state.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
const passes = state.events.filter((e) => e.type === "pass").length;
const receives = state.events.filter((e) => e.type === "receive" && e.from !== null).length;
const intercepts = state.events.filter((e) => e.type === "interception").length;

console.log(`seed ${seed}: ${state.home.shortName} ${state.score.home} - ${state.score.away} ${state.away.shortName}`);
console.log(`ticks ${state.clock.tick}, sim minutes ${(state.clock.timeMs / 60000).toFixed(1)}, wall ${ms.toFixed(0)} ms`);
console.log(`pass completion ${passes ? ((receives / passes) * 100).toFixed(0) : "-"}% (${receives}/${passes}), interceptions ${intercepts}`);
console.log(`max per-tick displacement ${maxStep.toFixed(3)} m`);
console.log(counts);
