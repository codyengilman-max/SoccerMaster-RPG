import { describe, expect, it } from "vitest";
import { resumeSession } from "../../src/app/session";
import { generateLeagueFixtures, ingestResult, standings, type League } from "../../src/calendar/competitions";
import { dayOfIso, formatDay, weekday } from "../../src/calendar/date";
import { modelResult } from "../../src/calendar/results";
import { commitmentsOn } from "../../src/calendar/schedule";
import { advanceDays, fixturesFor, PLAYER_ID, playerClubId, type CampaignState } from "../../src/campaign/campaign";
import { campaignMatchConfig, fixtureById, TOURNAMENT_FACTS } from "../../src/campaign/match";
import {
  attendsTournament,
  closeSeason,
  planTournaments,
  SCENES,
  SEASON_FACTS,
  seasonPhase,
  seasonReviewDay,
  seasonSummary,
  settleFixtures,
  syncTournamentChoice,
  tournamentViews,
} from "../../src/campaign/season";
import { completeMatch, MAX_SKIPPED_SLOTS, skipToNextEvent, slotActions, takeAction } from "../../src/campaign/week";
import { buildReport } from "../../src/match/report";
import { isPoolPlayer } from "../../src/roster/roster";
import { deserialize, MemoryStore, migrate, SAVE_VERSION, serialize } from "../../src/save/save";
import { runHeadless } from "../../src/sim/engine";
import { chooseInScene, sceneVars, takeQueuedScene, viewScene } from "../../src/story/flow";
import { drainScenes, joinedSession } from "./joined";

type S = ReturnType<typeof joinedSession>;

const D = dayOfIso;
const VALLEY_DAY = D("2026-10-10");
const VALLEY_CUTOFF = D("2026-09-12");

/** What the hub does on mount: surface any due queued scene and play it through with first choices. */
function hub(s: S): string[] {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 20 && (s.campaign.scene || takeQueuedScene(s.campaign, s.scenes))) seen.push(...drainScenes(s));
  return seen;
}

/** Advance to `day` a day at a time, answering scenes as they come (first choice). */
function liveTo(s: S, day: number): string[] {
  const seen: string[] = [];
  while (s.campaign.day < day) {
    seen.push(...hub(s));
    advanceDays(s.campaign, 1);
  }
  seen.push(...hub(s));
  return seen;
}

/** Play the fixture pending in the current slot with the engine and complete it. */
function playPending(s: S) {
  const c = s.campaign;
  const p = c.pending;
  if (!p || p.kind !== "match") throw new Error("no match pending");
  const fx = fixtureById(c, p.fixtureId);
  const st = runHeadless(campaignMatchConfig(c, fx));
  const rep = buildReport(st, [], { fixtureId: fx.id, homeClubId: fx.homeClubId, awayClubId: fx.awayClubId, isPool: isPoolPlayer });
  return { fx, rep, done: completeMatch(c, rep) };
}

const league = (c: CampaignState, term: League["term"]) => c.competitions.leagues.find((l) => l.term === term)!;

describe("scoreline model", () => {
  it("is deterministic, bounded and favours the better side", () => {
    expect(modelResult(50, 50, 1)).toEqual(modelResult(50, 50, 1));
    let strong = 0;
    let weak = 0;
    for (let seed = 0; seed < 400; seed++) {
      const r = modelResult(70, 40, seed);
      expect(r.homeGoals).toBeGreaterThanOrEqual(0);
      expect(r.homeGoals).toBeLessThanOrEqual(9);
      expect(r.awayGoals).toBeLessThanOrEqual(9);
      strong += r.homeGoals;
      weak += r.awayGoals;
    }
    expect(strong).toBeGreaterThan(weak * 1.5);
  });
});

