import { mondayOf, weekOf, weekday, type CampaignDay, type Weekday } from "../calendar/date";
import { commitmentsOn, markAttended, phoneAvailable, slotsFor, type Commitment, type Slot } from "../calendar/schedule";
import type { MatchReport } from "../match/report";
import { applyEffect, type Effect } from "../story/consequences";
import { takeQueuedScene, campaignScenes } from "../story/flow";
import type { ChallengeSummary } from "../training/crossbar";
import { nextAssignment, stageOf, type Assignment, type Stage } from "../training/homeSkill";
import { recordCrossbar, recordTraining } from "../training/record";
import { ACTIVITIES, type Activity, type Summary as SmallSidedSummary } from "../training/smallSided";
import { FRIEND_ID, advanceDays, playerClubId, storyContext, touch, type CampaignState, type DayAdvance, type PendingActivity } from "./campaign";
import { completeCampaignMatch, type CompleteMatchResult } from "./match";

/**
 * The regular week (spec §7): the campaign is lived one slot at a time. Each slot offers a small
 * set of actions — the commitment already on the calendar, or free-time choices. Playable actions
 * (training, match, friend, home skill) are *launched* here and *completed* here so the calendar,
 * evidence and story move in one place; the UI only draws what this module says.
 *
 * Rest matters: fatigue is a story fact in 0..10. Training and matches add to it, rest and sleep
 * take it away, and a tired player gets a shorter decision window at the next training. Training
 * every slot is therefore not the best week (spec §7 "training is not universally optimal").
 */

export type ActionId =
  | "school"
  | "train"
  | "skip_training"
  | "play_match"
  | "skip_match"
  | "home_skill"
  | "friend_crossbar"
  | "family"
  | "homework"
  | "rest"
  | "free";

export interface SlotAction {
  id: ActionId;
  label: string;
  detail: string;
  commitmentId: string | null;
  /** What the screen must run before calling the matching `complete*`; null for immediate actions. */
  launch: PendingActivity | null;
}

export const FATIGUE_FACT = "fatigue";
export const TIRED_AT = 7;
export const FATIGUE = { training: 2, match: 3, homeSkill: 1, rest: -3, sleep: -1, max: 10 } as const;

export const fatigue = (c: CampaignState): number => {
  const v = c.story.facts[FATIGUE_FACT];
  return typeof v === "number" ? v : 0;
};

export const isTired = (c: CampaignState): boolean => fatigue(c) >= TIRED_AT;

function addFatigue(c: CampaignState, delta: number): void {
  c.story.facts[FATIGUE_FACT] = Math.max(0, Math.min(FATIGUE.max, fatigue(c) + delta));
}

/** Tue → 1v1, Thu → 2v2, Fri → 3v2 in the first week; the programme rotates one step each week. */
export function trainingActivity(day: CampaignDay): Activity {
  const w = weekday(day);
  const order = w === "Tue" ? 0 : w === "Thu" ? 1 : 2;
  return ACTIVITIES[(order + weekOf(day)) % ACTIVITIES.length]!;
}

export const currentCommitment = (c: CampaignState): Commitment | undefined =>
  commitmentsOn(c.schedule, c.day).find((k) => k.slot === c.slot && k.status === "scheduled");

export const isFreeSlot = (c: CampaignState): boolean => !currentCommitment(c);

