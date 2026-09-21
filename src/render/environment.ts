import { goalPosts, type Rules } from "../sim/rules";
import type { Vec2 } from "../sim/geometry";
import { toScreen, type Camera } from "./camera";

/**
 * Field and surroundings: banded grass with a faint texture, dimensional goals with netting, corner
 * flags, low perimeter fencing, two benches and a restrained Arizona-desert backdrop behind the far
 * edge. All procedural; sized in field metres so it scales with the camera and never distorts.
 */

export const GRASS = { light: "#4a9e50", dark: "#3f8f47", line: "rgba(255,255,255,0.9)" };

/** Distance from the pitch boundary to the perimeter fence, in metres. */
export const FENCE_OFF_M = 2;

let texture: CanvasPattern | null | undefined;

/** Tiny tiled noise for grass grain; created once, skipped where canvases are unavailable (tests). */
function grassTexture(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (texture !== undefined) return texture;
  texture = null;
  try {
    if (typeof document === "undefined") return null;
    const tile = document.createElement("canvas");
    tile.width = 48;
    tile.height = 48;
    const t = tile.getContext("2d");
    if (!t) return null;
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 260; i++) {
      const a = 0.04 + rnd() * 0.07;
      t.fillStyle = rnd() < 0.5 ? `rgba(255,255,220,${a})` : `rgba(0,30,10,${a})`;
      t.fillRect(Math.floor(rnd() * 48), Math.floor(rnd() * 48), 1 + Math.floor(rnd() * 2), 1);
    }
    texture = ctx.createPattern(tile, "repeat");
  } catch {
    texture = null;
  }
  return texture;
}

/** Everything behind the pitch: dusty ground, evening sky and mountains beyond the far edge. */
export function drawBackdrop(ctx: CanvasRenderingContext2D, cam: Camera, rules: Rules): void {
  const { width, height } = cam;
  const ground = ctx.createLinearGradient(0, 0, 0, height);
  ground.addColorStop(0, "#5a6b3c");
  ground.addColorStop(0.35, "#3c6e3a");
  ground.addColorStop(1, "#2a5230");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);

  // the far edge of the pitch on screen (top touchline in landscape, far goal line in portrait)
  const farEdge = cam.portrait ? toScreen(cam, { x: rules.length, y: rules.width / 2 }).y : toScreen(cam, { x: rules.length / 2, y: 0 }).y;
  const horizon = farEdge - (FENCE_OFF_M + 1) * cam.zoom;
  const top = cam.insetTop;
  if (horizon < top + 6) return;

  const sky = ctx.createLinearGradient(0, top, 0, horizon);
  sky.addColorStop(0, "#2b3f70");
  sky.addColorStop(0.55, "#b8657a");
  sky.addColorStop(1, "#f0a663");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizon);

  // two mountain layers: hazy far ridge, darker near ridge
  const ridge = (amp: number, phase: number, color: string, base: number): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, horizon + 2);
    const n = Math.max(6, Math.round(width / 90));
    for (let i = 0; i <= n; i++) {
      const x = (width * i) / n;
      const h = amp * (0.45 + 0.55 * Math.abs(Math.sin(i * 1.7 + phase) * Math.cos(i * 0.6 + phase)));
      ctx.lineTo(x, base - h);
    }
    ctx.lineTo(width, horizon + 2);
    ctx.closePath();
    ctx.fill();
  };
  const rise = Math.min((horizon - top) * 0.7, 90);
  ridge(rise, 0.4, "rgba(110, 70, 110, 0.55)", horizon - rise * 0.15);
  ridge(rise * 0.7, 2.1, "rgba(70, 40, 60, 0.85)", horizon);
  // dusty sand strip between mountains and fence; the verge inside the fence stays grass
  const fence = farEdge - FENCE_OFF_M * cam.zoom;
  const sand = ctx.createLinearGradient(0, horizon, 0, fence);
  sand.addColorStop(0, "#b48a5c");
  sand.addColorStop(1, "#8a7a4c");
  ctx.fillStyle = sand;
  ctx.fillRect(0, horizon, width, fence - horizon);
}

/** Banded grass in field space with a faint grain. */
export function drawGrass(ctx: CanvasRenderingContext2D, cam: Camera, rules: Rules): void {
  const bands = 14;
  const bandLen = rules.length / bands;
  for (let i = 0; i < bands; i++) {
    const a = toScreen(cam, { x: i * bandLen, y: 0 });
    const b = toScreen(cam, { x: (i + 1) * bandLen, y: rules.width });
    ctx.fillStyle = i % 2 === 0 ? GRASS.light : GRASS.dark;
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x) + 0.5, Math.abs(b.y - a.y) + 0.5);
  }
  const tl = toScreen(cam, { x: 0, y: 0 });
  const br = toScreen(cam, { x: rules.length, y: rules.width });
  const x = Math.min(tl.x, br.x);
  const y = Math.min(tl.y, br.y);
  const w = Math.abs(br.x - tl.x);
  const h = Math.abs(br.y - tl.y);
  const grain = grassTexture(ctx);
  if (grain) {
    ctx.fillStyle = grain;
    ctx.fillRect(x, y, w, h);
  }
  // warm evening light from the top-left, cooler toward the far corner
  const light = ctx.createLinearGradient(x, y, x + w, y + h);
  light.addColorStop(0, "rgba(255, 214, 150, 0.16)");
  light.addColorStop(0.5, "rgba(255, 214, 150, 0.03)");
  light.addColorStop(1, "rgba(10, 30, 70, 0.18)");
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w, h);
  // worn goalmouths
  for (const gx of [rules.penaltySpotDistance * 0.55, rules.length - rules.penaltySpotDistance * 0.55]) {
    const c = toScreen(cam, { x: gx, y: rules.width / 2 });
    const rad = 6 * cam.zoom;
    const wear = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
    wear.addColorStop(0, "rgba(130, 115, 60, 0.18)");
    wear.addColorStop(1, "rgba(130, 115, 60, 0)");
    ctx.fillStyle = wear;
    ctx.fillRect(c.x - rad, c.y - rad, rad * 2, rad * 2);
  }
}

