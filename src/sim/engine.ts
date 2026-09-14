import { decideOffBall, decideOnBall, lastDefenderLine } from "./ai";
import { BALL_FRICTION, CONTROL_RADIUS, KICK_COOLDOWN_TICKS, firstTouch, kick, saveChance, tackleSuccess } from "./actions";
import { add, clamp, dist, len, norm, scale, sub, type Vec2 } from "./geometry";
import { kickoffPosition, shapePoint } from "./formation";
import { nearest, opponents, other, playerById, pressureAt, teammates, topSpeed } from "./perception";
import { Rng } from "./rng";
import { attackingGoalX, defendingGoalX, goalPosts, type Rules, type Side } from "./rules";
import {
  ROLE_NUMBERS,
  TICK_S,
  type Attributes,
  type MatchEvent,
  type MatchState,
  type Phase,
  type PlayerCommand,
  type PlayerState,
  type RoleNumber,
  type TeamInfo,
} from "./types";

export interface SquadPlayer {
  id: string;
  name: string;
  role: RoleNumber;
  attributes: Attributes;
}

export interface MatchConfig {
  matchId: string;
  seed: number;
  rules: Rules;
  home: TeamInfo & { squad: SquadPlayer[] };
  away: TeamInfo & { squad: SquadPlayer[] };
  /** The user's locked role; omitted for AI-vs-AI. */
  controlled?: { side: Side; playerId: string };
}

const DECISION_INTERVAL_TICKS = 10;
const RESTART_DELAY_TICKS = 40;

export function createMatch(cfg: MatchConfig): MatchState {
  for (const t of [cfg.home, cfg.away]) {
    if (t.squad.length !== cfg.rules.playersPerSide) throw new Error(`${t.side} squad must have ${cfg.rules.playersPerSide} players`);
    const roles = new Set(t.squad.map((p) => p.role));
    for (const r of ROLE_NUMBERS) if (!roles.has(r)) throw new Error(`${t.side} squad missing role ${r}`);
  }
  if (cfg.controlled) {
    const team = cfg.controlled.side === "home" ? cfg.home : cfg.away;
    if (!team.squad.some((p) => p.id === cfg.controlled!.playerId)) throw new Error("controlled player not in squad");
  }
  const players: PlayerState[] = [];
  const kickoffSide: Side = "home";
  for (const team of [cfg.home, cfg.away]) {
    for (const sp of team.squad) {
      const pos = kickoffPosition(cfg.rules, team.side, sp.role, team.side === kickoffSide);
      players.push({
        id: sp.id,
        side: team.side,
        role: sp.role,
        name: sp.name,
        attributes: { ...sp.attributes },
        pos,
        vel: { x: 0, y: 0 },
        fatigue: 0,
        moveTarget: pos,
        touchCooldown: 0,
        stunned: 0,
        commitUntilTick: 0,
      });
    }
  }
  const rng = new Rng(cfg.seed);
  const state: MatchState = {
    matchId: cfg.matchId,
    rules: cfg.rules,
    seed: cfg.seed,
    rngState: rng.snapshot(),
    home: { side: "home", name: cfg.home.name, shortName: cfg.home.shortName },
    away: { side: "away", name: cfg.away.name, shortName: cfg.away.shortName },
    players,
    ball: {
      pos: { x: cfg.rules.length / 2, y: cfg.rules.width / 2 },
      vel: { x: 0, y: 0 },
      status: "dead",
      owner: null,
      lastTouch: null,
      lastTouchSide: null,
      passTarget: null,
      passFrom: null,
    },
    phase: { kind: "kickoff", side: kickoffSide },
    restartTimer: RESTART_DELAY_TICKS,
    possession: null,
    score: { home: 0, away: 0 },
    clock: { tick: 0, timeMs: 0, half: 1, halfTimeS: 0 },
    events: [],
    offsideSnapshot: null,
    controlled: cfg.controlled ?? null,
    commands: {},
    awaiting: null,
    decisionTimers: {},
    eventSeq: 0,
    pendingShot: null,
  };
  return state;
}

type EventBody = MatchEvent extends infer E ? (E extends MatchEvent ? Omit<E, "id" | "tick"> : never) : never;

function emit(state: MatchState, ev: EventBody): MatchEvent {
  const full = { ...ev, id: `${state.matchId}:${state.clock.tick}:${state.eventSeq++}`, tick: state.clock.tick } as MatchEvent;
  state.events.push(full);
  return full;
}

