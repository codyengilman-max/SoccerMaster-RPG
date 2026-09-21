import { DEFAULT_ACCESSIBILITY, type MinigameConfig, type MinigameId } from "../../src/minigame/contract";
import { groupPresentation, topicById, type GpInput, type GpState } from "../../src/minigame/groupPresentation";
import { createSession, input, start, tick, type MinigameSession } from "../../src/minigame/machine";
import { GP_TIMING } from "../../src/minigame/groupPresentation";
import { worldCupKnockout, WCK_TIMING, type WckInput, type WckState } from "../../src/minigame/worldCupKnockout";

export const STEP = 50;

export const WCK_PLAYERS = ["player", "friend", "rival", "cm-leah", "cm-tobias", "cm-hana"];
export const GP_PLAYERS = ["player", "friend", "rival"];

export function cfg(gameId: MinigameId, over: Partial<MinigameConfig> = {}): MinigameConfig {
  const participantIds = gameId === "group_presentation" ? GP_PLAYERS : WCK_PLAYERS;
  const skills: Record<string, number> = {};
  for (const id of participantIds.slice(1)) skills[id] = 0.55;
  return {
    gameId,
    episodeId: "ep1",
    ageBand: "U11-U12",
    locationId: gameId === "group_presentation" ? "school" : "school",
    participantIds,
    ruleVariant: gameId === "group_presentation" ? "fractions_pizza" : "classic",
    seed: 7,
    day: 3,
    accessibility: { ...DEFAULT_ACCESSIBILITY },
    skills,
    ...over,
  };
}

export type WckSession = MinigameSession<WckState, WckInput>;
export type GpSession = MinigameSession<GpState, GpInput>;

export function newWck(over: Partial<MinigameConfig> = {}): WckSession {
  const s = createSession(worldCupKnockout, cfg("world_cup_knockout", over), 1000);
  start(s);
  return s;
}

export function newGp(over: Partial<MinigameConfig> = {}): GpSession {
  const s = createSession(groupPresentation, cfg("group_presentation", over), 1000);
  start(s);
  return s;
}

/** Tick until the game is over (or `maxMs` of game time), doing nothing else. */
export function idle<S, I>(s: MinigameSession<S, I>, logic: { tick: typeof worldCupKnockout.tick } | typeof groupPresentation, maxMs = 30 * 60_000): void {
  let t = 0;
  while (s.phase === "active" && t < maxMs) {
    tick(s, logic as never, STEP, s.elapsedMs + STEP);
    t += STEP;
  }
}

/** A player who does everything the game teaches: asks, opens the touch away from pressure, finishes away from the blocker once the ball is set. */
export function playWckPerfect(s: WckSession, untilMs = 30 * 60_000): void {
  const g = s.game;
  const weakFoot = s.config.ruleVariant === "weak_foot";
  while (s.phase === "active" && s.elapsedMs < untilMs) {
    const r = g.round;
    if (g.phase === "serve_wait" && !r.called) input(s, worldCupKnockout, { type: "call" }, s.elapsedMs);
    else if (g.phase === "incoming" && r.touch === null) input(s, worldCupKnockout, { type: "touch", dir: r.pressure === "forward" ? "left" : "forward" }, s.elapsedMs);
    else if (g.phase === "possession" && r.touch !== null && r.shot === null && r.result === null) {
      const since = g.elapsedMs - (r.touchAtMs ?? 0);
      if (since >= WCK_TIMING.setFrom && since <= WCK_TIMING.setTo) {
        const dir = r.blocker === "left" ? "right" : "left";
        input(s, worldCupKnockout, { type: "shoot", dir, foot: weakFoot ? "weak" : "strong" }, s.elapsedMs);
      }
    }
    tick(s, worldCupKnockout, STEP, s.elapsedMs + STEP);
  }
}

/** A player who never asks or prepares the touch but does pick the open side once the ball is set. */
export function playWckAverage(s: WckSession): void {
  const g = s.game;
  while (s.phase === "active") {
    const r = g.round;
    if (g.phase === "possession" && r.touch !== null && r.shot === null && r.result === null) {
      const since = g.elapsedMs - (r.touchAtMs ?? 0);
      if (since >= WCK_TIMING.setFrom && since <= WCK_TIMING.setTo) input(s, worldCupKnockout, { type: "shoot", dir: r.blocker === "left" ? "right" : "left" }, s.elapsedMs);
    }
    tick(s, worldCupKnockout, STEP, s.elapsedMs + STEP);
  }
}

