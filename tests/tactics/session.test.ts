import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { createMatch, isFinished, tick } from "../../src/sim/engine";
import { opponents, playerById } from "../../src/sim/perception";
import { Rng } from "../../src/sim/rng";
import { U11_9V9 } from "../../src/sim/rules";
import { ROLE_BY_NUMBER, type MatchState, type RoleId, type RoleNumber } from "../../src/sim/types";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { coverageReport } from "../../src/tactics/coverage";
import { readField } from "../../src/tactics/features";
import { coachReasons, gradeDecision, gradeExecution, resolveOutcome } from "../../src/tactics/grading";
import { instantiateIntent } from "../../src/tactics/intents";
import type { CommittedIntent, MomentRecord, TacticalMoment } from "../../src/tactics/moments";
import { DIRECT_PACING, GK_DIRECT_PACING, difficultyOf, pacingFor, recognize, createRecognizer } from "../../src/tactics/recognition";
import { commit, createSession, feedbackFor, observe, timeout, type TacticalSession } from "../../src/tactics/session";
import { testConfig } from "../helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);

function roleNumber(role: RoleId): RoleNumber {
  const n = (Object.keys(ROLE_BY_NUMBER).map(Number) as RoleNumber[]).find((k) => ROLE_BY_NUMBER[k] === role);
  if (!n) throw new Error(role);
  return n;
}

function controlledMatch(seed: number, role: RoleId): { state: MatchState; me: string } {
  const cfg = testConfig(seed);
  const me = cfg.home.squad.find((p) => p.role === roleNumber(role));
  if (!me) throw new Error("no such role");
  return { state: createMatch({ ...cfg, controlled: { side: "home", playerId: me.id } }), me: me.id };
}

type Policy = "random" | "best" | "timeout";

/** Play a full match with a scripted user who answers each moment after a short slow-motion delay. */
function playMatch(seed: number, role: RoleId, policy: Policy, maxTicks = Infinity): { session: TacticalSession; state: MatchState; suspendedTicks: number; leakedAiTicks: number } {
  const { state, me } = controlledMatch(seed, role);
  const session = createSession(catalog, pacingFor(role));
  const user = new Rng(seed);
  let pendingUntil = -1;
  let suspendedTicks = 0;
  let leakedAiTicks = 0;
  while (!isFinished(state) && state.clock.tick < maxTicks) {
    const moment = observe(session, state);
    if (moment) pendingUntil = state.clock.tick + user.int(2, 8);
    if (session.active) {
      suspendedTicks++;
      if (state.awaiting !== me) leakedAiTicks++;
      if (state.clock.tick >= pendingUntil) {
        const m = session.active;
        if (policy === "timeout") timeout(session, state);
        else {
          const pick = policy === "best" ? [...m.options].sort((a, b) => b.score - a.score)[0]! : user.pick(m.options)!;
          commit(session, state, pick.id);
        }
      }
    }
    tick(state);
  }
  return { session, state, suspendedTicks, leakedAiTicks };
}

/** Drive the match until the controlled player gets a moment whose read matches `want`. */
function nextMoment(session: TacticalSession, state: MatchState, want: (m: TacticalMoment) => boolean, maxTicks = 40000): TacticalMoment {
  while (!isFinished(state) && state.clock.tick < maxTicks) {
    const m = observe(session, state);
    if (m) {
      if (want(m)) return m;
      timeout(session, state);
    }
    tick(state);
  }
  throw new Error("no matching moment found");
}

