import type { MatchEvent, MatchState, PlayerId } from "../sim/types";
import type { Side } from "../sim/rules";
import type { DecisionBand, ExecutionBand, MomentRecord, OutcomeResult } from "../tactics/moments";

/**
 * Evidence a finished match leaves behind (plan §3.3). Postgame scenes, standings, progression and
 * dialogue read *this*, never the live state. Serialisable; one per match; `eventId` is the stable
 * key result ingestion de-duplicates on.
 */

export interface PlayerLine {
  playerId: PlayerId;
  name: string;
  side: Side;
  passes: number;
  passesCompleted: number;
  shots: number;
  onTarget: number;
  goals: number;
  assists: number;
  interceptions: number;
  tacklesWon: number;
  tacklesLost: number;
  saves: number;
  offsides: number;
}

export interface MomentSummary {
  total: number;
  decisions: Record<DecisionBand | "timeout" | "intent_unavailable", number>;
  executions: Record<ExecutionBand, number>;
  outcomes: Record<OutcomeResult, number>;
  /** Moments the controlled player read well but executed poorly, and the reverse — the story hooks. */
  goodReadPoorExecution: string[];
  poorReadGoodOutcome: string[];
  /** Titles of `major` moments, in order. */
  majorMoments: string[];
}

export interface Goal {
  tick: number;
  side: Side;
  scorer: PlayerId;
  assist: PlayerId | null;
  half: number;
}

export interface MatchReport {
  eventId: string;
  matchId: string;
  fixtureId: string | null;
  seed: number;
  home: { clubId: string; name: string };
  away: { clubId: string; name: string };
  score: { home: number; away: number };
  goals: Goal[];
  /** Non-pool player ids who actually played, by side. */
  participants: { home: PlayerId[]; away: PlayerId[] };
  controlled: { side: Side; playerId: PlayerId } | null;
  lines: PlayerLine[];
  moments: MomentSummary;
  finished: boolean;
}

export const resultFor = (r: MatchReport, side: Side): "win" | "draw" | "loss" => {
  const mine = side === "home" ? r.score.home : r.score.away;
  const theirs = side === "home" ? r.score.away : r.score.home;
  return mine > theirs ? "win" : mine < theirs ? "loss" : "draw";
};

const HALF_TICKS = (s: MatchState): number => s.rules.halfLengthSeconds * 20;

export function buildReport(
  state: MatchState,
  records: readonly MomentRecord[],
  meta: { fixtureId: string | null; homeClubId: string; awayClubId: string; isPool?: (id: PlayerId) => boolean },
): MatchReport {
  const isPool = meta.isPool ?? (() => false);
  const lines = new Map<PlayerId, PlayerLine>();
  for (const p of state.players) {
    lines.set(p.id, {
      playerId: p.id,
      name: p.name,
      side: p.side,
      passes: 0,
      passesCompleted: 0,
      shots: 0,
      onTarget: 0,
      goals: 0,
      assists: 0,
      interceptions: 0,
      tacklesWon: 0,
      tacklesLost: 0,
      saves: 0,
      offsides: 0,
    });
  }
  const L = (id: PlayerId | null): PlayerLine | undefined => (id ? lines.get(id) : undefined);
  const goals: Goal[] = [];
  const halfTicks = HALF_TICKS(state);
  for (const e of state.events as readonly MatchEvent[]) {
    switch (e.type) {
      case "pass":
        L(e.from) && L(e.from)!.passes++;
        break;
      case "receive":
        if (e.clean && e.from) L(e.from) && L(e.from)!.passesCompleted++;
        break;
      case "shot": {
        const l = L(e.player);
        if (l) (l.shots++, e.onTarget && l.onTarget++);
        break;
      }
      case "goal": {
        L(e.scorer) && L(e.scorer)!.goals++;
        L(e.assist) && L(e.assist)!.assists++;
        goals.push({ tick: e.tick, side: e.side, scorer: e.scorer, assist: e.assist, half: e.tick < halfTicks ? 1 : 2 });
        break;
      }
      case "interception":
        L(e.player) && L(e.player)!.interceptions++;
        break;
      case "tackle": {
        const l = L(e.player);
        if (l) e.won ? l.tacklesWon++ : l.tacklesLost++;
        break;
      }
      case "save":
        L(e.keeper) && L(e.keeper)!.saves++;
        break;
      case "offside":
        L(e.player) && L(e.player)!.offsides++;
        break;
      default:
        break;
    }
  }
  const moments: MomentSummary = {
    total: records.length,
    decisions: { strong: 0, acceptable: 0, weak: 0, timeout: 0, intent_unavailable: 0 },
    executions: { clean: 0, loose: 0, poor: 0 },
    outcomes: { success: 0, partial: 0, failure: 0, neutral: 0 },
    goodReadPoorExecution: [],
    poorReadGoodOutcome: [],
    majorMoments: [],
  };
  for (const r of records) {
    moments.decisions[r.decision.band]++;
    if (r.execution) moments.executions[r.execution.band]++;
    if (r.outcome) moments.outcomes[r.outcome.result]++;
    if (r.decision.band === "strong" && r.execution?.band === "poor") moments.goodReadPoorExecution.push(r.moment.title);
    if (r.decision.band === "weak" && r.outcome?.result === "success") moments.poorReadGoodOutcome.push(r.moment.title);
    if (r.moment.major) moments.majorMoments.push(r.moment.title);
  }
  const side = (s: Side) => state.players.filter((p) => p.side === s && !isPool(p.id)).map((p) => p.id);
  return {
    eventId: `match:${state.matchId}`,
    matchId: state.matchId,
    fixtureId: meta.fixtureId,
    seed: state.seed,
    home: { clubId: meta.homeClubId, name: state.home.name },
    away: { clubId: meta.awayClubId, name: state.away.name },
    score: { ...state.score },
    goals,
    participants: { home: side("home"), away: side("away") },
    controlled: state.controlled ? { ...state.controlled } : null,
    lines: [...lines.values()],
    moments,
    finished: state.phase.kind === "full_time",
  };
}

/** Facts a character may only state if the report supports them (spec §5, §20). */
export function playedIn(report: MatchReport, personId: string): boolean {
  return report.participants.home.includes(personId) || report.participants.away.includes(personId);
}

export function lineFor(report: MatchReport, playerId: PlayerId): PlayerLine | undefined {
  return report.lines.find((l) => l.playerId === playerId);
}