/** A player who panics: shoots into the blocker before the ball is set, with the wrong foot. */
export function playWckReckless(s: WckSession): void {
  const g = s.game;
  while (s.phase === "active") {
    const r = g.round;
    if (g.phase === "possession" && r.shot === null && r.result === null) input(s, worldCupKnockout, { type: "shoot", dir: r.blocker, foot: "strong" }, s.elapsedMs);
    tick(s, worldCupKnockout, STEP, s.elapsedMs + STEP);
  }
}

export interface GpStyle {
  /** Give every section to the best-fitting member, leaving nobody out when the topic allows it. */
  assign: "fit" | "hog" | "fit_only";
  order: "correct" | "leave";
  answers: "correct" | "wrong" | "none";
  handoff: "on_time" | "early" | "none";
  freeze: "prompt" | "takeover" | "wait" | "none";
}

export const GP_PERFECT: GpStyle = { assign: "fit", order: "correct", answers: "correct", handoff: "on_time", freeze: "prompt" };

function assignSections(s: GpSession, mode: GpStyle["assign"]): void {
  const g = s.game;
  const topic = topicById(g.topicId)!;
  const me = g.members[0]!.id;
  for (const sec of topic.sections) {
    let who = me;
    if (mode !== "hog") {
      const fit = g.members.find((m) => m.strength === sec.needs);
      who = fit ? fit.id : me;
    }
    input(s, groupPresentation, { type: "assign", sectionId: sec.id, personId: who }, s.elapsedMs);
  }
  if (mode === "fit") {
    // Nobody should sit out: hand the last section of an over-booked member to whoever has nothing.
    const idle = g.members.filter((m) => !Object.values(g.assignments).includes(m.id));
    for (const m of idle) {
      const counts = new Map<string, number>();
      for (const v of Object.values(g.assignments)) counts.set(v!, (counts.get(v!) ?? 0) + 1);
      const busy = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const sec = topic.sections.filter((x) => g.assignments[x.id] === busy).at(-1);
      if (sec) input(s, groupPresentation, { type: "assign", sectionId: sec.id, personId: m.id }, s.elapsedMs);
    }
  }
  input(s, groupPresentation, { type: "confirm" }, s.elapsedMs);
}

export function playGp(s: GpSession, style: GpStyle = GP_PERFECT, untilMs = 30 * 60_000): void {
  const g = s.game;
  let lastPhase: string | null = null;
  while (s.phase === "active" && s.elapsedMs < untilMs) {
    const before: string = g.phase;
    if (g.phase === "assign" && lastPhase !== "assign") assignSections(s, style.assign);
    else if (g.phase === "order" && lastPhase !== "order") {
      if (style.order === "correct") {
        for (let i = 0; i < g.correctOrder.length; i++) {
          const j = g.cards.indexOf(g.correctOrder[i]!);
          if (j !== i) input(s, groupPresentation, { type: "swap", a: i, b: j }, s.elapsedMs);
        }
      }
      input(s, groupPresentation, { type: "confirm" }, s.elapsedMs);
    } else if (g.phase === "rehearsal" && g.rehearsal.index < g.rehearsal.total) {
      if (style.handoff === "on_time" && g.rehearsal.windowOpen) input(s, groupPresentation, { type: "handoff" }, s.elapsedMs);
      else if (style.handoff === "early" && !g.rehearsal.windowOpen && g.rehearsal.windowInMs > 0) input(s, groupPresentation, { type: "handoff" }, s.elapsedMs);
    } else if (g.phase === "delivery" && !g.delivery.intro) {
      const step = g.delivery.steps[g.delivery.index];
      if (step?.kind === "cue" && step.answered === null && style.answers !== "none") {
        const took = g.elapsedMs - g.delivery.startedAtMs;
        if (took >= GP_TIMING.rushedMs) {
          const option = style.answers === "correct" ? step.correct : (step.correct + 1) % step.options.length;
          input(s, groupPresentation, { type: "answer", option }, s.elapsedMs);
        }
      } else if (step?.kind === "partner" && step.freezes && step.intervention === null && style.freeze !== "none") {
        input(s, groupPresentation, { type: "intervene", how: style.freeze }, s.elapsedMs);
      }
    }
    lastPhase = before;
    tick(s, groupPresentation, STEP, s.elapsedMs + STEP);
  }
}
