import { add, clamp, dist, len, lerp, norm, rotate, scale, sub, type Vec2 } from "./geometry";
import { shapePoint } from "./formation";
import {
  arrivalTime,
  distanceToGoal,
  interceptPoint,
  laneReport,
  nearest,
  opponents,
  other,
  pressureAt,
  progress,
  shotWindow,
  spaceAt,
  teammates,
} from "./perception";
import { attackingGoalX, defendingGoalX, goalCenter, inPenaltyArea } from "./rules";
import { speedForDistance } from "./actions";
import type { Rng } from "./rng";
import type { MatchState, PlayerCommand, PlayerState } from "./types";

/** A scored alternative the carrier considered. Exposed so the tactical layer can reuse the same evaluation. */
export interface OnBallOption {
  command: PlayerCommand;
  kind: "carry" | "pass" | "switch" | "shoot" | "hold";
  score: number;
  /** Human-readable field-condition reasons (used by feedback, never as a hint before selection). */
  reasons: string[];
  receiver?: string;
}

const PASS_MARGIN_MIN = 0.15;

/**
 * Enumerate and score the carrier's options. Methodology (spec §15): attack space first, draw
 * defenders when space is closed, switch when the far side offers more.
 */
export function evaluateOnBall(state: MatchState, p: PlayerState): OnBallOption[] {
  const rules = state.rules;
  const opps = opponents(state, p.side);
  const mates = teammates(state, p.side).filter((m) => m.id !== p.id);
  const dir = p.side === "home" ? 1 : -1;
  const myProgress = progress(rules, p.side, p.pos);
  const myPressure = pressureAt(p.pos, opps);
  const options: OnBallOption[] = [];

  // Shoot
  const dGoal = distanceToGoal(rules, p.side, p.pos);
  if (dGoal < 26 && p.role !== 1) {
    const window = shotWindow(rules, p.side, p.pos, opps);
    const keeper = opps.find((o) => o.role === 1);
    const target = goalCenter(rules, attackingGoalX(rules, p.side));
    let aim = target;
    if (keeper) {
      // aim away from the keeper, inside the post
      const side = keeper.pos.y > rules.width / 2 ? -1 : 1;
      aim = { x: target.x, y: target.y + side * rules.goalWidth * 0.32 };
    }
    const score = clamp((window / 0.5) * (1 - dGoal / 32) * 2.2 - myPressure * 0.15, 0, 2.5);
    const reasons = [`shot window ${(window * 57.3).toFixed(0)}°`, `${dGoal.toFixed(0)} m from goal`];
    options.push({ command: { type: "shoot", target: aim }, kind: "shoot", score, reasons });
  }

  // Carry into space
  const forward = { x: dir, y: 0 };
  for (const deg of [0, -35, 35, -70, 70, -110, 110]) {
    const d = rotate(forward, (deg * Math.PI) / 180);
    const spaceAhead = spaceAt(add(p.pos, scale(d, 4)), opps);
    const distance = clamp(3 + spaceAhead * 10, 3, 12);
    const end = add(p.pos, scale(d, distance));
    if (end.x < 0.5 || end.x > rules.length - 0.5 || end.y < 0.5 || end.y > rules.width - 0.5) continue;
    const gain = progress(rules, p.side, end) - myProgress;
    const endPressure = pressureAt(end, opps);
    const space = spaceAt(end, opps);
    let score = 0.65 + gain * 3 + space * 0.7 - endPressure * 0.5 - myPressure * 0.25;
    if (p.role === 1) score -= 0.8;
    if (inPenaltyArea(rules, defendingGoalX(rules, p.side), end)) score -= 0.4;
    const reasons = [`space ${space.toFixed(2)} ahead`, `pressure ${endPressure.toFixed(2)} at end`];
    if (gain > 0.04 && space > 0.4) reasons.push("open space to attack");
    options.push({ command: { type: "carry", direction: d, distance }, kind: "carry", score, reasons });
  }

  // Passes to teammates (to feet or to space ahead of them)
  const nearSideSpace = spaceAt(add(p.pos, scale(forward, 8)), opps);
  for (const m of mates) {
    const candidates: { point: Vec2; label: string }[] = [];
    const lead = add(m.pos, scale(m.vel, 0.4));
    candidates.push({ point: lead, label: "to feet" });
    const ahead = add(m.pos, scale(forward, 6));
    if (ahead.x > 1 && ahead.x < rules.length - 1 && spaceAt(ahead, opps) > 0.35 && len(m.vel) > 1)
      candidates.push({ point: ahead, label: "into space ahead" });
    for (const c of candidates) {
      const d = dist(p.pos, c.point);
      if (d < 3 || d > 40) continue;
      const speed = speedForDistance(d);
      const lane = laneReport(p.pos, c.point, speed, opps);
      if (lane.margin < PASS_MARGIN_MIN) continue;
      const gain = progress(rules, p.side, c.point) - myProgress;
      const recvPressure = pressureAt(c.point, opps);
      const recvSpace = spaceAt(c.point, opps);
      const lateral = Math.abs(c.point.y - p.pos.y);
      const isSwitch = lateral > rules.width * 0.4 && recvSpace > nearSideSpace + 0.2;
      let score =
        0.35 + gain * 2.2 + recvSpace * 0.7 - recvPressure * 0.4 + clamp(lane.margin, 0, 1) * 0.3 - (d / 40) * 0.25;
      if (isSwitch) score += 0.35;
      if (myPressure > 0.8) score += 0.3; // relieve pressure
      if (m.role === 1) score -= 0.6;
      if (gain < -0.15) score -= 0.2;
      if (d < 7) score -= 0.25;
      const reasons = [
        `lane margin ${lane.margin.toFixed(2)} s`,
        `receiver space ${recvSpace.toFixed(2)}`,
        c.label,
      ];
      if (isSwitch) reasons.push("far side more open: switch");
      options.push({
        command: { type: "pass", target: c.point, receiver: m.id },
        kind: isSwitch ? "switch" : "pass",
        score,
        reasons,
        receiver: m.id,
      });
    }
  }

  // Hold / shield
  options.push({
    command: { type: "hold" },
    kind: "hold",
    score: 0.2 - myPressure * 0.3,
    reasons: ["keep possession, wait for support"],
  });

  return options.sort((a, b) => b.score - a.score);
}

