import competitionsU11 from "../../content/rules/competitions-u11.json";
import {
  enterTournament,
  ingestResult,
  leagueRecord,
  rescheduleFixture,
  reserveDay,
  standings,
  tournamentEligibility,
  tournamentSummary,
  type Fixture,
  type League,
  type Tournament,
  type TournamentSummary,
} from "../calendar/competitions";
import { formatDay, nextWeekday, type CampaignDay } from "../calendar/date";
import { modelResult } from "../calendar/results";
import { lineFor } from "../match/report";
import { hashSeed } from "../sim/rng";
import { applyEffect, type Effect } from "../story/consequences";
import type { CampaignState } from "./campaign";
import { PLAYER_ID, playerClubId, storyContext, touch } from "./state";

/**
 * The season around the week (spec §17): the rest of the league plays when the user's club does,
 * the club enters tournaments as registration windows open, a tournament that lands on a league
 * Saturday moves that league match to a reserve date, and the season closes with a review. Every
 * result that nobody played on screen comes from the scoreline model and is ingested through the
 * same idempotent path as a played match, so standings can never double count.
 */

export type SeasonPhase = "preseason" | "fall" | "winter" | "spring" | "postseason";

/** Days before a tournament's registration cutoff during which the club decides (proposal). */
export const ENTRY_WINDOW_DAYS: number = (competitionsU11 as { entryWindowDays?: number }).entryWindowDays ?? 14;

export const SEASON_FACTS = {
  pendingTournament: "tournament_pending",
  tournamentName: "tournament_name",
  tournamentDate: "tournament_date",
  tournamentMatches: "tournament_matches",
  tournamentMoved: "tournament_moved",
  attend: "tournament_attend",
  attendPrefix: "tournament_attend:",
  missedMatchRecent: "missed_match_recent",
  missedMatchOpponent: "missed_match_opponent",
  missedMatchScore: "missed_match_score",
  missedMatches: "matches_missed",
  fallFinish: "season_fall_finish",
  springFinish: "season_spring_finish",
  leagueRecord: "season_league_record",
  tournamentsEntered: "season_tournaments_entered",
  trophies: "season_trophies",
  matchesPlayed: "season_matches_played",
  goals: "season_goals",
  reviewed: "season_reviewed",
} as const;

export const SCENES = {
  entered: "season.tournament_entered",
  between: "season.tournament_between",
  evening: "season.tournament_evening",
  end: "season.tournament_end",
  missedMatch: "season.missed_match",
  seasonEnd: "season.end",
} as const;

const byStart = (c: CampaignState): League[] => [...c.competitions.leagues].sort((a, b) => a.startDay - b.startDay);

/** The league in progress or next to start (qualification evidence comes from it). */
export const currentLeagueId = (c: CampaignState): string | null => byStart(c).find((l) => l.endDay >= c.day)?.id ?? null;

export function seasonPhase(c: CampaignState): SeasonPhase {
  const leagues = byStart(c);
  const fall = leagues.find((l) => l.term === "fall");
  const spring = leagues.find((l) => l.term === "spring");
  if (fall && c.day < fall.startDay) return "preseason";
  if (fall && c.day <= fall.endDay) return "fall";
  if (spring && c.day < spring.startDay) return "winter";
  if (spring && c.day <= spring.endDay) return "spring";
  return "postseason";
}

const clubQuality = (c: CampaignState, id: string): number => c.roster.clubs.find((k) => k.id === id)?.quality ?? 50;

export interface Settled {
  fixture: Fixture;
  /** The user's club was involved and nobody played it on screen. */
  absent: boolean;
}

/**
 * Give every past fixture without a result one from the scoreline model. Other clubs' league
 * rounds complete the table; the user's club is settled the same way when the match went unplayed
 * (a missed commitment or a skipped tournament) and the coach is told.
 */
