import type { GestureRead } from "../gesture/gesture";
import type { ActiveWindow } from "../match/runtime";
import { add, len, scale, sub, type Vec2 } from "../sim/geometry";
import { opponents, playerById, pressureAt } from "../sim/perception";
import { buildOutLineX, goalPosts, type Rules } from "../sim/rules";
import type { MatchState, PlayerState } from "../sim/types";
import { toScreen, type Camera } from "./camera";
import { LIGHT, paintBall, paintFigure, paintSurround, paintTurf } from "./figures";

/**
 * Canvas 2D presentation of the live state (spec §21): a sunlit pitch with depth, navy/cyan
 * interface. During a moment the overlay keeps the ball, the controlled player, pressure and space
 * readable; it shows *where* each option would go (ghost markers) but never which one scores best.
 * Everything is drawn procedurally — no bitmap assets — so it costs nothing to load and scales to
 * any device pixel ratio.
 */

export interface RenderOptions {
  controlledId: string | null;
  window: ActiveWindow | null;
  /** Anchors for the options currently on offer (live positions), keyed by option id. */
  optionAnchors: Map<string, Vec2>;
  /** 0..1 slow-motion intensity for vignette/desaturation. */
  slow: number;
  /** 0..1 fast-forward intensity (ball trail, motion streaks). */
  fast?: number;
  /** Recent ball positions, oldest first, for the fast-forward trail. */
  trail?: readonly Vec2[];
  major: boolean;
}

const COLORS = {
  line: "rgba(255,255,255,0.88)",
  pressure: "rgba(255, 90, 70, 0.55)",
  space: "rgba(125, 230, 255, 0.28)",
  anchor: "rgba(234, 246, 255, 0.85)",
  preview: "#7de6ff",
  cancel: "rgba(255, 122, 89, 0.9)",
};

export function render(ctx: CanvasRenderingContext2D, cam: Camera, state: MatchState, opts: RenderOptions): void {
  const { width, height } = cam;
  ctx.clearRect(0, 0, width, height);
  drawSurround(ctx, cam, state.rules);
  drawGrass(ctx, cam, state.rules);
  drawMarkings(ctx, cam, state.rules);

  const controlled = opts.controlledId ? playerById(state, opts.controlledId) : null;
  if (opts.window && controlled) drawMomentField(ctx, cam, state, controlled, opts);

  const fast = opts.fast ?? 0;
  if (fast > 0.05 && opts.trail && opts.trail.length > 1) drawTrail(ctx, cam, opts.trail, fast);

  // painter's order: further down the screen draws later so figures overlap naturally
  const sorted = [...state.players].sort((a, b) => a.pos.y - b.pos.y);
  drawShadows(ctx, cam, sorted);
  for (const p of sorted) drawPlayer(ctx, cam, p, p.id === opts.controlledId, opts.window?.moment.playerId === p.id);
  drawBall(ctx, cam, state);

  if (opts.window && controlled) drawMomentOverlay(ctx, cam, state, controlled, opts);
  if (opts.slow > 0) drawVignette(ctx, cam, opts.slow, opts.major);
  if (fast > 0.05) drawFastFrame(ctx, cam, fast);
}

