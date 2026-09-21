import presentationsFile from "../../content/school/presentations-u11.json";
import { Rng } from "../sim/rng";
import type { ActionQuality, AgeBand, ExitReason, GameLogic, MinigameConfig, OutcomeTier, RelationshipEffect, Resolution, VerifiedAction, WitnessedBehavior } from "./contract";

/**
 * Group Presentation (Story Engine v2 §8.6). Three classmates prepare and deliver a short
 * presentation: assign sections, put the visual cards in order, rehearse the hand-overs, then
 * deliver it live — follow your cue cards, answer in time, and decide what to do when a partner
 * freezes. The teacher grades accuracy, clarity and teamwork separately, so a player who knows
 * the material but takes the whole thing over is graded as exactly that.
 *
 * Academic content comes from `content/school/presentations-u11.json`, tagged with its age band.
 */

export type Strength = "explaining" | "reading" | "numbers";
export type Grade = "A" | "B" | "C" | "D";
export type Intervention = "prompt" | "takeover" | "wait";

export interface Topic {
  id: string;
  ageBand: AgeBand;
  subject: string;
  title: string;
  cards: { id: string; text: string }[];
  sections: { id: string; title: string; needs: Strength }[];
  cues: { id: string; prompt: string; options: string[] }[];
}

export const TOPICS: Topic[] = (presentationsFile as { topics: Topic[] }).topics;
export const topicById = (id: string): Topic | undefined => TOPICS.find((t) => t.id === id);

export type GpInput =
  | { type: "assign"; sectionId: string; personId: string }
  | { type: "confirm" }
  | { type: "swap"; a: number; b: number }
  | { type: "handoff" }
  | { type: "answer"; option: number }
  | { type: "intervene"; how: Intervention };

export type GpPhase = "assign" | "order" | "rehearsal" | "delivery" | "feedback";

export type DeliveryStep =
  | { kind: "cue"; sectionId: string; cueId: string; prompt: string; options: string[]; correct: number; answered: number | null; quality: ActionQuality | null }
  | { kind: "partner"; sectionId: string; personId: string; freezes: boolean; intervention: Intervention | null; recovered: boolean | null };

export interface GpState {
  topicId: string;
  phase: GpPhase;
  members: { id: string; strength: Strength; confidence: number }[];
  assignments: Record<string, string | null>;
  cards: string[];
  correctOrder: string[];
  swaps: number;
  rehearsal: { total: number; index: number; windowInMs: number; windowOpen: boolean; results: ActionQuality[] };
  delivery: { steps: DeliveryStep[]; index: number; intro: boolean; stepMs: number; limitMs: number; startedAtMs: number };
  /** Set when the live delivery ran past its own time limit. */
  ranOutOfTime: boolean;
  rng: number;
  actions: VerifiedAction[];
  elapsedMs: number;
  grades: { accuracy: Grade; clarity: Grade; teamwork: Grade } | null;
}

export const GP_TIMING = {
  introMs: 1200,
  handoffWindowMs: 1400,
  handoffLeadMinMs: 1500,
  handoffLeadMaxMs: 3200,
  cueLimitMs: 9000,
  rushedMs: 900,
  partnerTalkMs: 2600,
  freezeLimitMs: 6000,
  transitions: 3,
  timeLimitMs: 8 * 60_000,
} as const;

const STRENGTHS: Strength[] = ["explaining", "reading", "numbers"];

const q = (x: ActionQuality): number => (x === "strong" ? 1 : x === "acceptable" ? 0.5 : 0);

export const gradeOf = (score: number): Grade => (score >= 0.85 ? "A" : score >= 0.65 ? "B" : score >= 0.45 ? "C" : "D");
const gradeValue: Record<Grade, number> = { A: 3, B: 2, C: 1, D: 0 };

const topicOf = (cfg: MinigameConfig): Topic => topicById(cfg.ruleVariant) ?? TOPICS.find((t) => t.ageBand === cfg.ageBand) ?? TOPICS[0]!;

