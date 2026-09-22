import { createMatch, isFinished, tick, type MatchConfig } from "../sim/engine";
import type { Vec2 } from "../sim/geometry";
import { TICK_MS, type BallState, type MatchEvent, type MatchState } from "../sim/types";
import type { Catalog } from "../tactics/catalog";
import type { MomentRecord, TacticalMoment } from "../tactics/moments";
import { DIRECT_PACING, serializeRecognizer, type PacingConfig, type RecognizerState } from "../tactics/recognition";
import { abandon, commit, createSession, feedbackFor, observe, settle, timeout, type CommitResult, type TacticalSession } from "../tactics/session";
import { advanceClock, createClock, MAX_SKIP_TICKS_PER_FRAME, NORMAL_SCALE, SKIP_SCALE, type RuntimeClock } from "./clock";

/**
 * Match runtime / moment director (audit §5, spec §9–§13). The engine simulates the whole match; the
 * player experiences only the selected character's meaningful direct involvements:
 *
 *   routine ─▶ lead_in ─▶ question ─▶ timer ─▶ resolving ─▶ feedback ─▶ routine …
 *
 *  - `routine`    the simulation is skipped forward at `SKIP_SCALE` (the match clock advances tick by
 *                 tick — nothing is jumped over, it is just not watched);
 *  - `lead_in`    a moment was recognised on the current tick; the last few seconds *that actually
 *                 happened* are replayed at real speed from the position history so the player sees
 *                 the ball travel, the movement, the pressure and the space before the freeze;
 *  - `question`   the field is frozen at first controlled contact (or the keeper's intervention
 *                 point); question and 3–6 answers are shown; the timer waits for `ready()` (read-aloud);
 *  - `timer`      15 real seconds; pause stops it; selecting an answer ends it;
 *  - `resolving`  the selected (or engine-selected) command was issued; the consequence plays at real
 *                 speed until the outcome window has resolved from recorded events;
 *  - `feedback`   brief factual feedback, then straight back to skipping.
 *
 * The runtime has no DOM, canvas or timers: the screen feeds it frames and answers and reads back
 * what to draw. Every quantity is derived from the runtime clock and the simulation, so a headless
 * driver at a fixed frame cadence measures exactly what a phone would.
 */

export const ANSWER_MS = 15_000;
/** Real ms of replayed lead-in (spec: two to four seconds). */
export const LEAD_IN_MS = 3_000;
export const LEAD_IN_MIN_MS = 2_000;
/** Ticks of position history kept for the lead-in (3 s of match). */
export const HISTORY_TICKS = Math.round(LEAD_IN_MS / TICK_MS);
/** Real ms the feedback card stays up before play skips on (the user may continue earlier). */
export const FEEDBACK_MS = 3_000;
export const HALF_TIME_MS = 2_500;
export const TICKS_PER_SECOND = 1000 / TICK_MS;

export type RuntimePhase = "routine" | "lead_in" | "question" | "timer" | "resolving" | "feedback" | "halftime" | "finished";

export type MomentCloseReason = "committed" | "timeout" | "intent_unavailable" | "play_stopped";

export interface ActiveMoment {
  moment: TacticalMoment;
  /** Real ms of lead-in replayed so far. */
  leadInMs: number;
  /** Total real ms the lead-in will take (history available, ≥ `LEAD_IN_MIN_MS`). */
  leadInTotalMs: number;
  /** Position history from `HISTORY_TICKS` ticks before the freeze up to the frozen tick itself. */
  history: Snapshot[];
  /** Real ms left on the answer timer; `ANSWER_MS` until `ready()` starts it. */
  timerLeftMs: number;
  timerRunning: boolean;
  /** Set the instant an answer landed or the timer expired. */
  result: CommitResult | null;
  reason: MomentCloseReason | null;
  record: MomentRecord | null;
  /** Real ms the feedback has been showing. */
  feedbackMs: number;
  feedback: string[] | null;
}

export interface Snapshot {
  tick: number;
  players: { id: string; pos: Vec2; vel: Vec2 }[];
  ball: BallState;
}

export interface MomentClosed {
  moment: TacticalMoment;
  reason: MomentCloseReason;
  result: CommitResult;
  record: MomentRecord;
}

