import { gestureAccuracy, readGesture, tapAccuracy, type GestureRead } from "../gesture/gesture";
import { DRILL_SLOW_SCALE } from "../match/clock";
import { add, angleBetween, clamp, dist, dot, norm, rotate, scale, sub, type Vec2 } from "../sim/geometry";
import { Rng } from "../sim/rng";

/**
 * "Receive and go" — the introductory activity (spec §4 step 7, §8). A server plays the ball in,
 * one defender closes from a direction the user must read, and the first touch has to take the
 * ball through the gate that is away from the pressure. Same three layers as a match moment:
 * the gate chosen is the decision, the drawing is the execution, and whether the ball gets
 * through is the outcome — graded separately (spec §13). Deterministic for a seed.
 *
 * Small-sided activities (1v1, 2v2, 3v2) are separate implementations; this is the simplest
 * receive-under-pressure picture and is not a stand-in for them. Balance values are proposals
 * (OPEN_QUESTIONS #23).
 */

export const AREA = { length: 24, width: 18 } as const;
export const RECEIVE_POINT: Vec2 = { x: 10, y: 9 };
export const SERVER_POINT: Vec2 = { x: 3, y: 9 };
export const TICK_MS = 50;
export const WINDOW_MS = 2500;
export const ACCESSIBLE_WINDOW_FACTOR = 1.5;
const SERVE_SPEED = 8;
const TOUCH_SPEED = 5;
const DEFENDER_SPEED = 5;
const DEFENDER_START_DIST = 8;
/** The defender waits until the pass is on its way before closing. */
const DEFENDER_CLOSES_AT_M = 5;
const WINDOW_OPENS_AT_M = 3.5;
const INTERCEPT_RADIUS = 1.2;
const GATE_WIDTH = 4;
const BETWEEN_MS = 1200;
const MAX_TOUCH_TRAVEL = 14;
/** Directional error of a first touch drawn with zero precision. */
const MAX_TOUCH_ERROR_RAD = Math.PI / 9;
const TECHNIQUE_NOISE_RAD = Math.PI / 45;
/** Drawn direction must be within this angle of a gate to mean it. */
const GATE_INTENT_RAD = Math.PI / 3.6;

export type GateId = "left" | "forward" | "right";

export interface Gate {
  id: GateId;
  center: Vec2;
  a: Vec2;
  b: Vec2;
}

const gate = (id: GateId, center: Vec2): Gate => {
  const dir = norm(sub(center, RECEIVE_POINT));
  const across = scale(rotate(dir, Math.PI / 2), GATE_WIDTH / 2);
  return { id, center, a: sub(center, across), b: add(center, across) };
};

export const GATES: readonly Gate[] = [gate("left", { x: 17, y: 3.5 }), gate("forward", { x: 21, y: 9 }), gate("right", { x: 17, y: 14.5 })];

/** Where the defender starts, as an angle around the receive point (0 = from the server's side; ±90 = from the side). */
const APPROACHES: readonly number[] = [60, -60, 90, -90, 120, -120].map((deg) => (deg * Math.PI) / 180);

export type DecisionBand = "strong" | "acceptable" | "weak" | "timeout";
export type ExecutionBand = "clean" | "ok" | "loose";
export type Outcome = "through" | "wide" | "intercepted";

export interface RepRecord {
  index: number;
  defenderFrom: Vec2;
  bestGate: GateId;
  chosenGate: GateId | null;
  decision: DecisionBand;
  accuracy: number;
  execution: ExecutionBand | null;
  outcome: Outcome | null;
}

export type Phase = "serve" | "window" | "resolve" | "between" | "done";

export interface DrillState {
  seed: number;
  rngState: number;
  reps: number;
  index: number;
  phase: Phase;
  /** Simulated ms since the drill began. */
  timeMs: number;
  /** Real ms the current window has been open. */
  windowMs: number;
  accessible: boolean;
  ball: { pos: Vec2; vel: Vec2 };
  player: Vec2;
  defender: { pos: Vec2; start: Vec2 };
  records: RepRecord[];
  events: DrillEvent[];
  acc: number;
}

export type DrillEvent =
  | { type: "window_open"; rep: number }
  | { type: "committed"; rep: number; gate: GateId; decision: DecisionBand; accuracy: number }
  | { type: "timeout"; rep: number }
  | { type: "outcome"; rep: number; outcome: Outcome }
  | { type: "done" };

