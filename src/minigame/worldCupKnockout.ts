import { Rng } from "../sim/rng";
import type { ActionQuality, ExitReason, GameLogic, MinigameConfig, OutcomeTier, RelationshipEffect, Resolution, VerifiedAction, WitnessedBehavior } from "./contract";

/**
 * World Cup Knockout (Story Engine v2 §8.1). A server plays balls into a small scoring area;
 * whoever claims the ball must receive, turn and finish before the possession clock runs out.
 * A miss, a lost ball or a dead clock is a strike; reach the limit and you are out; the last
 * attacker standing wins. The concepts taught are the recess versions of the match ones: find
 * space and ask for the ball, open your first touch away from pressure, pick the side the
 * blocker is not on, strike when the ball is set — not before, not late.
 *
 * Everything is game time: the machine ticks it, so a seed plus the input log replays exactly.
 * Recess skill comes from the roster's `skills` map, never from match attributes, and nothing
 * here can reach the soccer engine.
 */

export type WckVariant = "classic" | "tight_space" | "shadow_defender" | "short_clock" | "weak_foot";

export type Dir3 = "left" | "center" | "right";
export type TouchDir = "left" | "right" | "forward";

export type WckInput =
  | { type: "move"; dx: number; dy: number }
  | { type: "move_to"; x: number; y: number }
  | { type: "call" }
  | { type: "touch"; dir: TouchDir }
  | { type: "shoot"; dir: Dir3; foot?: "strong" | "weak" };

export type WckPhase = "serve_wait" | "incoming" | "possession" | "round_end" | "other_play" | "other_end" | "finished";

export interface WckAttacker {
  id: string;
  strikes: number;
  goals: number;
  /** Round in which the attacker was eliminated, or null. */
  outRound: number | null;
  x: number;
  y: number;
}

export interface WckRound {
  n: number;
  /** Whose ball is in play right now (the player through their turn, then each other attacker). */
  targetId: string | null;
  /** Where the server drops the ball; a called ball comes to the caller's feet. */
  landing: { x: number; y: number };
  /** Side the blocker guards this round: shooting the other way is the strong choice. */
  blocker: Dir3;
  /** Where pressure comes from relative to the receiver (for first-touch orientation). */
  pressure: TouchDir;
  called: boolean;
  touch: ActionQuality | null;
  touchAtMs: number | null;
  shot: { dir: Dir3; timing: ActionQuality; direction: ActionQuality; foot: "strong" | "weak" } | null;
  /** The player's result this round (null while their turn is open or if they are out). */
  result: "goal" | "strike" | null;
  why: string | null;
  /** Other live attackers still to take their turn this round, in order. */
  others: string[];
  /** The other attacker whose turn just ended, shown during `other_end`. */
  last: { id: string; result: "goal" | "strike"; why: string } | null;
}

export interface WckState {
  area: { w: number; d: number };
  attackers: WckAttacker[];
  round: WckRound;
  phase: WckPhase;
  /** Game ms left in the current phase. */
  phaseMs: number;
  /** Possession clock left (only in `possession`). */
  clockMs: number;
  rng: number;
  actions: VerifiedAction[];
  witnessed: WitnessedBehavior[];
  elapsedMs: number;
  /** Shadow-defender variant: where the defender stands. */
  defender: { x: number; y: number } | null;
  strikesToOut: number;
}

interface VariantRules {
  area: { w: number; d: number };
  clockMs: number;
  defender: boolean;
  weakFoot: boolean;
  strikesToOut: number;
}

export const WCK_VARIANTS: Record<WckVariant, VariantRules> = {
  classic: { area: { w: 14, d: 12 }, clockMs: 4200, defender: false, weakFoot: false, strikesToOut: 3 },
  tight_space: { area: { w: 10, d: 9 }, clockMs: 4200, defender: false, weakFoot: false, strikesToOut: 3 },
  shadow_defender: { area: { w: 14, d: 12 }, clockMs: 4200, defender: true, weakFoot: false, strikesToOut: 3 },
  short_clock: { area: { w: 14, d: 12 }, clockMs: 2800, defender: false, weakFoot: false, strikesToOut: 3 },
  weak_foot: { area: { w: 14, d: 12 }, clockMs: 4200, defender: false, weakFoot: true, strikesToOut: 3 },
};