export function isFinished(state: MatchState): boolean {
  return state.phase.kind === "full_time";
}

/** Queue an external command for a player (consumed at their next decision). `accuracy` is the intent precision (0..1). */
export function issueCommand(state: MatchState, playerId: string, cmd: PlayerCommand, accuracy = 1): void {
  state.commands[playerId] = { command: cmd, accuracy: clamp(accuracy, 0, 1) };
  if (state.awaiting === playerId) state.awaiting = null;
}

/** Suspend AI decisions for a player until a command is issued (or `resumeDecisions` is called). */
export function suspendDecisions(state: MatchState, playerId: string): void {
  state.awaiting = playerId;
}

export function resumeDecisions(state: MatchState): void {
  state.awaiting = null;
}

/** Advance the simulation one tick (TICK_MS of simulated time). Mutates and returns state. */
export function tick(state: MatchState): MatchState {
  if (isFinished(state)) return state;
  const rng = new Rng(0);
  rng.restore(state.rngState);

  state.clock.tick++;
  const phase = state.phase;
  if (phase.kind === "half_time") {
    state.restartTimer--;
    if (state.restartTimer <= 0) beginKickoff(state, "away");
    state.rngState = rng.snapshot();
    return state;
  }
  if (phase.kind !== "open_play") {
    stepDeadBall(state, rng);
  } else {
    state.clock.timeMs += TICK_S * 1000;
    state.clock.halfTimeS += TICK_S;
  }

  stepPlayers(state, rng);
  if (state.phase.kind === "open_play") {
    stepBall(state, rng);
    checkOffsideAndBoundaries(state);
  }
  stepClock(state);
  state.rngState = rng.snapshot();
  return state;
}

// ---------------------------------------------------------------- dead balls

function beginKickoff(state: MatchState, side: Side): void {
  state.phase = { kind: "kickoff", side };
  state.restartTimer = RESTART_DELAY_TICKS;
  state.ball.status = "dead";
  state.ball.owner = null;
  state.ball.vel = { x: 0, y: 0 };
  state.ball.pos = { x: state.rules.length / 2, y: state.rules.width / 2 };
  for (const p of state.players) {
    p.pos = kickoffPosition(state.rules, p.side, p.role, p.side === side);
    p.vel = { x: 0, y: 0 };
    p.moveTarget = p.pos;
  }
  state.possession = side;
}

function restartSpot(state: MatchState): Vec2 {
  const ph = state.phase;
  const r = state.rules;
  switch (ph.kind) {
    case "kickoff":
      return { x: r.length / 2, y: r.width / 2 };
    case "goal_kick": {
      const gx = defendingGoalX(r, ph.side);
      const x = gx === 0 ? r.goalAreaDepth : r.length - r.goalAreaDepth;
      return { x, y: r.width / 2 + (ph.side === "home" ? -1 : 1) * r.goalAreaWidth * 0.3 };
    }
    case "corner":
      return { x: ph.at.x < r.length / 2 ? 0.3 : r.length - 0.3, y: ph.at.y < r.width / 2 ? 0.3 : r.width - 0.3 };
    case "throw_in":
      return { x: clamp(ph.at.x, 0.5, r.length - 0.5), y: ph.at.y < r.width / 2 ? 0.2 : r.width - 0.2 };
    case "free_kick":
      return { x: clamp(ph.at.x, 1, r.length - 1), y: clamp(ph.at.y, 1, r.width - 1) };
    default:
      return { x: r.length / 2, y: r.width / 2 };
  }
}

function restartSide(state: MatchState): Side {
  const ph = state.phase;
  return "side" in ph ? ph.side : "home";
}

function chooseTaker(state: MatchState, side: Side, spot: Vec2): PlayerState {
  const ph = state.phase.kind;
  const mates = teammates(state, side);
  if (ph === "goal_kick") return mates.find((p) => p.role === 1) ?? (nearest(mates, spot) as PlayerState);
  if (ph === "kickoff") return mates.find((p) => p.role === 9) ?? (nearest(mates, spot) as PlayerState);
  const outfield = mates.filter((p) => p.role !== 1);
  return nearest(outfield, spot) ?? (mates[0] as PlayerState);
}

