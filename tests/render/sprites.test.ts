import { describe, expect, it } from "vitest";
import { drawSprite, loadSprites, type ImageLoader, type SpriteSet } from "../../src/render/sprites";
import {
  FACINGS,
  MIRRORED,
  SPRITE_KITS,
  SPRITE_LAYOUT,
  SPRITE_POSES,
  SPRITE_VARIANTS,
  facingOf,
  frameColumn,
  frameRow,
  sheetHeight,
  sheetWidth,
} from "../../src/render/spriteLayout";

const fakeImage = (url: string): CanvasImageSource => ({ url }) as unknown as CanvasImageSource;

/** Records drawImage calls plus the transform in force at each one. */
function recordingCtx() {
  const calls: { args: number[]; mirrored: boolean }[] = [];
  let mirrored = false;
  const ctx = {
    save() {},
    restore() {
      mirrored = false;
    },
    translate() {},
    scale(x: number) {
      if (x < 0) mirrored = true;
    },
    drawImage(_img: CanvasImageSource, ...args: number[]) {
      calls.push({ args, mirrored });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("sprite layout", () => {
  it("covers every facing with five authored columns and three mirrored ones", () => {
    expect(FACINGS).toHaveLength(8);
    const authored = FACINGS.filter((f) => !MIRRORED[f].mirror);
    const mirrored = FACINGS.filter((f) => MIRRORED[f].mirror);
    expect(authored).toEqual(["N", "NE", "E", "SE", "S"]);
    expect(mirrored).toEqual(["SW", "W", "NW"]);
    expect(MIRRORED.W.column).toBe("E");
    expect(MIRRORED.SW.column).toBe("SE");
    expect(MIRRORED.NW.column).toBe("NE");
  });

  it("addresses frames row-major by pose then look, and the sheet size matches", () => {
    expect(sheetWidth(SPRITE_LAYOUT)).toBe(64 * 5);
    expect(sheetHeight(SPRITE_LAYOUT)).toBe(80 * SPRITE_POSES.length * SPRITE_VARIANTS);
    expect(frameRow("stand", 0)).toBe(0);
    expect(frameRow("run2", 1)).toBe(2 * SPRITE_VARIANTS + 1);
    expect(frameRow("carry", 2)).toBe(4 * SPRITE_VARIANTS + 2);
    expect(frameRow("stand", 5)).toBe(5 % SPRITE_VARIANTS);
    expect(frameColumn("S")).toBe(0);
    expect(frameColumn("N")).toBe(4);
  });

  it("maps screen directions to the nearest of eight facings", () => {
    expect(facingOf(1, 0)).toBe("E");
    expect(facingOf(-1, 0)).toBe("W");
    expect(facingOf(0, -1)).toBe("N");
    expect(facingOf(0, 1)).toBe("S");
    expect(facingOf(1, 1)).toBe("SE");
    expect(facingOf(-1, -1)).toBe("NW");
    expect(facingOf(0, 0)).toBe("S");
  });
});

describe("loadSprites", () => {
  it("loads every kit from its own file", async () => {
    const urls: string[] = [];
    const loader: ImageLoader = async (url) => {
      urls.push(url);
      return fakeImage(url);
    };
    const set = await loadSprites("x/", loader, 100);
    expect(set.failed).toEqual([]);
    expect(Object.keys(set.sheets).sort()).toEqual([...SPRITE_KITS].sort());
    expect(urls.sort()).toEqual(SPRITE_KITS.map((k) => "x/" + SPRITE_LAYOUT.files[k]).sort());
  });

  it("never rejects: a failing sheet is reported and the others still load", async () => {
    const loader: ImageLoader = async (url) => {
      if (url.includes("coral")) throw new Error("404");
      return fakeImage(url);
    };
    const set = await loadSprites("", loader, 100);
    expect(set.failed).toEqual(["coral"]);
    expect(set.sheets.coral).toBeUndefined();
    expect(set.sheets.blue).toBeDefined();
    expect(set.sheets.keeperHome).toBeDefined();
    expect(set.sheets.keeperAway).toBeDefined();
  });

  it("gives up on a sheet that never arrives after the timeout", async () => {
    const hang: ImageLoader = () => new Promise(() => {});
    const started = Date.now();
    const set = await loadSprites("", hang, 20);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(set.failed.sort()).toEqual([...SPRITE_KITS].sort());
    expect(Object.keys(set.sheets)).toEqual([]);
  });

  it("falls back per kit: drawSprite declines for a missing sheet and paints the rest", async () => {
    const loader: ImageLoader = async (url) => {
      if (url.includes("away")) throw new Error("nope");
      return fakeImage(url);
    };
    const set = await loadSprites("", loader, 100);
    const { ctx, calls } = recordingCtx();
    expect(drawSprite(ctx, set, { kit: "keeperAway", pose: "stand", facing: "S", variant: 0 }, 10, 10, 34)).toBe(false);
    expect(drawSprite(ctx, null, { kit: "blue", pose: "stand", facing: "S", variant: 0 }, 10, 10, 34)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(drawSprite(ctx, set, { kit: "blue", pose: "stand", facing: "S", variant: 0 }, 10, 10, 34)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("drawSprite", () => {
  const set: SpriteSet = {
    layout: SPRITE_LAYOUT,
    sheets: Object.fromEntries(SPRITE_KITS.map((k) => [k, fakeImage(k)])),
    failed: [],
  };

  it("blits the authored frame with the foot anchor at the requested point", () => {
    const { ctx, calls } = recordingCtx();
    const h = 34; // half the authored figure height
    drawSprite(ctx, set, { kit: "coral", pose: "run2", facing: "E", variant: 1 }, 100, 200, h);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = calls[0]!.args;
    expect(calls[0]!.mirrored).toBe(false);
    expect([sx, sy, sw, sh]).toEqual([2 * 64, frameRow("run2", 1) * 80, 64, 80]);
    const scale = h / SPRITE_LAYOUT.figureHeight;
    expect(dw).toBeCloseTo(64 * scale);
    expect(dh).toBeCloseTo(80 * scale);
    expect(dx).toBeCloseTo(100 - SPRITE_LAYOUT.anchor.x * scale);
    expect(dy).toBeCloseTo(200 - SPRITE_LAYOUT.anchor.y * scale);
  });

  it("mirrors the western facings from the eastern columns around the anchor", () => {
    for (const [facing, column] of [
      ["W", "E"],
      ["SW", "SE"],
      ["NW", "NE"],
    ] as const) {
      const { ctx, calls } = recordingCtx();
      drawSprite(ctx, set, { kit: "blue", pose: "stand", facing, variant: 0 }, 100, 200, 68);
      const [sx, , , , dx, dy, dw] = calls[0]!.args;
      expect(calls[0]!.mirrored).toBe(true);
      expect(sx).toBe(frameColumn(column) * 64);
      // after translate(x) + scale(-1, 1) the frame is drawn at -(dw - (x - dx)) so that it lands on
      // the same on-screen box as the unmirrored frame would
      const unmirroredDx = 100 - SPRITE_LAYOUT.anchor.x;
      expect(dx).toBeCloseTo(-(dw! - (100 - unmirroredDx)));
      expect(dy).toBeCloseTo(200 - SPRITE_LAYOUT.anchor.y);
    }
  });

  it("draws a frame for every kit × pose × facing × look without touching outside the sheet", () => {
    const { ctx, calls } = recordingCtx();
    for (const kit of SPRITE_KITS) {
      for (const pose of SPRITE_POSES) {
        for (const facing of FACINGS) {
          for (let v = 0; v < SPRITE_VARIANTS; v++) {
            expect(drawSprite(ctx, set, { kit, pose, facing, variant: v }, 0, 0, 20)).toBe(true);
          }
        }
      }
    }
    expect(calls).toHaveLength(SPRITE_KITS.length * SPRITE_POSES.length * FACINGS.length * SPRITE_VARIANTS);
    for (const c of calls) {
      const [sx, sy, sw, sh] = c.args;
      expect(sx! + sw!).toBeLessThanOrEqual(sheetWidth(SPRITE_LAYOUT));
      expect(sy! + sh!).toBeLessThanOrEqual(sheetHeight(SPRITE_LAYOUT));
    }
  });
});
