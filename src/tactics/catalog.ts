import type { RoleId } from "../sim/types";
import { FEATURE_NAMES, type FeatureName, type FieldRead } from "./features";

/**
 * Tactical catalog schema (spec §16). Content lives in `content/catalog/*.json` and is validated by
 * `loadCatalog`; the engine never contains situation-specific code. Every entry is provisional until
 * a coach reviews it (`review.status`).
 */

export type MomentCategory = "on_ball" | "off_ball" | "defending" | "transition";

export type PhaseOfPlay = "build_up" | "progression" | "final_third" | "defending" | "transition" | "restart";

export type ReviewStatus = "provisional" | "reviewed" | "approved";

/** Every executable intention the catalog may offer. Instantiated into engine commands by `intents.ts`. */
export type Intent =
  | "attack_space"
  | "draw_defender"
  | "through_gap"
  | "switch_play"
  | "recycle"
  | "shoot"
  | "hold_ball"
  | "first_touch_forward"
  | "first_touch_safe"
  | "run_behind"
  | "overlap"
  | "support_underneath"
  | "hold_width"
  | "hold_position"
  | "press"
  | "delay"
  | "drop"
  | "cover"
  | "track_runner"
  | "screen_lane"
  | "communicate"
  | "keeper_sweep"
  | "keeper_hold_line"
  | "keeper_distribute_short"
  | "keeper_distribute_long";

export const INTENTS: readonly Intent[] = [
  "attack_space",
  "draw_defender",
  "through_gap",
  "switch_play",
  "recycle",
  "shoot",
  "hold_ball",
  "first_touch_forward",
  "first_touch_safe",
  "run_behind",
  "overlap",
  "support_underneath",
  "hold_width",
  "hold_position",
  "press",
  "delay",
  "drop",
  "cover",
  "track_runner",
  "screen_lane",
  "communicate",
  "keeper_sweep",
  "keeper_hold_line",
  "keeper_distribute_short",
  "keeper_distribute_long",
];

/** Intents that are executed by drawing (spec §11); the rest use a contextual control. */
export const DRAWN_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  "attack_space",
  "draw_defender",
  "through_gap",
  "switch_play",
  "recycle",
  "shoot",
  "first_touch_forward",
  "first_touch_safe",
  "run_behind",
  "overlap",
  "support_underneath",
  "hold_width",
  "keeper_distribute_short",
  "keeper_distribute_long",
]);

export type Op = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface Condition {
  f: FeatureName;
  op: Op;
  v: number;
}

export interface Trigger {
  all: Condition[];
  any?: Condition[];
}

/** One scoring rule: when every condition holds, add `add` and record `why` as feedback. */
export interface Criterion {
  when?: Condition[];
  add: number;
  why: string;
}

export interface CatalogAction {
  id: string;
  label: string;
  intent: Intent;
  base: number;
  eval: Criterion[];
}

export interface TestState {
  label: string;
  /** Partial field read the trigger must accept (positive) or reject (negative). */
  read: Partial<FieldRead>;
}

export interface CatalogEntry {
  id: string;
  role: RoleId;
  /** Id of the entry this one mirrors across the pitch (left/right), if any. */
  mirrorOf?: string;
  category: MomentCategory;
  phase: PhaseOfPlay;
  title: string;
  trigger: Trigger;
  cues: string[];
  actions: CatalogAction[];
  mistakes: string[];
  difficultyFactors: string[];
  restrictions: {
    ageGroups: string[];
    requiresOffside?: boolean;
  };
  continuation: string;
  tests: { positive: TestState[]; negative: TestState[] };
  review: { status: ReviewStatus; note?: string };
}

export interface CatalogFile {
  id: string;
  version: number;
  reviewStatus: ReviewStatus;
  entries: CatalogEntry[];
}

export interface Catalog {
  id: string;
  version: number;
  reviewStatus: ReviewStatus;
  entries: readonly CatalogEntry[];
  byRole: ReadonlyMap<RoleId, readonly CatalogEntry[]>;
}

const ROLE_IDS: readonly RoleId[] = ["GK", "RB", "LB", "CB", "DM", "CM", "RW", "ST", "LW"];
const CATEGORIES: readonly MomentCategory[] = ["on_ball", "off_ball", "defending", "transition"];
const OPS: readonly Op[] = ["<", "<=", ">", ">=", "==", "!="];
const featureSet = new Set<string>(FEATURE_NAMES);
const intentSet = new Set<string>(INTENTS);

export function conditionHolds(read: FieldRead, c: Condition): boolean {
  const x = read[c.f];
  switch (c.op) {
    case "<":
      return x < c.v;
    case "<=":
      return x <= c.v;
    case ">":
      return x > c.v;
    case ">=":
      return x >= c.v;
    case "==":
      return x === c.v;
    case "!=":
      return x !== c.v;
  }
}

export function allHold(read: FieldRead, cs: readonly Condition[] | undefined): boolean {
  return !cs || cs.every((c) => conditionHolds(read, c));
}