describe("league season", () => {
  it("each league is home and away over ten Saturdays with two reserve dates, and guests never appear", () => {
    const s = joinedSession();
    const c = s.campaign;
    const fall = league(c, "fall");
    const fx = c.competitions.fixtures.filter((f) => f.competitionId === fall.id);
    expect(fx).toHaveLength(30);
    expect(new Set(fx.map((f) => f.day)).size).toBe(10);
    expect(fx.every((f) => weekday(f.day) === "Sat")).toBe(true);
    const lastRound = Math.max(...fx.map((f) => f.day));
    expect(fall.endDay - lastRound).toBe(14);
    const pairs = fx.map((f) => `${f.homeClubId}>${f.awayClubId}`);
    expect(new Set(pairs).size).toBe(30);
    for (const f of fx) expect(pairs).toContain(`${f.awayClubId}>${f.homeClubId}`);
    const guests = c.roster.clubs.filter((k) => k.guest).map((k) => k.id);
    expect(guests.length).toBeGreaterThanOrEqual(3);
    for (const l of c.competitions.leagues) for (const g of guests) expect(l.clubIds).not.toContain(g);
    expect(standings(c.competitions, fall.id).map((r) => r.clubId)).not.toEqual(expect.arrayContaining(guests));
    expect(seasonPhase(c)).toBe("preseason");
  });

  it("single-leg leagues still work when `legs` is absent", () => {
    const l: League = { id: "x", name: "x", ageGroup: "U11", term: "fall", clubIds: ["a", "b", "c", "d"], startDay: 5, endDay: 60 };
    expect(generateLeagueFixtures(l, 1)).toHaveLength(6);
    expect(generateLeagueFixtures({ ...l, legs: 2 }, 1)).toHaveLength(12);
  });

  it("other clubs' rounds are settled as the days pass; a settled table has every club level on games", () => {
    const s = joinedSession();
    const c = s.campaign;
    const fall = league(c, "fall");
    liveTo(s, fall.startDay + 3);
    const table = standings(c.competitions, fall.id, c.day);
    expect(table.every((r) => r.played === 1)).toBe(true);
    const applied = c.competitions.appliedEventIds;
    expect(new Set(applied).size).toBe(applied.length);
    // Settling again changes nothing: every past fixture already has a result.
    expect(settleFixtures(c)).toEqual([]);
    expect(c.competitions.fixtures.filter((f) => f.day < c.day && !f.result)).toEqual([]);
  });

  it("a missed league match is settled for the club and the coach brings it up on Tuesday", () => {
    const s = joinedSession();
    const c = s.campaign;
    const mine = fixturesFor(c, "batavia").find((f) => f.kind === "league")!;
    liveTo(s, mine.day);
    // Preseason friendlies passed unplayed on the way here and were settled the same way.
    const before = Number(c.story.facts[SEASON_FACTS.missedMatches] ?? 0);
    const acts = slotActions(c);
    expect(acts.map((a) => a.id)).toEqual(expect.arrayContaining(["play_match", "skip_match"]));
    const r = takeAction(c, "skip_match");
    expect(r.ok && r.launch === null).toBe(true);
    expect(commitmentsOn(c.schedule, mine.day).find((k) => k.refId === mine.id)!.status).toBe("missed");
    liveTo(s, mine.day + 1);
    expect(fixtureById(c, mine.id).result).not.toBeNull();
    expect(c.story.facts[SEASON_FACTS.missedMatches]).toBe(before + 1);
    expect(c.story.facts[SEASON_FACTS.missedMatchOpponent]).toBeTypeOf("string");
    expect(c.story.queuedScenes.some((q) => q.sceneId === SCENES.missedMatch && weekday(q.onDay!) === "Tue")).toBe(true);
    const seen = liveTo(s, mine.day + 3);
    expect(seen).toContain(SCENES.missedMatch);
    expect(c.story.facts[SEASON_FACTS.missedMatchRecent]).toBeUndefined();
  });
});