/** Everything the player can do in the current slot. */
export function slotActions(c: CampaignState): SlotAction[] {
  if (c.scene || c.pending) return [];
  const k = currentCommitment(c);
  if (k) {
    switch (k.kind) {
      case "school":
        return [{ id: "school", label: "Go to school", detail: k.title, commitmentId: k.id, launch: null }];
      case "training": {
        const activity = trainingActivity(c.day);
        return [
          {
            id: "train",
            label: "Go to training",
            detail: `${ACTIVITY_TITLE[activity]}${isTired(c) ? " · you're tired — expect slower reads" : ""}`,
            commitmentId: k.id,
            launch: { kind: "training", commitmentId: k.id, activity },
          },
          { id: "skip_training", label: "Skip training", detail: "The coach will notice.", commitmentId: k.id, launch: null },
        ];
      }
      case "match":
      case "tournament":
        return [
          { id: "play_match", label: "Play the match", detail: k.title, commitmentId: k.id, launch: { kind: "match", commitmentId: k.id, fixtureId: k.refId! } },
          { id: "skip_match", label: "Miss the match", detail: "The team plays without you. The result still counts.", commitmentId: k.id, launch: null },
        ];
      default:
        return [{ id: "free", label: k.title, detail: "", commitmentId: k.id, launch: null }];
    }
  }
  const out: SlotAction[] = [];
  const home = nextAssignment(c);
  if (home) out.push(homeAction(c, home));
  if (friendAvailable(c)) {
    out.push({ id: "friend_crossbar", label: "Crossbar challenge with {friend}", detail: "Time with your friend. Not training.", commitmentId: null, launch: { kind: "crossbar" } });
  }
  if (c.slot === "evening" || weekday(c.day) === "Sat" || weekday(c.day) === "Sun") {
    out.push({ id: "family", label: "Help at home", detail: "Responsibility; time with {parent}.", commitmentId: null, launch: null });
  }
  if (c.slot === "evening" && !["Sat", "Sun"].includes(weekday(c.day))) {
    out.push({ id: "homework", label: "Homework", detail: "School comes first.", commitmentId: null, launch: null });
  }
  out.push({ id: "rest", label: "Rest", detail: fatigue(c) >= 4 ? "Your legs would thank you." : "Recover.", commitmentId: null, launch: null });
  return out;
}

export const ACTIVITY_TITLE: Record<Activity, string> = {
  "1v1": "1v1 — beat your defender",
  "2v2": "2v2 — pass or carry",
  "3v2": "3v2 — numbers up",
};

function homeAction(c: CampaignState, a: Assignment): SlotAction {
  const stage = stageOf(c, a.id);
  const detail: Record<Stage, string> = {
    watch: `Watch the demonstration: ${a.title}`,
    practise: `Practise away from the screen, then report: ${a.title}`,
    report: `Report what you noticed: ${a.title}`,
    revisit: `Revisit the learning: ${a.title}`,
    done: a.title,
  };
  return { id: "home_skill", label: "Home skill work", detail: detail[stage], commitmentId: null, launch: { kind: "home_skill", assignmentId: a.id } };
}

export const CROSSBAR_DAY_FACT = "crossbar_last_day";

/** The friend is free after school and at weekends, once a day, and only where the phone is allowed (spec §7). */
export function friendAvailable(c: CampaignState): boolean {
  if (!phoneAvailable(c.day, c.slot)) return false;
  if (!c.roster.people.some((p) => p.id === FRIEND_ID)) return false;
  if (c.story.facts[CROSSBAR_DAY_FACT] === c.day) return false;
  const w = weekday(c.day);
  return c.slot !== "morning" || w === "Sat" || w === "Sun";
}

export type TakeResult =
  | { ok: true; launch: PendingActivity; effects: [] }
  | { ok: true; launch: null; effects: Effect[]; ended: SlotEnd }
  | { ok: false; reason: "unavailable" | "busy" };

/** Take an action. Immediate ones finish the slot; playable ones become `pending` for the screen to run. */
export function takeAction(c: CampaignState, id: ActionId): TakeResult {
  if (c.scene || c.pending) return { ok: false, reason: "busy" };
  const action = slotActions(c).find((a) => a.id === id);
  if (!action) return { ok: false, reason: "unavailable" };
  if (action.launch) {
    c.pending = action.launch;
    touch(c);
    return { ok: true, launch: action.launch, effects: [] };
  }
  const effects: Effect[] = [];
  switch (action.id) {
    case "school":
      markAttended(c.schedule, action.commitmentId!);
      break;
    case "skip_training":
      effects.push(...skipTraining(c, action.commitmentId!));
      break;
    case "skip_match": {
      const k = c.schedule.commitments.find((x) => x.id === action.commitmentId);
      if (k && k.status === "scheduled") k.status = "missed";
      break;
    }
    case "family":
      effects.push({ type: "track", track: "responsibility", delta: 1 }, { type: "relationship", personId: "parent", delta: 1 });
      break;
    case "homework":
      effects.push({ type: "track", track: "school", delta: 1 });
      break;
    case "rest":
      addFatigue(c, FATIGUE.rest);
      effects.push({ type: "track", track: "wellbeing", delta: 1 });
      break;
    case "free":
      if (action.commitmentId) markAttended(c.schedule, action.commitmentId);
      break;
    default:
      break;
  }
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  const ended = endSlot(c);
  return { ok: true, launch: null, effects, ended };
}

