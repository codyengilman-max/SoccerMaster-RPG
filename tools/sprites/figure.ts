import type { SpriteDirection, SpriteKit, SpritePose } from "../../src/render/spriteLayout";
import { capsule, circle, clipped, ellipse, expand, recolor, rgba, roundRect, type Rgba, type Shape } from "./raster";

/**
 * Procedural youth soccer figure: head, torso, arms, legs, boots, kit trim, in five facings and five
 * poses. Proportions are deliberately young (large head, short torso) and stylised, not adult
 * professional. Original artwork; nothing is traced or sampled.
 */

export interface KitPalette {
  shirt: string;
  shade: string;
  trim: string;
  shorts: string;
  socks: string;
  sockTop: string;
  gloves?: string;
}

export const KIT_PALETTES: Readonly<Record<SpriteKit, KitPalette>> = {
  blue: { shirt: "#2160d8", shade: "#153f96", trim: "#35d6ff", shorts: "#0c1f44", socks: "#2160d8", sockTop: "#35d6ff" },
  coral: { shirt: "#f2634a", shade: "#b83f2c", trim: "#ffd9c9", shorts: "#4a1d16", socks: "#f2634a", sockTop: "#ffd9c9" },
  keeperHome: { shirt: "#1fb896", shade: "#147a63", trim: "#e6fff8", shorts: "#0c1f44", socks: "#1fb896", sockTop: "#e6fff8", gloves: "#eafff9" },
  keeperAway: { shirt: "#f0be2f", shade: "#b8891a", trim: "#4a3300", shorts: "#2b1d0e", socks: "#f0be2f", sockTop: "#4a3300", gloves: "#fff3c4" },
};

export interface Look {
  skin: string;
  hair: string;
}

export const LOOKS: readonly Look[] = [
  { skin: "#f3c9a3", hair: "#2b1c12" },
  { skin: "#c68b5b", hair: "#1a120c" },
  { skin: "#7a4a2e", hair: "#0f0a08" },
];

const BOOT = rgba("#1a2236");
const EYE = rgba("#1a1a24");
const OUTLINE = rgba("#0a1424", 0.55);

/** Facing as lateral (`f`, +1 = right) and frontal (`d`, +1 = toward the viewer) components. */
const DIRS: Readonly<Record<SpriteDirection, { f: number; d: number }>> = {
  S: { f: 0, d: 1 },
  SE: { f: 0.71, d: 0.71 },
  E: { f: 1, d: 0 },
  NE: { f: 0.71, d: -0.71 },
  N: { f: 0, d: -1 },
};

