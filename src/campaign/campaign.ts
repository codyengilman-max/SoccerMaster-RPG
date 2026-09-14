import competitionsU11 from "../../content/rules/competitions-u11.json";
import cast from "../../content/story/cast.json";
import clubsFile from "../../content/story/clubs.json";
import {
  createCompetitions,
  generateLeagueFixtures,
  ingestResult,
  previewEligibilityPaths,
  tournamentEligibility,
  type AgeGroup,
  type CompetitionState,
  type Eligibility,
  type EligibilityPath,
  type Fixture,
  type IngestResult,
  type League,
  type Tournament,
} from "../calendar/competitions";
import { dayOfIso, isWeekend, nextWeekday, weekday, type CampaignDay } from "../calendar/date";
import { addCommitment, advanceTo, createSchedule, type Commitment, type Schedule } from "../calendar/schedule";
import type { MatchReport } from "../match/report";
import { createRosterState, joinRoster, squadFor, type Club, type Person, type RosterState } from "../roster/roster";
import type { SquadPlayer } from "../sim/engine";
import { hashSeed } from "../sim/rng";
import type { RoleNumber } from "../sim/types";
import { createStoryState, processDue, type Fired, type StoryContext, type StoryState } from "../story/consequences";
import { createProgression, refreshUnlocks, type Progression } from "../story/progression";

/**
 * The whole campaign in one serialisable object (plan §3.4). Every subsystem gets its own slice;
 * this module wires them and owns day advancement and match recording.
 */

export type CampaignKind = "boys" | "girls";
export type Foot = "left" | "right";
export type Month = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface PlayerProfile {
  name: string;
  /** Index into an appearance preset list (OPEN_QUESTIONS #4). */
  appearance: number;
  foot: Foot;
  birthMonth: Month;
  /** Locked playing role (spec §3). */
  position: RoleNumber;
}

export const PLAYER_ID = "player";
export const FRIEND_ID = "friend";
export const HOME_CLUB_ID = "batavia";
/** People who start whenever they are on the roster: the user and the best friend (spec §4). */
export const MUST_START: readonly string[] = [PLAYER_ID, FRIEND_ID];

export interface CampaignState {
  id: string;
  seed: number;
  kind: CampaignKind;
  player: PlayerProfile;
  ageGroup: AgeGroup;
  day: CampaignDay;
  /** Increments on every mutation that matters to saves; used as the dialogue staleness guard. */
  revision: number;
  schedule: Schedule;
  competitions: CompetitionState;
  roster: RosterState;
  story: StoryState;
  progression: Progression;
  /** Reports for matches the user played, in order. */
  reports: MatchReport[];
  /** Scene currently on screen (null when the campaign is at the hub / between scenes). */
  scene: string | null;
}

export interface CreateOptions {
  kind: CampaignKind;
  player: PlayerProfile;
  seed?: number;
}

interface CompetitionsFile {
  season: { ageGroup: AgeGroup; startDate: string; tryoutsDate: string };
  leagues: { id: string; name: string; term: "fall" | "spring"; startDate: string; endDate: string }[];
  tournaments: {
    id: string;
    name: string;
    minAge: AgeGroup;
    requirement: Tournament["requirement"];
    major: boolean;
    date: string;
    cutoffDate: string;
    matches: number;
  }[];
}

interface CastFile {
  shared: Person[];
  campaigns: Record<CampaignKind, { friend: Person; parent: Person; teammates: Person[] }>;
}

const competitionsFile = competitionsU11 as CompetitionsFile;
const castFile = cast as unknown as CastFile;
const clubs = (clubsFile as { clubs: Club[] }).clubs;

export function loadTournaments(): Tournament[] {
  return competitionsFile.tournaments.map((t) => ({
    id: t.id,
    name: t.name,
    minAge: t.minAge,
    requirement: t.requirement,
    major: t.major,
    day: dayOfIso(t.date),
    cutoffDay: dayOfIso(t.cutoffDate),
    matches: t.matches,
  }));
}

export function loadLeagues(ageGroup: AgeGroup): League[] {
  return competitionsFile.leagues.map((l) => ({
    id: l.id,
    name: l.name,
    ageGroup,
    term: l.term,
    clubIds: clubs.map((c) => c.id),
    startDay: dayOfIso(l.startDate),
    endDay: dayOfIso(l.endDate),
  }));
}

