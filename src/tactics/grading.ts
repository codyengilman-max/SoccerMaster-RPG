import { clamp } from "../sim/geometry";
import { opponents, playerById, pressureAt } from "../sim/perception";
import type { MatchEvent, MatchState, PlayerState } from "../sim/types";
import type { Catalog, CatalogEntry } from "./catalog";
import { readField } from "./features";
import type { CommittedIntent, DecisionRecord, ExecutionRecord, OutcomeRecord, OutcomeResult, TacticalMoment, TacticalOption } from "./moments";
import { buildOptions } from "./recognition";

/**
 * The three layers the spec (§13) insists stay separate:
 *  - decision quality: the chosen intention relative to the alternatives, judged on the field state
 *    at commit time (not at the moment start);
 *  - execution: how well the character performed the action (attributes + pressure + fatigue + the
 *    engine's own kick error); the user never executes, only chooses;
 *  - outcome: what actually happened in the simulation afterwards.
 */

export function entryOf(catalog: Catalog, moment: TacticalMoment): CatalogEntry {
  const e = catalog.entries.find((x) => x.id === moment.entryId);
  if (!e) throw new Error(`catalog entry ${moment.entryId} missing`);
  return e;
}

/** Re-score the moment's options against the current state (used at commit so late movement counts). */
export function rescoreAtCommit(state: MatchState, catalog: Catalog, moment: TacticalMoment): TacticalOption[] {
  const p = playerById(state, moment.playerId);
  if (!p) return moment.options;
  const read = readField(state, p);
  const fresh = buildOptions(state, p, entryOf(catalog, moment), read, moment.id);
  // keep original option identity; options that are no longer instantiable keep their opening score
  return moment.options.map((o) => fresh.find((f) => f.actionId === o.actionId) ?? o);
}

/**
 * The reasons a player is told: the catalog's field-condition sentences, plus the engine's telemetry
 * ("lane margin 0.32 s", "space 0.51 ahead", "shot window 12°") translated into what a coach would
 * point at on the field. The raw numbers stay on the option for review tools only.
 */
export function coachReasons(reasons: readonly string[]): string {
  const out: string[] = [];
  for (const r of reasons.flatMap((s) => s.split("; "))) {
    const plain = fieldLanguage(r);
    if (plain && !out.includes(plain)) out.push(plain);
  }
  return out.length ? out.join("; ") : "no field condition stood out either way";
}

/** One engine reason → what a coach would say about it, or null when it adds nothing a player can see. */
function fieldLanguage(reason: string): string | null {
  const num = (re: RegExp): number | null => {
    const m = re.exec(reason);
    return m ? Number(m[1]) : null;
  };
  const space = num(/^space (\d+\.\d+) ahead$/);
  if (space !== null) return space > 0.6 ? "plenty of grass in front of you" : space > 0.35 ? "some room ahead" : null;
  const endPressure = num(/^pressure (\d+\.\d+) at end$/);
  if (endPressure !== null) return endPressure > 0.6 ? "a defender is waiting where the carry ends" : endPressure < 0.15 ? "nobody at the end of the run" : null;
  const lane = num(/^lane margin (\d+\.\d+) s$/);
  if (lane !== null) return lane > 0.3 ? "the passing lane is clearly open" : lane < 0.12 ? "the lane is tight" : null;
  const receiver = num(/^receiver space (\d+\.\d+)$/);
  if (receiver !== null) return receiver > 0.6 ? "the receiver has time" : receiver < 0.3 ? "the receiver is marked" : null;
  const window = num(/^shot window (\d+)°$/);
  if (window !== null) return window >= 25 ? "the goal is open" : window >= 12 ? "a narrow sight of goal" : "the shot is blocked";
  const dist = num(/^(\d+) m from goal$/);
  if (dist !== null) return dist <= 14 ? "close enough to score" : dist >= 22 ? "a long way out" : null;
  if (/\d\.\d|\d°/.test(reason) || reason === "to feet" || reason === "into space ahead") return null;
  return reason;
}

