import { clamp, lerp, type Vec2 } from "../sim/geometry";
import type { Rules } from "../sim/rules";

/**
 * Field metres ↔ screen pixels. The camera follows the ball in normal play and tightens on the
 * controlled player during a moment, but it is only a view: nothing in the simulation depends on it.
 * Field x runs left→right across the screen, y top→bottom.
 */

export interface Camera {
  /** Field point at the viewport centre. */
  center: Vec2;
  /** Pixels per metre. */
  zoom: number;
  width: number;
  height: number;
}

export interface CameraTarget {
  center: Vec2;
  /** Metres of field visible across the viewport width. */
  visibleWidthM: number;
}

export function createCamera(rules: Rules, width: number, height: number): Camera {
  const cam: Camera = { center: { x: rules.length / 2, y: rules.width / 2 }, zoom: 1, width, height };
  cam.zoom = zoomForVisible(cam, normalVisibleWidth(rules));
  return cam;
}

export function resize(cam: Camera, width: number, height: number): void {
  const visible = cam.width / cam.zoom;
  cam.width = width;
  cam.height = height;
  cam.zoom = zoomForVisible(cam, visible);
}

const normalVisibleWidth = (rules: Rules): number => Math.min(rules.length + 8, 62);

function zoomForVisible(cam: Camera, visibleWidthM: number): number {
  return cam.width / Math.max(1, visibleWidthM);
}

export function toScreen(cam: Camera, p: Vec2): Vec2 {
  return { x: cam.width / 2 + (p.x - cam.center.x) * cam.zoom, y: cam.height / 2 + (p.y - cam.center.y) * cam.zoom };
}

export function toField(cam: Camera, s: Vec2): Vec2 {
  return { x: cam.center.x + (s.x - cam.width / 2) / cam.zoom, y: cam.center.y + (s.y - cam.height / 2) / cam.zoom };
}

/** Normal play: frame the ball with a wide view. Moment: tighten on the controlled player and the ball. */
export function frameFor(rules: Rules, ball: Vec2, focus: Vec2 | null, inMoment: boolean, major: boolean): CameraTarget {
  if (inMoment && focus) {
    const mid = lerp(focus, ball, 0.35);
    return { center: mid, visibleWidthM: major ? 34 : 42 };
  }
  return { center: ball, visibleWidthM: normalVisibleWidth(rules) };
}

/** Ease toward the target; clamp so the view never leaves the pitch surroundings entirely. */
export function follow(cam: Camera, rules: Rules, target: CameraTarget, easing: number): void {
  const wantZoom = zoomForVisible(cam, target.visibleWidthM);
  cam.zoom += (wantZoom - cam.zoom) * easing;
  const halfW = cam.width / cam.zoom / 2;
  const halfH = cam.height / cam.zoom / 2;
  const margin = 6;
  const cx = clamp(target.center.x, Math.min(halfW - margin, rules.length / 2), Math.max(rules.length - halfW + margin, rules.length / 2));
  const cy = clamp(target.center.y, Math.min(halfH - margin, rules.width / 2), Math.max(rules.width - halfH + margin, rules.width / 2));
  cam.center = lerp(cam.center, { x: cx, y: cy }, easing);
}
