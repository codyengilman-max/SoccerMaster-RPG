import type { ExitReason, GameLogic, MinigameConfig, MinigamePhase, MinigameResult } from "./contract";

/**
 * The shared minigame state machine (§6): start → active ⇄ paused → resolved | abandoned. Every
 * transition is logged as an event, inputs are logged for deterministic replay, and the whole
 * session is plain JSON so a save between rounds restores it exactly. Real time never enters
 * game logic except through `tick(dtMs)`.
 */

export type SessionEventType = "started" | "paused" | "resumed" | "input" | "checkpoint" | "resolved" | "abandoned";

export interface SessionEvent {
  type: SessionEventType;
  /** Game-time milliseconds. */
  atMs: number;
  detail?: string;
}

export interface MinigameSession<S, I> {
  phase: MinigamePhase;
  config: MinigameConfig;
  game: S;
  elapsedMs: number;
  startedAt: number;
  resolvedAt: number | null;
  result: MinigameResult | null;
  events: SessionEvent[];
  /** Every input with its game time, for replay and audit. */
  inputs: { atMs: number; input: I }[];
  /** Last checkpoint label the game reported, so a round boundary logs once. */
  lastCheckpoint: string | null;
}

export type Transition = { ok: true } | { ok: false; reason: "wrong_phase" };

const wrong: Transition = { ok: false, reason: "wrong_phase" };

export function createSession<S, I>(logic: GameLogic<S, I>, config: MinigameConfig, now = 0): MinigameSession<S, I> {
  return {
    phase: "start",
    config,
    game: logic.create(config),
    elapsedMs: 0,
    startedAt: now,
    resolvedAt: null,
    result: null,
    events: [],
    inputs: [],
    lastCheckpoint: null,
  };
}

export function start<S, I>(s: MinigameSession<S, I>): Transition {
  if (s.phase !== "start") return wrong;
  s.phase = "active";
  s.events.push({ type: "started", atMs: 0 });
  return { ok: true };
}

export function pause<S, I>(s: MinigameSession<S, I>): Transition {
  if (s.phase !== "active") return wrong;
  s.phase = "paused";
  s.events.push({ type: "paused", atMs: s.elapsedMs });
  return { ok: true };
}

export function resume<S, I>(s: MinigameSession<S, I>): Transition {
  if (s.phase !== "paused") return wrong;
  s.phase = "active";
  s.events.push({ type: "resumed", atMs: s.elapsedMs });
  return { ok: true };
}

/** Player input; ignored (and reported) unless the game is active. */
export function input<S, I>(s: MinigameSession<S, I>, logic: GameLogic<S, I>, i: I, now = 0): Transition {
  if (s.phase !== "active") return wrong;
  s.inputs.push({ atMs: s.elapsedMs, input: i });
  s.events.push({ type: "input", atMs: s.elapsedMs });
  logic.apply(s.game, s.config, i);
  settle(s, logic, now);
  return { ok: true };
}

/**
 * Advance game time. Resolves the session when the game ends or the time limit passes; only
 * active sessions move.
 */
export function tick<S, I>(s: MinigameSession<S, I>, logic: GameLogic<S, I>, dtMs: number, now = 0): Transition {
  if (s.phase !== "active") return wrong;
  const step = Math.max(0, dtMs);
  logic.tick(s.game, s.config, step);
  s.elapsedMs += step;
  settle(s, logic, now);
  return { ok: true };
}

/** The player leaves on purpose. Allowed while active or paused; the result records why. */
export function exit<S, I>(s: MinigameSession<S, I>, logic: GameLogic<S, I>, now = 0): Transition {
  if (s.phase !== "active" && s.phase !== "paused") return wrong;
  finish(s, logic, "voluntary_exit", now);
  return { ok: true };
}

function settle<S, I>(s: MinigameSession<S, I>, logic: GameLogic<S, I>, now: number): void {
  if (s.phase !== "active") return;
  const cp = logic.checkpoint(s.game);
  if (cp !== null && cp !== s.lastCheckpoint) {
    s.lastCheckpoint = cp;
    s.events.push({ type: "checkpoint", atMs: s.elapsedMs, detail: cp });
  }
  if (s.elapsedMs >= logic.timeLimitMs(s.config)) finish(s, logic, "timeout", now);
  else if (logic.done(s.game)) finish(s, logic, "completed", now);
}

function finish<S, I>(s: MinigameSession<S, I>, logic: GameLogic<S, I>, exitReason: ExitReason, now: number): void {
  const r = logic.resolve(s.game, s.config, exitReason, s.elapsedMs);
  s.phase = exitReason === "voluntary_exit" ? "abandoned" : "resolved";
  s.resolvedAt = now;
  s.result = {
    gameId: s.config.gameId,
    episodeId: s.config.episodeId,
    ageBand: s.config.ageBand,
    locationId: s.config.locationId,
    participantIds: [...s.config.participantIds],
    ruleVariant: s.config.ruleVariant,
    verifiedActions: r.verifiedActions,
    outcomeTier: r.outcomeTier,
    witnessedBehavior: r.witnessedBehavior,
    relationshipEffects: r.relationshipEffects,
    startedAt: s.startedAt,
    resolvedAt: now,
    exitReason,
    seed: s.config.seed,
    day: s.config.day,
    summary: r.summary,
  };
  s.events.push({ type: s.phase === "abandoned" ? "abandoned" : "resolved", atMs: s.elapsedMs, detail: exitReason });
}

/** Can the session be saved right now? Only at a round boundary or while paused/finished. */
export function atCheckpoint<S, I>(s: MinigameSession<S, I>, logic: GameLogic<S, I>): boolean {
  return s.phase !== "active" || logic.checkpoint(s.game) !== null;
}

/** Deep-copied, JSON-safe snapshot of the whole session. */
export function snapshot<S, I>(s: MinigameSession<S, I>): MinigameSession<S, I> {
  return JSON.parse(JSON.stringify(s)) as MinigameSession<S, I>;
}

const PHASES: readonly MinigamePhase[] = ["start", "active", "paused", "resolved", "abandoned"];

/** Restore a snapshot. A session saved while active resumes paused so the player is never dropped mid-clock. */
export function restore<S, I>(raw: unknown): MinigameSession<S, I> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<MinigameSession<S, I>>;
  if (!s.config || !PHASES.includes(s.phase as MinigamePhase) || typeof s.elapsedMs !== "number" || s.game === undefined) return null;
  if (!Array.isArray(s.events) || !Array.isArray(s.inputs)) return null;
  const out = JSON.parse(JSON.stringify(s)) as MinigameSession<S, I>;
  if (out.phase === "active") {
    out.phase = "paused";
    out.events.push({ type: "paused", atMs: out.elapsedMs, detail: "restored" });
  }
  return out;
}

/**
 * Replay a session from its config and input log with a fixed tick, ignoring wall-clock stamps.
 * Used by tests to prove determinism: same seed + same inputs ⇒ same result.
 */
export function replay<S, I>(logic: GameLogic<S, I>, config: MinigameConfig, inputs: readonly { atMs: number; input: I }[], stepMs = 50, untilMs?: number): MinigameSession<S, I> {
  const s = createSession(logic, config);
  start(s);
  let i = 0;
  const limit = untilMs ?? logic.timeLimitMs(config) + stepMs;
  while (s.phase === "active" && s.elapsedMs < limit) {
    while (i < inputs.length && inputs[i]!.atMs <= s.elapsedMs && s.phase === "active") {
      input(s, logic, inputs[i]!.input);
      i++;
    }
    if (s.phase !== "active") break;
    tick(s, logic, stepMs);
  }
  return s;
}