export function settleFixtures(c: CampaignState): Settled[] {
  const mine = playerClubId(c);
  const out: Settled[] = [];
  const due = c.competitions.fixtures.filter((f) => !f.result && f.day < c.day).sort((a, b) => a.day - b.day || a.id.localeCompare(b.id));
  for (const f of due) {
    const r = modelResult(clubQuality(c, f.homeClubId), clubQuality(c, f.awayClubId), hashSeed(`${c.seed}:auto:${f.id}`));
    const ingest = ingestResult(c.competitions, f.id, { eventId: `auto-${f.id}`, ...r });
    if (!ingest.ok) continue;
    const absent = mine !== null && (f.homeClubId === mine || f.awayClubId === mine);
    out.push({ fixture: f, absent });
    if (absent && !(f.kind === "tournament" && !attendsTournament(c, f.competitionId))) missedMatch(c, f, mine!);
  }
  if (out.length) touch(c);
  return out;
}

function missedMatch(c: CampaignState, f: Fixture, mine: string): void {
  const opp = f.homeClubId === mine ? f.awayClubId : f.homeClubId;
  const gf = f.homeClubId === mine ? f.result!.homeGoals : f.result!.awayGoals;
  const ga = f.homeClubId === mine ? f.result!.awayGoals : f.result!.homeGoals;
  const n = typeof c.story.facts[SEASON_FACTS.missedMatches] === "number" ? (c.story.facts[SEASON_FACTS.missedMatches] as number) : 0;
  const effects: Effect[] = [
    { type: "set_fact", id: SEASON_FACTS.missedMatchRecent, value: true },
    { type: "set_fact", id: SEASON_FACTS.missedMatchOpponent, value: c.roster.clubs.find((k) => k.id === opp)?.name ?? opp },
    { type: "set_fact", id: SEASON_FACTS.missedMatchScore, value: `${gf}–${ga}` },
    { type: "set_fact", id: SEASON_FACTS.missedMatches, value: n + 1 },
    { type: "learn", personId: "coach", factId: SEASON_FACTS.missedMatchRecent },
    { type: "learn", personId: "coach", factId: SEASON_FACTS.missedMatchScore },
    { type: "queue_scene", sceneId: SCENES.missedMatch, onDay: nextWeekday(c.day, "Tue") },
  ];
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
}

/** Whether the user goes to an entered tournament: the family decides in `season.tournament_entered`; unanswered means yes. */
export const attendsTournament = (c: CampaignState, tournamentId: string): boolean =>
  c.story.facts[`${SEASON_FACTS.attendPrefix}${tournamentId}`] !== "skip";

/** Distinct opponents for a tournament, guests first in the mix, deterministic for the campaign seed. */
export function pickOpponents(c: CampaignState, tournament: Tournament, clubId: string): string[] {
  const pool = c.roster.clubs.filter((k) => k.id !== clubId).map((k) => k.id);
  const rng = hashSeed(`${c.seed}:${tournament.id}`);
  const ranked = pool.map((id, i) => ({ id, key: hashSeed(`${rng}:${id}:${i}`) })).sort((a, b) => a.key - b.key || a.id.localeCompare(b.id));
  const out: string[] = [];
  for (const r of ranked) {
    if (out.length >= tournament.matches) break;
    out.push(r.id);
  }
  return out;
}

export interface Entered {
  tournament: Tournament;
  fixtures: Fixture[];
  /** League fixtures moved off the tournament weekend, with their new day. */
  moved: Fixture[];
}

/**
 * Enter at most one tournament today: the first, by cutoff, whose registration window is open and
 * whose eligibility holds on today's evidence. Team results decide which windows open (spec §17);
 * the season allowance is enforced by the competition module.
 */
