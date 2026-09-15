import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { FAST_SCALE_MAX, NORMAL_SCALE, SLOW_SCALE } from "../../src/match/clock";
import { DEFAULT_PACE } from "../../src/match/pace";
import {
  ACCESSIBLE_WINDOW_FACTOR,
  cancel,
  createRuntime,
  frame,
  liveAnchor,
  previewGesture,
  releaseGesture,
  select,
  setAccessible,
  tapTarget,
  TICKS_PER_SECOND,
  WINDOW_SECONDS,
  windowRemaining,
  type MatchRuntime,
} from "../../src/match/runtime";
import { dist, type Vec2 } from "../../src/sim/geometry";
import { playerById } from "../../src/sim/perception";
import { ROLE_BY_NUMBER, type RoleId, type RoleNumber } from "../../src/sim/types";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import type { TacticalMoment, TacticalOption } from "../../src/tactics/moments";
import { pacingFor } from "../../src/tactics/recognition";
import { testConfig } from "../helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);
const FRAME = 1000 / 60;

function roleNumber(role: RoleId): RoleNumber {
  const n = (Object.keys(ROLE_BY_NUMBER).map(Number) as RoleNumber[]).find((k) => ROLE_BY_NUMBER[k] === role);
  if (!n) throw new Error(role);
  return n;
}

function runtimeFor(seed: number, role: RoleId = "CM", accessible = false): MatchRuntime {
  const cfg = testConfig(seed);
  const me = cfg.home.squad.find((p) => p.role === roleNumber(role));
  if (!me) throw new Error("no such role");
  return createRuntime({ ...cfg, controlled: { side: "home", playerId: me.id } }, catalog, { pacing: pacingFor(role), accessible });
}

const hasDrawn = (m: TacticalMoment): boolean => m.options.some((x) => x.drawn && x.anchor);
const hasContextual = (m: TacticalMoment): boolean => m.options.some((x) => !x.drawn);

/** Run frames at 60 fps (fast play) until a moment matching `want` opens; other moments get their first option. */
function untilMoment(rt: MatchRuntime, want: (m: TacticalMoment) => boolean = () => true, maxFrames = 200_000): TacticalMoment {
  rt.fast = true;
  for (let i = 0; i < maxFrames; i++) {
    const r = frame(rt, FRAME);
    if (r.opened) {
      if (want(r.opened)) {
        rt.fast = false;
        return r.opened;
      }
      // answer unwanted moments with a drawn/tapped first option so play continues
      const first = r.opened.options[0]!;
      if (!select(rt, first.id) && rt.active) {
        const anchor = liveAnchor(rt, first) ?? rt.state.ball.pos;
        setAccessible(rt, true);
        tapTarget(rt, anchor);
        setAccessible(rt, false);
      }
    }
    if (r.finished) break;
  }
  throw new Error("no matching moment opened");
}

function drawnOption(m: TacticalMoment): TacticalOption {
  const o = m.options.find((x) => x.drawn && x.anchor);
  if (!o) throw new Error("no drawn option");
  return o;
}

function contextualOption(m: TacticalMoment): TacticalOption {
  const o = m.options.find((x) => !x.drawn);
  if (!o) throw new Error("no contextual option");
  return o;
}

const line = (from: Vec2, to: Vec2, n = 8): Vec2[] => Array.from({ length: n }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / (n - 1), y: from.y + ((to.y - from.y) * i) / (n - 1) }));

