import { describe, expect, it } from "vitest";
import { createMatch, isFinished, issueCommand, report, runHeadless, tick } from "../../src/sim/engine";
import { topSpeed } from "../../src/sim/perception";
import { rulesFromFile, U11_9V9, type RulesProfileFile } from "../../src/sim/rules";
import { TICK_S, type MatchState } from "../../src/sim/types";
import u11 from "../../content/rules/u11-9v9.json";
import { freshMatch, player, testConfig } from "../helpers";

const TICKS_PER_HALF = U11_9V9.halfLengthSeconds / TICK_S;

function eventsOf<T extends MatchState["events"][number]["type"]>(s: MatchState, type: T) {
  return s.events.filter((e): e is Extract<MatchState["events"][number], { type: T }> => e.type === type);
}

/** Put the match into open play with `carrier` holding the ball at `pos`. */
function openPlayWith(s: MatchState, carrierId: string, pos: { x: number; y: number }): void {
  s.phase = { kind: "open_play" };
  const c = player(s, carrierId);
  c.pos = { ...pos };
  c.vel = { x: 0, y: 0 };
  c.moveTarget = { ...pos };
  s.ball = { ...s.ball, pos: { ...pos }, vel: { x: 0, y: 0 }, status: "controlled", owner: c.id, lastTouch: c.id, lastTouchSide: c.side, passTarget: null, passFrom: null };
  s.possession = c.side;
}

describe("createMatch", () => {
  it("requires a full squad covering every role", () => {
    const cfg = testConfig(1);
    cfg.home.squad = cfg.home.squad.slice(1);
    expect(() => createMatch(cfg)).toThrow(/squad must have 9/);
    const cfg2 = testConfig(1);
    cfg2.home.squad[0] = { ...cfg2.home.squad[0]!, role: 9 };
    expect(() => createMatch(cfg2)).toThrow(/missing role 1/);
  });

  it("rejects a controlled player that is not in the squad", () => {
    expect(() => createMatch(testConfig(1, U11_9V9, { controlled: { side: "home", playerId: "nope" } }))).toThrow(/controlled player/);
  });

  it("starts at kickoff with all players on their own half", () => {
    const s = freshMatch(1);
    expect(s.phase).toEqual({ kind: "kickoff", side: "home" });
    for (const p of s.players) {
      if (p.side === "home") expect(p.pos.x).toBeLessThanOrEqual(U11_9V9.length / 2);
      else expect(p.pos.x).toBeGreaterThanOrEqual(U11_9V9.length / 2);
    }
  });
});

describe("determinism", () => {
  it("same seed → identical event stream and score", () => {
    const a = runHeadless(testConfig(11), undefined, 6000);
    const b = runHeadless(testConfig(11), undefined, 6000);
    expect(report(a)).toEqual(report(b));
    expect(a.events.length).toBeGreaterThan(20);
  });

  it("different seed → different stream", () => {
    const a = runHeadless(testConfig(11), undefined, 6000);
    const b = runHeadless(testConfig(12), undefined, 6000);
    expect(a.events.map((e) => e.id)).not.toEqual(b.events.map((e) => e.id));
  });

  it("a serialized snapshot resumes identically (save/resume)", () => {
    const live = freshMatch(13);
    for (let i = 0; i < 2500; i++) tick(live);
    const resumed: MatchState = JSON.parse(JSON.stringify(live));
    for (let i = 0; i < 2500; i++) {
      tick(live);
      tick(resumed);
    }
    expect(report(resumed)).toEqual(report(live));
    expect(resumed.ball).toEqual(live.ball);
  });

  it("event ids are unique and sequential", () => {
    const s = runHeadless(testConfig(14), undefined, 8000);
    const ids = s.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < s.events.length; i++) expect(s.events[i]!.tick).toBeGreaterThanOrEqual(s.events[i - 1]!.tick);
  });
});

