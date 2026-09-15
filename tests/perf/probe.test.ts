import { describe, expect, it } from "vitest";
import { createProbe, formatSummary, LONG_FRAME_MS, percentile, summarize, type FrameSample } from "../../src/perf/probe";

const s = (frameMs: number, simMs = 1, renderMs = 1, ticks = 1): FrameSample => ({ frameMs, simMs, renderMs, ticks });

describe("frame-time probe", () => {
  it("nearest-rank percentiles", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("summarises fps, percentiles, long frames and ticks", () => {
    const samples = [...Array(19)].map(() => s(16.7, 0.5, 0.8, 0));
    samples.push(s(50, 3, 4, 1));
    const sum = summarize(samples);
    expect(sum.frames).toBe(20);
    expect(sum.fps).toBeCloseTo(20000 / (19 * 16.7 + 50), 3);
    expect(sum.frameP50).toBe(16.7);
    expect(sum.frameP95).toBe(16.7);
    expect(sum.frameMax).toBe(50);
    expect(sum.simP95).toBe(0.5);
    expect(sum.renderP95).toBe(0.8);
    expect(sum.longFrames).toBe(1);
    expect(sum.ticks).toBe(1);
    expect(LONG_FRAME_MS).toBeGreaterThan(33);
    expect(formatSummary(sum)).toMatch(/fps · frame p50 16\.7 p95 16\.7 ms .* long 1\/20/);
  });

  it("empty summary is all zeros", () => {
    const sum = summarize([]);
    expect(sum.frames).toBe(0);
    expect(sum.fps).toBe(0);
    expect(sum.frameP95).toBe(0);
  });

  it("rolling window keeps only the most recent `capacity` frames", () => {
    const p = createProbe(4);
    for (let i = 1; i <= 10; i++) p.sample(s(i));
    const sum = p.summary();
    expect(sum.frames).toBe(4);
    expect(sum.frameMax).toBe(10);
    expect(sum.frameP50).toBe(8); // window is 7,8,9,10
    p.reset();
    expect(p.summary().frames).toBe(0);
  });
});
