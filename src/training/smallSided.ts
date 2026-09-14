import { gestureAccuracy, readGesture, tapAccuracy } from "../gesture/gesture";
import { SLOW_SCALE } from "../match/clock";
import { add, angleBetween, clamp, dist, distToSegment, dot, norm, rotate, scale, sub, type Vec2 } from "../sim/geometry";
import { Rng } from "../sim/rng";

/**
 * Small-sided training activities (spec §8): 1v1, 2v2 and 3v2 in one deterministic engine with a
 * scenario generator per activity. Each rep is a moving picture: the defenders keep closing while
 * the decision window is open (slow motion, spec §12), the user picks an option and draws it, and
 * the resolution is simulated — a carrier can be caught, a pass intercepted, a shot go wide. The
 * three layers are recorded separately (spec §13): `decision` is the option's rank among what the
 * field offered at commit time, `execution` is drawing precision, `outcome` is what happened.
 *
 * Each option teaches one recognisable concept (space, pressure, support, timing, transition);
 * the summary names the concept the user most often missed so the coach's debrief can point at
 * something concrete. Balance values are proposals (OPEN_QUESTIONS #23, #24).
 */

export type Activity = "1v1" | "2v2" | "3v2";
export const ACTIVITIES: readonly Activity[] = ["1v1", "2v2", "3v2"];

export const ACTIVITY_LABEL: Record<Activity, string> = { "1v1": "1v1 — beat your defender", "2v2": "2v2 — pass or carry", "3v2": "3v2 — find the free player" };

/** Playing area in metres; attackers play toward x = AREA.length where a small goal sits. */
export const AREA = { length: 30, width: 24 } as const;
export const GOAL = { center: { x: AREA.length, y: AREA.width / 2 } as Vec2, halfWidth: 2.5 };
/** Line a carrier must cross to have "beaten" the defence in 1v1/2v2. */
export const BEAT_LINE_X = 24;
export const START: Vec2 = { x: 8, y: AREA.width / 2 };
export const TICK_MS = 50;
export const WINDOW_MS = 3000;
export const ACCESSIBLE_WINDOW_FACTOR = 1.5;
const SETUP_MS = 700;
const BETWEEN_MS = 1200;
const RESOLVE_LIMIT_MS = 3500;
const CARRY_SPEED = 5.5;
const PASS_SPEED = 9;
const SHOT_SPEED = 14;
const TACKLE_RADIUS = 1.1;
const INTERCEPT_RADIUS = 1.0;
const RECEIVE_RADIUS = 1.2;
const HOLD_MS = 1300;
/** Defenders need a beat to react once the ball is played. */
const REACT_MS = 350;
/** A defender beaten on their wrong side needs this long to turn. */
const BEATEN_MS = 800;
const KEEPER_SPEED = 3.2;
const KEEPER_REACH = 1.4;
const MAX_ERROR_RAD = Math.PI / 8;
const TECHNIQUE_NOISE_RAD = Math.PI / 50;
/** Drawn direction must be within this angle of an option's anchor to mean it. */
const INTENT_RAD = Math.PI / 5;

export type Concept = "space" | "pressure" | "support" | "timing" | "transition";
export type OptionKind = "carry" | "pass" | "shoot" | "hold";

export interface Actor {
  id: string;
  name: string;
  team: "att" | "def";
  pos: Vec2;
  /** Speed in m/s; defenders are generated with a spread so reads matter. */
  speed: number;
  /** Defenders only: which way they lean (−1 toward y = 0, +1 toward y = width, 0 balanced). */
  lean: number;
  /** Defenders only: how eagerly they close the ball (0 = jockey, 1 = dive in). */
  eagerness: number;
  /** Which attacker a defender marks (2v2/3v2); null = pressing the ball. */
  marks: string | null;
  /** How close a marker sits to their mark (tight ≈ 1.5 m, loose ≈ 3.5 m). */
  standoff: number;
  /** Milliseconds this defender is still reacting / recovering and cannot move. */
  frozenMs: number;
}

export const KEEPER_ID = "gk";
export const isKeeper = (a: Actor): boolean => a.id === KEEPER_ID;

export interface Option {
  id: string;
  kind: OptionKind;
  label: string;
  concept: Concept;
  /** Where to draw toward (live receiver position for passes). Null for hold. */
  anchor: Vec2 | null;
  receiver: string | null;
  score: number;
  reasons: string[];
}

export type DecisionBand = "strong" | "acceptable" | "weak" | "timeout";
export type ExecutionBand = "clean" | "ok" | "loose";
export type Outcome = "success" | "partial" | "failure";