export function planTournaments(c: CampaignState): Entered | null {
  const clubId = playerClubId(c);
  if (!clubId) return null;
  if (c.story.facts[SEASON_FACTS.pendingTournament] !== undefined) return null;
  const ts = [...c.competitions.tournaments].sort((a, b) => a.cutoffDay - b.cutoffDay || a.id.localeCompare(b.id));
  for (const t of ts) {
    if (c.competitions.entered.includes(t.id)) continue;
    if (c.day < t.cutoffDay - ENTRY_WINDOW_DAYS || c.day > t.cutoffDay) continue;
    const r = enterTournament(c.competitions, t, {
      clubId,
      ageGroup: c.ageGroup,
      leagueId: currentLeagueId(c),
      asOfDay: c.day,
      opponents: pickOpponents(c, t, clubId),
    });
    if (!r.ok) continue;
    const moved = resolveLeagueClash(c, clubId, r.fixtures);
    const effects: Effect[] = [
      { type: "set_fact", id: SEASON_FACTS.pendingTournament, value: t.id },
      { type: "set_fact", id: SEASON_FACTS.tournamentName, value: t.name },
      { type: "set_fact", id: SEASON_FACTS.tournamentDate, value: formatDay(t.day) },
      { type: "set_fact", id: SEASON_FACTS.tournamentMatches, value: t.matches },
      moved.length
        ? {
            type: "set_fact",
            id: SEASON_FACTS.tournamentMoved,
            value: moved.map((f) => `${clubName(c, f.homeClubId === clubId ? f.awayClubId : f.homeClubId)} moves to ${formatDay(f.day)}`).join("; "),
          }
        : { type: "clear_fact", id: SEASON_FACTS.tournamentMoved },
      { type: "queue_scene", sceneId: SCENES.entered, onDay: c.day },
    ];
    const ctx = storyContext(c);
    for (const e of effects) applyEffect(ctx, e);
    touch(c);
    return { tournament: t, fixtures: r.fixtures, moved };
  }
  return null;
}

const clubName = (c: CampaignState, id: string): string => c.roster.clubs.find((k) => k.id === id)?.name ?? id;

/** A league match on a tournament day moves to the first free reserve Saturday for both clubs (spec §17 explicit resolution). */
export function resolveLeagueClash(c: CampaignState, clubId: string, tournamentFixtures: readonly Fixture[]): Fixture[] {
  const days = new Set(tournamentFixtures.map((f) => f.day));
  const moved: Fixture[] = [];
  for (const f of c.competitions.fixtures) {
    if (f.kind !== "league" || f.result || !days.has(f.day) || (f.homeClubId !== clubId && f.awayClubId !== clubId)) continue;
    const league = c.competitions.leagues.find((l) => l.id === f.competitionId);
    if (!league) continue;
    const to = reserveDay(c.competitions, league, [f.homeClubId, f.awayClubId], f.day);
    if (to === null) continue;
    moved.push(rescheduleFixture(c.competitions, f.id, to));
  }
  return moved;
}

/**
 * The family's answer in `season.tournament_entered` arrives as a fact; pin it to the tournament
 * and, if the user is not going, take the weekend's matches off their calendar (the club still
 * plays; the results are modelled when the days pass).
 */
export function syncTournamentChoice(c: CampaignState): string | null {
  const id = c.story.facts[SEASON_FACTS.pendingTournament];
  const answer = c.story.facts[SEASON_FACTS.attend];
  if (typeof id !== "string" || typeof answer !== "string") return null;
  c.story.facts[`${SEASON_FACTS.attendPrefix}${id}`] = answer;
  delete c.story.facts[SEASON_FACTS.pendingTournament];
  delete c.story.facts[SEASON_FACTS.attend];
  if (answer === "skip") {
    const ids = new Set(c.competitions.fixtures.filter((f) => f.competitionId === id).map((f) => f.id));
    for (const k of c.schedule.commitments) if (k.refId && ids.has(k.refId) && k.status === "scheduled") k.status = "cancelled";
  }
  touch(c);
  return id;
}

export interface TournamentView {
  tournament: Tournament;
  status: "entered" | "skipped" | "window" | "upcoming" | "closed" | "blocked";
  reasons: string[];
  summary: TournamentSummary | null;
}