function stepDeadBall(state: MatchState, rng: Rng): void {
  const spot = restartSpot(state);
  const side = restartSide(state);
  state.ball.pos = spot;
  state.ball.vel = { x: 0, y: 0 };
  state.ball.status = "dead";
  const taker = chooseTaker(state, side, spot);
  state.restartTimer--;

  // Position players: taker to the ball; opponents retreat to legal distance; teammates to shape
  for (const p of state.players) {
    if (p.id === taker.id) {
      p.moveTarget = spot;
      continue;
    }
    const inPoss = p.side === side;
    let target = shapePoint(state.rules, p, spot, inPoss);
    if (state.phase.kind === "kickoff") target = kickoffPosition(state.rules, p.side, p.role, inPoss);
    if (!inPoss) {
      const d = dist(target, spot);
      const minD = state.phase.kind === "kickoff" ? state.rules.centerCircleRadius : 6;
      if (d < minD) target = add(spot, scale(norm(sub(target, spot)), minD));
      // own half at kickoff
      if (state.phase.kind === "kickoff") {
        const half = state.rules.length / 2;
        target.x = p.side === "home" ? Math.min(target.x, half - 0.5) : Math.max(target.x, half + 0.5);
      }
    }
    p.moveTarget = target;
  }

  if (state.restartTimer <= 0 && dist(taker.pos, spot) < 1.2) {
    // Take it: give the taker the ball and let the AI decide the delivery
    state.ball.status = "controlled";
    state.ball.owner = taker.id;
    state.ball.lastTouch = taker.id;
    state.ball.lastTouchSide = side;
    state.possession = side;
    const kind = state.phase.kind;
    emit(state, { type: "restart", restart: kind, side, taker: taker.id });
    if (kind === "kickoff") emit(state, { type: "kickoff", side });
    state.phase = { kind: "open_play" };
    state.decisionTimers[taker.id] = DECISION_INTERVAL_TICKS; // decide immediately
    for (const p of state.players) p.vel = { x: 0, y: 0 };
    rng.next();
  } else if (state.restartTimer <= 0) {
    // taker still jogging over; snap if far (keeps dead-ball phases bounded)
    if (dist(taker.pos, spot) > 8) taker.pos = add(spot, { x: 0.8, y: 0 });
  }
}

// ---------------------------------------------------------------- players

function stepPlayers(state: MatchState, rng: Rng): void {
  const ball = state.ball;
  for (const p of state.players) {
    if (p.touchCooldown > 0) p.touchCooldown--;
    if (p.stunned > 0) p.stunned--;
    const timer = (state.decisionTimers[p.id] ?? DECISION_INTERVAL_TICKS) + 1;
    state.decisionTimers[p.id] = timer;
    const external = state.commands[p.id];
    const onBall = ball.status === "controlled" && ball.owner === p.id && state.phase.kind === "open_play";

    const suspended = state.awaiting === p.id;
    if (onBall) {
      if (external) {
        delete state.commands[p.id];
        state.decisionTimers[p.id] = 0;
        executeOnBall(state, p, external.command, rng, external.accuracy);
      } else if (suspended) {
        // keep carrying toward the current target while the decision is pending
      } else if (timer >= DECISION_INTERVAL_TICKS) {
        const committed = state.clock.tick < p.commitUntilTick;
        const pressed = committed && pressureAt(p.pos, opponents(state, p.side)) > 0.9;
        if (!committed || pressed) {
          state.decisionTimers[p.id] = 0;
          executeOnBall(state, p, decideOnBall(state, p, rng), rng, 1);
        }
      }
    } else if (state.phase.kind === "open_play" && p.stunned === 0) {
      const cmd = external?.command;
      if (cmd && (cmd.type === "move" || cmd.type === "press" || cmd.type === "screen" || cmd.type === "hold")) {
        delete state.commands[p.id];
        applyOffBall(state, p, cmd, rng);
      } else if (!suspended && timer >= 3) {
        state.decisionTimers[p.id] = 0;
        applyOffBall(state, p, decideOffBall(state, p), rng);
      }
    }
    movePlayer(state, p);
  }
}

