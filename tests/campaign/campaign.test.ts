import { describe, expect, it } from "vitest";
import { acceptResponse, AuthoredProvider, nextToken, type DialogueRequest } from "../../src/ai/provider";
import {
  advanceDays,
  createCampaign,
  eligibilityNow,
  eligibilityPreview,
  fixturesFor,
  joinClub,
  matchSquads,
  MUST_START,
  nextFixture,
  PLAYER_ID,
  recordMatch,
  scheduleWeek,
  storyContext,
  type CampaignState,
} from "../../src/campaign/campaign";
import { commitmentsOn } from "../../src/calendar/schedule";
import { standings } from "../../src/calendar/competitions";
import { buildReport, lineFor, playedIn, resultFor, type MatchReport } from "../../src/match/report";
import { isPoolPlayer, joinRoster, participants, rosterOf, squadFor } from "../../src/roster/roster";
import { createMatch, tick, isFinished } from "../../src/sim/engine";
import { U11_9V9 } from "../../src/sim/rules";
import { deserialize, loadCampaign, MemoryStore, migrate, saveCampaign, SaveError, serialize, SAVE_VERSION } from "../../src/save/save";
import { applyChoice, type Choice } from "../../src/story/consequences";

const profile = { name: "Sam Rivera", appearance: 2, foot: "right" as const, birthMonth: 3 as const, position: 8 as const };

function joined(kind: "boys" | "girls" = "boys"): CampaignState {
  const c = createCampaign({ kind, player: profile, seed: 42 });
  expect(joinClub(c, "batavia")).toEqual({ ok: true });
  return c;
}

/** Simulate a whole match headlessly for the club's next fixture and build the report. */
function playNext(c: CampaignState, seed = 1): MatchReport {
  const fx = nextFixture(c, "batavia")!;
  const { home, away } = matchSquads(c, fx, seed);
  const mine = fx.homeClubId === "batavia" ? "home" : "away";
  const s = createMatch({
    matchId: `${fx.id}-${seed}`,
    seed,
    rules: U11_9V9,
    home: { side: "home", name: fx.homeClubId, shortName: "H", squad: home },
    away: { side: "away", name: fx.awayClubId, shortName: "A", squad: away },
    controlled: { side: mine, playerId: PLAYER_ID },
  });
  while (!isFinished(s)) tick(s);
  return buildReport(s, [], { fixtureId: fx.id, homeClubId: fx.homeClubId, awayClubId: fx.awayClubId, isPool: isPoolPlayer });
}

describe("roster identities", () => {
  it("story characters are the players on the field; the user takes their shirt; the friend shares the field", () => {
    const c = joined();
    const roster = rosterOf(c.roster, "batavia", "U11")!;
    expect(roster.playerIds).toContain(PLAYER_ID);
    expect(roster.playerIds).toContain("friend");
    const squad = squadFor(c.roster, "batavia", "U11", 3, MUST_START);
    expect(squad.find((p) => p.id === PLAYER_ID)!.role).toBe(8);
    // The friend also wears 8, so they move to the nearest shirt (6) and a teammate sits.
    expect(squad.find((p) => p.id === "friend")!.role).toBe(6);
    expect(squad.find((p) => p.id === "bat-sam")).toBeUndefined();
    expect(squad).toHaveLength(9);
    expect(rosterOf(c.roster, "batavia", "U11")!.playerIds.length).toBe(10);
    expect(squad.filter((p) => isPoolPlayer(p.id))).toHaveLength(0);
    expect(squad.map((p) => p.role).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 11]);
    // Opponents are anonymous pool players.
    const opp = squadFor(c.roster, "sonoran", "U11", 3);
    expect(opp.every((p) => isPoolPlayer(p.id))).toBe(true);
    expect(participants({ home: squad, away: opp }).away).toEqual([]);
  });

  it("capacity is enforced and a player can be on one roster only", () => {
    const c = joined();
    const roster = rosterOf(c.roster, "batavia", "U11")!;
    roster.capacity = roster.playerIds.length;
    c.roster.people.push({ id: "new", name: "New Kid", role: "player", clubId: null, shirt: 9, bio: "", reviewStatus: "proposal" });
    expect(joinRoster(c.roster, "new", "batavia", "U11")).toEqual({ ok: false, reason: "full" });
    expect(joinRoster(c.roster, PLAYER_ID, "sonoran", "U11")).toEqual({ ok: true });
    expect(roster.playerIds).not.toContain(PLAYER_ID);
    expect(joinRoster(c.roster, "coach", "batavia", "U11")).toEqual({ ok: false, reason: "not_player" });
  });

  it("girls' campaign has its own friend and parent", () => {
    const b = createCampaign({ kind: "boys", player: profile, seed: 1 });
    const g = createCampaign({ kind: "girls", player: profile, seed: 1 });
    expect(b.roster.people.find((p) => p.id === "friend")!.name).not.toBe(g.roster.people.find((p) => p.id === "friend")!.name);
    expect(g.roster.people.find((p) => p.id === "coach")!.name).toBe("Coach Code");
  });
});