/** Beyond the touchlines: darker turf falling away into the evening, a hint of the stand. */
function drawSurround(ctx: CanvasRenderingContext2D, cam: Camera, rules: Rules): void {
  paintSurround(ctx, cam.width, cam.height);
  // running track / edge band around the pitch
  const tl = toScreen(cam, { x: -3, y: -3 });
  const br = toScreen(cam, { x: rules.length + 3, y: rules.width + 3 });
  ctx.fillStyle = "rgba(255, 235, 200, 0.06)";
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

function drawGrass(ctx: CanvasRenderingContext2D, cam: Camera, rules: Rules): void {
  const tl = toScreen(cam, { x: 0, y: 0 });
  const br = toScreen(cam, { x: rules.length, y: rules.width });
  paintTurf(ctx, { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }, 14);
  // worn goalmouths: the pitch has been played on
  for (const cx of [rules.penaltySpotDistance * 0.6, rules.length - rules.penaltySpotDistance * 0.6]) {
    const c = toScreen(cam, { x: cx, y: rules.width / 2 });
    const rad = 7 * cam.zoom;
    const wear = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
    wear.addColorStop(0, "rgba(120, 110, 60, 0.16)");
    wear.addColorStop(1, "rgba(120, 110, 60, 0)");
    ctx.fillStyle = wear;
    ctx.fillRect(c.x - rad, c.y - rad, rad * 2, rad * 2);
  }
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
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = Math.max(1, 0.12 * cam.zoom);
  ctx.lineCap = "butt";
  rect(ctx, cam, 0, 0, r.length, r.width);
  line(ctx, cam, { x: r.length / 2, y: 0 }, { x: r.length / 2, y: r.width });
  const c = toScreen(cam, { x: r.length / 2, y: r.width / 2 });
  ctx.beginPath();
  ctx.arc(c.x, c.y, r.centerCircleRadius * cam.zoom, 0, Math.PI * 2);
  ctx.stroke();
  for (const goalX of [0, r.length]) {
    const dir = goalX === 0 ? 1 : -1;
    const midY = r.width / 2;
    rect(ctx, cam, goalX, midY - r.penaltyAreaWidth / 2, goalX + dir * r.penaltyAreaDepth, midY + r.penaltyAreaWidth / 2);
    rect(ctx, cam, goalX, midY - r.goalAreaWidth / 2, goalX + dir * r.goalAreaDepth, midY + r.goalAreaWidth / 2);
    const spot = toScreen(cam, { x: goalX + dir * r.penaltySpotDistance, y: midY });
    ctx.beginPath();
    ctx.arc(spot.x, spot.y, Math.max(1.5, 0.15 * cam.zoom), 0, Math.PI * 2);
    ctx.fillStyle = COLORS.line;
    ctx.fill();
    if (r.buildOutLine) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      const bx = buildOutLineX(r, goalX);
      line(ctx, cam, { x: bx, y: 0 }, { x: bx, y: r.width });
      ctx.restore();
    }
    drawGoal(ctx, cam, r, goalX, dir);
  }
}

/** Goal frame with a shaded net so it reads as a box, not three lines. */
function drawGoal(ctx: CanvasRenderingContext2D, cam: Camera, r: Rules, goalX: number, dir: number): void {
  const [p1, p2] = goalPosts(r, goalX);
  const depth = 1.6 * -dir;
  const a = toScreen(cam, p1);
  const b = toScreen(cam, { x: p2.x + depth, y: p2.y });
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  // net mesh
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  const step = Math.max(3, 0.4 * cam.zoom);
  ctx.beginPath();
  for (let y = Math.min(a.y, b.y) + step; y < Math.max(a.y, b.y); y += step) {
    ctx.moveTo(Math.min(a.x, b.x), y);
    ctx.lineTo(Math.max(a.x, b.x), y);
  }
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = Math.max(2, 0.25 * cam.zoom);
  line(ctx, cam, p1, { x: p1.x + depth, y: p1.y });
  line(ctx, cam, p2, { x: p2.x + depth, y: p2.y });
  line(ctx, cam, { x: p1.x + depth, y: p1.y }, { x: p2.x + depth, y: p2.y });
  ctx.lineWidth = Math.max(1, 0.12 * cam.zoom);
  ctx.strokeStyle = COLORS.line;
}

const bodyRadius = (cam: Camera): number => Math.max(4, 0.55 * cam.zoom);

function drawShadows(ctx: CanvasRenderingContext2D, cam: Camera, players: readonly PlayerState[]): void {
  const r = bodyRadius(cam);
  ctx.fillStyle = "rgba(0, 10, 25, 0.32)";
  ctx.beginPath();
  for (const p of players) {
    const s = toScreen(cam, p.pos);
    ctx.moveTo(s.x + r * LIGHT.x + r * 1.15, s.y + r * LIGHT.y);
    ctx.ellipse(s.x + r * LIGHT.x, s.y + r * LIGHT.y, r * 1.15, r * 0.5, 0, 0, Math.PI * 2);
  }
  ctx.fill();
}

