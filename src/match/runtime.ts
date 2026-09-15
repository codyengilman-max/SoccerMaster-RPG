import { gestureAccuracy, isCancelGesture, readGesture, tapAccuracy, type GestureRead } from "../gesture/gesture";
import { createMatch, isFinished, tick, type MatchConfig } from "../sim/engine";
import { playerById } from "../sim/perception";
import { TICK_MS, type MatchEvent, type MatchState } from "../sim/types";
import { type Vec2 } from "../sim/geometry";
import type { Catalog } from "../tactics/catalog";
import type { DifficultyBand, MomentRecord, TacticalMoment, TacticalOption } from "../tactics/moments";
import { DEFAULT_PACING, type PacingConfig } from "../tactics/recognition";
import { abandon, commit, createSession, observe, timeout, type CommitResult, type TacticalSession } from "../tactics/session";
import { advanceClock, createClock, NORMAL_SCALE, SLOW_SCALE, type RuntimeClock } from "./clock";
import { beginAftermath, beginHalfTime, beginWindow, createPace, paceScale, paceTicked, type PaceConfig, type PaceState } from "./pace";

/**
 * Match runtime / moment director (plan §3.1). Owns the real-time loop's *decisions*: when the sim
 * ticks and how fast, when a tactical moment opens the decision window, how the window expires, how a
 * drawing or tap becomes a commit against the *current* state, and what the user cancels. It has no
 * DOM, canvas or timers — the screen feeds it frames and pointer paths and reads back what to draw.
 */

/** Decision window in *simulated* seconds by read difficulty (harder reads get less time). */
export const WINDOW_SECONDS: Record<DifficultyBand, number> = { easy: 3.0, medium: 2.5, hard: 2.0 };
/** The tap-based alternative gets more simulated time; time pressure still exists. */
export const ACCESSIBLE_WINDOW_FACTOR = 1.5;
export const TICKS_PER_SECOND = 20;

export type MomentStage =
  /** Options shown, nothing selected. */
  | "reading"
  /** A drawn option is selected; waiting for the drawing (preview while down, commit on release). */
  | "drawing"
  /** Accessible mode: a drawn option is selected; waiting for a target tap. */
  | "targeting";

export interface ActiveWindow {
  moment: TacticalMoment;
  openedTick: number;
  expiresTick: number;
  stage: MomentStage;
  selected: TacticalOption | null;
  /** Live drawing in field metres, present while the pointer is down. */
  preview: GestureRead | null;
  previewPoints: Vec2[];
}

export type MomentCloseReason = "committed" | "timeout" | "intent_unavailable" | "play_stopped";

export interface MomentClosed {
  moment: TacticalMoment;
  reason: MomentCloseReason;
  result: CommitResult;
  record: MomentRecord;
}

export interface FrameResult {
  ticks: number;
  opened: TacticalMoment | null;
  closed: MomentClosed | null;
  /** Engine events emitted during this frame, in order. */
  events: MatchEvent[];
  finished: boolean;
}

export interface RuntimeOptions {
  pacing?: PacingConfig;
  accessible?: boolean;
  pace?: PaceConfig;
}

export interface MatchRuntime {
  readonly state: MatchState;
  readonly session: TacticalSession;
  readonly clock: RuntimeClock;
  /** Real-time budget director: which phase the match is in and what each phase has cost so far. */
  readonly pace: PaceState;
  readonly active: ActiveWindow | null;
  accessible: boolean;
  /** Force routine play to the maximum rate (ignored while a moment is open). */
  fast: boolean;
  paused: boolean;
}

interface Internal extends MatchRuntime {
  active: ActiveWindow | null;
  eventCursor: number;
}

export function createRuntime(cfg: MatchConfig, catalog: Catalog, opts: RuntimeOptions = {}): MatchRuntime {
  const state = createMatch(cfg);
  const rt: Internal = {
    state,
    session: createSession(catalog, opts.pacing ?? DEFAULT_PACING),
    clock: createClock(NORMAL_SCALE),
    pace: createPace(opts.pace),
    active: null,
    accessible: opts.accessible ?? false,
    fast: false,
    paused: false,
    eventCursor: state.events.length,
  };
  return rt;
}

