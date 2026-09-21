/**
 * Procedural portrait previews for the appearance presets on the creation screen.
 *
 * Preset indices are the saved `appearance` ids (OPEN_QUESTIONS #4); the order here must never
 * change. Everything is drawn from shapes at call time — no image assets, deterministic output.
 */

export type HairStyle = "short" | "curly" | "tiedBack" | "buzz" | "braids" | "shortGlasses";

export interface AvatarLook {
  skin: string;
  hair: string;
  style: HairStyle;
}

/** One look per appearance preset, index-aligned with `APPEARANCE_PRESETS`. */
export const AVATAR_LOOKS: readonly AvatarLook[] = [
  { skin: "#f3c9a3", hair: "#2b1c12", style: "short" },
  { skin: "#d98a5c", hair: "#1a120c", style: "curly" },
  { skin: "#c9a27a", hair: "#3b2a1e", style: "tiedBack" },
  { skin: "#8b5a3c", hair: "#0f0a08", style: "buzz" },
  { skin: "#5a3a2a", hair: "#0f0a08", style: "braids" },
  { skin: "#e8b48f", hair: "#5a3a22", style: "shortGlasses" },
];

const KIT = { shirt: "#1b3a6b", trim: "#2fd3ff", bg0: "#0b1a33", bg1: "#06101f" };

const shade = (hex: string, k: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${c(16)}, ${c(8)}, ${c(0)})`;
};

/** Draws the preset portrait into a `size`×`size` square at (0,0). */
export function drawAvatar(ctx: CanvasRenderingContext2D, preset: number, size: number): void {
  const look = AVATAR_LOOKS[((preset % AVATAR_LOOKS.length) + AVATAR_LOOKS.length) % AVATAR_LOOKS.length]!;
  const u = size / 64;
  ctx.save();
  ctx.scale(u, u);

  // navy vignette behind the head
  const bg = ctx.createRadialGradient(32, 26, 4, 32, 32, 40);
  bg.addColorStop(0, KIT.bg0);
  bg.addColorStop(1, KIT.bg1);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 64, 64);

  // shoulders and collar (shirt), clipped to the square
  ctx.fillStyle = KIT.shirt;
  ctx.beginPath();
  ctx.moveTo(6, 64);
  ctx.quadraticCurveTo(8, 46, 22, 44);
  ctx.lineTo(42, 44);
  ctx.quadraticCurveTo(56, 46, 58, 64);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = KIT.trim;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(24, 45);
  ctx.quadraticCurveTo(32, 52, 40, 45);
  ctx.stroke();

  // neck
  ctx.fillStyle = shade(look.skin, 0.85);
  ctx.fillRect(28, 36, 8, 10);

  // back hair for long styles is behind the head
  const hx = 32;
  const hy = 27;
  const r = 12.5;
  ctx.fillStyle = look.hair;
  if (look.style === "tiedBack") {
    ctx.beginPath();
    ctx.ellipse(hx, hy + 6, r * 0.75, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(hx + 12, hy + 4, 3.6, 6, -0.25, 0, Math.PI * 2);
    ctx.fill();
  } else if (look.style === "braids") {
    for (const dx of [-9, -4, 4, 9]) {
      ctx.beginPath();
      ctx.moveTo(hx + dx, hy);
      ctx.lineTo(hx + dx * 1.15, hy + 20);
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = look.hair;
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }

  // head
  ctx.fillStyle = look.skin;
  ctx.beginPath();
  ctx.ellipse(hx, hy, r, r * 1.08, 0, 0, Math.PI * 2);
  ctx.fill();
  // ears
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(hx + s * r, hy + 1, 2.2, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // soft cheek light
  const light = ctx.createRadialGradient(hx - 4, hy - 5, 1, hx, hy, r);
  light.addColorStop(0, "rgba(255,255,255,0.16)");
  light.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.ellipse(hx, hy, r, r * 1.08, 0, 0, Math.PI * 2);
  ctx.fill();

  // hair on top of the head
  ctx.fillStyle = look.hair;
  switch (look.style) {
    case "short":
    case "shortGlasses":
      ctx.beginPath();
      ctx.ellipse(hx, hy - 3, r + 0.6, r * 0.8, 0, Math.PI, Math.PI * 2);
      ctx.lineTo(hx + r + 0.6, hy - 1);
      ctx.lineTo(hx - r - 0.6, hy - 1);
      ctx.closePath();
      ctx.fill();
      break;
    case "curly":
      for (let i = 0; i < 9; i++) {
        const a = Math.PI + (i / 8) * Math.PI;
        ctx.beginPath();
        ctx.arc(hx + Math.cos(a) * (r - 1), hy - 2 + Math.sin(a) * (r - 1), 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(hx, hy - 4, r, r * 0.75, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      break;
    case "tiedBack":
      ctx.beginPath();
      ctx.ellipse(hx, hy - 2.5, r + 0.6, r * 0.85, 0, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = shade(look.hair, 1.6);
      ctx.lineWidth = 0.8;
      for (const dx of [-6, 0, 6]) {
        ctx.beginPath();
        ctx.moveTo(hx + dx, hy - 10);
        ctx.quadraticCurveTo(hx + dx * 1.3, hy - 6, hx + dx * 1.5, hy - 3);
        ctx.stroke();
      }
      break;
    case "buzz":
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.ellipse(hx, hy - 3, r + 0.2, r * 0.72, 0, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      break;
    case "braids":
      ctx.beginPath();
      ctx.ellipse(hx, hy - 3, r + 0.6, r * 0.8, 0, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = shade(look.hair, 2.2);
      ctx.lineWidth = 0.7;
      for (const dx of [-7, -2.5, 2.5, 7]) {
        ctx.beginPath();
        ctx.moveTo(hx + dx, hy - 11);
        ctx.lineTo(hx + dx * 1.2, hy - 4);
        ctx.stroke();
      }
      break;
  }

  // eyes and brows
  ctx.fillStyle = "#1a1210";
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(hx + s * 4.6, hy + 1, 1.5, 1.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(hx + s * 4.6 - 0.5, hy + 0.3, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1210";
  }
  ctx.strokeStyle = shade(look.hair, 1.2);
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(hx + s * 2.6, hy - 3);
    ctx.lineTo(hx + s * 6.6, hy - 3.6);
    ctx.stroke();
  }
  // smile
  ctx.strokeStyle = shade(look.skin, 0.55);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(hx, hy + 5, 3.4, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();

  if (look.style === "shortGlasses") {
    ctx.strokeStyle = "#0b1a33";
    ctx.lineWidth = 1.2;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(hx + s * 4.8, hy + 1, 3.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(hx - 1.2, hy + 1);
    ctx.lineTo(hx + 1.2, hy + 1);
    ctx.stroke();
  }

  ctx.restore();
}
