import u11 from "../../content/rules/u11-9v9.json";
import type { Vec2 } from "./geometry";

export type ReviewStatus = "unverified" | "verified";

interface Sourced<T> {
  value: T;
  source: string;
}

/** Shape of a rules profile JSON file in content/rules. Values are proposals until verified. */
export interface RulesProfileFile {
  id: string;
  label: string;
  reviewStatus: ReviewStatus;
  note?: string;
  playersPerSide: number;
  field: { length: number; width: number; source: string };
  goal: { width: number; height: number; source: string };
  goalArea: { depth: number; width: number; source: string };
  penaltyArea: { depth: number; width: number; source: string };
  penaltySpotDistance: Sourced<number>;
  centerCircleRadius: Sourced<number>;
  buildOutLine: { enabled: boolean; source: string };
  offside: { enabled: boolean; source: string };
  headingAllowed: Sourced<boolean>;
  halves: number;
  halfLengthMinutes: Sourced<number>;
  ballSize: Sourced<number>;
  substitutions: { unlimited: boolean; reentryAllowed: boolean; source: string };
  goalkeeperPuntAllowed: Sourced<boolean>;
}

/** Flattened, engine-facing rules. Coordinates: x along length [0,length], y along width [0,width]. */
export interface Rules {
  id: string;
  label: string;
  reviewStatus: ReviewStatus;
  playersPerSide: number;
  length: number;
  width: number;
  goalWidth: number;
  goalAreaDepth: number;
  goalAreaWidth: number;
  penaltyAreaDepth: number;
  penaltyAreaWidth: number;
  penaltySpotDistance: number;
  centerCircleRadius: number;
  buildOutLine: boolean;
  offside: boolean;
  headingAllowed: boolean;
  halves: number;
  halfLengthSeconds: number;
  goalkeeperPuntAllowed: boolean;
}

export function rulesFromFile(f: RulesProfileFile): Rules {
  return {
    id: f.id,
    label: f.label,
    reviewStatus: f.reviewStatus,
    playersPerSide: f.playersPerSide,
    length: f.field.length,
    width: f.field.width,
    goalWidth: f.goal.width,
    goalAreaDepth: f.goalArea.depth,
    goalAreaWidth: f.goalArea.width,
    penaltyAreaDepth: f.penaltyArea.depth,
    penaltyAreaWidth: f.penaltyArea.width,
    penaltySpotDistance: f.penaltySpotDistance.value,
    centerCircleRadius: f.centerCircleRadius.value,
    buildOutLine: f.buildOutLine.enabled,
    offside: f.offside.enabled,
    headingAllowed: f.headingAllowed.value,
    halves: f.halves,
    halfLengthSeconds: f.halfLengthMinutes.value * 60,
    goalkeeperPuntAllowed: f.goalkeeperPuntAllowed.value,
  };
}

export const U11_9V9: Rules = rulesFromFile(u11 as RulesProfileFile);

export type Side = "home" | "away";

/** Direction of attack along x: home attacks +x, away attacks -x. */
export const attackDir = (side: Side): 1 | -1 => (side === "home" ? 1 : -1);

/** Goal line x-coordinate the given side attacks toward. */
export const attackingGoalX = (rules: Rules, side: Side): number => (side === "home" ? rules.length : 0);
export const defendingGoalX = (rules: Rules, side: Side): number => (side === "home" ? 0 : rules.length);

export function goalCenter(rules: Rules, goalLineX: number): Vec2 {
  return { x: goalLineX, y: rules.width / 2 };
}

export function goalPosts(rules: Rules, goalLineX: number): [Vec2, Vec2] {
  const half = rules.goalWidth / 2;
  return [
    { x: goalLineX, y: rules.width / 2 - half },
    { x: goalLineX, y: rules.width / 2 + half },
  ];
}

export function inPenaltyArea(rules: Rules, goalLineX: number, p: Vec2): boolean {
  const depthOk = goalLineX === 0 ? p.x <= rules.penaltyAreaDepth : p.x >= rules.length - rules.penaltyAreaDepth;
  return depthOk && Math.abs(p.y - rules.width / 2) <= rules.penaltyAreaWidth / 2;
}

export function inGoalArea(rules: Rules, goalLineX: number, p: Vec2): boolean {
  const depthOk = goalLineX === 0 ? p.x <= rules.goalAreaDepth : p.x >= rules.length - rules.goalAreaDepth;
  return depthOk && Math.abs(p.y - rules.width / 2) <= rules.goalAreaWidth / 2;
}

/** Build-out line: midway between penalty-area edge and halfway line (proposal, unverified). */
export function buildOutLineX(rules: Rules, goalLineX: number): number {
  const paEdge = goalLineX === 0 ? rules.penaltyAreaDepth : rules.length - rules.penaltyAreaDepth;
  return (paEdge + rules.length / 2) / 2;
}

export function onField(rules: Rules, p: Vec2): boolean {
  return p.x >= 0 && p.x <= rules.length && p.y >= 0 && p.y <= rules.width;
}
