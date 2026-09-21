import hobbiesFile from "../../content/story/hobbies-u11.json";
import openingFile from "../../content/story/opening-u11.json";
import seasonFile from "../../content/story/season-u11.json";
import tryoutsFile from "../../content/story/tryouts-u11.json";
import weekFile from "../../content/story/week-u11.json";
import { formatDay, nextWeekday, weekday } from "../calendar/date";
import { addCommitment, markAttended, slotsFor } from "../calendar/schedule";
import {
  advanceDays,
  PLAYER_ID,
  playerClubId,
  resolvePerson,
  storyContext,
  syncStoryFlags,
  touch,
  type CampaignKind,
  type CampaignState,
  type DayAdvance,
} from "../campaign/campaign";
import { ROLE_LABEL } from "../sim/types";
import { arcScenes } from "./arc";
import { episodeScenes } from "./episodes";
import { applyChoice, applyRepair, availableRepairs, choiceEligible, type ChoiceResult, type RepairOption, type RepairResult } from "./consequences";
import { CONTINUATIONS, type Continuation } from "../minigame/contract";
import {
  fill,
  markPlayed,
  markSeen,
  minigameContinuationKey,
  minigameDoneKey,
  sceneEligible,
  visibleLines,
  type Line,
  type MinigameLaunch,
  type Scene,
  type SceneChoice,
} from "./scenes";

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
const season = seasonFile as unknown as SceneFile;
const tryouts = tryoutsFile as unknown as SceneFile;
const hobbies = hobbiesFile as unknown as SceneFile;

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
export const seasonScenes = (kind: CampaignKind): Scene[] => merge(season, kind);
export const tryoutScenes = (kind: CampaignKind): Scene[] => merge(tryouts, kind);
export const hobbyScenes = (kind: CampaignKind): Scene[] => merge(hobbies, kind);

/** Everything authored for a campaign: opening, regular-week, season, story-arc, tryout and hobby scenes. */
export const campaignScenes = (kind: CampaignKind): Scene[] => [
  ...openingScenes(kind),
  ...weekScenes(kind),
  ...seasonScenes(kind),
  ...arcScenes(kind),
  ...tryoutScenes(kind),
  ...hobbyScenes(kind),
  ...episodeScenes(kind),
];

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

/** Display name for a story speaker or person id (cast roles resolve to the campaign's teammate). */
export function personName(c: CampaignState, id: string): string {
  if (id === PLAYER_ID) return c.player.name;
  const rosterId = resolvePerson(c.kind, id);
  return c.roster.people.find((p) => p.id === rosterId)?.name ?? id;
}

/** Text variables for `fill` (spec §4 names the friend, parent and coach by role). */
export function sceneVars(c: CampaignState): Record<string, string> {
  const name = (id: string): string => personName(c, id);
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
    tournament: factText("tournament_name"),
    tournament_date: factText("tournament_date"),
    tournament_moved: factText("tournament_moved"),
    tournament_record: factText("tournament_record"),
    missed_match_opponent: factText("missed_match_opponent"),
    missed_match_score: factText("missed_match_score"),
    season_record: factText("season_league_record"),
    season_goals: factText("season_goals"),
    season_matches: factText("season_matches_played"),
    season_trophies: factText("season_trophies"),
    juggling_best: factText("juggling_best"),
    striker: name("striker"),
    organiser: name("organiser"),
    keeper: name("keeper"),
    newcomer: name("newcomer"),
    league_played: factText("league_matches_played"),
    streak: factText("result_streak"),
    tryout_day: formatDay(c.tryouts.day),
    invited_clubs: factText("tryout_invited_clubs"),
    invite_count: factText("tryout_invite_count"),
    tryout_last_club: factText("tryout_last_club"),
    offers: factText("tryout_offers"),
    offer_count: factText("tryout_offer_count"),
    broken_club: factText("tryout_promise_broken_club"),
    next_club: factText("tryout_next_club"),
    friend_club: factText("tryout_friend_club"),
    striker_club: factText("tryout_striker_club"),
    rival: name("rival"),
    teacher: name("teacher"),
    leah: name("cm-leah"),
    tobias: name("cm-tobias"),
    hana: name("cm-hana"),
    ravi: name("cm-ravi"),
    sol: name("cm-sol"),
    lesson_title: factText("lesson:title"),
    lesson_faced: factText("lesson:last_faced"),
    lesson_strong: factText("lesson:last_strong"),
    lesson_verdict: factText("lesson:last_verdict"),
    wck_place: factText("mg:world_cup_knockout:place"),
    wck_players: factText("mg:world_cup_knockout:players"),
    wck_winner: (() => {
      const w = c.story.facts["mg:world_cup_knockout:winner"];
      return typeof w === "string" && w ? name(w) : "{wck_winner}";
    })(),
    gp_accuracy: factText("mg:group_presentation:accuracy"),
    gp_clarity: factText("mg:group_presentation:clarity"),
    gp_teamwork: factText("mg:group_presentation:teamwork"),
    fall_finish: typeof c.story.facts["fall_position"] === "number" && c.story.facts["fall_position"] > 0 ? ordinal(c.story.facts["fall_position"]) : "{fall_finish}",
  };
}

