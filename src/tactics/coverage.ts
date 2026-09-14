import type { MomentCategory } from "./catalog";
import type { DifficultyBand, MomentRecord } from "./moments";
import type { PacingConfig } from "./recognition";
import { DEFAULT_PACING } from "./recognition";

/** Measurable moment coverage and difficulty for one match (acceptance check 10, spec §14). */
export interface CoverageReport {
  total: number;
  byCategory: Record<MomentCategory, number>;
  /** Moments where the player had or was receiving the ball, whatever the category label. */
  onBall: number;
  byDifficulty: Record<DifficultyBand, number>;
  uniqueEntries: number;
  major: number;
  decisions: { strong: number; acceptable: number; weak: number; timeout: number; intent_unavailable: number };
  outcomes: { success: number; partial: number; failure: number; neutral: number; unresolved: number };
  /** Human-readable shortfalls against the pacing targets; empty when the match met them. */
  shortfalls: string[];
}

export function coverageReport(records: readonly MomentRecord[], pacing: PacingConfig = DEFAULT_PACING): CoverageReport {
  const byCategory: Record<MomentCategory, number> = { on_ball: 0, off_ball: 0, defending: 0, transition: 0 };
  const byDifficulty: Record<DifficultyBand, number> = { easy: 0, medium: 0, hard: 0 };
  const decisions = { strong: 0, acceptable: 0, weak: 0, timeout: 0, intent_unavailable: 0 };
  const outcomes = { success: 0, partial: 0, failure: 0, neutral: 0, unresolved: 0 };
  const entries = new Set<string>();
  let major = 0;
  let onBall = 0;
  for (const r of records) {
    byCategory[r.moment.category]++;
    if (r.moment.read.hasBall === 1 || r.moment.read.receiving === 1) onBall++;
    byDifficulty[r.moment.difficulty.band]++;
    decisions[r.decision.band]++;
    if (r.outcome) outcomes[r.outcome.result]++;
    else outcomes.unresolved++;
    entries.add(r.moment.entryId);
    if (r.moment.major) major++;
  }
  const shortfalls: string[] = [];
  const total = records.length;
  if (total < pacing.total[0]) shortfalls.push(`only ${total} moments (target ${pacing.total[0]}–${pacing.total[1]})`);
  if (total > pacing.total[1]) shortfalls.push(`${total} moments exceeds target ${pacing.total[1]}`);
  if (onBall < pacing.onBall[0]) shortfalls.push(`only ${onBall} on-ball moments (target ${pacing.onBall[0]}–${pacing.onBall[1]})`);
  for (const band of ["easy", "medium", "hard"] as const) if (byDifficulty[band] === 0 && total > 0) shortfalls.push(`no ${band} reads`);
  for (const cat of ["off_ball", "defending", "transition"] as const) if (byCategory[cat] === 0 && total > 0) shortfalls.push(`no ${cat} moments`);
  return { total, byCategory, onBall, byDifficulty, uniqueEntries: entries.size, major, decisions, outcomes, shortfalls };
}
