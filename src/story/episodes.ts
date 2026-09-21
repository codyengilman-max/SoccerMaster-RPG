import episode1File from "../../content/story/episode1-u11.json";
import { nextWeekday, weekday } from "../calendar/date";
import type { CampaignKind, CampaignState } from "../campaign/campaign";
import { playerClubId, storyContext } from "../campaign/state";
import { sceneEligible, type Scene } from "./scenes";

/**
 * Story Engine v2 episodes (§3, §7): authored school-week stories that launch minigames and react
 * to their verified results. Each episode file is a scene set with `auto` weekday beats; unlike
 * the season arc, an episode's beats are not capped at one per week — a school week is the unit —
 * so the planner queues every due beat the day its eligibility holds. Nothing here reads or
 * writes soccer state: scenes carry authored effects and gate on recorded facts only.
 */

interface EpisodeFile {
  episodeId: string;
  title: string;
  summary: string;
  shared: Scene[];
  boys: Scene[];
  girls: Scene[];
}

export const EPISODES: readonly EpisodeFile[] = [episode1File as unknown as EpisodeFile];

function merge(file: EpisodeFile, kind: CampaignKind): Scene[] {
  const byId = new Map<string, Scene>();
  for (const s of file.shared) byId.set(s.id, s);
  for (const s of file[kind]) byId.set(s.id, s);
  return [...byId.values()];
}

/** Every episode scene for a campaign, in episode order. */
export const episodeScenes = (kind: CampaignKind): Scene[] => EPISODES.flatMap((f) => merge(f, kind));

export const episodeBeats = (kind: CampaignKind): Scene[] => episodeScenes(kind).filter((s) => s.auto !== undefined);

/** Queue every episode beat whose eligibility holds today, for its weekday. Returns the queued ids. */
export function planEpisodes(c: CampaignState): string[] {
  if (!playerClubId(c)) return [];
  const ctx = storyContext(c);
  const queued: string[] = [];
  for (const s of episodeBeats(c.kind)) {
    if (c.story.queuedScenes.some((q) => q.sceneId === s.id)) continue;
    if (c.scene === s.id || !sceneEligible(ctx, s)) continue;
    const onDay = weekday(c.day) === s.auto ? c.day : nextWeekday(c.day, s.auto!);
    c.story.queuedScenes.push({ sceneId: s.id, onDay });
    queued.push(s.id);
  }
  return queued;
}