describe("recognition", () => {
  it("forms moments only from live eligible states, with at least two options each", () => {
    const { session, state } = playMatch(3, "CM", "random");
    expect(isFinished(state)).toBe(true);
    for (const r of session.records) {
      expect(r.moment.options.length).toBeGreaterThanOrEqual(2);
      // options are generated from the state: labels vary and none is flagged as the answer
      const labels = new Set(r.moment.options.map((o) => o.label));
      expect(labels.size).toBe(r.moment.options.length);
      for (const o of r.moment.options) expect(o).not.toHaveProperty("correct");
      expect(r.moment.cues.length).toBeGreaterThan(0);
    }
    expect(session.rejects.ball_dead ?? 0).toBeGreaterThanOrEqual(0);
    expect(session.rejects.not_open_play).toBeGreaterThan(0);
  });

  it("paces a full match into the 12–18 direct-involvement range, primarily on the ball, for outfield roles", () => {
    for (const [seed, role] of [[1, "CM"], [2, "ST"], [3, "RW"], [4, "DM"]] as const) {
      const { session } = playMatch(seed, role, "random");
      const rep = coverageReport(session.records, session.pacing);
      expect(rep.total, `${role} total`).toBeGreaterThanOrEqual(DIRECT_PACING.total[0]);
      expect(rep.total, `${role} total`).toBeLessThanOrEqual(DIRECT_PACING.total[1]);
      expect(rep.onBall, `${role} on-ball`).toBeGreaterThanOrEqual(rep.total - DIRECT_PACING.direct!.maxOffBall);
      expect(rep.uniqueEntries, `${role} variety`).toBeGreaterThanOrEqual(3);
    }
  });

  it("spreads moments across the match rather than front-loading them", () => {
    const { session, state } = playMatch(5, "CM", "random");
    const total = state.clock.timeMs;
    const firstHalf = session.records.filter((r) => r.moment.timeMs < total / 2).length;
    expect(firstHalf).toBeGreaterThanOrEqual(4);
    expect(firstHalf).toBeLessThanOrEqual(session.records.length - 4);
  });

  it("records shortfalls instead of manufacturing moments", () => {
    const { session } = playMatch(2, "GK", "random");
    const rep = coverageReport(session.records, GK_DIRECT_PACING);
    expect(rep.total).toBeGreaterThanOrEqual(GK_DIRECT_PACING.total[0]);
    expect(rep.total).toBeLessThanOrEqual(GK_DIRECT_PACING.total[1]);
    // the keeper's on-ball share depends on how often the engine's AI plays the ball back: any gap is stated, not papered over
    if (rep.onBall < GK_DIRECT_PACING.onBall[0]) expect(rep.shortfalls.some((s) => /on-ball/.test(s))).toBe(true);
    else expect(rep.shortfalls.some((s) => /on-ball/.test(s))).toBe(false);
    const empty = coverageReport([]);
    expect(empty.shortfalls.some((s) => /only 0 moments/.test(s))).toBe(true);
    expect(empty.shortfalls.some((s) => /on-ball/.test(s))).toBe(true);
  });

  it("assigns easy/medium/hard from clarity, alternatives, pressure and stakes", () => {
    const { session } = playMatch(1, "ST", "random");
    const rep = coverageReport(session.records);
    expect(rep.byDifficulty.easy + rep.byDifficulty.medium + rep.byDifficulty.hard).toBe(rep.total);
    expect(rep.byDifficulty.hard).toBeGreaterThan(0);
    expect(rep.byDifficulty.easy).toBeGreaterThan(0);
    const clear = difficultyOf(
      [
        { id: "a", actionId: "a", label: "A", intent: "recycle", drawn: true, command: { type: "hold" }, anchor: null, score: 1, feasibility: 1, reasons: [] },
        { id: "b", actionId: "b", label: "B", intent: "hold_ball", drawn: false, command: { type: "hold" }, anchor: null, score: 0, feasibility: 1, reasons: [] },
      ],
      { ...session.records[0]!.moment.read, pressure: 0, shotWindow: 0 },
    );
    expect(clear.band).toBe("easy");
  });

  it("is deterministic for a given seed and scripted user", () => {
    const a = playMatch(9, "LW", "random");
    const b = playMatch(9, "LW", "random");
    expect(a.session.records.map((r) => [r.moment.entryId, r.moment.tick, r.decision.band, r.outcome?.result])).toEqual(
      b.session.records.map((r) => [r.moment.entryId, r.moment.tick, r.decision.band, r.outcome?.result]),
    );
  });

  it("rejects when there is no controlled player or play is not live", () => {
    const state = createMatch(testConfig(1));
    expect(recognize(state, catalog, createRecognizer()).reject).toBe("no_controlled_player");
    const { state: s2 } = controlledMatch(1, "CM");
    expect(recognize(s2, catalog, createRecognizer()).reject).toBe("not_open_play");
  });
});

