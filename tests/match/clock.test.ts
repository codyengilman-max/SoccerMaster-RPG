import { describe, expect, it } from "vitest";
import { advanceClock, createClock, MAX_TICKS_PER_FRAME, realMsFor, SLOW_SCALE } from "../../src/match/clock";
import { TICK_MS } from "../../src/sim/types";

describe("runtime clock", () => {
  it("converts real time into whole ticks and carries the remainder", () => {
    const c = createClock(1);
    expect(advanceClock(c, 16)).toBe(0);
    expect(advanceClock(c, 16)).toBe(0);
    expect(advanceClock(c, 16)).toBe(0); // 48 ms owed
    expect(advanceClock(c, 16)).toBe(1); // 64 → 1 tick, 14 carried
    expect(c.carryMs).toBeCloseTo(14, 6);
  });

  it("slow motion runs the same ticks, just fewer per real second", () => {
    const normal = createClock(1);
    const slow = createClock(SLOW_SCALE);
    let n = 0;
    let s = 0;
    for (let i = 0; i < 60; i++) {
      n += advanceClock(normal, 1000 / 60);
      s += advanceClock(slow, 1000 / 60);
    }
    expect(n).toBe(1000 / TICK_MS);
    expect(s).toBeGreaterThanOrEqual(Math.floor(SLOW_SCALE * 20));
    expect(s).toBeLessThanOrEqual(Math.ceil(SLOW_SCALE * 20)); // 0.3 s of sim per real second = 6 ticks
    expect(realMsFor(slow, 2.5)).toBeCloseTo((2500 / SLOW_SCALE), 0); // a medium window ≈ 8.3 real seconds
  });

  it("caps the ticks run after a long stall and drops the backlog", () => {
    const c = createClock(1);
    expect(advanceClock(c, 5000)).toBe(MAX_TICKS_PER_FRAME);
    expect(c.carryMs).toBe(0);
  });

  it("is deterministic in its inputs", () => {
    const a = createClock(SLOW_SCALE);
    const b = createClock(SLOW_SCALE);
    const dts = [16, 17, 33, 16, 100, 8, 16, 16, 45];
    const ra = dts.map((d) => advanceClock(a, d));
    const rb = dts.map((d) => advanceClock(b, d));
    expect(ra).toEqual(rb);
  });
});
