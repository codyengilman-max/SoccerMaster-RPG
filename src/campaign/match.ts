import type { Fixture } from "../calendar/competitions";
import { buildReport, lineFor, playedIn, resultFor, type MatchReport } from "../match/report";
import type { MatchRuntime } from "../match/runtime";
import { isPoolPlayer } from "../roster/roster";
import type { MatchConfig } from "../sim/engine";
import { U11_9V9 } from "../sim/rules";
import { hashSeed } from "../sim/rng";
import { applyEffect, type Effect } from "../story/consequences";
import { FRIEND_ID, PLAYER_ID, matchSquads, playerClubId, recordMatch, storyContext, touch, type CampaignState } from "./campaign";

/**
 * Campaign matches (spec §10, §12): the fixture's real rosters go into the sim, the user's locked
 * position is the controlled player, and the finished match leaves a `MatchReport`. Everything a
 * postgame scene may say is derived here as facts from that report — never from the live state,
 * and never about a person the report does not list as having played (spec §5).
 */

export function fixtureById(c: CampaignState, id: string): Fixture {
  const f = c.competitions.fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture ${id}`);
  return f;
}

export function matchSeed(c: CampaignState, fixture: Fixture): number {
  return hashSeed(`${c.seed}:${fixture.id}`);
}

/** Sim configuration for a fixture the user's club plays; the user is always controlled and always starts. */
export function campaignMatchConfig(c: CampaignState, fixture: Fixture): MatchConfig {
  const mine = playerClubId(c);
  if (!mine) throw new Error("player has no club");
  const side = fixture.homeClubId === mine ? "home" : fixture.awayClubId === mine ? "away" : null;
  if (!side) throw new Error(`fixture ${fixture.id} does not involve ${mine}`);
  const seed = matchSeed(c, fixture);
  const squads = matchSquads(c, fixture, seed);
  const club = (id: string) => c.roster.clubs.find((k) => k.id === id);
  const home = club(fixture.homeClubId);
  const away = club(fixture.awayClubId);
  const controlledSquad = side === "home" ? squads.home : squads.away;
  if (!controlledSquad.some((p) => p.id === PLAYER_ID)) throw new Error("player not in the squad");
  return {
    matchId: `${c.id}:${fixture.id}`,
    seed,
    rules: U11_9V9,
    home: { side: "home", name: home?.name ?? fixture.homeClubId, shortName: home?.shortName ?? fixture.homeClubId.slice(0, 3).toUpperCase(), squad: squads.home },
    away: { side: "away", name: away?.name ?? fixture.awayClubId, shortName: away?.shortName ?? fixture.awayClubId.slice(0, 3).toUpperCase(), squad: squads.away },
    controlled: { side, playerId: PLAYER_ID },
  };
}

export function reportFromRuntime(runtime: MatchRuntime, fixture: Fixture): MatchReport {
  return buildReport(runtime.state, runtime.session.records, {
    fixtureId: fixture.id,
    homeClubId: fixture.homeClubId,
    awayClubId: fixture.awayClubId,
    isPool: isPoolPlayer,
  });
}

export const MATCH_FACTS = {
  played: "matches_played",
  result: "last_result",
  score: "last_score",
  opponent: "last_opponent",
  kind: "last_match_kind",
  myGoals: "last_my_goals",
  myShots: "last_my_shots",
  myPasses: "last_my_pass_rate",
  friendPlayed: "last_friend_played",
  friendGoals: "last_friend_goals",
  moments: "last_moments",
  strongReads: "last_strong_reads",
  weakReads: "last_weak_reads",
  timeouts: "last_timeouts",
  goodReadPoorExecution: "last_good_read_poor_execution",
  poorReadGoodOutcome: "last_poor_read_good_outcome",
  reads: "last_match_reads",
} as const;

/** `none` when no tactical moment was recorded — then nothing may be claimed about the reads. */
export type MatchReads = "sharp" | "mixed" | "rushed" | "none";

export function matchReads(r: MatchReport): MatchReads {
  const m = r.moments;
  if (m.total === 0) return "none";
  const total = m.total;
  const strong = m.decisions.strong / total;
  const sound = (m.decisions.strong + m.decisions.acceptable) / total;
  return strong >= 0.5 && m.decisions.timeout <= 1 ? "sharp" : sound >= 0.5 ? "mixed" : "rushed";
}

/** Facts derived from the report, for the postgame scenes. Pure. */
export function matchFacts(c: CampaignState, r: MatchReport, fixture: Fixture): Effect[] {
  const mine = playerClubId(c)!;
  const side = r.home.clubId === mine ? "home" : "away";
  const opponent = side === "home" ? r.away : r.home;
  const me = lineFor(r, PLAYER_ID);
  const friendPlayed = playedIn(r, FRIEND_ID);
  const friend = friendPlayed ? lineFor(r, FRIEND_ID) : undefined;
  const played = typeof c.story.facts[MATCH_FACTS.played] === "number" ? (c.story.facts[MATCH_FACTS.played] as number) : 0;
  const effects: Effect[] = [
    { type: "set_fact", id: MATCH_FACTS.played, value: played + 1 },
    { type: "set_fact", id: MATCH_FACTS.result, value: resultFor(r, side) },
    { type: "set_fact", id: MATCH_FACTS.score, value: side === "home" ? `${r.score.home}–${r.score.away}` : `${r.score.away}–${r.score.home}` },
    { type: "set_fact", id: MATCH_FACTS.opponent, value: opponent.name },
    { type: "set_fact", id: MATCH_FACTS.kind, value: fixture.kind },
    { type: "set_fact", id: MATCH_FACTS.myGoals, value: me?.goals ?? 0 },
    { type: "set_fact", id: MATCH_FACTS.myShots, value: me?.shots ?? 0 },
    { type: "set_fact", id: MATCH_FACTS.myPasses, value: me && me.passes ? Math.round((100 * me.passesCompleted) / me.passes) : 0 },
    { type: "set_fact", id: MATCH_FACTS.friendPlayed, value: friendPlayed },
    { type: "set_fact", id: MATCH_FACTS.friendGoals, value: friend?.goals ?? 0 },
    { type: "set_fact", id: MATCH_FACTS.moments, value: r.moments.total },
    { type: "set_fact", id: MATCH_FACTS.strongReads, value: r.moments.decisions.strong },
    { type: "set_fact", id: MATCH_FACTS.weakReads, value: r.moments.decisions.weak },
    { type: "set_fact", id: MATCH_FACTS.timeouts, value: r.moments.decisions.timeout },
    { type: "set_fact", id: MATCH_FACTS.goodReadPoorExecution, value: r.moments.goodReadPoorExecution.length },
    { type: "set_fact", id: MATCH_FACTS.poorReadGoodOutcome, value: r.moments.poorReadGoodOutcome.length },
    { type: "set_fact", id: MATCH_FACTS.reads, value: matchReads(r) },
  ];
  // The parent watched from the touchline: they know the result and what they could see, not the reads.
  for (const id of [MATCH_FACTS.result, MATCH_FACTS.score, MATCH_FACTS.opponent, MATCH_FACTS.myGoals, MATCH_FACTS.friendPlayed]) {
    effects.push({ type: "learn", personId: "parent", factId: id });
  }
  // The coach saw the decisions.
  for (const id of [MATCH_FACTS.result, MATCH_FACTS.reads, MATCH_FACTS.goodReadPoorExecution, MATCH_FACTS.poorReadGoodOutcome, MATCH_FACTS.myGoals]) {
    effects.push({ type: "learn", personId: "coach", factId: id });
  }
  // The friend knows what happened only if they were on the pitch.
  if (friendPlayed) {
    for (const id of [MATCH_FACTS.result, MATCH_FACTS.score, MATCH_FACTS.myGoals, MATCH_FACTS.friendGoals]) {
      effects.push({ type: "learn", personId: "friend", factId: id });
    }
  }
  return effects;
}

export type CompleteMatchResult =
  | { ok: true; effects: Effect[]; duplicate: false }
  | { ok: true; effects: []; duplicate: true }
  | { ok: false; reason: string };

/**
 * Persist the report, ingest the fixture result (idempotent), derive facts, and queue the postgame
 * scenes for today. Re-submitting the same match is a no-op.
 */
export function completeCampaignMatch(c: CampaignState, report: MatchReport): CompleteMatchResult {
  if (!report.finished) return { ok: false, reason: "match not finished" };
  if (!report.fixtureId) return { ok: false, reason: "campaign match without fixture" };
  const fixture = fixtureById(c, report.fixtureId);
  const before = c.competitions.appliedEventIds.includes(report.eventId);
  const ingest = recordMatch(c, report);
  if (!ingest.ok) return ingest.reason === "duplicate_event" || before ? { ok: true, effects: [], duplicate: true } : { ok: false, reason: ingest.reason };
  const effects = matchFacts(c, report, fixture);
  effects.push({ type: "track", track: "physical", delta: 1 });
  effects.push({ type: "queue_scene", sceneId: "week.postgame", onDay: c.day });
  effects.push({ type: "queue_scene", sceneId: "week.friend_after_match", onDay: c.day });
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return { ok: true, effects, duplicate: false };
}
