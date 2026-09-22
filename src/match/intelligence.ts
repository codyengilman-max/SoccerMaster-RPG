import type { Side } from "../sim/rules";
import type { MatchState } from "../sim/types";
import type { Intent } from "../tactics/catalog";
import type { DecisionBand, MomentRecord } from "../tactics/moments";

/**
 * Post-match soccer-intelligence report (spec §9, §14). Every number here is computed from the
 * recorded moments and the finished simulation state — nothing is estimated or narrated. Decision,
 * execution and outcome stay separate: a category score is the mean *decision* quality of the answers
 * the user actually gave; timeouts and engine-selected continuations are counted but never graded
 * as the user's reads.
 */

export type RecognitionCategory = "first_touch" | "pressure" | "passing" | "opposite_side" | "risk" | "position";

export const CATEGORY_LABEL: Record<RecognitionCategory, string> = {
  first_touch: "First touch",
  pressure: "Pressure recognition",
  passing: "Passing selection",
  opposite_side: "Opposite-side recognition",
  risk: "Risk management",
  position: "Position-specific understanding",
};

export interface CategoryScore {
  category: RecognitionCategory;
  label: string;
  /** Moments that belonged to the category. */
  moments: number;
  /** Of those, moments the user answered (graded). */
  graded: number;
  /** Answers that were the highest-rated option at the time. */
  best: number;
  /** Mean decision quality of the graded answers; null when nothing was graded. */
  quality: number | null;
  band: DecisionBand | null;
}

export interface MomentRef {
  momentId: string;
  timeMs: number;
  title: string;
  chosen: string;
  decision: DecisionBand | "timeout" | "intent_unavailable";
  execution: string | null;
  outcome: string | null;
  summary: string | null;
}

export interface IntelligenceReport {
  result: {
    home: string;
    away: string;
    score: { home: number; away: number };
    /** From the controlled side's point of view; null when no side was controlled. */
    forControlled: "win" | "draw" | "loss" | null;
    /** True only when the simulation reached full time. */
    verified: boolean;
    goalsInLedger: number;
  };
  moments: number;
  answered: number;
  timeouts: number;
  engineActed: number;
  overall: { quality: number | null; band: DecisionBand | null };
  categories: CategoryScore[];
  strongest: CategoryScore | null;
  weakest: CategoryScore | null;
  /** The user's answer was the best option and the character's execution or the play still failed. */
  correctButFailed: MomentRef[];
  /** A weak answer that the continuing simulation nonetheless rewarded. */
  poorButFavorable: MomentRef[];
  teachingPoint: string;
}

const PASS_INTENTS: readonly Intent[] = ["through_gap", "switch_play", "recycle", "keeper_distribute_short", "keeper_distribute_long"];
const OPPOSITE_SIDE_INTENTS: readonly Intent[] = ["switch_play", "narrow_inside"];
const SAFE_INTENTS: readonly Intent[] = ["recycle", "hold_ball", "first_touch_safe", "keeper_distribute_short", "delay", "cover", "hold_position", "keeper_hold_line", "drop"];
const BOLD_INTENTS: readonly Intent[] = ["shoot", "through_gap", "attack_space", "first_touch_forward", "run_behind", "press", "keeper_sweep", "keeper_step_up", "draw_defender"];
const PRESSURE_DIST_M = 4;
const PRESSURE_LEVEL = 0.35;

export function bandFor(quality: number): DecisionBand {
  return quality >= 0.85 ? "strong" : quality >= 0.55 ? "acceptable" : "weak";
}

const hasIntent = (r: MomentRecord, intents: readonly Intent[]): boolean => r.moment.options.some((o) => intents.includes(o.intent));

export function categoriesOf(r: MomentRecord): RecognitionCategory[] {
  const out: RecognitionCategory[] = [];
  const m = r.moment;
  if (m.involvement === "first_touch") out.push("first_touch");
  if (m.read.pressure >= PRESSURE_LEVEL || m.read.nearestOppDist <= PRESSURE_DIST_M) out.push("pressure");
  if (m.options.filter((o) => PASS_INTENTS.includes(o.intent)).length >= 2) out.push("passing");
  if (hasIntent(r, OPPOSITE_SIDE_INTENTS)) out.push("opposite_side");
  if (hasIntent(r, SAFE_INTENTS) && hasIntent(r, BOLD_INTENTS)) out.push("risk");
  if (m.category !== "on_ball" || m.role === "GK") out.push("position");
  return out;
}

const userGraded = (r: MomentRecord): boolean => r.decision.quality !== null && r.decision.chosenOptionId !== null;

