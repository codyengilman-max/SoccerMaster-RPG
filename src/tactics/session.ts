import { decideOnBall } from "../sim/ai";
import { issueCommand, resumeDecisions, suspendDecisions } from "../sim/engine";
import { playerById } from "../sim/perception";
import { Rng } from "../sim/rng";
import type { MatchState, PlayerCommand } from "../sim/types";
import type { Catalog } from "./catalog";
import { entryOf, gradeDecision, gradeExecution, kickAfter, resolveOutcome } from "./grading";
import { instantiateIntent } from "./intents";
import type { CommittedIntent, DecisionRecord, MomentRecord, TacticalMoment } from "./moments";
import { createRecognizer, DEFAULT_PACING, recognize, type PacingConfig, type RecognizerState, type RecognitionResult } from "./recognition";

/**
 * Drives one match's tactical moments against the engine: recognise → suspend the controlled
 * player's AI → (user chooses, optionally draws) → commit against the *current* state → grade →
 * watch the event stream for the outcome. Timing (slow motion, decision window) belongs to the
 * match runtime; this layer is headless and deterministic.
 */

export type CommitStatus = "committed" | "intent_unavailable" | "timeout" | "cancelled";

export interface CommitResult {
  status: CommitStatus;
  decision: DecisionRecord;
  committed: CommittedIntent | null;
  /** Command actually issued (fallback continuation when the intent was unavailable or timed out). */
  issued: PlayerCommand | null;
}

export interface TacticalSession {
  catalog: Catalog;
  pacing: PacingConfig;
  recognizer: RecognizerState;
  active: TacticalMoment | null;
  /** Committed moments awaiting outcome resolution. */
  open: { record: MomentRecord; committed: CommittedIntent | null }[];
  records: MomentRecord[];
  /** Ticks where a trigger fired but no moment could be formed — coverage diagnostics. */
  rejects: Record<string, number>;
}

export function createSession(catalog: Catalog, pacing: PacingConfig = DEFAULT_PACING): TacticalSession {
  return { catalog, pacing, recognizer: createRecognizer(), active: null, open: [], records: [], rejects: {} };
}

/** Call once per engine tick (before or after `tick`). Returns a new moment when one starts. */
export function observe(session: TacticalSession, state: MatchState): TacticalMoment | null {
  settleOutcomes(session, state);
  if (session.active) return null;
  const r: RecognitionResult = recognize(state, session.catalog, session.recognizer, session.pacing);
  if (r.reject) session.rejects[r.reject] = (session.rejects[r.reject] ?? 0) + 1;
  if (!r.moment) return null;
  session.active = r.moment;
  suspendDecisions(state, r.moment.playerId);
  return r.moment;
}

function finishActive(session: TacticalSession, state: MatchState, decision: DecisionRecord, committed: CommittedIntent | null): void {
  const moment = session.active;
  if (!moment) return;
  const p = playerById(state, moment.playerId);
  const record: MomentRecord = {
    moment,
    decision,
    execution: committed && p ? gradeExecution(state, p, committed, null) : null,
    outcome: null,
  };
  session.records.push(record);
  session.open.push({ record, committed });
  session.active = null;
  resumeDecisions(state);
}

/**
 * Commit the user's choice. The intent is re-instantiated against the current state so the ball goes
 * where the field is now, and the decision is graded on that state (acceptance check 5).
 * `accuracy` is the gesture precision (1 for non-drawn intents or accessible alternatives).
 */
export function commit(session: TacticalSession, state: MatchState, optionId: string, accuracy = 1): CommitResult {
  const moment = session.active;
  if (!moment) throw new Error("no active moment");
  const p = playerById(state, moment.playerId);
  const option = moment.options.find((o) => o.id === optionId);
  if (!p || !option) throw new Error(`option ${optionId} not in moment ${moment.id}`);

  const inst = instantiateIntent(state, p, option.intent);
  if (!inst) {
    const decision = unavailableDecision(session, state, moment, `${option.label} was no longer available when committed: the field had moved.`);
    decision.chosenOptionId = option.id;
    const issued = continuationDefault(state, moment);
    finishActive(session, state, decision, null);
    return { status: "intent_unavailable", decision, committed: null, issued };
  }
  const decision = gradeDecision(state, session.catalog, moment, option.id);
  const committed: CommittedIntent = { option: { ...option, command: inst.command, anchor: inst.anchor }, command: inst.command, commitTick: state.clock.tick, accuracy };
  issueCommand(state, p.id, inst.command, accuracy);
  finishActive(session, state, decision, committed);
  return { status: "committed", decision, committed, issued: inst.command };
}

