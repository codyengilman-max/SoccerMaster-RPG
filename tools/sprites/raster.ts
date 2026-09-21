import { deflateSync } from "node:zlib";

/**
 * Tiny dependency-free vector rasterizer used to author the player sprite sheets. Shapes are
 * implicit functions painted in order with alpha compositing at a supersampled resolution, then
 * box-filtered down, so edges come out anti-aliased. Output is an RGBA PNG.
 */

export type Rgba = readonly [number, number, number, number];

export interface Shape {
  /** Bounding box in output pixels. */
  box: readonly [number, number, number, number];
  inside(x: number, y: number): boolean;
  color: Rgba;
  /** Optional extra predicate (e.g. restrict a shade to the torso). */
  clip?: (x: number, y: number) => boolean;
}

export function rgba(hex: string, alpha = 1): Rgba {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

export function circle(cx: number, cy: number, r: number, color: Rgba): Shape {
  return { box: [cx - r, cy - r, cx + r, cy + r], inside: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r, color };
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, color: Rgba): Shape {
  return {
    box: [cx - rx, cy - ry, cx + rx, cy + ry],
    inside: (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1,
    color,
  };
}

/** Thick line with round caps. */
export function capsule(x1: number, y1: number, x2: number, y2: number, r: number, color: Rgba): Shape {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy || 1;
  return {
    box: [Math.min(x1, x2) - r, Math.min(y1, y2) - r, Math.max(x1, x2) + r, Math.max(y1, y2) + r],
    inside: (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2));
      const px = x1 + dx * t;
      const py = y1 + dy * t;
      return (x - px) ** 2 + (y - py) ** 2 <= r * r;
    },
    color,
  };
}

export function roundRect(x: number, y: number, w: number, h: number, r: number, color: Rgba): Shape {
  const rr = Math.min(r, w / 2, h / 2);
  return {
    box: [x, y, x + w, y + h],
    inside: (px, py) => {
      if (px < x || px > x + w || py < y || py > y + h) return false;
      const qx = Math.max(Math.abs(px - (x + w / 2)) - (w / 2 - rr), 0);
      const qy = Math.max(Math.abs(py - (y + h / 2)) - (h / 2 - rr), 0);
      return qx * qx + qy * qy <= rr * rr;
    },
    color,
  };
}

export function clipped(s: Shape, clip: (x: number, y: number) => boolean): Shape {
  return { ...s, clip };
}

export function recolor(s: Shape, color: Rgba): Shape {
  return { ...s, color };
}

/** Grow a shape by `e` px (for outlines): re-tests membership on a small ring of sample offsets. */
export function expand(s: Shape, e: number): Shape {
  const offs: Array<[number, number]> = [];
  for (let i = 0; i < 12; i++) offs.push([Math.cos((i / 12) * Math.PI * 2) * e, Math.sin((i / 12) * Math.PI * 2) * e]);
  offs.push([0, 0]);
  const [a, b, c, d] = s.box;
  return {
    box: [a - e, b - e, c + e, d + e],
    inside: (x, y) => offs.some(([ox, oy]) => s.inside(x + ox, y + oy)),
    color: s.color,
    ...(s.clip ? { clip: s.clip } : {}),
  };
}

export class Raster {
  readonly data: Float32Array;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly ss = 4,
  ) {
    this.data = new Float32Array(width * ss * height * ss * 4);
  }

  paint(shapes: readonly Shape[]): void {
    const { ss } = this;
    const W = this.width * ss;
    const H = this.height * ss;
    for (const s of shapes) {
      const [x0, y0, x1, y1] = s.box;
      const sx0 = Math.max(0, Math.floor(x0 * ss));
      const sy0 = Math.max(0, Math.floor(y0 * ss));
      const sx1 = Math.min(W - 1, Math.ceil(x1 * ss));
      const sy1 = Math.min(H - 1, Math.ceil(y1 * ss));
      const [r, g, b, a] = s.color;
      for (let sy = sy0; sy <= sy1; sy++) {
        const y = (sy + 0.5) / ss;
        for (let sx = sx0; sx <= sx1; sx++) {
          const x = (sx + 0.5) / ss;
          if (!s.inside(x, y)) continue;
          if (s.clip && !s.clip(x, y)) continue;
          const i = (sy * W + sx) * 4;
          const da = this.data[i + 3]!;
          const oa = a + da * (1 - a);
          if (oa <= 0) continue;
          this.data[i] = (r * a + this.data[i]! * da * (1 - a)) / oa;
          this.data[i + 1] = (g * a + this.data[i + 1]! * da * (1 - a)) / oa;
          this.data[i + 2] = (b * a + this.data[i + 2]! * da * (1 - a)) / oa;
          this.data[i + 3] = oa;
        }
      }
    }
  }

  /** Box-filter down to output pixels; premultiplied average then un-premultiplied. */
  toRgba8(): Uint8Array {
    const { ss, width, height } = this;
    const W = width * ss;
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let j = 0; j < ss; j++) {
          for (let i = 0; i < ss; i++) {
            const k = ((y * ss + j) * W + x * ss + i) * 4;
            const pa = this.data[k + 3]!;
            r += this.data[k]! * pa;
            g += this.data[k + 1]! * pa;
            b += this.data[k + 2]! * pa;
            a += pa;
          }
        }
        const o = (y * width + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
          out[o + 3] = Math.round((a / (ss * ss)) * 255);
        }
      }
    }
    return out;
  }
}

/** Compose frames (each `fw`×`fh` RGBA8) into a sheet with `columns` per row. */
export function composeSheet(frames: readonly Uint8Array[], fw: number, fh: number, columns: number): { width: number; height: number; data: Uint8Array } {
  const rows = Math.ceil(frames.length / columns);
  const width = fw * columns;
  const height = fh * rows;
  const data = new Uint8Array(width * height * 4);
  frames.forEach((f, idx) => {
    const cx = (idx % columns) * fw;
    const cy = Math.floor(idx / columns) * fh;
    for (let y = 0; y < fh; y++) {
      data.set(f.subarray(y * fw * 4, (y + 1) * fw * 4), ((cy + y) * width + cx) * 4);
    }
  });
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(body, 8);
  const crcInput = new Uint8Array(4 + body.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(body, 4);
  dv.setUint32(8 + body.length, crc32(crcInput));
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
