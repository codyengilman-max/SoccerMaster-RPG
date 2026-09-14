import type { CampaignDay } from "../calendar/date";
import { adjustRelationship, adjustTrack, refreshUnlocks, type Progression, type Track } from "./progression";

/**
 * Authored consequences (spec §20, plan §3.4). Every consequential choice is data with
 * eligibility, immediate effects, delayed triggers, repair options and an expiry. Effects go
 * through one reducer keyed by an idempotency id so nothing applies twice (acceptance 12).
 * Dialogue text never carries effects.
 */

export type FactValue = string | number | boolean;

export type Condition =
  | { type: "fact"; id: string; equals?: FactValue; not?: FactValue; exists?: boolean }
  | { type: "relationship"; personId: string; min?: number; max?: number }
  | { type: "track"; track: Track; min?: number; max?: number }
  | { type: "day"; min?: CampaignDay; max?: CampaignDay }
  | { type: "not_applied"; choiceId: string }
  | { type: "applied"; choiceId: string }
  | { type: "unlocked"; id: string };

export type Effect =
  | { type: "set_fact"; id: string; value: FactValue }
  | { type: "clear_fact"; id: string }
  | { type: "relationship"; personId: string; delta: number }
  | { type: "track"; track: Track; delta: number }
  | { type: "learn"; personId: string; factId: string }
  | { type: "promise"; id: string; by: string; text: string }
  | { type: "deliver"; promiseId: string }
  | { type: "queue_scene"; sceneId: string; onDay: CampaignDay | null }
  | { type: "flag"; id: string };

export interface DelayedEffect {
  id: string;
  afterDays: number;
  effects: Effect[];
  /** The consequence is dropped if this holds when it comes due (a repair, or the world moved on). */
  unless?: Condition[];
}

export interface RepairOption {
  id: string;
  label: string;
  /** Eligibility for the repair itself. */
  when: Condition[];
  effects: Effect[];
  /** Delayed effects of the original choice this repair cancels. */
  cancels: string[];
  /** Days after the choice during which repair is still possible. */
  withinDays: number;
}

export interface Choice {
  id: string;
  label: string;
  eligibility: Condition[];
  immediate: Effect[];
  delayed: DelayedEffect[];
  repair: RepairOption[];
  /** Day after which the choice can no longer be taken (null = never expires). */
  expiresDay: CampaignDay | null;
}

export interface PendingConsequence {
  /** `${choiceId}:${delayedId}` — the idempotency key. */
  key: string;
  choiceId: string;
  delayedId: string;
  dueDay: CampaignDay;
  effects: Effect[];
  unless: Condition[];
}

export interface StoryPromise {
  id: string;
  by: string;
  text: string;
  madeDay: CampaignDay;
  delivered: boolean;
}

export interface StoryState {
  facts: Record<string, FactValue>;
  /** Applied idempotency keys (choices and consequences). */
  applied: string[];
  appliedDays: Record<string, CampaignDay>;
  pending: PendingConsequence[];
  dropped: { key: string; day: CampaignDay; why: string }[];
  /** Person id → fact ids that character knows (spec §5 "limits on what they know"). */
  knowledge: Record<string, string[]>;
  promises: StoryPromise[];
  queuedScenes: { sceneId: string; onDay: CampaignDay | null }[];
  flags: string[];
}

export const createStoryState = (): StoryState => ({
  facts: {},
  applied: [],
  appliedDays: {},
  pending: [],
  dropped: [],
  knowledge: {},
  promises: [],
  queuedScenes: [],
  flags: [],
});

export interface StoryContext {
  story: StoryState;
  progression: Progression;
  day: CampaignDay;
}

