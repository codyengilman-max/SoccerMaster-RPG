import { clamp } from "../sim/geometry";
import { Rng } from "../sim/rng";

/**
 * Juggling (spec §8 names it as a home activity): keep the ball up with timed touches. Each flight
 * has a seeded duration; the player touches when the ball comes back to the foot. A clean touch
 * keeps the ball straight, a loose one adds drift, and drift shortens the next flight and narrows
 * the timing window, so the run gets harder until a good touch settles it again. Three runs per
 * session; the best run is the number that counts. Deterministic for a seed and a touch sequence.
 * Thresholds are proposals (OPEN_QUESTIONS #38).
 */

export const RUNS_PER_SESSION = 3;
/** A U11 who reaches this stops the run themselves — the point is made. */
export const RUN_CAP = 50;
export const TICK_MS = 50;
const FLIGHT_MIN_MS = 700;
const FLIGHT_MAX_MS = 1050;
/** Timing bands in ms of absolute error at a normal window. */
const PERFECT_MS = 90;
const GOOD_MS = 190;
const LOOSE_MS = 320;
/** How much a loose touch pushes the ball off line (metres of drift, 0..1 saturates). */
const DRIFT_PER_LOOSE = 0.35;
const DRIFT_RECOVER_PERFECT = 0.3;
const DRIFT_RECOVER_GOOD = 0.12;
const READY_MS = 800;
const BETWEEN_MS = 1200;
export const ACCESSIBLE_WINDOW_FACTOR = 1.5;

export type TouchQuality = "perfect" | "good" | "loose" | "drop";
export type Phase = "ready" | "air" | "between" | "done";

export interface Touch {
  /** Signed timing error in ms (negative = early). */
  error: number;
  quality: TouchQuality;
}

export interface Run {
  touches: Touch[];
  /** How the run ended: the ball dropped, the cap was reached, or still going. */
  ended: "drop" | "cap" | null;
}

export interface JuggleState {
  seed: number;
  rng: Rng;
  runs: Run[];
  phase: Phase;
  /** Duration of the current flight. */
  flightMs: number;
  /** Time since the current flight (or phase) started. */
  elapsedMs: number;
  /** Sideways drift, 0 (straight) .. 1 (barely reachable). */
  drift: number;
  /** Direction of drift, −1 or +1, for rendering. */
  driftSide: number;
  windowScale: number;
  runsMax: number;
  cap: number;
}

export interface JuggleSummary {
  /** Best run in touches. */
  best: number;
  runs: number[];
  total: number;
  perfect: number;
  good: number;
  loose: number;
  /** Any run that reached the cap. */
  capped: boolean;
}

export interface JuggleOptions {
  runs?: number;
  cap?: number;
  windowScale?: number;
}

export function createJuggle(seed: number, opts: JuggleOptions = {}): JuggleState {
  return {
    seed,
    rng: new Rng(seed),
    runs: [],
    phase: "ready",
    flightMs: 0,
    elapsedMs: 0,
    drift: 0,
    driftSide: 1,
    windowScale: opts.windowScale ?? 1,
    runsMax: opts.runs ?? RUNS_PER_SESSION,
    cap: opts.cap ?? RUN_CAP,
  };
}

export const currentRun = (s: JuggleState): Run | undefined => s.runs.at(-1);
export const touchesInRun = (r: Run | undefined): number => r?.touches.filter((t) => t.quality !== "drop").length ?? 0;
export const runsLeft = (s: JuggleState): number => s.runsMax - s.runs.filter((r) => r.ended).length;

/** Window widths at the current drift and accessibility scale. */
export function windows(s: JuggleState): { perfect: number; good: number; loose: number } {
  const k = s.windowScale * (1 - 0.35 * s.drift);
  return { perfect: PERFECT_MS * k, good: GOOD_MS * k, loose: LOOSE_MS * k };
}

function newFlight(s: JuggleState): void {
  s.flightMs = Math.round(s.rng.range(FLIGHT_MIN_MS, FLIGHT_MAX_MS) * (1 - 0.3 * s.drift));
  s.elapsedMs = 0;
  s.phase = "air";
}

/** Start the next run (the ball is flicked up); no-op while a run is live. */
export function startRun(s: JuggleState): boolean {
  if (s.phase === "air" || s.phase === "done") return false;
  if (runsLeft(s) <= 0) {
    s.phase = "done";
    return false;
  }
  s.runs.push({ touches: [], ended: null });
  s.drift = 0;
  s.driftSide = s.rng.chance(0.5) ? -1 : 1;
  newFlight(s);
  return true;
}

