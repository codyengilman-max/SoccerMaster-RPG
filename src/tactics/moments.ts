import type { Vec2 } from "../sim/geometry";
import type { MatchEvent, PlayerCommand, PlayerId, RoleId } from "../sim/types";
import type { CatalogEntry, Intent, MomentCategory, PhaseOfPlay } from "./catalog";
import type { FieldRead } from "./features";

export type DifficultyBand = "easy" | "medium" | "hard";

export interface Difficulty {
  band: DifficultyBand;
  /** Gap between the best and second-best option, normalised; low = unclear read. */
  clarity: number;
  pressure: number;
  alternatives: number;
  /** 0 (trivial) → 1 (very hard). */
  score: number;
}

/** One credible alternative offered to the user. `score` is internal and must not be shown before selection. */
export interface TacticalOption {
  id: string;
  actionId: string;
  label: string;
  intent: Intent;
  /** Executed by drawing (preview + commit on release) vs a contextual control. */
  drawn: boolean;
  command: PlayerCommand;
  /** Point a drawing is compared against (null for non-drawn intents). */
  anchor: Vec2 | null;
  score: number;
  feasibility: number;
  reasons: string[];
  receiver?: PlayerId;
}

export interface TacticalMoment {
  id: string;
  tick: number;
  timeMs: number;
  entryId: string;
  title: string;
  category: MomentCategory;
  phase: PhaseOfPlay;
  role: RoleId;
  playerId: PlayerId;
  cues: string[];
  options: TacticalOption[];
  difficulty: Difficulty;
  /** Stronger cinematic emphasis (spec §12): shots, last-defender situations, late-game swings. */
  major: boolean;
  /** How the player is involved: frozen at first controlled contact, later in a possession spell, or a positioning/defending decision. */
  involvement: Involvement;
  read: FieldRead;
}

export type Involvement = "first_touch" | "on_ball" | "off_ball";

export type DecisionBand = "strong" | "acceptable" | "weak";

export interface DecisionRecord {
  momentId: string;
  chosenOptionId: string | null;
  /** null when the window expired or the intent became unavailable before commit. */
  quality: number | null;
  band: DecisionBand | "timeout" | "intent_unavailable";
  bestOptionId: string;
  /** Field-condition explanations (never "you were wrong"): why the chosen and best options rated as they did. */
  explanation: string[];
  /** Tick at which the choice was committed; grading used the field state at this tick. */
  commitTick: number;
}

export type ExecutionBand = "clean" | "loose" | "poor";

/** Who chose the action the character executed: the user's answer, or the engine after a timeout / unavailable intent. */
export type Actor = "user" | "engine";

export interface ExecutionRecord {
  momentId: string;
  /** Whose choice the character executed; the grade describes the character's execution either way. */
  actor: Actor;
  /** 0..1 how well the player performed the action given attributes, pressure and fatigue. */
  quality: number;
  band: ExecutionBand;
  pressureAtCommit: number;
  fatigueAtCommit: number;
}

export type OutcomeResult = "success" | "partial" | "failure" | "neutral";

export interface OutcomeRecord {
  momentId: string;
  result: OutcomeResult;
  summary: string;
  eventIds: string[];
  resolvedTick: number;
}

export interface MomentRecord {
  moment: TacticalMoment;
  decision: DecisionRecord;
  /** The action the character actually carried out (user-selected or engine-selected); null when play stopped first. */
  acted: CommittedIntent | null;
  execution: ExecutionRecord | null;
  outcome: OutcomeRecord | null;
}

export interface CommittedIntent {
  momentId: string;
  actor: Actor;
  /** Displayed option whose command this is; null when the engine chose something that was not on offer. */
  optionId: string | null;
  label: string;
  command: PlayerCommand;
  commitTick: number;
}

export type MomentEventFilter = (e: MatchEvent) => boolean;

export type EntryLookup = (id: string) => CatalogEntry | undefined;