export const groupPresentation: GameLogic<GpState, GpInput> = {
  id: "group_presentation",

  create(cfg) {
    const topic = topicOf(cfg);
    const ids = cfg.participantIds.slice(0, 3);
    if (ids.length < 3) throw new Error("Group Presentation needs the player and two partners");
    const rng = new Rng(cfg.seed ^ 0x27d4eb2f);
    const cards = topic.cards.map((c) => c.id);
    // Shuffle until the order is actually wrong.
    do {
      for (let i = cards.length - 1; i > 0; i--) {
        const j = rng.int(0, i + 1);
        [cards[i], cards[j]] = [cards[j]!, cards[i]!];
      }
    } while (cards.every((c, i) => c === topic.cards[i]!.id));
    const s: GpState = {
      topicId: topic.id,
      phase: "assign",
      members: ids.map((id, i) => ({ id, strength: STRENGTHS[i]!, confidence: i === 0 ? 1 : (cfg.skills[id] ?? 0.6) })),
      assignments: Object.fromEntries(topic.sections.map((x) => [x.id, null])),
      cards,
      correctOrder: topic.cards.map((c) => c.id),
      swaps: 0,
      rehearsal: { total: GP_TIMING.transitions, index: 0, windowInMs: 0, windowOpen: false, results: [] },
      delivery: { steps: [], index: 0, intro: true, stepMs: 0, limitMs: 0, startedAtMs: 0 },
      ranOutOfTime: false,
      rng: 0,
      actions: [],
      elapsedMs: 0,
      grades: null,
    };
    s.rng = rng.snapshot();
    return s;
  },

  tick(s, cfg, dtMs) {
    if (s.phase === "feedback") return;
    s.elapsedMs += dtMs;
    const scale = cfg.accessibility.timerScale;
    if (s.phase === "rehearsal") {
      const r = s.rehearsal;
      if (r.index >= r.total) return;
      if (r.windowInMs > 0) {
        r.windowInMs -= dtMs;
        if (r.windowInMs <= 0) {
          r.windowOpen = true;
          r.windowInMs = 0;
          s.delivery.stepMs = GP_TIMING.handoffWindowMs * scale;
        }
        return;
      }
      if (r.windowOpen) {
        s.delivery.stepMs -= dtMs;
        if (s.delivery.stepMs <= 0) {
          r.results.push("weak");
          s.actions.push({ atMs: s.elapsedMs, kind: "handoff", actorId: s.members[0]!.id, quality: "weak", detail: { late: true } });
          nextTransition(s, cfg);
        }
      }
      return;
    }
    if (s.phase === "delivery") {
      const d = s.delivery;
      const step = d.steps[d.index];
      if (!step) return;
      if (d.intro) {
        d.stepMs -= dtMs;
        if (d.stepMs <= 0) {
          d.intro = false;
          d.startedAtMs = s.elapsedMs;
          d.limitMs = (step.kind === "cue" ? GP_TIMING.cueLimitMs : step.freezes ? GP_TIMING.freezeLimitMs : GP_TIMING.partnerTalkMs) * scale;
          d.stepMs = d.limitMs;
        }
        return;
      }
      d.stepMs -= dtMs;
      if (d.stepMs > 0) return;
      const rng = new Rng(0);
      rng.restore(s.rng);
      if (step.kind === "cue") {
        step.answered = -1;
        step.quality = "weak";
        s.actions.push({ atMs: s.elapsedMs, kind: "cue", actorId: s.members[0]!.id, quality: "weak", detail: { cue: step.cueId, timeout: true } });
      } else if (step.freezes && step.intervention === null) {
        step.intervention = "wait";
        step.recovered = rng.chance(confidenceOf(s, step.personId));
        s.actions.push({ atMs: s.elapsedMs, kind: "intervene", actorId: s.members[0]!.id, quality: "weak", detail: { how: "wait", partner: step.personId, recovered: step.recovered, timeout: true } });
      } else if (!step.freezes) {
        step.recovered = true;
      }
      s.rng = rng.snapshot();
      advanceDelivery(s, cfg);
    }
  },

  apply(s, cfg, input) {
    const me = s.members[0]!.id;
    switch (input.type) {
      case "assign": {
        if (s.phase !== "assign" || !(input.sectionId in s.assignments) || !s.members.some((m) => m.id === input.personId)) return;
        s.assignments[input.sectionId] = input.personId;
        return;
      }
      case "swap": {
        if (s.phase !== "order") return;
        if (input.a < 0 || input.b < 0 || input.a >= s.cards.length || input.b >= s.cards.length || input.a === input.b) return;
        [s.cards[input.a], s.cards[input.b]] = [s.cards[input.b]!, s.cards[input.a]!];
        s.swaps++;
        return;
      }
      case "confirm": {
        if (s.phase === "assign") {
          if (Object.values(s.assignments).some((v) => v === null)) return;
          const mine = Object.values(s.assignments).filter((v) => v === me).length;
          const fit = fitScore(s, cfg);
          s.actions.push({ atMs: s.elapsedMs, kind: "assign", actorId: me, quality: mine >= 2 ? "weak" : fit >= 0.99 ? "strong" : "acceptable", detail: { mine, fit } });
          s.phase = "order";
          return;
        }
        if (s.phase === "order") {
          const right = orderScore(s);
          s.actions.push({ atMs: s.elapsedMs, kind: "order", actorId: me, quality: right >= 0.99 ? "strong" : right >= 0.6 ? "acceptable" : "weak", detail: { correct: right, swaps: s.swaps } });
          s.phase = "rehearsal";
          scheduleTransition(s, cfg);
          return;
        }
        return;
      }
      case "handoff": {
        if (s.phase !== "rehearsal") return;
        const r = s.rehearsal;
        if (r.index >= r.total) return;
        const quality: ActionQuality = r.windowOpen ? (s.delivery.stepMs >= (GP_TIMING.handoffWindowMs * cfg.accessibility.timerScale) / 2 ? "strong" : "acceptable") : "weak";
        r.results.push(quality);
        s.actions.push({ atMs: s.elapsedMs, kind: "handoff", actorId: me, quality, detail: { early: !r.windowOpen } });
        nextTransition(s, cfg);
        return;
      }
      case "answer": {
        if (s.phase !== "delivery" || s.delivery.intro) return;
        const step = s.delivery.steps[s.delivery.index];
        if (!step || step.kind !== "cue" || step.answered !== null) return;
        if (input.option < 0 || input.option >= step.options.length) return;
        const took = s.elapsedMs - s.delivery.startedAtMs;
        const correct = input.option === step.correct;
        const timing: ActionQuality = took < GP_TIMING.rushedMs ? "acceptable" : took <= s.delivery.limitMs * 0.7 ? "strong" : "acceptable";
        step.answered = input.option;
        step.quality = correct ? timing : "weak";
        s.actions.push({ atMs: s.elapsedMs, kind: "cue", actorId: me, quality: step.quality, detail: { cue: step.cueId, correct, tookMs: took } });
        advanceDelivery(s, cfg);
        return;
      }
      case "intervene": {
        if (s.phase !== "delivery" || s.delivery.intro) return;
        const step = s.delivery.steps[s.delivery.index];
        if (!step || step.kind !== "partner" || !step.freezes || step.intervention !== null) return;
        const rng = new Rng(0);
        rng.restore(s.rng);
        step.intervention = input.how;
        step.recovered = input.how === "prompt" ? true : input.how === "takeover" ? true : rng.chance(confidenceOf(s, step.personId));
        const quality: ActionQuality = input.how === "prompt" ? "strong" : input.how === "wait" ? (step.recovered ? "acceptable" : "weak") : "acceptable";
        s.actions.push({ atMs: s.elapsedMs, kind: "intervene", actorId: me, quality, detail: { how: input.how, partner: step.personId, recovered: step.recovered } });
        s.rng = rng.snapshot();
        advanceDelivery(s, cfg);
        return;
      }
    }
  },

  done: (s) => s.phase === "feedback",

  checkpoint: (s) => {
    if (s.phase === "assign" || s.phase === "order" || s.phase === "feedback") return `phase:${s.phase}`;
    if (s.phase === "rehearsal" && !s.rehearsal.windowOpen) return `rehearsal:${s.rehearsal.index}`;
    if (s.phase === "delivery" && s.delivery.intro) return `delivery:${s.delivery.index}`;
    return null;
  },

  timeLimitMs: (cfg) => GP_TIMING.timeLimitMs * cfg.accessibility.timerScale,

  resolve(s, cfg, exit, elapsedMs): Resolution {
    const me = s.members[0]!.id;
    const partners = s.members.slice(1).map((m) => m.id);
    const grades = s.grades ?? computeGrades(s, cfg);
    const finished = s.phase === "feedback";
    let outcomeTier: OutcomeTier;
    const vals = [grades.accuracy, grades.clarity, grades.teamwork].map((g) => gradeValue[g]);
    if (!finished) outcomeTier = "failure";
    else if (vals.every((v) => v >= 2)) outcomeTier = "success";
    else if (vals.some((v) => v === 0) || grades.accuracy === "D") outcomeTier = "failure";
    else outcomeTier = "partial";
    const witnessed: WitnessedBehavior[] = [];
    const relationshipEffects: RelationshipEffect[] = [];
    const mine = Object.values(s.assignments).filter((v) => v === me).length;
    const teacher = "teacher";
    if (exit === "voluntary_exit") {
      witnessed.push({ tag: "left_group_project", actorId: me, witnessIds: [...partners, teacher], atMs: elapsedMs });
      for (const id of partners) relationshipEffects.push({ personId: id, dimension: "trust", delta: -2, reason: "left the group mid-project" });
    } else {
      if (mine >= 2) {
        witnessed.push({ tag: "dominated_presentation", actorId: me, witnessIds: [...partners, teacher], atMs: elapsedMs });
        for (const id of partners) relationshipEffects.push({ personId: id, dimension: "respect", delta: -1, reason: "took most of the presentation" });
      }
      for (const step of s.delivery.steps) {
        if (step.kind !== "partner" || !step.freezes || step.intervention === null) continue;
        if (step.intervention === "prompt") {
          witnessed.push({ tag: "rescued_partner", actorId: me, witnessIds: [step.personId, teacher], atMs: elapsedMs });
          relationshipEffects.push({ personId: step.personId, dimension: "trust", delta: 2, reason: "helped when they froze" });
        } else if (step.intervention === "takeover") {
          witnessed.push({ tag: "took_over_from_partner", actorId: me, witnessIds: [step.personId, teacher], atMs: elapsedMs });
          relationshipEffects.push({ personId: step.personId, dimension: "dependence", delta: 1, reason: "took over when they froze" });
          relationshipEffects.push({ personId: step.personId, dimension: "respect", delta: -1, reason: "took over when they froze" });
        } else if (!step.recovered) {
          witnessed.push({ tag: "let_partner_flounder", actorId: me, witnessIds: [step.personId, teacher], atMs: elapsedMs });
          relationshipEffects.push({ personId: step.personId, dimension: "trust", delta: -1, reason: "watched them freeze" });
        }
      }
      if (finished && outcomeTier === "success") witnessed.push({ tag: "strong_group_result", actorId: me, witnessIds: [...partners, teacher], atMs: elapsedMs });
    }
    return {
      outcomeTier,
      verifiedActions: [...s.actions],
      witnessedBehavior: witnessed,
      relationshipEffects,
      summary: {
        topic: s.topicId,
        accuracy: grades.accuracy,
        clarity: grades.clarity,
        teamwork: grades.teamwork,
        mine,
        finished,
        ranOutOfTime: s.ranOutOfTime,
        rescued: s.delivery.steps.some((x) => x.kind === "partner" && x.intervention === "prompt"),
        tookOver: s.delivery.steps.some((x) => x.kind === "partner" && x.intervention === "takeover"),
        correctCues: s.delivery.steps.filter((x) => x.kind === "cue" && x.answered === x.correct).length,
        totalCues: s.delivery.steps.filter((x) => x.kind === "cue").length,
      },
    };
  },
};