export function createDrill(seed: number, reps = 6, accessible = false): DrillState {
  const rng = new Rng(seed);
  const d: DrillState = {
    seed,
    rngState: rng.snapshot(),
    reps,
    index: -1,
    phase: "between",
    timeMs: 0,
    windowMs: 0,
    accessible,
    ball: { pos: { ...SERVER_POINT }, vel: { x: 0, y: 0 } },
    player: { ...RECEIVE_POINT },
    defender: { pos: { ...RECEIVE_POINT }, start: { ...RECEIVE_POINT } },
    records: [],
    events: [],
    acc: 0,
  };
  startRep(d, rng);
  d.rngState = rng.snapshot();
  return d;
}

function startRep(d: DrillState, rng: Rng): void {
  d.index++;
  if (d.index >= d.reps) {
    d.phase = "done";
    d.events.push({ type: "done" });
    return;
  }
  const angle = APPROACHES[rng.int(0, APPROACHES.length)]!;
  const from = add(RECEIVE_POINT, scale(rotate({ x: -1, y: 0 }, angle), DEFENDER_START_DIST));
  d.defender = { pos: { ...from }, start: { ...from } };
  d.player = { ...RECEIVE_POINT };
  d.ball = { pos: { ...SERVER_POINT }, vel: scale(norm(sub(RECEIVE_POINT, SERVER_POINT)), SERVE_SPEED) };
  d.phase = "serve";
  d.windowMs = 0;
  d.records.push({ index: d.index, defenderFrom: from, bestGate: bestGate(from), chosenGate: null, decision: "timeout", accuracy: 0, execution: null, outcome: null });
}

/** Openness of each gate against pressure arriving from `from`: 1 = directly away, −1 = straight into it. */
export function openness(from: Vec2): Record<GateId, number> {
  const pressure = norm(sub(from, RECEIVE_POINT));
  const out = {} as Record<GateId, number>;
  for (const g of GATES) out[g.id] = -dot(norm(sub(g.center, RECEIVE_POINT)), pressure);
  return out;
}

export function bestGate(from: Vec2): GateId {
  const o = openness(from);
  return GATES.map((g) => g.id).sort((a, b) => o[b] - o[a])[0]!;
}

/** Decision band for a gate: ranked by openness; near-ties with the best also count as strong. */
export function gradeGate(from: Vec2, chosen: GateId): Exclude<DecisionBand, "timeout"> {
  const o = openness(from);
  const ranked = GATES.map((g) => g.id).sort((a, b) => o[b] - o[a]);
  if (chosen === ranked[0] || o[ranked[0]!] - o[chosen] < 0.15) return "strong";
  return chosen === ranked[1] ? "acceptable" : "weak";
}

export const executionBand = (accuracy: number): ExecutionBand => (accuracy >= 0.75 ? "clean" : accuracy >= 0.45 ? "ok" : "loose");

export const windowLimitMs = (d: DrillState): number => WINDOW_MS * (d.accessible ? ACCESSIBLE_WINDOW_FACTOR : 1);
export const windowProgress = (d: DrillState): number => (d.phase === "window" ? clamp(d.windowMs / windowLimitMs(d), 0, 1) : 0);
export const timeScale = (d: DrillState): number => (d.phase === "window" ? DRILL_SLOW_SCALE : 1);
export const current = (d: DrillState): RepRecord | undefined => d.records[d.index];

/** Advance by real elapsed time; simulated time runs slower during the window. Returns events emitted. */
export function step(d: DrillState, realDtMs: number): DrillEvent[] {
  d.events = [];
  if (d.phase === "done") return d.events;
  if (d.phase === "window") {
    d.windowMs += realDtMs;
    if (d.windowMs >= windowLimitMs(d)) timeoutRep(d);
  }
  d.acc += realDtMs * timeScale(d);
  while (d.acc >= TICK_MS && (d.phase as Phase) !== "done") {
    d.acc -= TICK_MS;
    tick(d);
  }
  return d.events;
}

