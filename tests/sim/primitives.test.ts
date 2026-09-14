import { describe, expect, it } from "vitest";
import { firstTouch, saveChance, speedForDistance, tackleSuccess } from "../../src/sim/actions";
import { closestOnSegment, dist, distToSegment, norm } from "../../src/sim/geometry";
import { laneReport, pressureAt, spaceAt } from "../../src/sim/perception";
import { Rng, hashSeed } from "../../src/sim/rng";
import { U11_9V9, attackingGoalX, defendingGoalX, rulesFromFile, type RulesProfileFile } from "../../src/sim/rules";
import u11 from "../../content/rules/u11-9v9.json";
import { freshMatch, player } from "../helpers";

describe("Rng", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const a = new Rng(123);
    const b = new Rng(123);
    const c = new Rng(124);
    const sa = Array.from({ length: 20 }, () => a.next());
    const sb = Array.from({ length: 20 }, () => b.next());
    const sc = Array.from({ length: 20 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const v of sa) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of sa) expect(v).toBeLessThan(1);
  });

  it("snapshot/restore resumes the same sequence", () => {
    const r = new Rng(9);
    r.next();
    const snap = r.snapshot();
    const seq1 = [r.next(), r.next(), r.next()];
    r.restore(snap);
    const seq2 = [r.next(), r.next(), r.next()];
    expect(seq1).toEqual(seq2);
  });

  it("hashSeed is stable", () => {
    expect(hashSeed("match-1")).toBe(hashSeed("match-1"));
    expect(hashSeed("match-1")).not.toBe(hashSeed("match-2"));
  });
});

describe("geometry", () => {
  it("projects onto segments", () => {
    const { t, point } = closestOnSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(t).toBeCloseTo(0.5);
    expect(point).toEqual({ x: 5, y: 0 });
    expect(distToSegment({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(10);
    expect(norm({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("rules", () => {
  it("loads the provisional U11 profile and keeps its review status visible", () => {
    const r = rulesFromFile(u11 as RulesProfileFile);
    expect(r.playersPerSide).toBe(9);
    expect(r.reviewStatus).toBe("unverified");
    expect(U11_9V9.halves).toBe(2);
  });

  it("home attacks +x", () => {
    expect(attackingGoalX(U11_9V9, "home")).toBe(U11_9V9.length);
    expect(defendingGoalX(U11_9V9, "home")).toBe(0);
    expect(attackingGoalX(U11_9V9, "away")).toBe(0);
  });
});

describe("perception", () => {
  it("pressure rises and space falls with a nearby opponent", () => {
    const s = freshMatch();
    const opp = player(s, "a-4");
    const near = pressureAt(opp.pos, [opp]);
    const far = pressureAt({ x: opp.pos.x + 20, y: opp.pos.y }, [opp]);
    expect(near).toBeGreaterThan(far);
    expect(spaceAt(opp.pos, [opp])).toBeLessThan(spaceAt({ x: opp.pos.x + 20, y: opp.pos.y }, [opp]));
  });

  it("a lane through a defender is worse than an open one", () => {
    const s = freshMatch();
    const d = player(s, "a-4");
    d.pos = { x: 30, y: 22.5 };
    d.vel = { x: 0, y: 0 };
    const through = laneReport({ x: 20, y: 22.5 }, { x: 40, y: 22.5 }, 14, [d]);
    const open = laneReport({ x: 20, y: 5 }, { x: 40, y: 5 }, 14, [d]);
    expect(through.margin).toBeLessThan(open.margin);
    expect(through.threat?.id).toBe(d.id);
    expect(open.margin).toBeGreaterThan(0);
  });
});

describe("actions", () => {
  it("first touch with a direction sets off in that direction", () => {
    const s = freshMatch(3);
    const p = player(s, "h-8");
    p.attributes.firstTouch = 95;
    const rng = new Rng(1);
    let aligned = 0;
    for (let i = 0; i < 50; i++) {
      const { offset } = firstTouch(s, p, 6, { x: 1, y: 0 }, rng);
      if (offset.x > 0) aligned++;
    }
    expect(aligned).toBeGreaterThan(40);
  });

  it("better tacklers win more often", () => {
    const s = freshMatch(4);
    const strong = player(s, "a-4");
    const weak = player(s, "a-7");
    const carrier = player(s, "h-11");
    strong.attributes.tackling = 90;
    weak.attributes.tackling = 20;
    carrier.attributes.dribbling = 50;
    const r1 = new Rng(5);
    const r2 = new Rng(5);
    let ws = 0;
    let ww = 0;
    for (let i = 0; i < 400; i++) {
      if (tackleSuccess(strong, carrier, r1)) ws++;
      if (tackleSuccess(weak, carrier, r2)) ww++;
    }
    expect(ws).toBeGreaterThan(ww);
  });

  it("save chance drops with shot speed and keeper distance", () => {
    const s = freshMatch(5);
    const gk = player(s, "a-1");
    expect(saveChance(gk, 12, 10, 0.5)).toBeGreaterThan(saveChance(gk, 24, 10, 0.5));
    expect(saveChance(gk, 16, 10, 0.2)).toBeGreaterThan(saveChance(gk, 16, 10, 2.5));
  });

  it("kick speed for distance is monotonic", () => {
    expect(speedForDistance(10)).toBeLessThan(speedForDistance(20));
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