describe("match runtime", () => {
  it("fast-forwards routine play, runs the maximum rate when forced, and slows to 0.3× in a moment, on the same fixed tick", () => {
    const rt = runtimeFor(3);
    frame(rt, FRAME);
    // routine play is accelerated from the first frame (never below the director's minimum)
    expect(rt.clock.scale).toBeGreaterThanOrEqual(DEFAULT_PACE.routineMinScale);
    const m = untilMoment(rt);
    expect(rt.clock.scale).toBe(SLOW_SCALE);
    expect(rt.pace.phase).toBe("window");
    let before = rt.state.clock.tick;
    for (let i = 0; i < 60; i++) frame(rt, FRAME);
    expect(rt.state.clock.tick - before).toBe(Math.round(TICKS_PER_SECOND * SLOW_SCALE));
    // decide; the aftermath runs at real speed, then routine play accelerates; forced fast = the cap
    select(rt, m.options[0]!.id);
    if (rt.active) {
      setAccessible(rt, true);
      tapTarget(rt, liveAnchor(rt, m.options[0]!) ?? rt.state.ball.pos);
      setAccessible(rt, false);
    }
    expect(rt.active).toBeNull();
    expect(rt.pace.phase).toBe("aftermath");
    expect(rt.clock.scale).toBe(NORMAL_SCALE);
    before = rt.state.clock.tick;
    for (let i = 0; i < 60; i++) frame(rt, FRAME);
    expect(rt.state.clock.tick - before).toBe(TICKS_PER_SECOND);
    for (let i = 0; i < 120 && rt.pace.phase === "aftermath"; i++) frame(rt, FRAME);
    expect(rt.pace.phase).toBe("routine");
    rt.fast = true;
    for (let i = 0; i < 40; i++) frame(rt, FRAME);
    if (!rt.active) {
      expect(rt.clock.scale).toBe(FAST_SCALE_MAX);
      before = rt.state.clock.tick;
      let ticks = 0;
      for (let i = 0; i < 30 && !rt.active; i++) ticks += frame(rt, FRAME).ticks;
      if (!rt.active) expect(ticks).toBe((TICKS_PER_SECOND * FAST_SCALE_MAX) / 2);
    }
  });

  it("the simulation keeps moving during a moment: players and ball advance while the window is open", () => {
    const rt = runtimeFor(5);
    const m = untilMoment(rt);
    const snap = rt.state.players.map((p) => ({ ...p.pos }));
    const ballBefore = { ...rt.state.ball.pos };
    for (let i = 0; i < 120; i++) frame(rt, FRAME); // ~2 real seconds ≈ 12 sim ticks
    expect(rt.active?.moment.id).toBe(m.id);
    const moved = rt.state.players.filter((p, i) => dist(p.pos, snap[i]!) > 0.05).length;
    expect(moved).toBeGreaterThan(4);
    expect(dist(rt.state.ball.pos, ballBefore) + moved).toBeGreaterThan(0);
  });

  it("times out deterministically after the difficulty window and plays on", () => {
    const rt = runtimeFor(11);
    const m = untilMoment(rt);
    const expected = Math.round(WINDOW_SECONDS[m.difficulty.band] * TICKS_PER_SECOND);
    expect(rt.active!.expiresTick - rt.active!.openedTick).toBe(expected);
    expect(windowRemaining(rt)).toBeCloseTo(WINDOW_SECONDS[m.difficulty.band], 1);
    let closed = null;
    let guard = 0;
    while (!closed && guard++ < 10_000) closed = frame(rt, FRAME).closed;
    expect(closed).not.toBeNull();
    expect(["timeout", "play_stopped"]).toContain(closed!.reason);
    expect(rt.active).toBeNull();
    expect(rt.clock.scale).toBe(NORMAL_SCALE);
    expect(rt.pace.phase).toBe("aftermath");
    expect(rt.session.records.at(-1)?.decision.band).toBe(closed!.reason === "timeout" ? "timeout" : "intent_unavailable");
  });

  it("accessible mode extends the window by 1.5× and keeps the tap alternative", () => {
    const a = runtimeFor(11);
    const b = runtimeFor(11, "CM", true);
    const ma = untilMoment(a);
    const mb = untilMoment(b);
    expect(mb.id).toBe(ma.id); // same seed, same simulation → same moment
    const wa = a.active!.expiresTick - a.active!.openedTick;
    const wb = b.active!.expiresTick - b.active!.openedTick;
    expect(wb).toBe(Math.round(wa * ACCESSIBLE_WINDOW_FACTOR));
    // toggling mid-window rescales the remaining time
    setAccessible(a, true);
    expect(a.active!.expiresTick - a.state.clock.tick).toBeGreaterThan(wa - 5);
  });

  it("a contextual (non-drawn) option commits immediately", () => {
    const rt = runtimeFor(1);
    const m = untilMoment(rt, hasContextual);
    const ctx = contextualOption(m);
    const closed = select(rt, ctx.id);
    expect(closed?.reason).toBe("committed");
    expect(closed?.result.committed?.option.id).toBe(ctx.id);
    expect(closed?.record.decision.chosenOptionId).toBe(ctx.id);
    expect(closed?.record.execution?.intentAccuracy).toBe(1);
    expect(rt.active).toBeNull();
    expect(rt.clock.scale).toBe(NORMAL_SCALE);
  });

  it("drawn option: preview does not commit, cancel keeps the window open, release commits against the live state", () => {
    const rt = runtimeFor(1);
    const m = untilMoment(rt, hasDrawn);
    const opt = drawnOption(m);
    expect(select(rt, opt.id)).toBeNull();
    expect(rt.active?.stage).toBe("drawing");

    const me = playerById(rt.state, m.playerId)!;
    const anchor0 = liveAnchor(rt, opt)!;
    const beyond = { x: me.pos.x + 2 * (anchor0.x - me.pos.x), y: me.pos.y + 2 * (anchor0.y - me.pos.y) };
    const read = previewGesture(rt, line(me.pos, beyond));
    expect(read).not.toBeNull();
    expect(rt.active?.preview).toBe(read);
    expect(rt.active?.stage).toBe("drawing");
    expect(rt.session.active?.id).toBe(m.id);

    cancel(rt);
    expect(rt.active?.stage).toBe("reading");
    expect(rt.active?.selected).toBeNull();
    expect(rt.active?.moment.id).toBe(m.id);

    // the field keeps moving while the user thinks
    for (let i = 0; i < 120; i++) frame(rt, FRAME);
    expect(rt.active?.moment.id).toBe(m.id);
    select(rt, opt.id);
    const meNow = playerById(rt.state, m.playerId)!;
    const anchorNow = liveAnchor(rt, opt)!;
    const closed = releaseGesture(rt, line(meNow.pos, anchorNow));
    expect(closed).not.toBeNull();
    expect(rt.active).toBeNull();
    if (closed!.reason === "committed") {
      expect(closed!.result.committed?.accuracy).toBeGreaterThan(0.9);
      expect(closed!.record.execution?.intentAccuracy).toBeGreaterThan(0.9);
      expect(closed!.record.decision.chosenOptionId).toBe(opt.id);
    } else {
      // the intent may have become unavailable while the user waited: that is recorded, not faked
      expect(closed!.reason).toBe("intent_unavailable");
    }
  });

  it("a drawing in the wrong direction is graded as poor execution, not as a poor decision", () => {
    const rt = runtimeFor(1);
    const m = untilMoment(rt, hasDrawn);
    const opt = drawnOption(m);
    select(rt, opt.id);
    const me = playerById(rt.state, m.playerId)!;
    const anchor = liveAnchor(rt, opt)!;
    const away = { x: me.pos.x - (anchor.x - me.pos.x), y: me.pos.y - (anchor.y - me.pos.y) };
    const closed = releaseGesture(rt, line(me.pos, away));
    expect(closed).not.toBeNull();
    if (closed!.reason === "committed") {
      expect(closed!.result.committed!.accuracy).toBeLessThan(0.3);
      expect(closed!.record.execution!.intentAccuracy).toBeLessThan(0.3);
      expect(closed!.record.decision.band).not.toBe("timeout");
    }
  });

  it("a drag back to the origin cancels the drawing without closing the moment", () => {
    const rt = runtimeFor(1);
    const m = untilMoment(rt, hasDrawn);
    const opt = drawnOption(m);
    select(rt, opt.id);
    const me = playerById(rt.state, m.playerId)!;
    const out = line(me.pos, { x: me.pos.x + 6, y: me.pos.y }, 6);
    const back = line({ x: me.pos.x + 6, y: me.pos.y }, { x: me.pos.x + 0.3, y: me.pos.y }, 6);
    expect(releaseGesture(rt, [...out, ...back])).toBeNull();
    expect(rt.active?.stage).toBe("reading");
    expect(rt.active?.moment.id).toBe(m.id);
  });

  it("accessible tap targets the live anchor and commits", () => {
    const rt = runtimeFor(1, "CM", true);
    const m = untilMoment(rt, hasDrawn);
    const opt = drawnOption(m);
    expect(select(rt, opt.id)).toBeNull();
    expect(rt.active?.stage).toBe("targeting");
    const closed = tapTarget(rt, liveAnchor(rt, opt)!);
    expect(closed).not.toBeNull();
    if (closed!.reason === "committed") expect(closed!.result.committed!.accuracy).toBeGreaterThan(0.95);
  });

  it("closes the moment as play_stopped when the ball leaves open play before a commit", () => {
    // A whole match with every window left open: at least one closes because the ball went out.
    const rt = runtimeFor(1, "CB");
    rt.fast = true;
    const reasons: Record<string, number> = {};
    for (let i = 0; i < 200_000; i++) {
      const r = frame(rt, FRAME);
      if (r.closed) {
        reasons[r.closed.reason] = (reasons[r.closed.reason] ?? 0) + 1;
        if (r.closed.reason === "play_stopped") {
          expect(r.closed.record.decision.band).toBe("intent_unavailable");
          expect(r.closed.result.issued).toBeNull();
          expect(rt.active).toBeNull();
          expect(rt.state.phase.kind).not.toBe("open_play");
        }
      }
      if (r.finished) break;
    }
    expect(rt.state.phase.kind).toBe("full_time");
    expect(reasons["play_stopped"]).toBeGreaterThanOrEqual(1);
    expect(reasons["timeout"]).toBeGreaterThan(15);
    expect(rt.session.records.length).toBe((reasons["timeout"] ?? 0) + (reasons["play_stopped"] ?? 0));
  });

  it("slices new events per frame without gaps or repeats", () => {
    const rt = runtimeFor(2);
    rt.fast = true;
    const ids = new Set<string>();
    let count = 0;
    for (let i = 0; i < 3000; i++) {
      const r = frame(rt, FRAME);
      for (const e of r.events) {
        expect(ids.has(e.id)).toBe(false);
        ids.add(e.id);
        count++;
      }
      if (r.opened) select(rt, r.opened.options[0]!.id);
      if (r.finished) break;
    }
    expect(count).toBe(rt.state.events.length);
  });

  it("paused frames do not advance the simulation", () => {
    const rt = runtimeFor(2);
    rt.paused = true;
    const t = rt.state.clock.tick;
    for (let i = 0; i < 60; i++) expect(frame(rt, FRAME).ticks).toBe(0);
    expect(rt.state.clock.tick).toBe(t);
  });
});
