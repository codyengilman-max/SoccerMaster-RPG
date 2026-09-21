import { clamp, lerp, type Vec2 } from "../sim/geometry";
import type { Rules } from "../sim/rules";

/**
 * Field metres ↔ screen pixels. The camera is only a view: nothing in the simulation depends on it.
 *
 * Landscape: field x runs left→right, y top→bottom. Portrait (viewport taller than wide): the pitch
 * is turned a quarter so its length runs up the screen (home attacks upward) and the touchlines use
 * the full width. Zoom is uniform on both axes, so player coordinates are never distorted.
 *
 * Normal play frames the whole pitch length across the long screen axis; the short axis may overflow
 * a little (the view then follows the ball across it) so the field fills the screen instead of
 * leaving bands beside it. A moment tightens on the controlled player and the ball. Interface bands
 * at the top/bottom are declared as insets so framing centres on the uncovered area.
 */

export interface Camera {
  /** Field point at the canvas centre. */
  center: Vec2;
  /** Pixels per metre (same on both axes). */
  zoom: number;
  width: number;
  height: number;
  /** True when the pitch length runs down the screen. */
  portrait: boolean;
  /** Screen px at the top covered by interface. */
  insetTop: number;
  /** Screen px at the bottom covered by interface. */
  insetBottom: number;
}

export interface CameraTarget {
  center: Vec2;
  zoom: number;
}

/** Below this many px per metre the figures stop being readable, so the view follows the ball instead. */
export const MIN_NORMAL_ZOOM = 7.5;
/** Above this the whole-pitch view looks like a training board; very large viewports get more margin. */
export const MAX_NORMAL_ZOOM = 22;
/**
 * Metres of surroundings kept visible around the pitch in a whole-pitch framing. The far edge of the
 * screen (under the HUD) gets room for the fence and a strip of desert; the near edge (above the
 * dock) stays tight; the sides show the ground behind each goal.
 */
export const MARGIN_FAR_M = 5;
export const MARGIN_NEAR_M = 1;
export const MARGIN_SIDE_M = 2.5;

const MOMENT_VISIBLE_M = 42;
const MAJOR_VISIBLE_M = 34;
const MAX_MOMENT_ZOOM = 40;

export function createCamera(rules: Rules, width: number, height: number): Camera {
  const cam: Camera = {
    center: { x: rules.length / 2, y: rules.width / 2 },
    zoom: 1,
    width,
    height,
    portrait: height > width,
    insetTop: 0,
    insetBottom: 0,
  };
  cam.zoom = frameFor(rules, cam, cam.center, null, false, false).zoom;
  return cam;
}

const uncoveredHeight = (cam: Camera): number => Math.max(1, cam.height - cam.insetTop - cam.insetBottom);

/** Long screen axis in px — the one the pitch length runs along. */
export const longAxisPx = (cam: Camera): number => (cam.portrait ? uncoveredHeight(cam) : cam.width);

/** Metres visible along the long screen axis. */
export const visibleLongAxisM = (cam: Camera): number => longAxisPx(cam) / cam.zoom;

export function resize(cam: Camera, width: number, height: number): void {
  const visible = visibleLongAxisM(cam);
  cam.width = width;
  cam.height = height;
  cam.portrait = height > width;
  cam.zoom = longAxisPx(cam) / Math.max(1, visible);
}

export function setInsets(cam: Camera, topPx: number, bottomPx: number): void {
  cam.insetTop = clamp(topPx, 0, cam.height * 0.3);
  cam.insetBottom = clamp(bottomPx, 0, cam.height * 0.6);
}

/** Zoom at which the whole pitch plus its margins fits the uncovered area. */
export function fitZoom(cam: Camera, rules: Rules): number {
  const effH = uncoveredHeight(cam);
  const vertical = MARGIN_FAR_M + MARGIN_NEAR_M;
  if (cam.portrait) return Math.min(effH / (rules.length + vertical), cam.width / (rules.width + MARGIN_SIDE_M * 2));
  return Math.min(cam.width / (rules.length + MARGIN_SIDE_M * 2), effH / (rules.width + vertical));
}