describe("campaign calendar", () => {
  it("a regular week has school, three trainings and the Saturday league match when the league is on", () => {
    const c = joined();
    c.day = 35; // Monday of the first league week
    scheduleWeek(c, 35);
    const kinds = (d: number) => commitmentsOn(c.schedule, d).map((x) => x.kind);
    expect(kinds(35)).toEqual(["school"]);
    expect(kinds(36)).toEqual(["school", "training"]);
    expect(kinds(37)).toEqual(["school"]);
    expect(kinds(38)).toEqual(["school", "training"]);
    expect(kinds(39)).toEqual(["school", "training"]);
    expect(kinds(40)).toEqual(["match"]);
    expect(scheduleWeek(c, 35)).toEqual([]);
  });

  it("before joining a club there is school only", () => {
    const c = createCampaign({ kind: "boys", player: profile, seed: 42 });
    scheduleWeek(c, 0);
    expect(c.schedule.commitments.every((x) => x.kind === "school")).toBe(true);
  });

  it("advancing days schedules new weeks, records misses and fires due consequences", () => {
    const c = joined();
    const skip: Choice = {
      id: "t",
      label: "",
      eligibility: [],
      immediate: [],
      delayed: [{ id: "later", afterDays: 3, effects: [{ type: "flag", id: "later_fired" }] }],
      repair: [],
      expiresDay: null,
    };
    applyChoice(storyContext(c), skip);
    const a = advanceDays(c, 2);
    expect(a.fired).toEqual([]);
    const b = advanceDays(c, 7);
    expect(b.fired.map((f) => f.key)).toEqual(["t:later"]);
    expect(c.story.flags).toContain("later_fired");
    expect(b.missed.some((m) => m.kind === "training")).toBe(true);
    expect(c.day).toBe(9);
    expect(c.revision).toBeGreaterThan(0);
  });
});

describe("matches into the campaign", () => {
  it("records a match once into standings and keeps the evidence; the duplicate changes nothing", () => {
    const c = joined();
    c.day = 33;
    const report = playNext(c);
    expect(report.finished).toBe(true);
    expect(playedIn(report, PLAYER_ID)).toBe(true);
    expect(playedIn(report, "friend")).toBe(true);
    expect(playedIn(report, "coach")).toBe(false);
    expect(lineFor(report, PLAYER_ID)!.passes).toBeGreaterThan(0);
    const r1 = recordMatch(c, report);
    expect(r1.ok).toBe(true);
    const table = standings(c.competitions, "fall-u11");
    const r2 = recordMatch(c, report);
    expect(r2).toEqual({ ok: false, reason: "duplicate_event" });
    expect(standings(c.competitions, "fall-u11")).toEqual(table);
    expect(c.reports).toHaveLength(1);
    const mine = table.find((r) => r.clubId === "batavia")!;
    expect(mine.played).toBe(1);
    const side = report.home.clubId === "batavia" ? "home" : "away";
    expect(resultFor(report, side)).toBe(mine.won ? "win" : mine.lost ? "loss" : "draw");
  });

  it("eligibility now and the preview paths reflect the club's real position", () => {
    const c = joined();
    c.day = 33;
    const now = eligibilityNow(c);
    expect(now.find((e) => e.tournamentId === "valley-rising")!.eligible).toBe(true);
    expect(now.find((e) => e.tournamentId === "pacific-wave")!.eligible).toBe(false);
    expect(now.find((e) => e.tournamentId === "lone-star")!.eligible).toBe(false);
    expect(now.find((e) => e.tournamentId === "state")!.eligible).toBe(false);
    const paths = eligibilityPreview(c);
    expect(paths).toHaveLength(3);
    const win = paths.find((p) => p.assume === "win_out")!;
    const lose = paths.find((p) => p.assume === "lose_out")!;
    expect(win.eligible).toContain("state");
    expect(win.eligible).toContain("tuzona");
    expect(lose.eligible).not.toContain("state");
    expect(win.eligible).not.toContain("pacific-wave");
    // home and away against five clubs in each of the two league terms
    expect(fixturesFor(c, "batavia").filter((f) => f.kind === "league")).toHaveLength(20);
  });
});

