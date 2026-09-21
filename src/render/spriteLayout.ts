/**
 * Player sprite-sheet layout shared by the generator (tools/spriteGen.ts) and the renderer. One
 * sheet per kit; columns are the five drawn facings (the other three are horizontal mirrors), rows
 * are pose × look variant. Frames are authored at 2× so a 30 px figure on a retina phone stays crisp.
 */

export const SPRITE_DIRECTIONS = ["S", "SE", "E", "NE", "N"] as const;
export type SpriteDirection = (typeof SPRITE_DIRECTIONS)[number];

/** Eight screen-space facings; the three western ones reuse the eastern frames mirrored. */
export type Facing = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
export const FACINGS: readonly Facing[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export const MIRRORED: Readonly<Record<Facing, { column: SpriteDirection; mirror: boolean }>> = {
  S: { column: "S", mirror: false },
  SE: { column: "SE", mirror: false },
  E: { column: "E", mirror: false },
  NE: { column: "NE", mirror: false },
  N: { column: "N", mirror: false },
  SW: { column: "SE", mirror: true },
  W: { column: "E", mirror: true },
  NW: { column: "NE", mirror: true },
};

export const SPRITE_POSES = ["stand", "run1", "run2", "ready", "carry"] as const;
export type SpritePose = (typeof SPRITE_POSES)[number];

/** Skin/hair looks; a player's variant is fixed for the match from their id. */
export const SPRITE_VARIANTS = 3;

export const SPRITE_KITS = ["blue", "coral", "keeperHome", "keeperAway"] as const;
export type SpriteKit = (typeof SPRITE_KITS)[number];

export interface SpriteLayout {
  frameWidth: number;
  frameHeight: number;
  /** Foot contact point inside a frame, px. */
  anchor: { x: number; y: number };
  /** Feet → top of head, px; the renderer scales frames so this matches the wanted figure height. */
  figureHeight: number;
  columns: number;
  rows: number;
  /** Sheet file per kit, relative to the assets root. */
  files: Readonly<Record<SpriteKit, string>>;
}

export const SPRITE_LAYOUT: SpriteLayout = {
  frameWidth: 64,
  frameHeight: 80,
  anchor: { x: 32, y: 74 },
  figureHeight: 68,
  columns: SPRITE_DIRECTIONS.length,
  rows: SPRITE_POSES.length * SPRITE_VARIANTS,
  files: {
    blue: "players/blue/outfield.png",
    coral: "players/coral/outfield.png",
    keeperHome: "players/goalkeepers/home.png",
    keeperAway: "players/goalkeepers/away.png",
  },
};

export const sheetWidth = (l: SpriteLayout): number => l.frameWidth * l.columns;
export const sheetHeight = (l: SpriteLayout): number => l.frameHeight * l.rows;

export function frameRow(pose: SpritePose, variant: number): number {
  return SPRITE_POSES.indexOf(pose) * SPRITE_VARIANTS + (((variant % SPRITE_VARIANTS) + SPRITE_VARIANTS) % SPRITE_VARIANTS);
}

export function frameColumn(dir: SpriteDirection): number {
  return SPRITE_DIRECTIONS.indexOf(dir);
}

/** Facing for a screen-space unit direction (x right, y down). */
export function facingOf(x: number, y: number): Facing {
  if (x === 0 && y === 0) return "S";
  const a = Math.atan2(y, x); // -π..π, 0 = east, +π/2 = south
  const oct = Math.round(a / (Math.PI / 4));
  switch (((oct % 8) + 8) % 8) {
    case 0:
      return "E";
    case 1:
      return "SE";
    case 2:
      return "S";
    case 3:
      return "SW";
    case 4:
      return "W";
    case 5:
      return "NW";
    case 6:
      return "N";
    default:
      return "NE";
  }
}