function endRun(s: JuggleState, how: "drop" | "cap"): void {
  const r = currentRun(s)!;
  r.ended = how;
  s.elapsedMs = 0;
  s.phase = runsLeft(s) <= 0 ? "done" : "between";
}

/** Where the ball is in its flight, 0 at the foot .. 1 at the apex .. 0 back at the foot (past 1 means it is dropping below the foot). */
export function ballHeight(s: JuggleState): number {
  if (s.phase !== "air") return 0;
  const t = s.elapsedMs / s.flightMs;
  return Math.max(-0.4, 1 - (2 * t - 1) * (2 * t - 1));
}

export function classify(s: JuggleState, error: number): TouchQuality {
  const w = windows(s);
  const e = Math.abs(error);
  if (e <= w.perfect) return "perfect";
  if (e <= w.good) return "good";
  if (e <= w.loose) return "loose";
  return "drop";
}

/** The player touches the ball now. Returns the touch, or null when there is nothing to touch. */
export function touch(s: JuggleState): Touch | null {
  if (s.phase !== "air") return null;
  const error = s.elapsedMs - s.flightMs;
  const quality = classify(s, error);
  const t: Touch = { error, quality };
  const r = currentRun(s)!;
  r.touches.push(t);
  if (quality === "drop") {
    endRun(s, "drop");
    return t;
  }
  if (quality === "loose") {
    if (Math.sign(error) !== s.driftSide && s.drift < 0.2) s.driftSide = Math.sign(error) || s.driftSide;
    s.drift = clamp(s.drift + DRIFT_PER_LOOSE, 0, 1);
  } else {
    s.drift = clamp(s.drift - (quality === "perfect" ? DRIFT_RECOVER_PERFECT : DRIFT_RECOVER_GOOD), 0, 1);
  }
  if (touchesInRun(r) >= s.cap) {
    endRun(s, "cap");
    return t;
  }
  newFlight(s);
  return t;
}

/** Advance real time. A flight that runs past the loose window without a touch is a drop. */
export function step(s: JuggleState, dtMs: number): void {
  if (s.phase === "done") return;
  s.elapsedMs += dtMs;
  if (s.phase === "air") {
    if (s.elapsedMs > s.flightMs + windows(s).loose) {
      currentRun(s)!.touches.push({ error: s.elapsedMs - s.flightMs, quality: "drop" });
      endRun(s, "drop");
    }
  } else if (s.phase === "between" && s.elapsedMs >= BETWEEN_MS) {
    s.phase = "ready";
    s.elapsedMs = 0;
  } else if (s.phase === "ready" && s.elapsedMs >= READY_MS && s.runs.length === 0) {
    // the first run starts itself so the screen is not waiting on a hidden control
    startRun(s);
  }
}

export function summarize(s: JuggleState): JuggleSummary {
  const runs = s.runs.map((r) => touchesInRun(r));
  const all = s.runs.flatMap((r) => r.touches);
  return {
    best: runs.length ? Math.max(...runs) : 0,
    runs,
    total: runs.reduce((a, b) => a + b, 0),
    perfect: all.filter((t) => t.quality === "perfect").length,
    good: all.filter((t) => t.quality === "good").length,
    loose: all.filter((t) => t.quality === "loose").length,
    capped: s.runs.some((r) => r.ended === "cap"),
  };
}

/**
 * Headless run for tests and calibration: `errorFor` gives the timing error of each touch (null =
 * let the ball drop). Runs start as soon as the state allows.
 */
export function runHeadless(s: JuggleState, errorFor: (touchIndex: number, run: number) => number | null, maxTicks = 20000): JuggleState {
  let i = 0;
  for (let tick = 0; tick < maxTicks && s.phase !== "done"; tick++) {
    if (s.phase === "ready") {
      startRun(s);
      continue;
    }
    if (s.phase === "air") {
      const e = errorFor(i, s.runs.length - 1);
      const at = e === null ? Number.POSITIVE_INFINITY : s.flightMs + e;
      if (s.elapsedMs + TICK_MS >= at) {
        s.elapsedMs = at;
        touch(s);
        i++;
        continue;
      }
    }
    step(s, TICK_MS);
  }
  return s;
}
