import type { CampaignDay } from "../calendar/date";
import type { StoryContext } from "../story/consequences";

/**
 * The few things every campaign module needs from the state without pulling in the campaign
 * orchestration itself (which would make `campaign` ↔ `season` circular).
 */

export const PLAYER_ID = "player";
export const FRIEND_ID = "friend";
export const HOME_CLUB_ID = "batavia";
/** People who start whenever they are on the roster: the user and the best friend (spec §4). */
export const MUST_START: readonly string[] = [PLAYER_ID, FRIEND_ID];

export interface HasStory {
  day: CampaignDay;
  revision: number;
  roster: { people: { id: string; clubId: string | null }[] };
  story: StoryContext["story"];
  progression: StoryContext["progression"];
}

export const storyContext = (c: HasStory): StoryContext => ({ story: c.story, progression: c.progression, day: c.day });

export const touch = (c: { revision: number }): number => ++c.revision;

/** The user's club, if they have joined one. */
export function playerClubId(c: HasStory): string | null {
  return c.roster.people.find((p) => p.id === PLAYER_ID)?.clubId ?? null;
}
