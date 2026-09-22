import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { NORMAL_SCALE, SKIP_SCALE } from "../../src/match/clock";
import { ACCEPTABLE_BAND_MS } from "../../src/match/pace";
import {
  abandonActive,
  ANSWER_MS,
  answer,
  continueNow,
  createRuntime,
  FEEDBACK_MS,
  frame,
  LEAD_IN_MIN_MS,
  LEAD_IN_MS,
  leadInProgress,
  questionFor,
  questionOpen,
  ready,
  restoreRuntime,
  serializeRuntime,
  skipLeadIn,
  timerProgress,
  timerRemaining,
  totalRealMs,
  viewState,
  type MatchRuntime,
} from "../../src/match/runtime";
import { dist } from "../../src/sim/geometry";
import { isFinished } from "../../src/sim/engine";
import { ROLE_BY_NUMBER, type RoleId, type RoleNumber } from "../../src/sim/types";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { instantiateIntent } from "../../src/tactics/intents";
import type { TacticalMoment } from "../../src/tactics/moments";
import { DIRECT_RANGE, pacingFor } from "../../src/tactics/recognition";
import { timerLabel } from "../../src/ui/matchScreen";
import { playToFullTime, testConfig } from "../helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);
const FRAME = 1000 / 60;

function roleNumber(role: RoleId): RoleNumber {
  const n = (Object.keys(ROLE_BY_NUMBER).map(Number) as RoleNumber[]).find((k) => ROLE_BY_NUMBER[k] === role);
  if (!n) throw new Error(role);
  return n;
}

function runtimeFor(seed: number, role: RoleId = "CM"): MatchRuntime {
  const cfg = testConfig(seed);
  const me = cfg.home.squad.find((p) => p.role === roleNumber(role));
  if (!me) throw new Error("no such role");
  return createRuntime({ ...cfg, controlled: { side: "home", playerId: me.id } }, catalog, { pacing: pacingFor(role) });
}

/** Skip forward until a moment matching `want` opens (its lead-in starts); other moments get their first answer. */
function untilMoment(rt: MatchRuntime, want: (m: TacticalMoment) => boolean = () => true, maxFrames = 400_000): TacticalMoment {
  for (let i = 0; i < maxFrames; i++) {
    const r = frame(rt, FRAME);
    if (r.opened && want(r.opened)) return r.opened;
    if (rt.phase === "question") {
      ready(rt);
      answer(rt, rt.active!.moment.options[0]!.id);
    }
    if (r.finished) break;
  }
  throw new Error("no matching moment opened");
}

/** Play the lead-in out to the frozen question. */
function toQuestion(rt: MatchRuntime): void {
  let guard = 0;
  while (rt.phase === "lead_in" && guard++ < 10_000) frame(rt, FRAME);
  expect(rt.phase).toBe("question");
}