export function holds(ctx: StoryContext, c: Condition): boolean {
  const { story, progression, day } = ctx;
  switch (c.type) {
    case "fact": {
      const v = story.facts[c.id];
      if (c.exists !== undefined) return (v !== undefined) === c.exists;
      if (c.equals !== undefined) return v === c.equals;
      if (c.not !== undefined) return v !== c.not;
      return v !== undefined;
    }
    case "relationship": {
      const v = progression.relationships[c.personId] ?? 0;
      return (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
    }
    case "track": {
      const v = progression.tracks[c.track];
      return (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
    }
    case "day":
      return (c.min === undefined || day >= c.min) && (c.max === undefined || day <= c.max);
    case "not_applied":
      return !story.applied.includes(c.choiceId);
    case "applied":
      return story.applied.includes(c.choiceId);
    case "unlocked":
      return progression.unlocked.includes(c.id);
  }
}

export const allHold = (ctx: StoryContext, cs: readonly Condition[]): boolean => cs.every((c) => holds(ctx, c));

export function applyEffect(ctx: StoryContext, e: Effect): void {
  const { story, progression, day } = ctx;
  switch (e.type) {
    case "set_fact":
      story.facts[e.id] = e.value;
      return;
    case "clear_fact":
      delete story.facts[e.id];
      return;
    case "relationship":
      adjustRelationship(progression, e.personId, e.delta);
      return;
    case "track":
      adjustTrack(progression, e.track, e.delta);
      return;
    case "learn": {
      const k = (story.knowledge[e.personId] ??= []);
      if (!k.includes(e.factId)) k.push(e.factId);
      return;
    }
    case "promise":
      if (!story.promises.some((p) => p.id === e.id)) story.promises.push({ id: e.id, by: e.by, text: e.text, madeDay: day, delivered: false });
      return;
    case "deliver": {
      const p = story.promises.find((x) => x.id === e.promiseId);
      if (p) p.delivered = true;
      return;
    }
    case "queue_scene":
      if (!story.queuedScenes.some((q) => q.sceneId === e.sceneId)) story.queuedScenes.push({ sceneId: e.sceneId, onDay: e.onDay });
      return;
    case "flag":
      if (!story.flags.includes(e.id)) story.flags.push(e.id);
      return;
  }
}

export type ChoiceResult =
  | { ok: true; applied: Effect[]; scheduled: PendingConsequence[] }
  | { ok: false; reason: "duplicate" | "ineligible" | "expired" };

export function choiceEligible(ctx: StoryContext, choice: Choice): boolean {
  if (ctx.story.applied.includes(choice.id)) return false;
  if (choice.expiresDay !== null && ctx.day > choice.expiresDay) return false;
  return allHold(ctx, choice.eligibility);
}

/** Take a choice: immediate effects now, delayed ones queued. A second call with the same id is rejected. */
export function applyChoice(ctx: StoryContext, choice: Choice): ChoiceResult {
  if (ctx.story.applied.includes(choice.id)) return { ok: false, reason: "duplicate" };
  if (choice.expiresDay !== null && ctx.day > choice.expiresDay) return { ok: false, reason: "expired" };
  if (!allHold(ctx, choice.eligibility)) return { ok: false, reason: "ineligible" };
  ctx.story.applied.push(choice.id);
  ctx.story.appliedDays[choice.id] = ctx.day;
  for (const e of choice.immediate) applyEffect(ctx, e);
  const scheduled: PendingConsequence[] = choice.delayed.map((d) => ({
    key: `${choice.id}:${d.id}`,
    choiceId: choice.id,
    delayedId: d.id,
    dueDay: ctx.day + d.afterDays,
    effects: d.effects,
    unless: d.unless ?? [],
  }));
  for (const s of scheduled) if (!ctx.story.pending.some((p) => p.key === s.key)) ctx.story.pending.push(s);
  refreshUnlocks(ctx.progression);
  return { ok: true, applied: choice.immediate, scheduled };
}

export interface Fired {
  key: string;
  effects: Effect[];
}

/** Apply every consequence due on or before `ctx.day`, once each; dropped ones are recorded with the reason. */
export function processDue(ctx: StoryContext): Fired[] {
  const fired: Fired[] = [];
  const due = ctx.story.pending.filter((p) => p.dueDay <= ctx.day).sort((a, b) => a.dueDay - b.dueDay || a.key.localeCompare(b.key));
  for (const p of due) {
    ctx.story.pending.splice(ctx.story.pending.indexOf(p), 1);
    if (ctx.story.applied.includes(p.key)) continue;
    if (p.unless.length && allHold({ ...ctx, day: p.dueDay }, p.unless)) {
      ctx.story.dropped.push({ key: p.key, day: ctx.day, why: "condition no longer applies" });
      continue;
    }
    ctx.story.applied.push(p.key);
    ctx.story.appliedDays[p.key] = ctx.day;
    for (const e of p.effects) applyEffect(ctx, e);
    fired.push({ key: p.key, effects: p.effects });
  }
  if (fired.length) refreshUnlocks(ctx.progression);
  return fired;
}

/** Repairs still open for a taken choice. */
export function availableRepairs(ctx: StoryContext, choice: Choice): RepairOption[] {
  const madeDay = ctx.story.appliedDays[choice.id];
  if (madeDay === undefined) return [];
  return choice.repair.filter(
    (r) =>
      !ctx.story.applied.includes(`${choice.id}:repair:${r.id}`) &&
      ctx.day <= madeDay + r.withinDays &&
      allHold(ctx, r.when) &&
      r.cancels.some((id) => ctx.story.pending.some((p) => p.key === `${choice.id}:${id}`)),
  );
}

export type RepairResult = { ok: true; cancelled: string[] } | { ok: false; reason: "unavailable" };

export function applyRepair(ctx: StoryContext, choice: Choice, repairId: string): RepairResult {
  const r = availableRepairs(ctx, choice).find((x) => x.id === repairId);
  if (!r) return { ok: false, reason: "unavailable" };
  const key = `${choice.id}:repair:${r.id}`;
  ctx.story.applied.push(key);
  ctx.story.appliedDays[key] = ctx.day;
  const cancelled: string[] = [];
  for (const id of r.cancels) {
    const k = `${choice.id}:${id}`;
    const i = ctx.story.pending.findIndex((p) => p.key === k);
    if (i >= 0) {
      ctx.story.pending.splice(i, 1);
      ctx.story.dropped.push({ key: k, day: ctx.day, why: `repaired by ${r.id}` });
      cancelled.push(k);
    }
  }
  for (const e of r.effects) applyEffect(ctx, e);
  refreshUnlocks(ctx.progression);
  return { ok: true, cancelled };
}

export const knows = (story: StoryState, personId: string, factId: string): boolean => (story.knowledge[personId] ?? []).includes(factId);
export const fact = (story: StoryState, id: string): FactValue | undefined => story.facts[id];