export interface RepRecord {
  index: number;
  activity: Activity;
  /** Options with scores as they stood at commit (or timeout). */
  options: Option[];
  bestId: string;
  chosenId: string | null;
  decision: DecisionBand;
  /** Concept the chosen option should have taught when the read was weak or timed out. */
  missedConcept: Concept | null;
  accuracy: number;
  execution: ExecutionBand | null;
  outcome: Outcome | null;
  note: string;
}

export type Phase = "setup" | "window" | "resolve" | "between" | "done";

export interface DrillState {
  activity: Activity;
  seed: number;
  rngState: number;
  reps: number;
  index: number;
  phase: Phase;
  timeMs: number;
  windowMs: number;
  accessible: boolean;
  /** Decision-window multiplier: < 1 when the player arrives tired (spec §7 rest is a real choice). */
  windowScale: number;
  names: Names;
  actors: Actor[];
  ball: { pos: Vec2; vel: Vec2; holder: string | null };
  /** Options as offered when the window opened (re-scored at commit). */
  options: Option[];
  /** Active resolution, if any. */
  action: { kind: OptionKind; target: Vec2; receiver: string | null; dir: Vec2; elapsedMs: number; nearAtLaunch: number } | null;
  records: RepRecord[];
  events: DrillEvent[];
  acc: number;
}

export type DrillEvent =
  | { type: "window_open"; rep: number }
  | { type: "committed"; rep: number; optionId: string; decision: DecisionBand; accuracy: number }
  | { type: "timeout"; rep: number }
  | { type: "outcome"; rep: number; outcome: Outcome; note: string }
  | { type: "done" };

export const USER_ID = "you";

export interface Names {
  user: string;
  teammates: string[];
}

export interface DrillOptions {
  reps?: number;
  accessible?: boolean;
  names?: Names;
  windowScale?: number;
}

export function createDrill(activity: Activity, seed: number, opts: DrillOptions = {}): DrillState {
  const rng = new Rng(seed);
  const d: DrillState = {
    activity,
    seed,
    rngState: rng.snapshot(),
    reps: opts.reps ?? 5,
    index: -1,
    phase: "between",
    timeMs: 0,
    windowMs: 0,
    accessible: opts.accessible ?? false,
    windowScale: opts.windowScale ?? 1,
    names: opts.names ?? { user: "You", teammates: ["Teammate A", "Teammate B"] },
    actors: [],
    ball: { pos: { ...START }, vel: { x: 0, y: 0 }, holder: USER_ID },
    options: [],
    action: null,
    records: [],
    events: [],
    acc: 0,
  };
  startRep(d, rng);
  d.rngState = rng.snapshot();
  return d;
}

// ------------------------------------------------------------ scenarios

function defender(id: string, pos: Vec2, rng: Rng, marks: string | null, lean = 0, standoff = 1.5): Actor {
  return { id, name: id === "d1" ? "Defender 1" : "Defender 2", team: "def", pos, speed: rng.range(4.6, 5.6), lean, eagerness: rng.range(0.2, 1), marks, standoff, frozenMs: 0 };
}

function keeper(): Actor {
  return { id: KEEPER_ID, name: "Keeper", team: "def", pos: { x: AREA.length - 0.6, y: AREA.width / 2 }, speed: KEEPER_SPEED, lean: 0, eagerness: 0, marks: null, standoff: 0, frozenMs: 0 };
}

function attacker(id: string, name: string, pos: Vec2): Actor {
  return { id, name, team: "att", pos, speed: 5.2, lean: 0, eagerness: 0, marks: null, standoff: 0, frozenMs: 0 };
}

