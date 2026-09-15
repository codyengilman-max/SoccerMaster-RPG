import type { Side } from "../sim/rules";
import type { MatchState } from "../sim/types";

/**
 * Running commentary for accelerated routine play. Fast-forward compresses minutes of soccer into
 * seconds of screen time; these short lines keep the passage legible as one continuous match —
 * who has the ball, where, and how the game is going — without adding any decision the player
 * must react to. Deterministic in (state, cadence): the same match narrates the same way.
 */

export interface CommentaryState {
  /** Simulated ms at which the last routine line was produced. */
  lastAtMs: number;
  lastPossession: Side | null;
  lastZone: Zone | null;
}

export type Zone = "own_third" | "middle" | "final_third";

export const ROUTINE_LINE_EVERY_MS = 20_000;

export function createCommentary(): CommentaryState {
  return { lastAtMs: -ROUTINE_LINE_EVERY_MS, lastPossession: null, lastZone: null };
}

/** Third of the pitch the ball is in, from the perspective of the side in possession. */
export function zoneOf(state: MatchState, side: Side): Zone {
  const x = state.ball.pos.x / state.rules.length;
  const towardsAway = side === "home";
  const attackFrac = towardsAway ? x : 1 - x;
  if (attackFrac < 1 / 3) return "own_third";
  if (attackFrac < 2 / 3) return "middle";
  return "final_third";
}

const LINES: Record<Zone, readonly string[]> = {
  own_third: ["{team} build from the back", "{team} keep it patient in their own half", "{team} circulate it across the back line"],
  middle: ["{team} work it through midfield", "{team} probe for an opening", "{team} switch the play in the middle third"],
  final_third: ["{team} push into the final third", "{team} press for a way through", "{team} work the ball wide near the box"],
};

const SWITCH_LINES = ["Turnover — {team} come forward", "{team} win it back", "Possession changes: {team} on the ball"];

/**
 * A line for this frame of routine play, or null. Possession changes speak at once (rate-limited to
 * a few seconds); otherwise a zone line lands every `ROUTINE_LINE_EVERY_MS` of simulated time.
 */
export function routineLine(cs: CommentaryState, state: MatchState): string | null {
  if (state.phase.kind !== "open_play") return null;
  const side = state.possession;
  if (!side) return null;
  const team = side === "home" ? state.home.shortName : state.away.shortName;
  const now = state.clock.timeMs;
  const zone = zoneOf(state, side);
  const switched = cs.lastPossession !== null && cs.lastPossession !== side;
  const due = now - cs.lastAtMs >= ROUTINE_LINE_EVERY_MS;
  if (!switched && !due) return null;
  if (switched && now - cs.lastAtMs < 4000) {
    cs.lastPossession = side;
    return null;
  }
  const pool = switched ? SWITCH_LINES : LINES[zone];
  const pick = pool[Math.floor(now / 1000) % pool.length] ?? pool[0]!;
  cs.lastAtMs = now;
  cs.lastPossession = side;
  cs.lastZone = zone;
  return pick.replace("{team}", team);
}

/** One-line state of the game for the half-time and full-time beats. */
export function scorelineLine(state: MatchState): string {
  const { home, away } = state.score;
  if (home === away) return home === 0 ? "Goalless so far" : `Level at ${home}–${away}`;
  const lead = home > away ? state.home.shortName : state.away.shortName;
  return `${lead} lead ${Math.max(home, away)}–${Math.min(home, away)}`;
}
