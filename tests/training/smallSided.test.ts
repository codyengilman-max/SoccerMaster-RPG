import { describe, expect, it } from "vitest";
import {
  ACCESSIBLE_WINDOW_FACTOR,
  ACTIVITIES,
  bestOf,
  commit,
  createDrill,
  options,
  readTap,
  runHeadless,
  step,
  summarize,
  windowLimitMs,
  WINDOW_MS,
  type DrillState,
  type Option,
} from "../../src/training/smallSided";

const best = (_d: DrillState, o: readonly Option[]) => ({ optionId: bestOf(o).id, accuracy: 0.9 });
const worst = (_d: DrillState, o: readonly Option[]) => ({ optionId: [...o].sort((a, b) => a.score - b.score)[0]!.id, accuracy: 0.9 });
const bestLoose = (_d: DrillState, o: readonly Option[]) => ({ optionId: bestOf(o).id, accuracy: 0.2 });

const toWindow = (d: DrillState): void => {
  let guard = 0;
  while (d.phase !== "window" && d.phase !== "done" && guard++ < 10_000) step(d, 50);
  expect(d.phase).toBe("window");
};

describe("small-sided activities (1v1 / 2v2 / 3v2)", () => {
  it.each(ACTIVITIES)("%s replays identically from the same seed and differs across seeds", (act) => {
    const a = summarize(runHeadless(createDrill(act, 21, { reps: 5 }), best));
    const b = summarize(runHeadless(createDrill(act, 21, { reps: 5 }), best));
    expect(a).toEqual(b);
    expect(a.reps).toBe(5);
    const recA = runHeadless(createDrill(act, 21, { reps: 5 }), best).records.map((r) => r.options.map((o) => o.score));
    const recB = runHeadless(createDrill(act, 22, { reps: 5 }), best).records.map((r) => r.options.map((o) => o.score));
    expect(recA).not.toEqual(recB);
  });

  it.each(ACTIVITIES)("%s offers options that name a tactical concept and always includes a best option", (act) => {
    const d = createDrill(act, 3, { reps: 3 });
    toWindow(d);
    const o = options(d);
    expect(o.length).toBeGreaterThanOrEqual(2);
    expect(o.every((x) => x.concept && x.label)).toBe(true);
    expect(o.map((x) => x.id)).toContain(bestOf(o).id);
    if (act === "1v1") expect(o.every((x) => x.kind !== "pass")).toBe(true);
    else expect(o.some((x) => x.kind === "pass")).toBe(true);
  });

  it("grades the decision separately from the execution: a strong read with a loose touch is still a strong read", () => {
    const good = summarize(runHeadless(createDrill("2v2", 8, { reps: 6 }), best));
    const loose = summarize(runHeadless(createDrill("2v2", 8, { reps: 6 }), bestLoose));
    expect(good.decisions).toEqual(loose.decisions);
    expect(good.touch).toBe("clean");
    expect(loose.touch).toBe("loose");
    expect(loose.outcomes.success).toBeLessThanOrEqual(good.outcomes.success);
  });

  it("weak reads are graded weak and carry the concept that was missed", () => {
    const d = runHeadless(createDrill("3v2", 5, { reps: 6 }), worst);
    const s = summarize(d);
    expect(s.decisions.weak + s.decisions.acceptable).toBe(6);
    expect(s.decisions.strong).toBe(0);
    expect(d.records.filter((r) => r.decision === "weak").every((r) => r.missedConcept !== null)).toBe(true);
    expect(s.lesson).not.toBeNull();
  });

  it("times out deterministically when nothing is committed and the rep resolves with a timeout record", () => {
    const d = createDrill("1v1", 9, { reps: 1 });
    toWindow(d);
    const limit = windowLimitMs(d);
    expect(limit).toBe(WINDOW_MS);
    let guard = 0;
    while (d.phase === "window" && guard++ < 10_000) step(d, 50);
    expect(d.records[0]!.decision).toBe("timeout");
    while (d.phase !== "done" && guard++ < 20_000) step(d, 50);
    expect(summarize(d).decisions.timeout).toBe(1);
    expect(summarize(d).reads).toBe("rushed");
  });

  it("accessible mode widens the window; tiredness narrows it", () => {
    const base = createDrill("2v2", 1, { reps: 1 });
    const acc = createDrill("2v2", 1, { reps: 1, accessible: true });
    const tired = createDrill("2v2", 1, { reps: 1, windowScale: 0.7 });
    for (const d of [base, acc, tired]) toWindow(d);
    expect(windowLimitMs(acc)).toBeCloseTo(WINDOW_MS * ACCESSIBLE_WINDOW_FACTOR);
    expect(windowLimitMs(tired)).toBeCloseTo(WINDOW_MS * 0.7);
    expect(windowLimitMs(base)).toBe(WINDOW_MS);
  });

  it("tapping near an option's anchor selects it, and committing records the chosen option", () => {
    const d = createDrill("3v2", 14, { reps: 2, accessible: true });
    toWindow(d);
    const o = options(d).find((x) => x.anchor)!;
    const read = readTap(d, o.anchor!);
    expect(read.option?.id).toBe(o.id);
    const rec = commit(d, o.id, read.accuracy);
    expect(rec?.chosenId).toBe(o.id);
    expect(rec?.decision).not.toBe("timeout");
    expect(d.phase).toBe("resolve");
  });

  it("the summary is plain serialisable evidence", () => {
    const s = summarize(runHeadless(createDrill("1v1", 2, { reps: 4 }), best));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(s.activityId).toBe("1v1");
  });
});