describe("movement and ball invariants", () => {
  it("players never exceed top speed per tick in open play and stay near the field", () => {
    const s = freshMatch(21);
    let prev = new Map(s.players.map((p) => [p.id, { ...p.pos }]));
    for (let i = 0; i < 6000; i++) {
      const wasOpen = s.phase.kind === "open_play";
      tick(s);
      if (wasOpen && s.phase.kind === "open_play") {
        for (const p of s.players) {
          const q = prev.get(p.id)!;
          const step = Math.hypot(p.pos.x - q.x, p.pos.y - q.y);
          expect(step).toBeLessThanOrEqual(topSpeed(p) * TICK_S * 1.01);
          expect(p.pos.x).toBeGreaterThanOrEqual(-1);
          expect(p.pos.x).toBeLessThanOrEqual(U11_9V9.length + 1);
          expect(p.fatigue).toBeGreaterThanOrEqual(0);
          expect(p.fatigue).toBeLessThanOrEqual(1);
        }
      }
      prev = new Map(s.players.map((p) => [p.id, { ...p.pos }]));
    }
  });

  it("a loose ball decelerates under friction and never has an owner", () => {
    const s = freshMatch(22);
    s.phase = { kind: "open_play" };
    for (const p of s.players) p.touchCooldown = 1000;
    s.ball = { ...s.ball, status: "loose", pos: { x: 35, y: 22.5 }, vel: { x: 12, y: 0 }, lastTouchSide: "home" };
    let last = 12;
    for (let i = 0; i < 40; i++) {
      tick(s);
      const v = Math.hypot(s.ball.vel.x, s.ball.vel.y);
      expect(v).toBeLessThanOrEqual(last + 1e-9);
      expect(s.ball.owner).toBeNull();
      last = v;
    }
    expect(last).toBeLessThan(12);
  });

  it("controlled ball stays with its owner", () => {
    const s = freshMatch(23);
    for (let i = 0; i < 3000; i++) {
      tick(s);
      if (s.ball.status === "controlled") {
        const o = player(s, s.ball.owner!);
        expect(Math.hypot(o.pos.x - s.ball.pos.x, o.pos.y - s.ball.pos.y)).toBeLessThan(1.0);
      } else {
        expect(s.ball.owner).toBeNull();
      }
    }
  });
});

describe("possession, passing and interception", () => {
  it("an external pass command is executed by the carrier and can be received", () => {
    const s = freshMatch(31);
    openPlayWith(s, "h-8", { x: 30, y: 22.5 });
    const rcv = player(s, "h-9");
    rcv.pos = { x: 40, y: 22.5 };
    rcv.moveTarget = { ...rcv.pos };
    for (const p of s.players) if (p.side === "away") p.pos = { x: 60, y: p.pos.y };
    issueCommand(s, "h-8", { type: "pass", target: { x: 40, y: 22.5 }, receiver: "h-9" });
    for (let i = 0; i < 60 && eventsOf(s, "receive").length === 0; i++) tick(s);
    const pass = eventsOf(s, "pass")[0]!;
    expect(pass.from).toBe("h-8");
    expect(pass.to).toBe("h-9");
    expect(eventsOf(s, "receive")[0]!.player).toBe("h-9");
    expect(s.ball.owner).toBe("h-9");
  });

  it("a defender in the lane intercepts and possession changes", () => {
    const s = freshMatch(32);
    openPlayWith(s, "h-8", { x: 30, y: 22.5 });
    const rcv = player(s, "h-9");
    rcv.pos = { x: 45, y: 22.5 };
    rcv.moveTarget = { ...rcv.pos };
    for (const p of s.players) if (p.side === "away") p.pos = { x: 66, y: 5 };
    const d = player(s, "a-6");
    d.pos = { x: 37, y: 22.5 };
    d.moveTarget = { ...d.pos };
    issueCommand(s, "h-8", { type: "pass", target: { x: 45, y: 22.5 }, receiver: "h-9" });
    for (let i = 0; i < 40 && eventsOf(s, "interception").length === 0; i++) tick(s);
    expect(eventsOf(s, "interception")[0]!.player).toBe("a-6");
    expect(eventsOf(s, "possession_change").some((e) => e.to === "away")).toBe(true);
    expect(s.possession).toBe("away");
  });

  it("possession changes hands repeatedly over a match (continuous transitions)", () => {
    const s = runHeadless(testConfig(33), undefined, 20000);
    const changes = eventsOf(s, "possession_change");
    expect(changes.filter((e) => e.to === "home").length).toBeGreaterThan(5);
    expect(changes.filter((e) => e.to === "away").length).toBeGreaterThan(5);
  });
});