function scenario(d: DrillState, rng: Rng): Actor[] {
  const n = d.names;
  const me = attacker(USER_ID, n.user, { ...START });
  switch (d.activity) {
    case "1v1": {
      // Six pictures: leaning either way from near/far, balanced and near (make them commit), balanced and far (attack the space).
      const picture = rng.int(0, 6);
      const lean = picture < 4 ? (picture % 2 === 0 ? -1 : 1) : 0;
      const far = picture === 2 || picture === 3 || picture === 5;
      const dx = far ? rng.range(7, 9) : rng.range(3.5, 4.5);
      const pos = { x: START.x + dx, y: START.y + lean * rng.range(1.2, 2.2) };
      return [me, defender("d1", pos, rng, null, lean)];
    }
    case "2v2": {
      const side = rng.chance(0.5) ? -1 : 1;
      const mate = attacker("t1", n.teammates[0] ?? "Teammate", { x: START.x + rng.range(3, 5), y: START.y + side * rng.range(7, 9) });
      // Four pictures: my defender tight/far × teammate marked tight/loose.
      const picture = rng.int(0, 4);
      const myTight = picture < 2;
      const mateTight = picture % 2 === 0;
      const d1 = defender("d1", { x: START.x + (myTight ? rng.range(2.5, 3.5) : rng.range(7, 9)), y: START.y + rng.range(-1, 1) }, rng, USER_ID);
      const d2 = defender("d2", add(mate.pos, { x: mateTight ? 1.5 : 4.5, y: -side * (mateTight ? 1 : 3) }), rng, "t1", 0, mateTight ? 1.5 : 4);
      return [me, mate, d1, d2];
    }
    case "3v2": {
      const left = attacker("t1", n.teammates[0] ?? "Teammate A", { x: START.x + rng.range(5, 7), y: 5 + rng.range(-1, 1) });
      const right = attacker("t2", n.teammates[1] ?? "Teammate B", { x: START.x + rng.range(5, 7), y: AREA.width - 5 + rng.range(-1, 1) });
      // Four pictures: both press me (free player wide) · split covering both (carry to commit one) ·
      // one presses + one covers a side (other side free) · both drop wide (space in front, shot lane).
      const picture = rng.int(0, 4);
      let d1: Actor;
      let d2: Actor;
      if (picture === 0) {
        const s = rng.chance(0.5) ? -1 : 1;
        d1 = defender("d1", { x: START.x + rng.range(3, 4), y: START.y + s * 1.5 }, rng, USER_ID);
        d2 = defender("d2", { x: START.x + rng.range(4, 5.5), y: START.y - s * 1.5 }, rng, USER_ID);
      } else if (picture === 1) {
        d1 = defender("d1", { x: START.x + 9, y: 8 }, rng, "t1", 0, 3.5);
        d2 = defender("d2", { x: START.x + 9, y: AREA.width - 8 }, rng, "t2", 0, 3.5);
      } else if (picture === 2) {
        const coverRight = rng.chance(0.5);
        d1 = defender("d1", { x: START.x + rng.range(3, 4), y: START.y }, rng, USER_ID);
        d2 = defender("d2", coverRight ? { x: right.pos.x + 1.5, y: right.pos.y + 1 } : { x: left.pos.x + 1.5, y: left.pos.y - 1 }, rng, coverRight ? "t2" : "t1");
      } else {
        d1 = defender("d1", { x: START.x + 11, y: 5 }, rng, "t1", 0, 2.5);
        d2 = defender("d2", { x: START.x + 11, y: AREA.width - 5 }, rng, "t2", 0, 2.5);
      }
      return [me, left, right, d1, d2, keeper()];
    }
  }
}

function startRep(d: DrillState, rng: Rng): void {
  d.index++;
  if (d.index >= d.reps) {
    d.phase = "done";
    d.events.push({ type: "done" });
    return;
  }
  d.actors = scenario(d, rng);
  d.ball = { pos: { ...START }, vel: { x: 0, y: 0 }, holder: USER_ID };
  d.action = null;
  d.phase = "setup";
  d.windowMs = 0;
  d.options = [];
  d.records.push({ index: d.index, activity: d.activity, options: [], bestId: "", chosenId: null, decision: "timeout", missedConcept: null, accuracy: 0, execution: null, outcome: null, note: "" });
}

// ------------------------------------------------------------ reading the picture

export const me = (d: DrillState): Actor => d.actors.find((a) => a.id === USER_ID)!;
/** Outfield defenders (the keeper is not pressure). */
export const defenders = (d: DrillState): Actor[] => d.actors.filter((a) => a.team === "def" && !isKeeper(a));
export const teammates = (d: DrillState): Actor[] => d.actors.filter((a) => a.team === "att" && a.id !== USER_ID);

/** 0 = nobody near, 1 = a defender is on top of the point. */
export function pressureAt(p: Vec2, defs: readonly Actor[]): number {
  let s = 0;
  for (const df of defs) s += Math.exp(-dist(p, df.pos) / 3);
  return clamp(s, 0, 1);
}

export function laneOpen(from: Vec2, to: Vec2, defs: readonly Actor[]): number {
  let worst = 1;
  for (const df of defs) worst = Math.min(worst, clamp(distToSegment(df.pos, from, to) / 2.5, 0, 1));
  return worst;
}

/** How much room there is in a direction before a defender can get there. */
function spaceToward(from: Vec2, target: Vec2, defs: readonly Actor[]): number {
  const dir = norm(sub(target, from));
  let best = 1;
  for (const df of defs) {
    const rel = sub(df.pos, from);
    const ahead = dot(rel, dir);
    if (ahead < -1) continue;
    const lateral = Math.abs(rel.x * dir.y - rel.y * dir.x);
    const room = clamp((ahead - 1) / 8, 0, 1) * 0.5 + clamp(lateral / 5, 0, 1) * 0.5;
    best = Math.min(best, room);
  }
  return best;
}

const opt = (id: string, kind: OptionKind, label: string, concept: Concept, anchor: Vec2 | null, receiver: string | null, score: number, reasons: string[]): Option => ({
  id,
  kind,
  label,
  concept,
  anchor,
  receiver,
  score: clamp(score, 0, 1),
  reasons,
});

