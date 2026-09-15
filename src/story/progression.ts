import progressionFile from "../../content/rules/progression-u11.json";

/**
 * Progression tracks (spec §19). Tracked separately and only moved by authored effects or
 * evidence reducers; relationships never feed soccer attributes. Unlocks are explicit rules read
 * from `content/rules/progression-u11.json` (OPEN_QUESTIONS #20 — thresholds are a proposal):
 * each names what it grants and what it opens, so development is never implied by dialogue alone.
 */

export type Track = "technical" | "tactical" | "physical" | "wellbeing" | "school" | "responsibility" | "pathway";
export const TRACKS: readonly Track[] = ["technical", "tactical", "physical", "wellbeing", "school", "responsibility", "pathway"];

export interface Progression {
  /** 0–100 each. */
  tracks: Record<Track, number>;
  /** Person id → −100..100. */
  relationships: Record<string, number>;
  /** Self-reported home practice minutes per activity, kept apart from verified gameplay (spec §8). */
  selfReported: Record<string, number>;
  /** Verified activity results: activity id → completed count. */
  verified: Record<string, number>;
  unlocked: string[];
}

export const createProgression = (): Progression => ({
  tracks: { technical: 20, tactical: 20, physical: 20, wellbeing: 70, school: 60, responsibility: 40, pathway: 0 },
  relationships: {},
  selfReported: {},
  verified: {},
  unlocked: [],
});

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function adjustTrack(p: Progression, track: Track, delta: number): void {
  p.tracks[track] = clamp(p.tracks[track] + delta, 0, 100);
}

export function adjustRelationship(p: Progression, personId: string, delta: number): void {
  p.relationships[personId] = clamp((p.relationships[personId] ?? 0) + delta, -100, 100);
}

export const relationship = (p: Progression, personId: string): number => p.relationships[personId] ?? 0;

/** What an unlock hands the player. Never an attribute (spec §19). */
export type Grant = "conversation" | "activity" | "support" | "opportunity";
export const GRANTS: readonly Grant[] = ["conversation", "activity", "support", "opportunity"];

export type Requirement = { track: Track; personId?: undefined; min: number } | { personId: string; track?: undefined; min: number };

export interface UnlockRule {
  id: string;
  title: string;
  grants: Grant;
  /** What the unlock concretely opens in the game, in the player's terms. */
  opens: string;
  requires: Requirement[];
}

interface ProgressionFile {
  tracks: Record<Track, { label: string; movedBy: string[] }>;
  unlocks: UnlockRule[];
}

const rules = progressionFile as unknown as ProgressionFile;

export const TRACK_INFO: Readonly<Record<Track, { label: string; movedBy: string[] }>> = rules.tracks;
export const UNLOCKS: readonly UnlockRule[] = rules.unlocks;

export const requirementValue = (p: Progression, q: Requirement): number => (q.track ? p.tracks[q.track] : relationship(p, q.personId));

export const ruleMet = (p: Progression, r: UnlockRule): boolean => r.requires.every((q) => requirementValue(p, q) >= q.min);

/** Recompute unlocks; returns the newly unlocked ids (never re-locks: an earned unlock stays). */
export function refreshUnlocks(p: Progression, rules: readonly UnlockRule[] = UNLOCKS): string[] {
  const fresh: string[] = [];
  for (const r of rules) {
    if (p.unlocked.includes(r.id)) continue;
    if (ruleMet(p, r)) {
      p.unlocked.push(r.id);
      fresh.push(r.id);
    }
  }
  return fresh;
}

export interface UnlockView {
  rule: UnlockRule;
  unlocked: boolean;
  requirements: { requirement: Requirement; value: number; met: boolean }[];
}

/** Every rule with where the player stands on each requirement — the hub shows this, so unlocks are never implied. */
export function unlockViews(p: Progression, rules: readonly UnlockRule[] = UNLOCKS): UnlockView[] {
  return rules.map((rule) => ({
    rule,
    unlocked: p.unlocked.includes(rule.id),
    requirements: rule.requires.map((requirement) => {
      const value = requirementValue(p, requirement);
      return { requirement, value, met: value >= requirement.min };
    }),
  }));
}
