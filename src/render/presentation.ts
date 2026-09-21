import { dist, len, sub, type Vec2 } from "../sim/geometry";
import type { Side } from "../sim/rules";
import type { MatchState, PlayerState } from "../sim/types";

import { toScreenDir, type Camera } from "./camera";
import { SPRITE_VARIANTS, facingOf, type Facing, type SpriteKit, type SpritePose } from "./spriteLayout";

/**
 * Presentation adapter: reads the authoritative match state and derives what each figure should
 * *look* like (facing, pose, kit, ball/pressure/receiving flags). It keeps only cosmetic memory —
 * smoothed facing and a stride phase — and never feeds anything back into the simulation.
 */

export interface PlayerVisual {
  id: string;
  side: Side;
  role: number;
  pos: Vec2;
  fatigue: number;
  kit: SpriteKit;
  /** Screen-space facing (already rotated for portrait). */
  facing: Facing;
  pose: SpritePose;
  variant: number;
  /** m/s. */
  speed: number;
  hasBall: boolean;
  /** Intended receiver of the pass in flight. */
  receiving: boolean;
  /** 0..1 how tightly the nearest opponent is on this player. */
  pressure: number;
  keeper: boolean;
}

interface Memory {
  facing: Facing;
  /** Stride phase in [0, 1); flips run1/run2 every half stride. */
  phase: number;
  /** Last field-space heading, kept while the player stands still. */
  heading: Vec2;
}

export interface Presentation {
  memory: Map<string, Memory>;
}

export const createPresentation = (): Presentation => ({ memory: new Map() });

const STRIDE_M = 1.6;
const WALK_SPEED = 0.6;
const PRESSURE_RADIUS_M = 3.5;
/** During fast-forward, legs cycle at most this many times faster than real time to avoid strobing. */
const MAX_ANIM_SPEEDUP = 2.5;

function hashVariant(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SPRITE_VARIANTS;
}

export function kitFor(p: PlayerState): SpriteKit {
  const keeper = p.role === 1;
  if (p.side === "home") return keeper ? "keeperHome" : "blue";
  return keeper ? "keeperAway" : "coral";
}

function nearestOpponentDist(state: MatchState, p: PlayerState): number {
  let best = Infinity;
  for (const o of state.players) {
    if (o.side === p.side) continue;
    const d = dist(o.pos, p.pos);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Advance cosmetic memory by `simDtMs` simulated ms (played at `simSpeed` × real time) and derive
 * every player's visual. Facing turns toward the movement direction while moving and toward the ball
 * while standing; the stride phase advances with distance covered.
 */
export function deriveVisuals(pres: Presentation, state: MatchState, cam: Camera, simDtMs: number, simSpeed: number): PlayerVisual[] {
  const ball = state.ball;
  const animDt = simDtMs / Math.max(1, simSpeed / MAX_ANIM_SPEEDUP);
  const out: PlayerVisual[] = [];
  for (const p of state.players) {
    let mem = pres.memory.get(p.id);
    if (!mem) {
      mem = { facing: "S", phase: 0, heading: { x: p.side === "home" ? 1 : -1, y: 0 } };
      pres.memory.set(p.id, mem);
    }
    const speed = len(p.vel);
    const hasBall = ball.status === "controlled" && ball.owner === p.id;
    const receiving = ball.status === "loose" && ball.passTarget === p.id;

    if (speed > WALK_SPEED) {
      mem.heading = { x: p.vel.x / speed, y: p.vel.y / speed };
    } else {
      const toBall = sub(ball.pos, p.pos);
      const d = len(toBall);
      if (d > 0.5) mem.heading = { x: toBall.x / d, y: toBall.y / d };
    }
    const sd = toScreenDir(cam, mem.heading);
    mem.facing = facingOf(sd.x, sd.y);

    if (speed > WALK_SPEED) mem.phase = (mem.phase + (speed * animDt) / 1000 / STRIDE_M) % 1;

    let pose: SpritePose;
    if (speed > WALK_SPEED) {
      const first: SpritePose = hasBall ? "carry" : "run1";
      pose = mem.phase < 0.5 ? first : "run2";
    } else if (receiving || hasBall || p.stunned > 0) {
      pose = "ready";
    } else {
      pose = "stand";
    }

    const near = nearestOpponentDist(state, p);
    const pressure = near < PRESSURE_RADIUS_M ? 1 - near / PRESSURE_RADIUS_M : 0;

    out.push({
      id: p.id,
      side: p.side,
      role: p.role,
      pos: p.pos,
      fatigue: p.fatigue,
      kit: kitFor(p),
      facing: mem.facing,
      pose,
      variant: hashVariant(p.id),
      speed,
      hasBall,
      receiving,
      pressure,
      keeper: p.role === 1,
    });
  }
  return out;
}

/** Ball height (m) inferred from flight: a struck loose ball rises with speed, a controlled ball stays down. */
export function ballHeightM(state: MatchState): number {
  const b = state.ball;
  if (b.status !== "loose") return 0;
  const speed = len(b.vel);
  if (speed < 4) return 0;
  return Math.min(2.2, (speed - 4) * 0.12);
}
