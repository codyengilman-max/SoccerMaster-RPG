import { clamp } from "../sim/geometry";
import { playerById } from "../sim/perception";
import type { MatchState, PlayerState, RoleId } from "../sim/types";
import { allHold, DRAWN_INTENTS, triggerFires, type Catalog, type CatalogEntry, type MomentCategory } from "./catalog";
import { readField, roleOf, type FieldRead } from "./features";
import { instantiateIntent } from "./intents";
import type { Difficulty, TacticalMoment, TacticalOption } from "./moments";

/**
 * Turns the live simulation into tactical moments for the controlled player (spec §9, §14).
 * Moments emerge from eligible field states matched against the catalog; a pacing controller keeps
 * the count near the target band without manufacturing situations. Shortfalls are recorded, not hidden.
 */

/**
 * Official-match "meaningful direct involvement" policy (spec §9). Outfield moments freeze at the
 * player's first controlled contact; a small minority of defending decisions is admitted only when
 * the ball is not arriving often enough. Goalkeepers additionally get authentic positioning and
 * intervention decisions (cross, 1v1, sweep, shot, backpass, distribution) without inventing touches.
 */
export interface DirectPolicy {
  /** Fewest distinct, currently available answers a state must support to become a moment. */
  minOptions: number;
  /** Most answers shown. */
  maxOptions: number;
  /** Off-ball categories that count as direct involvement for this role. */
  offBall: readonly MomentCategory[];
  /** Cap on off-ball moments per match (outfield: keeps the mix overwhelmingly on-ball). */
  maxOffBall: number;
  /** Same catalog entry at most this many times per match. */
  maxPerEntry: number;
  /** On-ball moments open within this many ticks of the first controlled contact (unless behind schedule). */
  firstContactTicks: number;
}

export interface PacingConfig {
  /** Target total moments per match (inclusive band). */
  total: [number, number];
  onBall: [number, number];
  /** Base minimum gap between moments, simulated seconds. */
  minGapSeconds: number;
  /** Don't repeat the same catalog entry within this many seconds. */
  repeatGapSeconds: number;
  /** Present: official direct-involvement selection. Absent: the legacy metered mix (training tools, older tests). */
  direct?: DirectPolicy;
}

/** Legacy metered mix kept for headless tooling; official matches use `DIRECT_PACING` / `GK_DIRECT_PACING`. */
export const DEFAULT_PACING: PacingConfig = {
  total: [18, 25],
  onBall: [10, 14],
  minGapSeconds: 60,
  repeatGapSeconds: 180,
};

/** Legacy goalkeeper mix (OPEN_QUESTIONS #10). */
export const GK_PACING: PacingConfig = {
  total: [18, 25],
  onBall: [7, 12],
  minGapSeconds: 60,
  repeatGapSeconds: 180,
};

/** Hard player-facing range for a completed official match. */
export const DIRECT_RANGE: readonly [number, number] = [12, 18];

export const DIRECT_PACING: PacingConfig = {
  total: [DIRECT_RANGE[0], DIRECT_RANGE[1]],
  onBall: [DIRECT_RANGE[0], DIRECT_RANGE[1]],
  minGapSeconds: 45,
  repeatGapSeconds: 60,
  direct: { minOptions: 3, maxOptions: 6, offBall: ["defending"], maxOffBall: 3, maxPerEntry: 6, firstContactTicks: 6 },
};

/**
 * Goalkeeper direct involvement: backpasses and distribution are on-ball; crosses, 1v1s, sweeps,
 * shots and starting position are authentic keeper decisions even when the best answer is to hold.
 */
export const GK_DIRECT_PACING: PacingConfig = {
  total: [DIRECT_RANGE[0], DIRECT_RANGE[1]],
  onBall: [2, DIRECT_RANGE[1]],
  minGapSeconds: 30,
  repeatGapSeconds: 150,
  direct: { minOptions: 3, maxOptions: 6, offBall: ["defending", "transition", "off_ball"], maxOffBall: DIRECT_RANGE[1], maxPerEntry: 5, firstContactTicks: 6 },
};

/** Official-match pacing for a role. */
export function pacingFor(role: RoleId): PacingConfig {
  return role === "GK" ? GK_DIRECT_PACING : DIRECT_PACING;
}

/** The metered mix used before direct involvement; kept for tools that still compare against it. */
export function legacyPacingFor(role: RoleId): PacingConfig {
  return role === "GK" ? GK_PACING : DEFAULT_PACING;
}

export interface RecognizerState {
  lastMomentTick: number;
  lastByEntry: Record<string, number>;
  /** Times each entry has been used this match. */
  usesByEntry: Record<string, number>;
  count: number;
  /** Moments where the player had or was receiving the ball (any category). */
  onBallCount: number;
  byCategory: Record<MomentCategory, number>;
  seq: number;
  /** Tick the controlled player's current possession spell began; -1 when not in possession. */
  controlSinceTick: number;
}

