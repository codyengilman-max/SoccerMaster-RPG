import type { Vec2 } from "./geometry";
import type { Rules, Side } from "./rules";

/** Shirt/role numbers used in the 1-3-2-3 (spec §3). */
export type RoleNumber = 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9 | 11;
export const ROLE_NUMBERS: readonly RoleNumber[] = [1, 2, 3, 4, 6, 8, 7, 9, 11];

export type RoleId = "GK" | "RB" | "LB" | "CB" | "DM" | "CM" | "RW" | "ST" | "LW";

export const ROLE_BY_NUMBER: Record<RoleNumber, RoleId> = {
  1: "GK",
  2: "RB",
  3: "LB",
  4: "CB",
  6: "DM",
  8: "CM",
  7: "RW",
  9: "ST",
  11: "LW",
};

/** 0–100 scales. */
export interface Attributes {
  pace: number;
  acceleration: number;
  passing: number;
  firstTouch: number;
  dribbling: number;
  shooting: number;
  tackling: number;
  positioning: number;
  awareness: number;
  stamina: number;
  strength: number;
  goalkeeping: number;
}

export type PlayerId = string;

export interface PlayerState {
  id: PlayerId;
  side: Side;
  role: RoleNumber;
  name: string;
  attributes: Attributes;
  pos: Vec2;
  vel: Vec2;
  /** 0 = fresh, 1 = exhausted. */
  fatigue: number;
  /** Where the player is currently trying to go. */
  moveTarget: Vec2;
  /** Ticks until this player may touch the ball again (after kicking it). */
  touchCooldown: number;
  /** Ticks remaining in a recovery state after a failed tackle/lost duel. */
  stunned: number;
  /** While carrying: tick until which the current carry/hold intention is committed (re-decided early only under pressure). */
  commitUntilTick: number;
}

export type BallStatus = "loose" | "controlled" | "dead";

export interface BallState {
  pos: Vec2;
  vel: Vec2;
  status: BallStatus;
  /** Player id when status === "controlled". */
  owner: PlayerId | null;
  lastTouch: PlayerId | null;
  lastTouchSide: Side | null;
  /** Set when a pass is played: intended receiver id if any. */
  passTarget: PlayerId | null;
  passFrom: PlayerId | null;
}

export type Phase =
  | { kind: "kickoff"; side: Side }
  | { kind: "open_play" }
  | { kind: "goal_kick"; side: Side }
  | { kind: "corner"; side: Side; at: Vec2 }
  | { kind: "throw_in"; side: Side; at: Vec2 }
  | { kind: "free_kick"; side: Side; at: Vec2; reason: "offside" | "foul" | "build_out" }
  | { kind: "half_time" }
  | { kind: "full_time" };

export type PhaseKind = Phase["kind"];

export interface Clock {
  tick: number;
  /** Simulated milliseconds since match start (excluding stoppages; simple running clock). */
  timeMs: number;
  half: number;
  /** Seconds elapsed in the current half. */
  halfTimeS: number;
}

export type MatchEvent =
  | { id: string; tick: number; type: "kickoff"; side: Side }
  | { id: string; tick: number; type: "pass"; from: PlayerId; to: PlayerId | null; target: Vec2; side: Side }
  | { id: string; tick: number; type: "receive"; player: PlayerId; from: PlayerId | null; clean: boolean }
  | { id: string; tick: number; type: "carry"; player: PlayerId; from: Vec2; to: Vec2 }
  | { id: string; tick: number; type: "shot"; player: PlayerId; target: Vec2; onTarget: boolean; side: Side }
  | { id: string; tick: number; type: "save"; keeper: PlayerId; shooter: PlayerId }
  | { id: string; tick: number; type: "goal"; scorer: PlayerId; side: Side; assist: PlayerId | null }
  | { id: string; tick: number; type: "interception"; player: PlayerId; from: PlayerId | null }
  | { id: string; tick: number; type: "recovery"; player: PlayerId }
  | { id: string; tick: number; type: "tackle"; player: PlayerId; victim: PlayerId; won: boolean }
  | { id: string; tick: number; type: "possession_change"; to: Side; reason: string }
  | { id: string; tick: number; type: "out_of_play"; restart: PhaseKind; side: Side }
  | { id: string; tick: number; type: "offside"; player: PlayerId; side: Side }
  | { id: string; tick: number; type: "restart"; restart: PhaseKind; side: Side; taker: PlayerId }
  | { id: string; tick: number; type: "half_time" }
  | { id: string; tick: number; type: "full_time"; home: number; away: number };

export type MatchEventType = MatchEvent["type"];

export interface TeamInfo {
  side: Side;
  name: string;
  shortName: string;
}

/** External instruction for one player for the next decision (used by the tactical layer for the locked role). */
export type PlayerCommand =
  | { type: "pass"; target: Vec2; receiver?: PlayerId }
  | { type: "carry"; direction: Vec2; distance: number }
  | { type: "shoot"; target: Vec2 }
  | { type: "first_touch"; direction: Vec2 }
  | { type: "move"; target: Vec2 }
  | { type: "hold" }
  | { type: "press"; target: PlayerId }
  | { type: "screen"; from: PlayerId; to: PlayerId };

export interface MatchState {
  matchId: string;
  rules: Rules;
  seed: number;
  rngState: number;
  home: TeamInfo;
  away: TeamInfo;
  players: PlayerState[];
  ball: BallState;
  phase: Phase;
  /** Ticks remaining before a dead-ball phase resumes play. */
  restartTimer: number;
  possession: Side | null;
  score: { home: number; away: number };
  clock: Clock;
  events: MatchEvent[];
  /** Positions of the attacking team at the moment of the last pass, used for offside on receipt. */
  offsideSnapshot: { side: Side; offsidePlayers: PlayerId[] } | null;
  /** The user's locked role (spec §3). null for headless AI-vs-AI runs. */
  controlled: { side: Side; playerId: PlayerId } | null;
  /** Pending commands by player id; consumed at the player's next decision. */
  commands: Record<PlayerId, PlayerCommand | undefined>;
  /** Ticks since each player last made an AI decision. */
  decisionTimers: Record<PlayerId, number>;
  eventSeq: number;
  /** Shot in flight awaiting keeper/goal-line resolution. */
  pendingShot: { shooter: PlayerId; side: Side; onTarget: boolean } | null;
}

export const TICK_MS = 50;
export const TICK_S = TICK_MS / 1000;