/** Low fence a few metres outside the touchlines, benches on the near side, corner flags. */
export function drawFurniture(ctx: CanvasRenderingContext2D, cam: Camera, rules: Rules): void {
  const z = cam.zoom;
  const off = FENCE_OFF_M;
  // low fence right round the pitch (posts every 5 m, a rail between); posts stand up the screen
  ctx.strokeStyle = "rgba(230, 220, 200, 0.55)";
  ctx.lineWidth = Math.max(1, 0.06 * z);
  const postH = 0.9 * z;
  // posts are gathered into one path and filled once
  const post = (p: Vec2): void => {
    ctx.rect(p.x - 1, p.y - postH, 2, postH);
  };
  // two rails between the post tops and their middles, plus a soft ground shadow under the fence line
  const rail = (a: Vec2, b: Vec2): void => {
    const sa = toScreen(cam, a);
    const sb = toScreen(cam, b);
    ctx.strokeStyle = "rgba(0, 10, 25, 0.18)";
    ctx.lineWidth = Math.max(1, 0.1 * z);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y + 1);
    ctx.lineTo(sb.x, sb.y + 1);
    ctx.stroke();
    ctx.strokeStyle = "rgba(230, 220, 200, 0.55)";
    ctx.lineWidth = Math.max(1, 0.06 * z);
    for (const lift of [postH, postH * 0.5]) {
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y - lift);
      ctx.lineTo(sb.x, sb.y - lift);
      ctx.stroke();
    }
  };
  for (const y of [-off, rules.width + off]) rail({ x: -off, y }, { x: rules.length + off, y });
  for (const x of [-off, rules.length + off]) rail({ x, y: -off }, { x, y: rules.width + off });
  ctx.fillStyle = "rgba(230, 220, 200, 0.7)";
  ctx.beginPath();
  for (const y of [-off, rules.width + off]) {
    for (let x = -off; x <= rules.length + off + 0.01; x += 5) post(toScreen(cam, { x, y }));
  }
  for (const x of [-off, rules.length + off]) {
    for (let y = -off + 5; y < rules.width + off; y += 5) post(toScreen(cam, { x, y }));
  }
  ctx.fill();
  // benches: two low navy boxes beside the near touchline
  for (const bx of [rules.length / 2 - 14, rules.length / 2 + 8]) {
    const a = toScreen(cam, { x: bx, y: rules.width + off * 0.55 });
    const b = toScreen(cam, { x: bx + 6, y: rules.width + off * 0.55 + 1.1 });
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    ctx.fillStyle = "rgba(0, 10, 25, 0.35)";
    ctx.fillRect(x + 2, y + 3, w, h);
    ctx.fillStyle = "#12305c";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(125, 230, 255, 0.35)";
    ctx.fillRect(x, y, w, Math.max(1, h * 0.18));
  }
  // corner flags
  for (const c of [
    { x: 0, y: 0 },
    { x: rules.length, y: 0 },
    { x: 0, y: rules.width },
    { x: rules.length, y: rules.width },
  ]) {
    const p = toScreen(cam, c);
    const h = 1.5 * z;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(1, 0.08 * z);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x, p.y - h);
    ctx.stroke();
    ctx.fillStyle = "#ff7a59";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - h);
    ctx.lineTo(p.x + 0.7 * z, p.y - h + 0.25 * z);
    ctx.lineTo(p.x, p.y - h + 0.5 * z);
    ctx.closePath();
    ctx.fill();
  }
}

/** Goal frame with a shaded net box behind the line and posts that read as uprights. */
export function drawGoal(ctx: CanvasRenderingContext2D, cam: Camera, r: Rules, goalX: number): void {
  const dir = goalX === 0 ? -1 : 1; // net extends away from the pitch
  const depth = 1.6 * dir;
  const [p1, p2] = goalPosts(r, goalX);
  const a = toScreen(cam, p1);
  const b = toScreen(cam, { x: p2.x + depth, y: p2.y });
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  // net body
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  const step = Math.max(4, 0.5 * cam.zoom);
  ctx.beginPath();
  for (let d = -h; d < w + h; d += step) {
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + h, y + h);
    ctx.moveTo(x + d + h, y);
    ctx.lineTo(x + d, y + h);
  }
  ctx.stroke();
  ctx.restore();
  // a lit top edge gives the box volume
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  if (cam.portrait) ctx.fillRect(x, y, w, Math.max(1, 0.12 * cam.zoom));
  else ctx.fillRect(x, y, Math.max(1, 0.12 * cam.zoom), h);
  // frame
  const post = (fa: { x: number; y: number }, fb: { x: number; y: number }): void => {
    const sa = toScreen(cam, fa);
    const sb = toScreen(cam, fb);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  };
  ctx.strokeStyle = "rgba(255,255,255,0.97)";
  ctx.lineWidth = Math.max(2, 0.22 * cam.zoom);
  ctx.lineCap = "round";
  post(p1, { x: p1.x + depth, y: p1.y });
  post(p2, { x: p2.x + depth, y: p2.y });
  post({ x: p1.x + depth, y: p1.y }, { x: p2.x + depth, y: p2.y });
  post(p1, p2);
  ctx.lineCap = "butt";
}
