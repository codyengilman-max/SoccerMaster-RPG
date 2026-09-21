import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SPRITE_DIRECTIONS,
  SPRITE_KITS,
  SPRITE_LAYOUT,
  SPRITE_POSES,
  SPRITE_VARIANTS,
  sheetHeight,
  sheetWidth,
} from "../src/render/spriteLayout";
import { KIT_PALETTES, LOOKS, figureShapes } from "./sprites/figure";
import { Raster, composeSheet, encodePng } from "./sprites/raster";

/**
 * Generates the player sprite sheets under public/assets (deterministic, original procedural art).
 *   npm run sprites
 * Re-run after editing tools/sprites/figure.ts; commit the PNGs so the build has no runtime cost.
 */

const root = join(process.cwd(), "public", "assets");
const layout = SPRITE_LAYOUT;

for (const kit of SPRITE_KITS) {
  const frames: Uint8Array[] = [];
  for (const pose of SPRITE_POSES) {
    for (let v = 0; v < SPRITE_VARIANTS; v++) {
      const look = LOOKS[v]!;
      for (const dir of SPRITE_DIRECTIONS) {
        const r = new Raster(layout.frameWidth, layout.frameHeight, 4);
        r.paint(figureShapes(kit, look, dir, pose));
        frames.push(r.toRgba8());
      }
    }
  }
  const sheet = composeSheet(frames, layout.frameWidth, layout.frameHeight, layout.columns);
  if (sheet.width !== sheetWidth(layout) || sheet.height !== sheetHeight(layout)) {
    throw new Error(`sheet size mismatch for ${kit}: ${sheet.width}x${sheet.height}`);
  }
  const file = join(root, layout.files[kit]);
  mkdirSync(dirname(file), { recursive: true });
  const png = encodePng(sheet.width, sheet.height, sheet.data);
  writeFileSync(file, png);
  console.log(`${layout.files[kit]}  ${sheet.width}x${sheet.height}  ${(png.length / 1024).toFixed(1)} kB`);
}

const atlas = {
  generator: "tools/spriteGen.ts (procedural, original)",
  frameWidth: layout.frameWidth,
  frameHeight: layout.frameHeight,
  anchor: layout.anchor,
  figureHeight: layout.figureHeight,
  columns: [...SPRITE_DIRECTIONS],
  mirrored: { SW: "SE", W: "E", NW: "NE" },
  rows: SPRITE_POSES.flatMap((pose) => Array.from({ length: SPRITE_VARIANTS }, (_, v) => `${pose}/look${v}`)),
  sheets: layout.files,
  kits: KIT_PALETTES,
  looks: LOOKS,
};
writeFileSync(join(root, "players", "atlas.json"), `${JSON.stringify(atlas, null, 2)}\n`);
console.log("players/atlas.json written");
