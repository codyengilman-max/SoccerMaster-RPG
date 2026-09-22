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
 * player's AI → (user answers) → commit against the *current* state → grade → the engine executes →
 * watch the event stream for the outcome. Timing (lead-in, freeze, 15-second timer) belongs to the
 * match runtime; this layer is headless and deterministic.
 */

export type CommitStatus = "committed" | "intent_unavailable" | "timeout" | "cancelled";

export interface CommitResult {
  status: CommitStatus;
  decision: DecisionRecord;
  /** What the character carried out. `actor: "engine"` when the user did not choose (timeout / intent gone). */
  acted: CommittedIntent | null;
  /** Command actually issued to the engine, whoever chose it. */
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
  settle(session, state);
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
    acted: committed,
    execution: committed && p ? gradeExecution(state, p, committed, null) : null,
    outcome: null,
  };
  session.records.push(record);
  session.open.push({ record, committed });
  session.active = null;
  resumeDecisions(state);
}

/**
 * Commit the user's answer. The intent is re-instantiated against the current state so the ball goes
 * where the field is now, and the decision is graded on that state (acceptance check 5). The engine
 * then executes the command itself: there is no execution input.
 */
export function commit(session: TacticalSession, state: MatchState, optionId: string): CommitResult {
  const moment = session.active;
  if (!moment) throw new Error("no active moment");
  const p = playerById(state, moment.playerId);
  const option = moment.options.find((o) => o.id === optionId);
  if (!p || !option) throw new Error(`option ${optionId} not in moment ${moment.id}`);

  const inst = instantiateIntent(state, p, option.intent);
  if (!inst) {
    const decision = unavailableDecision(session, state, moment, `${option.label} was no longer available when committed: the field had moved.`);
    decision.chosenOptionId = option.id;
    const acted = engineContinuation(state, moment);
    finishActive(session, state, decision, acted);
    return { status: "intent_unavailable", decision, acted, issued: acted?.command ?? null };
  }
  const decision = gradeDecision(state, session.catalog, moment, option.id);
  const acted: CommittedIntent = { momentId: moment.id, actor: "user", optionId: option.id, label: option.label, command: inst.command, commitTick: state.clock.tick };
  issueCommand(state, p.id, inst.command, 1);
  finishActive(session, state, decision, acted);
  return { status: "committed", decision, acted, issued: inst.command };
}

/**
 * The 15-second timer expired: no user decision is graded. The engine picks the character's action
 * so the match continues; that action is recorded as engine-selected and its execution is graded on
 * its own — it is never presented as the user's choice.
 */
export function timeout(session: TacticalSession, state: MatchState): CommitResult {
  const moment = session.active;
  if (!moment) throw new Error("no active moment");
  const decision = gradeDecision(state, session.catalog, moment, null);
  const acted = engineContinuation(state, moment);
  if (acted) decision.explanation.push(`The character played on without you: ${acted.label}.`);
  finishActive(session, state, decision, acted);
  return { status: "timeout", decision, acted, issued: acted?.command ?? null };
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
  return { status: "intent_unavailable", decision, acted: null, issued: null };
}

function unavailableDecision(session: TacticalSession, state: MatchState, moment: TacticalMoment, why: string): DecisionRecord {
  const decision = gradeDecision(state, session.catalog, moment, null);
  decision.band = "intent_unavailable";
  const best = moment.options.find((o) => o.id === decision.bestOptionId);
  decision.explanation = best ? [why, `${best.label} read best as the situation stood.`] : [why];
  return decision;
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

/** The engine's continuation as a recorded, engine-attributed action (matched to a displayed answer when one has the same command). */
function engineContinuation(state: MatchState, moment: TacticalMoment): CommittedIntent | null {
  const cmd = continuationDefault(state, moment);
  if (!cmd) return null;
  const key = JSON.stringify(cmd);
  const shown = moment.options.find((o) => JSON.stringify(o.command) === key) ?? null;
  return {
    momentId: moment.id,
    actor: "engine",
    optionId: shown?.id ?? null,
    label: shown?.label ?? describeCommand(cmd),
    command: cmd,
    commitTick: state.clock.tick,
  };
}

/** Plain-language name for an engine command that matched none of the displayed answers. */
export function describeCommand(cmd: PlayerCommand): string {
  switch (cmd.type) {
    case "pass":
      return "Pass to a teammate";
    case "shoot":
      return "Shoot";
    case "carry":
      return "Carry the ball";
    case "hold":
      return "Hold the ball";
    case "first_touch":
      return "Take a touch";
    case "move":
      return "Hold the team shape";
    case "press":
      return "Press the carrier";
    case "screen":
      return "Screen the passing lane";
  }
}

/** Resolve open outcomes from the events the engine has recorded since each commit; recognises nothing. */
export function settle(session: TacticalSession, state: MatchState): void {
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
  if (record.execution) {
    const who = record.execution.actor === "engine" ? "Execution (engine-selected action)" : "Execution";
    lines.push(`${who} ${record.execution.band} (pressure ${record.execution.pressureAtCommit.toFixed(2)}).`);
  }
  if (record.outcome) lines.push(`Outcome: ${record.outcome.summary}`);
  if (record.decision.band === "weak" && entry.mistakes[0]) lines.push(`Common trap: ${entry.mistakes[0]}`);
  return lines;
}
