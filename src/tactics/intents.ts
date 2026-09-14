import { clampField, evaluateOnBall, lastDefenderLine } from "../sim/ai";
import { speedForDistance } from "../sim/actions";
import { add, clamp, dist, norm, scale, sub, type Vec2 } from "../sim/geometry";
import { shapePoint } from "../sim/formation";
import { laneReport, opponents, other, playerById, pressureAt, progress, spaceAt, teammates } from "../sim/perception";
import { attackingGoalX, defendingGoalX, goalCenter } from "../sim/rules";
import type { MatchState, PlayerCommand, PlayerState } from "../sim/types";
import type { Intent } from "./catalog";

/**
 * A catalog intent made concrete against the live field state.
 * `feasibility` (0..1) says how well the state supports the intent right now (an open lane, real
 * space, a runner to track); it feeds option scoring but is never shown as "the right answer".
 * `anchor` is the point the player's drawing will be compared against for drawn intents.
 */
export interface Instantiated {
  command: PlayerCommand;
  feasibility: number;
  anchor: Vec2 | null;
  detail: string;
  receiver?: string;
}

const FORWARD = (p: PlayerState): Vec2 => ({ x: p.side === "home" ? 1 : -1, y: 0 });

export function instantiateIntent(state: MatchState, p: PlayerState, intent: Intent): Instantiated | null {
  const rules = state.rules;
  const ball = state.ball;
  const opps = opponents(state, p.side);
  const dir = p.side === "home" ? 1 : -1;
  const fwd = FORWARD(p);
  const hasBall = ball.status === "controlled" && ball.owner === p.id;
  const ourGoal = goalCenter(rules, defendingGoalX(rules, p.side));
  const options = hasBall ? evaluateOnBall(state, p) : [];

  switch (intent) {
    case "attack_space": {
      const best = options.filter((o) => o.kind === "carry" && o.command.type === "carry").sort((a, b) => b.score - a.score)[0];
      if (!best || best.command.type !== "carry") return null;
      const end = add(p.pos, scale(best.command.direction, best.command.distance));
      return { command: best.command, feasibility: clamp(spaceAt(end, opps), 0, 1), anchor: end, detail: best.reasons.join("; ") };
    }
    case "draw_defender": {
      // carry at the nearest defender to commit them, short distance
      const nearest = [...opps].filter((o) => o.role !== 1).sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos))[0];
      if (!nearest || !hasBall) return null;
      const d = dist(nearest.pos, p.pos);
      if (d < 2 || d > 14) return null;
      const direction = norm(sub(nearest.pos, p.pos));
      const distance = clamp(d - 2.5, 2, 6);
      const gain = progress(rules, p.side, add(p.pos, scale(direction, distance))) - progress(rules, p.side, p.pos);
      return {
        command: { type: "carry", direction, distance },
        feasibility: clamp(0.5 + gain * 4, 0, 1),
        anchor: add(p.pos, scale(direction, distance)),
        detail: `carry at the defender ${d.toFixed(0)} m away to commit them`,
      };
    }
    case "through_gap": {
      const best = options
        .filter((o) => o.kind === "pass" && o.command.type === "pass" && progress(rules, p.side, o.command.target) > progress(rules, p.side, p.pos) + 0.04)
        .sort((a, b) => b.score - a.score)[0];
      if (!best || best.command.type !== "pass") return null;
      const lane = laneReport(p.pos, best.command.target, speedForDistance(dist(p.pos, best.command.target)), opps);
      const r: Instantiated = {
        command: best.command,
        feasibility: clamp(lane.margin / 0.6, 0, 1),
        anchor: best.command.target,
        detail: best.reasons.join("; "),
      };
      if (best.receiver !== undefined) r.receiver = best.receiver;
      return r;
    }
    case "switch_play": {
      const best = options.filter((o) => o.kind === "switch").sort((a, b) => b.score - a.score)[0];
      if (!best || best.command.type !== "pass") return null;
      const r: Instantiated = {
        command: best.command,
        feasibility: clamp(spaceAt(best.command.target, opps), 0, 1),
        anchor: best.command.target,
        detail: best.reasons.join("; "),
      };
      if (best.receiver !== undefined) r.receiver = best.receiver;
      return r;
    }
    case "recycle": {
      const best = options
        .filter((o) => o.kind === "pass" && o.command.type === "pass" && progress(rules, p.side, o.command.target) <= progress(rules, p.side, p.pos) + 0.04)
        .sort((a, b) => b.score - a.score)[0];
      if (!best || best.command.type !== "pass") return null;
      const r: Instantiated = {
        command: best.command,
        feasibility: clamp(1 - pressureAt(best.command.target, opps), 0, 1),
        anchor: best.command.target,
        detail: `keep the ball: ${best.reasons.join("; ")}`,
      };
      if (best.receiver !== undefined) r.receiver = best.receiver;
      return r;
    }
    case "shoot": {
      const best = options.find((o) => o.kind === "shoot");
      if (!best || best.command.type !== "shoot") return null;
      return { command: best.command, feasibility: clamp(best.score / 2, 0, 1), anchor: best.command.target, detail: best.reasons.join("; ") };
    }
    case "hold_ball": {
      if (!hasBall) return null;
      return { command: { type: "hold" }, feasibility: clamp(1 - pressureAt(p.pos, opps), 0, 1), anchor: null, detail: "shield and wait for support" };
    }
    case "first_touch_forward": {
      if (!(ball.status === "loose" && ball.passTarget === p.id)) return null;
      const end = add(p.pos, scale(fwd, 3));
      return { command: { type: "first_touch", direction: fwd }, feasibility: clamp(spaceAt(end, opps), 0, 1), anchor: end, detail: "take the first touch forward into space" };
    }
    case "first_touch_safe": {
      if (!(ball.status === "loose" && ball.passTarget === p.id)) return null;
      const nearest = [...opps].sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos))[0];
      const away = nearest ? norm(sub(p.pos, nearest.pos)) : scale(fwd, -1);
      const end = add(p.pos, scale(away, 3));
      return { command: { type: "first_touch", direction: away }, feasibility: clamp(1 - pressureAt(end, opps), 0, 1), anchor: end, detail: "touch away from pressure to keep the ball" };
    }
    case "run_behind": {
      const lineX = lastDefenderLine(state, other(p.side));
      const behind = clampField(rules, { x: lineX + dir * 4, y: clamp(p.pos.y + (rules.width / 2 - p.pos.y) * 0.3, 3, rules.width - 3) });
      const onside = dir > 0 ? p.pos.x <= lineX + 0.3 : p.pos.x >= lineX - 0.3;
      if (!onside || Math.abs(attackingGoalX(rules, p.side) - lineX) < 6) return null;
      return { command: { type: "move", target: behind }, feasibility: clamp(spaceAt(behind, opps), 0, 1), anchor: behind, detail: "run beyond the last defender" };
    }
    case "overlap": {
      const carrier = ball.owner && ball.owner !== p.id ? playerById(state, ball.owner) : null;
      if (!carrier || carrier.side !== p.side) return null;
      const wideY = carrier.pos.y < rules.width / 2 ? 2 : rules.width - 2;
      const target = clampField(rules, { x: carrier.pos.x + dir * 8, y: wideY });
      return { command: { type: "move", target }, feasibility: clamp(spaceAt(target, opps), 0, 1), anchor: target, detail: "overlap outside the carrier" };
    }
    case "support_underneath": {
      const carrier = ball.owner && ball.owner !== p.id ? playerById(state, ball.owner) : null;
      if (!carrier || carrier.side !== p.side) return null;
      const target = clampField(rules, add(carrier.pos, { x: -dir * 7, y: (p.pos.y - carrier.pos.y) * 0.5 }));
      return { command: { type: "move", target }, feasibility: clamp(1 - pressureAt(target, opps), 0, 1), anchor: target, detail: "offer a safe angle behind the ball" };
    }
    case "hold_width": {
      const wideY = p.pos.y < rules.width / 2 ? 2.5 : rules.width - 2.5;
      const target = clampField(rules, { x: p.pos.x + dir * 2, y: wideY });
      return { command: { type: "move", target }, feasibility: clamp(spaceAt(target, opps), 0, 1), anchor: target, detail: "stay wide to stretch the defence" };
    }
    case "hold_position": {
      const shape = shapePoint(rules, p, ball.pos, state.possession === p.side);
      return { command: { type: "move", target: shape }, feasibility: 0.6, anchor: null, detail: "keep the team shape" };
    }
    case "press": {
      const carrier = ball.status === "controlled" && ball.owner ? playerById(state, ball.owner) : null;
      if (!carrier || carrier.side === p.side) return null;
      const d = dist(p.pos, carrier.pos);
      if (d > 14) return null;
      const goalSide = norm(sub(ourGoal, carrier.pos));
      const cmd: PlayerCommand = d < 1.6 ? { type: "press", target: carrier.id } : { type: "move", target: add(carrier.pos, scale(goalSide, 0.8)) };
      return { command: cmd, feasibility: clamp(1 - d / 14, 0, 1), anchor: null, detail: `close the carrier down (${d.toFixed(0)} m)` };
    }
    case "delay": {
      const carrier = ball.status === "controlled" && ball.owner ? playerById(state, ball.owner) : null;
      if (!carrier || carrier.side === p.side) return null;
      const goalSide = norm(sub(ourGoal, carrier.pos));
      const target = clampField(rules, add(carrier.pos, scale(goalSide, 3)));
      return { command: { type: "move", target }, feasibility: 0.7, anchor: null, detail: "stay goal-side, slow the carrier, no dive-in" };
    }
    case "drop": {
      const target = clampField(rules, add(p.pos, scale(fwd, -6)));
      return { command: { type: "move", target }, feasibility: 0.6, anchor: null, detail: "drop toward goal to protect the space behind" };
    }
    case "cover": {
      const carrier = ball.status === "controlled" && ball.owner ? playerById(state, ball.owner) : null;
      if (!carrier || carrier.side === p.side) return null;
      const goalSide = norm(sub(ourGoal, carrier.pos));
      const target = clampField(rules, add(carrier.pos, scale(goalSide, 6)));
      return { command: { type: "move", target }, feasibility: 0.7, anchor: null, detail: "cover behind the pressing teammate" };
    }
    case "track_runner": {
      const runners = opps.filter((o) => o.role !== 1 && o.id !== ball.owner && dist(o.pos, p.pos) < 12 && o.vel.x * -dir > 0.5);
      const runner = runners.sort((a, b) => dist(a.pos, p.pos) - dist(b.pos, p.pos))[0];
      if (!runner) return null;
      const goalSide = norm(sub(ourGoal, runner.pos));
      const target = clampField(rules, add(runner.pos, scale(goalSide, 1.5)));
      return { command: { type: "move", target }, feasibility: 0.8, anchor: null, detail: "go with the runner, goal-side" };
    }
    case "screen_lane": {
      const carrier = ball.status === "controlled" && ball.owner ? playerById(state, ball.owner) : null;
      if (!carrier || carrier.side === p.side) return null;
      // most dangerous receiver: opponent ahead of the carrier (toward our goal) with an open lane
      const targets = opps
        .filter((o) => o.id !== carrier.id && o.role !== 1 && (o.pos.x - carrier.pos.x) * -dir > 2)
        .map((o) => ({ o, lane: laneReport(carrier.pos, o.pos, speedForDistance(dist(carrier.pos, o.pos)), teammates(state, p.side)) }))
        .filter((t) => t.lane.margin > 0)
        .sort((a, b) => b.lane.margin - a.lane.margin);
      const t = targets[0];
      if (!t) return null;
      return { command: { type: "screen", from: carrier.id, to: t.o.id }, feasibility: clamp(t.lane.margin, 0, 1), anchor: null, detail: `cut the lane to their ${t.o.name}` };
    }
    case "communicate": {
      return { command: { type: "hold" }, feasibility: 0.5, anchor: null, detail: "hand off responsibility and hold" };
    }
    case "keeper_sweep": {
      if (p.role !== 1 || ball.status !== "loose") return null;
      return { command: { type: "move", target: clampField(rules, ball.pos) }, feasibility: 0.7, anchor: null, detail: "come and claim the ball" };
    }
    case "keeper_hold_line": {
      if (p.role !== 1) return null;
      const shape = shapePoint(rules, p, ball.pos, state.possession === p.side);
      return { command: { type: "move", target: shape }, feasibility: 0.7, anchor: null, detail: "stay set on the line" };
    }
    case "keeper_distribute_short": {
      if (p.role !== 1 || !hasBall) return null;
      const best = options.filter((o) => o.kind === "pass" && o.command.type === "pass" && dist(p.pos, o.command.target) < 22).sort((a, b) => b.score - a.score)[0];
      if (!best || best.command.type !== "pass") return null;
      const r: Instantiated = { command: best.command, feasibility: clamp(1 - pressureAt(best.command.target, opps), 0, 1), anchor: best.command.target, detail: "build from the back" };
      if (best.receiver !== undefined) r.receiver = best.receiver;
      return r;
    }
    case "keeper_distribute_long": {
      if (p.role !== 1 || !hasBall) return null;
      const best = options.filter((o) => o.kind !== "shoot" && o.command.type === "pass" && dist(p.pos, o.command.target) >= 22).sort((a, b) => b.score - a.score)[0];
      if (!best || best.command.type !== "pass") return null;
      const r: Instantiated = { command: best.command, feasibility: clamp(spaceAt(best.command.target, opps), 0, 1), anchor: best.command.target, detail: "go long past the press" };
      if (best.receiver !== undefined) r.receiver = best.receiver;
      return r;
    }
  }
}

/** Direction for a "toward the goal" gesture check; exported for the runtime's preview. */
export function towardGoal(state: MatchState, p: PlayerState): Vec2 {
  return norm(sub(goalCenter(state.rules, attackingGoalX(state.rules, p.side)), p.pos));
}
