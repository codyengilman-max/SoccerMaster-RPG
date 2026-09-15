import arcFile from "../../content/story/arc-u11.json";
import { nextWeekday, weekOf, weekday } from "../calendar/date";
import type { CampaignKind, CampaignState } from "../campaign/campaign";
import { seasonPhase, seasonSummary } from "../campaign/season";
import { playerClubId, storyContext } from "../campaign/state";
import { lastPlayed, sceneEligible, type LocationId, type Scene } from "./scenes";

/**
 * The U11 story arc (spec §6): the season's central question, its authored emotional milestones
 * and the optional interactions at the everyday locations. Milestones are scenes with an `auto`
 * weekday; the planner queues one at most per week when its eligibility holds, so the arc paces
 * itself against the calendar and the evidence (phase, results played, relationships) rather than
 * a fixed script. Optional scenes are offered from the hub at their location and never forced.
 * Nothing here decides anything about soccer: scenes carry authored effects only.
 */

export const CENTRAL_QUESTION =
  "Can this new team become something worth believing in—and will the people building it stay together as new opportunities appear?";

export const ARC_FACTS = {
  /** Mirrors `seasonPhase` so authored eligibility can read it. */
  phase: "season_phase",
  /** FC Batavia's fall league position (1 = top), fixed once the fall league is over. */
  fallPosition: "fall_position",
  lastQueuedWeek: "arc_last_queued_week",
} as const;

interface SceneFile {
  shared: Scene[];
  boys: Scene[];
  girls: Scene[];
}

const arc = arcFile as unknown as SceneFile;

/** Arc scenes for one campaign: shared scenes, overridden by same-id campaign scenes. */
export function arcScenes(kind: CampaignKind): Scene[] {
  const byId = new Map<string, Scene>();
  for (const s of arc.shared) byId.set(s.id, s);
  for (const s of arc[kind]) byId.set(s.id, s);
  return [...byId.values()];
}

export const milestoneScenes = (kind: CampaignKind): Scene[] => arcScenes(kind).filter((s) => s.auto !== undefined);
export const optionalScenesFor = (kind: CampaignKind): Scene[] => arcScenes(kind).filter((s) => s.optional === true);

export function syncPhaseFact(c: CampaignState): void {
  const phase = seasonPhase(c);
  c.story.facts[ARC_FACTS.phase] = phase;
  if (phase !== "preseason" && phase !== "fall" && c.story.facts[ARC_FACTS.fallPosition] === undefined) {
    c.story.facts[ARC_FACTS.fallPosition] = seasonSummary(c).fall?.position ?? 0;
  }
}

/**
 * Queue the first due milestone, at most one per calendar week. Called for every day the campaign
 * passes through. Returns the queued scene id, or null.
 */
export function planArc(c: CampaignState): string | null {
  if (!playerClubId(c)) return null;
  syncPhaseFact(c);
  announceUnlocks(c);
  const week = weekOf(c.day);
  if (c.story.facts[ARC_FACTS.lastQueuedWeek] === week) return null;
  const ctx = storyContext(c);
  for (const s of milestoneScenes(c.kind)) {
    if (c.story.queuedScenes.some((q) => q.sceneId === s.id)) continue;
    if (!sceneEligible(ctx, s)) continue;
    const onDay = weekday(c.day) === s.auto ? c.day : nextWeekday(c.day, s.auto!);
    c.story.queuedScenes.push({ sceneId: s.id, onDay });
    c.story.facts[ARC_FACTS.lastQueuedWeek] = week;
    return s.id;
  }
  return null;
}

/** Scene id that plays once when an unlock is first reached, if the arc authors one. */
export const unlockSceneId = (unlockId: string): string => `unlock.${unlockId}`;
const announcedFact = (unlockId: string): string => `unlock_announced:${unlockId}`;

/** Queue the authored scene for every unlock reached since the last check (spec §19: unlocks are explicit, not implied by dialogue). */
export function announceUnlocks(c: CampaignState): string[] {
  const ids = new Set(arcScenes(c.kind).map((s) => s.id));
  const queued: string[] = [];
  for (const u of c.progression.unlocked) {
    if (c.story.facts[announcedFact(u)] === true) continue;
    const sceneId = unlockSceneId(u);
    if (!ids.has(sceneId)) continue;
    c.story.facts[announcedFact(u)] = true;
    if (c.story.queuedScenes.some((q) => q.sceneId === sceneId)) continue;
    c.story.queuedScenes.push({ sceneId, onDay: c.day });
    queued.push(sceneId);
  }
  return queued;
}

/** A repeatable optional scene waits this long before it is offered again. */
export const OPTIONAL_COOLDOWN_DAYS = 7;

/** Optional scenes the player could enter now at a location, in authored priority order. */
export function optionalScenes(c: CampaignState, location: LocationId): Scene[] {
  const ctx = storyContext(c);
  return optionalScenesFor(c.kind).filter((s) => {
    if (s.location !== location || !sceneEligible(ctx, s)) return false;
    if (s.once) return true;
    const last = lastPlayed(c.story, s.id);
    return last === undefined || c.day - last >= (s.cooldownDays ?? OPTIONAL_COOLDOWN_DAYS);
  });
}

export const optionalScene = (c: CampaignState, location: LocationId): Scene | null => optionalScenes(c, location)[0] ?? null;
