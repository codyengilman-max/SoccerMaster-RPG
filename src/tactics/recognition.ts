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

export interface PacingConfig {
  /** Target total moments per match (inclusive band). */
  total: [number, number];
  onBall: [number, number];
  /** Base minimum gap between moments, simulated seconds. */
  minGapSeconds: number;
  /** Don't repeat the same catalog entry within this many seconds. */
  repeatGapSeconds: number;
}

export const DEFAULT_PACING: PacingConfig = {
  total: [18, 25],
  onBall: [10, 14],
  minGapSeconds: 60,
  repeatGapSeconds: 180,
};

/** Goalkeepers see the ball less often (OPEN_QUESTIONS #10). */
export const GK_PACING: PacingConfig = {
  total: [12, 18],
  onBall: [6, 9],
  minGapSeconds: 60,
  repeatGapSeconds: 180,
};

export function pacingFor(role: RoleId): PacingConfig {
  return role === "GK" ? GK_PACING : DEFAULT_PACING;
}

export interface RecognizerState {
  lastMomentTick: number;
  lastByEntry: Record<string, number>;
  count: number;
  /** Moments where the player had or was receiving the ball (any category). */
  onBallCount: number;
  byCategory: Record<MomentCategory, number>;
  seq: number;
}

export function createRecognizer(): RecognizerState {
  return {
    lastMomentTick: -Infinity,
    lastByEntry: {},
    count: 0,
    onBallCount: 0,
    byCategory: { on_ball: 0, off_ball: 0, defending: 0, transition: 0 },
    seq: 0,
  };
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
 * Pacing: on-ball moments are scarce (the player only has the ball so often), so they are allowed
 * with a short gap whenever they appear, up to their band. Off-ball/defending/transition states are
 * abundant, so they are metered to the remaining share of the target, spread across the match.
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
  if (state.phase.kind === "full_time") return { moment: null, reject: "finished" };
  if (state.phase.kind !== "open_play") return { moment: null, reject: "not_open_play" };
  if (state.ball.status === "dead") return { moment: null, reject: "ball_dead" };
  if (state.awaiting !== null) return { moment: null, reject: "moment_pending" };
  if (rec.count >= pacing.total[1]) return { moment: null, reject: "cap_reached" };

  const p = playerById(state, state.controlled.playerId);
  if (!p) return { moment: null, reject: "no_controlled_player" };
  const allow = allowance(rec, state, pacing);
  if (!allow.onBall && !allow.other) return { moment: null, reject: "too_soon" };

  const read = readField(state, p);
  const onBallMoment = read.hasBall === 1 || read.receiving === 1;
  if (onBallMoment ? !allow.onBall : !allow.other) return { moment: null, reject: "too_soon" };
  // right after a restart the shape is still settling; the taker's own delivery is a legitimate moment though
  if (!onBallMoment && ticksSinceResume(state) < 3 / 0.05) return { moment: null, reject: "too_soon" };
  const entries = catalog.byRole.get(roleOf(p)) ?? [];
  const repeatTicks = pacing.repeatGapSeconds / 0.05;

  let best: { entry: CatalogEntry; options: TacticalOption[]; salience: number } | null = null;
  let sawTrigger = false;
  const momentId = `${state.matchId}:m${rec.seq}`;
  for (const entry of entries) {
    if (entry.restrictions.requiresOffside && !state.rules.offside) continue;
    if (!triggerFires(read, entry.trigger)) continue;
    sawTrigger = true;
    const last = rec.lastByEntry[entry.id];
    const recent = last !== undefined && state.clock.tick - last < repeatTicks;
    const options = buildOptions(state, p, entry, read, momentId);
    if (options.length < 2) continue;
    const top = Math.max(...options.map((o) => o.score));
    // prefer consequential, varied situations; on-ball moments carry the target mix
    let salience = top + (entry.category === "transition" ? 0.3 : 0) - (recent ? 1.0 : 0);
    if (rec.byCategory[entry.category] === 0 && rec.count >= 4) salience += 0.4;
    if (!best || salience > best.salience) best = { entry, options, salience };
  }
  if (!best) return { moment: null, reject: sawTrigger ? "too_few_options" : "no_trigger" };

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
    options: best.options,
    difficulty: difficultyOf(best.options, read),
    major: isMajor(best.entry, read, state),
    read,
  };
  rec.seq++;
  rec.count++;
  rec.lastMomentTick = state.clock.tick;
  rec.lastByEntry[best.entry.id] = state.clock.tick;
  rec.byCategory[best.entry.category]++;
  if (onBallMoment) rec.onBallCount++;
  return { moment, reject: null };
}