export const TRYOUTS_DAY: CampaignDay = dayOfIso(competitionsFile.season.tryoutsDate);

/** Cast for one campaign; the user is added as a player with the chosen shirt. */
export function buildRoster(kind: CampaignKind, player: PlayerProfile): RosterState {
  const st = createRosterState();
  st.clubs = structuredClone(clubs);
  const c = castFile.campaigns[kind];
  st.people = structuredClone([
    ...castFile.shared,
    c.friend,
    c.parent,
    ...c.teammates,
    { id: PLAYER_ID, name: player.name, role: "player", clubId: null, shirt: player.position, bio: "", reviewStatus: "reviewed" } satisfies Person,
  ]);
  for (const club of st.clubs) st.rosters.push({ clubId: club.id, ageGroup: "U11", playerIds: [], capacity: 12 });
  for (const p of st.people) if (p.role === "player" && p.clubId) joinRoster(st, p.id, p.clubId, "U11");
  return st;
}

export function createCampaign(opts: CreateOptions): CampaignState {
  const seed = opts.seed ?? hashSeed(`${opts.kind}:${opts.player.name}:${opts.player.position}`);
  const competitions = createCompetitions();
  competitions.leagues = loadLeagues("U11");
  competitions.tournaments = loadTournaments();
  for (const l of competitions.leagues) competitions.fixtures.push(...generateLeagueFixtures(l, seed ^ hashSeed(l.id)));
  const state: CampaignState = {
    id: `camp-${seed.toString(16)}`,
    seed,
    kind: opts.kind,
    player: { ...opts.player },
    ageGroup: "U11",
    day: 0,
    revision: 0,
    schedule: createSchedule(),
    competitions,
    roster: buildRoster(opts.kind, opts.player),
    story: createStoryState(),
    progression: createProgression(),
    reports: [],
    scene: null,
  };
  return state;
}

export const storyContext = (c: CampaignState): StoryContext => ({ story: c.story, progression: c.progression, day: c.day });

export const touch = (c: CampaignState): number => ++c.revision;

/** The user's club, if they have joined one. */
export function playerClubId(c: CampaignState): string | null {
  return c.roster.people.find((p) => p.id === PLAYER_ID)?.clubId ?? null;
}

/** Join FC Batavia (or another club). Roster capacity is enforced by the roster module. */
export function joinClub(c: CampaignState, clubId: string): ReturnType<typeof joinRoster> {
  const r = joinRoster(c.roster, PLAYER_ID, clubId, c.ageGroup);
  if (r.ok) touch(c);
  return r;
}

export const JOIN_FLAG_PREFIX = "join:";

/**
 * Story effects cannot reach the roster, so a choice raises a `join:<clubId>` flag and this applies
 * it. Idempotent: a flag for the club the user already belongs to is a no-op.
 */
export function syncStoryFlags(c: CampaignState): string[] {
  const joined: string[] = [];
  for (const f of c.story.flags) {
    if (!f.startsWith(JOIN_FLAG_PREFIX)) continue;
    const clubId = f.slice(JOIN_FLAG_PREFIX.length);
    if (playerClubId(c) === clubId) continue;
    if (joinClub(c, clubId).ok) joined.push(clubId);
  }
  return joined;
}

/**
 * Regular week (spec §7; OPEN_QUESTIONS #15): school on weekday school slots, team training
 * Tue/Thu/Fri afternoons, the club's league match on Saturday if one is scheduled. Idempotent:
 * commitment ids are derived from day + kind.
 */