function applyOffBall(state: MatchState, p: PlayerState, cmd: PlayerCommand, rng: Rng): void {
  switch (cmd.type) {
    case "move":
      p.moveTarget = cmd.target;
      break;
    case "hold":
      p.moveTarget = p.pos;
      break;
    case "press": {
      const target = state.players.find((q) => q.id === cmd.target);
      if (!target) break;
      p.moveTarget = target.pos;
      if (state.ball.owner === target.id && dist(p.pos, target.pos) < 1.3 && p.touchCooldown === 0 && rng.next() < 0.04 + 0.04 * (p.attributes.tackling / 100)) {
        const won = tackleSuccess(p, target, rng);
        emit(state, { type: "tackle", player: p.id, victim: target.id, won });
        p.touchCooldown = 60;
        if (won) {
          looseBall(state, add(p.pos, scale(norm(sub(p.pos, target.pos)), 1.2)), scale(norm(sub(p.pos, target.pos)), 3), p);
          target.stunned = 8;
          changePossession(state, p.side, "tackle");
        } else {
          p.stunned = 14;
          p.touchCooldown = 60;
        }
      }
      break;
    }
    case "screen": {
      const from = state.players.find((q) => q.id === cmd.from);
      const to = state.players.find((q) => q.id === cmd.to);
      if (from && to) p.moveTarget = add(from.pos, scale(sub(to.pos, from.pos), 0.4));
      break;
    }
    default:
      break;
  }
}

function movePlayer(state: MatchState, p: PlayerState): void {
  const r = state.rules;
  const carrying = state.ball.status === "controlled" && state.ball.owner === p.id;
  const toTarget = sub(p.moveTarget, p.pos);
  const d = len(toTarget);
  let desiredSpeed = d < 0.25 ? 0 : Math.min(topSpeed(p), d / TICK_S);
  if (carrying) desiredSpeed *= 0.72 + 0.2 * (p.attributes.dribbling / 100);
  if (p.stunned > 0) desiredSpeed *= 0.2;
  const desiredVel = scale(norm(toTarget), desiredSpeed);
  const accel = (3 + (p.attributes.acceleration / 100) * 3) * (1 - 0.25 * p.fatigue);
  const dv = sub(desiredVel, p.vel);
  const maxDv = accel * TICK_S * 2; // braking is easier than accelerating
  p.vel = add(p.vel, len(dv) > maxDv ? scale(norm(dv), maxDv) : dv);
  const speed = len(p.vel);
  if (speed > topSpeed(p)) p.vel = scale(p.vel, topSpeed(p) / speed);
  p.pos = add(p.pos, scale(p.vel, TICK_S));
  p.pos = { x: clamp(p.pos.x, -1, r.length + 1), y: clamp(p.pos.y, -1, r.width + 1) };
  // fatigue: builds with speed, recovers slowly when slow (stamina moderates both)
  const stamina = p.attributes.stamina / 100;
  const effort = (speed / 6.8) ** 2;
  p.fatigue = clamp(p.fatigue + TICK_S * (effort * 0.0032 * (1.5 - stamina) - 0.0009 * (0.5 + stamina)), 0, 1);
}

// ---------------------------------------------------------------- on-ball execution

function executeOnBall(state: MatchState, p: PlayerState, cmd: PlayerCommand, rng: Rng, intentAccuracy: number): void {
  const ball = state.ball;
  switch (cmd.type) {
    case "pass": {
      const k = kick(state, p, cmd.target, "pass", rng, intentAccuracy);
      const receiver = cmd.receiver ?? null;
      releaseBall(state, p, k.velocity);
      ball.passTarget = receiver;
      ball.passFrom = p.id;
      snapshotOffside(state, p.side);
      emit(state, { type: "pass", from: p.id, to: receiver, target: cmd.target, side: p.side, error: k.error });
      break;
    }
    case "shoot": {
      const k = kick(state, p, cmd.target, "shot", rng, intentAccuracy);
      releaseBall(state, p, k.velocity);
      ball.passTarget = null;
      ball.passFrom = p.id;
      const onTarget = shotOnTarget(state, p.side, p.pos, k.velocity);
      emit(state, { type: "shot", player: p.id, target: cmd.target, onTarget, side: p.side, error: k.error });
      state.pendingShot = { shooter: p.id, side: p.side, onTarget };
      break;
    }
    case "carry": {
      const from = { ...p.pos };
      const target = add(p.pos, scale(norm(cmd.direction), cmd.distance));
      p.moveTarget = { x: clamp(target.x, 0.3, state.rules.length - 0.3), y: clamp(target.y, 0.3, state.rules.width - 0.3) };
      const carrySpeed = topSpeed(p) * 0.8;
      p.commitUntilTick = state.clock.tick + Math.ceil(cmd.distance / carrySpeed / TICK_S);
      emit(state, { type: "carry", player: p.id, from, to: p.moveTarget });
      break;
    }
    case "hold":
      p.moveTarget = p.pos;
      p.commitUntilTick = state.clock.tick + 10;
      break;
    case "first_touch":
    case "move":
      p.moveTarget = cmd.type === "move" ? cmd.target : add(p.pos, scale(norm(cmd.direction), 2));
      break;
    default:
      break;
  }
}

