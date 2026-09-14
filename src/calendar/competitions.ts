import { Rng } from "../sim/rng";
import { nextWeekday, type CampaignDay } from "./date";

/**
 * Leagues, tournaments, standings and eligibility (spec §17). Fixtures carry their origin
 * (`generated` vs `imported`); results are ingested once per event id; tournament results never
 * touch league standings; qualification is decided on the standings visible at the cutoff.
 * Every threshold here is a configurable proposal (OPEN_QUESTIONS #12, #13).
 */

export type AgeGroup = "U11" | "U12" | "U13" | "U14" | "U15" | "U16";
export const AGE_GROUPS: readonly AgeGroup[] = ["U11", "U12", "U13", "U14", "U15", "U16"];
export const ageIndex = (a: AgeGroup): number => AGE_GROUPS.indexOf(a);

/** Friendlies count for nothing but the match itself: standings and eligibility ignore them. */
export type FixtureKind = "league" | "tournament" | "friendly";
export type FixtureSource = "generated" | "imported";

export interface FixtureResult {
  /** Stable id of the match that produced it (MatchReport.eventId). */
  eventId: string;
  homeGoals: number;
  awayGoals: number;
}

export interface Fixture {
  id: string;
  kind: FixtureKind;
  competitionId: string;
  day: CampaignDay;
  homeClubId: string;
  awayClubId: string;
  source: FixtureSource;
  result: FixtureResult | null;
}

export interface League {
  id: string;
  name: string;
  ageGroup: AgeGroup;
  term: "fall" | "spring";
  clubIds: string[];
  startDay: CampaignDay;
  endDay: CampaignDay;
}

export type TournamentRequirement = "open" | "record_500" | "state_qualification";

export interface Tournament {
  id: string;
  name: string;
  /** Working name inspiration is recorded in content, not here. */
  minAge: AgeGroup;
  requirement: TournamentRequirement;
  /** Out-of-state event: costs travel and can never be entered before U13 (spec §17). */
  major: boolean;
  day: CampaignDay;
  /** Registration cutoff; qualification uses evidence available on or before this day. */
  cutoffDay: CampaignDay;
  /** Fixtures a team plays if it enters (generated on entry). */
  matches: number;
}

export interface StandingsRow {
  clubId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export interface QualificationDecision {
  tournamentId: string;
  clubId: string;
  cutoffDay: CampaignDay;
  /** Standings as they stood at the cutoff; kept so the decision is explainable later. */
  snapshot: StandingsRow[];
  qualified: boolean;
  reason: string;
}

export interface CompetitionState {
  leagues: League[];
  tournaments: Tournament[];
  fixtures: Fixture[];
  /** Event ids already applied — duplicate submissions are rejected (spec §17, acceptance 12). */
  appliedEventIds: string[];
  /** Tournament ids the player's club has entered. */
  entered: string[];
  decisions: QualificationDecision[];
}

export const createCompetitions = (): CompetitionState => ({
  leagues: [],
  tournaments: [],
  fixtures: [],
  appliedEventIds: [],
  entered: [],
  decisions: [],
});

/** Round-robin, one league match per club per week on Saturdays. Deterministic for a seed. */
export function generateLeagueFixtures(league: League, seed: number): Fixture[] {
  const clubs = [...league.clubIds];
  const rng = new Rng(seed);
  for (let i = clubs.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [clubs[i], clubs[j]] = [clubs[j]!, clubs[i]!];
  }
  if (clubs.length % 2 === 1) clubs.push("__bye__");
  const n = clubs.length;
  const rounds = n - 1;
  const out: Fixture[] = [];
  let saturday = nextWeekday(league.startDay, "Sat");
  for (let r = 0; r < rounds && saturday <= league.endDay; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = clubs[i]!;
      const b = clubs[n - 1 - i]!;
      if (a === "__bye__" || b === "__bye__") continue;
      const homeFirst = (r + i) % 2 === 0;
      out.push({
        id: `${league.id}-r${r + 1}-${i + 1}`,
        kind: "league",
        competitionId: league.id,
        day: saturday,
        homeClubId: homeFirst ? a : b,
        awayClubId: homeFirst ? b : a,
        source: "generated",
        result: null,
      });
    }
    // rotate all but the first
    const fixed = clubs[0]!;
    const rest = clubs.slice(1);
    rest.unshift(rest.pop()!);
    clubs.splice(0, clubs.length, fixed, ...rest);
    saturday += 7;
  }
  return out;
}

const emptyRow = (clubId: string): StandingsRow => ({ clubId, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, points: 0 });

/**
 * League table from league fixtures with results on or before `asOfDay` (tournament fixtures are
 * ignored by construction). Sort: points, goal difference, goals for, club id.
 */
