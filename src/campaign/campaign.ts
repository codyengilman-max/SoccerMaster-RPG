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
import { dayOfIso, isWeekend, mondayOf, nextWeekday, weekday, type CampaignDay } from "../calendar/date";
import { addCommitment, advanceTo, createSchedule, slotsFor, type Commitment, type Schedule, type Slot } from "../calendar/schedule";
import type { MatchReport } from "../match/report";
import { createRosterState, joinRoster, squadFor, type Club, type Person, type RosterState } from "../roster/roster";
import type { SquadPlayer } from "../sim/engine";
import { hashSeed } from "../sim/rng";
import type { RoleNumber } from "../sim/types";
import type { Activity } from "../training/smallSided";
import { planArc } from "../story/arc";
import { createStoryState, processDue, type Fired, type StoryState } from "../story/consequences";
import { createProgression, refreshUnlocks, type Progression } from "../story/progression";
import { attendsTournament, closeSeason, currentLeagueId, planTournaments, SEASON_FACTS, settleFixtures, syncTournamentChoice } from "./season";
import { FRIEND_ID, HOME_CLUB_ID, MUST_START, PLAYER_ID, playerClubId, storyContext, touch } from "./state";
import { createTryoutState, syncTryouts, type SessionActivity, type TryoutState } from "./tryouts";

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

export { FRIEND_ID, HOME_CLUB_ID, MUST_START, PLAYER_ID, playerClubId, storyContext, touch };
export { currentLeagueId };

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
  /** Slot of `day` the player is in (spec §7: the week is lived slot by slot). */
  slot: Slot;
  /** A playable activity launched from the week and not yet completed; resumed on load (spec §22). */
  pending: PendingActivity | null;
  /** Season-end tryouts, offers and the next-season decision (spec §18). */
  tryouts: TryoutState;
}

export type PendingActivity =
  | { kind: "training"; commitmentId: string; activity: Activity }
  | { kind: "match"; commitmentId: string; fixtureId: string }
  | { kind: "crossbar" }
  | { kind: "juggling" }
  | { kind: "home_skill"; assignmentId: string }
  | { kind: "tryout"; commitmentId: string; clubId: string; activity: SessionActivity };

export interface CreateOptions {
  kind: CampaignKind;
  player: PlayerProfile;
  seed?: number;
}

interface CompetitionsFile {
  season: { ageGroup: AgeGroup; startDate: string; tryoutsDate: string };
  leagues: { id: string; name: string; term: "fall" | "spring"; legs?: number; startDate: string; endDate: string }[];
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

/** Story roles the arc addresses teammates by; each maps to a roster identity. */
export type CastRole = "striker" | "organiser" | "keeper" | "newcomer";
export const CAST_ROLES: readonly CastRole[] = ["striker", "organiser", "keeper", "newcomer"];

interface CastFile {
  shared: Person[];
  campaigns: Record<CampaignKind, { friend: Person; parent: Person; teammates: Person[]; roles: Record<CastRole, string> }>;
}

const competitionsFile = competitionsU11 as CompetitionsFile;
const castFile = cast as unknown as CastFile;
const clubs = (clubsFile as { clubs: Club[] }).clubs;

export const castRoles = (kind: CampaignKind): Readonly<Record<CastRole, string>> => castFile.campaigns[kind].roles;

/** Roster person id for a story id: cast roles resolve to the campaign's teammate, anything else is itself. */
export function resolvePerson(kind: CampaignKind, id: string): string {
  const roles = castRoles(kind);
  return (CAST_ROLES as readonly string[]).includes(id) ? roles[id as CastRole] : id;
}

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
    clubIds: clubs.filter((c) => !c.guest).map((c) => c.id),
    startDay: dayOfIso(l.startDate),
    endDay: dayOfIso(l.endDate),
    legs: l.legs ?? 1,
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
    slot: "morning",
    pending: null,
    tryouts: createTryoutState(TRYOUTS_DAY),
  };
  return state;
}

/** Join FC Batavia (or another club). Roster capacity is enforced by the roster module. */
export function joinClub(c: CampaignState, clubId: string): ReturnType<typeof joinRoster> {
  const r = joinRoster(c.roster, PLAYER_ID, clubId, c.ageGroup);
  if (r.ok) {
    addPreseasonFriendlies(c, clubId);
    scheduleWeek(c, mondayOf(c.day));
    const monday = nextWeekday(c.day, "Mon");
    for (const q of [
      { sceneId: "week.start", onDay: monday },
      { sceneId: "week.lunch", onDay: monday + 2 },
    ]) {
      if (!c.story.queuedScenes.some((x) => x.sceneId === q.sceneId)) c.story.queuedScenes.push(q);
    }
    touch(c);
  }
  return r;
}

/**
 * Preseason friendlies (OPEN_QUESTIONS #25): the first league match is weeks after the opening, so
 * every Saturday between joining and the first league fixture gets a friendly against a league
 * club. Deterministic for the campaign seed; idempotent by fixture id.
 */