export function gradeDecision(state: MatchState, catalog: Catalog, moment: TacticalMoment, chosenOptionId: string | null): DecisionRecord {
  const scored = rescoreAtCommit(state, catalog, moment);
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (!best || !worst) throw new Error("moment has no options");
  const chosen = chosenOptionId ? scored.find((o) => o.id === chosenOptionId) ?? null : null;
  if (!chosen) {
    return {
      momentId: moment.id,
      chosenOptionId: null,
      quality: null,
      band: "timeout",
      bestOptionId: best.id,
      explanation: [`No choice was committed in time. ${best.label} was available: ${coachReasons(best.reasons)}.`],
      commitTick: state.clock.tick,
    };
  }
  const spread = Math.max(0.6, best.score - worst.score);
  const quality = clamp(1 - (best.score - chosen.score) / spread, 0, 1);
  const band = quality >= 0.85 ? "strong" : quality >= 0.55 ? "acceptable" : "weak";
  const explanation = [`${chosen.label}: ${coachReasons(chosen.reasons)}.`];
  if (chosen.id !== best.id) explanation.push(`${best.label} read better here: ${coachReasons(best.reasons)}.`);
  return {
    momentId: moment.id,
    chosenOptionId: chosen.id,
    quality,
    band,
    bestOptionId: best.id,
    explanation,
    commitTick: state.clock.tick,
  };
}

/** Execution grade: the sim's own error for the resulting kick when there is one; otherwise pressure and fatigue at commit. */
export function gradeExecution(state: MatchState, p: PlayerState, committed: CommittedIntent, kickError: number | null): ExecutionRecord {
  const pressure = pressureAt(p.pos, opponents(state, p.side));
  const fatigue = p.fatigue;
  const quality = kickError !== null ? clamp(1 - kickError, 0, 1) : clamp((1 - 0.15 * pressure) * (1 - 0.1 * fatigue), 0, 1);
  const band = quality >= 0.75 ? "clean" : quality >= 0.45 ? "loose" : "poor";
  return {
    momentId: committed.momentId,
    actor: committed.actor,
    quality,
    band,
    pressureAtCommit: pressure,
    fatigueAtCommit: fatigue,
  };
}

/** Find the first pass/shot the player produced at or after `commitTick` (its error is the execution evidence). */
export function kickAfter(state: MatchState, playerId: string, commitTick: number, withinTicks = 60): { type: "pass" | "shot"; error: number; id: string } | null {
  for (const e of state.events) {
    if (e.tick < commitTick) continue;
    if (e.tick > commitTick + withinTicks) break;
    if (e.type === "pass" && e.from === playerId) return { type: "pass", error: e.error, id: e.id };
    if (e.type === "shot" && e.player === playerId) return { type: "shot", error: e.error, id: e.id };
  }
  return null;
}

/**
 * Outcome: read the event stream after commit. The window is short (~4 s) because possession
 * carries forward and later events belong to later moments.
 */
