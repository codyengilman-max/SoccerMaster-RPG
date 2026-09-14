import { storyContext, touch, type CampaignState } from "../campaign/campaign";
import { applyEffect, type Effect } from "../story/consequences";

/**
 * Home skill assignments (spec §8): watch an approved real demonstration → practise away from the
 * screen → report observations → revisit the learning. No video links are fabricated: each
 * assignment carries a demonstration *slot* the owner fills (OPEN_QUESTIONS #16), and the screen
 * says so. Practice minutes are self-reported and stored in `progression.selfReported`, never in
 * `verified`; nothing here changes soccer attributes. The coach can only know what the player
 * tells them (`learn` effects), so a dishonest report is a story fact, not a stat.
 */

export type Skill = "juggling" | "first_touch" | "wall_passing" | "dribbling";
export type Stage = "watch" | "practise" | "report" | "revisit" | "done";
export const STAGES: readonly Stage[] = ["watch", "practise", "report", "revisit", "done"];

export interface Observation {
  id: string;
  text: string;
  /** What the observation shows the player noticed; used by the revisit step. */
  insight: string;
}

export interface Assignment {
  id: string;
  skill: Skill;
  title: string;
  /** Approved demonstration slot. `url: null` = not yet supplied by the owner; the UI never invents one. */
  demonstration: { title: string; url: string | null; approved: boolean };
  watchFor: string[];
  practise: string[];
  observations: Observation[];
  revisit: string;
}

export const ASSIGNMENTS: readonly Assignment[] = [
  {
    id: "juggle-100",
    skill: "juggling",
    title: "Soft feet: juggling",
    demonstration: { title: "Approved demonstration — juggling with both feet (owner to supply)", url: null, approved: false },
    watchFor: ["Where the ball is struck (laces, toe pointed slightly up)", "How little the knee lifts", "Eyes on the ball, not the feet"],
    practise: ["Two touches then catch, ten times", "Alternate feet, count your best run", "Finish with a run you can repeat, not a lucky one"],
    observations: [
      { id: "laces", text: "It went straighter when I hit it with my laces, not my toe.", insight: "contact surface" },
      { id: "knee", text: "When my knee came up high the ball flew away from me.", insight: "small movements" },
      { id: "weak_foot", text: "My weak foot is a lot worse. I mostly used my strong one.", insight: "honest about the weak foot" },
    ],
    revisit: "The coach's version: the ball goes where the contact sends it. Small contact, small correction. Next session, weak foot only for the first minute.",
  },
  {
    id: "wall-pass",
    skill: "wall_passing",
    title: "Wall passing: inside of the foot",
    demonstration: { title: "Approved demonstration — inside-of-foot passing off a wall (owner to supply)", url: null, approved: false },
    watchFor: ["The standing foot points where the pass goes", "Ankle locked, toe up", "The first touch after the rebound sets up the next pass"],
    practise: ["Twenty passes right foot, twenty left, one touch to set", "Then one-touch passing against the wall for a minute", "Note how many came straight back"],
    observations: [
      { id: "standing_foot", text: "When my standing foot pointed at the wall, the ball came straight back.", insight: "body shape" },
      { id: "ankle", text: "If my ankle was soft the pass wobbled.", insight: "locked ankle" },
      { id: "first_touch", text: "My first touch after the rebound decided whether the next pass was good.", insight: "touch sets the pass" },
    ],
    revisit: "Coach Code's rule: the pass starts with the touch before it. Next time, set the ball a step ahead so you are moving into the pass.",
  },
  {
    id: "cone-dribble",
    skill: "dribbling",
    title: "Close control: cones or shoes",
    demonstration: { title: "Approved demonstration — close-control dribbling through gates (owner to supply)", url: null, approved: false },
    watchFor: ["The ball stays within a step", "Both feet used", "Head up at the end of each line"],
    practise: ["Five gates, two metres apart, slow and clean first", "Speed up only when you can look up at the last gate", "Try it with the outside of the foot"],
    observations: [
      { id: "slow_first", text: "Going slow first, I could actually do it with both feet.", insight: "control before speed" },
      { id: "look_up", text: "I couldn't look up without losing the ball at the last gate.", insight: "honest about the head-up cue" },
      { id: "outside", text: "Outside of the foot felt strange but kept the ball closer.", insight: "surface choice" },
    ],
    revisit: "Every touch in a match is under someone's pressure. Slow and clean at home is what makes quick and clean on Saturday.",
  },
];