describe("tournament weekends", () => {
  /** The day the Valley Rising window opens: entered, family scene queued but not yet shown. */
  function entered(): S {
    const s = joinedSession();
    liveTo(s, VALLEY_CUTOFF - 15);
    advanceDays(s.campaign, 1);
    expect(s.campaign.competitions.entered).toEqual(["valley-rising"]);
    return s;
  }

  it("the club enters the first open cup inside its registration window and the family is asked", () => {
    const s = joinedSession();
    const c = s.campaign;
    liveTo(s, VALLEY_CUTOFF - 15);
    expect(c.competitions.entered).toEqual([]);
    expect(tournamentViews(c).find((v) => v.tournament.id === "valley-rising")!.status).toBe("upcoming");
    advanceDays(c, 1);
    expect(c.competitions.entered).toEqual(["valley-rising"]);
    expect(c.story.facts[SEASON_FACTS.pendingTournament]).toBe("valley-rising");
    expect(c.story.queuedScenes.some((q) => q.sceneId === SCENES.entered)).toBe(true);
    const fx = c.competitions.fixtures.filter((f) => f.competitionId === "valley-rising");
    expect(fx).toHaveLength(3);
    expect(fx.map((f) => weekday(f.day))).toEqual(["Sat", "Sat", "Sun"]);
    expect(fx.every((f) => f.homeClubId === "batavia" || f.awayClubId === "batavia")).toBe(true);
    const opp = fx.map((f) => (f.homeClubId === "batavia" ? f.awayClubId : f.homeClubId));
    expect(new Set(opp).size).toBe(3);
    // Nothing else is entered while the family has not answered.
    expect(planTournaments(c)).toBeNull();
  });

  it("a league match on the tournament Saturday moves to a reserve date and the scene says so", () => {
    const s = entered();
    const c = s.campaign;
    const moved = fixturesFor(c, "batavia").find((f) => f.movedFromDay === VALLEY_DAY)!;
    expect(moved.kind).toBe("league");
    expect(moved.day).toBeGreaterThan(VALLEY_DAY);
    expect(weekday(moved.day)).toBe("Sat");
    const busy = c.competitions.fixtures.filter((f) => f.id !== moved.id && f.day === moved.day && (f.homeClubId === moved.homeClubId || f.awayClubId === moved.awayClubId || f.homeClubId === moved.awayClubId || f.awayClubId === moved.homeClubId));
    expect(busy).toEqual([]);
    expect(String(c.story.facts[SEASON_FACTS.tournamentMoved])).toContain(formatDay(moved.day));
    takeQueuedScene(c, s.scenes);
    const v = viewScene(c, s.scenes)!;
    expect(v.scene.id).toBe(SCENES.entered);
    expect(v.lines.map((l) => l.text).join(" ")).toContain(formatDay(moved.day));
    expect(sceneVars(c).tournament).toBe("Valley Rising Cup");
  });

  it("going with the team puts two games on Saturday and one on Sunday; results never touch the league table", () => {
    const s = entered();
    const c = s.campaign;
    takeQueuedScene(c, s.scenes);
    chooseInScene(c, s.scenes, "season.entered.family");
    expect(c.story.facts[`${SEASON_FACTS.attendPrefix}valley-rising`]).toBe("team");
    expect(c.story.facts[SEASON_FACTS.pendingTournament]).toBeUndefined();
    liveTo(s, VALLEY_DAY);
    const sat = commitmentsOn(c.schedule, VALLEY_DAY).filter((k) => k.kind === "tournament");
    const sun = commitmentsOn(c.schedule, VALLEY_DAY + 1).filter((k) => k.kind === "tournament");
    expect(commitmentsOn(c.schedule, VALLEY_DAY).filter((k) => k.kind === "match")).toEqual([]);
    expect(sat.map((k) => k.slot)).toEqual(["morning", "afternoon"]);
    expect(sun.map((k) => k.slot)).toEqual(["morning"]);
    expect(sat[0]!.title).toMatch(/Valley Rising Cup · G1/);

    const fall = league(c, "fall");
    const before = standings(c.competitions, fall.id, c.day + 2).find((r) => r.clubId === "batavia")!;
    expect(takeAction(c, "play_match").ok).toBe(true);
    const g1 = playPending(s);
    expect(g1.fx.kind).toBe("tournament");
    expect(g1.done.match.ok).toBe(true);
    expect(c.story.facts[TOURNAMENT_FACTS.game]).toBe(1);
    expect(c.story.facts[TOURNAMENT_FACTS.games]).toBe(3);
    // Between games: the coach's word, then the shade-and-orange-slices scene; no league postgame.
    const seen = hub(s);
    expect(seen).toContain(SCENES.between);
    expect(seen).not.toContain("week.postgame");
    expect(takeAction(c, "play_match").ok).toBe(true);
    playPending(s);
    expect(hub(s)).toContain(SCENES.evening);
    // Saturday evening is free time at the hotel; letting it pass lands on Sunday's game.
    expect(c.day).toBe(VALLEY_DAY);
    expect(skipToNextEvent(c)).toEqual({ slots: 1, stoppedAt: "commitment" });
    expect(c.day).toBe(VALLEY_DAY + 1);
    expect(takeAction(c, "play_match").ok).toBe(true);
    playPending(s);
    expect(hub(s)).toContain(SCENES.end);
    expect(["champions", "runners_up", "placement_won", "placement_lost"]).toContain(c.story.facts[TOURNAMENT_FACTS.outcome]);
    const after = standings(c.competitions, fall.id, c.day).find((r) => r.clubId === "batavia")!;
    expect(after.played).toBe(before.played);
    expect(after.points).toBe(before.points);
    const view = tournamentViews(c).find((v) => v.tournament.id === "valley-rising")!;
    expect(view.status).toBe("entered");
    expect(view.summary!.played).toBe(3);
    expect(seasonSummary(c).tournaments[0]!.tournamentId).toBe("valley-rising");
    // Re-submitting a played tournament result is rejected like any other.
    expect(ingestResult(c.competitions, g1.fx.id, { eventId: g1.rep.eventId, homeGoals: 0, awayGoals: 0 }).ok).toBe(false);
  });

  it("skipping the weekend keeps the club's games off the calendar; they are modelled without a missed-match talk", () => {
    const s = entered();
    const c = s.campaign;
    takeQueuedScene(c, s.scenes);
    chooseInScene(c, s.scenes, "season.entered.skip");
    expect(attendsTournament(c, "valley-rising")).toBe(false);
    expect(tournamentViews(c).find((v) => v.tournament.id === "valley-rising")!.status).toBe("skipped");
    liveTo(s, VALLEY_DAY);
    expect(commitmentsOn(c.schedule, VALLEY_DAY).filter((k) => k.kind === "tournament" && k.status === "scheduled")).toEqual([]);
    expect(commitmentsOn(c.schedule, VALLEY_DAY).filter((k) => k.kind === "match")).toEqual([]);
    const missedBefore = c.story.facts[SEASON_FACTS.missedMatches];
    liveTo(s, VALLEY_DAY + 3);
    const fx = c.competitions.fixtures.filter((f) => f.competitionId === "valley-rising");
    expect(fx.every((f) => f.result !== null)).toBe(true);
    expect(c.story.facts[SEASON_FACTS.missedMatches]).toBe(missedBefore);
    expect(c.story.queuedScenes.some((q) => q.sceneId === SCENES.missedMatch)).toBe(false);
    const view = tournamentViews(c).find((v) => v.tournament.id === "valley-rising")!;
    expect(view.summary!.played).toBe(3);
    // The friend's family went; the skip has a delayed cost that is still to land or has landed.
    expect(c.story.facts["tournament_skipped"]).toBe(true);
  });

  it("qualification uses only evidence at the cutoff: a .500 requirement is judged on league results by then", () => {
    const s = joinedSession();
    const c = s.campaign;
    const royal = c.competitions.tournaments.find((t) => t.id === "royal-holiday")!;
    liveTo(s, royal.cutoffDay - 10);
    // Make the club clearly under .500 with modelled results only (no matches played on screen).
    const view = tournamentViews(c).find((v) => v.tournament.id === "royal-holiday")!;
    const rec = seasonSummary(c).record;
    if (rec.won + rec.drawn / 2 >= rec.lost + rec.drawn / 2) {
      expect(["window", "entered"]).toContain(view.status);
    } else {
      expect(view.status).toBe("blocked");
      expect(view.reasons.join(" ")).toMatch(/record|\.500/i);
      expect(c.competitions.entered).not.toContain("royal-holiday");
    }
    // Major out-of-state events stay closed to a U11 side whatever the record.
    const pacific = tournamentViews(c).find((v) => v.tournament.id === "pacific-wave")!;
    expect(["blocked", "upcoming"]).toContain(pacific.status);
    liveTo(s, D("2027-01-20"));
    expect(c.competitions.entered).not.toContain("pacific-wave");
  });
});