const confidenceOf = (s: GpState, id: string): number => s.members.find((m) => m.id === id)?.confidence ?? 0.5;

/** Share of sections given to someone whose strength matches what the section needs. */
export function fitScore(s: GpState, cfg: MinigameConfig): number {
  const topic = topicOf(cfg);
  let hit = 0;
  for (const sec of topic.sections) {
    const who = s.assignments[sec.id];
    const m = s.members.find((x) => x.id === who);
    if (m && m.strength === sec.needs) hit++;
  }
  return topic.sections.length ? hit / topic.sections.length : 1;
}

export function orderScore(s: GpState): number {
  let right = 0;
  s.cards.forEach((c, i) => {
    if (c === s.correctOrder[i]) right++;
  });
  return right / s.cards.length;
}

function scheduleTransition(s: GpState, cfg: MinigameConfig): void {
  const rng = new Rng(0);
  rng.restore(s.rng);
  s.rehearsal.windowOpen = false;
  s.rehearsal.windowInMs = rng.range(GP_TIMING.handoffLeadMinMs, GP_TIMING.handoffLeadMaxMs) * cfg.accessibility.timerScale;
  s.rng = rng.snapshot();
}

function nextTransition(s: GpState, cfg: MinigameConfig): void {
  const r = s.rehearsal;
  r.index++;
  r.windowOpen = false;
  if (r.index >= r.total) {
    buildDelivery(s, cfg);
    return;
  }
  scheduleTransition(s, cfg);
}