/** A recess player at least this good treats losing to you as something to answer for. */
export const WCK_RIVALRY_SKILL = 0.7;

export const WCK_TIMING = {
  serveWaitMs: 2200,
  /** Each other attacker's turn: ball in, then the result. */
  otherPlayMs: 900,
  otherEndMs: 650,
  incomingMs: 700,
  roundEndMs: 1300,
  /** Once the player is out the rest of the knockout plays out at a glance. */
  spectatorMs: 350,
  /** Further than this from the drop when the ball arrives and the first touch can only be acceptable. */
  farM: 2.5,
  /** After the ball arrives, a touch this late is taken for you (weak). */
  autoTouchMs: 900,
  /** Ball set: shooting inside this window after the touch is the strong strike. */
  setFrom: 350,
  setTo: 1000,
  timeLimitMs: 6 * 60_000,
  minPlayers: 6,
  maxPlayers: 10,
} as const;

export const PLAYER_SPEED = 4.2; // m/s

const variantOf = (cfg: MinigameConfig): VariantRules => WCK_VARIANTS[(cfg.ruleVariant as WckVariant) in WCK_VARIANTS ? (cfg.ruleVariant as WckVariant) : "classic"];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

function alive(s: WckState): WckAttacker[] {
  return s.attackers.filter((a) => a.outRound === null);
}

const player = (s: WckState): WckAttacker => s.attackers[0]!;

function newRound(s: WckState, n: number, rng: Rng): WckRound {
  const dirs: Dir3[] = ["left", "center", "right"];
  const press: TouchDir[] = ["left", "right", "forward"];
  return {
    n,
    targetId: null,
    landing: { x: rng.range(s.area.w * 0.25, s.area.w * 0.75), y: rng.range(s.area.d * 0.35, s.area.d * 0.7) },
    blocker: dirs[rng.int(0, 3)]!,
    pressure: press[rng.int(0, 3)]!,
    called: false,
    touch: null,
    touchAtMs: null,
    shot: null,
    result: null,
    why: null,
    others: [],
    last: null,
  };
}

/** Spread the other attackers around the area; the player starts near the bottom middle. */
function placeAttackers(s: WckState, rng: Rng): void {
  const live = alive(s);
  live.forEach((a, i) => {
    if (i === 0 && a.id === player(s).id) return;
    const t = (i + 0.5) / live.length;
    a.x = clamp(s.area.w * t + rng.range(-1, 1), 0.8, s.area.w - 0.8);
    a.y = clamp(s.area.d * rng.range(0.3, 0.8), 1, s.area.d - 1);
  });
}

