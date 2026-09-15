import { storyContext, touch, type CampaignState } from "../campaign/campaign";
import { applyEffect, type Effect } from "../story/consequences";
import type { ChallengeSummary } from "./crossbar";
import type { DrillSummary } from "./firstTouch";
import type { Summary as SmallSidedSummary } from "./smallSided";

/**
 * Turn an activity result into campaign evidence (spec §8, §12): a verified activity count, small
 * track movement, and facts the coach and friend witnessed so the debrief can only say what they
 * saw. Attribute deltas are proposals (OPEN_QUESTIONS #23).
 */

export const INTRO_FACTS = { reads: "intro_reads", touch: "intro_touch" } as const;
export const PARK_FACTS = { reads: "park_reads", touch: "park_touch", sessions: "park_sessions" } as const;

/** The first-touch drill at the Thursday visit (coach and friend watching) or at the park (friend only). */
export function recordFirstTouch(c: CampaignState, s: DrillSummary, setting: "visit" | "park" = "visit"): Effect[] {
  const p = c.progression;
  p.verified["first_touch"] = (p.verified["first_touch"] ?? 0) + s.reps;
  const tactical = s.reads === "sharp" ? 2 : s.reads === "mixed" ? 1 : 0;
  const technical = s.touch === "clean" ? 1 : 0;
  const facts = setting === "park" ? PARK_FACTS : INTRO_FACTS;
  const witnesses = setting === "park" ? ["friend"] : ["coach", "friend"];
  const effects: Effect[] = [
    { type: "set_fact", id: facts.reads, value: s.reads },
    { type: "set_fact", id: facts.touch, value: s.touch },
    ...witnesses.flatMap((who): Effect[] => [
      { type: "learn", personId: who, factId: facts.reads },
      { type: "learn", personId: who, factId: facts.touch },
    ]),
  ];
  if (setting === "park") {
    p.verified["park_first_touch"] = (p.verified["park_first_touch"] ?? 0) + s.reps;
    const n = typeof c.story.facts[PARK_FACTS.sessions] === "number" ? (c.story.facts[PARK_FACTS.sessions] as number) : 0;
    effects.push({ type: "set_fact", id: PARK_FACTS.sessions, value: n + 1 });
  } else {
    effects.push({ type: "set_fact", id: "first_touch_through", value: s.outcomes.through });
  }
  if (tactical) effects.push({ type: "track", track: "tactical", delta: tactical });
  if (technical) effects.push({ type: "track", track: "technical", delta: technical });
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return effects;
}

export const TRAIN_FACTS = {
  activity: "last_training_activity",
  reads: "last_training_reads",
  touch: "last_training_touch",
  lesson: "last_training_lesson",
  attended: "trainings_attended",
  strongReads: "training_strong_reads",
} as const;

/**
 * A team-training activity (1v1 / 2v2 / 3v2). Verified evidence: reps per activity, strong reads,
 * clean executions. Story: the coach saw the reads and the lesson; the friend, who trains too,
 * saw the reads. A tired body (`windowScale < 1`) is not punished twice — the shorter window
 * already did that.
 */
export function recordTraining(c: CampaignState, s: SmallSidedSummary): Effect[] {
  const p = c.progression;
  p.verified[`train_${s.activityId}`] = (p.verified[`train_${s.activityId}`] ?? 0) + s.reps;
  p.verified["train_reads_strong"] = (p.verified["train_reads_strong"] ?? 0) + s.decisions.strong;
  p.verified["train_exec_clean"] = (p.verified["train_exec_clean"] ?? 0) + s.executions.clean;
  const tactical = s.reads === "sharp" ? 2 : s.reads === "mixed" ? 1 : 0;
  const technical = s.touch === "clean" ? 1 : 0;
  const attended = typeof c.story.facts[TRAIN_FACTS.attended] === "number" ? (c.story.facts[TRAIN_FACTS.attended] as number) : 0;
  const effects: Effect[] = [
    { type: "set_fact", id: TRAIN_FACTS.activity, value: s.activityId },
    { type: "set_fact", id: TRAIN_FACTS.reads, value: s.reads },
    { type: "set_fact", id: TRAIN_FACTS.touch, value: s.touch },
    { type: "set_fact", id: TRAIN_FACTS.attended, value: attended + 1 },
    { type: "learn", personId: "coach", factId: TRAIN_FACTS.reads },
    { type: "learn", personId: "coach", factId: TRAIN_FACTS.touch },
    { type: "learn", personId: "friend", factId: TRAIN_FACTS.reads },
    { type: "track", track: "physical", delta: 1 },
  ];
  if (s.lesson) {
    effects.push({ type: "set_fact", id: TRAIN_FACTS.lesson, value: s.lesson }, { type: "learn", personId: "coach", factId: TRAIN_FACTS.lesson });
  } else {
    effects.push({ type: "clear_fact", id: TRAIN_FACTS.lesson });
  }
  if (tactical) effects.push({ type: "track", track: "tactical", delta: tactical });
  if (technical) effects.push({ type: "track", track: "technical", delta: technical });
  if (c.story.facts["practised_at_home"] === true) effects.push({ type: "learn", personId: "coach", factId: "practised_at_home" });
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return effects;
}

export const CROSSBAR_FACTS = { winner: "crossbar_winner", played: "crossbar_played" } as const;

/**
 * The crossbar challenge is time with a friend, not training (spec §7): friendship and wellbeing
 * move, soccer tracks and verified evidence do not.
 */
export function recordCrossbar(c: CampaignState, s: ChallengeSummary): Effect[] {
  const played = typeof c.story.facts[CROSSBAR_FACTS.played] === "number" ? (c.story.facts[CROSSBAR_FACTS.played] as number) : 0;
  const effects: Effect[] = [
    { type: "set_fact", id: CROSSBAR_FACTS.winner, value: s.winner },
    { type: "set_fact", id: CROSSBAR_FACTS.played, value: played + 1 },
    { type: "learn", personId: "friend", factId: CROSSBAR_FACTS.winner },
    { type: "relationship", personId: "friend", delta: 1 },
    { type: "track", track: "wellbeing", delta: 1 },
  ];
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return effects;
}
