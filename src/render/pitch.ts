import type { GestureRead } from "../gesture/gesture";
import type { ActiveWindow } from "../match/runtime";
import { add, scale, sub, type Vec2 } from "../sim/geometry";
import { buildOutLineX, type Rules } from "../sim/rules";
import type { MatchState } from "../sim/types";
import { toScreen, type Camera } from "./camera";
import { drawBackdrop, drawFurniture, drawGoal, drawGrass, GRASS } from "./environment";
import { LIGHT, paintBall, paintFigure } from "./figures";
import type { PlayerVisual } from "./presentation";
import { drawSprite, type SpriteSet } from "./sprites";

/**
 * Canvas 2D presentation of the live state (spec §21). The picture is derived from the authoritative
 * match state through the presentation adapter: sprites (or procedural fallbacks) for the players,
 * a ball with height and shadow, the environment, and — during a moment — a restrained tactical
 * overlay that shows *where* each option would go but never which one scores best.
 */

export interface RenderOptions {
  controlledId: string | null;
  window: ActiveWindow | null;
  /** Anchors for the options currently on offer (live positions), keyed by option id. */
  optionAnchors: Map<string, Vec2>;
  /** 0..1 slow-motion intensity for vignette/focus. */
  slow: number;
  /** 0..1 fast-forward intensity (ball trail, motion streaks). */
  fast?: number;
  /** Recent ball positions, oldest first, for the fast-forward trail. */
  trail?: readonly Vec2[];
  major: boolean;
  /** Per-player visual state from the presentation adapter. */
  visuals: readonly PlayerVisual[];
  /** Loaded sprite sheets; null or a missing kit falls back to procedural figures. */
  sprites: SpriteSet | null;
  /** Ball display position (authoritative position carried by the sub-tick remainder). */
  ballPos?: Vec2;
  /** Ball height above the turf in metres. */
  ballHeightM: number;
  /** Real seconds, for subtle pulses. */
  timeS: number;
  /** Show diagnostic labels (numbers on every player, pressure values). */
  debug?: boolean;
}

const COLORS = {
  pressure: "rgba(255, 90, 70, 0.55)",
  space: "rgba(125, 230, 255, 0.28)",
  anchor: "rgba(234, 246, 255, 0.85)",
  preview: "#7de6ff",
  cancel: "rgba(255, 122, 89, 0.9)",
  select: "rgba(53, 214, 255, 0.95)",
  receive: "rgba(255, 255, 255, 0.75)",
};

/** Figure height in px: readable at phone scale, capped so desktop figures stay youth-sized. */
export const figureHeightPx = (cam: Camera): number => Math.min(40, Math.max(16, 2.2 * cam.zoom));

export function render(ctx: CanvasRenderingContext2D, cam: Camera, state: MatchState, opts: RenderOptions): void {
  const { width, height } = cam;
  ctx.clearRect(0, 0, width, height);
  drawBackdrop(ctx, cam, state.rules);
  drawGrass(ctx, cam, state.rules);
  drawFurniture(ctx, cam, state.rules);
  drawMarkings(ctx, cam, state.rules);

  const controlled = opts.controlledId ? opts.visuals.find((v) => v.id === opts.controlledId) ?? null : null;
  if (opts.window && controlled) drawMomentField(ctx, cam, controlled, opts);

  const fast = opts.fast ?? 0;
  if (fast > 0.05 && opts.trail && opts.trail.length > 1) drawTrail(ctx, cam, opts.trail, fast);

  // painter's order: further down the screen draws later so figures overlap naturally
  const placed = opts.visuals.map((v) => ({ v, s: toScreen(cam, v.pos) })).sort((a, b) => a.s.y - b.s.y);
  const h = figureHeightPx(cam);
  drawShadows(ctx, placed, h);
  drawGroundMarkers(ctx, placed, h, opts);
  const ballPos = opts.ballPos ?? state.ball.pos;
  const ballScreen = toScreen(cam, ballPos);
  let ballDrawn = false;
  for (const { v, s } of placed) {
    // a grounded ball at a player's feet is painted just before that player so the figure stands over it
    if (!ballDrawn && opts.ballHeightM < 0.2 && ballScreen.y <= s.y + h * 0.05) {
      drawBall(ctx, cam, ballPos, opts.ballHeightM);
      ballDrawn = true;
    }
    drawPlayer(ctx, cam, v, s, h, opts);
  }
  if (!ballDrawn) drawBall(ctx, cam, ballPos, opts.ballHeightM);

  if (opts.window && controlled) drawMomentOverlay(ctx, cam, controlled, opts);
  if (opts.slow > 0) drawVignette(ctx, cam, opts.slow, opts.major);
  if (fast > 0.05) drawFastFrame(ctx, cam, fast);
}