export const worldCupKnockout: GameLogic<WckState, WckInput> = {
  id: "world_cup_knockout",

  create(cfg) {
    const v = variantOf(cfg);
    const ids = cfg.participantIds.slice(0, WCK_TIMING.maxPlayers);
    if (ids.length < WCK_TIMING.minPlayers) throw new Error(`World Cup Knockout needs ${WCK_TIMING.minPlayers}–${WCK_TIMING.maxPlayers} players, got ${ids.length}`);
    const rng = new Rng(cfg.seed ^ 0x5bd1e995);
    const s: WckState = {
      area: { ...v.area },
      attackers: ids.map((id) => ({ id, strikes: 0, goals: 0, outRound: null, x: v.area.w / 2, y: v.area.d * 0.75 })),
      round: null as unknown as WckRound,
      phase: "serve_wait",
      phaseMs: WCK_TIMING.serveWaitMs,
      clockMs: 0,
      rng: 0,
      actions: [],
      witnessed: [],
      elapsedMs: 0,
      defender: v.defender ? { x: v.area.w / 2, y: v.area.d * 0.3 } : null,
      strikesToOut: v.strikesToOut,
    };
    s.round = newRound(s, 1, rng);
    beginRound(s, rng);
    s.rng = rng.snapshot();
    return s;
  },

  tick(s, cfg, dtMs) {
    if (s.phase === "finished") return;
    s.elapsedMs += dtMs;
    const rng = new Rng(0);
    rng.restore(s.rng);
    const scale = cfg.accessibility.timerScale;
    if (s.defender && s.phase === "possession") {
      const p = player(s);
      const step = (1.6 * dtMs) / 1000;
      s.defender.x += clamp(p.x - s.defender.x, -step, step);
      s.defender.y += clamp(p.y - s.defender.y, -step, step);
    }
    s.phaseMs -= dtMs;
    if (s.phase === "possession") {
      s.clockMs -= dtMs;
      const r = s.round;
      if (r.touch === null && s.phaseMs <= -WCK_TIMING.autoTouchMs * scale) {
        r.touch = "weak";
        r.touchAtMs = s.elapsedMs;
        s.actions.push({ atMs: s.elapsedMs, kind: "touch", actorId: player(s).id, quality: "weak", detail: { auto: true } });
      }
      if (s.clockMs <= 0) {
        endPlayerRound(s, cfg, rng, "strike", "clock");
        s.rng = rng.snapshot();
      }
      return;
    }
    if (s.phaseMs > 0) {
      s.rng = rng.snapshot();
      return;
    }
    switch (s.phase) {
      case "serve_wait":
        serve(s);
        break;
      case "incoming":
        s.phase = "possession";
        s.phaseMs = 0;
        s.clockMs = variantOf(cfg).clockMs * scale;
        break;
      case "round_end":
        othersTurn(s);
        break;
      case "other_play":
        resolveOther(s, cfg, rng);
        break;
      case "other_end":
        othersTurn(s);
        break;
    }
    if (s.phase === "round_end" && s.round.others.length === 0 && s.round.targetId !== player(s).id) nextRound(s, rng);
    s.rng = rng.snapshot();
  },

  apply(s, cfg, input) {
    if (s.phase === "finished") return;
    const p = player(s);
    if (p.outRound !== null) return;
    const rng = new Rng(0);
    rng.restore(s.rng);
    switch (input.type) {
      case "move": {
        if (s.phase !== "serve_wait" && s.phase !== "incoming" && s.phase !== "possession") return;
        const len = Math.hypot(input.dx, input.dy) || 1;
        const step = PLAYER_SPEED * 0.05;
        p.x = clamp(p.x + (input.dx / len) * step, 0.5, s.area.w - 0.5);
        p.y = clamp(p.y + (input.dy / len) * step, 0.5, s.area.d - 0.5);
        return;
      }
      case "move_to": {
        if (s.phase !== "serve_wait" && s.phase !== "incoming" && s.phase !== "possession") return;
        const step = PLAYER_SPEED * 0.12;
        const dx = clamp(input.x - p.x, -step, step);
        const dy = clamp(input.y - p.y, -step, step);
        p.x = clamp(p.x + dx, 0.5, s.area.w - 0.5);
        p.y = clamp(p.y + dy, 0.5, s.area.d - 0.5);
        return;
      }
      case "call":
        if (s.phase !== "serve_wait" || s.round.called) return;
        s.round.called = true;
        s.actions.push({ atMs: s.elapsedMs, kind: "call", actorId: p.id, detail: { space: Math.round(spaceOf(s, p) * 100) / 100 } });
        return;
      case "touch": {
        if ((s.phase !== "incoming" && s.phase !== "possession") || s.round.touch !== null) return;
        const read: ActionQuality = input.dir === s.round.pressure ? "weak" : input.dir === "forward" && s.round.pressure !== "forward" ? "strong" : s.round.pressure === "forward" ? "strong" : "acceptable";
        const far = dist(p, s.round.landing) > WCK_TIMING.farM;
        const q = far ? worst(read, "acceptable") : read;
        s.round.touch = q;
        s.round.touchAtMs = s.elapsedMs;
        s.actions.push({ atMs: s.elapsedMs, kind: "touch", actorId: p.id, quality: q, detail: { dir: input.dir, pressure: s.round.pressure, far } });
        if (s.phase === "incoming") {
          s.phase = "possession";
          s.phaseMs = 0;
          s.clockMs = variantOf(cfg).clockMs * cfg.accessibility.timerScale;
        }
        if (s.defender && q === "weak" && rng.chance(0.5)) {
          endPlayerRound(s, cfg, rng, "strike", "dispossessed");
        }
        s.rng = rng.snapshot();
        return;
      }
      case "shoot": {
        if (s.phase !== "possession" || s.round.shot) return;
        const r = s.round;
        if (r.touch === null) {
          r.touch = "weak";
          r.touchAtMs = s.elapsedMs;
          s.actions.push({ atMs: s.elapsedMs, kind: "touch", actorId: p.id, quality: "weak", detail: { auto: true } });
        }
        const since = s.elapsedMs - (r.touchAtMs ?? s.elapsedMs);
        const assist = cfg.accessibility.assist ? 250 : 0;
        const timing: ActionQuality = since < WCK_TIMING.setFrom - assist ? "weak" : since <= WCK_TIMING.setTo + assist ? "strong" : "acceptable";
        const direction: ActionQuality = input.dir === r.blocker ? "weak" : input.dir === "center" ? "acceptable" : "strong";
        const foot = input.foot ?? "strong";
        r.shot = { dir: input.dir, timing, direction, foot };
        s.actions.push({ atMs: s.elapsedMs, kind: "shoot", actorId: p.id, quality: worst(direction, timing), detail: { dir: input.dir, blocker: r.blocker, sinceTouchMs: since, foot } });
        if (variantOf(cfg).weakFoot && foot !== "weak") {
          endPlayerRound(s, cfg, rng, "strike", "wrong_foot");
        } else {
          const q = (x: ActionQuality): number => (x === "strong" ? 1 : x === "acceptable" ? 0.5 : 0);
          const pGoal = 0.12 + 0.3 * q(r.touch) + 0.36 * q(direction) + 0.22 * q(timing);
          const goal = rng.chance(pGoal);
          endPlayerRound(s, cfg, rng, goal ? "goal" : "strike", goal ? "finish" : direction === "weak" ? "blocked" : timing === "weak" ? "rushed" : "missed");
        }
        s.rng = rng.snapshot();
        return;
      }
    }
  },

  done: (s) => s.phase === "finished",

  checkpoint: (s) => (s.phase === "serve_wait" || s.phase === "finished" || (player(s).outRound !== null && s.phase === "other_play") ? `round:${s.round.n}` : null),

  timeLimitMs: (cfg) => WCK_TIMING.timeLimitMs * cfg.accessibility.timerScale,

  resolve(s, cfg, exit, elapsedMs): Resolution {
    const p = player(s);
    const total = s.attackers.length;
    const place = placeOf(s, p.id);
    const others = s.attackers.filter((a) => a.id !== p.id).map((a) => a.id);
    const liveNow = alive(s).length;
    let outcomeTier: OutcomeTier;
    if (exit === "completed") outcomeTier = place === 1 ? "success" : place <= Math.ceil(total / 2) ? "partial" : "failure";
    else outcomeTier = p.outRound !== null ? (place <= Math.ceil(total / 2) ? "partial" : "failure") : liveNow <= 3 ? "partial" : "failure";
    const witnessed = [...s.witnessed];
    const relationshipEffects: RelationshipEffect[] = [];
    const strongTouches = s.actions.filter((a) => a.kind === "touch" && a.quality === "strong").length;
    const calls = s.actions.filter((a) => a.kind === "call").length;
    if (exit === "voluntary_exit") {
      witnessed.push({ tag: "left_mid_game", actorId: p.id, witnessIds: others, atMs: elapsedMs });
      for (const id of others) relationshipEffects.push({ personId: id, dimension: "respect", delta: -1, reason: "walked off a recess game" });
    } else {
      if (place === 1) {
        witnessed.push({ tag: "won_knockout", actorId: p.id, witnessIds: others, atMs: elapsedMs });
        for (const id of others) relationshipEffects.push({ personId: id, dimension: "respect", delta: 1, reason: "won World Cup Knockout" });
        const best = Math.max(...others.map((id) => cfg.skills[id] ?? 0.5));
        for (const id of others) {
          if ((cfg.skills[id] ?? 0.5) === best && best >= WCK_RIVALRY_SKILL) relationshipEffects.push({ personId: id, dimension: "competitive_tension", delta: 1, reason: "beaten at their own recess game" });
        }
      }
      if (exit === "completed" && p.outRound !== null && place === total) witnessed.push({ tag: "out_first", actorId: p.id, witnessIds: others, atMs: elapsedMs });
      if (strongTouches >= 3) witnessed.push({ tag: "composed_first_touch", actorId: p.id, witnessIds: others, atMs: elapsedMs });
      if (calls >= 3) witnessed.push({ tag: "asked_for_ball", actorId: p.id, witnessIds: others, atMs: elapsedMs });
      witnessed.push({ tag: "stayed_to_the_end", actorId: p.id, witnessIds: others, atMs: elapsedMs });
    }
    const winner = liveNow === 1 ? alive(s)[0]!.id : null;
    return {
      outcomeTier,
      verifiedActions: [...s.actions],
      witnessedBehavior: witnessed,
      relationshipEffects,
      summary: {
        place,
        players: total,
        strikes: p.strikes,
        goals: p.goals,
        rounds: s.round.n,
        winner: winner ?? "",
        strongTouches,
        calls,
        variant: cfg.ruleVariant,
        finished: exit === "completed",
      },
    };
  },
};

