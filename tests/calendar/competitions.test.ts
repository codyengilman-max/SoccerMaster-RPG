import { describe, expect, it } from "vitest";
import {
  createCompetitions,
  enterTournament,
  entriesAllowed,
  generateLeagueFixtures,
  ingestResult,
  leagueRecord,
  previewEligibilityPaths,
  standings,
  stateQualification,
  tournamentEligibility,
  type CompetitionState,
  type League,
  type Tournament,
} from "../../src/calendar/competitions";

const CLUBS = ["a", "b", "c", "d", "e", "f"];

function league(): League {
  return { id: "fall", name: "Fall", ageGroup: "U11", term: "fall", clubIds: CLUBS, startDay: 33, endDay: 110 };
}

function setup(): CompetitionState {
  const st = createCompetitions();
  st.leagues.push(league());
  st.fixtures.push(...generateLeagueFixtures(league(), 5));
  return st;
}

const MAJOR: Tournament = { id: "pacific", name: "Pacific Wave Cup", minAge: "U13", requirement: "record_500", major: true, day: 200, cutoffDay: 170, matches: 4 };
const OPEN: Tournament = { id: "valley", name: "Valley Rising Cup", minAge: "U11", requirement: "open", major: false, day: 68, cutoffDay: 40, matches: 3 };
const R500: Tournament = { id: "tuzona", name: "Tuzona Challenge", minAge: "U11", requirement: "record_500", major: false, day: 166, cutoffDay: 138, matches: 3 };
/** Cutoff after round 2 of 5 (Saturdays 33, 40 | 47, 54, 61). */
const STATE: Tournament = { id: "state", name: "State", minAge: "U11", requirement: "state_qualification", major: false, day: 278, cutoffDay: 46, matches: 3 };

/** Ingest every league fixture up to `upToDay` with the given scoreline rule. */
function playAll(st: CompetitionState, results: (f: { homeClubId: string; awayClubId: string }) => [number, number], upToDay = Infinity) {
  for (const f of st.fixtures) {
    if (f.kind !== "league" || f.day > upToDay) continue;
    const [h, a] = results(f);
    expect(ingestResult(st, f.id, { eventId: `ev-${f.id}`, homeGoals: h, awayGoals: a }).ok).toBe(true);
  }
}

describe("league fixtures", () => {
  it("round robin: every club plays every other once, one match per Saturday, deterministic", () => {
    const fx = generateLeagueFixtures(league(), 5);
    expect(fx).toHaveLength(15);
    const days = new Set(fx.map((f) => f.day));
    expect(days.size).toBe(5);
    for (const d of days) {
      const onDay = fx.filter((f) => f.day === d).flatMap((f) => [f.homeClubId, f.awayClubId]);
      expect(new Set(onDay).size).toBe(6);
      expect((d - 33) % 7).toBe(0);
    }
    expect(generateLeagueFixtures(league(), 5)).toEqual(fx);
    expect(generateLeagueFixtures(league(), 6)).not.toEqual(fx);
    expect(fx.every((f) => f.source === "generated" && f.kind === "league")).toBe(true);
  });
});

describe("result ingestion and standings", () => {
  it("applies a result once and rejects duplicates, replays and mismatched clubs", () => {
    const st = setup();
    const f = st.fixtures[0]!;
    const res = { eventId: "m1", homeGoals: 2, awayGoals: 1 };
    expect(ingestResult(st, f.id, res).ok).toBe(true);
    const before = standings(st, "fall");
    expect(ingestResult(st, f.id, res)).toEqual({ ok: false, reason: "duplicate_event" });
    expect(ingestResult(st, f.id, { ...res, eventId: "m1-again" })).toEqual({ ok: false, reason: "already_played" });
    expect(ingestResult(st, "nope", res)).toEqual({ ok: false, reason: "unknown_fixture" });
    expect(ingestResult(st, st.fixtures[1]!.id, { eventId: "m2", homeGoals: 0, awayGoals: 0 }, { homeClubId: "zz", awayClubId: "yy" })).toEqual({ ok: false, reason: "club_mismatch" });
    expect(standings(st, "fall")).toEqual(before);
    const home = before.find((r) => r.clubId === f.homeClubId)!;
    expect(home).toMatchObject({ played: 1, won: 1, points: 3, goalsFor: 2, goalsAgainst: 1 });
  });

  it("tournament fixtures never count toward the league table", () => {
    const st = setup();
    st.tournaments.push(OPEN);
    const e = enterTournament(st, OPEN, { clubId: "a", ageGroup: "U11", leagueId: "fall", asOfDay: 35, opponents: ["b", "c"] });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    for (const f of e.fixtures) expect(ingestResult(st, f.id, { eventId: `t-${f.id}`, homeGoals: 5, awayGoals: 0 }).ok).toBe(true);
    const table = standings(st, "fall");
    expect(table.every((r) => r.played === 0 && r.points === 0)).toBe(true);
    expect(leagueRecord(st, "a")).toEqual({ won: 0, drawn: 0, lost: 0 });
  });

  it("sorts by points, goal difference, goals for", () => {
    const st = setup();
    playAll(st, (f) => (f.homeClubId === "a" ? [3, 0] : f.awayClubId === "a" ? [0, 3] : [1, 1]));
    const table = standings(st, "fall");
    expect(table[0]!.clubId).toBe("a");
    expect(table[0]!.points).toBe(15);
    expect(table.slice(1).every((r) => r.points === 4)).toBe(true);
  });
});