describe("letting time pass", () => {
  it("skips free slots, attends school on the way, and stops at a training, a scene or the cap", () => {
    const s = joinedSession();
    const c = s.campaign;
    hub(s);
    const r = skipToNextEvent(c);
    expect(["commitment", "scene"]).toContain(r.stoppedAt);
    expect(r.slots).toBeGreaterThan(0);
    expect(r.slots).toBeLessThanOrEqual(MAX_SKIPPED_SLOTS);
    if (r.stoppedAt === "commitment") {
      expect(slotActions(c).some((a) => a.id === "train" || a.id === "play_match")).toBe(true);
    }
    expect(c.schedule.commitments.filter((k) => k.kind === "school" && k.day < c.day).every((k) => k.status === "attended")).toBe(true);
  });
});

describe("season end", () => {
  it("closes once after the last fixture day with facts from the records and a review scene", () => {
    const s = joinedSession();
    const c = s.campaign;
    const review = seasonReviewDay(c);
    expect(weekday(review)).toBe("Mon");
    expect(closeSeason(c)).toBe(false);
    liveTo(s, review - 1);
    expect(c.story.facts[SEASON_FACTS.reviewed]).toBeUndefined();
    advanceDays(c, 1);
    expect(c.story.facts[SEASON_FACTS.reviewed]).toBe(true);
    expect(seasonPhase(c)).toBe("postseason");
    const rec = seasonSummary(c).record;
    expect(rec.won + rec.drawn + rec.lost).toBe(20);
    expect(c.story.facts[SEASON_FACTS.leagueRecord]).toBe(`${rec.won}-${rec.drawn}-${rec.lost}`);
    expect(c.story.facts[SEASON_FACTS.fallFinish]).toBeGreaterThanOrEqual(1);
    expect(c.story.facts[SEASON_FACTS.springFinish]).toBeLessThanOrEqual(6);
    expect(c.competitions.fixtures.filter((f) => f.kind === "league" && !f.result)).toEqual([]);
    expect(closeSeason(c)).toBe(false);
    const seen = hub(s);
    expect(seen.filter((id) => id === SCENES.seasonEnd)).toHaveLength(1);
    expect(c.story.facts["tryout_intent"]).toBe("stay");
    expect(sceneVars(c).season_record).toBe(c.story.facts[SEASON_FACTS.leagueRecord]);
    expect(playerClubId(c)).toBe("batavia");
    expect(c.roster.people.find((p) => p.id === PLAYER_ID)!.clubId).toBe("batavia");
  });
});