/** The options the picture offers right now, scored. Pure: reads actor positions only. */
export function options(d: DrillState): Option[] {
  const m = me(d);
  const defs = defenders(d);
  const mates = teammates(d);
  const out: Option[] = [];
  const nearest = defs.reduce((a, b) => (dist(a.pos, m.pos) <= dist(b.pos, m.pos) ? a : b));
  const dNear = dist(nearest.pos, m.pos);

  if (d.activity === "1v1") {
    const df = nearest;
    const sideTargets: [string, number][] = [["carry_left", -1], ["carry_right", 1]];
    for (const [id, s] of sideTargets) {
      const target = { x: BEAT_LINE_X, y: clamp(m.pos.y + s * 7, 2, AREA.width - 2) };
      const away = df.lean !== 0 && Math.sign(s) !== Math.sign(df.lean) ? 1 : df.lean === 0 ? 0.5 : 0;
      const room = spaceToward(m.pos, target, defs);
      const score = 0.25 + 0.45 * away + 0.3 * room;
      const reasons = [away === 1 ? "defender is leaning the other way" : away === 0 ? "defender is set on that side" : "defender is balanced"];
      out.push(opt(id, "carry", s < 0 ? "Attack the near side" : "Attack the far side", "space", target, null, score, reasons));
    }
    const straight = { x: BEAT_LINE_X, y: m.pos.y };
    const roomAhead = spaceToward(m.pos, straight, defs);
    out.push(opt("carry_at", "carry", "Drive straight", "timing", straight, null, 0.2 + 0.8 * (dNear > 6 ? 1 : 0.25) * (0.5 + 0.5 * roomAhead), [dNear > 6 ? "space in front before the defender arrives" : "defender is close — driving at them invites the tackle"]));
    const holdScore = df.lean === 0 ? (dNear <= 5 ? 0.85 : 0.45) : 0.2;
    out.push(opt("hold", "hold", "Slow down and make them commit", "timing", null, null, holdScore, [df.lean === 0 ? "defender is balanced — wait for a commitment" : "defender has already committed; waiting gives it back"]));
  } else if (d.activity === "2v2") {
    const mate = mates[0]!;
    const mateP = pressureAt(mate.pos, defs);
    const lane = laneOpen(m.pos, mate.pos, defs);
    out.push(opt("pass", "pass", `Pass to ${mate.name}`, "support", mate.pos, mate.id, 0.2 + 0.5 * (1 - mateP) + 0.3 * lane, [mateP < 0.4 ? `${mate.name} is loose from the marker` : `${mate.name} is marked tight`, lane < 0.5 ? "the lane is partly closed" : "the lane is open"]));
    const carryTarget = { x: BEAT_LINE_X, y: clamp(m.pos.y - Math.sign(mate.pos.y - m.pos.y) * 5, 2, AREA.width - 2) };
    const room = spaceToward(m.pos, carryTarget, defs);
    out.push(opt("carry", "carry", "Carry into the space", "space", carryTarget, null, 0.15 + 0.85 * room * (dNear > 5.5 ? 1 : 0.45), [dNear > 5.5 ? "your defender is far off" : "your defender is close"]));
    const wall = dNear <= 4 && mateP < 0.5 ? 0.85 : 0.35;
    out.push(opt("give_go", "pass", "Give and go", "pressure", mate.pos, mate.id, wall * (0.5 + 0.5 * lane), [dNear <= 4 ? "pressure on you — move them with a pass and run past" : "no pressure to escape from"]));
    out.push(opt("hold", "hold", "Shield and wait", "timing", null, null, dNear > 4 && mateP > 0.6 ? 0.55 : 0.25, [mateP > 0.6 ? "support is marked" : "support is available — waiting wastes it"]));
  } else {
    const [left, right] = [mates[0]!, mates[1]!];
    let freeCount = 0;
    for (const mate of [left, right]) {
      const p = pressureAt(mate.pos, defs);
      const lane = laneOpen(m.pos, mate.pos, defs);
      if (p < 0.4 && lane > 0.5) freeCount++;
      // With numbers up, the free player is the answer when someone is pressing the ball.
      const pressOnMe = pressureAt(m.pos, defs);
      const score = 0.2 + 0.45 * (1 - p) * lane + 0.35 * pressOnMe;
      out.push(opt(`pass_${mate.id}`, "pass", `Play early to ${mate.name}`, "transition", mate.pos, mate.id, score, [p < 0.4 ? `${mate.name} is free` : `${mate.name} is covered`, lane < 0.5 ? "lane is closed" : "lane is open"]));
    }
    const straight = { x: BEAT_LINE_X, y: m.pos.y };
    const roomAhead = spaceToward(m.pos, straight, defs);
    const bothCovered = freeCount === 0 && pressureAt(m.pos, defs) < 0.35;
    out.push(opt("carry", "carry", "Carry to commit a defender", "support", straight, null, bothCovered ? 0.85 : 0.25 + 0.4 * roomAhead * (1 - pressureAt(m.pos, defs)), [bothCovered ? "nobody is pressing — carry until one steps in, then release" : "carrying ignores the free player"]));
    const shotLane = laneOpen(m.pos, GOAL.center, defs);
    const range = clamp(1 - (GOAL.center.x - m.pos.x - 12) / 12, 0, 1);
    out.push(opt("shoot", "shoot", "Shoot", "timing", GOAL.center, null, 0.05 + 0.6 * shotLane * range + (roomAhead > 0.6 && shotLane > 0.7 ? 0.3 : 0), [shotLane > 0.7 ? "shooting lane is open" : "a body is in the shooting lane", range > 0.5 ? "in range" : "a long way out"]));
  }
  return out;
}