export interface FrameResult {
  ticks: number;
  /** A moment was recognised this frame: its lead-in starts. */
  opened: TacticalMoment | null;
  /** A moment's outcome settled this frame: feedback starts. */
  closed: MomentClosed | null;
  /** Engine events emitted during this frame, in order. */
  events: MatchEvent[];
  finished: boolean;
}

export interface RuntimeOptions {
  pacing?: PacingConfig;
}

export interface MatchRuntime {
  readonly state: MatchState;
  readonly session: TacticalSession;
  readonly clock: RuntimeClock;
  readonly phase: RuntimePhase;
  readonly active: ActiveMoment | null;
  /** Real ms left in the half-time beat. */
  readonly halfTimeLeftMs: number;
  /** Real ms spent per phase (pauses excluded): the measurement the 5–7 minute target is judged on. */
  readonly realMs: Record<RuntimePhase, number>;
  paused: boolean;
}

interface Internal extends MatchRuntime {
  phase: RuntimePhase;
  active: ActiveMoment | null;
  halfTimeLeftMs: number;
  history: Snapshot[];
  eventCursor: number;
  /** The half ended while a moment was in flight: hold the break once the moment has closed. */
  halfTimePending: boolean;
}

export function createRuntime(cfg: MatchConfig, catalog: Catalog, opts: RuntimeOptions = {}): MatchRuntime {
  const state = createMatch(cfg);
  const rt: Internal = {
    state,
    session: createSession(catalog, opts.pacing ?? DIRECT_PACING),
    clock: createClock(SKIP_SCALE),
    phase: "routine",
    active: null,
    halfTimeLeftMs: 0,
    realMs: { routine: 0, lead_in: 0, question: 0, timer: 0, resolving: 0, feedback: 0, halftime: 0, finished: 0 },
    paused: false,
    history: [],
    eventCursor: state.events.length,
    halfTimePending: false,
  };
  pushHistory(rt);
  return rt;
}

export const totalRealMs = (rt: MatchRuntime): number => Object.values(rt.realMs).reduce((a, b) => a + b, 0);

function snapshot(state: MatchState): Snapshot {
  return {
    tick: state.clock.tick,
    players: state.players.map((p) => ({ id: p.id, pos: { ...p.pos }, vel: { ...p.vel } })),
    ball: { ...state.ball, pos: { ...state.ball.pos }, vel: { ...state.ball.vel } },
  };
}

function pushHistory(rt: Internal): void {
  rt.history.push(snapshot(rt.state));
  if (rt.history.length > HISTORY_TICKS + 1) rt.history.splice(0, rt.history.length - (HISTORY_TICKS + 1));
}

function setPhase(rt: Internal, phase: RuntimePhase): void {
  rt.phase = phase;
  rt.clock.scale = phase === "routine" ? SKIP_SCALE : NORMAL_SCALE;
  rt.clock.carryMs = 0;
}

/**
 * Advance one real-time frame. Only `routine` and `resolving` run the simulation; every other phase
 * holds the field exactly where the answers were generated.
 */
export function frame(runtime: MatchRuntime, realDtMs: number): FrameResult {
  const rt = runtime as Internal;
  const dt = Math.max(0, realDtMs);
  const result: FrameResult = { ticks: 0, opened: null, closed: null, events: [], finished: isFinished(rt.state) };
  if (result.finished && rt.phase !== "finished") setPhase(rt, "finished");
  if (rt.paused || rt.phase === "finished") return result;
  rt.realMs[rt.phase] += dt;

  switch (rt.phase) {
    case "routine":
      runRoutine(rt, dt, result);
      break;
    case "lead_in": {
      const a = rt.active!;
      a.leadInMs += dt;
      if (a.leadInMs >= a.leadInTotalMs) setPhase(rt, "question");
      break;
    }
    case "question":
      // waiting for ready(): the timer never starts before the question, answers and read-aloud are done
      break;
    case "timer": {
      const a = rt.active!;
      a.timerLeftMs -= dt;
      if (a.timerLeftMs <= 0) {
        a.timerLeftMs = 0;
        finish(rt, "timeout", timeout(rt.session, rt.state));
      }
      break;
    }
    case "resolving":
      runResolving(rt, dt, result);
      break;
    case "feedback": {
      const a = rt.active!;
      a.feedbackMs += dt;
      if (a.feedbackMs >= FEEDBACK_MS) continueNow(rt);
      break;
    }
    case "halftime":
      rt.halfTimeLeftMs -= dt;
      if (rt.halfTimeLeftMs <= 0) {
        rt.halfTimeLeftMs = 0;
        setPhase(rt, "routine");
      }
      break;
  }

  result.events = rt.state.events.slice(rt.eventCursor);
  rt.eventCursor = rt.state.events.length;
  if (result.events.some((e) => e.type === "half_time")) {
    if (rt.phase === "routine") beginHalfTime(rt);
    else rt.halfTimePending = true;
  }
  result.finished = isFinished(rt.state);
  if (result.finished) setPhase(rt, "finished");
  return result;
}

