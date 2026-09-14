import { angleBetween, clamp, dist, distToSegment, len, norm, sub, type Vec2 } from "../sim/geometry";

/**
 * Drawing → intent precision (spec §11). A gesture is a pointer path in field metres. It never
 * creates a new soccer action: the chosen option already names the intent; the drawing says how
 * precisely the player expressed it, which the engine uses as execution noise. Nothing here knows
 * about grading or the simulation state.
 */

/** Shorter paths are taps, not drawings. */
export const MIN_DRAW_LENGTH_M = 1.5;
/** Ending a drawing back inside this radius of its origin cancels it. */
export const CANCEL_RADIUS_M = 1.5;
/** Angular error at which accuracy reaches zero. */
const MAX_ANGLE_ERROR = Math.PI / 2;

export interface GestureRead {
  origin: Vec2;
  end: Vec2;
  /** Unit vector from origin to end. */
  direction: Vec2;
  length: number;
  /** 1 = a straight line; lower when the path wandered. */
  straightness: number;
  /** Farthest the path got from the origin (used for cancel detection). */
  reach: number;
}

export function readGesture(points: readonly Vec2[]): GestureRead | null {
  if (points.length < 2) return null;
  const origin = points[0]!;
  const end = points[points.length - 1]!;
  const length = dist(origin, end);
  if (length < MIN_DRAW_LENGTH_M) return null;
  let reach = 0;
  let deviation = 0;
  for (const p of points) {
    reach = Math.max(reach, dist(p, origin));
    deviation = Math.max(deviation, distToSegment(p, origin, end));
  }
  return {
    origin,
    end,
    direction: norm(sub(end, origin)),
    length,
    straightness: clamp(1 - deviation / Math.max(length, 1), 0, 1),
    reach,
  };
}

/** Dragged out and back onto the origin marker: cancel, nothing is committed. */
export function isCancelGesture(points: readonly Vec2[]): boolean {
  if (points.length < 2) return false;
  const origin = points[0]!;
  const end = points[points.length - 1]!;
  let reach = 0;
  for (const p of points) reach = Math.max(reach, dist(p, origin));
  return reach >= MIN_DRAW_LENGTH_M * 2 && dist(end, origin) <= CANCEL_RADIUS_M;
}

/**
 * How precisely the drawing expressed the intent whose target is `anchor`, seen from the player.
 * Direction dominates (a pass drawn 90° off is not that pass); length matters less because the
 * engine, not the finger, chooses pace. Wobble costs a little.
 */
export function gestureAccuracy(g: GestureRead, playerPos: Vec2, anchor: Vec2): number {
  const want = sub(anchor, playerPos);
  const wantLen = len(want);
  if (wantLen < 0.5) return clamp(1 - dist(g.end, anchor) / 6, 0, 1);
  const angle = angleBetween(g.direction, norm(want));
  const directional = clamp(1 - angle / MAX_ANGLE_ERROR, 0, 1);
  const lengthRatio = g.length / wantLen;
  const lengthScore = clamp(1 - Math.abs(Math.log(clamp(lengthRatio, 0.2, 5))) / Math.log(4), 0, 1);
  const wobble = 0.85 + 0.15 * g.straightness;
  return clamp(directional * (0.7 + 0.3 * lengthScore) * wobble, 0, 1);
}

/** Accessible alternative: tap a target instead of drawing. Precision falls off with distance from the anchor. */
export function tapAccuracy(point: Vec2, playerPos: Vec2, anchor: Vec2): number {
  const want = sub(anchor, playerPos);
  const wantLen = len(want);
  if (wantLen < 0.5) return clamp(1 - dist(point, anchor) / 6, 0, 1);
  const toPoint = sub(point, playerPos);
  const directional = len(toPoint) < 0.5 ? 0 : clamp(1 - angleBetween(toPoint, want) / MAX_ANGLE_ERROR, 0, 1);
  const radial = clamp(1 - dist(point, anchor) / Math.max(8, wantLen * 0.6), 0, 1);
  return clamp(0.6 * directional + 0.4 * radial, 0, 1);
}