export function bestOf(opts: readonly Option[]): Option {
  return [...opts].sort((a, b) => b.score - a.score)[0]!;
}

export function gradeChoice(opts: readonly Option[], chosenId: string): Exclude<DecisionBand, "timeout"> {
  const best = bestOf(opts);
  const chosen = opts.find((o) => o.id === chosenId);
  if (!chosen) return "weak";
  const gap = best.score - chosen.score;
  return gap <= 0.1 ? "strong" : gap <= 0.3 ? "acceptable" : "weak";
}

export const executionBand = (accuracy: number): ExecutionBand => (accuracy >= 0.75 ? "clean" : accuracy >= 0.45 ? "ok" : "loose");
export const windowLimitMs = (d: DrillState): number => WINDOW_MS * (d.accessible ? ACCESSIBLE_WINDOW_FACTOR : 1) * d.windowScale;
export const windowProgress = (d: DrillState): number => (d.phase === "window" ? clamp(d.windowMs / windowLimitMs(d), 0, 1) : 0);
export const timeScale = (d: DrillState): number => (d.phase === "window" ? SLOW_SCALE : 1);
export const current = (d: DrillState): RepRecord | undefined => d.records[d.index];

/** Live anchor for an option (receivers move). */
export function liveAnchor(d: DrillState, o: Option): Vec2 | null {
  if (o.receiver) return d.actors.find((a) => a.id === o.receiver)?.pos ?? o.anchor;
  return o.anchor;
}

// ------------------------------------------------------------ time

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
    case "setup": {
      d.windowMs += TICK_MS;
      moveDefenders(d, dt, 0.35);
      if (d.windowMs >= SETUP_MS) {
        d.phase = "window";
        d.windowMs = 0;
        d.options = options(d);
        const rec = current(d)!;
        rec.options = d.options.map((o) => ({ ...o }));
        rec.bestId = bestOf(d.options).id;
        d.events.push({ type: "window_open", rep: d.index });
      }
      break;
    }
    case "window":
      moveDefenders(d, dt, 0.6);
      moveTeammates(d, dt);
      break;
    case "resolve":
      resolveTick(d, dt, rng);
      break;
    case "between":
      d.windowMs += TICK_MS;
      if (d.windowMs >= BETWEEN_MS) startRep(d, rng);
      break;
    case "done":
      break;
  }
  d.rngState = rng.snapshot();
}

/** Defenders close their mark (or the ball) at a share of their speed, stopping at their standoff; a leaning 1v1 defender drifts to their side. */
function moveDefenders(d: DrillState, dt: number, share: number): void {
  for (const df of defenders(d)) {
    const mark = df.marks ? d.actors.find((a) => a.id === df.marks) : null;
    const goal = mark && mark.id !== USER_ID ? add(mark.pos, { x: 1.2, y: 0 }) : d.ball.pos;
    const standoff = mark && mark.id !== USER_ID ? df.standoff : 1.5;
    const to = sub(goal, df.pos);
    const l = dist(goal, df.pos);
    if (l < standoff) continue;
    const v = scale(norm(to), Math.min(df.speed * share * (0.5 + 0.5 * df.eagerness) * dt, l - standoff));
    df.pos = add(df.pos, add(v, { x: 0, y: df.lean * 0.4 * dt }));
  }
}

/** The keeper shadows the ball across the goal line. */
function moveKeeper(d: DrillState, dt: number): void {
  const gk = d.actors.find(isKeeper);
  if (!gk) return;
  const targetY = clamp(d.ball.pos.y, GOAL.center.y - GOAL.halfWidth, GOAL.center.y + GOAL.halfWidth);
  const dy = targetY - gk.pos.y;
  gk.pos = { x: gk.pos.x, y: gk.pos.y + clamp(dy, -gk.speed * dt, gk.speed * dt) };
}

