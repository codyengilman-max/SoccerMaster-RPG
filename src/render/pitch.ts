import type { GestureRead } from "../gesture/gesture";
import type { ActiveWindow } from "../match/runtime";
import { add, scale, sub, type Vec2 } from "../sim/geometry";
import { opponents, playerById, pressureAt } from "../sim/perception";
import { buildOutLineX, goalPosts, type Rules } from "../sim/rules";
import type { MatchState, PlayerState } from "../sim/types";
import { toScreen, type Camera } from "./camera";

/**
 * Canvas 2D presentation of the live state (spec §21): warm pitch, navy/cyan interface. During a
 * moment the overlay keeps the ball, the controlled player, pressure and space readable; it shows
 * *where* each option would go (ghost markers) but never which one scores best.
 */

export interface RenderOptions {
  controlledId: string | null;
  window: ActiveWindow | null;
  /** Anchors for the options currently on offer (live positions), keyed by option id. */
  optionAnchors: Map<string, Vec2>;
  /** 0..1 slow-motion intensity for vignette/desaturation. */
  slow: number;
  major: boolean;
}

const COLORS = {
  grassA: "#3f8f4a",
  grassB: "#3a8444",
  line: "rgba(255,255,255,0.85)",
  home: "#2fd3ff",
  homeDark: "#0d8fb3",
  away: "#ff7a59",
  awayDark: "#b7452b",
  ball: "#fff5d6",
  controlled: "#ffffff",
  pressure: "rgba(255, 90, 70, 0.55)",
  space: "rgba(125, 230, 255, 0.28)",
  anchor: "rgba(234, 246, 255, 0.85)",
  preview: "#7de6ff",
  cancel: "rgba(255, 122, 89, 0.9)",
};

export function render(ctx: CanvasRenderingContext2D, cam: Camera, state: MatchState, opts: RenderOptions): void {
  const { width, height } = cam;
  ctx.clearRect(0, 0, width, height);
  drawGrass(ctx, cam, state.rules);
  drawMarkings(ctx, cam, state.rules);

  const controlled = opts.controlledId ? playerById(state, opts.controlledId) : null;
  if (opts.window && controlled) drawMomentField(ctx, cam, state, controlled, opts);

  for (const p of state.players) drawPlayer(ctx, cam, p, p.id === opts.controlledId, opts.window?.moment.playerId === p.id);
  drawBall(ctx, cam, state);

  if (opts.window && controlled) drawMomentOverlay(ctx, cam, state, controlled, opts);
  if (opts.slow > 0) drawVignette(ctx, cam, opts.slow, opts.major);
}

function drawGrass(ctx: CanvasRenderingContext2D, cam: Camera, rules: Rules): void {
  const tl = toScreen(cam, { x: -6, y: -6 });
  const br = toScreen(cam, { x: rules.length + 6, y: rules.width + 6 });
  const g = ctx.createLinearGradient(0, tl.y, 0, br.y);
  g.addColorStop(0, "#47a054");
  g.addColorStop(1, "#347a3e");
  ctx.fillStyle = g;
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  const stripeW = rules.length / 14;
  for (let i = 0; i < 14; i++) {
    const a = toScreen(cam, { x: i * stripeW, y: 0 });
    const b = toScreen(cam, { x: (i + 1) * stripeW, y: rules.width });
    ctx.fillStyle = i % 2 === 0 ? COLORS.grassA : COLORS.grassB;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  // warm afternoon light from the top-left
  const light = ctx.createRadialGradient(tl.x, tl.y, 0, tl.x, tl.y, (br.x - tl.x) * 1.1);
  light.addColorStop(0, "rgba(255, 220, 150, 0.18)");
  light.addColorStop(1, "rgba(0, 20, 60, 0.18)");
  ctx.fillStyle = light;
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
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
    // goal frame
    const [p1, p2] = goalPosts(r, goalX);
    ctx.lineWidth = Math.max(2, 0.25 * cam.zoom);
    const depth = 1.6 * -dir;
    line(ctx, cam, p1, { x: p1.x + depth, y: p1.y });
    line(ctx, cam, p2, { x: p2.x + depth, y: p2.y });
    line(ctx, cam, { x: p1.x + depth, y: p1.y }, { x: p2.x + depth, y: p2.y });
    ctx.lineWidth = Math.max(1, 0.12 * cam.zoom);
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, cam: Camera, p: PlayerState, controlled: boolean, deciding: boolean): void {
  const s = toScreen(cam, p.pos);
  const r = Math.max(4, 0.55 * cam.zoom);
  const isHome = p.side === "home";
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(s.x + r * 0.25, s.y + r * 0.45, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // body
  const g = ctx.createRadialGradient(s.x - r * 0.3, s.y - r * 0.3, r * 0.2, s.x, s.y, r);
  g.addColorStop(0, isHome ? COLORS.home : COLORS.away);
  g.addColorStop(1, isHome ? COLORS.homeDark : COLORS.awayDark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  if (p.role === 1) {
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (controlled) {
    ctx.strokeStyle = COLORS.controlled;
    ctx.lineWidth = Math.max(2, 0.18 * cam.zoom);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 1.45, 0, Math.PI * 2);
    ctx.stroke();
    if (deciding) {
      ctx.strokeStyle = COLORS.preview;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 1.9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  if (cam.zoom > 9) {
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `${Math.max(9, r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(p.role), s.x, s.y);
  }
}

function drawBall(ctx: CanvasRenderingContext2D, cam: Camera, state: MatchState): void {
  const s = toScreen(cam, state.ball.pos);
  const r = Math.max(2.5, 0.28 * cam.zoom);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(s.x + r * 0.5, s.y + r * 0.9, r, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.ball;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(20,30,50,0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();
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