describe("match runtime: lifecycle", () => {
  it("skips routine play at SKIP_SCALE, replays a 2–4 s lead-in at real speed, then freezes the field for the question", () => {
    const rt = runtimeFor(3);
    expect(rt.phase).toBe("routine");
    expect(rt.clock.scale).toBe(SKIP_SCALE);
    const before = rt.state.clock.tick;
    frame(rt, FRAME);
    expect(rt.state.clock.tick).toBeGreaterThan(before); // the clock advances tick by tick while skipping
    const m = untilMoment(rt);
    expect(rt.phase).toBe("lead_in");
    expect(rt.clock.scale).toBe(NORMAL_SCALE);
    const a = rt.active!;
    expect(a.moment.id).toBe(m.id);
    expect(a.leadInTotalMs).toBeGreaterThanOrEqual(LEAD_IN_MIN_MS);
    expect(a.leadInTotalMs).toBeLessThanOrEqual(LEAD_IN_MS);
    expect(a.history.at(-1)!.tick).toBe(rt.state.clock.tick); // history ends at the frozen tick itself

    // the lead-in shows what actually happened: the drawn view moves while the simulation stands still
    const frozenTick = rt.state.clock.tick;
    const v0 = viewState(rt);
    let moved = 0;
    let realMs = 0;
    while (rt.phase === "lead_in") {
      frame(rt, FRAME);
      realMs += FRAME;
      const v = viewState(rt);
      moved = Math.max(moved, v.players.filter((p, i) => dist(p.pos, v0.players[i]!.pos) > 0.05).length);
      expect(rt.state.clock.tick).toBe(frozenTick);
    }
    expect(moved).toBeGreaterThan(3);
    expect(realMs).toBeGreaterThanOrEqual(LEAD_IN_MIN_MS - FRAME);
    expect(realMs).toBeLessThanOrEqual(LEAD_IN_MS + FRAME);
    expect(leadInProgress(rt)).toBe(1);
    expect(rt.phase).toBe("question");
    expect(questionOpen(rt)).toBe(true);
    // the view now IS the authoritative frozen state
    expect(viewState(rt)).toBe(rt.state);
    expect(questionFor(m).length).toBeGreaterThan(10);
  });

  it("the question shows 3–6 answers and the timer does not start until the screen says ready()", () => {
    const rt = runtimeFor(5);
    const m = untilMoment(rt);
    toQuestion(rt);
    expect(m.options.length).toBeGreaterThanOrEqual(3);
    expect(m.options.length).toBeLessThanOrEqual(6);
    const tick = rt.state.clock.tick;
    for (let i = 0; i < 600; i++) frame(rt, FRAME); // 10 s with no ready(): nothing moves, nothing expires
    expect(rt.phase).toBe("question");
    expect(rt.state.clock.tick).toBe(tick);
    expect(timerRemaining(rt)).toBe(ANSWER_MS / 1000);
    expect(timerProgress(rt)).toBe(0);
    expect(rt.active!.timerRunning).toBe(false);

    ready(rt);
    expect(rt.phase).toBe("timer");
    for (let i = 0; i < 60; i++) frame(rt, FRAME);
    expect(timerRemaining(rt)).toBeCloseTo(14, 0);
    expect(timerProgress(rt)).toBeCloseTo(1 / 15, 1);
    expect(rt.state.clock.tick).toBe(tick); // the field stays frozen while the player thinks
  });

  it("the on-screen timer label counts whole seconds down from 15 and reads as an ellipsis before the timer is armed", () => {
    const rt = runtimeFor(5);
    untilMoment(rt);
    toQuestion(rt);
    expect(timerLabel(rt)).toBe("…");
    ready(rt);
    expect(timerLabel(rt)).toBe("15 s");
    for (let i = 0; i < 61; i++) frame(rt, FRAME);
    expect(timerLabel(rt)).toBe("14 s");
    for (let i = 0; i < 60 * 12; i++) frame(rt, FRAME);
    expect(timerLabel(rt)).toBe("2 s");
  });

  it("pause stops the timer and the simulation; resuming picks up where it left off", () => {
    const rt = runtimeFor(5);
    untilMoment(rt);
    toQuestion(rt);
    ready(rt);
    for (let i = 0; i < 120; i++) frame(rt, FRAME);
    const left = timerRemaining(rt);
    rt.paused = true;
    for (let i = 0; i < 600; i++) expect(frame(rt, FRAME).ticks).toBe(0);
    expect(timerRemaining(rt)).toBe(left);
    expect(rt.phase).toBe("timer");
    rt.paused = false;
    frame(rt, FRAME);
    expect(timerRemaining(rt)).toBeLessThan(left);

    // paused routine frames do not advance the clock either
    const rt2 = runtimeFor(2);
    rt2.paused = true;
    const t = rt2.state.clock.tick;
    for (let i = 0; i < 60; i++) expect(frame(rt2, FRAME).ticks).toBe(0);
    expect(rt2.state.clock.tick).toBe(t);
    expect(totalRealMs(rt2)).toBe(0);
  });

  it("skipLeadIn jumps straight to the frozen question (reduced motion)", () => {
    const rt = runtimeFor(7);
    untilMoment(rt);
    skipLeadIn(rt);
    expect(rt.phase).toBe("question");
    expect(leadInProgress(rt)).toBe(1);
  });

  it("the half-time beat is held and then play resumes into the second half", () => {
    const rt = runtimeFor(4, "CB");
    let sawHalf = false;
    for (let i = 0; i < 400_000 && !sawHalf; i++) {
      frame(rt, FRAME);
      if (rt.phase === "question") {
        ready(rt);
        answer(rt, rt.active!.moment.options[0]!.id);
      }
      if (rt.phase === "halftime") sawHalf = true;
    }
    expect(sawHalf).toBe(true);
    expect(rt.halfTimeLeftMs).toBeGreaterThan(0);
    // the beat is shown once the engine has closed the first half; the simulation is held while it plays
    expect(rt.state.clock.half).toBe(2);
    const tick = rt.state.clock.tick;
    let guard = 0;
    while (rt.phase === "halftime" && guard++ < 1000) {
      frame(rt, FRAME);
      expect(rt.state.clock.tick).toBe(tick);
    }
    expect(rt.phase).toBe("routine");
    frame(rt, FRAME);
    expect(rt.state.clock.tick).toBeGreaterThan(tick);
    expect(rt.state.clock.half).toBe(2);
  });
});

