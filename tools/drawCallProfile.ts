/**
 * Counts canvas context calls per render layer for one frame at a phone viewport, so the
 * per-frame budget in docs/PERFORMANCE.md can be attributed. Usage: npx tsx tools/drawCallProfile.ts
 */
import { createCamera, setInsets } from "../src/render/camera";
import { drawBackdrop, drawFurniture, drawGrass } from "../src/render/environment";
import { render } from "../src/render/pitch";
import { createPresentation, deriveVisuals } from "../src/render/presentation";
import { SPRITE_KITS, SPRITE_LAYOUT } from "../src/render/spriteLayout";
import type { SpriteSet } from "../src/render/sprites";
import { createMatch } from "../src/sim/engine";
import { generateSquad } from "../src/sim/squad";
import { U11_9V9 } from "../src/sim/rules";

const VIEW = { w: 390 * 2, h: 844 * 2, hud: 52 * 2, dock: 120 * 2 };

const PAINT = new Set(["fill", "stroke", "fillRect", "strokeRect", "clearRect", "drawImage", "fillText", "strokeText", "clip"]);
let paints = 0;
function countingContext(): { ctx: CanvasRenderingContext2D; calls: () => number; reset: () => void } {
  let n = 0;
  const stub = (): unknown =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get(t, key) {
        if (key in t) return t[key];
        return (..._args: unknown[]) => {
          n++;
          if (PAINT.has(key as string)) paints++;
          return typeof key === "string" && key.startsWith("create") ? stub() : undefined;
        };
      },
      set(t, key, value) {
        t[key] = value;
        return true;
      },
    });
  return { ctx: stub() as CanvasRenderingContext2D, calls: () => n, reset: () => ((n = 0), (paints = 0)) };
}

const sprites: SpriteSet = { layout: SPRITE_LAYOUT, sheets: Object.fromEntries(SPRITE_KITS.map((k) => [k, {} as CanvasImageSource])), failed: [] };
const home = generateSquad(1, "H", 55);
const away = generateSquad(2, "A", 55);
const state = createMatch({
  matchId: "profile",
  seed: 1,
  rules: U11_9V9,
  home: { side: "home", name: "Home", shortName: "HOM", squad: home },
  away: { side: "away", name: "Away", shortName: "AWY", squad: away },
  controlled: { side: "home", playerId: home[5]!.id },
});
const cam = createCamera(U11_9V9, VIEW.w, VIEW.h);
setInsets(cam, VIEW.hud, VIEW.dock);
const visuals = deriveVisuals(createPresentation(), state, cam, 50, 1, 0);
const { ctx, calls, reset } = countingContext();

const layer = (name: string, fn: () => void): void => {
  reset();
  fn();
  console.log(`${name.padEnd(16)} calls ${String(calls()).padStart(4)}  paints ${String(paints).padStart(4)}`);
};
layer("backdrop", () => drawBackdrop(ctx, cam, U11_9V9));
layer("grass", () => drawGrass(ctx, cam, U11_9V9));
layer("furniture", () => drawFurniture(ctx, cam, U11_9V9));
for (const [label, s] of [
  ["frame/sprites", sprites],
  ["frame/fallback", null],
] as const) {
  layer(label, () =>
    render(ctx, cam, state, {
      controlledId: home[5]!.id,
      window: null,
      optionAnchors: new Map(),
      slow: 0,
      major: false,
      visuals,
      sprites: s,
      ballHeightM: 0,
      timeS: 1,
    }),
  );
}
layer("frame/empty", () =>
  render(ctx, cam, state, { controlledId: null, window: null, optionAnchors: new Map(), slow: 0, major: false, visuals: [], sprites, ballHeightM: 0, timeS: 1 }),
);
layer("frame/1 spr", () =>
  render(ctx, cam, state, { controlledId: null, window: null, optionAnchors: new Map(), slow: 0, major: false, visuals: visuals.slice(0, 1), sprites, ballHeightM: 0, timeS: 1 }),
);
layer("frame/1 fb", () =>
  render(ctx, cam, state, { controlledId: null, window: null, optionAnchors: new Map(), slow: 0, major: false, visuals: visuals.slice(0, 1), sprites: null, ballHeightM: 0, timeS: 1 }),
);
console.log("zoom", cam.zoom.toFixed(2), "portrait", cam.portrait);