describe("shots, saves and goals", () => {
  it("a ball crossing the line between the posts is a goal, then the conceding side kicks off", () => {
    const s = freshMatch(41);
    s.phase = { kind: "open_play" };
    for (const p of s.players) p.touchCooldown = 1000;
    s.ball = { ...s.ball, status: "loose", pos: { x: 66, y: 22.5 }, vel: { x: 18, y: 0 }, lastTouch: "h-9", lastTouchSide: "home" };
    for (let i = 0; i < 20 && eventsOf(s, "goal").length === 0; i++) tick(s);
    expect(eventsOf(s, "goal")[0]).toMatchObject({ scorer: "h-9", side: "home" });
    expect(s.score).toEqual({ home: 1, away: 0 });
    expect(s.phase).toEqual({ kind: "kickoff", side: "away" });
  });

  it("a ball wide of the posts is a goal kick, not a goal", () => {
    const s = freshMatch(42);
    s.phase = { kind: "open_play" };
    for (const p of s.players) p.touchCooldown = 1000;
    s.ball = { ...s.ball, status: "loose", pos: { x: 66, y: 4 }, vel: { x: 18, y: 0 }, lastTouch: "h-9", lastTouchSide: "home" };
    for (let i = 0; i < 20 && s.phase.kind === "open_play"; i++) tick(s);
    expect(s.score).toEqual({ home: 0, away: 0 });
    expect(s.phase).toEqual({ kind: "goal_kick", side: "away" });
  });

  it("the keeper can save a shot and keep possession for their side", () => {
    let saves = 0;
    for (let seed = 50; seed < 58; seed++) {
      const s = freshMatch(seed);
      s.phase = { kind: "open_play" };
      for (const p of s.players) p.touchCooldown = 1000;
      const gk = player(s, "a-1");
      gk.pos = { x: 69, y: 22.5 };
      gk.moveTarget = { ...gk.pos };
      gk.touchCooldown = 0;
      gk.attributes.goalkeeping = 95;
      s.pendingShot = { shooter: "h-9", side: "home", onTarget: true };
      s.ball = { ...s.ball, status: "loose", pos: { x: 62, y: 22.5 }, vel: { x: 12, y: 0 }, lastTouch: "h-9", lastTouchSide: "home" };
      for (let i = 0; i < 30 && s.phase.kind === "open_play" && eventsOf(s, "save").length === 0; i++) tick(s);
      if (eventsOf(s, "save").length) {
        saves++;
        expect(s.possession).toBe("away");
        expect(s.score.home).toBe(0);
      }
    }
    expect(saves).toBeGreaterThan(0);
  });
});