function beginHalfTime(rt: Internal): void {
  rt.halfTimePending = false;
  rt.halfTimeLeftMs = HALF_TIME_MS;
  setPhase(rt, "halftime");
}

/** Back to skipping — or into the half-time beat the moment was holding back. */
function resumeRoutine(rt: Internal): void {
  if (rt.halfTimePending) beginHalfTime(rt);
  else setPhase(rt, "routine");
}

function runRoutine(rt: Internal, dt: number, result: FrameResult): void {
  const ticks = advanceClock(rt.clock, dt, MAX_SKIP_TICKS_PER_FRAME);
  for (let i = 0; i < ticks && !isFinished(rt.state); i++) {
    // settles open outcomes; recognises a new moment against the state exactly as it stands
    const moment = observe(rt.session, rt.state);
    if (moment) {
      open(rt, moment);
      result.opened = moment;
      return;
    }
    tick(rt.state);
    pushHistory(rt);
    result.ticks++;
    if (rt.state.events[rt.state.events.length - 1]?.type === "half_time") return;
  }
}

function open(rt: Internal, moment: TacticalMoment): void {
  const history = rt.history.slice();
  const available = Math.max(0, history.length - 1) * TICK_MS;
  rt.active = {
    moment,
    leadInMs: 0,
    leadInTotalMs: Math.max(LEAD_IN_MIN_MS, Math.min(LEAD_IN_MS, available)),
    history,
    timerLeftMs: ANSWER_MS,
    timerRunning: false,
    result: null,
    reason: null,
    record: null,
    feedbackMs: 0,
    feedback: null,
  };
  setPhase(rt, "lead_in");
}

/** The screen has shown the question and answers (and finished any read-aloud): start the 15 seconds. */
export function ready(runtime: MatchRuntime): void {
  const rt = runtime as Internal;
  if (rt.phase !== "question" || !rt.active) return;
  rt.active.timerRunning = true;
  setPhase(rt, "timer");
}

/** Skip the remaining lead-in straight to the frozen question (reduced motion, replays). */
export function skipLeadIn(runtime: MatchRuntime): void {
  const rt = runtime as Internal;
  if (rt.phase !== "lead_in" || !rt.active) return;
  rt.active.leadInMs = rt.active.leadInTotalMs;
  setPhase(rt, "question");
}

/**
 * The user selected an answer. Allowed from the moment the question is visible (before or after the
 * timer starts). The session re-instantiates the intent against the frozen state, grades the
 * decision and issues the exact command; the engine executes it — nothing else is asked of the user.
 */
export function answer(runtime: MatchRuntime, optionId: string): boolean {
  const rt = runtime as Internal;
  if (!rt.active || (rt.phase !== "question" && rt.phase !== "timer")) return false;
  if (!rt.active.moment.options.some((o) => o.id === optionId)) throw new Error(`unknown option ${optionId}`);
  const res = commit(rt.session, rt.state, optionId);
  finish(rt, res.status === "committed" ? "committed" : "intent_unavailable", res);
  return true;
}

function finish(rt: Internal, reason: MomentCloseReason, res: CommitResult): void {
  const a = rt.active!;
  a.timerRunning = false;
  a.result = res;
  a.reason = reason;
  a.record = rt.session.records[rt.session.records.length - 1] ?? null;
  setPhase(rt, "resolving");
}

