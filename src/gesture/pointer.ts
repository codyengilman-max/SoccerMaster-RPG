import type { Vec2 } from "../sim/geometry";

/**
 * Pointer Events → field-space paths. One code path for touch, mouse and pen. The primary pointer
 * draws; a second pointer touching down while drawing cancels (two-finger cancel). A press that
 * never travels far enough to be a drawing is reported as a tap (the accessible alternative).
 */

export interface PointerHandlers {
  /** Pointer down/move while drawing: path so far, in field metres. */
  onPreview(points: readonly Vec2[]): void;
  /** Primary pointer released after moving: full path. */
  onRelease(points: readonly Vec2[]): void;
  /** Press and release without meaningful travel. */
  onTap(point: Vec2): void;
  onCancel(): void;
}

export interface PointerAdapter {
  detach(): void;
}

const TAP_TRAVEL_PX = 10;

export function attachPointer(el: HTMLElement, toField: (client: Vec2) => Vec2, handlers: PointerHandlers): PointerAdapter {
  let primary: number | null = null;
  let points: Vec2[] = [];
  let travelPx = 0;
  let lastClient: Vec2 | null = null;

  const clientOf = (e: PointerEvent): Vec2 => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const reset = (): void => {
    primary = null;
    points = [];
    travelPx = 0;
    lastClient = null;
  };

  const down = (e: PointerEvent): void => {
    if (primary !== null) {
      // second finger while drawing: cancel
      if (e.pointerId !== primary) {
        reset();
        handlers.onCancel();
      }
      return;
    }
    primary = e.pointerId;
    el.setPointerCapture?.(e.pointerId);
    const c = clientOf(e);
    lastClient = c;
    points = [toField(c)];
    handlers.onPreview(points);
    e.preventDefault();
  };

  const move = (e: PointerEvent): void => {
    if (e.pointerId !== primary || !lastClient) return;
    const c = clientOf(e);
    travelPx += Math.hypot(c.x - lastClient.x, c.y - lastClient.y);
    lastClient = c;
    points.push(toField(c));
    handlers.onPreview(points);
    e.preventDefault();
  };

  const up = (e: PointerEvent): void => {
    if (e.pointerId !== primary) return;
    const c = clientOf(e);
    points.push(toField(c));
    const path = points;
    const tap = travelPx < TAP_TRAVEL_PX;
    reset();
    if (tap) handlers.onTap(path[path.length - 1]!);
    else handlers.onRelease(path);
    e.preventDefault();
  };

  const cancelEvt = (e: PointerEvent): void => {
    if (e.pointerId !== primary) return;
    reset();
    handlers.onCancel();
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancelEvt);
  el.style.touchAction = "none";

  return {
    detach() {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancelEvt);
    },
  };
}