describe("moment lifecycle", () => {
  it("suspends the controlled player's AI while a moment is pending and resumes after commit", () => {
    const { session, suspendedTicks, leakedAiTicks, state } = playMatch(1, "CM", "random");
    expect(session.records.length).toBeGreaterThan(0);
    expect(suspendedTicks).toBeGreaterThan(0);
    expect(leakedAiTicks).toBe(0);
    expect(state.awaiting).toBeNull();
  });

  it("selecting an answer is the whole action: commit issues exactly that option's engine command, attributed to the user", () => {
    const { state, me } = controlledMatch(1, "CM");
    const session = createSession(catalog, pacingFor("CM"));
    const m = nextMoment(session, state, (x) => x.read.hasBall === 1);
    expect(state.awaiting).toBe(me);
    const pick = m.options[0]!;
    const res = commit(session, state, pick.id);
    expect(res.status).toBe("committed");
    expect(res.acted?.actor).toBe("user");
    expect(res.acted?.optionId).toBe(pick.id);
    expect(res.issued?.type).toBe(pick.command.type);
    expect(state.commands[me]?.command).toEqual(res.issued);
    // no manual execution input exists: the engine executes at full intent precision
    expect(state.commands[me]?.accuracy).toBe(1);
    expect(state.awaiting).toBeNull();
    expect(session.active).toBeNull();
    const last = session.records[session.records.length - 1]!;
    expect(last.moment.id).toBe(m.id);
    expect(last.execution?.actor).toBe("user");
  });

  it("grades the decision against the field at commit time, not the moment start", () => {
    const { state } = controlledMatch(2, "CM");
    const session = createSession(catalog);
    const m = nextMoment(session, state, (x) => x.read.hasBall === 1);
    const startTick = m.tick;
    for (let i = 0; i < 6; i++) tick(state); // the field moves during slow motion
    const pick = m.options[0]!;
    const res = commit(session, state, pick.id);
    expect(res.decision.commitTick).toBe(startTick + 6);
    expect(res.decision.commitTick).toBeGreaterThan(m.tick);
    // rescoring uses the live state: recomputing from the moment-start snapshot is not what is stored
    const rescored = gradeDecision(state, catalog, m, pick.id);
    expect(res.decision.quality).toBe(rescored.quality);
  });

  it("separates decision, execution and outcome: a strong read can still fail and a weak one succeed", () => {
    const records: MomentRecord[] = [];
    for (const seed of [1, 2, 3, 4]) records.push(...playMatch(seed, "CM", "random").session.records);
    const settled = records.filter((r) => r.outcome && r.decision.quality !== null);
    expect(settled.length).toBeGreaterThan(30);
    expect(settled.some((r) => r.decision.band === "strong" && r.outcome!.result === "failure")).toBe(true);
    expect(settled.some((r) => r.decision.band === "weak" && r.outcome!.result === "success")).toBe(true);
    for (const r of settled) {
      expect(r.decision.momentId).toBe(r.moment.id);
      expect(r.outcome!.momentId).toBe(r.moment.id);
      if (r.execution) expect(r.execution.momentId).toBe(r.moment.id);
    }
    // outcomes come from the event stream
    expect(settled.every((r) => r.outcome!.resolvedTick > r.decision.commitTick)).toBe(true);
  });

  it("best-policy user grades strong; random user does not", () => {
    const best = coverageReport(playMatch(4, "ST", "best").session.records);
    const rnd = coverageReport(playMatch(4, "ST", "random").session.records);
    expect(best.decisions.strong).toBeGreaterThan(best.decisions.weak);
    expect(best.decisions.strong / best.total).toBeGreaterThan(rnd.decisions.strong / rnd.total);
  });

  it("resolves a timeout through an engine-selected continuation: no user grade, execution attributed to the engine", () => {
    const { session, state } = playMatch(6, "CB", "timeout", 24000);
    expect(session.records.length).toBeGreaterThan(0);
    for (const r of session.records) {
      expect(r.decision.band).toBe("timeout");
      expect(r.decision.quality).toBeNull();
      expect(r.decision.chosenOptionId).toBeNull();
      if (r.execution) expect(r.execution.actor).toBe("engine");
    }
    expect(state.awaiting).toBeNull();
    const rep = coverageReport(session.records);
    expect(rep.decisions.timeout).toBe(rep.total);
  });

  it("records intent_unavailable separately from timeout when the field has moved on", () => {
    const { state } = controlledMatch(3, "ST");
    const session = createSession(catalog);
    const m = nextMoment(session, state, (x) => x.read.hasBall === 1 && x.options.some((o) => o.intent === "shoot"));
    // strip the ball away: the shot is no longer available at commit
    const opp = opponents(state, "home")[0]!;
    state.ball = { ...state.ball, status: "controlled", owner: opp.id, lastTouch: opp.id, lastTouchSide: "away" };
    state.possession = "away";
    const shoot = m.options.find((o) => o.intent === "shoot")!;
    const res = commit(session, state, shoot.id);
    expect(res.status).toBe("intent_unavailable");
    expect(res.decision.band).toBe("intent_unavailable");
    expect(res.decision.chosenOptionId).toBe(shoot.id);
    expect(res.decision.quality).toBeNull();
    if (res.acted) expect(res.acted.actor).toBe("engine");
    const last = session.records[session.records.length - 1]!;
    if (last.execution) expect(last.execution.actor).toBe("engine");
  });

  it("feedback describes the field first and the outcome last", () => {
    const { session } = playMatch(1, "RB", "random");
    const r = session.records.find((x) => x.outcome && x.decision.band === "weak");
    expect(r).toBeDefined();
    const lines = feedbackFor(session, r!);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatch(/:/);
    expect(lines.some((l) => l.startsWith("Outcome:"))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/^(Outcome:|Common trap:)/);
  });

  it("feedback speaks in field conditions, never in engine telemetry, and never claims a ball action for an off-ball moment", () => {
    expect(coachReasons(["a forward lane is open", "lane margin 0.32 s; receiver space 0.79; to feet"])).toBe("a forward lane is open");
    expect(coachReasons(["space 0.51 ahead; pressure 0.08 at end; open space to attack"])).toBe("open space to attack");
    expect(coachReasons(["shot window 12°; 15 m from goal"])).toBe("no field condition stood out either way");
    for (const role of ["GK", "CM", "ST"] as RoleId[]) {
      const { session } = playMatch(role === "GK" ? 2001 : 2000, role, "random");
      for (const r of session.records) {
        const lines = feedbackFor(session, r);
        for (const l of lines) expect(l, `${role} ${r.moment.entryId}: ${l}`).not.toMatch(/\d\.\d|\d°/);
        if (r.outcome && r.moment.read.hasBall !== 1) {
          expect(r.outcome.summary, `${role} ${r.moment.entryId}`).not.toMatch(/^(Held the ball|Carried|Took the touch)/);
        }
      }
    }
  });
});