export const assignmentById = (id: string): Assignment | undefined => ASSIGNMENTS.find((a) => a.id === id);

export const STAGE_FACT = (id: string): string => `home:${id}:stage`;
export const OBSERVATION_FACT = (id: string): string => `home:${id}:observation`;
/** Number of completed report steps across all assignments (self-reported, not verified). */
export const HOME_REPORTS_FACT = "home_reports";
export const HOME_MINUTES_FACT = "home_minutes";

export function stageOf(c: CampaignState, id: string): Stage {
  const s = c.story.facts[STAGE_FACT(id)];
  return typeof s === "string" && (STAGES as readonly string[]).includes(s) ? (s as Stage) : "watch";
}

export function selfReportedMinutes(c: CampaignState, skill: Skill): number {
  return c.progression.selfReported[skill] ?? 0;
}

function apply(c: CampaignState, effects: Effect[]): Effect[] {
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return effects;
}

/** Step 1 — the player has watched (or, with no approved link, read) the demonstration. */
export function watchDemonstration(c: CampaignState, id: string): Effect[] {
  if (stageOf(c, id) !== "watch" || !assignmentById(id)) return [];
  return apply(c, [{ type: "set_fact", id: STAGE_FACT(id), value: "practise" }]);
}

/** Step 2 — practised away from the screen; minutes are the player's own claim. */
export function practised(c: CampaignState, id: string, minutes: number): Effect[] {
  const a = assignmentById(id);
  if (!a || stageOf(c, id) !== "practise") return [];
  const m = Math.max(0, Math.round(minutes));
  c.progression.selfReported[a.skill] = (c.progression.selfReported[a.skill] ?? 0) + m;
  const total = typeof c.story.facts[HOME_MINUTES_FACT] === "number" ? (c.story.facts[HOME_MINUTES_FACT] as number) : 0;
  return apply(c, [
    { type: "set_fact", id: STAGE_FACT(id), value: "report" },
    { type: "set_fact", id: HOME_MINUTES_FACT, value: total + m },
  ]);
}

/** Step 3 — what the player noticed; also what they will be able to tell the coach. */
export function report(c: CampaignState, id: string, observationId: string): Effect[] {
  const a = assignmentById(id);
  if (!a || stageOf(c, id) !== "report") return [];
  const obs = a.observations.find((o) => o.id === observationId);
  if (!obs) return [];
  const n = typeof c.story.facts[HOME_REPORTS_FACT] === "number" ? (c.story.facts[HOME_REPORTS_FACT] as number) : 0;
  return apply(c, [
    { type: "set_fact", id: OBSERVATION_FACT(id), value: obs.id },
    { type: "set_fact", id: STAGE_FACT(id), value: "revisit" },
    { type: "set_fact", id: HOME_REPORTS_FACT, value: n + 1 },
    { type: "set_fact", id: "practised_at_home", value: true },
    { type: "track", track: "responsibility", delta: 1 },
  ]);
}

/** Step 4 — revisit the learning point; the assignment is complete. */
export function revisit(c: CampaignState, id: string): { text: string; effects: Effect[] } | null {
  const a = assignmentById(id);
  if (!a || stageOf(c, id) !== "revisit") return null;
  const effects = apply(c, [{ type: "set_fact", id: STAGE_FACT(id), value: "done" }]);
  return { text: a.revisit, effects };
}

/** The assignment a player would naturally pick up next: the first that is not done. */
export function nextAssignment(c: CampaignState): Assignment | null {
  return ASSIGNMENTS.find((a) => stageOf(c, a.id) !== "done") ?? null;
}
