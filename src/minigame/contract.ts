import type { CampaignDay } from "../calendar/date";
import type { LocationId } from "../story/scenes";
import type { RelationDimension } from "../story/memory";

/**
 * Shared minigame contract (Story Engine v2 §6–§7). Every school or recess game — soccer or
 * academic — is launched by a story scene, runs through the same state machine and hands one
 * structured, verified result back to the episode. The result is the *only* thing the story may
 * react to; nothing here can reach the soccer engine (§4: official-match truth belongs to it).
 */

export const MINIGAME_IDS = [
  "world_cup_knockout",
  "two_v_two_court",
  "crossbar_challenge",
  "keep_away_circle",
  "next_goal_wins",
  "group_presentation",
  "locker_dash",
  "study_session",
] as const;
export type MinigameId = (typeof MINIGAME_IDS)[number];

export const MINIGAME_TITLE: Record<MinigameId, string> = {
  world_cup_knockout: "World Cup Knockout",
  two_v_two_court: "Two-versus-Two Court",
  crossbar_challenge: "Crossbar Challenge",
  keep_away_circle: "Keep-Away Circle",
  next_goal_wins: "Next Goal Wins",
  group_presentation: "Group Presentation",
  locker_dash: "Locker Dash",
  study_session: "Study Session",
};

export type AgeBand = "U11-U12" | "U13-U14" | "U15-U16";

/** Lifecycle phases every game shares (§6). */
export type MinigamePhase = "start" | "active" | "paused" | "resolved" | "abandoned";

/** Graded outcome of a game that ran to a verdict. */
export type OutcomeTier = "success" | "partial" | "failure";

/** Why the session ended. `completed` = the game reached its own end. */
export type ExitReason = "completed" | "timeout" | "voluntary_exit";

/** The branch a story scene continues on; one per required path (§6). */
export type Continuation = OutcomeTier | "timeout" | "voluntary_exit";
export const CONTINUATIONS: readonly Continuation[] = ["success", "partial", "failure", "timeout", "voluntary_exit"];

export function continuationOf(r: { outcomeTier: OutcomeTier; exitReason: ExitReason }): Continuation {
  return r.exitReason === "completed" ? r.outcomeTier : r.exitReason;
}

export type ActionQuality = "strong" | "acceptable" | "weak";
export type Scalar = string | number | boolean;

/** One thing the player (or a participant) verifiably did, in game time. */
export interface VerifiedAction {
  atMs: number;
  kind: string;
  actorId: string;
  quality?: ActionQuality;
  detail?: Record<string, Scalar>;
}

/** Behaviour other participants saw — what they may remember and talk about later (§5). */
export interface WitnessedBehavior {
  tag: string;
  actorId: string;
  witnessIds: string[];
  atMs: number;
}

/** Default relationship movement proposed by the game; authored continuations add their own. */
export interface RelationshipEffect {
  personId: string;
  dimension: RelationDimension;
  delta: number;
  reason: string;
}

/** Game-specific accessibility settings (§6): every game reads these, no game may ignore them. */
export interface AccessibilitySettings {
  reducedMotion: boolean;
  highContrast: boolean;
  /** Multiplies every player-facing timer (1 = authored, 1.5 / 2 = slower). */
  timerScale: 1 | 1.5 | 2;
  /** Game-specific help: wider timing windows, highlighted correct order, etc. */
  assist: boolean;
}

export const DEFAULT_ACCESSIBILITY: AccessibilitySettings = { reducedMotion: false, highContrast: false, timerScale: 1, assist: false };

export interface MinigameConfig {
  gameId: MinigameId;
  episodeId: string;
  ageBand: AgeBand;
  locationId: LocationId;
  /** Player first, then the others in the scene. */
  participantIds: string[];
  ruleVariant: string;
  seed: number;
  day: CampaignDay;
  accessibility: AccessibilitySettings;
  /** Skill 0..1 per non-player participant, from the roster (never from match attributes). */
  skills: Record<string, number>;
}

export interface MinigameResult {
  gameId: MinigameId;
  episodeId: string;
  ageBand: AgeBand;
  locationId: LocationId;
  participantIds: string[];
  ruleVariant: string;
  verifiedActions: VerifiedAction[];
  outcomeTier: OutcomeTier;
  witnessedBehavior: WitnessedBehavior[];
  relationshipEffects: RelationshipEffect[];
  /** Epoch milliseconds (real clock). */
  startedAt: number;
  resolvedAt: number | null;
  exitReason: ExitReason;
  /** Deterministic replay key: seed + variant + the inputs reproduce the game. */
  seed: number;
  day: CampaignDay;
  /** Headline numbers for dialogue (place, strikes, grades); copied into story facts as `mg_<game>_<key>`. */
  summary: Record<string, Scalar>;
}

/** What a game returns when it resolves; the machine fills in the rest of the result. */
export interface Resolution {
  outcomeTier: OutcomeTier;
  verifiedActions: VerifiedAction[];
  witnessedBehavior: WitnessedBehavior[];
  relationshipEffects: RelationshipEffect[];
  summary: Record<string, Scalar>;
}

/**
 * The per-game logic the shared machine drives. `S` is plain JSON (saves snapshot it between
 * rounds), `I` the game's input union. Time only moves through `tick`, so a session replays
 * exactly from its seed and input log.
 */
export interface GameLogic<S, I> {
  id: MinigameId;
  create(cfg: MinigameConfig): S;
  tick(s: S, cfg: MinigameConfig, dtMs: number): void;
  apply(s: S, cfg: MinigameConfig, input: I): void;
  /** The game reached its own end. */
  done(s: S): boolean;
  /** A stable label for the current round boundary, or null while a round is in play. */
  checkpoint(s: S): string | null;
  /** Whole-session limit; the machine resolves with `timeout` when it passes. */
  timeLimitMs(cfg: MinigameConfig): number;
  resolve(s: S, cfg: MinigameConfig, exit: ExitReason, elapsedMs: number): Resolution;
}

const REQUIRED: (keyof MinigameResult)[] = [
  "gameId", "episodeId", "ageBand", "locationId", "participantIds", "ruleVariant", "verifiedActions",
  "outcomeTier", "witnessedBehavior", "relationshipEffects", "startedAt", "resolvedAt", "exitReason", "seed", "day", "summary",
];

const TIERS: readonly OutcomeTier[] = ["success", "partial", "failure"];
const EXITS: readonly ExitReason[] = ["completed", "timeout", "voluntary_exit"];

/** Structural validation for anything claiming to be a result (a save, a ledger entry). */
export function validateResult(x: unknown): x is MinigameResult {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  for (const k of REQUIRED) if (!(k in r)) return false;
  if (!(MINIGAME_IDS as readonly string[]).includes(r.gameId as string)) return false;
  if (typeof r.episodeId !== "string" || typeof r.ruleVariant !== "string" || typeof r.locationId !== "string") return false;
  if (!Array.isArray(r.participantIds) || r.participantIds.length === 0 || !r.participantIds.every((p) => typeof p === "string")) return false;
  if (!Array.isArray(r.verifiedActions) || !Array.isArray(r.witnessedBehavior) || !Array.isArray(r.relationshipEffects)) return false;
  if (!TIERS.includes(r.outcomeTier as OutcomeTier) || !EXITS.includes(r.exitReason as ExitReason)) return false;
  if (typeof r.startedAt !== "number" || typeof r.seed !== "number" || typeof r.day !== "number") return false;
  if (r.resolvedAt !== null && typeof r.resolvedAt !== "number") return false;
  if (typeof r.summary !== "object" || r.summary === null) return false;
  return true;
}