function windowTicks(moment: TacticalMoment, accessible: boolean): number {
  const seconds = WINDOW_SECONDS[moment.difficulty.band] * (accessible ? ACCESSIBLE_WINDOW_FACTOR : 1);
  return Math.round(seconds * TICKS_PER_SECOND);
}

/** Simulated seconds left in the open window (0 when none). */
export function windowRemaining(rt: MatchRuntime): number {
  if (!rt.active) return 0;
  return Math.max(0, rt.active.expiresTick - rt.state.clock.tick) / TICKS_PER_SECOND;
}

/** 0 at open → 1 at expiry. */
export function windowProgress(rt: MatchRuntime): number {
  if (!rt.active) return 0;
  const span = rt.active.expiresTick - rt.active.openedTick;
  return span <= 0 ? 1 : Math.min(1, (rt.state.clock.tick - rt.active.openedTick) / span);
}

function close(rt: Internal, reason: MomentCloseReason, result: CommitResult): MomentClosed {
  const moment = rt.active!.moment;
  rt.active = null;
  rt.clock.scale = NORMAL_SCALE;
  beginAftermath(rt.pace);
  const record = rt.session.records[rt.session.records.length - 1]!;
  return { moment, reason, result, record };
}

function open(rt: Internal, moment: TacticalMoment): void {
  rt.active = {
    moment,
    openedTick: rt.state.clock.tick,
    expiresTick: rt.state.clock.tick + windowTicks(moment, rt.accessible),
    stage: "reading",
    selected: null,
    preview: null,
    previewPoints: [],
  };
  rt.clock.scale = SLOW_SCALE;
  beginWindow(rt.pace);
}

/**
 * Advance one real-time frame. The pace director picks the scale, then the clock says how many
 * whole ticks that frame is worth; before each tick the director checks the window (expiry, play
 * stopping) and lets the tactical session recognise a new moment. Slow motion is literally fewer
 * ticks per frame; fast-forward is more of them.
 */
export function frame(runtime: MatchRuntime, realDtMs: number): FrameResult {
  const rt = runtime as Internal;
  const result: FrameResult = { ticks: 0, opened: null, closed: null, events: [], finished: isFinished(rt.state) };
  if (rt.paused || result.finished) return result;

  rt.clock.scale = paceScale(
    rt.pace,
    { state: rt.state, pacing: rt.session.pacing, momentsSoFar: rt.session.records.length, windowOpen: rt.active !== null, forceFast: rt.fast },
    realDtMs,
  );
  const ticks = advanceClock(rt.clock, realDtMs);
  for (let i = 0; i < ticks && !isFinished(rt.state); i++) {
    if (rt.active) {
      const closed = checkWindow(rt);
      if (closed) result.closed = closed;
    }
    // settles open outcomes every tick; recognises a new moment only when none is active
    const moment = observe(rt.session, rt.state);
    if (moment) {
      open(rt, moment);
      result.opened = moment;
    }
    tick(rt.state);
    result.ticks++;
    paceTicked(rt.pace, TICK_MS);
    // the frame that opened a moment stops ticking at normal speed
    if (moment) break;
  }
  result.events = rt.state.events.slice(rt.eventCursor);
  rt.eventCursor = rt.state.events.length;
  if (result.events.some((e) => e.type === "half_time")) beginHalfTime(rt.pace);
  result.finished = isFinished(rt.state);
  return result;
}

function checkWindow(rt: Internal): MomentClosed | null {
  const w = rt.active!;
  if (rt.state.phase.kind !== "open_play") {
    return close(rt, "play_stopped", abandon(rt.session, rt.state, "Play stopped before the choice landed."));
  }
  if (rt.state.clock.tick >= w.expiresTick) {
    return close(rt, "timeout", timeout(rt.session, rt.state));
  }
  return null;
}

/**
 * The user picked an option. Contextual (non-drawn) intents commit immediately; drawn intents wait
 * for the drawing (or, in accessible mode, a target tap). Returns the close when it committed now.
 */