/** Teammates drift into support: a little wider and a little further forward. */
function moveTeammates(d: DrillState, dt: number): void {
  for (const t of teammates(d)) t.pos = { x: Math.min(t.pos.x + 0.8 * dt, BEAT_LINE_X - 2), y: t.pos.y };
}

function timeoutRep(d: DrillState): void {
  const rec = current(d)!;
  d.options = options(d);
  rec.options = d.options.map((o) => ({ ...o }));
  rec.bestId = bestOf(d.options).id;
  rec.decision = "timeout";
  rec.missedConcept = bestOf(d.options).concept;
  d.events.push({ type: "timeout", rep: d.index });
  // The picture closes: the nearest defender arrives and the rep is lost without a decision.
  rec.chosenId = null;
  rec.accuracy = 0;
  rec.execution = null;
  d.action = { kind: "hold", target: me(d).pos, receiver: null, dir: { x: 1, y: 0 }, elapsedMs: 0, nearAtLaunch: 0 };
  d.phase = "resolve";
}

/** Commit an option during the window with a drawing precision. */
export function commit(d: DrillState, optionId: string, accuracy: number): RepRecord | null {
  if (d.phase !== "window") return null;
  const live = options(d);
  const chosen = live.find((o) => o.id === optionId);
  if (!chosen) return null;
  const rec = current(d)!;
  rec.options = live.map((o) => ({ ...o }));
  rec.bestId = bestOf(live).id;
  rec.chosenId = optionId;
  rec.decision = gradeChoice(live, optionId);
  rec.missedConcept = rec.decision === "weak" ? bestOf(live).concept : null;
  const a = chosen.kind === "hold" ? 1 : clamp(accuracy, 0, 1);
  rec.accuracy = a;
  rec.execution = chosen.kind === "hold" ? null : executionBand(a);
  d.events.push({ type: "committed", rep: d.index, optionId, decision: rec.decision, accuracy: a });
  const rng = new Rng(0);
  rng.restore(d.rngState);
  launch(d, chosen, a, rng);
  d.rngState = rng.snapshot();
  return rec;
}

function launch(d: DrillState, o: Option, accuracy: number, rng: Rng): void {
  const m = me(d);
  const anchor = liveAnchor(d, o) ?? m.pos;
  const err = (1 - accuracy) * MAX_ERROR_RAD * (rng.chance(0.5) ? 1 : -1) + rng.gaussian() * TECHNIQUE_NOISE_RAD;
  const dir = rotate(norm(sub(anchor, m.pos)), o.kind === "hold" ? 0 : err);
  const nearAtLaunch = Math.min(...defenders(d).map((df) => dist(df.pos, m.pos)));
  d.action = { kind: o.kind, target: anchor, receiver: o.receiver, dir, elapsedMs: 0, nearAtLaunch };
  for (const df of defenders(d)) {
    df.frozenMs = REACT_MS;
    // A carry away from the side a defender is leaning to, or past one who has already dived in, beats them for a moment.
    if (o.kind === "carry") {
      const wrongWay = df.lean !== 0 && Math.sign(dir.y) !== 0 && Math.sign(dir.y) !== Math.sign(df.lean);
      const divedIn = df.lean === 0 && df.eagerness > 0.6 && dist(df.pos, m.pos) < 3;
      if (wrongWay || divedIn) df.frozenMs = BEATEN_MS;
    }
  }
  if (o.kind === "pass") {
    d.ball.holder = null;
    d.ball.vel = scale(dir, PASS_SPEED);
  } else if (o.kind === "shoot") {
    d.ball.holder = null;
    d.ball.vel = scale(dir, SHOT_SPEED);
  } else if (o.kind === "carry") {
    d.ball.holder = USER_ID;
  }
  d.phase = "resolve";
}