function releaseBall(state: MatchState, p: PlayerState, velocity: Vec2): void {
  const ball = state.ball;
  ball.status = "loose";
  ball.owner = null;
  ball.vel = velocity;
  ball.pos = add(p.pos, scale(norm(velocity), 0.5));
  ball.lastTouch = p.id;
  ball.lastTouchSide = p.side;
  p.touchCooldown = KICK_COOLDOWN_TICKS;
  // Opponents standing next to the kicker only get the ball if they are in the kick's path (a block);
  // otherwise the ball is past them before they can react.
  const dir = norm(velocity);
  for (const o of state.players) {
    if (o.side === p.side || o.touchCooldown > 0) continue;
    const rel = sub(o.pos, p.pos);
    const d = len(rel);
    if (d > 2.2) continue;
    const cos = d > 1e-6 ? (rel.x * dir.x + rel.y * dir.y) / d : 1;
    if (cos < 0.85) o.touchCooldown = 6;
  }
}

function looseBall(state: MatchState, pos: Vec2, vel: Vec2, toucher: PlayerState | null): void {
  const ball = state.ball;
  ball.status = "loose";
  ball.owner = null;
  ball.pos = pos;
  ball.vel = vel;
  ball.passTarget = null;
  ball.passFrom = null;
  if (toucher) {
    ball.lastTouch = toucher.id;
    ball.lastTouchSide = toucher.side;
    toucher.touchCooldown = 4;
  }
}

function changePossession(state: MatchState, to: Side, reason: string): void {
  if (state.possession !== to) {
    state.possession = to;
    emit(state, { type: "possession_change", to, reason });
  }
}

function shotOnTarget(state: MatchState, side: Side, from: Vec2, vel: Vec2): boolean {
  const gx = attackingGoalX(state.rules, side);
  if (Math.abs(vel.x) < 1e-6) return false;
  const t = (gx - from.x) / vel.x;
  if (t <= 0) return false;
  const y = from.y + vel.y * t;
  const [a, b] = goalPosts(state.rules, gx);
  return y > a.y && y < b.y;
}

// ---------------------------------------------------------------- ball