export function select(runtime: MatchRuntime, optionId: string): MomentClosed | null {
  const rt = runtime as Internal;
  const w = rt.active;
  if (!w) return null;
  const option = w.moment.options.find((o) => o.id === optionId);
  if (!option) throw new Error(`unknown option ${optionId}`);
  if (!option.drawn || !option.anchor) return commitNow(rt, option, 1);
  w.selected = option;
  w.stage = rt.accessible ? "targeting" : "drawing";
  w.preview = null;
  w.previewPoints = [];
  return null;
}

function commitNow(rt: Internal, option: TacticalOption, accuracy: number): MomentClosed {
  const res = commit(rt.session, rt.state, option.id, accuracy);
  return close(rt, res.status === "committed" ? "committed" : "intent_unavailable", res);
}

/** Pointer moved while down: update the preview (field metres). Nothing is committed. */
export function previewGesture(runtime: MatchRuntime, points: readonly Vec2[]): GestureRead | null {
  const rt = runtime as Internal;
  const w = rt.active;
  if (!w || w.stage !== "drawing") return null;
  w.previewPoints = [...points];
  w.preview = isCancelGesture(points) ? null : readGesture(points);
  return w.preview;
}

/**
 * Pointer released: commit the selected option with the drawing's accuracy, measured against the
 * option's anchor as it is *now* (the field moved during the preview). A cancel gesture or a path
 * too short to be a drawing clears the selection and keeps the window running.
 */
export function releaseGesture(runtime: MatchRuntime, points: readonly Vec2[]): MomentClosed | null {
  const rt = runtime as Internal;
  const w = rt.active;
  if (!w || w.stage !== "drawing" || !w.selected) return null;
  w.preview = null;
  w.previewPoints = [];
  const g = readGesture(points);
  if (!g || isCancelGesture(points)) {
    cancel(rt);
    return null;
  }
  const p = playerById(rt.state, w.moment.playerId);
  const anchor = liveAnchor(rt, w.selected);
  const accuracy = anchor ? gestureAccuracy(g, p.pos, anchor) : 1;
  return commitNow(rt, w.selected, accuracy);
}

/** Accessible alternative: tap where the action should go. */
export function tapTarget(runtime: MatchRuntime, point: Vec2): MomentClosed | null {
  const rt = runtime as Internal;
  const w = rt.active;
  if (!w || w.stage !== "targeting" || !w.selected) return null;
  const p = playerById(rt.state, w.moment.playerId);
  const anchor = liveAnchor(rt, w.selected);
  const accuracy = anchor ? tapAccuracy(point, p.pos, anchor) : 1;
  return commitNow(rt, w.selected, accuracy);
}

/** Back to the option list; the window keeps running (spec §12 cancellation). */
export function cancel(runtime: MatchRuntime): void {
  const rt = runtime as Internal;
  const w = rt.active;
  if (!w) return;
  w.selected = null;
  w.stage = "reading";
  w.preview = null;
  w.previewPoints = [];
}

/**
 * Where the option's target is right now: the option was instantiated when the moment opened, but
 * receivers and spaces move during slow motion, so the drawing is judged against the live position.
 */
export function liveAnchor(runtime: MatchRuntime, option: TacticalOption): Vec2 | null {
  if (option.receiver) {
    const r = runtime.state.players.find((q) => q.id === option.receiver);
    if (r) return r.pos;
  }
  return option.anchor;
}

export function setAccessible(runtime: MatchRuntime, on: boolean): void {
  const rt = runtime as Internal;
  if (rt.accessible === on) return;
  rt.accessible = on;
  const w = rt.active;
  if (!w) return;
  // rescale the remaining window so switching mid-moment neither punishes nor gifts time
  const remaining = w.expiresTick - rt.state.clock.tick;
  const factor = on ? ACCESSIBLE_WINDOW_FACTOR : 1 / ACCESSIBLE_WINDOW_FACTOR;
  w.expiresTick = rt.state.clock.tick + Math.max(0, Math.round(remaining * factor));
  if (w.stage === "drawing") w.stage = "targeting";
  else if (w.stage === "targeting") w.stage = "drawing";
}
