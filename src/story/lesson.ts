import type { FacedMoment, MatchReport } from "../match/report";
import type { RoleId } from "../sim/types";
import type { Effect } from "./consequences";

/**
 * A coaching lesson (Story Engine v2 §6): something Coach Code teaches at training that the
 * player can then recognise in an official match. The lesson is information only — it names the
 * catalog entries where the concept applies so the match screen can show the coach's cue and the
 * Monday scene can talk about what verifiably happened. It changes no option, grade or probability.
 */
export interface Lesson {
  id: string;
  title: string;
  /** What the coach says; also shown as a cue on matching match moments. */
  cue: string;
  /** Catalog entries per role in which the lesson applies. Roles without an entry are honest about it. */
  entries: Partial<Record<RoleId, string[]>>;
}

export const LESSONS: Record<string, Lesson> = {
  scan_before_receive: {
    id: "scan_before_receive",
    title: "Look before it arrives",
    cue: "Coach Code: look before it arrives — know where the pressure is and where your first touch goes.",
    entries: {
      GK: ["GK_RECV_01"],
      RB: ["RB_RECV_01"],
      LB: ["LB_RECV_01"],
      CB: ["CB_BUILD_01", "CB_BUILD_02"],
      DM: ["DM_RECV_01"],
      CM: ["CM_RECV_01"],
      RW: ["RW_RECV_01"],
      LW: ["LW_RECV_01"],
      ST: ["ST_RECV_01"],
    },
  },
};

export const LESSON_FACTS = {
  /** Lesson currently being carried into the next match (id) or unset. */
  active: "lesson:active",
  title: "lesson:title",
  /** Facts about the last match in which the active lesson was checked. */
  faced: "lesson:last_faced",
  strong: "lesson:last_strong",
  weak: "lesson:last_weak",
  /** "applied" | "mixed" | "missed" | "not_faced" | "none" */
  verdict: "lesson:last_verdict",
  /** Lifetime count of moments faced with a lesson active. */
  facedTotal: "lesson:faced_total",
} as const;

export type LessonVerdict = "applied" | "mixed" | "missed" | "not_faced";

export const lessonById = (id: string): Lesson | undefined => LESSONS[id];

export function lessonEntries(lesson: Lesson, role: RoleId): string[] {
  return lesson.entries[role] ?? [];
}

/** The cue the match screen may show on the lesson's own catalog entries — presentation only. */
export function activeLessonCue(facts: Readonly<Record<string, unknown>>, role: RoleId): { entryIds: string[]; cue: string } | null {
  const id = facts[LESSON_FACTS.active];
  const lesson = typeof id === "string" ? lessonById(id) : undefined;
  if (!lesson) return null;
  const entryIds = lessonEntries(lesson, role);
  return entryIds.length ? { entryIds, cue: lesson.cue } : null;
}

export function lessonMoments(lesson: Lesson, role: RoleId, r: MatchReport): FacedMoment[] {
  const ids = new Set(lessonEntries(lesson, role));
  return r.moments.faced.filter((m) => ids.has(m.entryId));
}

export function lessonVerdict(faced: readonly FacedMoment[]): LessonVerdict {
  if (faced.length === 0) return "not_faced";
  const strong = faced.filter((m) => m.band === "strong").length;
  const weak = faced.filter((m) => m.band !== "strong" && m.band !== "acceptable").length;
  if (strong >= Math.ceil(faced.length / 2) && weak === 0) return "applied";
  if (weak >= Math.ceil(faced.length / 2)) return "missed";
  return "mixed";
}

/** Facts the Monday scene may quote: only what the report lists for the lesson's own entries. */
export function lessonFacts(lesson: Lesson, role: RoleId, r: MatchReport, facedBefore: number): Effect[] {
  const faced = lessonMoments(lesson, role, r);
  const strong = faced.filter((m) => m.band === "strong").length;
  const weak = faced.filter((m) => m.band !== "strong" && m.band !== "acceptable").length;
  return [
    { type: "set_fact", id: LESSON_FACTS.faced, value: faced.length },
    { type: "set_fact", id: LESSON_FACTS.strong, value: strong },
    { type: "set_fact", id: LESSON_FACTS.weak, value: weak },
    { type: "set_fact", id: LESSON_FACTS.verdict, value: lessonVerdict(faced) },
    { type: "set_fact", id: LESSON_FACTS.facedTotal, value: facedBefore + faced.length },
    { type: "learn", personId: "coach", factId: LESSON_FACTS.verdict },
    { type: "learn", personId: "coach", factId: LESSON_FACTS.faced },
  ];
}