function line(ctx: CanvasRenderingContext2D, cam: Camera, a: Vec2, b: Vec2): void {
  const sa = toScreen(cam, a);
  const sb = toScreen(cam, b);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
}

function rect(ctx: CanvasRenderingContext2D, cam: Camera, x0: number, y0: number, x1: number, y1: number): void {
  const a = toScreen(cam, { x: x0, y: y0 });
  const b = toScreen(cam, { x: x1, y: y1 });
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
}

function drawMarkings(ctx: CanvasRenderingContext2D, cam: Camera, r: Rules): void {
  ctx.strokeStyle = GRASS.line;
  ctx.lineWidth = Math.max(1, 0.12 * cam.zoom);
  ctx.lineCap = "butt";
  rect(ctx, cam, 0, 0, r.length, r.width);
  line(ctx, cam, { x: r.length / 2, y: 0 }, { x: r.length / 2, y: r.width });
  const c = toScreen(cam, { x: r.length / 2, y: r.width / 2 });
  ctx.beginPath();
  ctx.arc(c.x, c.y, r.centerCircleRadius * cam.zoom, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.max(1.5, 0.15 * cam.zoom), 0, Math.PI * 2);
  ctx.fillStyle = GRASS.line;
  ctx.fill();
  for (const goalX of [0, r.length]) {
    const dir = goalX === 0 ? 1 : -1;
    const midY = r.width / 2;
    rect(ctx, cam, goalX, midY - r.penaltyAreaWidth / 2, goalX + dir * r.penaltyAreaDepth, midY + r.penaltyAreaWidth / 2);
    rect(ctx, cam, goalX, midY - r.goalAreaWidth / 2, goalX + dir * r.goalAreaDepth, midY + r.goalAreaWidth / 2);
    const spot = toScreen(cam, { x: goalX + dir * r.penaltySpotDistance, y: midY });
    ctx.beginPath();
    ctx.arc(spot.x, spot.y, Math.max(1.5, 0.15 * cam.zoom), 0, Math.PI * 2);
    ctx.fill();
    if (r.buildOutLine) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      const bx = buildOutLineX(r, goalX);
      line(ctx, cam, { x: bx, y: 0 }, { x: bx, y: r.width });
      ctx.restore();
    }
    drawGoal(ctx, cam, r, goalX);
    ctx.strokeStyle = GRASS.line;
    ctx.lineWidth = Math.max(1, 0.12 * cam.zoom);
  }
}

interface Placed {
  v: PlayerVisual;
  s: Vec2;
}

function drawShadows(ctx: CanvasRenderingContext2D, placed: readonly Placed[], h: number): void {
  const rx = h * 0.3;
  const ry = h * 0.11;
  ctx.fillStyle = "rgba(0, 10, 25, 0.3)";
  ctx.beginPath();
  for (const { s } of placed) {
    ctx.moveTo(s.x + rx * LIGHT.x + rx, s.y + ry * 0.6);
    ctx.ellipse(s.x + rx * LIGHT.x * 0.6, s.y + ry * 0.6, rx, ry, 0, 0, Math.PI * 2);
  }
  ctx.fill();
}

