import { describe, expect, it } from "vitest";
import {
  ACCESSIBLE_WINDOW_FACTOR,
  classify,
  createJuggle,
  currentRun,
  RUN_CAP,
  RUNS_PER_SESSION,
  runHeadless,
  startRun,
  step,
  summarize,
  touch,
  touchesInRun,
  windows,
} from "../../src/training/juggling";

describe("juggling: deterministic tap-timing minigame", () => {
  it("is deterministic for a seed and touch sequence, and a session is three runs with the best run counting", () => {
    const policy = (i: number): number => (i % 7 === 6 ? 250 : 40);
    const a = summarize(runHeadless(createJuggle(11), policy));
    const b = summarize(runHeadless(createJuggle(11), policy));
    expect(a).toEqual(b);
    expect(a.runs).toHaveLength(RUNS_PER_SESSION);
    expect(a.best).toBe(Math.max(...a.runs));
    expect(a.total).toBe(a.runs.reduce((x, y) => x + y, 0));
    const s11 = createJuggle(11);
    const s12 = createJuggle(12);
    startRun(s11);
    startRun(s12);
    expect(s11.flightMs).not.toBe(s12.flightMs);
  });

  it("classifies timing error into perfect / good / loose / drop, and loose touches narrow the window through drift", () => {
    const s = createJuggle(3);
    startRun(s);
    const w0 = windows(s);
    expect(classify(s, 0)).toBe("perfect");
    expect(classify(s, w0.perfect + 1)).toBe("good");
    expect(classify(s, -(w0.good + 1))).toBe("loose");
    expect(classify(s, w0.loose + 1)).toBe("drop");
    s.elapsedMs = s.flightMs + w0.good + 1;
    expect(touch(s)!.quality).toBe("loose");
    expect(s.drift).toBeGreaterThan(0);
    const w1 = windows(s);
    expect(w1.good).toBeLessThan(w0.good);
    s.elapsedMs = s.flightMs;
    expect(touch(s)!.quality).toBe("perfect");
    expect(windows(s).good).toBeGreaterThan(w1.good);
  });

  it("a flight nobody touches is a drop; a run that reaches the cap ends itself and is flagged", () => {
    const s = createJuggle(5);
    startRun(s);
    for (let i = 0; i < 200 && s.phase === "air"; i++) step(s, 50);
    expect(currentRun(s)!.ended).toBe("drop");
    expect(touchesInRun(currentRun(s))).toBe(0);
    const capped = runHeadless(createJuggle(5, { runs: 1 }), () => 0);
    expect(touchesInRun(currentRun(capped))).toBe(RUN_CAP);
    expect(currentRun(capped)!.ended).toBe("cap");
    expect(summarize(capped).capped).toBe(true);
    expect(capped.phase).toBe("done");
  });

  it("the accessible setting widens every window by the same factor", () => {
    const normal = createJuggle(9);
    const wide = createJuggle(9, { windowScale: ACCESSIBLE_WINDOW_FACTOR });
    startRun(normal);
    startRun(wide);
    expect(windows(wide).good).toBeCloseTo(windows(normal).good * ACCESSIBLE_WINDOW_FACTOR);
    const err = windows(normal).loose + 10;
    expect(classify(normal, err)).toBe("drop");
    expect(classify(wide, err)).toBe("loose");
  });

  it("a hesitant beginner gets a few touches; a steady player goes long — the number is earned, not granted", () => {
    const beginner = summarize(runHeadless(createJuggle(21), (i) => (i % 3 === 2 ? 400 : 150)));
    const steady = summarize(runHeadless(createJuggle(21), (i) => (i % 12 === 11 ? 230 : 60)));
    expect(beginner.best).toBeLessThan(6);
    expect(steady.best).toBeGreaterThan(beginner.best);
    expect(steady.best).toBeGreaterThanOrEqual(10);
  });
});