function runResolving(rt: Internal, dt: number, result: FrameResult): void {
  const a = rt.active!;
  const ticks = advanceClock(rt.clock, dt);
  for (let i = 0; i < ticks && !isFinished(rt.state); i++) {
    tick(rt.state);
    pushHistory(rt);
    result.ticks++;
    settle(rt.session, rt.state);
    if (a.record?.outcome) break;
  }
  if (isFinished(rt.state)) settle(rt.session, rt.state);
  if (a.record?.outcome || isFinished(rt.state)) {
    a.feedback = a.record ? feedbackFor(rt.session, a.record) : [];
    a.feedbackMs = 0;
    if (a.record && a.result && a.reason) result.closed = { moment: a.moment, reason: a.reason, result: a.result, record: a.record };
    setPhase(rt, "feedback");
  }
}

/** Dismiss the feedback early and skip on to the next involvement. */
export function continueNow(runtime: MatchRuntime): void {
  const rt = runtime as Internal;
  if (rt.phase !== "feedback") return;
  rt.active = null;
  resumeRoutine(rt);
}

/**
 * Leave the match while a question is open (save and exit): the situation is recorded as abandoned
 * with no command issued, so nothing is attributed to the user and the simulation can carry on later.
 */
export function abandonActive(runtime: MatchRuntime, why = "You left the match before choosing."): MomentClosed | null {
  const rt = runtime as Internal;
  if (!rt.active || (rt.phase !== "lead_in" && rt.phase !== "question" && rt.phase !== "timer")) return null;
  const res = abandon(rt.session, rt.state, why);
  const record = rt.session.records[rt.session.records.length - 1]!;
  const moment = rt.active.moment;
  rt.active = null;
  resumeRoutine(rt);
  return { moment, reason: "play_stopped", result: res, record };
}

/** Real seconds left on the answer timer (15 until it starts; 0 when no question is open). */
export function timerRemaining(rt: MatchRuntime): number {
  if (!rt.active || (rt.phase !== "question" && rt.phase !== "timer")) return 0;
  return rt.active.timerLeftMs / 1000;
}

/** 0 when the timer starts → 1 at expiry. */
export function timerProgress(rt: MatchRuntime): number {
  if (!rt.active || rt.phase !== "timer") return 0;
  return 1 - rt.active.timerLeftMs / ANSWER_MS;
}

/** 0 → 1 across the lead-in replay. */
export function leadInProgress(rt: MatchRuntime): number {
  if (!rt.active || rt.phase !== "lead_in") return 1;
  return Math.min(1, rt.active.leadInMs / rt.active.leadInTotalMs);
}

/**
 * The field as it should be drawn: during the lead-in, the recorded positions at the replay's current
 * point (with the sub-frame remainder interpolated); otherwise the authoritative state itself. The
 * view is a shallow copy — the simulation is never touched by presentation.
 */
export function viewState(rt: MatchRuntime): MatchState {
  const a = rt.active;
  if (!a || rt.phase !== "lead_in" || a.history.length < 2) return rt.state;
  const n = a.history.length;
  const span = a.leadInTotalMs;
  // replay covers the whole history at real speed; a short history holds its first frame first
  const replayMs = (n - 1) * TICK_MS;
  const t = Math.max(0, a.leadInMs - (span - replayMs));
  const f = Math.min(n - 1, t / TICK_MS);
  const i = Math.min(n - 2, Math.floor(f));
  const u = f - i;
  const s0 = a.history[i]!;
  const s1 = a.history[i + 1]!;
  const lerp = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
  const byId = new Map(s1.players.map((p) => [p.id, p]));
  const players = rt.state.players.map((p, k) => {
    const p0 = s0.players[k]?.id === p.id ? s0.players[k]! : s0.players.find((q) => q.id === p.id);
    const p1 = byId.get(p.id);
    if (!p0 || !p1) return p;
    return { ...p, pos: lerp(p0.pos, p1.pos), vel: p1.vel };
  });
  const ball: BallState = u < 0.5 ? { ...s0.ball, pos: lerp(s0.ball.pos, s1.ball.pos) } : { ...s1.ball, pos: lerp(s0.ball.pos, s1.ball.pos) };
  return { ...rt.state, players, ball, clock: { ...rt.state.clock, tick: s0.tick, timeMs: Math.max(0, rt.state.clock.timeMs - (n - 1 - i) * TICK_MS) } };
}

/** The question is visible: frozen field, answers on offer (before or during the timer). */
export const questionOpen = (rt: MatchRuntime): boolean => rt.active !== null && (rt.phase === "question" || rt.phase === "timer");

