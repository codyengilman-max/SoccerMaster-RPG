import openingFile from "../../content/story/opening-u11.json";
import weekFile from "../../content/story/week-u11.json";
import { nextWeekday, weekday } from "../calendar/date";
import { addCommitment, markAttended, slotsFor } from "../calendar/schedule";
import {
  advanceDays,
  playerClubId,
  storyContext,
  syncStoryFlags,
  touch,
  type CampaignKind,
  type CampaignState,
  type DayAdvance,
} from "../campaign/campaign";
import { ROLE_LABEL } from "../sim/types";
import { applyChoice, choiceEligible, type ChoiceResult } from "./consequences";
import { fill, markSeen, sceneEligible, visibleLines, type Line, type Scene, type SceneChoice } from "./scenes";

/**
 * Scene flow: which authored scene is on screen, what of it the world lets the user see, and
 * how a choice moves the campaign on. All effects go through the consequence reducer; this
 * module only sequences scenes, moves the calendar when a scene is pinned to a weekday, and
 * turns story flags into campaign facts (joining a club).
 */

interface SceneFile {
  shared: Scene[];
  boys: Scene[];
  girls: Scene[];
}

const opening = openingFile as unknown as SceneFile;
const week = weekFile as unknown as SceneFile;

export const OPENING_START = "open.kickabout";

/** Scenes for one campaign: shared scenes, overridden by same-id campaign scenes. */
function merge(file: SceneFile, kind: CampaignKind): Scene[] {
  const byId = new Map<string, Scene>();
  for (const s of file.shared) byId.set(s.id, s);
  for (const s of file[kind]) byId.set(s.id, s);
  return [...byId.values()];
}

export const openingScenes = (kind: CampaignKind): Scene[] => merge(opening, kind);
export const weekScenes = (kind: CampaignKind): Scene[] => merge(week, kind);

/** Everything authored for a campaign: opening plus regular-week scenes. */
export const campaignScenes = (kind: CampaignKind): Scene[] => [...openingScenes(kind), ...weekScenes(kind)];

/**
 * Choice ids are the consequence reducer's idempotency keys. A repeatable scene (`once: false`,
 * e.g. the postgame car ride) must be answerable every time it plays, so its choices are keyed by
 * the day they are taken.
 */
export function scopedChoice(scene: Scene, choice: SceneChoice, day: number): SceneChoice {
  return scene.once ? choice : { ...choice, id: `${choice.id}@${day}` };
}

