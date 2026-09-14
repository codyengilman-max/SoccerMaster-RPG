import { describe, expect, it } from "vitest";
import { gestureAccuracy, isCancelGesture, readGesture, tapAccuracy } from "../../src/gesture/gesture";
import type { Vec2 } from "../../src/sim/geometry";

const line = (from: Vec2, to: Vec2, n = 10): Vec2[] => Array.from({ length: n }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / (n - 1), y: from.y + ((to.y - from.y) * i) / (n - 1) }));

describe("gesture reading", () => {
  const player = { x: 30, y: 20 };
  const anchor = { x: 42, y: 20 };

  it("ignores taps and single points", () => {
    expect(readGesture([])).toBeNull();
    expect(readGesture([player])).toBeNull();
    expect(readGesture([player, { x: 30.5, y: 20.2 }])).toBeNull();
  });

  it("a straight line toward the anchor is (almost) perfect", () => {
    const g = readGesture(line(player, anchor));
    expect(g).not.toBeNull();
    expect(g!.straightness).toBeCloseTo(1, 5);
    expect(gestureAccuracy(g!, player, anchor)).toBeGreaterThan(0.95);
  });

  it("direction error costs more than length error", () => {
    const short = readGesture(line(player, { x: 36, y: 20 }))!;
    const long = readGesture(line(player, { x: 60, y: 20 }))!;
    const off45 = readGesture(line(player, { x: 38.5, y: 28.5 }))!;
    const off90 = readGesture(line(player, { x: 30, y: 32 }))!;
    const back = readGesture(line(player, { x: 18, y: 20 }))!;
    expect(gestureAccuracy(short, player, anchor)).toBeGreaterThan(0.7);
    expect(gestureAccuracy(long, player, anchor)).toBeGreaterThan(0.6);
    expect(gestureAccuracy(off45, player, anchor)).toBeLessThan(gestureAccuracy(short, player, anchor));
    expect(gestureAccuracy(off90, player, anchor)).toBeLessThan(0.35);
    expect(gestureAccuracy(back, player, anchor)).toBeLessThan(0.15);
  });

  it("a wobbly line loses a little, not a lot (a shaky hand is not a bad read)", () => {
    const pts = line(player, anchor, 20).map((p, i) => ({ x: p.x, y: p.y + (i % 2 ? 1.2 : -1.2) }));
    const g = readGesture(pts)!;
    expect(g.straightness).toBeLessThan(0.95);
    expect(gestureAccuracy(g, player, anchor)).toBeGreaterThan(0.8);
  });

  it("dragging back onto the origin cancels", () => {
    const out = line(player, { x: 38, y: 20 }, 6);
    const back = line({ x: 38, y: 20 }, { x: 30.5, y: 20.3 }, 6);
    expect(isCancelGesture([...out, ...back])).toBe(true);
    expect(isCancelGesture(out)).toBe(false);
    // a tiny jitter that never went anywhere is not a cancel either
    expect(isCancelGesture([player, { x: 30.2, y: 20.1 }, player])).toBe(false);
  });

  it("tap accuracy falls off with distance and direction from the anchor", () => {
    expect(tapAccuracy(anchor, player, anchor)).toBeCloseTo(1, 5);
    expect(tapAccuracy({ x: 44, y: 21 }, player, anchor)).toBeGreaterThan(0.75);
    expect(tapAccuracy({ x: 30, y: 34 }, player, anchor)).toBeLessThan(0.3);
    expect(tapAccuracy(player, player, anchor)).toBeLessThan(0.2);
  });
});
