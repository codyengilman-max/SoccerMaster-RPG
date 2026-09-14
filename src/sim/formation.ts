import { clamp, type Vec2 } from "./geometry";
import type { Rules, Side } from "./rules";
import type { PlayerState, RoleNumber } from "./types";

/**
 * 1-3-2-3 base shape in normalised field coordinates for a team attacking toward x = 1.
 * y = 0 is the team's right touchline when facing the goal they attack... to keep it simple we
 * define y in absolute field terms for the HOME team (attacking +x) and mirror both axes for away.
 * Home right back (2) therefore sits at low y, left back (3) at high y.
 */
export const BASE_1323: Record<RoleNumber, Vec2> = {
  1: { x: 0.06, y: 0.5 },
  2: { x: 0.28, y: 0.2 },
  4: { x: 0.24, y: 0.5 },
  3: { x: 0.28, y: 0.8 },
  6: { x: 0.42, y: 0.42 },
  8: { x: 0.5, y: 0.6 },
  7: { x: 0.68, y: 0.15 },
  9: { x: 0.74, y: 0.5 },
  11: { x: 0.68, y: 0.85 },
};

/** How strongly each role's shape point follows the ball along x / y (0 = fixed, 1 = fully ball-relative). */
const BALL_FOLLOW: Record<RoleNumber, { x: number; y: number }> = {
  1: { x: 0.12, y: 0.15 },
  2: { x: 0.45, y: 0.3 },
  4: { x: 0.45, y: 0.35 },
  3: { x: 0.45, y: 0.3 },
  6: { x: 0.55, y: 0.4 },
  8: { x: 0.6, y: 0.4 },
  7: { x: 0.5, y: 0.2 },
  9: { x: 0.45, y: 0.3 },
  11: { x: 0.5, y: 0.2 },
};

export function toField(rules: Rules, side: Side, n: Vec2): Vec2 {
  const x = side === "home" ? n.x : 1 - n.x;
  const y = side === "home" ? n.y : 1 - n.y;
  return { x: x * rules.length, y: y * rules.width };
}

export function basePosition(rules: Rules, side: Side, role: RoleNumber): Vec2 {
  return toField(rules, side, BASE_1323[role]);
}

/** Kickoff positions: everyone in own half, base shape compressed toward own goal. */
export function kickoffPosition(rules: Rules, side: Side, role: RoleNumber, taking: boolean): Vec2 {
  const b = BASE_1323[role];
  let n: Vec2 = { x: Math.min(b.x * 0.8, 0.47), y: b.y };
  if (taking && role === 9) n = { x: 0.495, y: 0.5 };
  if (taking && role === 8) n = { x: 0.47, y: 0.55 };
  return toField(rules, side, n);
}

/**
 * Ball-relative team shape (spec §15): each role's reference point slides toward the ball with a
 * role-specific weight, compresses when defending and stretches when attacking.
 */
export function shapePoint(rules: Rules, p: PlayerState, ball: Vec2, inPossession: boolean): Vec2 {
  const dir = p.side === "home" ? 1 : -1;
  const base = basePosition(rules, p.side, p.role);
  const follow = BALL_FOLLOW[p.role];
  const dx = (ball.x - rules.length / 2) * follow.x;
  const dy = (ball.y - rules.width / 2) * follow.y;
  let x = base.x + dx;
  let y = base.y + dy;
  if (inPossession) {
    // stretch: attackers push higher, wide players hold width
    if (p.role === 7 || p.role === 11 || p.role === 9) x += dir * rules.length * 0.05;
    if (p.role === 7 || p.role === 11) y = base.y + dy * 0.4;
  } else {
    // compress: drop toward own goal and narrow
    x -= dir * rules.length * 0.07;
    y = rules.width / 2 + (y - rules.width / 2) * 0.8;
  }
  if (p.role === 1) {
    // keeper stays near goal, slides across with the ball
    const goalX = p.side === "home" ? 0 : rules.length;
    x = goalX + dir * clamp(2 + Math.abs(ball.x - goalX) * 0.08, 1.5, 8);
    y = rules.width / 2 + (ball.y - rules.width / 2) * 0.35;
  }
  return { x: clamp(x, 0.5, rules.length - 0.5), y: clamp(y, 0.5, rules.width - 0.5) };
}