function buildDelivery(s: GpState, cfg: MinigameConfig): void {
  const topic = topicOf(cfg);
  const rng = new Rng(0);
  rng.restore(s.rng);
  const me = s.members[0]!.id;
  const steps: DeliveryStep[] = [];
  let cueIdx = 0;
  for (const sec of topic.sections) {
    const who = s.assignments[sec.id] ?? me;
    if (who === me) {
      for (let k = 0; k < 2 && cueIdx < topic.cues.length; k++, cueIdx++) {
        const cue = topic.cues[cueIdx]!;
        const order = cue.options.map((_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = rng.int(0, i + 1);
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        steps.push({ kind: "cue", sectionId: sec.id, cueId: cue.id, prompt: cue.prompt, options: order.map((i) => cue.options[i]!), correct: order.indexOf(0), answered: null, quality: null });
      }
    } else {
      steps.push({ kind: "partner", sectionId: sec.id, personId: who, freezes: rng.chance(1 - confidenceOf(s, who)), intervention: null, recovered: null });
    }
  }
  s.rng = rng.snapshot();
  s.phase = "delivery";
  s.delivery = { steps, index: 0, intro: true, stepMs: GP_TIMING.introMs, limitMs: 0, startedAtMs: 0 };
}

function advanceDelivery(s: GpState, cfg: MinigameConfig): void {
  const d = s.delivery;
  d.index++;
  if (d.index >= d.steps.length) {
    s.grades = computeGrades(s, cfg);
    s.phase = "feedback";
    s.actions.push({ atMs: s.elapsedMs, kind: "feedback", actorId: "teacher", detail: { ...s.grades } });
    return;
  }
  d.intro = true;
  d.stepMs = GP_TIMING.introMs;
}

export function computeGrades(s: GpState, cfg: MinigameConfig): { accuracy: Grade; clarity: Grade; teamwork: Grade } {
  const cues = s.delivery.steps.filter((x): x is Extract<DeliveryStep, { kind: "cue" }> => x.kind === "cue");
  const partners = s.delivery.steps.filter((x): x is Extract<DeliveryStep, { kind: "partner" }> => x.kind === "partner");
  const cueRight = cues.length ? cues.filter((c) => c.answered === c.correct).length / cues.length : 0;
  const partnerRight = partners.length ? partners.filter((p) => p.recovered === true).length / partners.length : 1;
  const accuracy = 0.4 * orderScore(s) + 0.45 * cueRight + 0.15 * partnerRight;
  const timings = [...cues.map((c) => c.quality ?? "weak"), ...s.rehearsal.results];
  const clarity = timings.length ? timings.reduce((sum, t) => sum + q(t), 0) / timings.length : 0;
  const me = s.members[0]!.id;
  const mine = Object.values(s.assignments).filter((v) => v === me).length;
  const everyone = s.members.every((m) => Object.values(s.assignments).includes(m.id));
  let teamwork = 0.35 * fitScore(s, cfg) + (everyone ? 0.35 : 0) + (mine >= 2 ? -0.25 : 0.1);
  for (const p of partners) {
    if (!p.freezes) continue;
    if (p.intervention === "prompt") teamwork += 0.25;
    else if (p.intervention === "takeover") teamwork -= 0.1;
    else if (p.recovered === false) teamwork -= 0.2;
  }
  if (s.phase !== "feedback" && s.delivery.index < s.delivery.steps.length) s.ranOutOfTime = true;
  return { accuracy: gradeOf(accuracy), clarity: gradeOf(clarity), teamwork: gradeOf(Math.max(0, Math.min(1, teamwork))) };
}
