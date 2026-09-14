import { add, closestOnSegment, dist, distToSegment, dot, len, norm, scale, sub, type Vec2 } from "./geometry";
import { attackingGoalX, goalCenter, type Rules, type Side } from "./rules";
import type { BallState, MatchState, PlayerState } from "./types";

export const other = (s: Side): Side => (s === "home" ? "away" : "home");

export function teammates(state: MatchState, side: Side): PlayerState[] {
  return state.players.filter((p) => p.side === side);
}

export function opponents(state: MatchState, side: Side): PlayerState[] {
  return state.players.filter((p) => p.side !== side);
}

export function playerById(state: MatchState, id: string): PlayerState {
  const p = state.players.find((q) => q.id === id);
  if (!p) throw new Error(`unknown player ${id}`);
  return p;
}

export function nearest(players: readonly PlayerState[], point: Vec2): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = Infinity;
  for (const p of players) {
    const d = dist(p.pos, point);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Effective top speed in m/s after fatigue. */
export function topSpeed(p: PlayerState): number {
  const base = 4.2 + (p.attributes.pace / 100) * 2.6; // 4.2–6.8 m/s, youth range (proposal)
  return base * (1 - 0.3 * p.fatigue);
}

/** Time for player to arrive at a point, accounting for current velocity toward it. */
export function arrivalTime(p: PlayerState, point: Vec2): number {
  const d = dist(p.pos, point);
  if (d < 0.3) return 0;
  const toward = dot(p.vel, norm(sub(point, p.pos)));
  const v = topSpeed(p);
  const accel = 3 + (p.attributes.acceleration / 100) * 3;
  // time to reach top speed from current closing speed
  const v0 = Math.max(0, toward);
  const tAcc = Math.max(0, (v - v0) / accel);
  const dAcc = v0 * tAcc + 0.5 * accel * tAcc * tAcc;
  if (dAcc >= d) {
    // solve v0 t + 0.5 a t^2 = d
    return (-v0 + Math.sqrt(v0 * v0 + 2 * accel * d)) / accel;
  }
  return tAcc + (d - dAcc) / v;
}

/**
 * Pressure on a point from the given opponents: 0 (free) → 1+ (tightly pressed).
 * Each opponent contributes by proximity and closing speed.
 */
export function pressureAt(point: Vec2, opps: readonly PlayerState[]): number {
  let total = 0;
  for (const o of opps) {
    const d = dist(o.pos, point);
    if (d > 8) continue;
    const closing = Math.max(0, dot(o.vel, norm(sub(point, o.pos))));
    total += Math.max(0, 1 - d / 8) ** 2 * (1 + closing / 6);
  }
  return total;
}

/** Space score at a point: distance to nearest opponent, capped, scaled 0..1. */
export function spaceAt(point: Vec2, opps: readonly PlayerState[]): number {
  let minD = Infinity;
  for (const o of opps) minD = Math.min(minD, dist(o.pos, point));
  return Math.min(1, minD / 12);
}

export interface LaneReport {
  /** Minimum distance from any opponent to the pass line. */
  minClearance: number;
  /** Opponent who can most plausibly intercept (smallest margin), if any. */
  threat: PlayerState | null;
  /** Estimated intercept margin in seconds: positive = ball arrives before the threat. */
  margin: number;
}

/** Evaluate a straight pass from a to b at the given ball speed. */
export function laneReport(a: Vec2, b: Vec2, ballSpeed: number, opps: readonly PlayerState[]): LaneReport {
  let minClearance = Infinity;
  let threat: PlayerState | null = null;
  let margin = Infinity;
  const total = dist(a, b);
  for (const o of opps) {
    const c = closestOnSegment(o.pos, a, b);
    const clearance = dist(o.pos, c.point);
    minClearance = Math.min(minClearance, clearance);
    const ballT = (c.t * total) / Math.max(1, ballSpeed);
    const oppT = arrivalTime(o, c.point) + 0.15; // reaction
    const m = oppT - ballT;
    if (m < margin) {
      margin = m;
      threat = o;
    }
  }
  return { minClearance, threat, margin };
}

/** Progress of a point toward the attacking goal, 0..1 along the field. */
export function progress(rules: Rules, side: Side, p: Vec2): number {
  return side === "home" ? p.x / rules.length : 1 - p.x / rules.length;
}

export function distanceToGoal(rules: Rules, side: Side, p: Vec2): number {
  return dist(p, goalCenter(rules, attackingGoalX(rules, side)));
}

/** Player's shooting angle window (radians) to the attacking goal, reduced by defenders on the line. */
export function shotWindow(rules: Rules, side: Side, from: Vec2, opps: readonly PlayerState[]): number {
  const gx = attackingGoalX(rules, side);
  const half = rules.goalWidth / 2;
  const left = { x: gx, y: rules.width / 2 - half };
  const right = { x: gx, y: rules.width / 2 + half };
  const vL = sub(left, from);
  const vR = sub(right, from);
  let angle = Math.abs(Math.atan2(vL.y, vL.x) - Math.atan2(vR.y, vR.x));
  if (angle > Math.PI) angle = 2 * Math.PI - angle;
  // blockers: opponents within 1 m of the line to goal centre reduce the window
  const center = goalCenter(rules, gx);
  for (const o of opps) {
    const d = distToSegment(o.pos, from, center);
    if (d < 1.2 && len(sub(o.pos, from)) < len(sub(center, from))) angle *= 0.55;
  }
  return angle;
}

/** Ball friction (m/s^2) used to predict where a rolling ball will be. Keep in sync with actions.BALL_FRICTION. */
export const ROLLING_FRICTION = 3.2;

/** Position of a freely rolling ball after t seconds. */
export function ballPositionAt(ball: BallState, t: number): Vec2 {
  const v = len(ball.vel);
  if (v < 1e-6) return ball.pos;
  const tStop = v / ROLLING_FRICTION;
  const tt = Math.min(t, tStop);
  const s = v * tt - 0.5 * ROLLING_FRICTION * tt * tt;
  return add(ball.pos, scale(norm(ball.vel), s));
}

/**
 * Earliest point on the ball's path the player can reach no later than the ball.
 * Falls back to the ball's stopping point.
 */
export function interceptPoint(p: PlayerState, ball: BallState, horizon = 3): { point: Vec2; t: number } {
  for (let t = 0; t <= horizon; t += 0.05) {
    const point = ballPositionAt(ball, t);
    if (arrivalTime(p, point) <= t + 0.02) return { point, t };
  }
  const point = ballPositionAt(ball, horizon);
  return { point, t: arrivalTime(p, point) };
}