export function standings(state: CompetitionState, leagueId: string, asOfDay = Number.POSITIVE_INFINITY): StandingsRow[] {
  const league = state.leagues.find((l) => l.id === leagueId);
  if (!league) throw new Error(`no league ${leagueId}`);
  const rows = new Map(league.clubIds.map((c) => [c, emptyRow(c)]));
  for (const f of state.fixtures) {
    if (f.kind !== "league" || f.competitionId !== leagueId || !f.result || f.day > asOfDay) continue;
    const h = rows.get(f.homeClubId);
    const a = rows.get(f.awayClubId);
    if (!h || !a) continue;
    const { homeGoals: hg, awayGoals: ag } = f.result;
    h.played++;
    a.played++;
    h.goalsFor += hg;
    h.goalsAgainst += ag;
    a.goalsFor += ag;
    a.goalsAgainst += hg;
    if (hg > ag) (h.won++, a.lost++, (h.points += 3));
    else if (hg < ag) (a.won++, h.lost++, (a.points += 3));
    else (h.drawn++, a.drawn++, h.points++, a.points++);
  }
  return [...rows.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.goalsFor - y.goalsAgainst - (x.goalsFor - x.goalsAgainst) ||
      y.goalsFor - x.goalsFor ||
      x.clubId.localeCompare(y.clubId),
  );
}

export type IngestResult = { ok: true; fixture: Fixture } | { ok: false; reason: "unknown_fixture" | "duplicate_event" | "already_played" | "club_mismatch" };

/**
 * Record a result. Rejected (and nothing changes) when the fixture is unknown, the clubs do not
 * match the fixture, the fixture already has a result, or the event id was seen before.
 */
export function ingestResult(
  state: CompetitionState,
  fixtureId: string,
  result: FixtureResult,
  clubs?: { homeClubId: string; awayClubId: string },
): IngestResult {
  const fixture = state.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return { ok: false, reason: "unknown_fixture" };
  if (state.appliedEventIds.includes(result.eventId)) return { ok: false, reason: "duplicate_event" };
  if (fixture.result) return { ok: false, reason: "already_played" };
  if (clubs && (clubs.homeClubId !== fixture.homeClubId || clubs.awayClubId !== fixture.awayClubId)) return { ok: false, reason: "club_mismatch" };
  fixture.result = { ...result };
  state.appliedEventIds.push(result.eventId);
  return { ok: true, fixture };
}

export interface Record500 {
  won: number;
  drawn: number;
  lost: number;
}

export function leagueRecord(state: CompetitionState, clubId: string, asOfDay = Number.POSITIVE_INFINITY): Record500 {
  const rec: Record500 = { won: 0, drawn: 0, lost: 0 };
  for (const f of state.fixtures) {
    if (f.kind !== "league" || !f.result || f.day > asOfDay) continue;
    const mine = f.homeClubId === clubId ? "home" : f.awayClubId === clubId ? "away" : null;
    if (!mine) continue;
    const gf = mine === "home" ? f.result.homeGoals : f.result.awayGoals;
    const ga = mine === "home" ? f.result.awayGoals : f.result.homeGoals;
    if (gf > ga) rec.won++;
    else if (gf < ga) rec.lost++;
    else rec.drawn++;
  }
  return rec;
}

const atLeast500 = (r: Record500): boolean => r.won + r.drawn + r.lost > 0 && r.won >= r.lost;

/** Proposal: the top half of the table at the cutoff qualifies for the state championships. */
export const STATE_QUALIFYING_SHARE = 0.5;

export function stateQualification(state: CompetitionState, leagueId: string, clubId: string, tournament: Tournament): QualificationDecision {
  const snapshot = standings(state, leagueId, tournament.cutoffDay);
  const places = Math.max(1, Math.floor(snapshot.length * STATE_QUALIFYING_SHARE));
  const pos = snapshot.findIndex((r) => r.clubId === clubId);
  const played = snapshot[pos]?.played ?? 0;
  const qualified = pos >= 0 && pos < places && played > 0;
  return {
    tournamentId: tournament.id,
    clubId,
    cutoffDay: tournament.cutoffDay,
    snapshot,
    qualified,
    reason:
      pos < 0
        ? "club not in league"
        : played === 0
          ? "no league results before the cutoff"
          : qualified
            ? `finished ${pos + 1} of ${snapshot.length} at the cutoff (top ${places} qualify)`
            : `finished ${pos + 1} of ${snapshot.length} at the cutoff (top ${places} qualify)`,
  };
}

export interface Eligibility {
  tournamentId: string;
  eligible: boolean;
  reasons: string[];
}

/** Eligibility for one tournament from the evidence available on `asOfDay` (never later). */
export function tournamentEligibility(
  state: CompetitionState,
  tournament: Tournament,
  ctx: { clubId: string; ageGroup: AgeGroup; leagueId: string | null; asOfDay: CampaignDay },
): Eligibility {
  const reasons: string[] = [];
  if (ageIndex(ctx.ageGroup) < ageIndex(tournament.minAge)) reasons.push(`${tournament.name} is not open before ${tournament.minAge}`);
  if (tournament.major && ageIndex(ctx.ageGroup) < ageIndex("U13")) reasons.push("major out-of-state events are not available before U13");
  const evidenceDay = Math.min(ctx.asOfDay, tournament.cutoffDay);
  if (tournament.requirement === "record_500") {
    const rec = leagueRecord(state, ctx.clubId, evidenceDay);
    if (!atLeast500(rec)) reasons.push(`needs a .500 league record by the cutoff (currently ${rec.won}-${rec.drawn}-${rec.lost})`);
  }
  if (tournament.requirement === "state_qualification") {
    if (!ctx.leagueId) reasons.push("no league to qualify through");
    else {
      const d = stateQualification(state, ctx.leagueId, ctx.clubId, { ...tournament, cutoffDay: evidenceDay });
      if (!d.qualified) reasons.push(d.reason);
    }
  }
  return { tournamentId: tournament.id, eligible: reasons.length === 0, reasons };
}

