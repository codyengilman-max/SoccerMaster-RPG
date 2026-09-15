import { totalRealMs, withinBand, type PacePhase } from "../match/pace";
import { createRuntime, frame, releaseGesture, select, type MatchRuntime } from "../match/runtime";
import { isFinished } from "../sim/engine";
import { Rng } from "../sim/rng";
import { U11_9V9 } from "../sim/rules";
import { generateSquad } from "../sim/squad";
import { ROLE_BY_NUMBER, type RoleId, type RoleNumber } from "../sim/types";
import type { Catalog } from "../tactics/catalog";
import { coverageReport } from "../tactics/coverage";
import { pacingFor } from "../tactics/recognition";

/**
 * Headless real-time pace harness (docs/PERFORMANCE.md "match duration"). Drives the real match
 * runtime at a fixed frame cadence with a scripted player and measures how much *real* time a
 * complete match costs, split by pace phase. The clock only ever sees each frame's real dt, so the
 * numbers are what a phone reports on its full-time screen — independent of CPU speed. Shared by
 * `tools/paceBench.ts` and the pace tests so both judge the same thing.
 */

/** How quickly the scripted player commits inside a window. */
export type PlayerModel = "quick" | "typical" | "slow";
export const ANSWER_MS: Record<PlayerModel, number> = { quick: 1500, typical: 4000, slow: Number.POSITIVE_INFINITY };

export interface PaceRun {
  seed: number;
  role: RoleId;
  player: PlayerModel;
  fps: number;
  realMs: number;
  byPhase: Record<PacePhase, number>;
  moments: number;
  onBall: number;
  simMinutes: number;
  score: string;
  /** Goals counted from the event timeline (must equal the scoreboard). */
  goalEvents: number;
  /** Mean fatigue of the outfield players at full time (0 = fresh). */
  fatigueMean: number;
  withinBand: boolean;
  /** Highest routine scale the director used. */
  peakScale: number;
  /** Largest number of ticks any single frame ran. */
  maxTicksPerFrame: number;
}

function roleNumberOf(role: RoleId): RoleNumber {
  const n = (Object.keys(ROLE_BY_NUMBER).map(Number) as RoleNumber[]).find((k) => ROLE_BY_NUMBER[k] === role);
  if (!n) throw new Error(`unknown role ${role}`);
  return n;
}

export function runPace(catalog: Catalog, seed: number, role: RoleId, player: PlayerModel, fps = 60): PaceRun {
  const roleNumber = roleNumberOf(role);
  const home = generateSquad(seed * 7 + 1, "H", 55);
  const away = generateSquad(seed * 7 + 2, "A", 55);
  const me = home.find((p) => p.role === roleNumber);
  if (!me) throw new Error("role missing from squad");
  const runtime: MatchRuntime = createRuntime(
    {
      matchId: `pace-${seed}`,
      seed,
      rules: U11_9V9,
      home: { side: "home", name: "Home", shortName: "HOM", squad: home },
      away: { side: "away", name: "Away", shortName: "AWY", squad: away },
      controlled: { side: "home", playerId: me.id },
    },
    catalog,
    { pacing: pacingFor(role) },
  );
  const frameMs = 1000 / fps;
  const user = new Rng(seed ^ 0x51ed270b);
  let answerIn = -1;
  let peakScale = 0;
  let maxTicks = 0;
  let goalEvents = 0;
  for (let f = 0; f < 2_000_000 && !isFinished(runtime.state); f++) {
    const res = frame(runtime, frameMs);
    maxTicks = Math.max(maxTicks, res.ticks);
    for (const e of res.events) if (e.type === "goal") goalEvents++;
    if (!runtime.active) peakScale = Math.max(peakScale, runtime.clock.scale);
    if (res.opened) answerIn = Number.isFinite(ANSWER_MS[player]) ? Math.round(ANSWER_MS[player] / frameMs) : -1;
    if (runtime.active && answerIn > 0 && --answerIn === 0) {
      const opts = runtime.active.moment.options;
      const pick = opts[Math.floor(user.next() * opts.length)]!;
      const me2 = runtime.state.players.find((p) => p.id === runtime.active!.moment.playerId)!;
      if (pick.drawn) {
        select(runtime, pick.id);
        const to = pick.anchor ?? me2.pos;
        releaseGesture(runtime, [me2.pos, { x: (me2.pos.x + to.x) / 2, y: (me2.pos.y + to.y) / 2 }, to]);
      } else select(runtime, pick.id);
    }
  }
  const rep = coverageReport(runtime.session.records, runtime.session.pacing);
  const st = runtime.state;
  const outfield = st.players.filter((p) => p.role !== 1);
  return {
    seed,
    role,
    player,
    fps,
    realMs: totalRealMs(runtime.pace),
    byPhase: { ...runtime.pace.realMs },
    moments: rep.total,
    onBall: rep.onBall,
    simMinutes: st.clock.timeMs / 60_000,
    score: `${st.score.home}–${st.score.away}`,
    goalEvents,
    fatigueMean: outfield.reduce((a, p) => a + p.fatigue, 0) / Math.max(1, outfield.length),
    withinBand: withinBand(runtime.pace),
    peakScale,
    maxTicksPerFrame: maxTicks,
  };
}