function tick(d: DrillState): void {
  const dt = TICK_MS / 1000;
  d.timeMs += TICK_MS;
  const rng = new Rng(0);
  rng.restore(d.rngState);
  switch (d.phase) {
    case "serve":
    case "window": {
      d.ball.pos = add(d.ball.pos, scale(d.ball.vel, dt));
      if (d.phase === "serve" && dist(d.ball.pos, RECEIVE_POINT) <= WINDOW_OPENS_AT_M) {
        d.phase = "window";
        d.windowMs = 0;
        d.events.push({ type: "window_open", rep: d.index });
      }
      if (dist(d.ball.pos, RECEIVE_POINT) <= DEFENDER_CLOSES_AT_M) moveDefender(d, dt);
      if (dist(d.ball.pos, RECEIVE_POINT) < 0.15 || dot(d.ball.vel, sub(RECEIVE_POINT, d.ball.pos)) < 0) {
        d.ball.pos = { ...RECEIVE_POINT };
        if (d.phase === "window") timeoutRep(d);
        else resolveTouch(d, rng, "forward", 0.4);
      }
      break;
    }
    case "resolve": {
      const prev = d.ball.pos;
      d.ball.pos = add(d.ball.pos, scale(d.ball.vel, dt));
      d.player = add(d.player, scale(norm(sub(d.ball.pos, d.player)), Math.min(3.5 * dt, dist(d.ball.pos, d.player))));
      moveDefender(d, dt);
      const rec = current(d)!;
      const target = GATES.find((g) => g.id === rec.chosenGate) ?? GATES[1]!;
      if (dist(d.defender.pos, d.ball.pos) <= INTERCEPT_RADIUS) finishRep(d, "intercepted");
      else if (crosses(prev, d.ball.pos, target.a, target.b)) finishRep(d, "through");
      else if (dist(d.ball.pos, RECEIVE_POINT) > MAX_TOUCH_TRAVEL || passedGateLine(d.ball.pos, target)) finishRep(d, "wide");
      break;
    }
    case "between": {
      d.windowMs += TICK_MS;
      if (d.windowMs >= BETWEEN_MS) startRep(d, rng);
      break;
    }
    case "done":
      break;
  }
  d.rngState = rng.snapshot();
}

/** The defender runs an intercept line: toward where the ball will be, not where it is. */
function moveDefender(d: DrillState, dt: number): void {
  const l = dist(d.ball.pos, d.defender.pos);
  if (l < 0.05) return;
  const lead = clamp(l / DEFENDER_SPEED, 0, 1.2);
  const aim = add(d.ball.pos, scale(d.ball.vel, lead));
  const to = sub(aim, d.defender.pos);
  d.defender.pos = add(d.defender.pos, scale(norm(to), Math.min(DEFENDER_SPEED * dt, dist(aim, d.defender.pos))));
}

function timeoutRep(d: DrillState): void {
  const rec = current(d)!;
  rec.decision = "timeout";
  d.events.push({ type: "timeout", rep: d.index });
  const rng = new Rng(0);
  rng.restore(d.rngState);
  resolveTouch(d, rng, "forward", 0.4);
  d.rngState = rng.snapshot();
}

/** The first touch itself: direction toward the gate, bent by imprecision and a little technique noise. */
function resolveTouch(d: DrillState, rng: Rng, gateId: GateId, accuracy: number): void {
  const rec = current(d)!;
  const g = GATES.find((x) => x.id === gateId)!;
  const err = (1 - accuracy) * MAX_TOUCH_ERROR_RAD * (rng.chance(0.5) ? 1 : -1) + rng.gaussian() * TECHNIQUE_NOISE_RAD;
  d.ball.pos = { ...RECEIVE_POINT };
  d.ball.vel = scale(rotate(norm(sub(g.center, RECEIVE_POINT)), err), TOUCH_SPEED);
  rec.chosenGate = gateId;
  rec.accuracy = accuracy;
  rec.execution = rec.decision === "timeout" ? "loose" : executionBand(accuracy);
  d.phase = "resolve";
}

function finishRep(d: DrillState, outcome: Outcome): void {
  const rec = current(d)!;
  rec.outcome = outcome;
  d.events.push({ type: "outcome", rep: d.index, outcome });
  d.phase = "between";
  d.windowMs = 0;
}

/** Commit a gate during the window with an execution precision (0..1). */
export function commitGate(d: DrillState, gateId: GateId, accuracy: number): RepRecord | null {
  if (d.phase !== "window") return null;
  const rec = current(d)!;
  rec.decision = gradeGate(d.defender.start, gateId);
  const a = clamp(accuracy, 0, 1);
  d.events.push({ type: "committed", rep: d.index, gate: gateId, decision: rec.decision, accuracy: a });
  const rng = new Rng(0);
  rng.restore(d.rngState);
  resolveTouch(d, rng, gateId, a);
  d.rngState = rng.snapshot();
  return rec;
}