function stepBall(state: MatchState, rng: Rng): void {
  const ball = state.ball;
  if (ball.status === "controlled" && ball.owner) {
    const owner = playerById(state, ball.owner);
    const facing = len(owner.vel) > 0.3 ? norm(owner.vel) : norm(sub(owner.moveTarget, owner.pos));
    ball.pos = add(owner.pos, scale(facing, 0.45));
    ball.vel = owner.vel;
    return;
  }
  if (ball.status !== "loose") return;

  // integrate with rolling friction
  const speed = len(ball.vel);
  if (speed > 0) {
    const newSpeed = Math.max(0, speed - BALL_FRICTION * TICK_S);
    ball.vel = scale(ball.vel, newSpeed / speed);
  }
  const prev = ball.pos;
  ball.pos = add(ball.pos, scale(ball.vel, TICK_S));

  // goal check (crossing the line between the posts)
  for (const side of ["home", "away"] as const) {
    const gx = attackingGoalX(state.rules, side);
    const crossed = side === "home" ? prev.x <= gx && ball.pos.x > gx : prev.x >= gx && ball.pos.x < gx;
    if (crossed) {
      const [a, b] = goalPosts(state.rules, gx);
      const t = (gx - prev.x) / (ball.pos.x - prev.x);
      const y = prev.y + (ball.pos.y - prev.y) * t;
      if (y > a.y && y < b.y && ball.lastTouchSide) {
        scoreGoal(state, side);
        return;
      }
    }
  }

  // receipt / interception: earliest player within reach
  const candidates = state.players.filter(
    (p) => p.touchCooldown === 0 && p.stunned === 0 && dist(p.pos, ball.pos) <= CONTROL_RADIUS + len(ball.vel) * TICK_S * 0.5,
  );
  const receiver = nearest(candidates, ball.pos);
  if (!receiver) return;

  // goalkeeper save resolution
  if (state.pendingShot && receiver.role === 1 && receiver.side !== state.pendingShot.side) {
    const shooter = playerById(state, state.pendingShot.shooter);
    const dOff = dist(receiver.pos, ball.pos);
    const chance = saveChance(receiver, speed, dist(shooter.pos, ball.pos), dOff);
    const saved = rng.next() < chance;
    if (saved) {
      emit(state, { type: "save", keeper: receiver.id, shooter: shooter.id });
      if (rng.next() < 0.65) {
        controlBall(state, receiver, true);
      } else {
        looseBall(state, ball.pos, scale({ x: receiver.side === "home" ? 1 : -1, y: rng.gaussian() }, 6), receiver);
      }
      changePossession(state, receiver.side, "save");
      state.pendingShot = null;
      return;
    }
    // failed save: ball continues past the keeper
    receiver.touchCooldown = 8;
    state.pendingShot = null;
    return;
  }

  const passer = ball.passFrom ? playerById(state, ball.passFrom) : null;
  const isInterception = ball.lastTouchSide !== null && receiver.side !== ball.lastTouchSide;
  const cmd = state.commands[receiver.id]?.command;
  const touchDir = cmd && cmd.type === "first_touch" ? cmd.direction : receiver.moveTarget ? sub(receiver.moveTarget, receiver.pos) : null;
  if (cmd && cmd.type === "first_touch") delete state.commands[receiver.id];

  // offside on receipt
  if (!isInterception && state.offsideSnapshot && state.offsideSnapshot.side === receiver.side && state.offsideSnapshot.offsidePlayers.includes(receiver.id)) {
    emit(state, { type: "offside", player: receiver.id, side: receiver.side });
    state.offsideSnapshot = null;
    state.phase = { kind: "free_kick", side: other(receiver.side), at: { ...receiver.pos }, reason: "offside" };
    state.restartTimer = RESTART_DELAY_TICKS;
    ball.status = "dead";
    ball.owner = null;
    ball.vel = { x: 0, y: 0 };
    changePossession(state, other(receiver.side), "offside");
    return;
  }

  const touch = firstTouch(state, receiver, speed, touchDir && len(touchDir) > 0.1 ? touchDir : null, rng);
  if (isInterception && passer) {
    emit(state, { type: "interception", player: receiver.id, from: passer.id });
    changePossession(state, receiver.side, "interception");
  } else if (isInterception) {
    emit(state, { type: "recovery", player: receiver.id });
    changePossession(state, receiver.side, "recovery");
  } else {
    emit(state, { type: "receive", player: receiver.id, from: passer ? passer.id : null, clean: touch.clean });
  }
  state.pendingShot = null;
  state.offsideSnapshot = null;
  if (touch.clean) {
    controlBall(state, receiver, false);
  } else {
    looseBall(state, add(receiver.pos, touch.offset), scale(norm(touch.offset), 2.5), receiver);
  }
}

function controlBall(state: MatchState, p: PlayerState, _keeperCatch: boolean): void {
  const ball = state.ball;
  ball.status = "controlled";
  ball.owner = p.id;
  ball.vel = p.vel;
  ball.pos = add(p.pos, scale(norm(sub(ball.pos, p.pos)), 0.45));
  ball.lastTouch = p.id;
  ball.lastTouchSide = p.side;
  ball.passTarget = null;
  ball.passFrom = null;
  state.decisionTimers[p.id] = 0;
  p.commitUntilTick = state.clock.tick + 24;
  changePossession(state, p.side, "control");
}

function scoreGoal(state: MatchState, side: Side): void {
  const scorerId = state.ball.lastTouch;
  const scorer = scorerId ? playerById(state, scorerId) : null;
  state.score[side]++;
  const assist = state.pendingShot && scorer && scorer.side === side ? lastPassFrom(state, scorer.id) : null;
  emit(state, { type: "goal", scorer: scorer ? scorer.id : "unknown", side, assist });
  state.pendingShot = null;
  beginKickoff(state, other(side));
}

