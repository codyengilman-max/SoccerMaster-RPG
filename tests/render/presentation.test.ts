import { describe, expect, it } from "vitest";
import { createCamera } from "../../src/render/camera";
import { ballHeightM, createPresentation, deriveVisuals, kitFor } from "../../src/render/presentation";
import { runHeadless } from "../../src/sim/engine";
import { U11_9V9 } from "../../src/sim/rules";
import { freshMatch, player, testConfig } from "../helpers";

const landscape = () => createCamera(U11_9V9, 1440, 900);
const portrait = () => createCamera(U11_9V9, 390, 844);

describe("presentation adapter", () => {
  it("assigns kits by side and keeper role only", () => {
    const s = freshMatch(3);
    for (const p of s.players) {
      const kit = kitFor(p);
      if (p.role === 1) expect(kit).toBe(p.side === "home" ? "keeperHome" : "keeperAway");
      else expect(kit).toBe(p.side === "home" ? "blue" : "coral");
    }
    const visuals = deriveVisuals(createPresentation(), s, landscape(), 50, 1);
    expect(visuals.filter((v) => v.keeper)).toHaveLength(2);
    expect(visuals.filter((v) => v.kit === "blue")).toHaveLength(8);
    expect(visuals.filter((v) => v.kit === "coral")).toHaveLength(8);
  });

  it("mirrors engine state exactly: one visual per player at the authoritative position", () => {
    const s = freshMatch(5);
    const visuals = deriveVisuals(createPresentation(), s, landscape(), 50, 1);
    expect(visuals.map((v) => v.id)).toEqual(s.players.map((p) => p.id));
    for (const v of visuals) {
      const p = player(s, v.id);
      expect(v.pos).toBe(p.pos);
      expect(v.side).toBe(p.side);
      expect(v.role).toBe(p.role);
      expect(v.fatigue).toBe(p.fatigue);
    }
  });

  it("does not mutate the match state", () => {
    const s = freshMatch(9);
    const before = JSON.stringify(s);
    const pres = createPresentation();
    for (let i = 0; i < 5; i++) deriveVisuals(pres, s, landscape(), 50, 8);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("faces the movement direction in screen space, including the portrait rotation", () => {
    const s = freshMatch(11);
    const p = s.players[3]!;
    p.vel = { x: 4, y: 0 }; // running towards the away goal (+x on the pitch)
    const land = deriveVisuals(createPresentation(), s, landscape(), 50, 1).find((v) => v.id === p.id)!;
    expect(land.facing).toBe("E");
    const port = deriveVisuals(createPresentation(), s, portrait(), 50, 1).find((v) => v.id === p.id)!;
    expect(["N", "S"]).toContain(port.facing);
    expect(port.facing).not.toBe(land.facing);
  });

  it("uses the running poses only while moving and alternates the stride with distance covered", () => {
    const s = freshMatch(13);
    const p = s.players[4]!;
    const pres = createPresentation();
    p.vel = { x: 0, y: 0 };
    expect(deriveVisuals(pres, s, landscape(), 50, 1).find((v) => v.id === p.id)!.pose).toBe("stand");
    p.vel = { x: 5, y: 0 };
    const poses = new Set<string>();
    for (let i = 0; i < 20; i++) poses.add(deriveVisuals(pres, s, landscape(), 50, 1).find((v) => v.id === p.id)!.pose);
    expect(poses).toEqual(new Set(["run1", "run2"]));
  });

  it("shows carrying while dribbling and ready while receiving, with pressure from the nearest opponent", () => {
    const s = freshMatch(17);
    const carrier = s.players.find((p) => p.side === "home" && p.role === 8)!;
    const opp = s.players.find((p) => p.side === "away" && p.role === 8)!;
    s.phase = { kind: "open_play" };
    carrier.pos = { x: 30, y: 25 };
    carrier.vel = { x: 3, y: 0 };
    opp.pos = { x: 31.5, y: 25 };
    s.ball = { ...s.ball, pos: { ...carrier.pos }, vel: carrier.vel, status: "controlled", owner: carrier.id, lastTouch: carrier.id, lastTouchSide: "home", passTarget: null, passFrom: null };
    const pres = createPresentation();
    const v = deriveVisuals(pres, s, landscape(), 50, 1).find((x) => x.id === carrier.id)!;
    expect(v.hasBall).toBe(true);
    expect(v.pose).toBe("carry");
    expect(v.pressure).toBeGreaterThan(0.4);

    const target = s.players.find((p) => p.side === "home" && p.role === 9)!;
    target.vel = { x: 0, y: 0 };
    s.ball = { ...s.ball, status: "loose", owner: null, passTarget: target.id, passFrom: carrier.id, vel: { x: 8, y: 0 } };
    const w = deriveVisuals(pres, s, landscape(), 50, 1).find((x) => x.id === target.id)!;
    expect(w.receiving).toBe(true);
    expect(w.pose).toBe("ready");
  });

  it("derives ball height from flight only", () => {
    const s = freshMatch(19);
    s.ball = { ...s.ball, status: "controlled", vel: { x: 20, y: 0 } };
    expect(ballHeightM(s)).toBe(0);
    s.ball = { ...s.ball, status: "loose", owner: null, vel: { x: 2, y: 0 } };
    expect(ballHeightM(s)).toBe(0);
    s.ball = { ...s.ball, vel: { x: 14, y: 0 } };
    expect(ballHeightM(s)).toBeCloseTo(1.2);
    s.ball = { ...s.ball, vel: { x: 40, y: 0 } };
    expect(ballHeightM(s)).toBe(2.2);
  });

  it("is deterministic and leaves the seeded replay untouched", () => {
    const a = runHeadless(testConfig(23), undefined, 400);
    const b = runHeadless(testConfig(23), undefined, 400);
    const va = deriveVisuals(createPresentation(), a, landscape(), 50, 1);
    const vb = deriveVisuals(createPresentation(), b, landscape(), 50, 1);
    expect(JSON.stringify(va)).toBe(JSON.stringify(vb));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