/** Proposal: three suitable entries per season with an earned fourth (spec §17). */
export const BASE_ENTRIES = 3;
export const EARNED_ENTRIES = 1;

export function entriesAllowed(state: CompetitionState, clubId: string, asOfDay: CampaignDay): number {
  return BASE_ENTRIES + (atLeast500(leagueRecord(state, clubId, asOfDay)) ? EARNED_ENTRIES : 0);
}

export type EnterResult = { ok: true; fixtures: Fixture[] } | { ok: false; reasons: string[] };

/** Enter a tournament: eligibility is decided and recorded on the day of entry. */
export function enterTournament(
  state: CompetitionState,
  tournament: Tournament,
  ctx: { clubId: string; ageGroup: AgeGroup; leagueId: string | null; asOfDay: CampaignDay; opponents: string[] },
): EnterResult {
  if (state.entered.includes(tournament.id)) return { ok: false, reasons: ["already entered"] };
  if (ctx.asOfDay > tournament.cutoffDay) return { ok: false, reasons: ["registration closed"] };
  if (state.entered.length >= entriesAllowed(state, ctx.clubId, ctx.asOfDay)) return { ok: false, reasons: ["no tournament entries left this season"] };
  const e = tournamentEligibility(state, tournament, ctx);
  if (!e.eligible) return { ok: false, reasons: e.reasons };
  if (tournament.requirement === "state_qualification" && ctx.leagueId) {
    state.decisions.push(stateQualification(state, ctx.leagueId, ctx.clubId, tournament));
  }
  state.entered.push(tournament.id);
  const fixtures: Fixture[] = [];
  for (let i = 0; i < tournament.matches; i++) {
    const opp = ctx.opponents[i % Math.max(1, ctx.opponents.length)] ?? "unknown";
    fixtures.push({
      id: `${tournament.id}-m${i + 1}`,
      kind: "tournament",
      competitionId: tournament.id,
      day: tournament.day + Math.floor(i / 2),
      homeClubId: i % 2 === 0 ? ctx.clubId : opp,
      awayClubId: i % 2 === 0 ? opp : ctx.clubId,
      source: "generated",
      result: null,
    });
  }
  state.fixtures.push(...fixtures);
  return { ok: true, fixtures };
}

export interface EligibilityPath {
  label: string;
  /** Hypothetical remaining league results before the cutoff. */
  assume: "win_out" | "hold_500" | "lose_out";
  eligible: string[];
  blocked: { tournamentId: string; reasons: string[] }[];
}

/**
 * Calendar preview: which tournaments open up under different remaining-league scenarios (spec
 * §23 "calendar preview showing different tournament eligibility paths"). Works on a copy; the
 * real state is untouched.
 */
export function previewEligibilityPaths(
  state: CompetitionState,
  ctx: { clubId: string; ageGroup: AgeGroup; leagueId: string | null; asOfDay: CampaignDay },
): EligibilityPath[] {
  const scenarios: { label: string; assume: EligibilityPath["assume"]; goals: (mine: boolean) => [number, number] }[] = [
    { label: "Win every remaining league match", assume: "win_out", goals: (home) => (home ? [2, 0] : [0, 2]) },
    { label: "Draw every remaining league match", assume: "hold_500", goals: () => [1, 1] },
    { label: "Lose every remaining league match", assume: "lose_out", goals: (home) => (home ? [0, 2] : [2, 0]) },
  ];
  return scenarios.map((sc) => {
    const copy: CompetitionState = structuredClone(state);
    const horizon = Math.max(...copy.tournaments.map((t) => t.cutoffDay), ctx.asOfDay);
    for (const f of copy.fixtures) {
      if (f.kind !== "league" || f.result || f.day <= ctx.asOfDay || f.day > horizon) continue;
      const mine = f.homeClubId === ctx.clubId || f.awayClubId === ctx.clubId;
      if (!mine) continue;
      const [hg, ag] = sc.goals(f.homeClubId === ctx.clubId);
      f.result = { eventId: `preview-${sc.assume}-${f.id}`, homeGoals: hg, awayGoals: ag };
    }
    const eligible: string[] = [];
    const blocked: EligibilityPath["blocked"] = [];
    for (const t of copy.tournaments) {
      const e = tournamentEligibility(copy, t, { ...ctx, asOfDay: t.cutoffDay });
      if (e.eligible) eligible.push(t.id);
      else blocked.push({ tournamentId: t.id, reasons: e.reasons });
    }
    return { label: sc.label, assume: sc.assume, eligible, blocked };
  });
}