/** The decision window expired: resolve through the role's continuation default and record a timeout. */
export function timeout(session: TacticalSession, state: MatchState): CommitResult {
  const moment = session.active;
  if (!moment) throw new Error("no active moment");
  const decision = gradeDecision(state, session.catalog, moment, null);
  const issued = continuationDefault(state, moment);
  finishActive(session, state, decision, null);
  return { status: "timeout", decision, committed: null, issued };
}

/**
 * The situation ended before a choice landed (ball out, whistle): nothing is issued and the record
 * is `intent_unavailable` — the field moved, the player is not marked down for it.
 */
export function abandon(session: TacticalSession, state: MatchState, why: string): CommitResult {
  const moment = session.active;
  if (!moment) throw new Error("no active moment");
  const decision = unavailableDecision(session, state, moment, why);
  finishActive(session, state, decision, null);
  return { status: "intent_unavailable", decision, committed: null, issued: null };
}

function unavailableDecision(session: TacticalSession, state: MatchState, moment: TacticalMoment, why: string): DecisionRecord {
  const decision = gradeDecision(state, session.catalog, moment, null);
  decision.band = "intent_unavailable";
  const best = moment.options.find((o) => o.id === decision.bestOptionId);
  decision.explanation = best ? [why, `${best.label} read best as the situation stood.`] : [why];
  return decision;
}

/** The user cancelled the gesture: the moment stays active (they can pick again) — nothing is committed. */
export function cancelGesture(session: TacticalSession): void {
  if (!session.active) throw new Error("no active moment");
}

/**
 * Role-specific continuation when no choice lands: on the ball, the engine's own evaluator acts
 * (a sensible but unremarkable play); off the ball the player keeps the team shape. Deterministic:
 * the RNG is derived from the state so headless runs stay reproducible.
 */
export function continuationDefault(state: MatchState, moment: TacticalMoment): PlayerCommand | null {
  const p = playerById(state, moment.playerId);
  if (!p) return null;
  const onBall = state.ball.status === "controlled" && state.ball.owner === p.id;
  if (onBall) {
    const rng = new Rng(state.rngState ^ 0x5bd1e995);
    const cmd = decideOnBall(state, p, rng);
    issueCommand(state, p.id, cmd, 1);
    return cmd;
  }
  const inst = instantiateIntent(state, p, "hold_position");
  if (!inst) return null;
  issueCommand(state, p.id, inst.command, 1);
  return inst.command;
}

function settleOutcomes(session: TacticalSession, state: MatchState): void {
  if (session.open.length === 0) return;
  const remaining: typeof session.open = [];
  for (const o of session.open) {
    const outcome = resolveOutcome(state, o.record.moment, o.committed);
    if (!outcome) {
      remaining.push(o);
      continue;
    }
    o.record.outcome = outcome;
    if (o.committed) {
      const p = playerById(state, o.record.moment.playerId);
      const kick = kickAfter(state, o.record.moment.playerId, o.committed.commitTick);
      if (p && kick) o.record.execution = gradeExecution(state, p, o.committed, kick.error);
    }
  }
  session.open = remaining;
}

/** Text feedback for a settled record: field conditions first, outcome last (spec §13). */
export function feedbackFor(session: TacticalSession, record: MomentRecord): string[] {
  const entry = entryOf(session.catalog, record.moment);
  const lines = [...record.decision.explanation];
  if (record.execution) lines.push(`Execution ${record.execution.band} (pressure ${record.execution.pressureAtCommit.toFixed(2)}).`);
  if (record.outcome) lines.push(`Outcome: ${record.outcome.summary}`);
  if (record.decision.band === "weak" && entry.mistakes[0]) lines.push(`Common trap: ${entry.mistakes[0]}`);
  return lines;
}
