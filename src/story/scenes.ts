import type { CampaignDay, Weekday } from "../calendar/date";
import type { CommitmentKind, Slot } from "../calendar/schedule";
import type { Continuation, MinigameId } from "../minigame/contract";
import { allHold, knows, type Choice, type Condition, type StoryContext, type StoryState } from "./consequences";

/**
 * Authored scenes (spec §6, §20). A scene is lines plus choices; choices are `Choice` data so the
 * consequence reducer owns every effect. Lines can be gated on what the speaker actually knows.
 * Scene tone tags feed the editorial-mix report and never touch results (OPEN_QUESTIONS #21).
 */

export type Tone = "reward" | "adversity" | "everyday";
export const TONES: readonly Tone[] = ["reward", "adversity", "everyday"];

/** The everyday places of spec §6 (school, lunch, car, park, home, training, tournament common areas, the pitch). */
export type LocationId = "home" | "car" | "school" | "lunch_spot" | "training_field" | "park" | "tournament_hotel" | "pitch";
export const LOCATIONS: readonly LocationId[] = ["home", "car", "school", "lunch_spot", "training_field", "park", "tournament_hotel", "pitch"];

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
  /** The scene happens on the next such weekday; entering it moves the campaign forward. */
  weekday?: Weekday;
  /** Playable activity run after the lines and before `next` (spec §4 step 7). */
  activity?: string;
  /**
   * Story Engine v2 minigame launched after the lines; its verified result is written to the
   * ledger before `next` continues. Participants are story ids (player first is implied).
   */
  minigame?: MinigameLaunch;
  /** One-off calendar commitment the scene represents (e.g. the Thursday visit); attended on entry. */
  commitment?: { kind: CommitmentKind; slot: Slot; title: string; minutes: number };
  /** Once-only scenes are recorded as `scene:<id>` in `story.applied`. */
  once: boolean;
  /**
   * Arc milestone: the planner queues the scene for the next such weekday as soon as its
   * eligibility holds (at most one milestone per week). Absent for scenes queued by effects.
   */
  auto?: Weekday;
  /** Offered from the hub at the scene's location when eligible (lunch, car, park); never forced. */
  optional?: boolean;
  /** Days before a repeatable optional scene is offered again (default in story/arc). */
  cooldownDays?: number;
  reviewStatus: "proposal" | "reviewed";
}

export interface MinigameLaunch {
  gameId: MinigameId;
  episodeId: string;
  ruleVariant: string;
  participants: string[];
  /** Scene to continue on per verified continuation; missing entries fall back to the scene's `next`. */
  continuations?: Partial<Record<Continuation, string>>;
}

/** Fact holding the campaign day a scene's minigame was last committed (the continuation gate). */
export const minigameDoneKey = (sceneId: string): string => `mg:scene:${sceneId}`;
export const minigameContinuationKey = (sceneId: string): string => `mg:scene:${sceneId}:continuation`;

export const sceneKey = (id: string): string => `scene:${id}`;

export function sceneEligible(ctx: StoryContext, scene: Scene): boolean {
  if (scene.once && ctx.story.applied.includes(sceneKey(scene.id))) return false;
  return allHold(ctx, scene.eligibility);
}

/** Day a repeatable scene last played, or undefined. */
export const lastPlayed = (story: StoryState, sceneId: string): CampaignDay | undefined => story.appliedDays[`played:${sceneId}`];

export function markPlayed(story: StoryState, sceneId: string, day: CampaignDay): void {
  story.appliedDays[`played:${sceneId}`] = day;
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