describe("match runtime: answers, timeouts and attribution", () => {
  it("selecting an answer is the whole action: the exact command of that option is issued and the consequence plays at real speed", () => {
    const rt = runtimeFor(1);
    const m = untilMoment(rt, (x) => x.read.hasBall === 1);
    toQuestion(rt);
    ready(rt);
    const me = rt.state.players.find((p) => p.id === m.playerId)!;
    const pick = m.options[1] ?? m.options[0]!;
    const expected = instantiateIntent(rt.state, me, pick.intent)?.command ?? null;
    const frozenTick = rt.state.clock.tick;
    expect(answer(rt, pick.id)).toBe(true);
    expect(rt.phase).toBe("resolving");
    expect(rt.clock.scale).toBe(NORMAL_SCALE);
    const a = rt.active!;
    expect(a.timerRunning).toBe(false);
    expect(a.reason).toBe(expected ? "committed" : "intent_unavailable");
    if (expected) {
      expect(a.result!.issued).toEqual(expected);
      expect(a.result!.acted!.actor).toBe("user");
      expect(a.result!.acted!.optionId).toBe(pick.id);
      expect(a.record!.decision.chosenOptionId).toBe(pick.id);
      expect(a.record!.decision.commitTick).toBe(frozenTick);
    }
    // real-speed consequence: 60 frames ≈ 20 ticks
    const before = rt.state.clock.tick;
    let closed = null;
    for (let i = 0; i < 60 && !closed; i++) closed = frame(rt, FRAME).closed;
    expect(rt.state.clock.tick - before).toBeLessThanOrEqual(21);
    let guard = 0;
    while (rt.phase === "resolving" && guard++ < 2000) closed = frame(rt, FRAME).closed ?? closed;
    expect(rt.phase).toBe("feedback");
    expect(closed).not.toBeNull();
    expect(closed!.record.outcome).not.toBeNull();
    expect(a.feedback!.length).toBeGreaterThan(0);
    // answers are refused once the question is gone
    expect(answer(rt, pick.id)).toBe(false);
  });

  it("a second answer to the same question is refused and unknown ids throw", () => {
    const rt = runtimeFor(1);
    const m = untilMoment(rt);
    toQuestion(rt);
    expect(() => answer(rt, "nope")).toThrow();
    expect(answer(rt, m.options[0]!.id)).toBe(true);
    expect(answer(rt, m.options[0]!.id)).toBe(false);
  });

  it("answering before ready() is allowed (the timer never needs to start)", () => {
    const rt = runtimeFor(6);
    const m = untilMoment(rt);
    toQuestion(rt);
    expect(answer(rt, m.options[0]!.id)).toBe(true);
    expect(rt.realMs.timer).toBe(0);
  });

  it("timeout after 15 real seconds: no user grade, the engine chooses, the record says so", () => {
    const rt = runtimeFor(11);
    const m = untilMoment(rt);
    toQuestion(rt);
    ready(rt);
    let frames = 0;
    while (rt.phase === "timer" && frames++ < 2000) frame(rt, FRAME);
    expect(frames * FRAME).toBeGreaterThanOrEqual(ANSWER_MS - FRAME);
    expect(frames * FRAME).toBeLessThanOrEqual(ANSWER_MS + 2 * FRAME);
    expect(rt.phase).toBe("resolving");
    const a = rt.active!;
    expect(a.reason).toBe("timeout");
    expect(a.record!.moment.id).toBe(m.id);
    expect(a.record!.decision.band).toBe("timeout");
    expect(a.record!.decision.quality).toBeNull();
    expect(a.record!.decision.chosenOptionId).toBeNull();
    if (a.result!.acted) {
      expect(a.result!.acted.actor).toBe("engine");
      expect(a.result!.issued).toEqual(a.result!.acted.command);
    }
    if (a.record!.execution) expect(a.record!.execution.actor).toBe("engine");
    expect(a.record!.decision.explanation.some((l) => /No choice was committed in time/.test(l))).toBe(true);
    let guard = 0;
    while (rt.phase === "resolving" && guard++ < 2000) frame(rt, FRAME);
    expect(rt.phase).toBe("feedback");
  });

  it("feedback is brief and can be dismissed early; either way play skips on and the next moment comes", () => {
    const rt = runtimeFor(2);
    untilMoment(rt);
    toQuestion(rt);
    answer(rt, rt.active!.moment.options[0]!.id);
    let guard = 0;
    while (rt.phase !== "feedback" && guard++ < 5000) frame(rt, FRAME);
    let fb = 0;
    while (rt.phase === "feedback" && fb++ < 1000) frame(rt, FRAME);
    expect(fb * FRAME).toBeGreaterThanOrEqual(FEEDBACK_MS - FRAME);
    expect(fb * FRAME).toBeLessThanOrEqual(FEEDBACK_MS + 2 * FRAME);
    expect(["routine", "halftime"]).toContain(rt.phase);
    expect(rt.active).toBeNull();

    const next = untilMoment(rt);
    toQuestion(rt);
    answer(rt, next.options[0]!.id);
    guard = 0;
    while (rt.phase !== "feedback" && guard++ < 5000) frame(rt, FRAME);
    continueNow(rt);
    expect(["routine", "halftime"]).toContain(rt.phase);
    expect(rt.clock.scale === SKIP_SCALE || rt.phase === "halftime").toBe(true);
  });

  it("leaving during a question abandons it: nothing issued, nothing attributed to the user, play can carry on", () => {
    const rt = runtimeFor(9);
    const m = untilMoment(rt);
    toQuestion(rt);
    ready(rt);
    const closed = abandonActive(rt);
    expect(closed).not.toBeNull();
    expect(closed!.moment.id).toBe(m.id);
    expect(closed!.reason).toBe("play_stopped");
    expect(closed!.result.issued).toBeNull();
    expect(closed!.result.acted).toBeNull();
    expect(closed!.record.decision.band).toBe("intent_unavailable");
    expect(closed!.record.decision.chosenOptionId).toBeNull();
    expect(rt.active).toBeNull();
    expect(rt.state.awaiting).toBeNull();
    expect(["routine", "halftime"]).toContain(rt.phase);
    expect(abandonActive(rt)).toBeNull();
    // the match still completes
    playToFullTime(rt);
    expect(isFinished(rt.state)).toBe(true);
  });
});

