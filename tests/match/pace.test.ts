import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { MAX_SKIP_TICKS_PER_FRAME } from "../../src/match/clock";
import { ACCEPTABLE_BAND_MS, formatRealTime, PREFERRED_BAND_MS, withinAcceptable, withinPreferred } from "../../src/match/pace";
import { ANSWER_MS, LEAD_IN_MIN_MS, LEAD_IN_MS } from "../../src/match/runtime";
import { runPace, type PaceRun } from "../../src/perf/pace";
import { ROLE_BY_NUMBER } from "../../src/sim/types";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { DIRECT_RANGE, pacingFor } from "../../src/tactics/recognition";

const catalog = loadCatalog(catalogJson as CatalogFile);
const MIN = 60_000;

/**
 * Acceptance for "a complete match in 5–7 real minutes (4–8 acceptable)": whole matches through the
 * real runtime at a fixed frame cadence for quick, typical and slow players, at 60 and 30 fps. The
 * measurement is the runtime's own real-time accounting (what the full-time screen shows), pauses
 * excluded — not wall time on this machine.
 */
describe("match duration", () => {
  const runs: PaceRun[] = [
    runPace(catalog, 2000, "CM", "typical", 60),
    runPace(catalog, 2001, "ST", "quick", 60),
    runPace(catalog, 2002, "CB", "slow", 60),
    runPace(catalog, 2003, "CM", "typical", 30),
  ];

  it("finishes every complete 60-minute match within 4–8 real minutes, at 60 and 30 fps", () => {
    for (const r of runs) {
      expect(r.simMinutes, `seed ${r.seed}`).toBeCloseTo(60, 0);
      expect(r.realMs, `seed ${r.seed} ${r.player}: ${formatRealTime(r.realMs)}`).toBeGreaterThanOrEqual(ACCEPTABLE_BAND_MS[0]);
      expect(r.realMs, `seed ${r.seed} ${r.player}: ${formatRealTime(r.realMs)}`).toBeLessThanOrEqual(ACCEPTABLE_BAND_MS[1]);
      expect(r.withinAcceptable).toBe(true);
    }
    // a typical player lands in the preferred band
    for (const r of runs.filter((x) => x.player === "typical")) expect(r.withinPreferred, `seed ${r.seed}: ${formatRealTime(r.realMs)}`).toBe(true);
  });

  it("gives 12–18 direct-involvement moments, each with 3–6 answers", () => {
    for (const r of runs) {
      expect(r.moments, `seed ${r.seed}`).toBeGreaterThanOrEqual(DIRECT_RANGE[0]);
      expect(r.moments, `seed ${r.seed}`).toBeLessThanOrEqual(DIRECT_RANGE[1]);
      expect(r.options[0], `seed ${r.seed} min answers`).toBeGreaterThanOrEqual(3);
      expect(r.options[1], `seed ${r.seed} max answers`).toBeLessThanOrEqual(6);
      expect(r.timeouts).toBe(0);
    }
  });

  it("spends real time on the player's moments, not on routine play", () => {
    for (const r of runs) {
      const ph = r.byPhase;
      const involvement = ph.lead_in + ph.question + ph.timer + ph.resolving + ph.feedback;
      expect(involvement, `seed ${r.seed}`).toBeGreaterThan(0.75 * r.realMs);
      expect(ph.routine, `seed ${r.seed} routine`).toBeLessThan(0.2 * r.realMs);
      expect(ph.lead_in).toBeGreaterThanOrEqual(r.moments * LEAD_IN_MIN_MS * 0.98);
      expect(ph.lead_in).toBeLessThanOrEqual(r.moments * (LEAD_IN_MS + 40));
      expect(ph.timer).toBeLessThanOrEqual(r.moments * ANSWER_MS);
      expect(ph.halftime).toBeGreaterThan(0);
    }
  });

  it("skipping is the same simulation: score matches the goal events, players tire, no frame runs past the tick cap", () => {
    for (const r of runs) {
      const [h, a] = r.score.split("–").map(Number);
      expect(h! + a!).toBe(r.goalEvents);
      expect(r.fatigueMean).toBeGreaterThan(0.05);
      expect(r.maxTicksPerFrame).toBeLessThanOrEqual(MAX_SKIP_TICKS_PER_FRAME);
    }
  });

  it("every one of the nine positions completes 60 simulated minutes in the acceptable band with 12–18 moments", () => {
    for (const role of Object.values(ROLE_BY_NUMBER)) {
      const r = runPace(catalog, 2010, role, "typical", 60);
      const [lo, hi] = pacingFor(role).total;
      expect(r.simMinutes, role).toBeCloseTo(60, 0);
      expect(r.withinAcceptable, `${role}: ${formatRealTime(r.realMs)}`).toBe(true);
      expect(r.moments, `${role} moments`).toBeGreaterThanOrEqual(lo);
      expect(r.moments, `${role} moments`).toBeLessThanOrEqual(hi);
      expect(r.maxTicksPerFrame).toBeLessThanOrEqual(MAX_SKIP_TICKS_PER_FRAME);
    }
  }, 120_000);

  it("a player who never answers still completes the match: every moment times out to an engine-selected action", () => {
    const r = runPace(catalog, 2004, "DM", "timeout", 60);
    expect(r.simMinutes).toBeCloseTo(60, 0);
    expect(r.timeouts).toBe(r.moments);
    expect(r.byPhase.timer).toBeCloseTo(r.moments * ANSWER_MS, -3);
    expect(r.realMs).toBeLessThanOrEqual(ACCEPTABLE_BAND_MS[1] + 2 * MIN); // 18 × 15 s of silence is the only way past the band
  });

  it("is deterministic: the same seed, role, player and cadence give the same real time and score", () => {
    const again = runPace(catalog, 2000, "CM", "typical", 60);
    expect(again.realMs).toBe(runs[0]!.realMs);
    expect(again.score).toBe(runs[0]!.score);
    expect(again.moments).toBe(runs[0]!.moments);
  });

  it("band helpers match the documented ranges", () => {
    expect(PREFERRED_BAND_MS).toEqual([5 * MIN, 7 * MIN]);
    expect(ACCEPTABLE_BAND_MS).toEqual([4 * MIN, 8 * MIN]);
    expect(withinPreferred(6 * MIN)).toBe(true);
    expect(withinPreferred(4.5 * MIN)).toBe(false);
    expect(withinAcceptable(4.5 * MIN)).toBe(true);
    expect(withinAcceptable(8 * MIN + 1)).toBe(false);
    expect(formatRealTime(5 * MIN + 48_000)).toBe("5:48");
  });
});
