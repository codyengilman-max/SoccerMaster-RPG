import { storyContext, touch, type CampaignState } from "../campaign/campaign";
import { applyEffect, type Effect } from "../story/consequences";
import type { DrillSummary } from "./firstTouch";

/**
 * Turn an activity result into campaign evidence (spec §8, §12): a verified activity count, small
 * track movement, and facts the coach and friend witnessed so the debrief can only say what they
 * saw. Attribute deltas are proposals (OPEN_QUESTIONS #23).
 */

export const INTRO_FACTS = { reads: "intro_reads", touch: "intro_touch" } as const;

export function recordFirstTouch(c: CampaignState, s: DrillSummary): Effect[] {
  const p = c.progression;
  p.verified["first_touch"] = (p.verified["first_touch"] ?? 0) + s.reps;
  const tactical = s.reads === "sharp" ? 2 : s.reads === "mixed" ? 1 : 0;
  const technical = s.touch === "clean" ? 1 : 0;
  const effects: Effect[] = [
    { type: "set_fact", id: INTRO_FACTS.reads, value: s.reads },
    { type: "set_fact", id: INTRO_FACTS.touch, value: s.touch },
    { type: "learn", personId: "coach", factId: INTRO_FACTS.reads },
    { type: "learn", personId: "coach", factId: INTRO_FACTS.touch },
    { type: "learn", personId: "friend", factId: INTRO_FACTS.reads },
    { type: "learn", personId: "friend", factId: INTRO_FACTS.touch },
    { type: "set_fact", id: "first_touch_through", value: s.outcomes.through },
  ];
  if (tactical) effects.push({ type: "track", track: "tactical", delta: tactical });
  if (technical) effects.push({ type: "track", track: "technical", delta: technical });
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return effects;
}