/** The one soccer-intelligence question asked at the freeze, worded by how the player is involved. */
export function questionFor(moment: TacticalMoment): string {
  if (moment.role === "GK" && moment.category !== "on_ball") return "How do you deal with this?";
  if (moment.involvement === "first_touch") return "The ball is arriving — what do you do with your first touch?";
  switch (moment.category) {
    case "on_ball":
      return "You have the ball — what is the right play?";
    case "defending":
      return "They have the ball — what is your job right now?";
    case "transition":
      return "The ball has just changed hands — what do you do first?";
    case "off_ball":
      return "Where should you be as this develops?";
  }
}

// ------------------------------------------------------------------ save / reload

/**
 * A match mid-flight, as JSON. Records keep their identity through `momentId`; the frozen question
 * (if one is open) is restored *before* its timer so the screen shows it and calls `ready()` again —
 * whatever was left on the clock is what the player gets back. Nothing about the simulation is
 * re-derived: the authoritative state, its events and RNG are stored verbatim.
 */
export interface RuntimeSave {
  version: 1;
  state: MatchState;
  session: {
    pacing: PacingConfig;
    recognizer: RecognizerState;
    active: TacticalMoment | null;
    open: { momentId: string; committed: CommittedIntentJson | null }[];
    records: MomentRecord[];
    rejects: Record<string, number>;
  };
  clock: RuntimeClock;
  phase: RuntimePhase;
  active: (Omit<ActiveMoment, "record"> & { recordId: string | null }) | null;
  halfTimeLeftMs: number;
  realMs: Record<RuntimePhase, number>;
  history: Snapshot[];
  eventCursor: number;
  halfTimePending: boolean;
}

type CommittedIntentJson = NonNullable<TacticalSession["open"][number]["committed"]>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function serializeRuntime(runtime: MatchRuntime): RuntimeSave {
  const rt = runtime as Internal;
  const a = rt.active;
  return clone({
    version: 1,
    state: rt.state,
    session: {
      pacing: rt.session.pacing,
      recognizer: serializeRecognizer(rt.session.recognizer),
      active: rt.session.active,
      open: rt.session.open.map((o) => ({ momentId: o.record.moment.id, committed: o.committed })),
      records: rt.session.records,
      rejects: rt.session.rejects,
    },
    clock: rt.clock,
    phase: rt.phase,
    active: a ? { ...omitRecord(a), recordId: a.record?.moment.id ?? null } : null,
    halfTimeLeftMs: rt.halfTimeLeftMs,
    realMs: rt.realMs,
    history: rt.history,
    eventCursor: rt.eventCursor,
    halfTimePending: rt.halfTimePending,
  });
}

function omitRecord(a: ActiveMoment): Omit<ActiveMoment, "record"> {
  const { record: _record, ...rest } = a;
  return rest;
}

export function restoreRuntime(save: RuntimeSave, catalog: Catalog): MatchRuntime {
  if (save.version !== 1) throw new Error(`unsupported match save v${String(save.version)}`);
  const s = clone(save);
  const byId = new Map(s.session.records.map((r) => [r.moment.id, r]));
  const session: TacticalSession = {
    catalog,
    pacing: s.session.pacing,
    recognizer: { ...s.session.recognizer, lastMomentTick: s.session.recognizer.lastMomentTick <= -1_000_000 ? -Infinity : s.session.recognizer.lastMomentTick },
    active: s.session.active,
    open: s.session.open.flatMap((o) => {
      const record = byId.get(o.momentId);
      return record ? [{ record, committed: o.committed }] : [];
    }),
    records: s.session.records,
    rejects: s.session.rejects,
  };
  let active: ActiveMoment | null = null;
  if (s.active) {
    const { recordId, ...rest } = s.active;
    active = { ...rest, record: recordId ? byId.get(recordId) ?? null : null };
  }
  const rt: Internal = {
    state: s.state,
    session,
    clock: s.clock,
    phase: s.phase,
    active,
    halfTimeLeftMs: s.halfTimeLeftMs,
    realMs: s.realMs,
    paused: false,
    history: s.history,
    eventCursor: s.eventCursor,
    halfTimePending: s.halfTimePending,
  };
  // an open timer comes back as the frozen question: the screen re-shows it and calls ready()
  if (rt.phase === "timer" && rt.active) {
    rt.active.timerRunning = false;
    setPhase(rt, "question");
  } else {
    setPhase(rt, rt.phase);
  }
  return rt;
}