function resolveTick(d: DrillState, dt: number, rng: Rng): void {
  const act = d.action!;
  act.elapsedMs += TICK_MS;
  const m = me(d);
  const defs = defenders(d);
  const rec = current(d)!;
  // Once the picture has been decided defenders chase the ball flat out — after reacting, and once any beaten one has turned.
  for (const df of defs) {
    if (df.frozenMs > 0) {
      df.frozenMs -= TICK_MS;
      continue;
    }
    const to = sub(d.ball.pos, df.pos);
    const l = dist(d.ball.pos, df.pos);
    const share = act.kind === "hold" && rec.decision !== "timeout" ? 0.45 + 0.55 * df.eagerness : 1;
    if (l > 0.05) df.pos = add(df.pos, scale(norm(to), Math.min(df.speed * share * dt, l)));
  }
  moveKeeper(d, dt);
  switch (act.kind) {
    case "hold": {
      const caught = defs.some((df) => dist(df.pos, m.pos) <= TACKLE_RADIUS);
      if (caught) return finishRep(d, "failure", rec.decision === "timeout" ? "You waited too long and were closed down." : "They dived in and won it — waiting cost you the ball.");
      if (act.elapsedMs >= HOLD_MS) {
        if (rec.decision === "timeout") return finishRep(d, "failure", "No decision — the picture closed and the ball went backwards.");
        if (defs.some((df) => df.lean !== 0)) return finishRep(d, "partial", "You kept it, but the defender recovered their balance while you waited.");
        if (act.nearAtLaunch > 5.5) return finishRep(d, "partial", "Nobody came to you — you waited for nothing and the chance went.");
        return finishRep(d, "success", "They committed and you still had the ball — the picture reopened.");
      }
      return;
    }
    case "carry": {
      const dir = act.dir;
      m.pos = add(m.pos, scale(dir, CARRY_SPEED * dt));
      d.ball.pos = add(m.pos, scale(dir, 0.5));
      if (m.pos.y < 0.5 || m.pos.y > AREA.width - 0.5) return finishRep(d, "failure", "You ran the ball out of the area.");
      if (defs.some((df) => df.frozenMs <= 0 && dist(df.pos, d.ball.pos) <= TACKLE_RADIUS)) {
        const strongRead = rec.decision === "strong";
        return finishRep(d, strongRead && rng.chance(0.35) ? "partial" : "failure", strongRead ? "Right idea; the defender recovered and you shielded it out for a throw." : "Tackled.");
      }
      if (m.pos.x >= BEAT_LINE_X) return finishRep(d, "success", "You beat the defence into the space.");
      if (act.elapsedMs >= RESOLVE_LIMIT_MS) return finishRep(d, "partial", "You kept it but the chance had gone.");
      return;
    }
    case "pass": {
      d.ball.pos = add(d.ball.pos, scale(d.ball.vel, dt));
      const rcv = d.actors.find((a) => a.id === act.receiver)!;
      if (dist(d.ball.pos, rcv.pos) <= RECEIVE_RADIUS) {
        d.ball.holder = rcv.id;
        return finishRep(d, "success", `${rcv.name} received it clean.`);
      }
      if (defs.some((df) => df.frozenMs <= 0 && dist(df.pos, d.ball.pos) <= INTERCEPT_RADIUS)) return finishRep(d, "failure", "Intercepted.");
      const passed = dot(sub(d.ball.pos, rcv.pos), norm(d.ball.vel)) > 2.5;
      if (passed || d.ball.pos.x < 0 || d.ball.pos.x > AREA.length || d.ball.pos.y < 0 || d.ball.pos.y > AREA.width) {
        return finishRep(d, rec.decision === "strong" ? "partial" : "failure", "Right pass, wrong weight — it ran past.");
      }
      return;
    }
    case "shoot": {
      d.ball.pos = add(d.ball.pos, scale(d.ball.vel, dt));
      if (defs.some((df) => df.frozenMs <= 0 && dist(df.pos, d.ball.pos) <= INTERCEPT_RADIUS)) return finishRep(d, "failure", "Blocked.");
      if (d.ball.pos.x >= GOAL.center.x - 0.6) {
        const gk = d.actors.find(isKeeper);
        const inFrame = Math.abs(d.ball.pos.y - GOAL.center.y) <= GOAL.halfWidth;
        if (!inFrame) return finishRep(d, "failure", "Wide.");
        if (gk && Math.abs(gk.pos.y - d.ball.pos.y) <= KEEPER_REACH) return finishRep(d, "failure", "Saved.");
        return finishRep(d, "success", "Goal.");
      }
      if (d.ball.pos.y < 0 || d.ball.pos.y > AREA.width) return finishRep(d, "failure", "Wide.");
      return;
    }
  }
}

function finishRep(d: DrillState, outcome: Outcome, note: string): void {
  const rec = current(d)!;
  rec.outcome = outcome;
  rec.note = note;
  d.events.push({ type: "outcome", rep: d.index, outcome, note });
  d.phase = "between";
  d.windowMs = 0;
  d.action = null;
}

// ------------------------------------------------------------ input

export interface DrawRead {
  option: Option | null;
  accuracy: number;
}

/** Which drawable option a path means, and how precisely. `selected` narrows to one option (select-then-draw). */
export function readDraw(d: DrillState, points: readonly Vec2[], selected: Option | null = null): DrawRead {
  const g = readGesture(points);
  if (!g) return { option: null, accuracy: 0 };
  const m = me(d);
  const candidates = (selected ? [selected] : d.options).filter((o) => o.kind !== "hold");
  let best: Option | null = null;
  let bestAngle = selected ? Math.PI : INTENT_RAD;
  for (const o of candidates) {
    const anchor = liveAnchor(d, o);
    if (!anchor) continue;
    const a = angleBetween(g.direction, norm(sub(anchor, m.pos)));
    if (a < bestAngle) {
      bestAngle = a;
      best = o;
    }
  }
  if (!best) return { option: null, accuracy: 0 };
  return { option: best, accuracy: gestureAccuracy(g, m.pos, liveAnchor(d, best)!) };
}

