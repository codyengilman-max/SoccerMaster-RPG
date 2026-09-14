import { describe, expect, it } from "vitest";
import { createCamera, follow, frameFor, resize, toField, toScreen } from "../../src/render/camera";
import { U11_9V9 } from "../../src/sim/rules";

describe("camera", () => {
  it("screen ↔ field round-trips", () => {
    const cam = createCamera(U11_9V9, 800, 500);
    for (const p of [
      { x: 0, y: 0 },
      { x: 35, y: 22.5 },
      { x: 70, y: 45 },
      { x: 12.3, y: 41.7 },
    ]) {
      const back = toField(cam, toScreen(cam, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it("keeps the visible width across a resize", () => {
    const cam = createCamera(U11_9V9, 800, 500);
    const visible = cam.width / cam.zoom;
    resize(cam, 400, 700);
    expect(cam.width / cam.zoom).toBeCloseTo(visible, 6);
  });

  it("tightens on the controlled player during a moment and eases back", () => {
    const cam = createCamera(U11_9V9, 800, 500);
    const wide = cam.zoom;
    const target = frameFor(U11_9V9, { x: 50, y: 20 }, { x: 46, y: 18 }, true, false);
    for (let i = 0; i < 60; i++) follow(cam, U11_9V9, target, 0.15);
    expect(cam.zoom).toBeGreaterThan(wide * 1.3);
    expect(cam.center.x).toBeCloseTo(target.center.x, 0);
    const major = frameFor(U11_9V9, { x: 50, y: 20 }, { x: 46, y: 18 }, true, true);
    expect(major.visibleWidthM).toBeLessThan(target.visibleWidthM);
    const normal = frameFor(U11_9V9, { x: 50, y: 20 }, { x: 46, y: 18 }, false, false);
    for (let i = 0; i < 60; i++) follow(cam, U11_9V9, normal, 0.15);
    expect(cam.zoom).toBeCloseTo(wide, 1);
  });
});
