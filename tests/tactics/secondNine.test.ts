import { describe, expect, it } from "vitest";
import { decideOffBall, SECOND_NINE, secondNineRead } from "../../src/sim/ai";
import { createMatch, isFinished, tick } from "../../src/sim/engine";
import type { Side } from "../../src/sim/rules";
import type { MatchState, PlayerState, RoleNumber } from "../../src/sim/types";
import { readField } from "../../src/tactics/features";
import { instantiateIntent } from "../../src/tactics/intents";
import { freshMatch, testConfig } from "../helpers";

const at = (s: MatchState, side: Side, role: RoleNumber): PlayerState => {
  const p = s.players.find((q) => q.side === side && q.role === role);
  if (!p) throw new Error(`no ${side} ${role}`);
  return p;
};
const place = (s: MatchState, side: Side, role: RoleNumber, x: number, y: number): PlayerState => {
  const p = at(s, side, role);
  p.pos = { x, y };
  p.vel = { x: 0, y: 0 };
  return p;
};

/**
 * Home attack +x on a 70×45 pitch. The ball is secured by the CM (8) on the LEFT flank (high y),
 * the right back (2) holds width on the right, the striker (9) pins the away back line at x≈56,
 * and four home outfielders stay behind the ball. The right winger (7) is the opposite winger.
 */
function secondNineState(): MatchState {
  const s = freshMatch(21);
  for (const p of s.players) p.vel = { x: 0, y: 0 };
  // home
  place(s, "home", 1, 6, 22.5);
  place(s, "home", 4, 25, 22.5);
  place(s, "home", 3, 30, 36);
  place(s, "home", 6, 38, 26);
  place(s, "home", 2, 40, 8); // width on the right flank, past halfway
  const carrier = place(s, "home", 8, 50, 36); // secured on the left flank
  place(s, "home", 9, 52, 24); // pins the centre backs
  place(s, "home", 11, 52, 40);
  place(s, "home", 7, 58, 8); // beyond the back line: the run-behind branch cannot fire
  // away: back line at x=56, nobody near the carrier, far post open
  place(s, "away", 1, 68, 22.5);
  place(s, "away", 2, 56, 36);
  place(s, "away", 4, 56, 24);
  place(s, "away", 3, 56, 30);
  place(s, "away", 6, 40, 40);
  place(s, "away", 8, 35, 22);
  place(s, "away", 7, 30, 10);
  place(s, "away", 11, 30, 34);
  place(s, "away", 9, 20, 22);
  s.possession = "home";
  s.ball = { ...s.ball, pos: { ...carrier.pos }, vel: { x: 0, y: 0 }, status: "controlled", owner: carrier.id, lastTouch: carrier.id, lastTouchSide: "home" };
  return s;
}

describe("contextual second-9 (winger narrowing)", () => {
  it("turns on only for the opposite winger when the ball is secured wide, width is held and the far-post space is open", () => {
    const s = secondNineState();
    const rw = secondNineRead(s, at(s, "home", 7));
    expect(rw.on).toBe(true);
    expect(rw.widthProvided).toBe(true);
    expect(rw.restDefense).toBeGreaterThanOrEqual(SECOND_NINE.restDefenseMin);
    expect(rw.farPostSpace).toBeGreaterThanOrEqual(SECOND_NINE.farPostSpaceMin);
    // narrows into the right half-space just in front of the back line, not onto the touchline
    expect(rw.target).toEqual({ x: 54.5, y: 22.5 - 45 * SECOND_NINE.narrowLane });
    // the ball-side winger keeps their width: never both wingers inside
    const lw = secondNineRead(s, at(s, "home", 11));
    expect(lw.on).toBe(false);
    expect(lw.target).toBeNull();
  });

  it("feeds the field read, the narrow_inside intent and the engine's own off-ball movement from one predicate", () => {
    const s = secondNineState();
    const rw = at(s, "home", 7);
    const read = readField(s, rw);
    expect(read.secondNineOn).toBe(1);
    expect(read.widthProvidedMyFlank).toBe(1);
    expect(read.restDefenseCount).toBe(4);
    const inst = instantiateIntent(s, rw, "narrow_inside");
    expect(inst?.command).toEqual({ type: "move", target: secondNineRead(s, rw).target });
    expect(decideOffBall(s, rw)).toEqual({ type: "move", target: secondNineRead(s, rw).target });
    expect(instantiateIntent(s, at(s, "home", 11), "narrow_inside")).toBeNull();
    expect(readField(s, at(s, "home", 11)).secondNineOn).toBe(0);
  });

  it("stays off when nobody else holds width on the winger's flank", () => {
    const s = secondNineState();
    place(s, "home", 2, 40, 20);
    const r = secondNineRead(s, at(s, "home", 7));
    expect(r.widthProvided).toBe(false);
    expect(r.on).toBe(false);
    expect(instantiateIntent(s, at(s, "home", 7), "narrow_inside")).toBeNull();
  });

  it("stays off when the carrier is pressed (ball not secured)", () => {
    const s = secondNineState();
    place(s, "away", 6, 52, 36);
    expect(secondNineRead(s, at(s, "home", 7)).on).toBe(false);
  });

  it("stays off when rest defence is thin", () => {
    const s = secondNineState();
    place(s, "home", 4, 49, 18);
    place(s, "home", 3, 49, 40);
    place(s, "home", 6, 49, 28);
    const r = secondNineRead(s, at(s, "home", 7));
    expect(r.restDefense).toBeLessThan(SECOND_NINE.restDefenseMin);
    expect(r.on).toBe(false);
  });

  it("stays off when the far-post space is crowded or the striker does not pin the back line", () => {
    const crowded = secondNineState();
    place(crowded, "away", 4, 55, 17);
    expect(secondNineRead(crowded, at(crowded, "home", 7)).on).toBe(false);
    const noPin = secondNineState();
    place(noPin, "home", 9, 40, 24);
    expect(secondNineRead(noPin, at(noPin, "home", 7)).on).toBe(false);
  });

  it("stays off when the ball is central or on the winger's own flank, and in build-up", () => {
    const central = secondNineState();
    const c = place(central, "home", 8, 50, 24);
    central.ball.pos = { ...c.pos };
    expect(secondNineRead(central, at(central, "home", 7)).target).toBeNull();
    const own = secondNineState();
    const o = place(own, "home", 8, 50, 10);
    own.ball.pos = { ...o.pos };
    expect(secondNineRead(own, at(own, "home", 7)).target).toBeNull();
    const build = secondNineState();
    const b = place(build, "home", 8, 30, 36);
    build.ball.pos = { ...b.pos };
    expect(secondNineRead(build, at(build, "home", 7)).on).toBe(false);
  });

  it("never activates both wingers of a side in the same tick over full simulated matches", () => {
    let fired = 0;
    for (const seed of [11, 12]) {
      const s = createMatch(testConfig(seed));
      while (!isFinished(s)) {
        tick(s);
        if (s.ball.status !== "controlled") continue;
        for (const side of ["home", "away"] as const) {
          const on = [7, 11].map((r) => secondNineRead(s, at(s, side, r as RoleNumber)).on);
          expect(on[0] && on[1]).toBe(false);
          if (on[0] || on[1]) fired++;
        }
      }
    }
    // contextual: it happens in real states, but only briefly
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(2000);
  });
});
