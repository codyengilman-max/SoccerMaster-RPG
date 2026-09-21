import { describe, expect, it } from "vitest";
import { continuationOf, validateResult } from "../../src/minigame/contract";
import { exit, input, pause, replay, restore, resume, tick } from "../../src/minigame/machine";
import { gameLogic } from "../../src/minigame/registry";
import { computeGrades, GP_ASSIST_SCALE, GP_TIMING, gpWindowScale, gradeOf, groupPresentation, TOPICS, topicById, type GpInput, type GpState } from "../../src/minigame/groupPresentation";
import { cfg, GP_PERFECT, GP_PLAYERS, idle, newGp, playGp, STEP } from "./helpers";

const withFrozenPartner = (seedFrom = 1): ReturnType<typeof newGp> => {
  for (let seed = seedFrom; seed < seedFrom + 60; seed++) {
    const probe = newGp({ seed });
    playGp(probe, GP_PERFECT);
    if (probe.game.delivery.steps.some((x) => x.kind === "partner" && x.freezes)) return newGp({ seed });
  }
  throw new Error("no seed with a frozen partner");
};

describe("Group Presentation", () => {
  it("is registered, needs three group members and an age-tagged topic", () => {
    expect(gameLogic("group_presentation")).toBe(groupPresentation);
    expect(() => groupPresentation.create(cfg("group_presentation", { participantIds: ["player", "friend"] }))).toThrow(/two partners/);
    // An unknown variant falls back to a topic for the configured age band rather than breaking the scene.
    const fallback = groupPresentation.create(cfg("group_presentation", { ruleVariant: "not_a_topic", ageBand: "U11-U12" }));
    expect(topicById(fallback.topicId)!.ageBand).toBe("U11-U12");
    const topic = topicById("fractions_pizza")!;
    expect(topic.ageBand).toBe("U11-U12");
    for (const t of TOPICS) {
      expect(t.sections.length).toBeGreaterThanOrEqual(3);
      expect(t.cards.length).toBeGreaterThanOrEqual(3);
      expect(t.cues.length).toBeGreaterThanOrEqual(2);
      for (const c of t.cues) expect(c.options.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("deals a scrambled card order deterministically and never a solved one", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const a = groupPresentation.create(cfg("group_presentation", { seed }));
      const b = groupPresentation.create(cfg("group_presentation", { seed }));
      expect(a).toEqual(b);
      expect(a.cards).not.toEqual(a.correctOrder);
      expect([...a.cards].sort()).toEqual([...a.correctOrder].sort());
      expect(a.members.map((m) => m.id)).toEqual(GP_PLAYERS);
    }
  });

  it("a fair split, the right order, on-time hand-offs and correct cues earn the strong result", () => {
    const s = newGp();
    playGp(s, GP_PERFECT);
    expect(s.phase).toBe("resolved");
    const r = s.result!;
    expect(validateResult(r)).toBe(true);
    expect(r.exitReason).toBe("completed");
    expect(r.outcomeTier).toBe("success");
    expect(r.summary.finished).toBe(true);
    expect(["A", "B"]).toContain(r.summary.accuracy);
    expect(["A", "B"]).toContain(r.summary.clarity);
    expect(["A", "B"]).toContain(r.summary.teamwork);
    expect(r.summary.correctCues).toBe(r.summary.totalCues);
    expect(r.summary.mine).toBeLessThanOrEqual(1);
    expect(r.witnessedBehavior.map((w) => w.tag)).toContain("strong_group_result");
    expect(r.witnessedBehavior.map((w) => w.tag)).not.toContain("dominated_presentation");
    // The teacher sees the group result as well as the partners.
    const strong = r.witnessedBehavior.find((w) => w.tag === "strong_group_result")!;
    expect(strong.witnessIds).toEqual(expect.arrayContaining(["friend", "rival", "teacher"]));
    // Every phase of the activity is on the record.
    const kinds = new Set(r.verifiedActions.map((a) => a.kind));
    for (const k of ["assign", "order", "handoff", "cue", "feedback"]) expect(kinds.has(k)).toBe(true);
    expect(r.verifiedActions.filter((a) => a.kind === "handoff")).toHaveLength(GP_TIMING.transitions);
    expect(r.verifiedActions.filter((a) => a.kind === "handoff").every((a) => a.quality === "strong")).toBe(true);
    expect(s.elapsedMs).toBeLessThan(3 * 60_000);
  });

  it("grades accuracy, clarity and teamwork separately", () => {
    // Wrong answers hurt accuracy but not teamwork; a hogged split hurts teamwork but not accuracy.
    const wrong = newGp();
    playGp(wrong, { ...GP_PERFECT, answers: "wrong" });
    const hog = newGp();
    playGp(hog, { ...GP_PERFECT, assign: "hog" });
    const perfect = newGp();
    playGp(perfect, GP_PERFECT);
    const v = (g: unknown): number => ({ A: 3, B: 2, C: 1, D: 0 })[g as "A" | "B" | "C" | "D"];
    expect(v(wrong.result!.summary.accuracy)).toBeLessThan(v(perfect.result!.summary.accuracy));
    expect(v(wrong.result!.summary.teamwork)).toBe(v(perfect.result!.summary.teamwork));
    expect(v(hog.result!.summary.teamwork)).toBeLessThan(v(perfect.result!.summary.teamwork));
    expect(v(hog.result!.summary.accuracy)).toBeGreaterThanOrEqual(v(perfect.result!.summary.accuracy) - 1);
    expect(hog.result!.summary.mine).toBe(topicById("fractions_pizza")!.sections.length);
    expect(hog.result!.witnessedBehavior.map((w) => w.tag)).toContain("dominated_presentation");
    expect(hog.result!.relationshipEffects.filter((e) => e.dimension === "respect" && e.delta === -1).map((e) => e.personId).sort()).toEqual(["friend", "rival"]);
    // Early hand-offs are recorded weak and pull clarity down.
    const early = newGp();
    playGp(early, { ...GP_PERFECT, handoff: "early" });
    expect(early.result!.verifiedActions.filter((a) => a.kind === "handoff").every((a) => a.quality === "weak" && a.detail?.early === true)).toBe(true);
    expect(v(early.result!.summary.clarity)).toBeLessThan(v(perfect.result!.summary.clarity));
    // Grade bands are fixed.
    expect([gradeOf(0.85), gradeOf(0.65), gradeOf(0.45), gradeOf(0.44)]).toEqual(["A", "B", "C", "D"]);
  });

  it("wrong cards and wrong cues together are the failure route — and the story still continues", () => {
    const s = newGp();
    playGp(s, { assign: "fit", order: "leave", answers: "wrong", handoff: "none", freeze: "wait" });
    expect(s.phase).toBe("resolved");
    const r = s.result!;
    expect(r.exitReason).toBe("completed");
    expect(r.outcomeTier).toBe("failure");
    expect(r.summary.finished).toBe(true);
    expect(r.summary.accuracy).toBe("D");
    expect(continuationOf(r)).toBe("failure");
  });

  it("ignoring every prompt lets the clock answer for you: late hand-offs, timed-out cues, partial or failed", () => {
    const s = newGp();
    // Do the set-up (it cannot time out) then leave the live parts alone.
    playGp(s, GP_PERFECT, 1);
    while (s.phase === "active" && s.game.phase === "assign") playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    while (s.phase === "active" && s.game.phase === "order") playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    idle(s, groupPresentation);
    expect(s.phase).toBe("resolved");
    const r = s.result!;
    expect(r.exitReason).toBe("completed");
    expect(["partial", "failure"]).toContain(r.outcomeTier);
    expect(r.verifiedActions.filter((a) => a.kind === "handoff").every((a) => a.quality === "weak" && a.detail?.late === true)).toBe(true);
    expect(r.verifiedActions.filter((a) => a.kind === "cue").every((a) => a.quality === "weak" && a.detail?.timeout === true)).toBe(true);
    expect(r.summary.correctCues).toBe(0);
  });

  it("times out if the set-up never finishes, resolving as failure on the bell", () => {
    const s = newGp();
    idle(s, groupPresentation);
    expect(s.phase).toBe("resolved");
    expect(s.result!.exitReason).toBe("timeout");
    expect(s.result!.outcomeTier).toBe("failure");
    expect(s.result!.summary.finished).toBe(false);
    expect(s.elapsedMs).toBe(GP_TIMING.timeLimitMs);
    expect(continuationOf(s.result!)).toBe("timeout");
  });

  it("a frozen partner can be prompted, taken over from, or left — each with a different memory", () => {
    const base = withFrozenPartner();
    const seed = base.config.seed;
    const run = (freeze: "prompt" | "takeover" | "wait"): NonNullable<ReturnType<typeof newGp>["result"]> => {
      const s = newGp({ seed });
      playGp(s, { ...GP_PERFECT, freeze });
      expect(s.phase).toBe("resolved");
      return s.result!;
    };
    const prompted = run("prompt");
    expect(prompted.witnessedBehavior.map((w) => w.tag)).toContain("rescued_partner");
    expect(prompted.relationshipEffects.some((e) => e.dimension === "trust" && e.delta === 2)).toBe(true);
    expect(prompted.summary.rescued).toBe(true);

    const took = run("takeover");
    expect(took.witnessedBehavior.map((w) => w.tag)).toContain("took_over_from_partner");
    expect(took.relationshipEffects.some((e) => e.dimension === "dependence" && e.delta === 1)).toBe(true);
    expect(took.relationshipEffects.some((e) => e.dimension === "respect" && e.delta === -1)).toBe(true);
    expect(took.summary.tookOver).toBe(true);

    const waited = run("wait");
    const tags = waited.witnessedBehavior.map((w) => w.tag);
    const frozen = waited.verifiedActions.filter((a) => a.kind === "intervene");
    expect(frozen.every((a) => a.detail?.how === "wait")).toBe(true);
    if (frozen.some((a) => a.detail?.recovered === false)) {
      expect(tags).toContain("let_partner_flounder");
      expect(waited.relationshipEffects.some((e) => e.dimension === "trust" && e.delta === -1)).toBe(true);
    } else {
      expect(tags).not.toContain("let_partner_flounder");
    }
    expect(tags).not.toContain("rescued_partner");
    // Teamwork: prompting ≥ waiting ≥ taking over is never inverted.
    const v = (g: unknown): number => ({ A: 3, B: 2, C: 1, D: 0 })[g as "A" | "B" | "C" | "D"];
    expect(v(prompted.summary.teamwork)).toBeGreaterThanOrEqual(v(took.summary.teamwork));
    expect(v(prompted.summary.teamwork)).toBeGreaterThanOrEqual(v(waited.summary.teamwork));
  });

  it("walking out mid-delivery costs both partners' trust and takes the voluntary_exit route", () => {
    const s = newGp();
    while (s.phase === "active" && s.game.phase !== "delivery") playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    expect(s.game.phase).toBe("delivery");
    expect(exit(s, groupPresentation, 9000).ok).toBe(true);
    expect(s.phase).toBe("abandoned");
    const r = s.result!;
    expect(r.exitReason).toBe("voluntary_exit");
    expect(r.outcomeTier).toBe("failure");
    expect(r.summary.finished).toBe(false);
    expect(r.witnessedBehavior.map((w) => w.tag)).toEqual(["left_group_project"]);
    expect(r.witnessedBehavior[0]!.witnessIds).toEqual(["friend", "rival", "teacher"]);
    expect(r.relationshipEffects).toEqual([
      { personId: "friend", dimension: "trust", delta: -2, reason: "left the group mid-project" },
      { personId: "rival", dimension: "trust", delta: -2, reason: "left the group mid-project" },
    ]);
    expect(continuationOf(r)).toBe("voluntary_exit");
  });

  it("saves at phase boundaries, restores paused, and finishes like the uninterrupted run", () => {
    const straight = newGp({ seed: 4 });
    playGp(straight, GP_PERFECT);

    const s = newGp({ seed: 4 });
    while (s.phase === "active" && s.game.phase !== "rehearsal") playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    expect(s.game.phase).toBe("rehearsal");
    expect(groupPresentation.checkpoint(s.game)).toBe("rehearsal:0");
    // Mid-window there is no checkpoint: a reload would cheat the timing.
    const probe = newGp({ seed: 4 });
    while (probe.phase === "active" && !(probe.game.phase === "rehearsal" && probe.game.rehearsal.windowOpen)) {
      if (probe.game.phase !== "rehearsal") playGp(probe, GP_PERFECT, probe.elapsedMs + STEP);
      else tick(probe, groupPresentation, STEP, probe.elapsedMs + STEP);
    }
    expect(groupPresentation.checkpoint(probe.game)).toBeNull();

    expect(pause(s).ok).toBe(true);
    const back = restore<GpState, GpInput>(JSON.parse(JSON.stringify(s)));
    expect(back).not.toBeNull();
    expect(back!.phase).toBe("paused");
    expect(resume(back!).ok).toBe(true);
    playGp(back!, GP_PERFECT);
    expect(back!.phase).toBe("resolved");
    expect(back!.result!.summary).toEqual(straight.result!.summary);
  });

  it("replays from the input log to the identical grades", () => {
    const live = newGp({ seed: 9 });
    playGp(live, { ...GP_PERFECT, answers: "wrong" });
    const again = replay(groupPresentation, live.config, live.inputs, STEP);
    expect(again.phase).toBe("resolved");
    expect(again.result!.summary).toEqual(live.result!.summary);
    expect(again.result!.verifiedActions).toEqual(live.result!.verifiedActions);
    expect(again.game.grades).toEqual(live.game.grades);
  });

  it("ignores inputs in the wrong phase and out-of-range indices", () => {
    const s = newGp();
    const g = s.game;
    input(s, groupPresentation, { type: "swap", a: 0, b: 1 }, 0);
    input(s, groupPresentation, { type: "handoff" }, 0);
    input(s, groupPresentation, { type: "answer", option: 0 }, 0);
    input(s, groupPresentation, { type: "intervene", how: "prompt" }, 0);
    expect(g.swaps).toBe(0);
    expect(g.actions).toHaveLength(0);
    // Cannot confirm the split with a section unassigned.
    input(s, groupPresentation, { type: "confirm" }, 0);
    expect(g.phase).toBe("assign");
    input(s, groupPresentation, { type: "assign", sectionId: "nope", personId: "player" }, 0);
    input(s, groupPresentation, { type: "assign", sectionId: topicById(g.topicId)!.sections[0]!.id, personId: "stranger" }, 0);
    expect(Object.values(g.assignments).every((v) => v === null)).toBe(true);
    for (const sec of topicById(g.topicId)!.sections) input(s, groupPresentation, { type: "assign", sectionId: sec.id, personId: "player" }, 0);
    input(s, groupPresentation, { type: "confirm" }, 0);
    expect(g.phase).toBe("order");
    input(s, groupPresentation, { type: "swap", a: 0, b: 99 }, 0);
    input(s, groupPresentation, { type: "swap", a: 1, b: 1 }, 0);
    expect(g.swaps).toBe(0);
  });

  it("stretches every live clock with the accessibility timer scale", () => {
    const a = newGp({ accessibility: { reducedMotion: false, highContrast: false, timerScale: 1, assist: false } });
    const b = newGp({ accessibility: { reducedMotion: false, highContrast: false, timerScale: 2, assist: false } });
    expect(groupPresentation.timeLimitMs(b.config)).toBe(2 * groupPresentation.timeLimitMs(a.config));
    for (const s of [a, b]) while (s.phase === "active" && s.game.phase !== "rehearsal") playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    expect(Math.abs(b.game.rehearsal.windowInMs - a.game.rehearsal.windowInMs * 2)).toBeLessThanOrEqual(2 * STEP);
    expect(computeGrades(a.game, a.config)).toEqual(computeGrades(b.game, b.config));
  });

  it("assist widens the answer, hand-off and rescue windows but not the bell", () => {
    const a = newGp({ accessibility: { reducedMotion: false, highContrast: false, timerScale: 1, assist: false } });
    const b = newGp({ accessibility: { reducedMotion: false, highContrast: false, timerScale: 1, assist: true } });
    expect(gpWindowScale(b.config)).toBe(GP_ASSIST_SCALE);
    expect(groupPresentation.timeLimitMs(b.config)).toBe(groupPresentation.timeLimitMs(a.config));
    for (const s of [a, b]) while (s.phase === "active" && s.game.phase !== "rehearsal") playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    expect(Math.abs(b.game.rehearsal.windowInMs - a.game.rehearsal.windowInMs * GP_ASSIST_SCALE)).toBeLessThanOrEqual(2 * STEP);
    for (const s of [a, b]) {
      while (s.phase === "active" && !(s.game.phase === "delivery" && !s.game.delivery.intro && s.game.delivery.limitMs > 0)) playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    }
    expect(b.game.delivery.limitMs).toBe(a.game.delivery.limitMs * GP_ASSIST_SCALE);
    for (const s of [a, b]) while (s.phase === "active") playGp(s, GP_PERFECT, s.elapsedMs + STEP);
    expect(computeGrades(a.game, a.config)).toEqual(computeGrades(b.game, b.config));
  });
});