describe("saves", () => {
  it("round-trips a campaign with pending consequences, results and schedule intact", () => {
    const c = joined();
    c.day = 33;
    recordMatch(c, playNext(c));
    applyChoice(storyContext(c), {
      id: "p",
      label: "",
      eligibility: [],
      immediate: [{ type: "promise", id: "pr", by: "friend", text: "I'll pass you the ball" }],
      delayed: [{ id: "d", afterDays: 5, effects: [] }],
      repair: [],
      expiresDay: null,
    });
    advanceDays(c, 2);
    const store = new MemoryStore();
    const summary = saveCampaign(store, "slot-1", c, new Date("2026-09-14T00:00:00Z"));
    expect(summary).toMatchObject({ slot: "slot-1", playerName: "Sam Rivera", day: 35, version: SAVE_VERSION });
    const loaded = loadCampaign(store, "slot-1")!;
    expect(loaded).toEqual(JSON.parse(JSON.stringify(c)));
    expect(loaded.story.pending).toHaveLength(1);
    // The played match plus every off-screen fixture settled while the days passed, each exactly once.
    expect(loaded.competitions.appliedEventIds).toContain(c.reports[0]!.eventId);
    expect(loaded.competitions.appliedEventIds).toHaveLength(1 + loaded.competitions.fixtures.filter((f) => f.result && f.source === "generated" && f.id !== c.reports[0]!.fixtureId).length);
    expect(new Set(loaded.competitions.appliedEventIds).size).toBe(loaded.competitions.appliedEventIds.length);
    expect(loaded.reports[0]!.eventId).toBe(c.reports[0]!.eventId);
    expect(store.list()).toHaveLength(1);
    // Loaded state keeps behaving: the duplicate result is still rejected.
    expect(recordMatch(loaded, c.reports[0]!)).toEqual({ ok: false, reason: "duplicate_event" });
    expect(loadCampaign(store, "missing")).toBeNull();
  });

  it("rejects corrupt, unsupported and malformed saves with a typed error", () => {
    expect(() => deserialize("{nope")).toThrow(SaveError);
    expect(() => deserialize(JSON.stringify({ version: 0, campaign: {} }))).toThrow(/not supported/);
    expect(() => deserialize(JSON.stringify({ version: SAVE_VERSION + 1, campaign: {} }))).toThrow(/newer/);
    expect(() => deserialize(JSON.stringify({ version: SAVE_VERSION, savedAt: "x", slot: "s", campaign: { id: "c" } }))).toThrow(/missing/);
    expect(() => migrate({ version: SAVE_VERSION })).not.toThrow();
  });

  it("serialize is deterministic for equal state and stamps the header", () => {
    const c = joined();
    const t = new Date("2026-09-14T00:00:00Z");
    expect(serialize(c, "a", t)).toBe(serialize(structuredClone(c), "a", t));
    expect(deserialize(serialize(c, "a", t)).savedAt).toBe("2026-09-14T00:00:00.000Z");
  });
});

describe("dialogue provider", () => {
  it("authored provider is off; stale or mismatched responses fall back to the authored line", async () => {
    const p = new AuthoredProvider();
    expect(p.available()).toBe(false);
    const req: DialogueRequest = { revision: 3, token: nextToken(), sceneId: "s", speakerId: "friend", authored: "Hey.", approvedFacts: {}, choiceMeaning: null };
    expect(await p.render(req)).toBeNull();
    expect(acceptResponse(req, null, 3)).toEqual({ ok: false, reason: "unavailable", text: "Hey." });
    expect(acceptResponse(req, { token: req.token, revision: 3, text: "Hey there." }, 3)).toEqual({ ok: true, text: "Hey there." });
    expect(acceptResponse(req, { token: req.token, revision: 3, text: "Hey there." }, 4).ok).toBe(false);
    expect(acceptResponse(req, { token: "other", revision: 3, text: "Hey there." }, 3)).toMatchObject({ reason: "token_mismatch", text: "Hey." });
    expect(acceptResponse(req, { token: req.token, revision: 3, text: "  " }, 3)).toMatchObject({ reason: "empty" });
  });
});