/** Frame 64×80 px; feet at y=74, head top at y≈6. */
export function figureShapes(kitId: SpriteKit, look: Look, dir: SpriteDirection, pose: SpritePose): Shape[] {
  const k = KIT_PALETTES[kitId];
  const { f, d } = DIRS[dir];
  const af = Math.abs(f);
  const cx = 32;
  const footY = 74;
  const keeper = kitId === "keeperHome" || kitId === "keeperAway";

  const running = pose === "run1" || pose === "run2" || pose === "carry";
  const stride = pose === "run2" ? -1 : running ? 1 : 0;
  const crouch = pose === "ready" ? 3 : pose === "carry" ? 1.5 : 0;
  const bounce = running ? 1.5 : 0;
  const leanX = running ? f * (pose === "carry" ? 3 : 2) : 0;
  const bodyY = footY - 30 - bounce + crouch; // top of shorts

  const skin = rgba(look.skin);
  const hair = rgba(look.hair);
  const shirt = rgba(k.shirt);
  const shade = rgba(k.shade);
  const trim = rgba(k.trim);
  const shorts = rgba(k.shorts);
  const socks = rgba(k.socks);
  const sockTop = rgba(k.sockTop);
  const gloves = rgba(k.gloves ?? look.skin);

  const spread = 1 - 0.7 * af; // paired limbs collapse toward the centre line in profile
  const hipHalf = 3.4 * spread + 0.8;
  const shoulderHalf = 6.4 * spread + 1.4;
  const torsoHalf = 7.2 * spread + 1.6;

  const body: Shape[] = [];
  const back: Shape[] = [];
  const front: Shape[] = [];

  // ---- legs (hip → foot), the far leg drawn first
  const legR = 2.5;
  const legs: Array<{ hx: number; fx: number; fy: number; lift: number; far: boolean }> = [];
  for (const side of [-1, 1] as const) {
    const s = side * stride; // +1 = this leg is forward
    const hx = cx + leanX * 0.4 + side * hipHalf + (af > 0.5 ? side * 0.6 : 0);
    const fx = hx + s * f * 6 + (pose === "ready" ? side * 2 : 0);
    const fy = footY + s * d * 3.2 - (s > 0 && running ? 3 : 0);
    const far = side * f < -0.3 || (af < 0.3 && s * d < -0.3);
    legs.push({ hx, fx, fy, lift: s > 0 && running ? 1 : 0, far });
  }
  legs.sort((a, b) => Number(b.far) - Number(a.far));
  for (const l of legs) {
    const kneeX = (l.hx + l.fx) / 2 + (running ? f * 1.5 * l.lift : 0);
    const kneeY = bodyY + 9 + (l.lift ? -2 : 0) + crouch * 0.6;
    const dark = l.far ? 0.82 : 1;
    const tone = (c: Rgba): Rgba => [c[0] * dark, c[1] * dark, c[2] * dark, c[3]];
    body.push(capsule(l.hx, bodyY + 6, kneeX, kneeY, legR, tone(skin)));
    body.push(capsule(kneeX, kneeY, l.fx, l.fy - 2, legR, tone(skin)));
    // socks: lower half of the shin
    const sx = kneeX + (l.fx - kneeX) * 0.45;
    const sy = kneeY + (l.fy - 2 - kneeY) * 0.45;
    body.push(capsule(sx, sy, l.fx, l.fy - 2, legR + 0.2, tone(socks)));
    body.push(capsule(sx, sy, sx + (l.fx - sx) * 0.18, sy + (l.fy - 2 - sy) * 0.18, legR + 0.3, tone(sockTop)));
    body.push(ellipse(l.fx + f * 1.2, l.fy - 0.6, 3.6 - af * 0.6, 1.9 + af * 0.6, tone(BOOT)));
  }

  // ---- shorts
  body.push(roundRect(cx + leanX * 0.5 - hipHalf - 2.4, bodyY, (hipHalf + 2.4) * 2, 9, 3, shorts));

  // ---- torso
  const torsoTop = bodyY - 17;
  const torsoX = cx + leanX * 0.8;
  body.push(roundRect(torsoX - torsoHalf, torsoTop, torsoHalf * 2, 19, 5, shirt));
  // shade: the side away from the top-left light, plus the back of the shirt when facing away
  const shadeClip = (x: number, y: number): boolean => x > torsoX + torsoHalf * (0.25 - (d < 0 ? 0.6 : 0)) && y > torsoTop + 2;
  body.push(clipped(roundRect(torsoX - torsoHalf, torsoTop, torsoHalf * 2, 19, 5, shade), shadeClip));
  // trim: collar and a chest band; the number goes on the front at render time
  body.push(clipped(ellipse(torsoX + f * 2, torsoTop + 1.5, 4.5 * spread + 1.2, 2.4, trim), (x, y) => y >= torsoTop - 0.2));
  if (d > 0.2) body.push(roundRect(torsoX - torsoHalf + 1.5, torsoTop + 13, torsoHalf * 2 - 3, 1.6, 0.8, trim));
  if (d < -0.2) body.push(roundRect(torsoX - torsoHalf + 2, torsoTop + 5, torsoHalf * 2 - 4, 1.4, 0.7, trim));

  // ---- arms
  const armR = 2.1;
  for (const side of [-1, 1] as const) {
    const s = side * stride;
    const sx = torsoX + side * shoulderHalf + (af > 0.5 ? side * 0.4 : 0);
    const sy = torsoTop + 3.5;
    let hx: number;
    let hy: number;
    if (pose === "ready") {
      hx = sx + side * 6.5 * spread + f * 3;
      hy = sy + 11;
    } else if (running) {
      // arms swing opposite to the legs
      hx = sx - s * f * 5 + side * 1.5 * spread;
      hy = sy + 12 - s * d * 3 - (pose === "carry" ? 0 : 1);
    } else {
      hx = sx + side * 1.8 * spread;
      hy = sy + 15;
    }
    const far = side * f < -0.3;
    const dark = far ? 0.82 : 1;
    const tone = (c: Rgba): Rgba => [c[0] * dark, c[1] * dark, c[2] * dark, c[3]];
    const list = far ? back : front;
    const ex = (sx + hx) / 2 + (pose === "ready" ? side * 1.5 : 0);
    const ey = (sy + hy) / 2 + 1;
    list.push(capsule(sx, sy, ex, ey, armR, tone(keeper ? shirt : skin)));
    list.push(capsule(ex, ey, hx, hy, armR, tone(keeper ? shirt : skin)));
    list.push(capsule(sx, sy, sx + (ex - sx) * 0.5, sy + (ey - sy) * 0.5, armR + 0.5, tone(shirt)));
    list.push(circle(hx, hy, keeper ? 3.1 : 2.3, tone(gloves)));
  }

  // ---- head
  const headR = 9.2;
  const hx0 = cx + leanX * 1.3 + f * (running ? 1 : 0.4);
  const hy0 = torsoTop - headR + 1.5 + (pose === "ready" ? 1 : 0);
  const head: Shape[] = [];
  head.push(circle(hx0, hy0, headR, skin));
  if (d > 0.15) {
    // eyes offset toward the facing side, spacing narrows in three-quarter view
    const gap = 3.2 * (1 - 0.55 * af);
    const ex = hx0 + f * 3.4;
    const ey = hy0 + 1.6;
    head.push(ellipse(ex - gap, ey, 1.1, 1.4, EYE));
    head.push(ellipse(ex + gap, ey, 1.1, 1.4, EYE));
    head.push(capsule(ex - 1.2 + f, ey + 4.2, ex + 1.2 + f, ey + 4.2, 0.6, rgba("#8a4a3a", 0.8)));
    // fringe cap
    head.push(clipped(circle(hx0, hy0 - 0.6, headR + 0.2, hair), (x, y) => y < hy0 - 2.6 + (x - hx0) * f * 0.25));
    head.push(capsule(hx0 - headR + 1.2, hy0 - 2, hx0 - headR + 1.2, hy0 + 3, 1.6, hair));
    head.push(capsule(hx0 + headR - 1.2, hy0 - 2, hx0 + headR - 1.2, hy0 + 3, 1.6, hair));
  } else if (d > -0.15) {
    // profile: one eye, hair covering the back half
    head.push(ellipse(hx0 + f * 5.2, hy0 + 1.6, 1.1, 1.4, EYE));
    head.push(clipped(circle(hx0, hy0, headR + 0.2, hair), (x, y) => y < hy0 - 2.4 || (x - hx0) * f < -1.5));
  } else {
    // back of the head
    head.push(clipped(circle(hx0, hy0, headR + 0.2, hair), (_x, y) => y < hy0 + headR * 0.8));
    head.push(clipped(circle(hx0, hy0 + 1, headR - 1.5, rgba(look.hair, 0.5)), (_x, y) => y < hy0 + headR * 0.8));
  }
  // neck
  const neck = capsule(hx0, hy0 + headR - 2, torsoX, torsoTop + 2, 2.2, skin);

  const all = [...back, ...body, neck, ...front, ...head];
  const outline = all.map((s) => recolor(expand(s, 0.9), OUTLINE));
  return [...outline, ...all];
}