const worst = (a: ActionQuality, b: ActionQuality): ActionQuality => (a === "weak" || b === "weak" ? "weak" : a === "acceptable" || b === "acceptable" ? "acceptable" : "strong");

/** Metres to the nearest other live attacker (capped): space is what the server rewards. */
export function spaceOf(s: WckState, a: WckAttacker): number {
  let best = 6;
  for (const o of alive(s)) if (o.id !== a.id) best = Math.min(best, dist(a, o));
  return best / 6;
}

/** The player's turn: the ball comes to whoever asked for it, otherwise to the chalk circle. */
function serve(s: WckState): void {
  const p = player(s);
  const r = s.round;
  if (r.called) r.landing = { x: clamp(p.x, 0.8, s.area.w - 0.8), y: clamp(p.y, 1, s.area.d - 1) };
  r.targetId = p.id;
  s.actions.push({ atMs: s.elapsedMs, kind: "serve", actorId: "server", detail: { to: p.id, called: r.called, far: dist(p, r.landing) > WCK_TIMING.farM } });
  s.phase = "incoming";
  s.phaseMs = WCK_TIMING.incomingMs;
}

/** Next other attacker's ball, or the end of the round once everyone has had one. */
function othersTurn(s: WckState): void {
  const r = s.round;
  const next = r.others.shift();
  if (!next) {
    r.targetId = null;
    s.phase = "round_end";
    s.phaseMs = 0;
    return;
  }
  r.targetId = next;
  s.phase = "other_play";
  s.phaseMs = player(s).outRound === null ? WCK_TIMING.otherPlayMs : WCK_TIMING.spectatorMs;
}