export function createRecognizer(): RecognizerState {
  return {
    lastMomentTick: -Infinity,
    lastByEntry: {},
    usesByEntry: {},
    count: 0,
    onBallCount: 0,
    byCategory: { on_ball: 0, off_ball: 0, defending: 0, transition: 0 },
    seq: 0,
    controlSinceTick: -1,
  };
}

/** JSON-safe copy of the recognizer (the `-Infinity` sentinel does not survive JSON). */
export function serializeRecognizer(rec: RecognizerState): RecognizerState {
  return { ...rec, lastMomentTick: Number.isFinite(rec.lastMomentTick) ? rec.lastMomentTick : -1_000_000, lastByEntry: { ...rec.lastByEntry }, usesByEntry: { ...rec.usesByEntry }, byCategory: { ...rec.byCategory } };
}

/** Why recognition declined this tick; exposed for tests and coverage diagnostics (acceptance check 9). */
export type RejectReason =
  | "no_controlled_player"
  | "not_open_play"
  | "ball_dead"
  | "moment_pending"
  | "finished"
  | "too_soon"
  | "cap_reached"
  | "no_trigger"
  | "too_few_options";

export interface RecognitionResult {
  moment: TacticalMoment | null;
  reject: RejectReason | null;
}

/** Score one catalog action against the field read plus its live feasibility. */
export function scoreAction(entry: CatalogEntry, actionId: string, read: FieldRead, feasibility: number): { score: number; reasons: string[] } {
  const a = entry.actions.find((x) => x.id === actionId);
  if (!a) return { score: -Infinity, reasons: [] };
  let score = a.base + feasibility * 0.8;
  const reasons: string[] = [];
  for (const c of a.eval) {
    if (allHold(read, c.when)) {
      score += c.add;
      reasons.push(c.why);
    }
  }
  return { score, reasons };
}

/** Build the concrete, scored options for `entry` in the current state. Fewer than two ⇒ not a moment. */
export function buildOptions(state: MatchState, p: PlayerState, entry: CatalogEntry, read: FieldRead, momentId: string): TacticalOption[] {
  const options: TacticalOption[] = [];
  const seen = new Set<string>();
  for (const a of entry.actions) {
    const inst = instantiateIntent(state, p, a.intent);
    if (!inst) continue;
    const key = JSON.stringify(inst.command);
    if (seen.has(key)) continue;
    seen.add(key);
    const { score, reasons } = scoreAction(entry, a.id, read, inst.feasibility);
    const opt: TacticalOption = {
      id: `${momentId}:${a.id}`,
      actionId: a.id,
      label: a.label,
      intent: a.intent,
      drawn: DRAWN_INTENTS.has(a.intent),
      command: inst.command,
      anchor: inst.anchor,
      score,
      feasibility: inst.feasibility,
      reasons: [...reasons, inst.detail],
    };
    if (inst.receiver !== undefined) opt.receiver = inst.receiver;
    options.push(opt);
  }
  return options;
}

export function difficultyOf(options: readonly TacticalOption[], read: FieldRead): Difficulty {
  const sorted = [...options].sort((a, b) => b.score - a.score);
  const best = sorted[0]?.score ?? 0;
  const second = sorted[1]?.score ?? best;
  const clarity = clamp((best - second) / 0.8, 0, 1);
  const alternatives = options.length;
  const score = clamp(0.45 * (1 - clarity) + 0.35 * read.pressure + 0.1 * clamp((alternatives - 2) / 2, 0, 1) + 0.1 * clamp(1 - read.nearestOppDist / 10, 0, 1), 0, 1);
  const band = score < 0.35 ? "easy" : score < 0.65 ? "medium" : "hard";
  return { band, clarity, pressure: read.pressure, alternatives, score };
}

function isMajor(entry: CatalogEntry, read: FieldRead, state: MatchState): boolean {
  const late = state.clock.timeMs > state.rules.halves * state.rules.halfLengthSeconds * 1000 - 5 * 60_000;
  return entry.phase === "final_third" || read.ballInOurBox === 1 || read.shotWindow > 0.3 || (late && Math.abs(read.scoreDiff) <= 1);
}

interface Allowance {
  onBall: boolean;
  other: boolean;
}

/**
 * Direct-involvement pacing. Supply is uneven (a striker may see the ball 40 times, a centre back
 * 20), so the gap between moments tightens when the count is behind the even-spread schedule and
 * widens when ahead; the hard cap is never exceeded. Off-ball decisions are metered against the
 * schedule and, for outfield players, capped so the match stays overwhelmingly on-ball.
 */
