import hobbiesFile from "../../content/rules/hobbies-u11.json";
import { weekday } from "../calendar/date";
import type { Slot } from "../calendar/schedule";
import { applyEffect, type Effect } from "../story/consequences";
import { storyContext, touch, type CampaignState } from "./campaign";

/**
 * Hobbies (spec §4, §19): a non-soccer thing the player does with free time. The hobby moves
 * wellbeing and sometimes school or fatigue, and its milestones queue authored moments; it never
 * touches soccer attributes or verified evidence. State lives in story facts (which hobby, sessions
 * of it, last day) so the save format is unchanged. Rules are content (hobbies-u11.json, proposal).
 */

export interface HobbyMilestone {
  sessions: number;
  sceneId: string;
}

export interface Hobby {
  id: string;
  label: string;
  detail: string;
  /** Fatigue change per session (negative rests the legs). */
  fatigue: number;
  effects: Effect[];
  /** Effects that land on every n-th session of this hobby. */
  every: { n: number; effects: Effect[] }[];
  milestones: HobbyMilestone[];
}

interface HobbiesFile {
  rules: { sessionsPerDay: number; switchRestartsMilestones: boolean; slots: Slot[]; weekendMorning: boolean };
  hobbies: Hobby[];
}

const file = hobbiesFile as unknown as HobbiesFile;

export const HOBBIES: readonly Hobby[] = file.hobbies;
export const HOBBY_RULES = file.rules;
export const HOBBY_FACTS = { id: "hobby", sessions: "hobby_sessions", total: "hobby_total_sessions", day: "hobby_day" } as const;

export const hobbyById = (id: string): Hobby | undefined => HOBBIES.find((h) => h.id === id);

export function currentHobby(c: CampaignState): Hobby | null {
  const id = c.story.facts[HOBBY_FACTS.id];
  return typeof id === "string" ? (hobbyById(id) ?? null) : null;
}

const numberFact = (c: CampaignState, id: string): number => (typeof c.story.facts[id] === "number" ? (c.story.facts[id] as number) : 0);

export const hobbySessions = (c: CampaignState): number => numberFact(c, HOBBY_FACTS.sessions);

/** Free time for a hobby: afternoons and evenings, weekend mornings too; one session a day. */
export function hobbyAvailable(c: CampaignState): boolean {
  if (c.story.facts[HOBBY_FACTS.day] === c.day) return false;
  const w = weekday(c.day);
  const weekend = w === "Sat" || w === "Sun";
  if (HOBBY_RULES.slots.includes(c.slot)) return true;
  return weekend && HOBBY_RULES.weekendMorning && c.slot === "morning";
}

/** Pick (or change) the hobby. Changing restarts the milestone count; the lifetime total is kept. */
export function chooseHobby(c: CampaignState, id: string): boolean {
  const h = hobbyById(id);
  if (!h) return false;
  if (c.story.facts[HOBBY_FACTS.id] === id) return true;
  c.story.facts[HOBBY_FACTS.id] = id;
  if (HOBBY_RULES.switchRestartsMilestones) c.story.facts[HOBBY_FACTS.sessions] = 0;
  touch(c);
  return true;
}

/** One session of the hobby: its effects, any every-n effect, and a milestone moment when one is reached. Fatigue is the caller's (week.ts). */
export function recordHobby(c: CampaignState, id: string): Effect[] {
  const h = hobbyById(id);
  if (!h) throw new Error(`unknown hobby ${id}`);
  chooseHobby(c, id);
  const n = hobbySessions(c) + 1;
  const effects: Effect[] = [
    { type: "set_fact", id: HOBBY_FACTS.sessions, value: n },
    { type: "set_fact", id: HOBBY_FACTS.total, value: numberFact(c, HOBBY_FACTS.total) + 1 },
    { type: "set_fact", id: HOBBY_FACTS.day, value: c.day },
    { type: "learn", personId: "parent", factId: HOBBY_FACTS.id },
    ...h.effects,
  ];
  for (const e of h.every) if (e.n > 0 && n % e.n === 0) effects.push(...e.effects);
  for (const m of h.milestones) if (m.sessions === n) effects.push({ type: "queue_scene", sceneId: m.sceneId, onDay: c.day });
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return effects;
}

export interface HobbyView {
  hobby: Hobby | null;
  sessions: number;
  total: number;
  /** Next milestone of the current hobby, if any. */
  next: HobbyMilestone | null;
  others: Hobby[];
}

export function hobbyView(c: CampaignState): HobbyView {
  const hobby = currentHobby(c);
  const sessions = hobbySessions(c);
  return {
    hobby,
    sessions,
    total: numberFact(c, HOBBY_FACTS.total),
    next: hobby?.milestones.find((m) => m.sessions > sessions) ?? null,
    others: HOBBIES.filter((h) => h.id !== hobby?.id),
  };
}
