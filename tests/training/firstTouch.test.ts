import { describe, expect, it } from "vitest";
import {
  GATES,
  RECEIVE_POINT,
  bestGate,
  commitGate,
  createDrill,
  current,
  gradeGate,
  openness,
  readDraw,
  readTap,
  runHeadless,
  step,
  summarize,
  windowProgress,
  type DrillState,
} from "../../src/training/firstTouch";

const bestPolicy = (_d: DrillState, rec: { bestGate: "left" | "forward" | "right" }) => ({ gate: rec.bestGate, accuracy: 0.9 });
const worstPolicy = (d: DrillState, rec: { defenderFrom: { x: number; y: number } }) => {
  const o = openness(rec.defenderFrom);
  const worst = GATES.map((g) => g.id).sort((a, b) => o[a] - o[b])[0]!;
  return { gate: worst, accuracy: 0.2 };
};

describe("first-touch drill", () => {
  it("is deterministic for a seed", () => {
    const a = runHeadless(createDrill(7), bestPolicy);
    const b = runHeadless(createDrill(7), bestPolicy);
    expect(a.records).toEqual(b.records);
    expect(a.timeMs).toBe(b.timeMs);
    expect(summarize(a)).toEqual(summarize(b));
  });

  it("varies the defender's approach across reps and seeds", () => {
    const a = runHeadless(createDrill(1), bestPolicy);
    const froms = new Set(a.records.map((r) => `${r.defenderFrom.x.toFixed(1)},${r.defenderFrom.y.toFixed(1)}`));
    expect(froms.size).toBeGreaterThan(1);
    const b = runHeadless(createDrill(2), bestPolicy);
    expect(b.records.map((r) => r.defenderFrom)).not.toEqual(a.records.map((r) => r.defenderFrom));
  });

  it("grades the gate away from pressure as strong and the gate into it as weak", () => {
    const fromRight = { x: RECEIVE_POINT.x, y: RECEIVE_POINT.y + 8 };
    expect(bestGate(fromRight)).toBe("left");
    expect(gradeGate(fromRight, "left")).toBe("strong");
    expect(gradeGate(fromRight, "forward")).toBe("acceptable");
    expect(gradeGate(fromRight, "right")).toBe("weak");
    const fromBehind = { x: RECEIVE_POINT.x - 8, y: RECEIVE_POINT.y };
    expect(gradeGate(fromBehind, "forward")).toBe("strong");
  });

  it("keeps decision, execution and outcome separate", () => {
    const good = summarize(runHeadless(createDrill(3), bestPolicy));
    const bad = summarize(runHeadless(createDrill(3), worstPolicy));
    expect(good.reps).toBe(6);
    expect(good.decisions.strong).toBe(6);
    expect(good.executions.clean).toBe(6);
    expect(good.reads).toBe("sharp");
    expect(good.touch).toBe("clean");
    expect(bad.decisions.weak).toBe(6);
    expect(bad.executions.loose).toBe(6);
    expect(bad.reads).toBe("rushed");
    expect(bad.touch).toBe("loose");
    // a strong read with a clean touch should usually get through; a weak read into pressure should not
    expect(good.outcomes.through).toBeGreaterThan(bad.outcomes.through);
  });

  it("times out an unanswered window into a loose default touch", () => {
    const d = createDrill(5, 1);
    let opened = false;
    for (let i = 0; i < 2000 && d.phase !== "done"; i++) {
      const evs = step(d, 100);
      if (evs.some((e) => e.type === "window_open")) opened = true;
    }
    expect(opened).toBe(true);
    const rec = d.records[0]!;
    expect(rec.decision).toBe("timeout");
    expect(rec.execution).toBe("loose");
    expect(rec.outcome).not.toBeNull();
    expect(summarize(d).reads).toBe("rushed");
  });

  it("only accepts a commit while the window is open and runs slow motion inside it", () => {
    const d = createDrill(9, 1);
    expect(commitGate(d, "forward", 1)).toBeNull();
    while (d.phase !== "window") step(d, 50);
    const t0 = d.timeMs;
    step(d, 500);
    expect(d.timeMs - t0).toBeLessThan(200);
    expect(windowProgress(d)).toBeGreaterThan(0.1);
    const rec = commitGate(d, current(d)!.bestGate, 0.8);
    expect(rec?.decision).toBe("strong");
    expect(d.phase).toBe("resolve");
    expect(commitGate(d, "left", 1)).toBeNull();
  });

  it("extends the window in accessible mode", () => {
    const a = createDrill(4, 1, false);
    const b = createDrill(4, 1, true);
    while (a.phase !== "window") step(a, 50);
    while (b.phase !== "window") step(b, 50);
    step(a, 3000);
    step(b, 3000);
    expect(a.phase).not.toBe("window");
    expect(b.phase).toBe("window");
  });

  it("reads a drawn line toward a gate and a tap on a gate", () => {
    const toLeft = GATES[0]!.center;
    const points = [RECEIVE_POINT, { x: (RECEIVE_POINT.x + toLeft.x) / 2, y: (RECEIVE_POINT.y + toLeft.y) / 2 }, toLeft];
    const draw = readDraw(points);
    expect(draw.gate).toBe("left");
    expect(draw.accuracy).toBeGreaterThan(0.7);
    expect(readDraw([RECEIVE_POINT, { x: RECEIVE_POINT.x - 4, y: RECEIVE_POINT.y }]).gate).toBeNull();
    expect(readDraw([RECEIVE_POINT]).gate).toBeNull();
    const tap = readTap({ x: GATES[2]!.center.x + 0.5, y: GATES[2]!.center.y });
    expect(tap.gate).toBe("right");
    expect(tap.accuracy).toBeGreaterThan(0.5);
    expect(readTap({ x: 1, y: 1 }).gate).toBeNull();
  });
});