export function addPreseasonFriendlies(c: CampaignState, clubId: string): Fixture[] {
  const league = [...c.competitions.leagues].sort((a, b) => a.startDay - b.startDay).find((l) => l.endDay >= c.day);
  if (!league) return [];
  const others = league.clubIds.filter((id) => id !== clubId);
  if (!others.length) return [];
  const firstLeagueDay = Math.min(...c.competitions.fixtures.filter((f) => f.competitionId === league.id).map((f) => f.day));
  const added: Fixture[] = [];
  let i = 0;
  for (let sat = nextWeekday(c.day, "Sat"); sat < firstLeagueDay; sat += 7, i++) {
    const id = `friendly-${clubId}-${sat}`;
    if (c.competitions.fixtures.some((f) => f.id === id)) continue;
    const opponent = others[(hashSeed(`${c.seed}:${id}`) + i) % others.length]!;
    const home = i % 2 === 0;
    const fx: Fixture = {
      id,
      kind: "friendly",
      competitionId: "preseason",
      day: sat,
      homeClubId: home ? clubId : opponent,
      awayClubId: home ? opponent : clubId,
      source: "generated",
      result: null,
    };
    c.competitions.fixtures.push(fx);
    added.push(fx);
  }
  return added;
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
  syncTournamentChoice(c);
  return joined;
}

const WEEKEND_MATCH_SLOTS: readonly Slot[] = ["morning", "afternoon", "evening"];

/** Commitment title for a fixture; tournament games are numbered within the club's weekend. */
export function fixtureTitle(c: CampaignState, fx: Fixture): string {
  if (fx.kind === "league") return fx.movedFromDay !== undefined ? "League match (moved)" : "League match";
  if (fx.kind === "friendly") return "Friendly";
  const t = c.competitions.tournaments.find((x) => x.id === fx.competitionId);
  const mine = playerClubId(c);
  const games = c.competitions.fixtures
    .filter((f) => f.competitionId === fx.competitionId && (f.homeClubId === mine || f.awayClubId === mine))
    .sort((a, b) => a.day - b.day || a.id.localeCompare(b.id));
  const n = games.findIndex((f) => f.id === fx.id) + 1;
  return `${t?.name ?? "Tournament"} · G${n || 1}`;
}

/**
 * Regular week (spec §7; OPEN_QUESTIONS #15): school on weekday school slots, team training
 * Tue/Thu/Fri afternoons, and every fixture of the club that falls on the weekend — one per slot,
 * so a tournament Saturday is two games and Sunday one. A skipped tournament adds nothing.
 * Idempotent: commitment ids are derived from day + kind.
 */
export function scheduleWeek(c: CampaignState, monday: CampaignDay): Commitment[] {
  const clubId = playerClubId(c);
  const offSeason = c.story.facts[SEASON_FACTS.reviewed] === true;
  const added: Commitment[] = [];
  const put = (x: Commitment) => {
    if (x.day === c.day && slotsFor(c.day).indexOf(x.slot) <= slotsFor(c.day).indexOf(c.slot)) return;
    const r = addCommitment(c.schedule, x);
    if (r.ok && r.commitment === x) added.push(x);
  };
  for (let d = Math.max(monday, c.day); d < monday + 7; d++) {
    const w = weekday(d);
    if (!isWeekend(d)) {
      put({ id: `school-${d}`, day: d, slot: "school", kind: "school", title: "School", mandatory: true, refId: null, minutes: 390, status: "scheduled" });
    }
    if (clubId && !offSeason && (w === "Tue" || w === "Thu" || w === "Fri")) {
      put({ id: `training-${d}`, day: d, slot: "afternoon", kind: "training", title: "Team training", mandatory: true, refId: `training-${d}`, minutes: 90, status: "scheduled" });
    }
    if (clubId && (w === "Sat" || w === "Sun")) {
      const onDay = fixturesFor(c, clubId)
        .filter((f) => f.day === d && !(f.kind === "tournament" && !attendsTournament(c, f.competitionId)))
        .sort((a, b) => a.id.localeCompare(b.id));
      onDay.forEach((fx, i) => {
        put({
          id: `${fx.kind}-${fx.id}`,
          day: d,
          slot: WEEKEND_MATCH_SLOTS[Math.min(i, WEEKEND_MATCH_SLOTS.length - 1)]!,
          kind: fx.kind === "tournament" ? "tournament" : "match",
          title: fixtureTitle(c, fx),
          mandatory: true,
          refId: fx.id,
          minutes: 120,
          status: "scheduled",
        });
      });
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
  /** Fixtures that received a modelled result because their day passed unplayed. */
  settled: Fixture[];
  /** Tournament the club entered today, if any. */
  entered: string | null;
}

/**
 * Move the campaign forward: schedule the new week when a Monday is crossed, expire missed
 * commitments, settle the season's unplayed fixtures, fire due consequences, open tournament
 * registrations, close the season when its last day has passed.
 */
export function advanceDays(c: CampaignState, days: number): DayAdvance {
  if (days <= 0) throw new Error("days must be positive");
  const from = c.day;
  const to = from + days;
  const settled: Fixture[] = [];
  const entered: string[] = [];
  // Day by day, so results land and registration windows open on the day they fall.
  for (let d = from + 1; d <= to; d++) {
    if (weekday(d) === "Mon") scheduleWeek(c, d);
    c.day = d;
    settled.push(...settleFixtures(c).map((s) => s.fixture));
    const e = planTournaments(c);
    if (e) {
      entered.push(e.tournament.id);
      scheduleWeek(c, mondayOf(c.day));
    }
    planArc(c);
  }
  c.slot = slotsFor(to)[0]!;
  const missed = advanceTo(c.schedule, to);
  const fired = processDue(storyContext(c));
  syncStoryFlags(c);
  closeSeason(c);
  const unlocked = refreshUnlocks(c.progression);
  syncTryouts(c);
  touch(c);
  return { from, to, missed, fired, unlocked, settled, entered: entered.at(-1) ?? null };
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