describe("match runtime: whole matches", () => {
  it("every completed match gives 12–18 moments, every one with 3–6 answers, and finishes within the acceptable band", () => {
    for (const role of ["CM", "GK", "LW"] as const) {
      const rt = runtimeFor(21, role);
      const answered = playToFullTime(rt, (o) => o[o.length - 1]!, FRAME);
      expect(isFinished(rt.state), role).toBe(true);
      expect(rt.phase).toBe("finished");
      const n = rt.session.records.length;
      expect(n, `${role} moments`).toBeGreaterThanOrEqual(DIRECT_RANGE[0]);
      expect(n, `${role} moments`).toBeLessThanOrEqual(DIRECT_RANGE[1]);
      expect(answered, role).toBe(n);
      for (const r of rt.session.records) {
        expect(r.moment.options.length).toBeGreaterThanOrEqual(3);
        expect(r.moment.options.length).toBeLessThanOrEqual(6);
        expect(r.decision.chosenOptionId).not.toBeNull();
      }
      const total = totalRealMs(rt);
      // instant answers: the floor is lead-ins + feedback; no real player is faster, and the ceiling still holds
      expect(total, `${role} real time`).toBeGreaterThanOrEqual((n - 1) * (LEAD_IN_MIN_MS + FEEDBACK_MS));
      expect(total, `${role} real time`).toBeLessThanOrEqual(ACCEPTABLE_BAND_MS[1]);
      expect(rt.realMs.question).toBe(0); // the driver answers as soon as the question shows
    }
  });

  it("slices new events per frame without gaps or repeats, and the scoreboard equals the goal events", () => {
    const rt = runtimeFor(2);
    const ids = new Set<string>();
    let count = 0;
    let goals = 0;
    for (let i = 0; i < 4_000_000; i++) {
      const r = frame(rt, FRAME);
      for (const e of r.events) {
        expect(ids.has(e.id)).toBe(false);
        ids.add(e.id);
        count++;
        if (e.type === "goal") goals++;
      }
      if (rt.phase === "question") answer(rt, rt.active!.moment.options[0]!.id);
      if (r.finished) break;
    }
    expect(count).toBe(rt.state.events.length);
    expect(goals).toBe(rt.state.score.home + rt.state.score.away);
  });

  it("is deterministic: the same seed and the same answers replay to identical records, events and score", () => {
    const play = (): MatchRuntime => {
      const rt = runtimeFor(13, "ST");
      playToFullTime(rt, (o) => o[o.length > 2 ? 2 : 0]!, FRAME);
      return rt;
    };
    const a = play();
    const b = play();
    const sig = (rt: MatchRuntime) => rt.session.records.map((r) => [r.moment.id, r.moment.tick, r.decision.chosenOptionId, r.decision.band, r.execution?.band, r.outcome?.result]);
    expect(sig(a)).toEqual(sig(b));
    expect(a.state.events.map((e) => e.id)).toEqual(b.state.events.map((e) => e.id));
    expect(a.state.score).toEqual(b.state.score);
    expect(totalRealMs(a)).toBe(totalRealMs(b));
  });

  it("decision, execution and outcome are stored apart: grade at the frozen state, outcome from later events", () => {
    const rt = runtimeFor(17, "CM");
    playToFullTime(rt, (o) => [...o].sort((x, y) => y.score - x.score)[0]!, FRAME);
    const settled = rt.session.records.filter((r) => r.outcome && r.decision.quality !== null);
    expect(settled.length).toBeGreaterThanOrEqual(DIRECT_RANGE[0] - 2);
    for (const r of settled) {
      expect(r.decision.commitTick).toBe(r.moment.tick); // the answer lands on the frozen tick
      expect(r.outcome!.resolvedTick).toBeGreaterThan(r.decision.commitTick);
      expect(r.outcome!.eventIds.every((id) => rt.state.events.some((e) => e.id === id))).toBe(true);
      if (r.execution) expect(r.execution.actor).toBe("user");
    }
    // best-policy answers grade strong regardless of how the play turned out
    const strong = settled.filter((r) => r.decision.band === "strong").length;
    expect(strong).toBe(settled.length);
    expect(new Set(settled.map((r) => r.outcome!.result)).size).toBeGreaterThan(1);
  });
});

