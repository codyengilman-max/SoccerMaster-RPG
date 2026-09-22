import { withinAcceptable, withinPreferred } from "../match/pace";
import { answer, createRuntime, frame, ready, totalRealMs, type MatchRuntime, type RuntimePhase } from "../match/runtime";
import { isFinished } from "../sim/engine";
import { Rng } from "../sim/rng";
import { U11_9V9 } from "../sim/rules";
import { generateSquad } from "../sim/squad";
import { ROLE_BY_NUMBER, type RoleId, type RoleNumber } from "../sim/types";
import type { Catalog } from "../tactics/catalog";
import { coverageReport } from "../tactics/coverage";
import type { Involvement } from "../tactics/moments";
import { pacingFor } from "../tactics/recognition";

/**
 * Headless real-time pace harness (docs/PERFORMANCE.md "match duration"). Drives the real match
 * runtime at a fixed frame cadence with a scripted player and measures how much *real* time a
 * complete match costs, split by runtime phase. The clock only ever sees each frame's real dt, so
 * the numbers are what a phone reports on its full-time screen — independent of CPU speed. Shared by
 * `tools/paceBench.ts` and the pace tests so both judge the same thing.
 */

/** How quickly the scripted player answers once the timer is running; `timeout` never answers. */
export type PlayerModel = "quick" | "typical" | "slow" | "timeout";
export const ANSWER_MS: Record<PlayerModel, number> = { quick: 3000, typical: 8000, slow: 13_000, timeout: Number.POSITIVE_INFINITY };
/** Which answer the scripted player picks. */
export type AnswerPolicy = "random" | "best" | "worst";

export interface PaceRun {
  seed: number;
  role: RoleId;
  player: PlayerModel;
  fps: number;
  realMs: number;
  byPhase: Record<RuntimePhase, number>;
  moments: number;
  onBall: number;
  byInvolvement: Record<Involvement, number>;
  /** Spells in which the controlled player had the ball under control (sampled per frame). */
  possessions: number;
  simMinutes: number;
  score: string;
  /** Goals counted from the event timeline (must equal the scoreboard). */
  goalEvents: number;
  /** Mean fatigue of the outfield players at full time (0 = fresh). */
  fatigueMean: number;
  withinPreferred: boolean;
  withinAcceptable: boolean;
  /** Largest number of ticks any single frame ran. */
  maxTicksPerFrame: number;
  /** Displayed answers per moment: min and max. */
  options: [number, number];
  timeouts: number;
}

function roleNumberOf(role: RoleId): RoleNumber {
  const n = (Object.keys(ROLE_BY_NUMBER).map(Number) as RoleNumber[]).find((k) => ROLE_BY_NUMBER[k] === role);
  if (!n) throw new Error(`unknown role ${role}`);
  return n;
}

export function paceRuntime(catalog: Catalog, seed: number, role: RoleId): { runtime: MatchRuntime; me: string } {
  const roleNumber = roleNumberOf(role);
  const home = generateSquad(seed * 7 + 1, "H", 55);
  const away = generateSquad(seed * 7 + 2, "A", 55);
  const me = home.find((p) => p.role === roleNumber);
  if (!me) throw new Error("role missing from squad");
  const runtime = createRuntime(
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
  return { runtime, me: me.id };
}

export function runPace(catalog: Catalog, seed: number, role: RoleId, player: PlayerModel, fps = 60, policy: AnswerPolicy = "random"): PaceRun {
  const { runtime, me } = paceRuntime(catalog, seed, role);
  const frameMs = 1000 / fps;
  const user = new Rng(seed ^ 0x51ed270b);
  let answerIn = -1;
  let maxTicks = 0;
  let goalEvents = 0;
  let possessions = 0;
  let hadBall = false;
  let minOptions = Number.POSITIVE_INFINITY;
  let maxOptions = 0;
  for (let f = 0; f < 4_000_000 && !isFinished(runtime.state); f++) {
    const res = frame(runtime, frameMs);
    maxTicks = Math.max(maxTicks, res.ticks);
    for (const e of res.events) if (e.type === "goal") goalEvents++;
    const hasBall = runtime.state.ball.status === "controlled" && runtime.state.ball.owner === me;
    if (hasBall && !hadBall) possessions++;
    hadBall = hasBall;
    if (res.opened) {
      minOptions = Math.min(minOptions, res.opened.options.length);
      maxOptions = Math.max(maxOptions, res.opened.options.length);
    }
    // the screen would call ready() once the question, answers and read-aloud are up: next frame
    if (runtime.phase === "question") {
      ready(runtime);
      answerIn = Number.isFinite(ANSWER_MS[player]) ? Math.max(1, Math.round(ANSWER_MS[player] / frameMs)) : -1;
    } else if (runtime.phase === "timer" && answerIn > 0 && --answerIn === 0) {
      const opts = runtime.active!.moment.options;
      const sorted = [...opts].sort((a, b) => b.score - a.score);
      const pick = policy === "best" ? sorted[0]! : policy === "worst" ? sorted[sorted.length - 1]! : opts[Math.floor(user.next() * opts.length)]!;
      answer(runtime, pick.id);
    }
  }
  const rep = coverageReport(runtime.session.records, runtime.session.pacing);
  const st = runtime.state;
  const outfield = st.players.filter((p) => p.role !== 1);
  const byInvolvement: Record<Involvement, number> = { first_touch: 0, on_ball: 0, off_ball: 0 };
  for (const r of runtime.session.records) byInvolvement[r.moment.involvement]++;
  const realMs = totalRealMs(runtime);
  return {
    seed,
    role,
    player,
    fps,
    realMs,
    byPhase: { ...runtime.realMs },
    moments: rep.total,
    onBall: rep.onBall,
    byInvolvement,
    possessions,
    simMinutes: st.clock.timeMs / 60_000,
    score: `${st.score.home}–${st.score.away}`,
    goalEvents,
    fatigueMean: outfield.reduce((a, p) => a + p.fatigue, 0) / Math.max(1, outfield.length),
    withinPreferred: withinPreferred(realMs),
    withinAcceptable: withinAcceptable(realMs),
    maxTicksPerFrame: maxTicks,
    options: [Number.isFinite(minOptions) ? minOptions : 0, maxOptions],
    timeouts: rep.decisions.timeout,
  };
}