function directAllowance(rec: RecognizerState, state: MatchState, pacing: PacingConfig, policy: DirectPolicy): DirectAllowance {
  const totalS = state.rules.halves * state.rules.halfLengthSeconds;
  const elapsedS = state.clock.timeMs / 1000;
  const frac = clamp(elapsedS / totalS, 0, 1);
  const [lo, hi] = pacing.total;
  // aim high inside the range: every extra involvement is a real touch the player gets to read
  const target = lo + (hi - lo) * 0.8;
  const expected = target * frac;
  const remainingS = Math.max(1, totalS - elapsedS);
  const behind = rec.count < expected - 1.5;
  const ahead = rec.count > expected + 1.5;
  const sinceLast = (state.clock.tick - rec.lastMomentTick) * 0.05;
  const shortfall = lo - rec.count;
  // the remaining match can no longer supply the floor at a comfortable spacing: take what comes
  const urgent = shortfall > 0 && remainingS / shortfall < 150;
  const relaxed = behind || urgent;
  const onGap = urgent ? 3 : behind ? 10 : ahead ? pacing.minGapSeconds * 2.5 : pacing.minGapSeconds;
  // spread moments across the whole match instead of exhausting the range early
  const room = rec.count < hi && (rec.count < Math.ceil(expected) + 3 || frac > 0.9);
  const onBall = room && sinceLast >= onGap;
  const offCount = rec.count - rec.onBallCount;
  const offGap = urgent ? 12 : behind ? 20 : pacing.minGapSeconds * 1.5;
  const keeper = policy.offBall.length > 1;
  const other = room && offCount < policy.maxOffBall && sinceLast >= offGap && (keeper ? !ahead || urgent : relaxed);
  return { onBall, other, anyTickOfControl: relaxed, ignoreEntryCap: relaxed };
}

interface DirectAllowance extends Allowance {
  /** Behind schedule: accept a controlled-possession moment even after the first contact. */
  anyTickOfControl: boolean;
  /** Behind schedule: the per-entry variety cap yields to the 12–18 floor. */
  ignoreEntryCap: boolean;
}

/**
 * Legacy pacing: on-ball moments are scarce (the player only has the ball so often), so they are
 * allowed with a short gap whenever they appear, up to their band. Off-ball/defending/transition
 * states are abundant, so they are metered to the remaining share of the target across the match.
 */
function allowance(rec: RecognizerState, state: MatchState, pacing: PacingConfig): Allowance {
  const total = state.rules.halves * state.rules.halfLengthSeconds;
  const frac = clamp(state.clock.timeMs / 1000 / total, 0, 1);
  const totalMid = (pacing.total[0] + pacing.total[1]) / 2;
  const onMid = (pacing.onBall[0] + pacing.onBall[1]) / 2;
  const otherCount = rec.count - rec.onBallCount;
  const sinceLast = (state.clock.tick - rec.lastMomentTick) * 0.05;
  const onBall = rec.onBallCount < pacing.onBall[1] && rec.onBallCount <= onMid * frac + 2 && sinceLast >= pacing.minGapSeconds * 0.1;
  let other = otherCount <= (totalMid - onMid) * frac + 1 && sinceLast >= pacing.minGapSeconds;
  // when on-ball moments are running short, let other responsibilities keep the match near target
  if (!other && rec.count < totalMid * frac - 2 && sinceLast >= pacing.minGapSeconds) other = true;
  return { onBall, other };
}

function ticksSinceResume(state: MatchState): number {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i];
    if (e && (e.type === "restart" || e.type === "kickoff")) return state.clock.tick - e.tick;
  }
  return state.clock.tick;
}

