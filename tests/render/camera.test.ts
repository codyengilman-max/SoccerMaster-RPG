import { describe, expect, it } from "vitest";
import {
  createCamera,
  fitZoom,
  follow,
  frameFor,
  MIN_NORMAL_ZOOM,
  resize,
  setInsets,
  toField,
  toScreen,
  toScreenDir,
} from "../../src/render/camera";
import { U11_9V9 } from "../../src/sim/rules";

/** Representative viewports (CSS px of the match stage). */
// `longFill` is the share of the long axis the pitch must occupy: 16:9 landscape screens are wider
// than the 70×45 pitch plus HUD/dock, so the width is the limit and the sides show surroundings.
const VIEWPORTS = {
  desktop: { w: 1440, h: 900, hud: 40, dock: 120, longFill: 0.7 },
  laptop: { w: 1280, h: 720, hud: 40, dock: 120, longFill: 0.6 },
  tabletLandscape: { w: 1024, h: 768, hud: 40, dock: 120, longFill: 0.8 },
  tabletPortrait: { w: 768, h: 1024, hud: 40, dock: 170, longFill: 0.85 },
  phonePortrait: { w: 390, h: 844, hud: 40, dock: 190, longFill: 0.85 },
  phoneSmall: { w: 360, h: 640, hud: 40, dock: 170, longFill: 0.85 },
  phoneLandscape: { w: 844, h: 390, hud: 28, dock: 150, longFill: 0.6 },
} as const;

function settled(vp: { w: number; h: number; hud: number; dock: number }, ball = { x: 35, y: 22.5 }) {
  const cam = createCamera(U11_9V9, vp.w, vp.h);
  setInsets(cam, vp.hud, vp.dock);
  const target = frameFor(U11_9V9, cam, ball, null, false, false);
  for (let i = 0; i < 200; i++) follow(cam, U11_9V9, target, 0.2);
  return cam;
}