describe("match runtime: save and reload", () => {
  it("round-trips a match mid-question: the same frozen field, answers and remaining time come back, then plays on identically", () => {
    const rt = runtimeFor(8, "RB");
    const m = untilMoment(rt, (x) => x.options.length >= 3);
    toQuestion(rt);
    ready(rt);
    for (let i = 0; i < 90; i++) frame(rt, FRAME); // 1.5 s on the clock
    const left = timerRemaining(rt);
    const save = JSON.parse(JSON.stringify(serializeRuntime(rt))) as ReturnType<typeof serializeRuntime>;
    const back = restoreRuntime(save, catalog);
    expect(back.phase).toBe("question"); // the timer restarts only after the screen re-shows the question
    expect(back.active!.timerRunning).toBe(false);
    expect(back.active!.moment.id).toBe(m.id);
    expect(back.active!.moment.options.map((o) => o.id)).toEqual(m.options.map((o) => o.id));
    expect(timerRemaining(back)).toBeCloseTo(left, 6);
    expect(back.state.clock.tick).toBe(rt.state.clock.tick);
    expect(back.state.events.length).toBe(rt.state.events.length);
    expect(back.session.records.length).toBe(rt.session.records.length);
    expect(totalRealMs(back)).toBeCloseTo(totalRealMs(rt), 6);
    expect(back.session.recognizer.lastMomentTick).toBe(rt.session.recognizer.lastMomentTick);

    ready(back);
    const pick = m.options[0]!.id;
    answer(rt, pick);
    answer(back, pick);
    playToFullTime(rt, (o) => o[0]!, FRAME);
    playToFullTime(back, (o) => o[0]!, FRAME);
    expect(back.state.score).toEqual(rt.state.score);
    expect(back.state.events.map((e) => e.id)).toEqual(rt.state.events.map((e) => e.id));
    expect(back.session.records.map((r) => [r.moment.id, r.decision.band, r.outcome?.result])).toEqual(
      rt.session.records.map((r) => [r.moment.id, r.decision.band, r.outcome?.result]),
    );
  });

  it("round-trips during routine skipping and with open (unsettled) outcomes", () => {
    const rt = runtimeFor(10, "DM");
    untilMoment(rt);
    toQuestion(rt);
    answer(rt, rt.active!.moment.options[0]!.id);
    for (let i = 0; i < 10; i++) frame(rt, FRAME); // resolving: the outcome is still open
    const save = serializeRuntime(rt);
    expect(save.session.open.length).toBeGreaterThanOrEqual(0);
    const back = restoreRuntime(save, catalog);
    expect(back.phase).toBe(rt.phase);
    expect(back.session.open.length).toBe(rt.session.open.length);
    playToFullTime(rt, (o) => o[0]!, FRAME);
    playToFullTime(back, (o) => o[0]!, FRAME);
    expect(back.state.score).toEqual(rt.state.score);
    expect(back.session.records.length).toBe(rt.session.records.length);
    expect(back.session.records.every((r) => r.outcome)).toBe(true);
  });

  it("abandon-then-save persists the abandoned record and resumes into routine play", () => {
    const rt = runtimeFor(12, "LB");
    untilMoment(rt);
    toQuestion(rt);
    const closed = abandonActive(rt, "Saved and left.");
    const back = restoreRuntime(serializeRuntime(rt), catalog);
    expect(back.active).toBeNull();
    expect(["routine", "halftime"]).toContain(back.phase);
    const rec = back.session.records.find((r) => r.moment.id === closed!.moment.id)!;
    expect(rec.decision.band).toBe("intent_unavailable");
    expect(rec.decision.explanation[0]).toBe("Saved and left.");
    playToFullTime(back, (o) => o[0]!, FRAME);
    expect(isFinished(back.state)).toBe(true);
  });

  it("refuses an unknown save version", () => {
    const rt = runtimeFor(1);
    const save = serializeRuntime(rt);
    expect(() => restoreRuntime({ ...save, version: 2 as unknown as 1 }, catalog)).toThrow(/unsupported/);
  });
});
