import { isWeekend, weekday, type CampaignDay } from "./date";

/**
 * Calendar slots (spec §7; OPEN_QUESTIONS #15): four on weekdays, three on weekends. One
 * commitment per slot; a second one is a conflict that must be resolved explicitly.
 */

export type Slot = "morning" | "school" | "afternoon" | "evening";
export const WEEKDAY_SLOTS: readonly Slot[] = ["morning", "school", "afternoon", "evening"];
const WEEKEND_SLOTS: readonly Slot[] = ["morning", "afternoon", "evening"];

export const slotsFor = (day: CampaignDay): readonly Slot[] => (isWeekend(day) ? WEEKEND_SLOTS : WEEKDAY_SLOTS);

/** Phones are away during school (spec §7). */
export const phoneAvailable = (day: CampaignDay, slot: Slot): boolean => slot !== "school" || isWeekend(day);

export type CommitmentKind =
  | "school"
  | "training"
  | "match"
  | "tournament"
  | "home_skill"
  | "friend"
  | "family"
  | "rest"
  | "story"
  | "visit"
  | "tryout";

export type CommitmentStatus = "scheduled" | "attended" | "missed" | "postponed" | "cancelled";

export interface Commitment {
  id: string;
  day: CampaignDay;
  slot: Slot;
  kind: CommitmentKind;
  title: string;
  /** Skipping a mandatory commitment is recorded and followed up (attendance). */
  mandatory: boolean;
  /** Fixture id, scene id, activity id — whatever the kind refers to. */
  refId: string | null;
  /** Minutes; informational for the hub (durations are a proposal, OPEN_QUESTIONS #15). */
  minutes: number;
  status: CommitmentStatus;
}

export interface Conflict {
  day: CampaignDay;
  slot: Slot;
  existing: Commitment;
  incoming: Commitment;
}

export interface Schedule {
  commitments: Commitment[];
  /** Conflicts waiting for an explicit decision (spec §17: "calendar conflicts require explicit resolution"). */
  conflicts: Conflict[];
}

export const createSchedule = (): Schedule => ({ commitments: [], conflicts: [] });

export const commitmentsOn = (s: Schedule, day: CampaignDay): Commitment[] =>
  s.commitments.filter((c) => c.day === day).sort((a, b) => slotsFor(day).indexOf(a.slot) - slotsFor(day).indexOf(b.slot));

export const commitmentAt = (s: Schedule, day: CampaignDay, slot: Slot): Commitment | undefined =>
  s.commitments.find((c) => c.day === day && c.slot === slot && c.status === "scheduled");

export type AddResult = { ok: true; commitment: Commitment } | { ok: false; conflict: Conflict };

/**
 * Add a commitment. If the slot is taken the incoming one is parked as a conflict (nothing is
 * silently dropped or double-booked). Ids must be unique; re-adding an id is a no-op.
 */
export function addCommitment(s: Schedule, c: Commitment): AddResult {
  if (!slotsFor(c.day).includes(c.slot)) throw new Error(`no ${c.slot} slot on ${weekday(c.day)}`);
  const dup = s.commitments.find((x) => x.id === c.id);
  if (dup) return { ok: true, commitment: dup };
  const existing = commitmentAt(s, c.day, c.slot);
  if (existing) {
    const conflict: Conflict = { day: c.day, slot: c.slot, existing, incoming: c };
    s.conflicts.push(conflict);
    return { ok: false, conflict };
  }
  s.commitments.push(c);
  return { ok: true, commitment: c };
}

/** Resolve a parked conflict: keep one, the other is postponed (story) or cancelled (everything else). */
export function resolveConflict(s: Schedule, conflict: Conflict, keep: "existing" | "incoming"): void {
  const idx = s.conflicts.indexOf(conflict);
  if (idx < 0) throw new Error("conflict not pending");
  s.conflicts.splice(idx, 1);
  const loser = keep === "existing" ? conflict.incoming : conflict.existing;
  const winner = keep === "existing" ? conflict.existing : conflict.incoming;
  if (keep === "incoming") {
    const i = s.commitments.indexOf(conflict.existing);
    if (i >= 0) s.commitments.splice(i, 1);
    s.commitments.push(winner);
  }
  loser.status = loser.kind === "story" || loser.kind === "friend" || loser.kind === "family" ? "postponed" : "cancelled";
  if (!s.commitments.includes(loser)) s.commitments.push(loser);
}

export function markAttended(s: Schedule, id: string): Commitment {
  const c = s.commitments.find((x) => x.id === id);
  if (!c) throw new Error(`no commitment ${id}`);
  if (c.status !== "scheduled") throw new Error(`commitment ${id} is ${c.status}`);
  c.status = "attended";
  return c;
}

/**
 * Advance to `toDay`: anything still `scheduled` before it becomes `missed` and is returned so
 * the story layer can react (coach follow-up for mandatory training, a friend asking where you
 * were, ...). Deterministic and idempotent for the same target day.
 */
export function advanceTo(s: Schedule, toDay: CampaignDay): Commitment[] {
  const missed: Commitment[] = [];
  for (const c of s.commitments) {
    if (c.status === "scheduled" && c.day < toDay) {
      c.status = "missed";
      missed.push(c);
    }
  }
  return missed.sort((a, b) => a.day - b.day);
}

export interface AttendanceSummary {
  mandatoryScheduled: number;
  attended: number;
  missed: number;
}

export function attendance(s: Schedule, kind: CommitmentKind, upToDay: CampaignDay): AttendanceSummary {
  const rel = s.commitments.filter((c) => c.kind === kind && c.mandatory && c.day <= upToDay);
  return {
    mandatoryScheduled: rel.length,
    attended: rel.filter((c) => c.status === "attended").length,
    missed: rel.filter((c) => c.status === "missed").length,
  };
}