export interface DrawRead {
  gate: GateId | null;
  accuracy: number;
  gesture: GestureRead | null;
}

/** Read a drawn path (field metres) as intent + precision. Null gate: the drawing points at no gate. */
export function readDraw(points: readonly Vec2[]): DrawRead {
  const g = readGesture(points);
  if (!g) return { gate: null, accuracy: 0, gesture: null };
  let best: Gate | null = null;
  let bestAngle = GATE_INTENT_RAD;
  for (const gt of GATES) {
    const a = angleBetween(g.direction, norm(sub(gt.center, RECEIVE_POINT)));
    if (a < bestAngle) {
      bestAngle = a;
      best = gt;
    }
  }
  if (!best) return { gate: null, accuracy: 0, gesture: g };
  return { gate: best.id, accuracy: gestureAccuracy(g, RECEIVE_POINT, best.center), gesture: g };
}

/** Accessible alternative: tap a gate. */
export function readTap(point: Vec2): DrawRead {
  let best: Gate | null = null;
  let bestD = 5;
  for (const gt of GATES) {
    const dd = dist(point, gt.center);
    if (dd < bestD) {
      bestD = dd;
      best = gt;
    }
  }
  if (!best) return { gate: null, accuracy: 0, gesture: null };
  return { gate: best.id, accuracy: tapAccuracy(point, RECEIVE_POINT, best.center), gesture: null };
}

/** Run to completion with a policy, for tests and calibration. */
export function runHeadless(d: DrillState, policy: (d: DrillState, rec: RepRecord) => { gate: GateId; accuracy: number } | null, maxSteps = 20_000): DrillState {
  for (let i = 0; i < maxSteps && d.phase !== "done"; i++) {
    const evs = step(d, 100);
    if (evs.some((e) => e.type === "window_open")) {
      const choice = policy(d, current(d)!);
      if (choice) commitGate(d, choice.gate, choice.accuracy);
    }
  }
  return d;
}

export type ReadsBand = "sharp" | "mixed" | "rushed";
export type TouchBand = "clean" | "ok" | "loose";

export interface DrillSummary {
  activityId: "first_touch";
  reps: number;
  decisions: Record<DecisionBand, number>;
  executions: Record<ExecutionBand, number>;
  outcomes: Record<Outcome, number>;
  meanAccuracy: number;
  reads: ReadsBand;
  touch: TouchBand;
}

export function summarize(d: DrillState): DrillSummary {
  const decisions: Record<DecisionBand, number> = { strong: 0, acceptable: 0, weak: 0, timeout: 0 };
  const executions: Record<ExecutionBand, number> = { clean: 0, ok: 0, loose: 0 };
  const outcomes: Record<Outcome, number> = { through: 0, wide: 0, intercepted: 0 };
  let acc = 0;
  let n = 0;
  for (const r of d.records) {
    if (r.outcome === null) continue;
    n++;
    decisions[r.decision]++;
    if (r.execution) executions[r.execution]++;
    outcomes[r.outcome]++;
    acc += r.accuracy;
  }
  const total = Math.max(1, n);
  const strongShare = decisions.strong / total;
  const readShare = (decisions.strong + decisions.acceptable) / total;
  const reads: ReadsBand = strongShare >= 0.66 && decisions.timeout === 0 ? "sharp" : readShare >= 0.5 ? "mixed" : "rushed";
  const meanAccuracy = n ? acc / n : 0;
  const touch: TouchBand = meanAccuracy >= 0.7 ? "clean" : meanAccuracy >= 0.45 ? "ok" : "loose";
  return { activityId: "first_touch", reps: n, decisions, executions, outcomes, meanAccuracy, reads, touch };
}

function crosses(p0: Vec2, p1: Vec2, a: Vec2, b: Vec2): boolean {
  const d1 = side(a, b, p0);
  const d2 = side(a, b, p1);
  const d3 = side(p0, p1, a);
  const d4 = side(p0, p1, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

const side = (a: Vec2, b: Vec2, p: Vec2): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

/** Ball has gone past the plane of the gate (measured along the gate's approach direction). */
function passedGateLine(ball: Vec2, g: Gate): boolean {
  const dir = norm(sub(g.center, RECEIVE_POINT));
  return dot(sub(ball, g.center), dir) > 1.5;
}