function resolveOther(s: WckState, cfg: MinigameConfig, rng: Rng): void {
  const r = s.round;
  const a = s.attackers.find((x) => x.id === r.targetId)!;
  const skill = cfg.skills[a.id] ?? 0.5;
  const goal = rng.chance(0.3 + 0.5 * skill);
  const why = goal ? "finish" : "missed";
  record(s, a, goal ? "goal" : "strike", why);
  r.last = { id: a.id, result: goal ? "goal" : "strike", why };
  s.phase = "other_end";
  s.phaseMs = player(s).outRound === null ? WCK_TIMING.otherEndMs : WCK_TIMING.spectatorMs;
}

function endPlayerRound(s: WckState, _cfg: MinigameConfig, _rng: Rng, result: "goal" | "strike", why: string): void {
  const r = s.round;
  if (r.result !== null) return;
  r.result = result;
  r.why = why;
  record(s, player(s), result, why);
  s.phase = "round_end";
  s.phaseMs = WCK_TIMING.roundEndMs;
  s.clockMs = 0;
}

function record(s: WckState, a: WckAttacker, result: "goal" | "strike", why: string): void {
  const r = s.round;
  if (result === "goal") a.goals++;
  else if (a.strikes + 1 >= s.strikesToOut && alive(s).length === 1) {
    // Playground rule: the last one standing cannot be knocked out — the game is already theirs.
    s.actions.push({ atMs: s.elapsedMs, kind: "strike", actorId: a.id, detail: { why, strikes: a.strikes, round: r.n, lastStanding: true } });
    return;
  } else a.strikes++;
  s.actions.push({ atMs: s.elapsedMs, kind: result, actorId: a.id, detail: { why, strikes: a.strikes, round: r.n } });
  if (a.strikes >= s.strikesToOut) {
    a.outRound = r.n;
    s.actions.push({ atMs: s.elapsedMs, kind: "eliminated", actorId: a.id, detail: { round: r.n } });
    const others = s.attackers.filter((x) => x.id !== a.id).map((x) => x.id);
    if (a.id === player(s).id) s.witnessed.push({ tag: "eliminated", actorId: a.id, witnessIds: others, atMs: s.elapsedMs });
  }
}