function drawPlayer(ctx: CanvasRenderingContext2D, cam: Camera, p: PlayerState, controlled: boolean, deciding: boolean): void {
  const s = toScreen(cam, p.pos);
  const r = bodyRadius(cam);
  const speed = len(p.vel);
  paintFigure(ctx, s.x, s.y, r, {
    kit: p.side === "home" ? "home" : "away",
    lean: speed > 0.5 ? { x: p.vel.x / speed, y: p.vel.y / speed } : null,
    fatigue: p.fatigue,
    label: cam.zoom > 9 ? String(p.role) : null,
    controlled,
    deciding,
    outline: p.role === 1,
  });
}

function drawBall(ctx: CanvasRenderingContext2D, cam: Camera, state: MatchState): void {
  const s = toScreen(cam, state.ball.pos);
  const r = Math.max(2.5, 0.28 * cam.zoom);
  const speed = len(state.ball.vel);
  // a struck ball rises: lift it off its shadow in proportion to speed
  const lift = state.ball.status === "loose" ? Math.min(r * 1.4, speed * 0.06 * cam.zoom) : 0;
  paintBall(ctx, s.x, s.y, r, lift);
}

/** Fading streak behind the ball while play is fast-forwarded: motion you can read at a glance. */
function drawTrail(ctx: CanvasRenderingContext2D, cam: Camera, trail: readonly Vec2[], fast: number): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // three bands of growing weight and opacity: a tapered streak in three strokes
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

/** Fast-forward frame: cinematic bars creep in so the eye knows the picture is accelerated. */
function drawFastFrame(ctx: CanvasRenderingContext2D, cam: Camera, fast: number): void {
  const { width, height } = cam;
  const bar = Math.round(height * 0.035 * fast);
  if (bar < 1) return;
  ctx.fillStyle = "rgba(4, 12, 26, 0.85)";
  ctx.fillRect(0, 0, width, bar);
  ctx.fillRect(0, height - bar, width, bar);
}

/** Under the players: pressure around the controlled player and the space the options point at. */
function drawMomentField(ctx: CanvasRenderingContext2D, cam: Camera, state: MatchState, me: PlayerState, opts: RenderOptions): void {
  const opps = opponents(state, me.side);
  const pressure = Math.min(1.5, pressureAt(me.pos, opps));
  const s = toScreen(cam, me.pos);
  const ring = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 8 * cam.zoom);
  ring.addColorStop(0, `rgba(255, 90, 70, ${0.08 + pressure * 0.25})`);
  ring.addColorStop(1, "rgba(255, 90, 70, 0)");
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 8 * cam.zoom, 0, Math.PI * 2);
  ctx.fill();

  for (const [, anchor] of opts.optionAnchors) {
    const a = toScreen(cam, anchor);
    const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, 4 * cam.zoom);
    g.addColorStop(0, COLORS.space);
    g.addColorStop(1, "rgba(125,230,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 4 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Over the players: option ghost markers, live drawing preview, cancel hint. */
function drawMomentOverlay(ctx: CanvasRenderingContext2D, cam: Camera, _state: MatchState, me: PlayerState, opts: RenderOptions): void {
  const w = opts.window!;
  const s = toScreen(cam, me.pos);
  const selectedId = w.selected?.id ?? null;
  for (const [id, anchor] of opts.optionAnchors) {
    const a = toScreen(cam, anchor);
    const selected = id === selectedId;
    ctx.strokeStyle = selected ? COLORS.preview : COLORS.anchor;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.setLineDash(selected ? [] : [5, 5]);
    ctx.beginPath();
    ctx.arc(a.x, a.y, Math.max(6, 0.9 * cam.zoom), 0, Math.PI * 2);
    ctx.stroke();
    if (selected) {
      ctx.setLineDash([8, 6]);
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.setLineDash([]);

  if (w.stage === "drawing") {
    // origin marker: releasing back here cancels
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
    ctx.fillText("tap where it should go", s.x, s.y - 2.6 * cam.zoom);
  }
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
    // arrow head on the intended direction — intent only, not a promise
    const end = toScreen(cam, read.end);
    const back = toScreen(cam, sub(read.end, scale(read.direction, 1.2)));
    const perp = { x: -(end.y - back.y) * 0.5, y: (end.x - back.x) * 0.5 };
    ctx.fillStyle = COLORS.preview;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(back.x + perp.x, back.y + perp.y);
    ctx.lineTo(back.x - perp.x, back.y - perp.y);
    ctx.closePath();
    ctx.fill();
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
