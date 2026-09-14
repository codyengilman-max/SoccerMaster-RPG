/**
 * Progression tracks (spec §19). Tracked separately and only moved by authored effects or
 * evidence reducers; relationships never feed soccer attributes. Unlocks are explicit rules
 * (OPEN_QUESTIONS #20 — the table is a proposal).
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

export interface UnlockRule {
  id: string;
  title: string;
  requires: { track?: Track; personId?: string; min: number }[];
}

/** Proposal — see OPEN_QUESTIONS #20. Relationships gate conversations and activities, never attributes. */
export const UNLOCKS: readonly UnlockRule[] = [
  { id: "friend_park_sessions", title: "Extra park sessions with your friend", requires: [{ personId: "friend", min: 20 }] },
  { id: "coach_extra_feedback", title: "Coach Code offers detailed film feedback", requires: [{ personId: "coach", min: 25 }, { track: "responsibility", min: 45 }] },
  { id: "captain_conversation", title: "Captaincy conversation", requires: [{ track: "tactical", min: 45 }, { track: "responsibility", min: 60 }] },
  { id: "tryout_invitations", title: "Other clubs notice you", requires: [{ track: "pathway", min: 30 }] },
];

/** Recompute unlocks; returns the newly unlocked ids (never re-locks: an earned unlock stays). */
export function refreshUnlocks(p: Progression, rules: readonly UnlockRule[] = UNLOCKS): string[] {
  const fresh: string[] = [];
  for (const r of rules) {
    if (p.unlocked.includes(r.id)) continue;
    const ok = r.requires.every((q) => (q.track ? p.tracks[q.track] >= q.min : q.personId ? relationship(p, q.personId) >= q.min : false));
    if (ok) {
      p.unlocked.push(r.id);
      fresh.push(r.id);
    }
  }
  return fresh;
}