describe("saves", () => {
  it("resumes mid-tournament with the family's pending answer and the moved fixture intact", () => {
    const store = new MemoryStore();
    const s = joinedSession({}, store);
    const c = s.campaign;
    liveTo(s, VALLEY_CUTOFF - 15);
    advanceDays(c, 1);
    expect(c.story.facts[SEASON_FACTS.pendingTournament]).toBe("valley-rising");
    s.save();
    const r = resumeSession(store, store.list()[0]!.slot)!;
    expect(r.campaign).toEqual(JSON.parse(JSON.stringify(c)));
    expect(r.campaign.competitions.entered).toEqual(["valley-rising"]);
    expect(fixturesFor(r.campaign, "batavia").some((f) => f.movedFromDay === VALLEY_DAY)).toBe(true);
    takeQueuedScene(r.campaign, r.scenes);
    expect(viewScene(r.campaign, r.scenes)!.scene.id).toBe(SCENES.entered);
    chooseInScene(r.campaign, r.scenes, "season.entered.friend");
    expect(syncTournamentChoice(r.campaign)).toBeNull();
    expect(r.campaign.story.facts[`${SEASON_FACTS.attendPrefix}valley-rising`]).toBe("friend");
  });

  it("migrates a v2 save by adding the guest clubs tournaments need", () => {
    const s = joinedSession();
    const c = s.campaign;
    const old = JSON.parse(serialize(c, "a")) as { version: number; campaign: CampaignState };
    old.version = 2;
    old.campaign.roster.clubs = old.campaign.roster.clubs.filter((k) => !k.guest);
    old.campaign.roster.rosters = old.campaign.roster.rosters.filter((r) => old.campaign.roster.clubs.some((k) => k.id === r.clubId));
    const migrated = migrate(old as unknown as Record<string, unknown>) as unknown as { version: number; campaign: CampaignState };
    expect(migrated.version).toBe(SAVE_VERSION);
    expect(migrated.campaign.roster.clubs.filter((k) => k.guest).length).toBe(c.roster.clubs.filter((k) => k.guest).length);
    expect(migrated.campaign.roster.rosters.map((r) => r.clubId).sort()).toEqual(c.roster.rosters.map((r) => r.clubId).sort());
    expect(deserialize(JSON.stringify(old)).campaign.roster.clubs.some((k) => k.guest)).toBe(true);
  });
});