export const MISSED_FACTS = { recent: "missed_training_recent", count: "trainings_missed", day: "missed_training_day" } as const;

/** Skipping is a choice with a follow-up: the commitment is missed now (not at day end) and the coach asks next time. */
function skipTraining(c: CampaignState, commitmentId: string): Effect[] {
  const k = c.schedule.commitments.find((x) => x.id === commitmentId);
  if (!k || k.status !== "scheduled") return [];
  k.status = "missed";
  return missedTrainingEffects(c, k);
}

function missedTrainingEffects(c: CampaignState, k: Commitment): Effect[] {
  const count = typeof c.story.facts[MISSED_FACTS.count] === "number" ? (c.story.facts[MISSED_FACTS.count] as number) : 0;
  return [
    { type: "set_fact", id: MISSED_FACTS.recent, value: true },
    { type: "set_fact", id: MISSED_FACTS.count, value: count + 1 },
    { type: "set_fact", id: MISSED_FACTS.day, value: weekday(k.day) },
    { type: "learn", personId: "coach", factId: MISSED_FACTS.recent },
    { type: "queue_scene", sceneId: "week.missed_followup", onDay: k.day + 1 },
  ];
}

// ------------------------------------------------------------ completions

export interface Completion {
  effects: Effect[];
  ended: SlotEnd;
}

export function completeTraining(c: CampaignState, summary: SmallSidedSummary): Completion {
  const p = c.pending;
  if (!p || p.kind !== "training") throw new Error("no training pending");
  markAttended(c.schedule, p.commitmentId);
  const effects = recordTraining(c, summary);
  addFatigue(c, FATIGUE.training);
  c.pending = null;
  return { effects, ended: endSlot(c) };
}

export function completeMatch(c: CampaignState, report: MatchReport): Completion & { match: CompleteMatchResult } {
  const p = c.pending;
  if (!p || p.kind !== "match") throw new Error("no match pending");
  const k = c.schedule.commitments.find((x) => x.id === p.commitmentId);
  if (k && k.status === "scheduled") markAttended(c.schedule, p.commitmentId);
  const match = completeCampaignMatch(c, report);
  addFatigue(c, FATIGUE.match);
  c.pending = null;
  return { effects: match.ok && !match.duplicate ? match.effects : [], ended: endSlot(c), match };
}

export function completeCrossbar(c: CampaignState, summary: ChallengeSummary): Completion {
  const p = c.pending;
  if (!p || p.kind !== "crossbar") throw new Error("no crossbar pending");
  const effects = recordCrossbar(c, summary);
  c.story.facts[CROSSBAR_DAY_FACT] = c.day;
  c.pending = null;
  return { effects, ended: endSlot(c) };
}

/** One home-skill session (a stage or two of the assignment) fills the slot; the stage effects were already applied by the screen. */
export function completeHomeSkill(c: CampaignState, effects: Effect[]): Completion {
  const p = c.pending;
  if (!p || p.kind !== "home_skill") throw new Error("no home skill pending");
  addFatigue(c, FATIGUE.homeSkill);
  c.pending = null;
  touch(c);
  return { effects, ended: endSlot(c) };
}

/** Back out of an optional activity before it started: the slot is still free. Not for training or matches. */
export function cancelPending(c: CampaignState): boolean {
  const p = c.pending;
  if (!p || p.kind === "training" || p.kind === "match") return false;
  c.pending = null;
  touch(c);
  return true;
}