/** Rings under the feet: selected player (cyan, pulsing only while a decision is open), intended receiver. */
function drawGroundMarkers(ctx: CanvasRenderingContext2D, placed: readonly Placed[], h: number, opts: RenderOptions): void {
  const deciding = opts.window?.moment.playerId ?? null;
  for (const { v, s } of placed) {
    if (v.id === opts.controlledId) {
      const pulse = deciding === v.id ? 0.5 + 0.5 * Math.sin(opts.timeS * 5) : 0;
      const rx = h * 0.42 + pulse * h * 0.08;
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = Math.max(1.5, h * 0.06);
      ctx.globalAlpha = 0.75 + 0.25 * pulse;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + h * 0.04, rx, rx * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (v.receiving && opts.window) {
      ctx.strokeStyle = COLORS.receive;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + h * 0.04, h * 0.36, h * 0.15, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, cam: Camera, v: PlayerVisual, s: Vec2, h: number, opts: RenderOptions): void {
  const drawn = drawSprite(ctx, opts.sprites, { kit: v.kit, pose: v.pose, facing: v.facing, variant: v.variant }, s.x, s.y, h);
  if (!drawn) {
    paintFigure(ctx, s.x, s.y - h * 0.18, h * 0.3, {
      kit: v.keeper ? "keeper" : v.side === "home" ? "home" : "away",
      lean: v.speed > 0.5 ? { x: 0, y: 0 } : null,
      fatigue: v.fatigue,
      label: null,
      controlled: false,
      deciding: false,
      outline: v.keeper,
    });
  }
  const showNumber = opts.debug || v.id === opts.controlledId || cam.zoom >= 11;
  if (showNumber) {
    const size = Math.max(8, h * 0.28);
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = opts.debug ? `${v.role} ${v.pressure > 0 ? v.pressure.toFixed(1) : ""}`.trim() : String(v.role);
    const y = s.y - h * 0.5;
    ctx.lineWidth = Math.max(2, size * 0.28);
    ctx.strokeStyle = "rgba(6, 16, 31, 0.75)";
    ctx.strokeText(label, s.x, y);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(label, s.x, y);
    ctx.textBaseline = "alphabetic";
  }
}

function drawBall(ctx: CanvasRenderingContext2D, cam: Camera, pos: Vec2, heightM: number): void {
  const s = toScreen(cam, pos);
  const r = Math.max(2.5, 0.24 * cam.zoom);
  paintBall(ctx, s.x, s.y, r, heightM * cam.zoom * 0.9);
}

/** Fading streak behind the ball while play is fast-forwarded: motion you can read at a glance. */
function drawTrail(ctx: CanvasRenderingContext2D, cam: Camera, trail: readonly Vec2[], fast: number): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const n = trail.length;
  const bands = 3;
  for (let b = 0; b < bands; b++) {
    const from = Math.max(1, Math.floor((n * b) / bands));
    const to = Math.floor((n * (b + 1)) / bands);
    if (to <= from) continue;
    const t = (b + 1) / bands;
    ctx.strokeStyle = `rgba(255, 247, 224, ${0.55 * t * fast})`;
    ctx.lineWidth = Math.max(1, 0.22 * cam.zoom * t);
    ctx.beginPath();
    const start = toScreen(cam, trail[from - 1]!);
    ctx.moveTo(start.x, start.y);
    for (let i = from; i < to; i++) {
      const s = toScreen(cam, trail[i]!);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }
}

/** Fast-forward frame: thin cinematic bars creep in so the eye knows the picture is accelerated. */
function drawFastFrame(ctx: CanvasRenderingContext2D, cam: Camera, fast: number): void {
  const { width, height } = cam;
  const bar = Math.round(height * 0.025 * fast);
  if (bar < 1) return;
  ctx.fillStyle = "rgba(4, 12, 26, 0.85)";
  ctx.fillRect(0, 0, width, bar);
  ctx.fillRect(0, height - bar, width, bar);
}

/** Under the players: pressure around the controlled player and the space the options point at. */
function drawMomentField(ctx: CanvasRenderingContext2D, cam: Camera, me: PlayerVisual, opts: RenderOptions): void {
  const s = toScreen(cam, me.pos);
  const focus = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 9 * cam.zoom);
  focus.addColorStop(0, "rgba(255, 236, 200, 0.10)");
  focus.addColorStop(1, "rgba(255, 236, 200, 0)");
  ctx.fillStyle = focus;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 9 * cam.zoom, 0, Math.PI * 2);
  ctx.fill();
  if (me.pressure > 0.05) {
    const ring = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 5 * cam.zoom);
    ring.addColorStop(0, `rgba(255, 90, 70, ${0.05 + me.pressure * 0.3})`);
    ring.addColorStop(1, "rgba(255, 90, 70, 0)");
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  // opponents pressing the controlled player get a faint coral ground arc
  for (const v of opts.visuals) {
    if (v.side === me.side) continue;
    const d = Math.hypot(v.pos.x - me.pos.x, v.pos.y - me.pos.y);
    if (d > 4) continue;
    const o = toScreen(cam, v.pos);
    ctx.strokeStyle = COLORS.pressure;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(o.x, o.y + 2, 0.7 * cam.zoom, 0.3 * cam.zoom, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const [, anchor] of opts.optionAnchors) {
    const a = toScreen(cam, anchor);
    const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, 3.5 * cam.zoom);
    g.addColorStop(0, COLORS.space);
    g.addColorStop(1, "rgba(125,230,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3.5 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Over the players: option markers, the selected lane, live drawing preview, cancel hint. */
function drawMomentOverlay(ctx: CanvasRenderingContext2D, cam: Camera, me: PlayerVisual, opts: RenderOptions): void {
  const w = opts.window!;
  const s = toScreen(cam, me.pos);
  const selectedId = w.selected?.id ?? null;
  const dashOffset = -(opts.timeS * 24) % 14;
  for (const [id, anchor] of opts.optionAnchors) {
    const a = toScreen(cam, anchor);
    const selected = id === selectedId;
    ctx.strokeStyle = selected ? COLORS.preview : COLORS.anchor;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.setLineDash(selected ? [] : [5, 5]);
    ctx.lineDashOffset = 0;
    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(6, 0.8 * cam.zoom), 0, Math.PI * 2);
    ctx.stroke();
    if (selected) {
      // suggested lane: thin, animated dashes; the confirmed drawing is drawn solid below
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = dashOffset;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      arrowHead(ctx, s, a, Math.max(5, 0.5 * cam.zoom), COLORS.preview);
    }
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;

  if (w.stage === "drawing") {
    ctx.strokeStyle = COLORS.cancel;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.5 * cam.zoom, 0, Math.PI * 2);
    ctx.stroke();
    if (w.previewPoints.length > 1) drawPreviewPath(ctx, cam, w.previewPoints, w.preview);
  }
  if (w.stage === "targeting") {
    ctx.fillStyle = "rgba(234,246,255,0.9)";
    ctx.font = `${Math.max(11, 0.9 * cam.zoom)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("tap where it should go", s.x, s.y - 2.6 * cam.zoom - figureHeightPx(cam));
  }
}

function arrowHead(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, size: number, color: string): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  if (l < 1) return;
  const ux = dx / l;
  const uy = dy / l;
  const bx = to.x - ux * size;
  const by = to.y - uy * size;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(bx - uy * size * 0.5, by + ux * size * 0.5);
  ctx.lineTo(bx + uy * size * 0.5, by - ux * size * 0.5);
  ctx.closePath();
  ctx.fill();
}

function drawPreviewPath(ctx: CanvasRenderingContext2D, cam: Camera, points: readonly Vec2[], read: GestureRead | null): void {
  ctx.strokeStyle = read ? COLORS.preview : COLORS.cancel;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const first = toScreen(cam, points[0]!);
  ctx.moveTo(first.x, first.y);
  for (const p of points.slice(1)) {
    const s = toScreen(cam, p);
    ctx.lineTo(s.x, s.y);
  }
  ctx.stroke();
  if (read) {
    const end = toScreen(cam, read.end);
    const back = toScreen(cam, sub(read.end, scale(read.direction, 1.2)));
    arrowHead(ctx, back, end, Math.hypot(end.x - back.x, end.y - back.y), COLORS.preview);
    const ghost = toScreen(cam, add(read.origin, scale(read.direction, read.length)));
    ctx.strokeStyle = "rgba(125,230,255,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ghost.x, ghost.y, 0.6 * cam.zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawVignette(ctx: CanvasRenderingContext2D, cam: Camera, slow: number, major: boolean): void {
  const { width, height } = cam;
  const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.75);
  g.addColorStop(0, "rgba(6,16,31,0)");
  g.addColorStop(1, `rgba(6,16,31,${(major ? 0.7 : 0.45) * slow})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}