export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
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
  /** The scene's minigame still has to be played (and its result committed) before it can continue. */
  minigame: MinigameLaunch | null;
}

/** A minigame scene is gated until `completeMinigame` has committed today's result. */
export function minigameDue(c: CampaignState, scene: Scene): boolean {
  return !!scene.minigame && c.story.facts[minigameDoneKey(scene.id)] !== c.day;
}

/** Where a minigame scene continues, from the verified continuation recorded at commit time. */
export function minigameNext(c: CampaignState, scene: Scene): string | null {
  const launch = scene.minigame;
  if (!launch) return scene.next;
  const cont = c.story.facts[minigameContinuationKey(scene.id)];
  const key = CONTINUATIONS.find((k): k is Continuation => k === cont);
  return (key && launch.continuations?.[key]) ?? scene.next;
}

export function viewScene(c: CampaignState, scenes: readonly Scene[]): SceneView | null {
  if (!c.scene) return null;
  const scene = sceneById(scenes, c.scene);
  const ctx = storyContext(c);
  const vars = sceneVars(c);
  const lines = visibleLines(ctx, scene.lines).map((l) => ({ ...l, text: fill(l.text, vars) }));
  const choices = scene.choices
    .filter((ch) => choiceEligible(ctx, scopedChoice(scene, ch, c.day)))
    .map((ch) => ({ ...ch, label: fill(ch.label, vars) }));
  return { scene, lines, choices, vars, minigame: minigameDue(c, scene) ? scene.minigame! : null };
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
  const next = leave(c, scenes, scene, choice.next ?? minigameNext(c, scene));
  return { ok: true, result, response, next };
}

/**
 * Finish a scene that has no (remaining) choices and move to `next`. A minigame scene whose game
 * has not been committed stays current and returns null: the screen must launch the game.
 */
export function continueScene(c: CampaignState, scenes: readonly Scene[]): EnterResult | null {
  if (!c.scene) return null;
  const scene = sceneById(scenes, c.scene);
  return leave(c, scenes, scene, minigameNext(c, scene));
}

function leave(c: CampaignState, scenes: readonly Scene[], scene: Scene, nextId: string | null): EnterResult | null {
  if (minigameDue(c, scene)) return null;
  if (scene.once) markSeen(c.story, scene.id, c.day);
  else markPlayed(c.story, scene.id, c.day);
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

export interface OpenRepair {
  scene: Scene;
  choice: SceneChoice;
  repair: RepairOption;
  label: string;
  /** Last campaign day the repair is still possible. */
  untilDay: number;
}

/** Repairs still open for choices already taken (spec §20: every consequential choice names its repair). */
export function openRepairs(c: CampaignState, scenes: readonly Scene[]): OpenRepair[] {
  const ctx = storyContext(c);
  const vars = sceneVars(c);
  const out: OpenRepair[] = [];
  for (const scene of scenes) {
    for (const choice of scene.choices) {
      if (!choice.repair.length) continue;
      const takenIds = scene.once
        ? [choice.id]
        : Object.keys(c.story.appliedDays).filter((k) => k.startsWith(`${choice.id}@`) && !k.includes(":"));
      for (const id of takenIds) {
        const madeDay = c.story.appliedDays[id];
        if (madeDay === undefined) continue;
        const taken = { ...choice, id };
        for (const repair of availableRepairs(ctx, taken)) {
          out.push({ scene, choice: taken, repair, label: fill(repair.label, vars), untilDay: madeDay + repair.withinDays });
        }
      }
    }
  }
  return out;
}

/** `choiceId` is the taken (possibly day-scoped) id from `openRepairs`. */
export function takeRepair(c: CampaignState, scenes: readonly Scene[], choiceId: string, repairId: string): RepairResult {
  const open = openRepairs(c, scenes).find((r) => r.choice.id === choiceId && r.repair.id === repairId);
  if (!open) return { ok: false, reason: "unavailable" };
  const r = applyRepair(storyContext(c), open.choice, repairId);
  if (r.ok) touch(c);
  return r;
}

export type OpeningStatus = "in_progress" | "joined" | "undecided" | "declined";

/** Where the opening stands, for the hub / end card. */
export function openingStatus(c: CampaignState): OpeningStatus {
  if (c.scene) return "in_progress";
  if (playerClubId(c)) return "joined";
  if (c.story.facts["undecided"] === true) return "undecided";
  return "declined";
}
