import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { formatRealTime } from "../../src/match/pace";
import { runPace, type PaceRun } from "../../src/perf/pace";
import { createMatch, isFinished, tick } from "../../src/sim/engine";
import { playerById } from "../../src/sim/perception";
import { Rng } from "../../src/sim/rng";
import type { MatchState, PlayerCommand } from "../../src/sim/types";
import { loadCatalog, type CatalogFile, type MomentCategory } from "../../src/tactics/catalog";
import { coverageReport } from "../../src/tactics/coverage";
import { readField } from "../../src/tactics/features";
import { instantiateIntent } from "../../src/tactics/intents";
import { GK_PACING, pacingFor } from "../../src/tactics/recognition";
import { commit, createSession, observe, type TacticalSession } from "../../src/tactics/session";
import { testConfig } from "../helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);
const MIN = 60_000;
const CATEGORIES: readonly MomentCategory[] = ["on_ball", "off_ball", "defending", "transition"];

interface Issued {
  entryId: string;
  tick: number;
  command: PlayerCommand;
  hadBall: number;
  possession: MatchState["possession"];
}

/** A full keeper match with a scripted user, keeping the command issued at each commit and the state it was issued into. */
function keeperMatch(seed: number): { session: TacticalSession; state: MatchState; me: string; issued: Issued[] } {
  const cfg = testConfig(seed);
  const gk = cfg.home.squad.find((p) => p.role === 1);
  if (!gk) throw new Error("no keeper");
  const state = createMatch({ ...cfg, controlled: { side: "home", playerId: gk.id } });
  const session = createSession(catalog, pacingFor("GK"));
  const user = new Rng(seed);
  const issued: Issued[] = [];
  let pendingUntil = -1;
  while (!isFinished(state)) {
    if (observe(session, state)) pendingUntil = state.clock.tick + user.int(2, 8);
    if (session.active && state.clock.tick >= pendingUntil) {
      const m = session.active;
      const pick = user.pick(m.options)!;
      const res = commit(session, state, pick.id, user.range(0.6, 1));
      if (res.issued) issued.push({ entryId: m.entryId, tick: state.clock.tick, command: res.issued, hadBall: m.read.hasBall, possession: state.possession });
    }
    tick(state);
  }
  return { session, state, me: gk.id, issued };
}

