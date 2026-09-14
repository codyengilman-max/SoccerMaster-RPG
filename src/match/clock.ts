import { TICK_MS } from "../sim/types";

/**
 * Presentation time → simulation ticks (spec §12, plan §3.1). The simulation only ever advances in
 * whole 50 ms ticks; the runtime clock decides how many of them a real-time frame is worth. Slow
 * motion is the same tick function run less often — never a frozen snapshot with animation on top.
 */

export const NORMAL_SCALE = 1;
/** Inside a tactical moment: 2.5 simulated seconds ≈ 21 real seconds. */
export const SLOW_SCALE = 0.12;
/** Routine passages may be accelerated; every event still reaches the timeline. */
export const FAST_SCALE = 3;
/** Never run more than this many ticks in one frame (tab was hidden, long GC pause...). */
export const MAX_TICKS_PER_FRAME = 8;

export interface RuntimeClock {
  scale: number;
  /** Simulated milliseconds owed but not yet ticked (always in [0, TICK_MS)). */
  carryMs: number;
  realElapsedMs: number;
}

export function createClock(scale = NORMAL_SCALE): RuntimeClock {
  return { scale, carryMs: 0, realElapsedMs: 0 };
}

/** Convert a real frame of `realDtMs` into the number of ticks to run now. Deterministic in its inputs. */
export function advanceClock(clock: RuntimeClock, realDtMs: number): number {
  const dt = Math.max(0, realDtMs);
  clock.realElapsedMs += dt;
  const owed = clock.carryMs + dt * clock.scale;
  let ticks = Math.floor(owed / TICK_MS);
  if (ticks > MAX_TICKS_PER_FRAME) {
    ticks = MAX_TICKS_PER_FRAME;
    clock.carryMs = 0;
    return ticks;
  }
  clock.carryMs = owed - ticks * TICK_MS;
  return ticks;
}

/** Real milliseconds that `simSeconds` of simulated time takes at the current scale. */
export function realMsFor(clock: RuntimeClock, simSeconds: number): number {
  return (simSeconds * 1000) / clock.scale;
}