function lastPassFrom(state: MatchState, scorerId: string): string | null {
  for (let i = state.events.length - 1; i >= 0 && i > state.events.length - 40; i--) {
    const e = state.events[i];
    if (!e) continue;
    if (e.type === "receive" && e.player === scorerId) return e.from;
    if (e.type === "possession_change") return null;
  }
  return null;
}

function snapshotOffside(state: MatchState, side: Side): void {
  if (!state.rules.offside) {
    state.offsideSnapshot = null;
    return;
  }
  const line = lastDefenderLine(state, other(side));
  const ballX = state.ball.pos.x;
  const half = state.rules.length / 2;
  const offsidePlayers = teammates(state, side)
    .filter((p) => {
      if (state.ball.lastTouch === p.id) return false;
      const inOppHalf = side === "home" ? p.pos.x > half : p.pos.x < half;
      const beyondBall = side === "home" ? p.pos.x > ballX : p.pos.x < ballX;
      const beyondLine = side === "home" ? p.pos.x > line + 0.05 : p.pos.x < line - 0.05;
      return inOppHalf && beyondBall && beyondLine;
    })
    .map((p) => p.id);
  state.offsideSnapshot = { side, offsidePlayers };
}

// ---------------------------------------------------------------- boundaries & clock

function checkOffsideAndBoundaries(state: MatchState): void {
  if (state.phase.kind !== "open_play") return;
  const ball = state.ball;
  const r = state.rules;
  const p = ball.pos;
  const lastSide = ball.lastTouchSide ?? "home";
  const restartFor = other(lastSide);
  let phase: Phase | null = null;
  if (p.y < 0 || p.y > r.width) {
    phase = { kind: "throw_in", side: restartFor, at: { x: clamp(p.x, 0, r.length), y: p.y < 0 ? 0 : r.width } };
  } else if (p.x < 0 || p.x > r.length) {
    const goalLineX = p.x < 0 ? 0 : r.length;
    const defender: Side = goalLineX === 0 ? "home" : "away";
    if (lastSide === defender) phase = { kind: "corner", side: other(defender), at: { x: goalLineX, y: p.y } };
    else phase = { kind: "goal_kick", side: defender };
  }
  if (phase) {
    emit(state, { type: "out_of_play", restart: phase.kind, side: restartFor });
    state.phase = phase;
    state.restartTimer = RESTART_DELAY_TICKS;
    ball.status = "dead";
    ball.owner = null;
    ball.vel = { x: 0, y: 0 };
    ball.pos = { x: clamp(p.x, 0, r.length), y: clamp(p.y, 0, r.width) };
    state.pendingShot = null;
    changePossession(state, "side" in phase ? phase.side : restartFor, phase.kind);
  }
}

function stepClock(state: MatchState): void {
  const r = state.rules;
  if (state.phase.kind === "full_time" || state.phase.kind === "half_time") return;
  if (state.clock.halfTimeS >= r.halfLengthSeconds && state.phase.kind === "open_play") {
    if (state.clock.half >= r.halves) {
      state.phase = { kind: "full_time" };
      state.ball.status = "dead";
      emit(state, { type: "full_time", home: state.score.home, away: state.score.away });
    } else {
      state.clock.half++;
      state.clock.halfTimeS = 0;
      state.phase = { kind: "half_time" };
      state.restartTimer = RESTART_DELAY_TICKS;
      state.ball.status = "dead";
      state.ball.owner = null;
      emit(state, { type: "half_time" });
    }
  }
}

// ---------------------------------------------------------------- helpers for callers

export interface MatchReport {
  matchId: string;
  seed: number;
  rulesId: string;
  score: { home: number; away: number };
  events: MatchEvent[];
  ticks: number;
}

export function report(state: MatchState): MatchReport {
  return {
    matchId: state.matchId,
    seed: state.seed,
    rulesId: state.rules.id,
    score: { ...state.score },
    events: [...state.events],
    ticks: state.clock.tick,
  };
}

/** Run a whole match with AI on both sides. Optional per-tick observer. */
export function runHeadless(cfg: MatchConfig, observer?: (s: MatchState) => void, maxTicks = 200_000): MatchState {
  const state = createMatch(cfg);
  while (!isFinished(state) && state.clock.tick < maxTicks) {
    tick(state);
    observer?.(state);
  }
  return state;
}

