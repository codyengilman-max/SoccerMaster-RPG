import { describe, expect, it } from "vitest";
import {
  applyChoice,
  applyRepair,
  availableRepairs,
  choiceEligible,
  createStoryState,
  knows,
  processDue,
  type Choice,
  type StoryContext,
} from "../../src/story/consequences";
import { createProgression, refreshUnlocks, relationship } from "../../src/story/progression";
import { fill, markSeen, sceneEligible, toneReport, visibleLines, type Scene } from "../../src/story/scenes";

const ctxAt = (day: number, base?: StoryContext): StoryContext => ({
  story: base?.story ?? createStoryState(),
  progression: base?.progression ?? createProgression(),
  day,
});

/** "Skip Thursday training to game with your friend": friend +, coach follow-up in 2 days unless you apologise first. */
const SKIP: Choice = {
  id: "week1.skip_training",
  label: "Skip training, hang out",
  eligibility: [{ type: "not_applied", choiceId: "week1.attend_training" }],
  immediate: [
    { type: "relationship", personId: "friend", delta: 5 },
    { type: "set_fact", id: "skipped_training_w1", value: true },
    { type: "learn", personId: "friend", factId: "skipped_training_w1" },
  ],
  delayed: [
    {
      id: "coach_notices",
      afterDays: 2,
      effects: [
        { type: "relationship", personId: "coach", delta: -10 },
        { type: "queue_scene", sceneId: "coach_talk", onDay: null },
      ],
      unless: [{ type: "fact", id: "apologised_w1", equals: true }],
    },
  ],
  repair: [
    {
      id: "apologise",
      label: "Tell Coach before he finds out",
      when: [],
      effects: [{ type: "set_fact", id: "apologised_w1", value: true }, { type: "relationship", personId: "coach", delta: 2 }],
      cancels: ["coach_notices"],
      withinDays: 1,
    },
  ],
  expiresDay: 10,
};