export function triggerFires(read: FieldRead, t: Trigger): boolean {
  if (!allHold(read, t.all)) return false;
  if (t.any && t.any.length > 0 && !t.any.some((c) => conditionHolds(read, c))) return false;
  return true;
}

function checkConditions(cs: readonly Condition[] | undefined, where: string, errors: string[]): void {
  if (!cs) return;
  for (const c of cs) {
    if (!featureSet.has(c.f)) errors.push(`${where}: unknown feature "${c.f}"`);
    if (!OPS.includes(c.op)) errors.push(`${where}: unknown op "${c.op}"`);
    if (typeof c.v !== "number" || Number.isNaN(c.v)) errors.push(`${where}: value must be a number`);
  }
}

/** Validate a catalog file: schema, unique ids, feature names, mirrors, and that each entry's own test states behave. */
export function validateCatalog(file: CatalogFile): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of file.entries) {
    const w = `entry ${e.id}`;
    if (ids.has(e.id)) errors.push(`${w}: duplicate id`);
    ids.add(e.id);
    if (!ROLE_IDS.includes(e.role)) errors.push(`${w}: unknown role ${e.role}`);
    if (!CATEGORIES.includes(e.category)) errors.push(`${w}: unknown category ${e.category}`);
    checkConditions(e.trigger.all, `${w} trigger.all`, errors);
    checkConditions(e.trigger.any, `${w} trigger.any`, errors);
    if (e.actions.length < 2) errors.push(`${w}: needs at least two plausible actions`);
    const actionIds = new Set<string>();
    for (const a of e.actions) {
      if (actionIds.has(a.id)) errors.push(`${w}: duplicate action id ${a.id}`);
      actionIds.add(a.id);
      if (!intentSet.has(a.intent)) errors.push(`${w} action ${a.id}: unknown intent ${a.intent}`);
      for (const c of a.eval) checkConditions(c.when, `${w} action ${a.id}`, errors);
    }
    if (e.cues.length === 0) errors.push(`${w}: scanning cues required`);
    if (e.tests.positive.length === 0 || e.tests.negative.length === 0) errors.push(`${w}: positive and negative test states required`);
    for (const t of e.tests.positive) {
      const read = withDefaults(t.read);
      if (!triggerFires(read, e.trigger)) errors.push(`${w}: positive test "${t.label}" does not fire the trigger`);
    }
    for (const t of e.tests.negative) {
      const read = withDefaults(t.read);
      if (triggerFires(read, e.trigger)) errors.push(`${w}: negative test "${t.label}" fires the trigger`);
    }
  }
  for (const e of file.entries) {
    if (e.mirrorOf !== undefined) {
      const m = file.entries.find((x) => x.id === e.mirrorOf);
      if (!m) errors.push(`entry ${e.id}: mirrorOf ${e.mirrorOf} not found`);
      else if (m.category !== e.category) errors.push(`entry ${e.id}: mirror category differs from ${m.id}`);
    }
  }
  return errors;
}

/** A neutral field read used to complete partial test states. */
export const NEUTRAL_READ: FieldRead = {
  hasBall: 0,
  receiving: 0,
  ourPossession: 0,
  theirPossession: 0,
  looseBall: 0,
  pressure: 0,
  nearestOppDist: 15,
  spaceAhead: 0.5,
  spaceFarSide: 0.5,
  spaceNearSide: 0.5,
  progress: 0.5,
  ballProgress: 0.5,
  distToGoal: 35,
  distToBall: 20,
  shotWindow: 0,
  openLanes: 0,
  progressiveLanes: 0,
  bestPassScore: 0,
  bestCarryScore: 0,
  bestShotScore: 0,
  bestSwitchScore: 0,
  spaceBehindLine: 15,
  onsideForRun: 1,
  teammateRunAhead: 0,
  ballOnMyFlank: 0,
  carrierDist: 999,
  firstDefender: 0,
  secondDefender: 0,
  teammatePressing: 0,
  oppRunnerNear: 0,
  carrierDistToOurGoal: 999,
  secondsSinceTurnover: 999,
  ballInOurBox: 0,
  ballInTheirBox: 0,
  keeperCanSweep: 0,
  scoreDiff: 0,
  minute: 10,
  carrierPressure: 0,
  teammateCarrierDist: 999,
};

export function withDefaults(partial: Partial<FieldRead>): FieldRead {
  return { ...NEUTRAL_READ, ...partial };
}

export function loadCatalog(file: CatalogFile): Catalog {
  const errors = validateCatalog(file);
  if (errors.length > 0) throw new Error(`Invalid tactical catalog ${file.id}:\n${errors.join("\n")}`);
  const byRole = new Map<RoleId, CatalogEntry[]>();
  for (const e of file.entries) {
    const list = byRole.get(e.role) ?? [];
    list.push(e);
    byRole.set(e.role, list);
  }
  return { id: file.id, version: file.version, reviewStatus: file.reviewStatus, entries: file.entries, byRole };
}