/** Centre of a whole-pitch framing: biased so the far screen edge shows more surroundings. */
function wholePitchCentre(cam: Camera, rules: Rules): Vec2 {
  const bias = (MARGIN_FAR_M - MARGIN_NEAR_M) / 2;
  // screen-up is +x in portrait (far goal at the top) and -y in landscape (far touchline at the top)
  return cam.portrait ? { x: rules.length / 2 + bias, y: rules.width / 2 } : { x: rules.length / 2, y: rules.width / 2 - bias };
}

export function toScreen(cam: Camera, p: Vec2): Vec2 {
  if (cam.portrait) {
    return { x: cam.width / 2 + (p.y - cam.center.y) * cam.zoom, y: cam.height / 2 - (p.x - cam.center.x) * cam.zoom };
  }
  return { x: cam.width / 2 + (p.x - cam.center.x) * cam.zoom, y: cam.height / 2 + (p.y - cam.center.y) * cam.zoom };
}

export function toField(cam: Camera, s: Vec2): Vec2 {
  if (cam.portrait) {
    return { x: cam.center.x - (s.y - cam.height / 2) / cam.zoom, y: cam.center.y + (s.x - cam.width / 2) / cam.zoom };
  }
  return { x: cam.center.x + (s.x - cam.width / 2) / cam.zoom, y: cam.center.y + (s.y - cam.height / 2) / cam.zoom };
}

/** Rotate a field-space direction into screen space (unit vectors stay unit). */
export function toScreenDir(cam: Camera, v: Vec2): Vec2 {
  return cam.portrait ? { x: v.y, y: -v.x } : { x: v.x, y: v.y };
}

/** Normal play: whole pitch when readable, else follow the ball. Moment: tighten on player + ball. */
export function frameFor(rules: Rules, cam: Camera, ball: Vec2, focus: Vec2 | null, inMoment: boolean, major: boolean): CameraTarget {
  const fit = fitZoom(cam, rules);
  const normal = clamp(fit, MIN_NORMAL_ZOOM, MAX_NORMAL_ZOOM);
  if (inMoment && focus) {
    const mid = lerp(focus, ball, 0.35);
    const want = longAxisPx(cam) / (major ? MAJOR_VISIBLE_M : MOMENT_VISIBLE_M);
    return { center: mid, zoom: Math.min(MAX_MOMENT_ZOOM, Math.max(want, normal * 1.25)) };
  }
  // whole-pitch framing centres on the pitch; below the readability floor the view follows the ball
  const wide = fit >= MIN_NORMAL_ZOOM;
  return { center: wide ? wholePitchCentre(cam, rules) : ball, zoom: normal };
}

/** Ease toward the target; clamp so the view never leaves the pitch surroundings entirely. */
export function follow(cam: Camera, rules: Rules, target: CameraTarget, easing: number): void {
  cam.zoom += (target.zoom - cam.zoom) * easing;
  const effH = uncoveredHeight(cam);
  const halfX = (cam.portrait ? effH : cam.width) / cam.zoom / 2;
  const halfY = (cam.portrait ? cam.width : effH) / cam.zoom / 2;
  const margin = Math.max(MARGIN_FAR_M, MARGIN_SIDE_M);
  // clamp the *uncovered-area* centre, then offset so that point lands mid-way between the insets
  const ux = clamp(target.center.x, Math.min(halfX - margin, rules.length / 2), Math.max(rules.length - halfX + margin, rules.length / 2));
  const uy = clamp(target.center.y, Math.min(halfY - margin, rules.width / 2), Math.max(rules.width - halfY + margin, rules.width / 2));
  const shift = (cam.insetTop - cam.insetBottom) / 2 / cam.zoom;
  const want = cam.portrait ? { x: ux + shift, y: uy } : { x: ux, y: uy - shift };
  cam.center = lerp(cam.center, want, easing);
}