export function resolveOutcome(state: MatchState, moment: TacticalMoment, committed: CommittedIntent | null, windowTicks = 80): OutcomeRecord | null {
  const from = committed ? committed.commitTick : moment.tick;
  const until = from + windowTicks;
  if (state.clock.tick < until && state.phase.kind !== "full_time") return null;
  const p = playerById(state, moment.playerId);
  const side = p?.side ?? "home";
  const events = state.events.filter((e) => e.tick >= from && e.tick <= until);
  const ids = events.map((e) => e.id);
  const done = (result: OutcomeResult, summary: string): OutcomeRecord => ({ momentId: moment.id, result, summary, eventIds: ids, resolvedTick: state.clock.tick });

  const goalFor = events.find((e) => e.type === "goal" && e.side === side);
  const goalAgainst = events.find((e) => e.type === "goal" && e.side !== side);
  if (goalFor) return done("success", "Goal for your team.");
  if (goalAgainst) return done("failure", "Goal conceded.");

  const cmd = committed?.command;
  const passResult = (kick: Extract<MatchEvent, { type: "pass" }>): OutcomeRecord => {
    const received = events.find((e) => e.type === "receive" && e.tick > kick.tick && playerById(state, e.player)?.side === side);
    const lost = events.find((e) => e.tick > kick.tick && (e.type === "interception" || (e.type === "possession_change" && e.to !== side)));
    if (received && (!lost || received.tick < lost.tick)) return done("success", `Pass reached ${kick.to ? "the intended teammate" : "a teammate"}.`);
    if (lost) return done("failure", lost.type === "interception" ? "Pass intercepted." : "Possession lost.");
    return done("neutral", "Pass still in play.");
  };
  if (cmd && (cmd.type === "pass" || cmd.type === "shoot")) {
    const kick = events.find((e): e is Extract<MatchEvent, { type: "pass" | "shot" }> => (e.type === "pass" && e.from === moment.playerId) || (e.type === "shot" && e.player === moment.playerId));
    if (kick?.type === "shot") {
      if (events.some((e) => e.type === "save")) return done("partial", "Shot saved.");
      return done("failure", kick.onTarget ? "Shot cleared or blocked." : "Shot off target.");
    }
    if (kick?.type === "pass") return passResult(kick);
    if (events.some((e) => e.type === "tackle" && e.victim === moment.playerId && e.won)) return done("failure", "Tackled before the ball could be played.");
    if (events.some((e) => e.type === "possession_change" && e.to !== side)) return done("failure", "Possession lost.");
    return done("neutral", cmd.type === "shoot" ? "Shot not taken; ball still in play." : "Pass not played; ball still in play.");
  }
  const onBall = moment.read.hasBall === 1;
  if (onBall && cmd && (cmd.type === "carry" || cmd.type === "hold" || cmd.type === "first_touch")) {
    // the action is the carry / shield / touch itself: judged by whether the ball was kept, then by what the player did next
    // (an off-ball `hold` — a keeper organising the line — is judged below by what the team did, never as a ball kept)
    const verb = cmd.type === "carry" ? "Carried" : cmd.type === "hold" ? "Held the ball" : "Took the touch";
    const tackled = events.find((e) => e.type === "tackle" && e.victim === moment.playerId && e.won);
    const lost = events.find((e) => e.type === "possession_change" && e.to !== side);
    const release = events.find((e): e is Extract<MatchEvent, { type: "pass" | "shot" }> => (e.type === "pass" && e.from === moment.playerId) || (e.type === "shot" && e.player === moment.playerId));
    if (tackled && (!release || tackled.tick < release.tick)) return done("failure", `${verb} but was tackled.`);
    if (lost && (!release || lost.tick < release.tick)) return done("failure", `${verb} but possession was lost.`);
    if (release?.type === "shot") {
      if (events.some((e) => e.type === "save" && e.tick > release.tick)) return done("partial", `${verb}, then shot: saved.`);
      return done("failure", `${verb}, then shot ${release.onTarget ? "blocked or cleared" : "off target"}.`);
    }
    if (release?.type === "pass") {
      const next = passResult(release);
      const to = release.to ? playerById(state, release.to)?.name : null;
      return { ...next, summary: `${verb} and kept the ball, then passed${to ? ` to ${to}` : ""}: ${next.summary.toLowerCase()}` };
    }
    return done("success", `${verb} and kept the ball.`);
  }

  // off-ball / defending / transition: judged by what the team did with the ball in the window
  const regained = events.find((e) => e.type === "possession_change" && e.to === side);
  const lost = events.find((e) => e.type === "possession_change" && e.to !== side);
  const receivedByMe = events.find((e) => e.type === "receive" && e.player === moment.playerId);
  if (moment.category === "defending" || moment.category === "transition") {
    if (regained) return done("success", "Ball won back.");
    if (events.some((e) => e.type === "shot" && e.side !== side)) return done("failure", "Opponents got a shot away.");
    if (lost) return done("failure", "Possession lost.");
    return done("partial", "Attack slowed; no shot conceded.");
  }
  if (receivedByMe) return done("success", "You received the ball.");
  if (lost) return done("failure", "Team lost possession.");
  return done("neutral", "Team kept the ball; run not used.");
}