/** Every tournament of the season as the hub shows it: what is entered, what is still reachable, what closed and why. */
export function tournamentViews(c: CampaignState): TournamentView[] {
  const clubId = playerClubId(c);
  return [...c.competitions.tournaments]
    .sort((a, b) => a.day - b.day)
    .map((t) => {
      if (!clubId) return { tournament: t, status: "closed" as const, reasons: ["no club yet"], summary: null };
      if (c.competitions.entered.includes(t.id)) {
        return { tournament: t, status: attendsTournament(c, t.id) ? ("entered" as const) : ("skipped" as const), reasons: [], summary: tournamentSummary(c.competitions, t.id, clubId) };
      }
      if (c.day > t.cutoffDay) return { tournament: t, status: "closed" as const, reasons: ["registration closed"], summary: null };
      const e = tournamentEligibility(c.competitions, t, { clubId, ageGroup: c.ageGroup, leagueId: currentLeagueId(c), asOfDay: c.day });
      if (!e.eligible) return { tournament: t, status: "blocked" as const, reasons: e.reasons, summary: null };
      return { tournament: t, status: c.day >= t.cutoffDay - ENTRY_WINDOW_DAYS ? ("window" as const) : ("upcoming" as const), reasons: [], summary: null };
    });
}

/** Monday after the season's last fixture day: the coach's review happens then (proposal). */
export function seasonReviewDay(c: CampaignState): CampaignDay {
  const last = Math.max(...c.competitions.tournaments.map((t) => t.day), ...c.competitions.leagues.map((l) => l.endDay));
  return nextWeekday(last + 1, "Mon");
}

export interface SeasonSummary {
  phase: SeasonPhase;
  fall: { position: number; of: number } | null;
  spring: { position: number; of: number } | null;
  record: { won: number; drawn: number; lost: number };
  tournaments: TournamentSummary[];
  trophies: number;
  matchesPlayed: number;
  goals: number;
}

export function seasonSummary(c: CampaignState): SeasonSummary {
  const clubId = playerClubId(c);
  const finish = (term: League["term"]) => {
    const l = c.competitions.leagues.find((x) => x.term === term);
    if (!l || !clubId) return null;
    const table = standings(c.competitions, l.id, c.day);
    const pos = table.findIndex((r) => r.clubId === clubId);
    return pos < 0 || table[pos]!.played === 0 ? null : { position: pos + 1, of: table.length };
  };
  const tournaments = clubId ? c.competitions.entered.map((id) => tournamentSummary(c.competitions, id, clubId)) : [];
  return {
    phase: seasonPhase(c),
    fall: finish("fall"),
    spring: finish("spring"),
    record: clubId ? leagueRecord(c.competitions, clubId, c.day) : { won: 0, drawn: 0, lost: 0 },
    tournaments,
    trophies: tournaments.filter((t) => t.outcome === "champions").length,
    matchesPlayed: c.reports.length,
    goals: c.reports.reduce((n, r) => n + (lineFor(r, PLAYER_ID)?.goals ?? 0), 0),
  };
}

/** Once the last fixture day has passed: season facts for the coach, then the review scene. Idempotent. */
export function closeSeason(c: CampaignState): boolean {
  if (c.story.facts[SEASON_FACTS.reviewed] === true || !playerClubId(c) || c.day < seasonReviewDay(c)) return false;
  const s = seasonSummary(c);
  const effects: Effect[] = [
    { type: "set_fact", id: SEASON_FACTS.reviewed, value: true },
    { type: "set_fact", id: SEASON_FACTS.fallFinish, value: s.fall ? s.fall.position : 0 },
    { type: "set_fact", id: SEASON_FACTS.springFinish, value: s.spring ? s.spring.position : 0 },
    { type: "set_fact", id: SEASON_FACTS.leagueRecord, value: `${s.record.won}-${s.record.drawn}-${s.record.lost}` },
    { type: "set_fact", id: SEASON_FACTS.tournamentsEntered, value: s.tournaments.length },
    { type: "set_fact", id: SEASON_FACTS.trophies, value: s.trophies },
    { type: "set_fact", id: SEASON_FACTS.matchesPlayed, value: s.matchesPlayed },
    { type: "set_fact", id: SEASON_FACTS.goals, value: s.goals },
    { type: "queue_scene", sceneId: SCENES.seasonEnd, onDay: c.day },
  ];
  for (const id of [SEASON_FACTS.fallFinish, SEASON_FACTS.springFinish, SEASON_FACTS.leagueRecord, SEASON_FACTS.tournamentsEntered, SEASON_FACTS.trophies, SEASON_FACTS.matchesPlayed]) {
    effects.push({ type: "learn", personId: "coach", factId: id });
  }
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return true;
}
