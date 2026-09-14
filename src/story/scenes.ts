import type { CampaignDay } from "../calendar/date";
import { allHold, knows, type Choice, type Condition, type StoryContext, type StoryState } from "./consequences";

/**
 * Authored scenes (spec §6, §20). A scene is lines plus choices; choices are `Choice` data so the
 * consequence reducer owns every effect. Lines can be gated on what the speaker actually knows.
 * Scene tone tags feed the editorial-mix report and never touch results (OPEN_QUESTIONS #21).
 */

export type Tone = "reward" | "adversity" | "everyday";

export type LocationId = "home" | "car" | "school" | "lunch_spot" | "training_field" | "park" | "tournament_hotel" | "pitch";

export interface Line {
  /** Person id, or null for narration. */
  speaker: string | null;
  text: string;
  /** Fact ids the speaker must know for the line to be spoken; otherwise the line is skipped. */
  requiresKnown?: string[];
  /** Conditions on the world for the line to appear. */
  when?: Condition[];
}

export interface SceneChoice extends Choice {
  /** Lines spoken after the choice. */
  response: Line[];
  next: string | null;
}

export interface Scene {
  id: string;
  title: string;
  location: LocationId;
  tone: Tone;
  eligibility: Condition[];
  lines: Line[];
  choices: SceneChoice[];
  /** Scene to continue into when there are no choices (or after a choice without its own `next`). */
  next: string | null;
  /** Once-only scenes are recorded as `scene:<id>` in `story.applied`. */
  once: boolean;
  reviewStatus: "proposal" | "reviewed";
}

export const sceneKey = (id: string): string => `scene:${id}`;

export function sceneEligible(ctx: StoryContext, scene: Scene): boolean {
  if (scene.once && ctx.story.applied.includes(sceneKey(scene.id))) return false;
  return allHold(ctx, scene.eligibility);
}

/** Lines the world currently allows: speaker knowledge and conditions. */
export function visibleLines(ctx: StoryContext, lines: readonly Line[]): Line[] {
  return lines.filter((l) => {
    if (l.requiresKnown && l.speaker && !l.requiresKnown.every((f) => knows(ctx.story, l.speaker!, f))) return false;
    if (l.when && !allHold(ctx, l.when)) return false;
    return true;
  });
}

/** Mark a scene seen (idempotent). */
export function markSeen(story: StoryState, sceneId: string, day: CampaignDay): boolean {
  const k = sceneKey(sceneId);
  if (story.applied.includes(k)) return false;
  story.applied.push(k);
  story.appliedDays[k] = day;
  return true;
}

/** `{player}`, `{friend}` … substitution for authored text. Unknown keys are left visible so gaps are noticed. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export interface ToneReport {
  total: number;
  share: Record<Tone, number>;
  /** Spec §6 targets: 30 / 15 / 55. */
  target: Record<Tone, number>;
}

export function toneReport(scenes: readonly Scene[]): ToneReport {
  const counts: Record<Tone, number> = { reward: 0, adversity: 0, everyday: 0 };
  for (const s of scenes) counts[s.tone]++;
  const total = scenes.length || 1;
  return {
    total: scenes.length,
    share: { reward: counts.reward / total, adversity: counts.adversity / total, everyday: counts.everyday / total },
    target: { reward: 0.3, adversity: 0.15, everyday: 0.55 },
  };
}