/** Accessible alternative: tap near an option's anchor (or anywhere, once an option is selected). */
export function readTap(d: DrillState, point: Vec2, selected: Option | null = null): DrawRead {
  const m = me(d);
  if (selected) {
    const anchor = liveAnchor(d, selected);
    return anchor ? { option: selected, accuracy: tapAccuracy(point, m.pos, anchor) } : { option: selected, accuracy: 1 };
  }
  let best: Option | null = null;
  let bestD = 4;
  for (const o of d.options) {
    const anchor = liveAnchor(d, o);
    if (!anchor) continue;
    const dd = dist(point, anchor);
    if (dd < bestD) {
      bestD = dd;
      best = o;
    }
  }
  if (!best) return { option: null, accuracy: 0 };
  return { option: best, accuracy: tapAccuracy(point, m.pos, liveAnchor(d, best)!) };
}

/** Run to completion with a policy, for tests and calibration. */
export function runHeadless(d: DrillState, policy: (d: DrillState, opts: readonly Option[]) => { optionId: string; accuracy: number } | null, maxSteps = 40_000): DrillState {
  for (let i = 0; i < maxSteps && d.phase !== "done"; i++) {
    const evs = step(d, 100);
    if (evs.some((e) => e.type === "window_open")) {
      const choice = policy(d, d.options);
      if (choice) commit(d, choice.optionId, choice.accuracy);
    }
  }
  return d;
}

// ------------------------------------------------------------ summary

export type ReadsBand = "sharp" | "mixed" | "rushed";
export type TouchBand = "clean" | "ok" | "loose";

export interface Summary {
  activityId: Activity;
  reps: number;
  decisions: Record<DecisionBand, number>;
  executions: Record<ExecutionBand, number>;
  outcomes: Record<Outcome, number>;
  meanAccuracy: number;
  reads: ReadsBand;
  touch: TouchBand;
  /** The concept most often missed (weak reads and timeouts), or null when reads were sound. */
  lesson: Concept | null;
  /** A strong read that failed anyway / a weak read that succeeded — the story hooks (spec §13). */
  goodReadFailed: number;
  poorReadSucceeded: number;
}

export function summarize(d: DrillState): Summary {
  const decisions: Record<DecisionBand, number> = { strong: 0, acceptable: 0, weak: 0, timeout: 0 };
  const executions: Record<ExecutionBand, number> = { clean: 0, ok: 0, loose: 0 };
  const outcomes: Record<Outcome, number> = { success: 0, partial: 0, failure: 0 };
  const missed: Partial<Record<Concept, number>> = {};
  let acc = 0;
  let accN = 0;
  let n = 0;
  let goodReadFailed = 0;
  let poorReadSucceeded = 0;
  for (const r of d.records) {
    if (r.outcome === null) continue;
    n++;
    decisions[r.decision]++;
    if (r.execution) {
      executions[r.execution]++;
      acc += r.accuracy;
      accN++;
    }
    outcomes[r.outcome]++;
    if (r.missedConcept) missed[r.missedConcept] = (missed[r.missedConcept] ?? 0) + 1;
    if (r.decision === "strong" && r.outcome === "failure") goodReadFailed++;
    if ((r.decision === "weak" || r.decision === "timeout") && r.outcome === "success") poorReadSucceeded++;
  }
  const total = Math.max(1, n);
  const strongShare = decisions.strong / total;
  const readShare = (decisions.strong + decisions.acceptable) / total;
  const reads: ReadsBand = strongShare >= 0.6 && decisions.timeout === 0 ? "sharp" : readShare >= 0.5 ? "mixed" : "rushed";
  const meanAccuracy = accN ? acc / accN : 0;
  const touch: TouchBand = accN === 0 ? "ok" : meanAccuracy >= 0.7 ? "clean" : meanAccuracy >= 0.45 ? "ok" : "loose";
  const lesson = (Object.entries(missed) as [Concept, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { activityId: d.activity, reps: n, decisions, executions, outcomes, meanAccuracy, reads, touch, lesson, goodReadFailed, poorReadSucceeded };
}

export const CONCEPT_LABEL: Record<Concept, string> = {
  space: "attacking the space the defender leaves",
  pressure: "using pressure against the defender",
  support: "seeing where the support is",
  timing: "waiting for the right moment",
  transition: "playing early when you have numbers",
};