describe("camera", () => {
  it("screen ↔ field round-trips in landscape and portrait", () => {
    for (const size of [
      [800, 500],
      [390, 844],
    ] as const) {
      const cam = createCamera(U11_9V9, size[0], size[1]);
      setInsets(cam, 40, 100);
      cam.center = { x: 31, y: 20 };
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
    }
  });

  it("uses the same scale on both axes so player coordinates are never distorted", () => {
    for (const vp of Object.values(VIEWPORTS)) {
      const cam = settled(vp);
      const o = toScreen(cam, { x: 10, y: 10 });
      const dx = toScreen(cam, { x: 20, y: 10 });
      const dy = toScreen(cam, { x: 10, y: 20 });
      expect(Math.hypot(dx.x - o.x, dx.y - o.y)).toBeCloseTo(Math.hypot(dy.x - o.x, dy.y - o.y), 6);
      expect(Math.hypot(dx.x - o.x, dx.y - o.y)).toBeCloseTo(10 * cam.zoom, 6);
    }
  });

  it("turns the pitch lengthways on portrait viewports (home attacks up the screen)", () => {
    const cam = settled(VIEWPORTS.phonePortrait);
    expect(cam.portrait).toBe(true);
    const ownGoal = toScreen(cam, { x: 0, y: 22.5 });
    const farGoal = toScreen(cam, { x: 70, y: 22.5 });
    expect(farGoal.y).toBeLessThan(ownGoal.y);
    expect(Math.abs(farGoal.x - ownGoal.x)).toBeLessThan(1e-6);
    const up = toScreenDir(cam, { x: 1, y: 0 });
    expect(up.y).toBeLessThan(0);
    const landscape = settled(VIEWPORTS.laptop);
    expect(landscape.portrait).toBe(false);
    expect(toScreen(landscape, { x: 70, y: 22.5 }).x).toBeGreaterThan(toScreen(landscape, { x: 0, y: 22.5 }).x);
  });

  it("frames the whole pitch length inside the uncovered area on every representative viewport", () => {
    for (const [name, vp] of Object.entries(VIEWPORTS)) {
      const cam = settled(vp);
      const corners = [
        { x: 0, y: 0 },
        { x: 70, y: 0 },
        { x: 0, y: 45 },
        { x: 70, y: 45 },
      ].map((p) => toScreen(cam, p));
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      const pitchW = Math.max(...xs) - Math.min(...xs);
      const pitchH = Math.max(...ys) - Math.min(...ys);
      const effH = vp.h - vp.hud - vp.dock;
      const longPx = cam.portrait ? pitchH : pitchW;
      const shortPx = cam.portrait ? pitchW : pitchH;
      const longAvail = cam.portrait ? effH : vp.w;
      const shortAvail = cam.portrait ? vp.w : effH;
      if (fitZoom(cam, U11_9V9) < MIN_NORMAL_ZOOM) {
        // too small to show everything readably: hold the zoom floor and keep the ball centred instead
        expect(cam.zoom, `${name} floor`).toBeCloseTo(MIN_NORMAL_ZOOM, 6);
        const b = toScreen(cam, { x: 35, y: 22.5 });
        expect(b.x).toBeGreaterThan(0);
        expect(b.x).toBeLessThan(vp.w);
        expect(b.y).toBeGreaterThan(vp.hud);
        expect(b.y).toBeLessThan(vp.h - vp.dock);
        continue;
      }
      // the whole pitch (both goal lines, both touchlines) is inside the uncovered area
      expect(longPx, `${name} length`).toBeLessThanOrEqual(longAvail + 1e-6);
      expect(shortPx, `${name} width`).toBeLessThanOrEqual(shortAvail + 1e-6);
      // the pitch fills the available area: ≥ 85 % of the long axis, ≥ 65 % of the short one even when
      // the viewport aspect (e.g. a 4:3 tablet) is squarer than the 70×45 pitch
      expect(longPx / longAvail, `${name} long fill`).toBeGreaterThan(vp.longFill);
      expect(shortPx / shortAvail, `${name} short fill`).toBeGreaterThan(0.6);
      // and the goal lines are inside the uncovered area, clear of the HUD and dock
      if (cam.portrait) {
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(vp.hud - 1e-6);
        expect(Math.max(...ys)).toBeLessThanOrEqual(vp.h - vp.dock + 1e-6);
      } else {
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1e-6);
        expect(Math.max(...xs)).toBeLessThanOrEqual(vp.w + 1e-6);
      }
    }
  });

  it("keeps figures readable: zoom never drops under the floor on the smallest phone", () => {
    const cam = settled(VIEWPORTS.phoneSmall);
    expect(cam.zoom).toBeGreaterThanOrEqual(MIN_NORMAL_ZOOM - 1e-6);
    expect(fitZoom(cam, U11_9V9)).toBeGreaterThan(0);
  });

  it("follows the ball below the readability floor without leaving the pitch surroundings", () => {
    const vp = VIEWPORTS.phoneLandscape;
    expect(fitZoom(settled(vp), U11_9V9)).toBeLessThan(MIN_NORMAL_ZOOM);
    const near = settled(vp, { x: 35, y: 0 });
    const far = settled(vp, { x: 35, y: 45 });
    expect(near.center.y).toBeLessThan(far.center.y);
    expect(toScreen(near, { x: 35, y: 0 }).y).toBeGreaterThanOrEqual(vp.hud);
    expect(toScreen(far, { x: 35, y: 45 }).y).toBeLessThanOrEqual(vp.h - vp.dock);
    // in whole-pitch mode the ball position does not move the frame
    const a = settled(VIEWPORTS.laptop, { x: 5, y: 2 });
    const b = settled(VIEWPORTS.laptop, { x: 65, y: 43 });
    expect(a.center).toEqual(b.center);
  });

  it("keeps the visible length across a resize and re-evaluates orientation", () => {
    const cam = createCamera(U11_9V9, 800, 500);
    const visible = cam.width / cam.zoom;
    resize(cam, 1200, 700);
    expect(cam.width / cam.zoom).toBeCloseTo(visible, 6);
    resize(cam, 400, 900);
    expect(cam.portrait).toBe(true);
  });

  it("tightens on the controlled player during a moment and eases back", () => {
    const cam = createCamera(U11_9V9, 800, 500);
    const wide = cam.zoom;
    const target = frameFor(U11_9V9, cam, { x: 50, y: 20 }, { x: 46, y: 18 }, true, false);
    for (let i = 0; i < 60; i++) follow(cam, U11_9V9, target, 0.15);
    expect(cam.zoom).toBeGreaterThan(wide * 1.2);
    expect(cam.center.x).toBeCloseTo(target.center.x, 0);
    const major = frameFor(U11_9V9, cam, { x: 50, y: 20 }, { x: 46, y: 18 }, true, true);
    expect(major.zoom).toBeGreaterThan(target.zoom);
    const normal = frameFor(U11_9V9, cam, { x: 50, y: 20 }, { x: 46, y: 18 }, false, false);
    for (let i = 0; i < 80; i++) follow(cam, U11_9V9, normal, 0.15);
    expect(cam.zoom).toBeCloseTo(wide, 1);
  });
});