describe("goalkeeper calibration", () => {
  const paceRuns: PaceRun[] = [
    runPace(catalog, 2000, "GK", "quick", 60),
    runPace(catalog, 2001, "GK", "typical", 60),
    runPace(catalog, 2002, "GK", "slow", 60),
  ];

  it("keeper matches stay within 6–8 real minutes over 60 simulated minutes", () => {
    for (const r of paceRuns) {
      expect(r.simMinutes, `seed ${r.seed}`).toBeCloseTo(60, 0);
      expect(r.realMs, `seed ${r.seed}: ${formatRealTime(r.realMs)}`).toBeGreaterThanOrEqual(6 * MIN);
      expect(r.realMs, `seed ${r.seed}: ${formatRealTime(r.realMs)}`).toBeLessThanOrEqual(8 * MIN);
      expect(r.withinBand).toBe(true);
    }
  });

  it("keeper matches produce 18–25 moments with a keeper-sized on-ball share", () => {
    for (const r of paceRuns) {
      expect(r.moments, `seed ${r.seed}`).toBeGreaterThanOrEqual(GK_PACING.total[0]);
      expect(r.moments, `seed ${r.seed}`).toBeLessThanOrEqual(GK_PACING.total[1]);
      expect(r.onBall, `seed ${r.seed} on-ball`).toBeGreaterThanOrEqual(GK_PACING.onBall[0] - 1);
      expect(r.onBall, `seed ${r.seed} on-ball`).toBeLessThanOrEqual(GK_PACING.onBall[1]);
    }
  });

  it("is deterministic for a keeper: same seed replays to the same real time, moments and score", () => {
    const again = runPace(catalog, 2001, "GK", "typical", 60);
    expect(again.realMs).toBe(paceRuns[1]!.realMs);
    expect(again.moments).toBe(paceRuns[1]!.moments);
    expect(again.score).toBe(paceRuns[1]!.score);
  });

  const matches = [2, 7, 11].map(keeperMatch);

  it("moments are varied keeper decisions, not one repeated prompt", () => {
    for (const { session, state } of matches) {
      const rep = coverageReport(session.records, GK_PACING);
      expect(rep.total, `seed ${state.seed}`).toBeGreaterThanOrEqual(GK_PACING.total[0]);
      expect(rep.total, `seed ${state.seed}`).toBeLessThanOrEqual(GK_PACING.total[1]);
      expect(rep.uniqueEntries, `seed ${state.seed} variety`).toBeGreaterThanOrEqual(6);
      for (const cat of CATEGORIES) expect(rep.byCategory[cat], `seed ${state.seed} ${cat}`).toBeGreaterThan(0);
      const byEntry = new Map<string, number>();
      for (const r of session.records) byEntry.set(r.moment.entryId, (byEntry.get(r.moment.entryId) ?? 0) + 1);
      const most = Math.max(...byEntry.values());
      expect(most / rep.total, `seed ${state.seed} most-used entry share`).toBeLessThanOrEqual(0.45);
      expect(rep.shortfalls.filter((s) => !/on-ball/.test(s)), `seed ${state.seed}`).toEqual([]);
    }
  });

  it("every keeper moment fires only from a state that supports it", () => {
    for (const { session } of matches) {
      for (const r of session.records) {
        const read = r.moment.read;
        expect(r.moment.role).toBe("GK");
        expect(r.moment.options.length).toBeGreaterThanOrEqual(2);
        switch (r.moment.entryId) {
          case "GK_POS_01":
          case "GK_POS_02":
            expect(read.ourPossession).toBe(1);
            expect(read.hasBall).toBe(0);
            break;
          case "GK_LINE_01":
          case "GK_CROSS_01":
          case "GK_1V1_01":
          case "GK_SHOT_01":
          case "GK_TRANS_02":
            expect(read.theirPossession).toBe(1);
            break;
          case "GK_SWEEP_01":
            expect(read.looseBall).toBe(1);
            expect(read.ballInOurBox).toBe(1);
            break;
          case "GK_BUILD_01":
          case "GK_BUILD_02":
          case "GK_BUILD_03":
          case "GK_TRANS_01":
            expect(read.hasBall).toBe(1);
            break;
          case "GK_RECV_01":
            expect(read.receiving).toBe(1);
            break;
          default:
            throw new Error(`unexpected keeper entry ${r.moment.entryId}`);
        }
        if (r.moment.entryId === "GK_1V1_01") expect(read.teammatePressing).toBe(0);
        if (r.moment.entryId === "GK_CROSS_01") expect(read.ballWide).toBeGreaterThan(0.55);
      }
    }
  });

  it("each decision resolves into the next match state: a real command, separate grades, and a settled outcome", () => {
    for (const { session, issued, state } of matches) {
      expect(issued.length).toBe(session.records.length);
      for (const i of issued) {
        // off-ball decisions move/press/hold the keeper; on-ball ones pass, carry or hold the ball
        if (i.hadBall === 1) expect(["pass", "carry", "hold", "shoot"]).toContain(i.command.type);
        else expect(["move", "press", "hold", "screen"]).toContain(i.command.type);
      }
      // the only intent that can vanish between recognition and commit is a sweep whose ball our own side reached first
      const unavailable = session.records.filter((r) => r.decision.band === "intent_unavailable");
      expect(unavailable.length).toBeLessThanOrEqual(1);
      for (const r of unavailable) expect(r.moment.entryId).toBe("GK_SWEEP_01");
      for (const r of session.records) {
        expect(r.outcome, `${r.moment.entryId} outcome`).not.toBeNull();
        expect(r.outcome!.resolvedTick).toBeGreaterThan(r.decision.commitTick);
        if (r.decision.band === "intent_unavailable") continue;
        expect(r.decision.quality).not.toBeNull();
        expect(r.execution).not.toBeNull();
      }
      const rep = coverageReport(session.records, GK_PACING);
      expect(rep.outcomes.unresolved).toBe(0);
      expect(rep.outcomes.success + rep.outcomes.failure + rep.outcomes.partial + rep.outcomes.neutral).toBe(rep.total);
      expect(rep.outcomes.success).toBeGreaterThan(0);
      expect(rep.outcomes.failure + rep.outcomes.partial).toBeGreaterThan(0);
      // the whistle may cut off a moment recognised inside the harness's last decision delay; nothing older is left hanging
      if (session.active) expect(state.clock.tick - session.active.tick).toBeLessThanOrEqual(8);
      else expect(state.awaiting).toBeNull();
    }
  });

  it("keeps the keeper locked to the keeper: every moment belongs to the controlled player, who ends the match as the keeper", () => {
    for (const { session, state, me } of matches) {
      for (const r of session.records) expect(r.moment.playerId).toBe(me);
      const p = playerById(state, me)!;
      expect(p.role).toBe(1);
      expect(p.side).toBe("home");
    }
  });

  it("keeper start-position intents resolve to moves inside our own box and only for a keeper without the ball", () => {
    const { state, me } = keeperMatchStart(3);
    const gk = playerById(state, me)!;
    const outfield = state.players.find((p) => p.side === "home" && p.role !== 1)!;
    const rules = state.rules;
    const ourGoalX = gk.side === "home" ? 0 : rules.length;
    const stepUp = instantiateIntent(state, gk, "keeper_step_up");
    expect(stepUp?.command.type).toBe("move");
    if (stepUp?.command.type === "move") {
      const off = Math.abs(stepUp.command.target.x - ourGoalX);
      expect(off).toBeGreaterThanOrEqual(6);
      expect(off).toBeLessThanOrEqual(rules.penaltyAreaDepth + 2);
    }
    const nearPost = instantiateIntent(state, gk, "keeper_near_post");
    expect(nearPost?.command.type).toBe("move");
    if (nearPost?.command.type === "move") {
      expect(Math.abs(nearPost.command.target.x - ourGoalX)).toBeLessThan(2);
      expect(Math.abs(nearPost.command.target.y - rules.width / 2)).toBeLessThan(rules.goalWidth / 2);
    }
    expect(instantiateIntent(state, outfield, "keeper_step_up")).toBeNull();
    expect(instantiateIntent(state, outfield, "keeper_near_post")).toBeNull();
    const read = readField(state, gk);
    expect(read.ourLineDepth).toBeGreaterThan(0);
    expect(read.ballWide).toBeGreaterThanOrEqual(0);
    expect(read.ballWide).toBeLessThanOrEqual(1);
    expect(read.distFromOwnGoalLine).toBeGreaterThanOrEqual(0);
  });
});

function keeperMatchStart(seed: number): { state: MatchState; me: string } {
  const cfg = testConfig(seed);
  const gk = cfg.home.squad.find((p) => p.role === 1)!;
  const state = createMatch({ ...cfg, controlled: { side: "home", playerId: gk.id } });
  for (let i = 0; i < 200; i++) tick(state);
  return { state, me: gk.id };
}