function scoreCategory(category: RecognitionCategory, records: readonly MomentRecord[]): CategoryScore {
  const mine = records.filter((r) => categoriesOf(r).includes(category));
  const graded = mine.filter(userGraded);
  const quality = graded.length ? graded.reduce((a, r) => a + (r.decision.quality ?? 0), 0) / graded.length : null;
  return {
    category,
    label: CATEGORY_LABEL[category],
    moments: mine.length,
    graded: graded.length,
    best: graded.filter((r) => r.decision.chosenOptionId === r.decision.bestOptionId).length,
    quality,
    band: quality === null ? null : bandFor(quality),
  };
}

function ref(r: MomentRecord): MomentRef {
  const chosen = r.acted?.label ?? r.moment.options.find((o) => o.id === r.decision.chosenOptionId)?.label ?? "—";
  return {
    momentId: r.moment.id,
    timeMs: r.moment.timeMs,
    title: r.moment.title,
    chosen,
    decision: r.decision.band,
    execution: r.execution?.band ?? null,
    outcome: r.outcome?.result ?? null,
    summary: r.outcome?.summary ?? null,
  };
}

const TEACHING: Record<RecognitionCategory, string> = {
  first_touch: "take the picture before the ball arrives so the first touch already points at the next action.",
  pressure: "check the nearest defender before receiving — pressure decides whether the touch goes forward or safe.",
  passing: "pick the pass that moves the team forward and keeps the ball, not the one that only looks ambitious.",
  opposite_side: "when one side is crowded, find the spare player on the other side before forcing it.",
  risk: "protect the ball when the picture is closed; attack the space when it is open.",
  position: "your starting position decides what you can do next — be in the right place before the ball asks you to be.",
};

function teachingPointFor(categories: CategoryScore[], weakest: CategoryScore | null, answered: number, timeouts: number): string {
  if (answered === 0) {
    return timeouts > 0
      ? `Coach Code: the character had to play on without you ${timeouts} time${timeouts === 1 ? "" : "s"}. Next match, pick an answer before the clock runs out — a decision teaches us more than a timeout.`
      : "Coach Code: no reads were recorded this match, so there is nothing to grade yet.";
  }
  const c = weakest ?? categories.find((k) => k.graded > 0) ?? null;
  if (!c) return "Coach Code: keep reading the field before the ball arrives.";
  return `Coach Code: ${c.label.toLowerCase()} — you picked the highest-rated answer in ${c.best} of ${c.graded} ${c.graded === 1 ? "moment" : "moments"}. Next match, ${TEACHING[c.category]}`;
}

export function intelligenceReport(state: MatchState, records: readonly MomentRecord[]): IntelligenceReport {
  const graded = records.filter(userGraded);
  const timeouts = records.filter((r) => r.decision.band === "timeout").length;
  const engineActed = records.filter((r) => r.acted?.actor === "engine").length;
  const overallQ = graded.length ? graded.reduce((a, r) => a + (r.decision.quality ?? 0), 0) / graded.length : null;
  const categories = (Object.keys(CATEGORY_LABEL) as RecognitionCategory[]).map((c) => scoreCategory(c, records));
  const ranked = categories.filter((c) => c.quality !== null && c.graded >= 2).sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
  const strongest = ranked[0] ?? null;
  const weakest = ranked.length > 1 ? ranked[ranked.length - 1]! : null;
  const side: Side | null = state.controlled?.side ?? null;
  const mine = side ? state.score[side] : null;
  const theirs = side ? state.score[side === "home" ? "away" : "home"] : null;
  return {
    result: {
      home: state.home.name,
      away: state.away.name,
      score: { ...state.score },
      forControlled: mine === null || theirs === null ? null : mine > theirs ? "win" : mine < theirs ? "loss" : "draw",
      verified: state.phase.kind === "full_time",
      goalsInLedger: state.events.filter((e) => e.type === "goal").length,
    },
    moments: records.length,
    answered: graded.length,
    timeouts,
    engineActed,
    overall: { quality: overallQ, band: overallQ === null ? null : bandFor(overallQ) },
    categories,
    strongest,
    weakest,
    correctButFailed: records
      .filter((r) => userGraded(r) && r.decision.chosenOptionId === r.decision.bestOptionId && (r.execution?.band === "poor" || r.outcome?.result === "failure"))
      .map(ref),
    poorButFavorable: records.filter((r) => userGraded(r) && r.decision.band === "weak" && r.outcome?.result === "success").map(ref),
    teachingPoint: teachingPointFor(categories, weakest, graded.length, timeouts),
  };
}
