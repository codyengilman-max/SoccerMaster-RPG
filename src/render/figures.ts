/**
 * Screen-space painters shared by the match pitch and the training screens so people, balls and
 * turf look the same everywhere. Everything is procedural (gradients and a few fills); no assets.
 */

export type Kit = "home" | "away" | "keeper" | "neutral";

export interface KitColors {
  shirt: string;
  shirtDark: string;
  shorts: string;
  hair: string;
}

export const KITS: Record<Kit, KitColors> = {
  home: { shirt: "#35d6ff", shirtDark: "#0b7fa6", shorts: "#0a2a4a", hair: "#2a1d14" },
  away: { shirt: "#ff8a5c", shirtDark: "#b8452a", shorts: "#3b1a12", hair: "#4a3020" },
  keeper: { shirt: "#ffd34d", shirtDark: "#b8891a", shorts: "#3b2a12", hair: "#2a1d14" },
  neutral: { shirt: "#eaf6ff", shirtDark: "#8fa8c4", shorts: "#22304a", hair: "#3a2a1c" },
};

export const SKIN = "#f2c9a0";
export const BALL = "#fff7e0";

/** Light comes from the top-left; shadows fall down-right. */
export const LIGHT = { x: 0.35, y: 0.55 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Striped grass with a drop shadow, worn centre and warm top-left light. `stripes` run across the
 * short side of the rectangle (as a mower would cut them).
 */
export function paintTurf(ctx: CanvasRenderingContext2D, r: Rect, stripes = 10): void {
  ctx.fillStyle = "rgba(0, 12, 30, 0.35)";
  ctx.fillRect(r.x + 4, r.y + 6, r.w, r.h);
  ctx.fillStyle = "#3e9a4c";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const stripeW = r.w / stripes;
  ctx.fillStyle = "#378c44";
  ctx.beginPath();
  for (let i = 1; i < stripes; i += 2) ctx.rect(r.x + i * stripeW, r.y, stripeW + 0.5, r.h);
  ctx.fill();
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rad = Math.min(r.w, r.h) * 0.22;
  const wear = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
  wear.addColorStop(0, "rgba(120, 110, 60, 0.16)");
  wear.addColorStop(1, "rgba(120, 110, 60, 0)");
  ctx.fillStyle = wear;
  ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  const light = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, Math.max(r.w, r.h) * 1.15);
  light.addColorStop(0, "rgba(255, 224, 160, 0.22)");
  light.addColorStop(0.55, "rgba(255, 224, 160, 0.04)");
  light.addColorStop(1, "rgba(0, 24, 70, 0.26)");
  ctx.fillStyle = light;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

/** Darker turf beyond the playing area, falling away into the evening. */
export function paintSurround(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, "#1b4a2a");
  g.addColorStop(0.5, "#2c6b37");
  g.addColorStop(1, "#1b4a2a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

export function paintShadow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = "rgba(0, 10, 25, 0.32)";
  ctx.beginPath();
  ctx.ellipse(x + r * LIGHT.x, y + r * LIGHT.y, r * 1.15, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
}

export interface FigureOptions {
  kit: Kit;
  /** Unit direction of travel, scaled by speed in [0, 1]; the figure leans into it. */
  lean?: { x: number; y: number } | null;
  /** 0..1; tired figures lose their shirt highlight. */
  fatigue?: number;
  /** Short text on the shirt (role number, initials). */
  label?: string | null;
  /** Draw the cyan halo + white ground ring used for the player's own character. */
  controlled?: boolean;
  /** Dashed outer ring while a decision is open. */
  deciding?: boolean;
  /** Thin white outline (used for goalkeepers on the match pitch). */
  outline?: boolean;
}

/**
 * A small figure seen from a high, slightly raked camera: shorts, shirt with a highlight, head with a
 * hair cap. Cheap (a handful of fills) and readable at phone size. `r` is the body radius in px.
 */
export function paintFigure(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, o: FigureOptions): void {
  const kit = KITS[o.kit];
  const lean = o.lean ? { x: o.lean.x * r * 0.12, y: o.lean.y * r * 0.12 } : { x: 0, y: 0 };

  if (o.controlled) {
    const halo = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2.4);
    halo.addColorStop(0, "rgba(125, 230, 255, 0.35)");
    halo.addColorStop(1, "rgba(125, 230, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = kit.shorts;
  ctx.beginPath();
  ctx.ellipse(x + lean.x, y + r * 0.15 + lean.y, r * 0.78, r * 0.62, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.55, r * 0.15, x, y - r * 0.2, r * 1.1);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.18, kit.shirt);
  g.addColorStop(1, kit.shirtDark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x + lean.x, y - r * 0.28 + lean.y, r * 0.92, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  if (o.outline) {
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.stroke();
  }
  const hx = x + lean.x * 1.6;
  const hy = y - r * 0.95 + lean.y * 1.6;
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(hx, hy, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = kit.hair;
  ctx.beginPath();
  ctx.arc(hx - r * 0.04, hy - r * 0.1, r * 0.4, Math.PI * 1.05, Math.PI * 1.95);
  ctx.fill();
  const tired = o.fatigue ?? 0;
  if (tired > 0.5) {
    ctx.fillStyle = `rgba(20, 30, 50, ${(tired - 0.5) * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(x + lean.x, y - r * 0.28 + lean.y, r * 0.92, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (o.controlled) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.35, r * 1.5, r * 0.75, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (o.deciding) {
      ctx.strokeStyle = "#7de6ff";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.35, r * 2.0, r * 1.0, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  if (o.label) {
    ctx.fillStyle = o.kit === "neutral" || o.kit === "keeper" ? "rgba(6,16,31,0.9)" : "rgba(255,255,255,0.95)";
    ctx.font = `700 ${Math.max(9, r * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(o.label, x + lean.x, y - r * 0.25 + lean.y);
    ctx.textBaseline = "alphabetic";
  }
}

/** Shaded ball with its own shadow; `lift` (px) raises it off the ground for a struck ball. */
export function paintBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, lift = 0): void {
  // the shadow shrinks and fades as the ball climbs, never below a small disc
  const high = Math.min(1, lift / (r * 6));
  ctx.fillStyle = `rgba(0, 10, 25, ${0.35 * (1 - high * 0.6)})`;
  ctx.beginPath();
  ctx.ellipse(x + r * 0.5 + lift * 0.12, y + r * 0.9, r * (1 - high * 0.55), r * 0.5 * (1 - high * 0.4), 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.35, y - lift - r * 0.35, r * 0.1, x, y - lift, r * 1.05);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.6, BALL);
  g.addColorStop(1, "#c9b98f");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y - lift, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(20,30,50,0.65)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(20,30,50,0.45)";
  ctx.beginPath();
  ctx.arc(x + r * 0.15, y - lift + r * 0.1, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Side-view backdrop for the yard and park minigames: evening sky, a low sun glow, a treeline band
 * and grass down to the bottom edge. `groundY` is the horizon in px.
 */
export function paintSideView(ctx: CanvasRenderingContext2D, width: number, height: number, groundY: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, "#0f2a52");
  sky.addColorStop(0.6, "#1f4f8a");
  sky.addColorStop(1, "#d98a4a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, groundY);
  const sun = ctx.createRadialGradient(width * 0.72, groundY * 0.92, 0, width * 0.72, groundY * 0.92, width * 0.55);
  sun.addColorStop(0, "rgba(255, 210, 140, 0.55)");
  sun.addColorStop(1, "rgba(255, 210, 140, 0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, groundY);
  // treeline: soft dark bumps against the sunset
  ctx.fillStyle = "#12331f";
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  const bumps = Math.max(6, Math.round(width / 70));
  for (let i = 0; i <= bumps; i++) {
    const x = (width * i) / bumps;
    const hgt = groundY * (0.08 + 0.06 * Math.abs(Math.sin(i * 2.3)));
    ctx.quadraticCurveTo(x - width / bumps / 2, groundY - hgt * 1.3, x, groundY - hgt);
  }
  ctx.lineTo(width, groundY);
  ctx.closePath();
  ctx.fill();
  const grass = ctx.createLinearGradient(0, groundY, 0, height);
  grass.addColorStop(0, "#3e9a4c");
  grass.addColorStop(1, "#245c30");
  ctx.fillStyle = grass;
  ctx.fillRect(0, groundY, width, height - groundY);
  ctx.fillStyle = "rgba(255, 224, 160, 0.10)";
  ctx.fillRect(0, groundY, width, 3);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Side-view standing figure for the yard minigames: legs, shorts, shirt with a highlight, head with
 * hair, all scaled from `height` px. `kick` (0..1) swings the near leg forward.
 */
export function paintStandingFigure(ctx: CanvasRenderingContext2D, x: number, footY: number, height: number, kit: Kit, kick = 0): void {
  const k = KITS[kit];
  const u = height / 10;
  // ground shadow
  ctx.fillStyle = "rgba(0, 10, 25, 0.3)";
  ctx.beginPath();
  ctx.ellipse(x + u * 0.6, footY + u * 0.15, u * 2.2, u * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  // legs
  ctx.strokeStyle = SKIN;
  ctx.lineWidth = u * 0.75;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - u * 0.5, footY - u * 4.2);
  ctx.lineTo(x - u * 0.9, footY - u * 0.3);
  ctx.moveTo(x + u * 0.5, footY - u * 4.2);
  ctx.lineTo(x + u * 0.7 + kick * u * 2.2, footY - u * 0.3 - kick * u * 1.6);
  ctx.stroke();
  // boots
  ctx.fillStyle = "#1a2236";
  ctx.beginPath();
  ctx.ellipse(x - u * 0.9, footY - u * 0.2, u * 0.7, u * 0.35, 0, 0, Math.PI * 2);
  ctx.ellipse(x + u * 0.9 + kick * u * 2.2, footY - u * 0.2 - kick * u * 1.6, u * 0.7, u * 0.35, -kick * 0.8, 0, Math.PI * 2);
  ctx.fill();
  // shorts
  ctx.fillStyle = k.shorts;
  roundedRect(ctx, x - u * 1.3, footY - u * 5.2, u * 2.6, u * 1.6, u * 0.4);
  ctx.fill();
  // shirt
  const g = ctx.createLinearGradient(x - u * 1.5, 0, x + u * 1.5, 0);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.25, k.shirt);
  g.addColorStop(1, k.shirtDark);
  ctx.fillStyle = g;
  roundedRect(ctx, x - u * 1.5, footY - u * 8.2, u * 3, u * 3.4, u * 0.7);
  ctx.fill();
  // arms
  ctx.strokeStyle = SKIN;
  ctx.lineWidth = u * 0.6;
  ctx.beginPath();
  ctx.moveTo(x - u * 1.4, footY - u * 7.6);
  ctx.lineTo(x - u * 2.3, footY - u * 5.4);
  ctx.moveTo(x + u * 1.4, footY - u * 7.6);
  ctx.lineTo(x + u * 2.4, footY - u * 5.6);
  ctx.stroke();
  // head + hair
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(x, footY - u * 9.1, u * 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = k.hair;
  ctx.beginPath();
  ctx.arc(x, footY - u * 9.3, u * 0.9, Math.PI * 1.0, Math.PI * 2.0);
  ctx.fill();
}

/** Darkened edges during slow motion so the eye goes to the middle of the picture. */
export function paintVignette(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
  if (strength <= 0.02) return;
  const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.75);
  g.addColorStop(0, "rgba(6,16,31,0)");
  g.addColorStop(1, `rgba(6,16,31,${0.55 * strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}