describe("eligibility", () => {
  const ctx = (ageGroup: "U11" | "U12" | "U13", asOfDay: number) => ({ clubId: "a", ageGroup, leagueId: "fall", asOfDay });

  it("U11 and U12 can never enter major out-of-state events even with a perfect record", () => {
    const st = setup();
    playAll(st, (f) => (f.homeClubId === "a" ? [3, 0] : f.awayClubId === "a" ? [0, 3] : [1, 1]));
    expect(tournamentEligibility(st, MAJOR, ctx("U11", 120)).eligible).toBe(false);
    expect(tournamentEligibility(st, MAJOR, ctx("U12", 120)).eligible).toBe(false);
    expect(tournamentEligibility(st, MAJOR, ctx("U13", 120)).eligible).toBe(true);
    const e = enterTournament(st, MAJOR, { ...ctx("U11", 120), opponents: ["b"] });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.reasons.join(" ")).toMatch(/U13/);
  });

  it("open tournaments are available to a new team; .500 tournaments need the record by the cutoff", () => {
    const st = setup();
    expect(tournamentEligibility(st, OPEN, ctx("U11", 35)).eligible).toBe(true);
    expect(tournamentEligibility(st, R500, ctx("U11", 35)).eligible).toBe(false);
    playAll(st, (f) => (f.homeClubId === "a" ? [1, 0] : f.awayClubId === "a" ? [0, 1] : [0, 0]));
    expect(tournamentEligibility(st, R500, ctx("U11", 120)).eligible).toBe(true);
  });

  it("state qualification uses standings at the cutoff, not later results", () => {
    const st = setup();
    // Before the cutoff (two rounds played) club a loses everything.
    playAll(st, (f) => (f.homeClubId === "a" ? [0, 2] : f.awayClubId === "a" ? [2, 0] : [1, 1]), STATE.cutoffDay);
    // After the cutoff club a wins everything.
    for (const f of st.fixtures) {
      if (f.result || f.kind !== "league") continue;
      const [h, a]: [number, number] = f.homeClubId === "a" ? [4, 0] : f.awayClubId === "a" ? [0, 4] : [1, 1];
      ingestResult(st, f.id, { eventId: `late-${f.id}`, homeGoals: h, awayGoals: a });
    }
    expect(standings(st, "fall")[0]!.clubId).toBe("a");
    const d = stateQualification(st, "fall", "a", STATE);
    expect(d.qualified).toBe(false);
    expect(d.snapshot.at(-1)!.clubId).toBe("a");
    expect(d.reason).toMatch(/at the cutoff/);
    expect(tournamentEligibility(st, STATE, ctx("U11", 120)).eligible).toBe(false);
  });

  it("entry count is three plus an earned fourth; entries are recorded once", () => {
    const st = setup();
    expect(entriesAllowed(st, "a", 35)).toBe(3);
    playAll(st, (f) => (f.homeClubId === "a" ? [1, 0] : f.awayClubId === "a" ? [0, 1] : [0, 0]));
    expect(entriesAllowed(st, "a", 120)).toBe(4);
    st.tournaments.push(OPEN);
    expect(enterTournament(st, OPEN, { ...ctx("U11", 35), opponents: ["b"] }).ok).toBe(true);
    expect(enterTournament(st, OPEN, { ...ctx("U11", 35), opponents: ["b"] })).toEqual({ ok: false, reasons: ["already entered"] });
    expect(enterTournament(st, { ...OPEN, id: "late" }, { ...ctx("U11", 41), opponents: ["b"] })).toEqual({ ok: false, reasons: ["registration closed"] });
  });

  it("preview shows different eligibility paths without touching state", () => {
    const st = setup();
    st.tournaments.push(OPEN, R500, MAJOR);
    const snapshot = structuredClone(st);
    const paths = previewEligibilityPaths(st, ctx("U11", 35));
    expect(st).toEqual(snapshot);
    const win = paths.find((p) => p.assume === "win_out")!;
    const lose = paths.find((p) => p.assume === "lose_out")!;
    expect(win.eligible).toContain("tuzona");
    expect(lose.eligible).not.toContain("tuzona");
    expect(lose.eligible).toContain("valley");
    expect(win.eligible).not.toContain("pacific");
    expect(win.blocked.find((b) => b.tournamentId === "pacific")!.reasons.join(" ")).toMatch(/U13/);
  });
});
