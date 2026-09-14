import { add, clamp, dist, norm, rotate, scale, sub, type Vec2 } from "./geometry";
import { opponents, pressureAt } from "./perception";
import type { Rng } from "./rng";
import type { MatchState, PlayerState } from "./types";

/** Rolling deceleration of the ball on grass, m/s² (proposal). */
export const BALL_FRICTION = 3.2;
/** Radius within which a player can play the ball. */
export const CONTROL_RADIUS = 0.9;
/** Ticks a kicker must wait before touching the ball again. */
export const KICK_COOLDOWN_TICKS = 6;

export function maxKickSpeed(p: PlayerState, kind: "pass" | "shot"): number {
  const a = kind === "pass" ? p.attributes.passing : p.attributes.shooting;
  const base = kind === "pass" ? 9 + (a / 100) * 7 : 13 + (a / 100) * 9; // youth ranges (proposal)
  return base * (1 - 0.15 * p.fatigue) * (0.85 + 0.15 * (p.attributes.strength / 100));
}

/** Launch speed so a rolling ball arrives at distance d with residual speed vr. */
export function speedForDistance(d: number, residual = 4): number {
  return Math.sqrt(residual * residual + 2 * BALL_FRICTION * d);
}

export interface KickResult {
  velocity: Vec2;
  /** 0 (perfect) → 1 (badly misplayed) execution error magnitude. */
  error: number;
}

/**
 * Compute the ball velocity for a kick toward `target` with the player's error model.
 * Error grows with pressure, fatigue, distance and how far the ball is from the player's feet.
 * `intentAccuracy` (0..1) is the gesture accuracy supplied by the input layer; AI uses 1.
 */
export function kick(
  state: MatchState,
  p: PlayerState,
  target: Vec2,
  kind: "pass" | "shot",
  rng: Rng,
  intentAccuracy = 1,
): KickResult {
  const opps = opponents(state, p.side);
  const pressure = pressureAt(p.pos, opps);
  const d = dist(p.pos, target);
  const skill = (kind === "pass" ? p.attributes.passing : p.attributes.shooting) / 100;
  let speed = kind === "pass" ? speedForDistance(d) : maxKickSpeed(p, "shot") * (0.8 + 0.2 * skill);
  speed = Math.min(speed, maxKickSpeed(p, kind));

  const baseErr = kind === "pass" ? 0.05 : 0.08;
  const err =
    (baseErr + 0.18 * (1 - skill) + 0.06 * pressure + 0.08 * p.fatigue + 0.06 * (1 - intentAccuracy)) *
    (0.6 + 0.4 * Math.min(1, d / 30));
  const angleErr = rng.gaussian() * err * 0.35; // radians
  const speedErr = 1 + rng.gaussian() * err * 0.5;
  const dir = rotate(norm(sub(target, p.pos)), angleErr);
  return { velocity: scale(dir, clamp(speed * speedErr, 2, 26)), error: clamp(Math.abs(angleErr) * 3 + Math.abs(speedErr - 1), 0, 1) };
}

/**
 * First touch when receiving: returns the ball's new position offset from the player and whether the
 * touch was clean. A directional touch moves the ball ~1–2.5 m toward `direction`.
 */
export function firstTouch(
  state: MatchState,
  p: PlayerState,
  ballSpeed: number,
  direction: Vec2 | null,
  rng: Rng,
): { offset: Vec2; clean: boolean } {
  const opps = opponents(state, p.side);
  const pressure = pressureAt(p.pos, opps);
  const skill = p.attributes.firstTouch / 100;
  const difficulty = 0.05 + 0.012 * ballSpeed + 0.12 * pressure + 0.1 * p.fatigue;
  const clean = rng.next() < clamp(1 - difficulty * (1.4 - skill), 0.15, 0.98);
  const dir = direction ? norm(direction) : norm(p.vel);
  const reach = clean ? 1 + 1.5 * skill : 2.5 + rng.next() * 2.5;
  const wobble = clean ? 0.15 : 0.9;
  const off = add(scale(dir, reach), { x: rng.gaussian() * wobble, y: rng.gaussian() * wobble });
  return { offset: off, clean };
}

/** Tackle attempt outcome probability. */
export function tackleSuccess(tackler: PlayerState, carrier: PlayerState, rng: Rng): boolean {
  const t = tackler.attributes.tackling / 100;
  const d = carrier.attributes.dribbling / 100;
  const s = (tackler.attributes.strength - carrier.attributes.strength) / 200;
  const p = clamp(0.32 + 0.35 * (t - d) + 0.15 * s - 0.1 * tackler.fatigue + 0.1 * carrier.fatigue, 0.1, 0.85);
  return rng.next() < p;
}

/** Goalkeeper save probability against a shot arriving at speed `v` from distance `d` with keeper `dOff` off-line. */
export function saveChance(keeper: PlayerState, v: number, d: number, dOff: number): number {
  const g = keeper.attributes.goalkeeping / 100;
  const base = 0.35 + 0.4 * g;
  const speedPenalty = clamp((v - 12) / 30, 0, 0.35);
  const distBonus = clamp((d - 8) / 40, 0, 0.3);
  const reachPenalty = clamp(dOff / 6, 0, 0.5);
  return clamp(base - speedPenalty + distBonus - reachPenalty, 0.05, 0.95);
}
