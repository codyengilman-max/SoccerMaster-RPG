import type { CampaignDay } from "../calendar/date";

/**
 * Relationship memory (Story Engine v2 §5). A relationship is not one meter: it has dimensions
 * that move independently and a list of remembered events with the observer's *belief* about
 * what happened, where they learned it and how sure they are. The player never sees a number;
 * the hub and dialogue infer behaviour from these (`describeRelation`).
 */

export const RELATION_DIMENSIONS = ["trust", "respect", "loyalty", "jealousy", "dependence", "competitive_tension"] as const;
export type RelationDimension = (typeof RELATION_DIMENSIONS)[number];

export type Relation = Record<RelationDimension, number>;

export type KnowledgeSource = "witnessed" | "told" | "rumour" | "inferred";
export type EmotionalTag = "warm" | "proud" | "grateful" | "impressed" | "neutral" | "embarrassed" | "hurt" | "resentful" | "annoyed";
export type Visibility = "public" | "private" | "secret";
export type DecayRule = "permanent" | "fades" | "until_repaired";

export interface RememberedEvent {
  eventId: string;
  observerId: string;
  knowledgeSource: KnowledgeSource;
  /** What the observer believes happened, in their words. */
  belief: string;
  /** 0..1 */
  confidence: number;
  emotionalTag: EmotionalTag;
  visibility: Visibility;
  decayRule: DecayRule;
  day: CampaignDay;
  /** Set when a repair or later event resolved it (`until_repaired`). */
  resolvedDay?: CampaignDay;
}

export interface MemoryState {
  relations: Record<string, Relation>;
  memories: RememberedEvent[];
}

export const createMemoryState = (): MemoryState => ({ relations: {}, memories: [] });

export const RELATION_MIN = -20;
export const RELATION_MAX = 20;

export const emptyRelation = (): Relation => ({ trust: 0, respect: 0, loyalty: 0, jealousy: 0, dependence: 0, competitive_tension: 0 });

export function relationOf(m: MemoryState, personId: string): Relation {
  return m.relations[personId] ?? emptyRelation();
}

export function adjustRelation(m: MemoryState, personId: string, dimension: RelationDimension, delta: number): number {
  const r = (m.relations[personId] ??= emptyRelation());
  r[dimension] = Math.max(RELATION_MIN, Math.min(RELATION_MAX, r[dimension] + delta));
  return r[dimension];
}

/** Record what someone remembers. The same observer never stores the same event twice. */
export function remember(m: MemoryState, ev: RememberedEvent): boolean {
  if (m.memories.some((x) => x.eventId === ev.eventId && x.observerId === ev.observerId)) return false;
  m.memories.push({ ...ev, confidence: Math.max(0, Math.min(1, ev.confidence)) });
  return true;
}

export function memoriesOf(m: MemoryState, observerId: string): RememberedEvent[] {
  return m.memories.filter((x) => x.observerId === observerId);
}

export const FADE_DAYS = 28;

/** A memory still shapes behaviour when it is permanent, unresolved, or recent enough not to have faded. */
export function memoryActive(ev: RememberedEvent, day: CampaignDay): boolean {
  if (ev.resolvedDay !== undefined) return false;
  if (ev.decayRule === "fades") return day - ev.day < FADE_DAYS;
  return true;
}

export function resolveMemory(m: MemoryState, observerId: string, eventIdPrefix: string, day: CampaignDay): number {
  let n = 0;
  for (const ev of m.memories) {
    if (ev.observerId === observerId && ev.eventId.startsWith(eventIdPrefix) && ev.resolvedDay === undefined && ev.decayRule === "until_repaired") {
      ev.resolvedDay = day;
      n++;
    }
  }
  return n;
}

/** Does the observer hold an active memory matching the prefix (and tag, if given)? */
export function remembers(m: MemoryState, observerId: string, eventIdPrefix: string, day: CampaignDay, tag?: EmotionalTag): boolean {
  return m.memories.some((ev) => ev.observerId === observerId && ev.eventId.startsWith(eventIdPrefix) && memoryActive(ev, day) && (tag === undefined || ev.emotionalTag === tag));
}

export interface RelationView {
  /** How this person behaves around the player right now — behaviour, not a score. */
  behaviour: string;
  /** The one active memory that most shapes it, if any. */
  remembered: RememberedEvent | null;
}

/**
 * Behaviour inferred from the dimensions and the strongest active memory (§5: relationships are
 * shown through availability, dialogue and what people bring up, never as a meter).
 */
export function describeRelation(m: MemoryState, personId: string, day: CampaignDay): RelationView {
  const r = relationOf(m, personId);
  const active = memoriesOf(m, personId).filter((ev) => memoryActive(ev, day));
  const weight = (ev: RememberedEvent): number => ev.confidence * (ev.emotionalTag === "neutral" ? 0.5 : 1) * (ev.decayRule === "until_repaired" ? 1.5 : 1);
  const remembered = active.sort((a, b) => weight(b) - weight(a) || b.day - a.day)[0] ?? null;
  let behaviour: string;
  if (r.trust <= -4) behaviour = "keeps things short with you";
  else if (r.competitive_tension >= 5 && r.respect >= 2) behaviour = "wants to beat you, and says so to your face";
  else if (r.competitive_tension >= 5) behaviour = "needles you whenever soccer comes up";
  else if (r.jealousy >= 4) behaviour = "goes quiet when your soccer comes up";
  else if (r.trust >= 4 && r.loyalty >= 2) behaviour = "waits for you after school";
  else if (r.trust >= 3) behaviour = "saves you a seat";
  else if (r.respect >= 3) behaviour = "listens when you talk";
  else if (r.dependence >= 4) behaviour = "checks what you're doing before deciding";
  else behaviour = "is easy enough with you";
  return { behaviour, remembered };
}