describe("grading primitives", () => {
  it("execution is graded from the character's kick evidence, else pressure and fatigue — never from any user input", () => {
    const { state, me } = controlledMatch(1, "CM");
    const p = playerById(state, me)!;
    const committed: CommittedIntent = { momentId: "m", actor: "user", optionId: "m:x", label: "x", command: { type: "hold" }, commitTick: 0 };
    const clean = gradeExecution(state, p, committed, null);
    expect(clean.band).toBe("clean");
    expect(clean.actor).toBe("user");
    const tired = gradeExecution(state, { ...p, fatigue: 1 }, committed, null);
    expect(tired.quality).toBeLessThan(clean.quality);
    expect(gradeExecution(state, p, committed, 0.9).band).toBe("poor");
    expect(gradeExecution(state, p, committed, 0.05).band).toBe("clean");
    expect(gradeExecution(state, p, { ...committed, actor: "engine" }, null).actor).toBe("engine");
  });

  it("outcomes wait for the observation window and then read events", () => {
    const { state, me } = controlledMatch(1, "CM");
    const session = createSession(catalog);
    const m = nextMoment(session, state, (x) => x.read.hasBall === 1);
    const res = commit(session, state, m.options[0]!.id);
    expect(resolveOutcome(state, m, res.acted)).toBeNull();
    for (let i = 0; i < 81; i++) tick(state);
    const out = resolveOutcome(state, m, res.acted);
    expect(out).not.toBeNull();
    expect(["success", "partial", "failure", "neutral"]).toContain(out!.result);
    expect(out!.eventIds.every((id) => state.events.some((e) => e.id === id))).toBe(true);
    // a goal for the player's side in the window dominates
    state.events.push({ id: "fake", tick: res.acted!.commitTick + 1, type: "goal", side: "home", scorer: me, assist: null });
    expect(resolveOutcome(state, m, res.acted)!.result).toBe("success");
  });
});

describe("features and intents", () => {
  it("reads the live field for the controlled player", () => {
    const { state, me } = controlledMatch(2, "CM");
    const session = createSession(catalog);
    nextMoment(session, state, (x) => x.read.hasBall === 1);
    const p = playerById(state, me)!;
    const read = readField(state, p);
    expect(read.hasBall).toBe(1);
    expect(read.ourPossession).toBe(1);
    expect(read.theirPossession).toBe(0);
    expect(read.pressure).toBeGreaterThanOrEqual(0);
    expect(read.pressure).toBeLessThanOrEqual(1);
    expect(read.nearestOppDist).toBeGreaterThan(0);
    expect(read.distToGoal).toBeGreaterThan(0);
    expect(read.minute).toBeGreaterThanOrEqual(0);
  });

  it("instantiates role-appropriate intents and refuses the rest", () => {
    const { state, me } = controlledMatch(2, "CM");
    const session = createSession(catalog);
    nextMoment(session, state, (x) => x.read.hasBall === 1);
    const p = playerById(state, me)!;
    const recycle = instantiateIntent(state, p, "recycle");
    if (recycle) expect(recycle.command.type).toBe("pass");
    expect(instantiateIntent(state, p, "hold_ball")?.command.type).toBe("hold");
    expect(instantiateIntent(state, p, "keeper_sweep")).toBeNull();
    expect(instantiateIntent(state, p, "keeper_distribute_short")).toBeNull();
    expect(instantiateIntent(state, p, "first_touch_forward")).toBeNull(); // not receiving
    expect(instantiateIntent(state, p, "press")).toBeNull(); // we have the ball
    const carry = instantiateIntent(state, p, "attack_space");
    if (carry) {
      expect(carry.command.type).toBe("carry");
      expect(carry.anchor).not.toBeNull();
    }
  });
});