describe("consequence reducer", () => {
  it("applies immediate effects once and rejects the same choice twice", () => {
    const ctx = ctxAt(3);
    const r = applyChoice(ctx, SKIP);
    expect(r.ok).toBe(true);
    expect(relationship(ctx.progression, "friend")).toBe(5);
    expect(ctx.story.facts.skipped_training_w1).toBe(true);
    expect(knows(ctx.story, "friend", "skipped_training_w1")).toBe(true);
    expect(knows(ctx.story, "coach", "skipped_training_w1")).toBe(false);
    expect(applyChoice(ctx, SKIP)).toEqual({ ok: false, reason: "duplicate" });
    expect(relationship(ctx.progression, "friend")).toBe(5);
    expect(ctx.story.pending).toHaveLength(1);
  });

  it("enforces eligibility and expiry", () => {
    const ctx = ctxAt(3);
    ctx.story.applied.push("week1.attend_training");
    expect(choiceEligible(ctx, SKIP)).toBe(false);
    expect(applyChoice(ctx, SKIP)).toEqual({ ok: false, reason: "ineligible" });
    expect(applyChoice(ctxAt(11), SKIP)).toEqual({ ok: false, reason: "expired" });
  });

  it("fires delayed consequences once when due and never again", () => {
    const ctx = ctxAt(3);
    applyChoice(ctx, SKIP);
    expect(processDue({ ...ctx, day: 4 })).toEqual([]);
    const fired = processDue({ ...ctx, day: 5 });
    expect(fired.map((f) => f.key)).toEqual(["week1.skip_training:coach_notices"]);
    expect(relationship(ctx.progression, "coach")).toBe(-10);
    expect(ctx.story.queuedScenes).toEqual([{ sceneId: "coach_talk", onDay: null }]);
    expect(processDue({ ...ctx, day: 9 })).toEqual([]);
    expect(relationship(ctx.progression, "coach")).toBe(-10);
    // Re-queueing the same pending key (e.g. a replayed save action) is ignored too.
    ctx.story.pending.push({ key: "week1.skip_training:coach_notices", choiceId: SKIP.id, delayedId: "coach_notices", dueDay: 5, effects: SKIP.delayed[0]!.effects, unless: [] });
    expect(processDue({ ...ctx, day: 9 })).toEqual([]);
    expect(relationship(ctx.progression, "coach")).toBe(-10);
  });

  it("a repair inside its window cancels the delayed consequence", () => {
    const ctx = ctxAt(3);
    applyChoice(ctx, SKIP);
    expect(availableRepairs({ ...ctx, day: 4 }, SKIP).map((r) => r.id)).toEqual(["apologise"]);
    expect(availableRepairs({ ...ctx, day: 5 }, SKIP)).toEqual([]);
    const r = applyRepair({ ...ctx, day: 4 }, SKIP, "apologise");
    expect(r).toEqual({ ok: true, cancelled: ["week1.skip_training:coach_notices"] });
    expect(processDue({ ...ctx, day: 5 })).toEqual([]);
    expect(relationship(ctx.progression, "coach")).toBe(2);
    expect(ctx.story.dropped[0]!.why).toMatch(/repaired/);
    expect(applyRepair({ ...ctx, day: 4 }, SKIP, "apologise")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("the `unless` guard drops a consequence whose premise no longer holds", () => {
    const ctx = ctxAt(3);
    applyChoice(ctx, SKIP);
    ctx.story.facts.apologised_w1 = true;
    expect(processDue({ ...ctx, day: 5 })).toEqual([]);
    expect(ctx.story.dropped).toHaveLength(1);
    expect(relationship(ctx.progression, "coach")).toBe(0);
  });

  it("relationships gate unlocks but never move soccer tracks", () => {
    const ctx = ctxAt(3);
    const before = { ...ctx.progression.tracks };
    applyChoice(ctx, { ...SKIP, id: "x", immediate: [{ type: "relationship", personId: "friend", delta: 25 }], delayed: [], repair: [] });
    expect(ctx.progression.tracks).toEqual(before);
    expect(ctx.progression.unlocked).toContain("friend_park_sessions");
    expect(refreshUnlocks(ctx.progression)).toEqual([]);
  });
});

describe("scenes", () => {
  const scene: Scene = {
    id: "lunch",
    title: "Lunch",
    location: "lunch_spot",
    tone: "everyday",
    eligibility: [{ type: "fact", id: "joined", equals: true }],
    lines: [
      { speaker: null, text: "{friend} slides onto the bench." },
      { speaker: "friend", text: "So you skipped.", requiresKnown: ["skipped_training_w1"] },
      { speaker: "friend", text: "Coach was asking about you.", when: [{ type: "relationship", personId: "coach", max: -5 }] },
    ],
    choices: [],
    next: null,
    once: true,
    reviewStatus: "proposal",
  };

  it("lines respect speaker knowledge and world conditions; once-only scenes are seen once", () => {
    const ctx = ctxAt(6);
    expect(sceneEligible(ctx, scene)).toBe(false);
    ctx.story.facts.joined = true;
    expect(sceneEligible(ctx, scene)).toBe(true);
    expect(visibleLines(ctx, scene.lines).map((l) => l.text)).toEqual(["{friend} slides onto the bench."]);
    ctx.story.knowledge.friend = ["skipped_training_w1"];
    ctx.progression.relationships.coach = -10;
    expect(visibleLines(ctx, scene.lines)).toHaveLength(3);
    expect(markSeen(ctx.story, scene.id, 6)).toBe(true);
    expect(markSeen(ctx.story, scene.id, 6)).toBe(false);
    expect(sceneEligible(ctx, scene)).toBe(false);
    expect(fill("{friend} and {player}", { friend: "Mateo", player: "Sam" })).toBe("Mateo and Sam");
    expect(fill("{nobody}", {})).toBe("{nobody}");
  });

  it("tone report counts shares against the 30/15/55 target", () => {
    const r = toneReport([scene, { ...scene, id: "b", tone: "reward" }]);
    expect(r.total).toBe(2);
    expect(r.share.reward).toBe(0.5);
    expect(r.target).toEqual({ reward: 0.3, adversity: 0.15, everyday: 0.55 });
  });
});