export function decideOnBall(state: MatchState, p: PlayerState, rng: Rng): PlayerCommand {
  const options = evaluateOnBall(state, p);
  const best = options[0];
  if (!best) return { type: "hold" };
  // soft choice: occasionally take the second-best when close, weighted by awareness
  const second = options[1];
  const awareness = p.attributes.awareness / 100;
  if (second && best.score - second.score < 0.15 && rng.next() > 0.5 + awareness * 0.4) return second.command;
  return best.command;
}

/** Off-ball decision: where should this player move (and should they press/tackle)? */
export function decideOffBall(state: MatchState, p: PlayerState): PlayerCommand {
  const rules = state.rules;
  const ball = state.ball;
  const inPossession = state.possession === p.side;
  const opps = opponents(state, p.side);
  const mates = teammates(state, p.side);
  const dir = p.side === "home" ? 1 : -1;
  const shape = shapePoint(rules, p, ball.pos, inPossession);

  // Intended receiver goes to meet the pass
  if (ball.status === "loose" && ball.passTarget === p.id) {
    return { type: "move", target: clampField(rules, interceptPoint(p, ball).point) };
  }
  // Loose ball: nearest few go for it
  if (ball.status === "loose") {
    const all = state.players.filter((q) => q.touchCooldown === 0 && q.stunned === 0);
    const myT = arrivalTime(p, ball.pos);
    const faster = all.filter((q) => q.id !== p.id && arrivalTime(q, ball.pos) < myT - 0.05);
    const teamFaster = faster.filter((q) => q.side === p.side).length;
    const keeperOwnBox = p.role === 1 && inPenaltyArea(rules, defendingGoalX(rules, p.side), ball.pos);
    if (teamFaster === 0 || keeperOwnBox) {
      return { type: "move", target: clampField(rules, interceptPoint(p, ball).point) };
    }
  }

  if (inPossession) {
    const carrier = ball.owner ? state.players.find((q) => q.id === ball.owner) : null;
    if (carrier && carrier.id !== p.id) {
      const carrierPressure = pressureAt(carrier.pos, opps);
      const carrierProgress = progress(rules, p.side, carrier.pos);
      const myProgress = progress(rules, p.side, p.pos);
      const sameFlank = Math.sign(carrier.pos.y - rules.width / 2) === Math.sign(p.pos.y - rules.width / 2);

      // Run behind: attackers when there is space beyond the last defender line
      if (p.role === 9 || p.role === 7 || p.role === 11) {
        const lastDefX = lastDefenderLine(state, other(p.side));
        const behind = { x: lastDefX + dir * 3, y: clamp(p.pos.y + (rules.width / 2 - p.pos.y) * 0.3, 3, rules.width - 3) };
        const goalX = attackingGoalX(rules, p.side);
        const offsideSafe = dir > 0 ? p.pos.x <= lastDefX + 0.3 : p.pos.x >= lastDefX - 0.3;
        if (offsideSafe && Math.abs(goalX - lastDefX) > 8 && spaceAt(behind, opps) > 0.3 && dist(carrier.pos, behind) < 35) {
          return { type: "move", target: behind };
        }
      }
      // Overlap: full back on the same flank when the winger has the ball with space wide of them
      if ((p.role === 2 || p.role === 3) && sameFlank && (carrier.role === 7 || carrier.role === 11)) {
        const wideY = carrier.pos.y < rules.width / 2 ? 2 : rules.width - 2;
        const target = { x: carrier.pos.x + dir * 8, y: wideY };
        if (spaceAt(target, opps) > 0.4) return { type: "move", target };
      }
      // Support underneath: midfielders when the carrier is pressed
      if ((p.role === 6 || p.role === 8) && carrierPressure > 0.7 && myProgress > carrierProgress - 0.05) {
        const target = add(carrier.pos, { x: -dir * 7, y: (p.pos.y - carrier.pos.y) * 0.5 });
        return { type: "move", target: clampField(rules, target) };
      }
      // Third-player support: midfielders offer an angle 8–10 m from carrier
      if (p.role === 6 || p.role === 8 || (p.role === 4 && carrierPressure > 0.9)) {
        const angle = ((p.role === 8 ? 1 : -1) * Math.PI) / 4;
        const off = rotate({ x: -dir * 8, y: 0 }, angle);
        const target = clampField(rules, add(carrier.pos, off));
        return { type: "move", target: lerp(shape, target, 0.6) };
      }
    }
    return { type: "move", target: shape };
  }

  // Out of possession
  const carrier = ball.owner ? state.players.find((q) => q.id === ball.owner) : null;
  const ballPoint = carrier ? carrier.pos : ball.pos;
  const defenders = mates.filter((m) => m.role !== 1 && m.stunned === 0);
  const byDist = [...defenders].sort((a, b) => dist(a.pos, ballPoint) - dist(b.pos, ballPoint));
  const first = byDist[0];
  const second = byDist[1];

  if (first && first.id === p.id && carrier) {
    // Press: close down the carrier, approach on the goal side
    const goalSide = norm(sub(goalCenter(rules, defendingGoalX(rules, p.side)), carrier.pos));
    const target = add(carrier.pos, scale(goalSide, 0.8));
    return dist(p.pos, carrier.pos) < 1.6 ? { type: "press", target: carrier.id } : { type: "move", target };
  }
  if (second && second.id === p.id && carrier) {
    // Cover behind the presser
    const goalSide = norm(sub(goalCenter(rules, defendingGoalX(rules, p.side)), carrier.pos));
    return { type: "move", target: clampField(rules, add(carrier.pos, scale(goalSide, 6))) };
  }
  // Track runners: defenders pick up the nearest opponent goal-side of the shape point
  if (p.role === 2 || p.role === 3 || p.role === 4 || p.role === 6) {
    const dangerous = opps.filter(
      (o) => o.role !== 1 && (dir > 0 ? o.pos.x < shape.x + 6 : o.pos.x > shape.x - 6) && dist(o.pos, shape) < 10,
    );
    const runner = nearest(dangerous, shape);
    if (runner) {
      const goalSide = norm(sub(goalCenter(rules, defendingGoalX(rules, p.side)), runner.pos));
      return { type: "move", target: clampField(rules, add(runner.pos, scale(goalSide, 1.5))) };
    }
  }
  return { type: "move", target: shape };
}

/** x-coordinate of the second-last defender of `side` (offside line), including the keeper as a defender. */
export function lastDefenderLine(state: MatchState, side: "home" | "away"): number {
  const xs = teammates(state, side)
    .map((p) => p.pos.x)
    .sort((a, b) => a - b);
  // defending goal for home is x=0: second-lowest x; for away x=L: second-highest
  if (side === "home") return xs[1] ?? xs[0] ?? 0;
  return xs[xs.length - 2] ?? xs[xs.length - 1] ?? state.rules.length;
}

export function clampField(rules: { length: number; width: number }, p: Vec2): Vec2 {
  return { x: clamp(p.x, 0.3, rules.length - 0.3), y: clamp(p.y, 0.3, rules.width - 0.3) };
}