export function scheduleWeek(c: CampaignState, monday: CampaignDay): Commitment[] {
  const clubId = playerClubId(c);
  const added: Commitment[] = [];
  const put = (x: Commitment) => {
    const r = addCommitment(c.schedule, x);
    if (r.ok && r.commitment === x) added.push(x);
  };
  for (let d = monday; d < monday + 7; d++) {
    const w = weekday(d);
    if (!isWeekend(d)) {
      put({ id: `school-${d}`, day: d, slot: "school", kind: "school", title: "School", mandatory: true, refId: null, minutes: 390, status: "scheduled" });
    }
    if (clubId && (w === "Tue" || w === "Thu" || w === "Fri")) {
      put({ id: `training-${d}`, day: d, slot: "afternoon", kind: "training", title: "Team training", mandatory: true, refId: `training-${d}`, minutes: 90, status: "scheduled" });
    }
    if (clubId && w === "Sat") {
      const fx = fixturesFor(c, clubId).find((f) => f.day === d);
      if (fx) {
        put({
          id: `${fx.kind}-${fx.id}`,
          day: d,
          slot: "morning",
          kind: fx.kind === "league" ? "match" : "tournament",
          title: fx.kind === "league" ? "League match" : "Tournament match",
          mandatory: true,
          refId: fx.id,
          minutes: 120,
          status: "scheduled",
        });
      }
    }
  }
  if (added.length) touch(c);
  return added;
}

export const fixturesFor = (c: CampaignState, clubId: string): Fixture[] =>
  c.competitions.fixtures.filter((f) => f.homeClubId === clubId || f.awayClubId === clubId).sort((a, b) => a.day - b.day);

export const nextFixture = (c: CampaignState, clubId: string): Fixture | undefined => fixturesFor(c, clubId).find((f) => !f.result && f.day >= c.day);

/** Both starting nines for a fixture, from the rosters as they stand now. */
export function matchSquads(c: CampaignState, fixture: Fixture, seed: number): { home: SquadPlayer[]; away: SquadPlayer[] } {
  return {
    home: squadFor(c.roster, fixture.homeClubId, c.ageGroup, seed, MUST_START),
    away: squadFor(c.roster, fixture.awayClubId, c.ageGroup, seed + 1, MUST_START),
  };
}

export interface DayAdvance {
  from: CampaignDay;
  to: CampaignDay;
  missed: Commitment[];
  fired: Fired[];
  unlocked: string[];
}

/** Move the campaign forward; schedules the new week when a Monday is crossed, expires missed commitments, fires due consequences. */
export function advanceDays(c: CampaignState, days: number): DayAdvance {
  if (days <= 0) throw new Error("days must be positive");
  const from = c.day;
  const to = from + days;
  for (let d = from + 1; d <= to; d++) if (weekday(d) === "Mon") scheduleWeek(c, d);
  c.day = to;
  const missed = advanceTo(c.schedule, to);
  const fired = processDue(storyContext(c));
  syncStoryFlags(c);
  const unlocked = refreshUnlocks(c.progression);
  touch(c);
  return { from, to, missed, fired, unlocked };
}

export const nextDayOf = (c: CampaignState, w: Parameters<typeof nextWeekday>[1]): CampaignDay => nextWeekday(c.day, w);

/** Record a finished match: standings/idempotency via the competition module, evidence kept for postgame. */
export function recordMatch(c: CampaignState, report: MatchReport): IngestResult | { ok: true; fixture: null } {
  if (!c.reports.some((r) => r.eventId === report.eventId)) c.reports.push(report);
  if (!report.fixtureId) {
    touch(c);
    return { ok: true, fixture: null };
  }
  const r = ingestResult(
    c.competitions,
    report.fixtureId,
    { eventId: report.eventId, homeGoals: report.score.home, awayGoals: report.score.away },
    { homeClubId: report.home.clubId, awayClubId: report.away.clubId },
  );
  if (r.ok) touch(c);
  return r;
}

/** The league in progress or next to start (qualification evidence comes from it). */
export const currentLeagueId = (c: CampaignState): string | null =>
  [...c.competitions.leagues].sort((a, b) => a.startDay - b.startDay).find((l) => l.endDay >= c.day)?.id ?? null;

export function eligibilityNow(c: CampaignState): Eligibility[] {
  const clubId = playerClubId(c);
  if (!clubId) return [];
  const ctx = { clubId, ageGroup: c.ageGroup, leagueId: currentLeagueId(c), asOfDay: c.day };
  return c.competitions.tournaments.map((t) => tournamentEligibility(c.competitions, t, ctx));
}

export function eligibilityPreview(c: CampaignState): EligibilityPath[] {
  const clubId = playerClubId(c);
  if (!clubId) return [];
  return previewEligibilityPaths(c.competitions, { clubId, ageGroup: c.ageGroup, leagueId: currentLeagueId(c), asOfDay: c.day });
}