export function recognize(state: MatchState, catalog: Catalog, rec: RecognizerState, pacing: PacingConfig = DEFAULT_PACING): RecognitionResult {
  if (!state.controlled) return { moment: null, reject: "no_controlled_player" };
  const hasBall = state.ball.status === "controlled" && state.ball.owner === state.controlled.playerId;
  if (!hasBall) rec.controlSinceTick = -1;
  else if (rec.controlSinceTick < 0) rec.controlSinceTick = state.clock.tick;
  if (state.phase.kind === "full_time") return { moment: null, reject: "finished" };
  if (state.phase.kind !== "open_play") return { moment: null, reject: "not_open_play" };
  if (state.ball.status === "dead") return { moment: null, reject: "ball_dead" };
  if (state.awaiting !== null) return { moment: null, reject: "moment_pending" };
  if (rec.count >= pacing.total[1]) return { moment: null, reject: "cap_reached" };

  const p = playerById(state, state.controlled.playerId);
  if (!p) return { moment: null, reject: "no_controlled_player" };
  const direct = pacing.direct;
  const allow: DirectAllowance = direct ? directAllowance(rec, state, pacing, direct) : { ...allowance(rec, state, pacing), anyTickOfControl: true, ignoreEntryCap: true };
  if (!allow.onBall && !allow.other) return { moment: null, reject: "too_soon" };

  const read = readField(state, p);
  const onBallMoment = direct ? hasBall : read.hasBall === 1 || read.receiving === 1;
  if (onBallMoment ? !allow.onBall : !allow.other) return { moment: null, reject: "too_soon" };
  // official moments freeze at first controlled contact; mid-carry decisions only when the count is behind
  if (direct && onBallMoment && !allow.anyTickOfControl && state.clock.tick - rec.controlSinceTick > direct.firstContactTicks) return { moment: null, reject: "too_soon" };
  // right after a restart the shape is still settling; the taker's own delivery is a legitimate moment though
  if (!onBallMoment && ticksSinceResume(state) < 3 / 0.05) return { moment: null, reject: "too_soon" };
  const entries = catalog.byRole.get(roleOf(p)) ?? [];
  const repeatTicks = pacing.repeatGapSeconds / 0.05;
  const minOptions = direct?.minOptions ?? 2;

  let best: { entry: CatalogEntry; options: TacticalOption[]; salience: number } | null = null;
  let sawTrigger = false;
  const momentId = `${state.matchId}:m${rec.seq}`;
  for (const entry of entries) {
    if (entry.restrictions.requiresOffside && !state.rules.offside) continue;
    if (!triggerFires(read, entry.trigger)) continue;
    if (direct && !onBallMoment && !direct.offBall.includes(entry.category)) continue;
    if (direct && !allow.ignoreEntryCap && (rec.usesByEntry[entry.id] ?? 0) >= direct.maxPerEntry) continue;
    sawTrigger = true;
    const last = rec.lastByEntry[entry.id];
    const recent = last !== undefined && state.clock.tick - last < repeatTicks;
    const options = buildOptions(state, p, entry, read, momentId);
    if (options.length < minOptions) continue;
    const top = Math.max(...options.map((o) => o.score));
    // prefer consequential, varied situations; on-ball moments carry the target mix
    let salience = top + (entry.category === "transition" ? 0.3 : 0) - (recent ? 1.0 : 0);
    if (rec.byCategory[entry.category] === 0 && rec.count >= 4) salience += 0.4;
    if (direct) salience += directSalience(entry, read) - 0.15 * (rec.usesByEntry[entry.id] ?? 0);
    if (!best || salience > best.salience) best = { entry, options, salience };
  }
  if (!best) return { moment: null, reject: sawTrigger ? "too_few_options" : "no_trigger" };

  const options = direct ? trimOptions(best.options, direct.maxOptions) : best.options;
  const moment: TacticalMoment = {
    id: momentId,
    tick: state.clock.tick,
    timeMs: state.clock.timeMs,
    entryId: best.entry.id,
    title: best.entry.title,
    category: best.entry.category,
    phase: best.entry.phase,
    role: best.entry.role,
    playerId: p.id,
    cues: best.entry.cues,
    options,
    difficulty: difficultyOf(options, read),
    major: isMajor(best.entry, read, state),
    involvement: onBallMoment ? (state.clock.tick - rec.controlSinceTick <= (direct?.firstContactTicks ?? 6) ? "first_touch" : "on_ball") : "off_ball",
    read,
  };
  rec.seq++;
  rec.count++;
  rec.lastMomentTick = state.clock.tick;
  rec.lastByEntry[best.entry.id] = state.clock.tick;
  rec.usesByEntry[best.entry.id] = (rec.usesByEntry[best.entry.id] ?? 0) + 1;
  rec.byCategory[best.entry.category]++;
  if (onBallMoment) rec.onBallCount++;
  return { moment, reject: null };
}

/**
 * What makes a state worth stopping for: the ball in a scoring area, pressure that forces a real
 * choice, a keeper intervention (cross, 1v1, sweep, shot) over a quiet starting-position check.
 */
function directSalience(entry: CatalogEntry, read: FieldRead): number {
  let s = 0;
  if (entry.category === "on_ball") s += 0.6;
  if (entry.phase === "final_third") s += 0.3;
  if (read.ballInOurBox === 1 || read.shotWindow > 0.3) s += 0.3;
  s += 0.25 * read.pressure;
  if (entry.role === "GK") {
    if (/CROSS|1V1|SWEEP|SHOT/.test(entry.id)) s += 0.5;
    else if (/POS|LINE/.test(entry.id)) s -= 0.3;
  }
  return s;
}

/**
 * Never show more than `max` answers. The engine's highest-scoring option is always kept (the
 * answer-set integrity rule), then the rest by score; the displayed order stays the catalog order.
 */
function trimOptions(options: TacticalOption[], max: number): TacticalOption[] {
  if (options.length <= max) return options;
  const keep = new Set([...options].sort((a, b) => b.score - a.score).slice(0, max).map((o) => o.id));
  return options.filter((o) => keep.has(o.id));
}
