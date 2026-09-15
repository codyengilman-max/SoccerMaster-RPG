import { Rng } from "../sim/rng";

/**
 * Scoreline model for matches nobody plays on screen: the other clubs' league rounds, and the
 * user's club when the user is absent. It is not the soccer simulation — it only has to keep
 * league tables and tournament records complete and plausible so qualification, standings and
 * story facts have something real to stand on. Quality is the club's ambient 0–100 figure.
 * Deterministic for a seed. Every number is a proposal (OPEN_QUESTIONS #28).
 */

export interface ModelledResult {
  homeGoals: number;
  awayGoals: number;
}

/** Mean goals per side for evenly matched U11 9v9 teams (proposal; real reference statistics are open). */
export const BASE_GOALS = 2.1;
/** Home-side multiplier. */
export const HOME_EDGE = 1.08;
/** A 15-point quality gap is worth roughly +28% / −22% goals. */
export const QUALITY_SLOPE = 1.65;
/** Hard cap so a runaway sample cannot produce a cartoon scoreline. */
export const MAX_GOALS = 9;

export function expectedGoals(quality: number, opponentQuality: number, home: boolean): number {
  const gap = (quality - opponentQuality) / 100;
  return BASE_GOALS * Math.exp(QUALITY_SLOPE * gap) * (home ? HOME_EDGE : 1);
}

/** Poisson sample by inversion. */
export function poisson(rng: Rng, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = rng.next();
  while (p > limit && k < MAX_GOALS) {
    k++;
    p *= rng.next();
  }
  return k;
}

export function modelResult(homeQuality: number, awayQuality: number, seed: number): ModelledResult {
  const rng = new Rng(seed);
  return {
    homeGoals: poisson(rng, expectedGoals(homeQuality, awayQuality, true)),
    awayGoals: poisson(rng, expectedGoals(awayQuality, homeQuality, false)),
  };
}