function nextRound(s: WckState, rng: Rng): void {
  const live = alive(s);
  if (live.length <= 1) {
    s.phase = "finished";
    s.phaseMs = 0;
    return;
  }
  s.round = newRound(s, s.round.n + 1, rng);
  beginRound(s, rng);
}

/** Everyone still in takes a ball this round: the player first (if in), then the others in order. */
function beginRound(s: WckState, rng: Rng): void {
  const p = player(s);
  placeAttackers(s, rng);
  if (s.defender) {
    s.defender.x = s.area.w / 2;
    s.defender.y = s.area.d * 0.3;
  }
  s.round.others = alive(s)
    .filter((a) => a.id !== p.id)
    .map((a) => a.id);
  if (p.outRound === null) {
    s.phase = "serve_wait";
    s.phaseMs = WCK_TIMING.serveWaitMs;
  } else {
    othersTurn(s);
  }
}

/** Final position: the last one standing is 1st; eliminated attackers rank by how long they lasted (round, then order within the round), then fewer strikes. */
export function placeOf(s: WckState, id: string): number {
  const outSeq = (x: WckAttacker): number => {
    const i = s.actions.findIndex((act) => act.kind === "eliminated" && act.actorId === x.id);
    return i === -1 ? Infinity : i;
  };
  const order = [...s.attackers].sort((a, b) => {
    const ao = a.outRound ?? Infinity;
    const bo = b.outRound ?? Infinity;
    if (ao !== bo) return bo - ao;
    const as = outSeq(a);
    const bs = outSeq(b);
    if (as !== bs) return bs - as;
    if (a.strikes !== b.strikes) return a.strikes - b.strikes;
    return b.goals - a.goals;
  });
  return order.findIndex((a) => a.id === id) + 1;
}