describe("restarts, offside and clock", () => {
  it("a ball over the touchline becomes a throw-in for the other side and play resumes", () => {
    const s = freshMatch(61);
    s.phase = { kind: "open_play" };
    for (const p of s.players) p.touchCooldown = 1000;
    s.ball = { ...s.ball, status: "loose", pos: { x: 35, y: 44.5 }, vel: { x: 0, y: 12 }, lastTouch: "h-7", lastTouchSide: "home" };
    for (let i = 0; i < 10 && s.phase.kind === "open_play"; i++) tick(s);
    expect(s.phase).toMatchObject({ kind: "throw_in", side: "away" });
    expect(s.ball.status).toBe("dead");
    for (const p of s.players) p.touchCooldown = 0;
    for (let i = 0; i < 400 && s.phase.kind !== "open_play"; i++) tick(s);
    expect(s.phase.kind).toBe("open_play");
    expect(eventsOf(s, "restart")[0]).toMatchObject({ restart: "throw_in", side: "away" });
  });

  it("a receiver beyond the last defender at the pass is flagged offside", () => {
    const s = freshMatch(62);
    openPlayWith(s, "h-8", { x: 40, y: 22.5 });
    for (const p of s.players) {
      if (p.side === "away") {
        p.pos = { x: p.role === 1 ? 68 : 48, y: p.role === 1 ? 22.5 : 38 + (p.role % 3) * 2 };
        p.moveTarget = { ...p.pos };
      } else if (p.id !== "h-8" && p.id !== "h-9") {
        p.pos = { x: 30, y: 5 + p.role * 3 };
        p.moveTarget = { ...p.pos };
      }
    }
    const striker = player(s, "h-9");
    striker.pos = { x: 55, y: 22.5 };
    striker.moveTarget = { ...striker.pos };
    issueCommand(s, "h-8", { type: "pass", target: { x: 55, y: 22.5 }, receiver: "h-9" });
    for (let i = 0; i < 80 && eventsOf(s, "offside").length === 0 && s.phase.kind === "open_play"; i++) tick(s);
    expect(eventsOf(s, "offside")[0]).toMatchObject({ player: "h-9", side: "home" });
    expect(s.phase).toMatchObject({ kind: "free_kick", side: "away", reason: "offside" });
  });

  it("offside is not called when the competition rules disable it", () => {
    const noOffside = rulesFromFile({ ...(u11 as RulesProfileFile), id: "u11-no-offside", offside: { enabled: false, source: "unverified" } });
    const s = freshMatch(62, noOffside);
    openPlayWith(s, "h-8", { x: 40, y: 22.5 });
    for (const p of s.players) {
      if (p.side === "away") {
        p.pos = { x: p.role === 1 ? 68 : 48, y: p.role === 1 ? 22.5 : 38 + (p.role % 3) * 2 };
        p.moveTarget = { ...p.pos };
      } else if (p.id !== "h-8" && p.id !== "h-9") {
        p.pos = { x: 30, y: 5 + p.role * 3 };
        p.moveTarget = { ...p.pos };
      }
    }
    const striker = player(s, "h-9");
    striker.pos = { x: 55, y: 22.5 };
    striker.moveTarget = { ...striker.pos };
    issueCommand(s, "h-8", { type: "pass", target: { x: 55, y: 22.5 }, receiver: "h-9" });
    for (let i = 0; i < 80 && eventsOf(s, "receive").length === 0 && s.phase.kind === "open_play"; i++) tick(s);
    expect(eventsOf(s, "offside")).toHaveLength(0);
    expect(eventsOf(s, "receive")[0]?.player).toBe("h-9");
  });

  it("plays two halves, switches kickoff at half time and reaches full time without resetting the score", () => {
    const s = runHeadless(testConfig(63));
    expect(isFinished(s)).toBe(true);
    expect(eventsOf(s, "half_time")).toHaveLength(1);
    expect(eventsOf(s, "full_time")).toHaveLength(1);
    const ht = eventsOf(s, "half_time")[0]!;
    const secondKickoff = eventsOf(s, "kickoff").find((e) => e.tick > ht.tick);
    expect(secondKickoff?.side).toBe("away");
    expect(s.clock.tick).toBeGreaterThanOrEqual(2 * TICKS_PER_HALF);
    expect(Math.abs(s.clock.timeMs - 2 * U11_9V9.halfLengthSeconds * 1000)).toBeLessThan(1000);
    const goals = eventsOf(s, "goal");
    expect(s.score.home).toBe(goals.filter((g) => g.side === "home").length);
    expect(s.score.away).toBe(goals.filter((g) => g.side === "away").length);
    expect(eventsOf(s, "full_time")[0]).toMatchObject({ home: s.score.home, away: s.score.away });
  });

  it("the match keeps going after a goal (no state reset) and fatigue accumulates", () => {
    const s = runHeadless(testConfig(64));
    const goal = eventsOf(s, "goal")[0];
    if (goal) {
      expect(s.events.filter((e) => e.tick > goal.tick).length).toBeGreaterThan(10);
    }
    expect(s.players.some((p) => p.fatigue > 0.05)).toBe(true);
    for (const p of s.players) expect(p.fatigue).toBeLessThanOrEqual(1);
    expect(s.events.some((e) => e.type === "out_of_play")).toBe(true);
  });
});

describe("controlled player role lock", () => {
  it("the selected player's role and identity never change during a match", () => {
    const s = createMatch(testConfig(71, U11_9V9, { controlled: { side: "home", playerId: "h-8" } }));
    const initialRole = player(s, "h-8").role;
    for (let i = 0; i < 30000 && !isFinished(s); i++) {
      tick(s);
      if (i % 500 === 0) {
        expect(s.controlled).toEqual({ side: "home", playerId: "h-8" });
        expect(player(s, "h-8").role).toBe(initialRole);
      }
    }
    expect(player(s, "h-8").role).toBe(8);
    expect(s.players.map((p) => p.id).sort()).toEqual(createMatch(testConfig(71)).players.map((p) => p.id).sort());
  });
});
