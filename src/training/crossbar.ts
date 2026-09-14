import { readGesture } from "../gesture/gesture";
import { clamp, dist, type Vec2 } from "../sim/geometry";
import { Rng } from "../sim/rng";

/**
 * Crossbar challenge — the optional friend activity (spec §7 "enjoyable optional activity with
 * the friend"). Front view of a small goal; you and your friend alternate five attempts each to
 * hit the bar from the edge of the area. Nothing here is graded as a tactical decision: it is a
 * game between friends, and its only campaign effects are relationship and wellbeing (spec §19:
 * friendship never awards soccer attributes). Deterministic for a seed; the friend's attempts are
 * drawn from the same generator so a replay matches.
 */

/** Goal frame in metres, viewed from the front: x across (0 = left post), y up (0 = ground). */
export const FRAME = { width: 6, height: 2, barThickness: 0.12 } as const;
/** Drawing space: the view extends beyond the frame so misses are visible. */
export const VIEW = { width: 12, height: 5 } as const;
/** The ball sits at the bottom centre of the view. */
export const BALL_SPOT: Vec2 = { x: VIEW.width / 2, y: 0.2 };
export const ATTEMPTS_EACH = 5;
/** A shot ending this close to the bar's centre line counts as a hit. */
const HIT_TOLERANCE = 0.16;
/** Height error of a drawing with zero precision. */
const MAX_HEIGHT_ERROR = 1.1;
const MAX_SIDE_ERROR = 1.6;
/** Friend's chance of a hit per attempt (proposal; not from attributes, see OPEN_QUESTIONS). */
export const FRIEND_HIT_CHANCE = 0.35;

export type Shooter = "you" | "friend";
export type Result = "bar" | "over" | "under" | "wide";

export interface Attempt {
  shooter: Shooter;
  /** Where the ball crossed the goal-line plane, in frame metres (x across the view, y up). */
  landing: Vec2;
  result: Result;
}

export interface ChallengeState {
  seed: number;
  rngState: number;
  attempts: Attempt[];
  /** Whose turn it is; null once both have used their attempts. */
  turn: Shooter | null;
  friendName: string;
}

export function createChallenge(seed: number, friendName = "Friend"): ChallengeState {
  const rng = new Rng(seed);
  return { seed, rngState: rng.snapshot(), attempts: [], turn: "you", friendName };
}

const barCenter: Vec2 = { x: VIEW.width / 2, y: FRAME.height };
const frameLeft = (VIEW.width - FRAME.width) / 2;

export function classify(landing: Vec2): Result {
  const inWidth = landing.x >= frameLeft && landing.x <= frameLeft + FRAME.width;
  if (!inWidth) return "wide";
  if (Math.abs(landing.y - FRAME.height) <= HIT_TOLERANCE) return "bar";
  return landing.y > FRAME.height ? "over" : "under";
}

/** Read a drawing (view metres) as an aiming point: the path's end is where you meant the ball to go. */
export function readAim(points: readonly Vec2[]): { aim: Vec2; precision: number } | null {
  const g = readGesture(points);
  if (!g) return null;
  if (g.direction.y <= 0.2) return null;
  const aim = { x: clamp(g.end.x, 0, VIEW.width), y: clamp(g.end.y, 0, VIEW.height) };
  const precision = clamp(0.55 + 0.45 * g.straightness, 0, 1);
  return { aim, precision };
}

/** Accessible alternative: tap where you want the ball to go. */
export function readTapAim(point: Vec2): { aim: Vec2; precision: number } {
  return { aim: { x: clamp(point.x, 0, VIEW.width), y: clamp(point.y, 0, VIEW.height) }, precision: 0.8 };
}

function done(s: ChallengeState, who: Shooter): number {
  return s.attempts.filter((a) => a.shooter === who).length;
}

/** Your shot: the aim bent by the drawing's imprecision plus a little technique noise. */
export function shoot(s: ChallengeState, aim: Vec2, precision: number): Attempt | null {
  if (s.turn !== "you") return null;
  const rng = new Rng(0);
  rng.restore(s.rngState);
  const p = clamp(precision, 0, 1);
  const landing = {
    x: aim.x + (1 - p) * MAX_SIDE_ERROR * rng.gaussian() * 0.5 + rng.gaussian() * 0.15,
    y: Math.max(0, aim.y + (1 - p) * MAX_HEIGHT_ERROR * rng.gaussian() * 0.5 + rng.gaussian() * 0.1),
  };
  const attempt: Attempt = { shooter: "you", landing, result: classify(landing) };
  s.attempts.push(attempt);
  s.rngState = rng.snapshot();
  advanceTurn(s);
  return attempt;
}

/** The friend's attempt, drawn from the generator. */
export function friendShoots(s: ChallengeState): Attempt | null {
  if (s.turn !== "friend") return null;
  const rng = new Rng(0);
  rng.restore(s.rngState);
  const hit = rng.chance(FRIEND_HIT_CHANCE);
  const landing = hit
    ? { x: barCenter.x + rng.range(-FRAME.width / 2 + 0.3, FRAME.width / 2 - 0.3), y: FRAME.height + rng.range(-HIT_TOLERANCE, HIT_TOLERANCE) * 0.9 }
    : { x: barCenter.x + rng.gaussian() * 1.6, y: Math.max(0, FRAME.height + rng.gaussian() * 0.9) };
  const attempt: Attempt = { shooter: "friend", landing, result: classify(landing) };
  s.attempts.push(attempt);
  s.rngState = rng.snapshot();
  advanceTurn(s);
  return attempt;
}

function advanceTurn(s: ChallengeState): void {
  const you = done(s, "you");
  const friend = done(s, "friend");
  if (you >= ATTEMPTS_EACH && friend >= ATTEMPTS_EACH) s.turn = null;
  else if (you > friend) s.turn = "friend";
  else s.turn = "you";
}

export interface ChallengeSummary {
  activityId: "crossbar";
  yourHits: number;
  friendHits: number;
  winner: Shooter | "draw";
  /** Your closest miss in metres from the bar (0 when you hit it). */
  closest: number;
}

export function summarize(s: ChallengeState): ChallengeSummary {
  const yourHits = s.attempts.filter((a) => a.shooter === "you" && a.result === "bar").length;
  const friendHits = s.attempts.filter((a) => a.shooter === "friend" && a.result === "bar").length;
  let closest = Number.POSITIVE_INFINITY;
  for (const a of s.attempts) if (a.shooter === "you") closest = Math.min(closest, a.result === "bar" ? 0 : dist(a.landing, { x: clamp(a.landing.x, frameLeft, frameLeft + FRAME.width), y: FRAME.height }));
  return { activityId: "crossbar", yourHits, friendHits, winner: yourHits > friendHits ? "you" : friendHits > yourHits ? "friend" : "draw", closest: Number.isFinite(closest) ? closest : 0 };
}