/** Abandon a pending activity without evidence (the player backed out). Training counts as missed. */
export function abandonPending(c: CampaignState): SlotEnd | null {
  const p = c.pending;
  if (!p) return null;
  if (p.kind === "training") {
    const effects = skipTraining(c, p.commitmentId);
    const ctx = storyContext(c);
    for (const e of effects) applyEffect(ctx, e);
  }
  c.pending = null;
  return endSlot(c);
}

// ------------------------------------------------------------ slot / day end

export interface SlotEnd {
  /** Day advanced (the slot was the last of the day). */
  advanced: DayAdvance | null;
  /** Mandatory commitments that went unattended when the day rolled over. */
  missed: Commitment[];
  /** A queued scene became current. */
  scene: string | null;
}

export function nextSlot(day: CampaignDay, slot: Slot): Slot | null {
  const slots = slotsFor(day);
  return slots[slots.indexOf(slot) + 1] ?? null;
}

/** Move to the next slot, or to tomorrow morning; then let a due story scene in. */
export function endSlot(c: CampaignState): SlotEnd {
  const next = nextSlot(c.day, c.slot);
  let advanced: DayAdvance | null = null;
  let missed: Commitment[] = [];
  if (next) {
    c.slot = next;
  } else {
    addFatigue(c, FATIGUE.sleep);
    advanced = advanceDays(c, 1);
    missed = advanced.missed;
    const ctx = storyContext(c);
    for (const k of missed) if (k.kind === "training" && k.mandatory) for (const e of missedTrainingEffects(c, k)) applyEffect(ctx, e);
    if (isTired(c)) applyEffect(ctx, { type: "queue_scene", sceneId: "week.tired", onDay: c.day });
  }
  touch(c);
  const entered = takeQueuedScene(c, campaignScenes(c.kind));
  return { advanced, missed, scene: entered?.scene.id ?? null };
}

export const MAX_SKIPPED_SLOTS = 40;

export interface SkipResult {
  /** Slots passed without an action (school was attended on the way). */
  slots: number;
  /** Why the skip stopped: a commitment that needs the player, a scene, or the safety cap. */
  stoppedAt: "commitment" | "scene" | "cap";
}

/**
 * Let free time pass until something needs the player: a training or match, a scene, or the cap.
 * School is attended on the way (it is mandatory and has no choice). Free slots pass without the
 * rest bonus — skipping is not resting — and sleep still lowers fatigue at each day end.
 */
export function skipToNextEvent(c: CampaignState): SkipResult {
  let slots = 0;
  while (slots < MAX_SKIPPED_SLOTS) {
    if (c.scene || c.pending) return { slots, stoppedAt: "scene" };
    const k = currentCommitment(c);
    if (k && k.kind !== "school") return { slots, stoppedAt: "commitment" };
    if (k) markAttended(c.schedule, k.id);
    endSlot(c);
    slots++;
  }
  return { slots, stoppedAt: "cap" };
}

/** The week at a glance for the hub: Monday..Sunday of the current week with each slot's commitment. */
export interface WeekDay {
  day: CampaignDay;
  weekday: Weekday;
  slots: { slot: Slot; commitment: Commitment | null; current: boolean; past: boolean }[];
}

export function weekView(c: CampaignState): WeekDay[] {
  const monday = mondayOf(c.day);
  const out: WeekDay[] = [];
  for (let d = monday; d < monday + 7; d++) {
    const slots = slotsFor(d);
    const cur = slotsFor(c.day).indexOf(c.slot);
    out.push({
      day: d,
      weekday: weekday(d),
      slots: slots.map((slot, i) => ({
        slot,
        commitment: commitmentsOn(c.schedule, d).find((k) => k.slot === slot) ?? null,
        current: d === c.day && slot === c.slot,
        past: d < c.day || (d === c.day && i < cur),
      })),
    });
  }
  return out;
}

/** True once the opening is over and the player is living the week (joined a club, no scene on screen). */
export const inRegularWeek = (c: CampaignState): boolean => !c.scene && playerClubId(c) !== null;
