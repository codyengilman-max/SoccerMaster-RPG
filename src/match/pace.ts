import { clamp } from "../sim/geometry";
import type { MatchState } from "../sim/types";
import type { PacingConfig } from "../tactics/recognition";
import { FAST_SCALE_MAX, NORMAL_SCALE, SLOW_SCALE } from "./clock";

/**
 * Pace director: fits a whole simulated match (60 minutes of soccer) into a fixed budget of real
 * play time (spec §12 "a match should not drag"). The simulation itself never changes — score,
 * possession, fatigue and positions come from the same ticks — only how many ticks each real
 * frame is worth:
 *
 *  - `window`    a tactical moment is open → slow motion, the player reads and commits;
 *  - `aftermath` the choice has just landed → real speed so cause and effect stay visible;
 *  - `halftime`  a short beat at the break so the half change reads as one;
 *  - `routine`   everything else → accelerated, at whatever rate spends the remaining real budget
 *                over the remaining simulated time, after reserving time for the moments still to come.
 *
 * Every quantity is derived from the runtime clock and simulation state, so a headless driver at a
 * fixed frame cadence measures exactly what a phone would (tools/paceBench.ts).
 */

export interface PaceConfig {
  /** Real play time the director aims for, ms. */
  targetRealMs: number;
  /** Band a complete match must land in (reported, tested), ms. */
  bandRealMs: [number, number];
  /** Routine play is never slower than this... */
  routineMinScale: number;
  /** ...nor faster than this (readability; also bounded by the per-frame tick cap). */
  routineMaxScale: number;
  /** Real speed after a decision closes, simulated ms. */
  aftermathSimMs: number;
  /** Real hold at half time, ms. */
  halfTimeRealMs: number;
  /** Real time reserved per moment still expected (window + aftermath at typical commit speed), ms. */
  reservePerMomentMs: number;
  /** Dead-ball ticks do not advance the match clock; routine estimates carry this factor. */
  deadBallFactor: number;
}

export const DEFAULT_PACE: PaceConfig = {
  targetRealMs: 7 * 60_000,
  bandRealMs: [6 * 60_000, 8 * 60_000],
  routineMinScale: 2,
  routineMaxScale: FAST_SCALE_MAX,
  aftermathSimMs: 2500,
  halfTimeRealMs: 2500,
  reservePerMomentMs: 10_500,
  deadBallFactor: 1.06,
};

export type PacePhase = "routine" | "window" | "aftermath" | "halftime";

export interface PaceState {
  config: PaceConfig;
  phase: PacePhase;
  /** Simulated ms of aftermath still to run at real speed. */
  aftermathLeftMs: number;
  /** Real ms of half-time beat still to hold. */
  halfTimeLeftMs: number;
  /** Smoothed routine scale (jumps only when a phase changes). */
  routineScale: number;
  /** Real ms spent per phase (pauses excluded), the measurement the target is judged on. */
  realMs: Record<PacePhase, number>;
}

export function createPace(config: PaceConfig = DEFAULT_PACE): PaceState {
  return {
    config,
    phase: "routine",
    aftermathLeftMs: 0,
    halfTimeLeftMs: 0,
    routineScale: config.routineMinScale,
    realMs: { routine: 0, window: 0, aftermath: 0, halftime: 0 },
  };
}

export const totalRealMs = (p: PaceState): number => p.realMs.routine + p.realMs.window + p.realMs.aftermath + p.realMs.halftime;

export interface PaceInputs {
  state: MatchState;
  pacing: PacingConfig;
  momentsSoFar: number;
  windowOpen: boolean;
  /** Force maximum routine speed (tests, "skip" affordances). */
  forceFast: boolean;
}

/** Simulated ms of open play left in the match. */
export function simRemainingMs(state: MatchState): number {
  const total = state.rules.halves * state.rules.halfLengthSeconds * 1000;
  return Math.max(0, total - state.clock.timeMs);
}

/** Moments the pacing controller still expects, spread over the remaining match fraction. */
export function expectedRemainingMoments(state: MatchState, pacing: PacingConfig, soFar: number): number {
  const total = state.rules.halves * state.rules.halfLengthSeconds * 1000;
  const frac = total > 0 ? clamp(state.clock.timeMs / total, 0, 1) : 1;
  const mid = (pacing.total[0] + pacing.total[1]) / 2;
  const byTime = Math.round(mid * (1 - frac));
  return clamp(Math.max(byTime, mid - soFar), 0, pacing.total[1] - soFar);
}

/**
 * The routine scale that spends the remaining real budget over the remaining simulated time once
 * the still-expected moments are reserved. Behind schedule → faster; ahead → down to the minimum.
 */
export function routineScaleFor(p: PaceState, inp: PaceInputs): number {
  const c = p.config;
  if (inp.forceFast) return c.routineMaxScale;
  const remainingSim = simRemainingMs(inp.state) * c.deadBallFactor;
  const reserved = expectedRemainingMoments(inp.state, inp.pacing, inp.momentsSoFar) * c.reservePerMomentMs;
  const budget = c.targetRealMs - totalRealMs(p) - reserved;
  if (budget <= 0) return c.routineMaxScale;
  return clamp(remainingSim / budget, c.routineMinScale, c.routineMaxScale);
}

/** A tactical moment just opened. */
export function beginWindow(p: PaceState): void {
  p.phase = "window";
}

/** A moment just closed: show the consequence at real speed for a while. */
export function beginAftermath(p: PaceState): void {
  p.phase = "aftermath";
  p.aftermathLeftMs = p.config.aftermathSimMs;
}

/** The half just ended: hold the break for a beat. */
export function beginHalfTime(p: PaceState): void {
  p.halfTimeLeftMs = p.config.halfTimeRealMs;
  if (p.phase === "routine") p.phase = "halftime";
}

/**
 * Decide the clock scale for the next frame and charge the frame's real time to the phase it is
 * about to spend it in. Call once per frame before advancing the clock.
 */
export function paceScale(p: PaceState, inp: PaceInputs, realDtMs: number): number {
  if (inp.windowOpen) p.phase = "window";
  else if (p.phase === "window") beginAftermath(p);
  else if (p.phase === "aftermath" && p.aftermathLeftMs <= 0) {
    // a half-time whistle that arrived mid-moment still gets its beat
    p.phase = p.halfTimeLeftMs > 0 ? "halftime" : "routine";
    p.routineScale = p.config.routineMinScale;
  }
  else if (p.phase === "halftime" && p.halfTimeLeftMs <= 0) p.phase = "routine";

  p.realMs[p.phase] += Math.max(0, realDtMs);
  switch (p.phase) {
    case "window":
      return SLOW_SCALE;
    case "aftermath":
      return NORMAL_SCALE;
    case "halftime":
      p.halfTimeLeftMs -= realDtMs;
      return NORMAL_SCALE;
    case "routine": {
      const target = routineScaleFor(p, inp);
      // ease towards the target so the picture speeds up rather than jumping
      p.routineScale += (target - p.routineScale) * 0.2;
      if (Math.abs(target - p.routineScale) < 0.05) p.routineScale = target;
      return p.routineScale;
    }
  }
}

/** Simulated time passed this frame: burns down the aftermath. */
export function paceTicked(p: PaceState, simMs: number): void {
  if (p.phase === "aftermath") p.aftermathLeftMs -= simMs;
}

/** Whether a complete match landed inside the configured band. */
export function withinBand(p: PaceState): boolean {
  const t = totalRealMs(p);
  return t >= p.config.bandRealMs[0] && t <= p.config.bandRealMs[1];
}

export function formatRealTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