export function sceneById(scenes: readonly Scene[], id: string): Scene {
  const s = scenes.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scene ${id}`);
  return s;
}

/** Text variables for `fill` (spec §4 names the friend, parent and coach by role). */
export function sceneVars(c: CampaignState): Record<string, string> {
  const name = (id: string): string => c.roster.people.find((p) => p.id === id)?.name ?? id;
  const club = c.roster.clubs.find((k) => k.id === "batavia");
  const factText = (id: string): string => {
    const v = c.story.facts[id];
    return v === undefined ? `{${id}}` : String(v);
  };
  return {
    player: c.player.name,
    friend: name("friend"),
    parent: name("parent"),
    coach: name("coach"),
    position: ROLE_LABEL[c.player.position].toLowerCase(),
    club: club?.name ?? "the club",
    score: factText("last_score"),
    opponent: factText("last_opponent"),
    missed_day: factText("missed_training_day"),
  };
}

export interface EnterResult {
  scene: Scene;
  advanced: DayAdvance | null;
}

/** Make a scene current. A weekday-pinned scene moves the campaign to the next such day first. */
export function enterScene(c: CampaignState, scenes: readonly Scene[], id: string): EnterResult {
  const scene = sceneById(scenes, id);
  let advanced: DayAdvance | null = null;
  if (scene.weekday && weekday(c.day) !== scene.weekday) {
    advanced = advanceDays(c, nextWeekday(c.day, scene.weekday) - c.day);
  }
  if (scene.commitment) attend(c, scene);
  c.scene = scene.id;
  touch(c);
  return { scene, advanced };
}

/** A scene-bound commitment (the Thursday visit) is a one-off on the calendar, not part of the weekly template (spec §4). */
function attend(c: CampaignState, scene: Scene): void {
  const spec = scene.commitment!;
  const id = `${spec.kind}-${scene.id}-${c.day}`;
  addCommitment(c.schedule, {
    id,
    day: c.day,
    slot: spec.slot,
    kind: spec.kind,
    title: spec.title,
    mandatory: false,
    refId: scene.id,
    minutes: spec.minutes,
    status: "scheduled",
  });
  if (c.schedule.commitments.some((x) => x.id === id && x.status === "scheduled")) markAttended(c.schedule, id);
  const slots = slotsFor(c.day);
  if (slots.indexOf(spec.slot) > slots.indexOf(c.slot)) c.slot = spec.slot;
}

export function startOpening(c: CampaignState): EnterResult {
  return enterScene(c, openingScenes(c.kind), OPENING_START);
}

export interface SceneView {
  scene: Scene;
  /** Lines the world allows, with variables filled. */
  lines: Line[];
  /** Choices the user may currently take. */
  choices: SceneChoice[];
  vars: Record<string, string>;
}

export function viewScene(c: CampaignState, scenes: readonly Scene[]): SceneView | null {
  if (!c.scene) return null;
  const scene = sceneById(scenes, c.scene);
  const ctx = storyContext(c);
  const vars = sceneVars(c);
  const lines = visibleLines(ctx, scene.lines).map((l) => ({ ...l, text: fill(l.text, vars) }));
  const choices = scene.choices.filter((ch) => choiceEligible(ctx, scopedChoice(scene, ch, c.day)));
  return { scene, lines, choices, vars };
}

export type ChooseResult =
  | { ok: true; result: ChoiceResult; response: Line[]; next: EnterResult | null }
  | { ok: false; reason: "no_scene" | "unknown_choice" | "duplicate" | "ineligible" | "expired" };

/** Take a choice in the current scene; the scene is marked seen and the flow moves to the choice's (or scene's) `next`. */
export function chooseInScene(c: CampaignState, scenes: readonly Scene[], choiceId: string): ChooseResult {
  if (!c.scene) return { ok: false, reason: "no_scene" };
  const scene = sceneById(scenes, c.scene);
  const choice = scene.choices.find((ch) => ch.id === choiceId);
  if (!choice) return { ok: false, reason: "unknown_choice" };
  const result = applyChoice(storyContext(c), scopedChoice(scene, choice, c.day));
  if (!result.ok) return { ok: false, reason: result.reason };
  syncStoryFlags(c);
  const vars = sceneVars(c);
  const response = visibleLines(storyContext(c), choice.response).map((l) => ({ ...l, text: fill(l.text, vars) }));
  const next = leave(c, scenes, scene, choice.next ?? scene.next);
  return { ok: true, result, response, next };
}

/** Finish a scene that has no (remaining) choices and move to `next`. */
export function continueScene(c: CampaignState, scenes: readonly Scene[]): EnterResult | null {
  if (!c.scene) return null;
  const scene = sceneById(scenes, c.scene);
  return leave(c, scenes, scene, scene.next);
}

function leave(c: CampaignState, scenes: readonly Scene[], scene: Scene, nextId: string | null): EnterResult | null {
  if (scene.once) markSeen(c.story, scene.id, c.day);
  if (nextId) return enterScene(c, scenes, nextId);
  c.scene = null;
  touch(c);
  return null;
}

/** A queued scene that is due and eligible now, if any; it is removed from the queue and entered. */
export function takeQueuedScene(c: CampaignState, scenes: readonly Scene[]): EnterResult | null {
  const ctx = storyContext(c);
  const i = c.story.queuedScenes.findIndex((q) => {
    if (q.onDay !== null && q.onDay > c.day) return false;
    const s = scenes.find((x) => x.id === q.sceneId);
    return !!s && sceneEligible(ctx, s);
  });
  if (i < 0) return null;
  const [q] = c.story.queuedScenes.splice(i, 1);
  return enterScene(c, scenes, q!.sceneId);
}

export type OpeningStatus = "in_progress" | "joined" | "undecided" | "declined";

/** Where the opening stands, for the hub / end card. */
export function openingStatus(c: CampaignState): OpeningStatus {
  if (c.scene) return "in_progress";
  if (playerClubId(c)) return "joined";
  if (c.story.facts["undecided"] === true) return "undecided";
  return "declined";
}
