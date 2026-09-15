import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { MAX_TICKS_PER_FRAME } from "../../src/match/clock";
import { createPace, DEFAULT_PACE, expectedRemainingMoments, formatRealTime, paceScale, routineScaleFor, simRemainingMs } from "../../src/match/pace";
import { createRuntime, frame } from "../../src/match/runtime";
import { runPace, type PaceRun } from "../../src/perf/pace";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { DEFAULT_PACING } from "../../src/tactics/recognition";
import { testConfig } from "../helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);
const MIN = 60_000;

/**
 * Acceptance for "a complete match in 6–8 real minutes": whole matches through the real runtime at a
 * fixed frame cadence, for quick, typical and slow players, at 60 and 30 fps. The measurement is the
 * runtime's own real-time accounting (what the full-time screen shows), not wall time on this machine.
 */
describe("pace director", () => {
  const runs: PaceRun[] = [
    runPace(catalog, 2000, "CM", "typical", 60),
    runPace(catalog, 2001, "ST", "quick", 60),
    runPace(catalog, 2002, "CB", "slow", 60),
    runPace(catalog, 2003, "CM", "typical", 30),
  ];

  it("finishes every complete 60-minute match within 6–8 real minutes, at 60 and 30 fps", () => {
    for (const r of runs) {
      expect(r.simMinutes, `seed ${r.seed}`).toBeCloseTo(60, 0);
      expect(r.realMs, `seed ${r.seed} ${r.player}: ${formatRealTime(r.realMs)}`).toBeGreaterThanOrEqual(6 * MIN);
      expect(r.realMs, `seed ${r.seed} ${r.player}: ${formatRealTime(r.realMs)}`).toBeLessThanOrEqual(8 * MIN);
      expect(r.withinBand).toBe(true);
    }
  });

  it("keeps 18–25 tactical moments (10–14 on the ball for outfield roles)", () => {
    for (const r of runs) {
      expect(r.moments, `seed ${r.seed}`).toBeGreaterThanOrEqual(18);
      expect(r.moments, `seed ${r.seed}`).toBeLessThanOrEqual(25);
      expect(r.onBall).toBeGreaterThanOrEqual(10);
      expect(r.onBall).toBeLessThanOrEqual(14);
    }
  });

  it("spends real time where it matters: decisions and live aftermath, not routine play", () => {
    for (const r of runs) {
      const ph = r.byPhase;
      expect(ph.window + ph.aftermath).toBeGreaterThan(1.5 * MIN);
      expect(ph.routine).toBeGreaterThan(MIN); // fast-forward is visible, not skipped...
      expect(ph.routine).toBeLessThan(5.5 * MIN); // ...but never most of the match
      expect(ph.halftime).toBeGreaterThan(0);
    }
  });

  it("fast-forward is the same simulation: score matches the goal events, players tire, no frame runs past the tick cap", () => {
    for (const r of runs) {
      const [h, a] = r.score.split("–").map(Number);
      expect(h! + a!).toBe(r.goalEvents);
      expect(r.fatigueMean).toBeGreaterThan(0.05);
      expect(r.maxTicksPerFrame).toBeLessThanOrEqual(MAX_TICKS_PER_FRAME);
      expect(r.peakScale).toBeLessThanOrEqual(DEFAULT_PACE.routineMaxScale);
    }
  });

  it("is deterministic: the same seed, role, player and cadence give the same real time and score", () => {
    const again = runPace(catalog, 2000, "CM", "typical", 60);
    expect(again.realMs).toBe(runs[0]!.realMs);
    expect(again.score).toBe(runs[0]!.score);
    expect(again.moments).toBe(runs[0]!.moments);
  });

  it("routine speed rises when behind budget and falls back toward the minimum when ahead", () => {
    const rt = createRuntime(testConfig(1), catalog);
    const inp = { state: rt.state, pacing: DEFAULT_PACING, momentsSoFar: 0, windowOpen: false, forceFast: false };
    const fresh = createPace();
    const onPlan = routineScaleFor(fresh, inp);
    expect(onPlan).toBeGreaterThan(1);
    const behind = createPace();
    behind.realMs.window = 5 * MIN; // decisions have already eaten most of the budget
    expect(routineScaleFor(behind, inp)).toBeGreaterThan(onPlan);
    expect(routineScaleFor(behind, inp)).toBeLessThanOrEqual(DEFAULT_PACE.routineMaxScale);
    const ahead = createPace({ ...DEFAULT_PACE, targetRealMs: 60 * MIN });
    expect(routineScaleFor(ahead, inp)).toBe(DEFAULT_PACE.routineMinScale);
    expect(routineScaleFor(fresh, { ...inp, forceFast: true })).toBe(DEFAULT_PACE.routineMaxScale);
  });

  it("reserves real time for the moments still expected and releases it as they happen", () => {
    const rt = createRuntime(testConfig(1), catalog);
    const start = expectedRemainingMoments(rt.state, DEFAULT_PACING, 0);
    expect(start).toBeGreaterThanOrEqual(DEFAULT_PACING.total[0]);
    expect(start).toBeLessThanOrEqual(DEFAULT_PACING.total[1]);
    expect(expectedRemainingMoments(rt.state, DEFAULT_PACING, 25)).toBe(0);
    expect(simRemainingMs(rt.state)).toBe(rt.state.rules.halves * rt.state.rules.halfLengthSeconds * 1000);
  });

  it("charges each frame's real time to the phase it is spent in and excludes paused frames", () => {
    const rt = createRuntime(testConfig(2), catalog);
    for (let i = 0; i < 30; i++) frame(rt, 20);
    expect(rt.pace.realMs.routine).toBeCloseTo(600, 6);
    rt.paused = true;
    for (let i = 0; i < 30; i++) frame(rt, 20);
    expect(rt.pace.realMs.routine).toBeCloseTo(600, 6);
    expect(rt.clock.realElapsedMs).toBeCloseTo(600, 6);
    const p = createPace();
    paceScale(p, { state: rt.state, pacing: DEFAULT_PACING, momentsSoFar: 0, windowOpen: true, forceFast: false }, 16);
    expect(p.phase).toBe("window");
    expect(p.realMs.window).toBe(16);
    paceScale(p, { state: rt.state, pacing: DEFAULT_PACING, momentsSoFar: 1, windowOpen: false, forceFast: false }, 16);
    expect(p.phase).toBe("aftermath");
    expect(p.realMs.aftermath).toBe(16);
  });
});
