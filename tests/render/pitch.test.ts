import { describe, expect, it } from "vitest";
import { createCamera, setInsets } from "../../src/render/camera";
import { PULSE_LIFE_S, render, type GroundPulse, type RenderOptions } from "../../src/render/pitch";
import { createPresentation, deriveVisuals } from "../../src/render/presentation";
import { SPRITE_KITS, SPRITE_LAYOUT } from "../../src/render/spriteLayout";
import type { SpriteSet } from "../../src/render/sprites";
import { createMatch } from "../../src/sim/engine";
import { U11_9V9 } from "../../src/sim/rules";
import { generateSquad } from "../../src/sim/squad";

const PAINT = new Set(["fill", "stroke", "fillRect", "strokeRect", "drawImage", "fillText", "strokeText", "clip"]);

/** Counts every 2D method call by name; factories return another counter so gradients work. */
function countingContext(): { ctx: CanvasRenderingContext2D; count: (name: string) => number; paints: () => number; total: () => number } {
  const calls = new Map<string, number>();
  const stub = (): unknown =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get(t, key) {
        if (key in t) return t[key];
        return () => {
          if (typeof key === "string") calls.set(key, (calls.get(key) ?? 0) + 1);
          return typeof key === "string" && key.startsWith("create") ? stub() : undefined;
        };
      },
      set(t, key, value) {
        t[key] = value;
        return true;
      },
    });
  return {
    ctx: stub() as CanvasRenderingContext2D,
    count: (name) => calls.get(name) ?? 0,
    paints: () => [...calls].reduce((n, [k, v]) => (PAINT.has(k) ? n + v : n), 0),
    total: () => [...calls.values()].reduce((a, b) => a + b, 0),
  };
}

const sprites: SpriteSet = {
  layout: SPRITE_LAYOUT,
  sheets: Object.fromEntries(SPRITE_KITS.map((k) => [k, {} as CanvasImageSource])),
  failed: [],
};

function scene(): { state: ReturnType<typeof createMatch>; base: RenderOptions; controlledId: string; cam: ReturnType<typeof createCamera> } {
  const home = generateSquad(1, "H", 55);
  const away = generateSquad(2, "A", 55);
  const controlledId = home[5]!.id;
  const state = createMatch({
    matchId: "pitch-test",
    seed: 3,
    rules: U11_9V9,
    home: { side: "home", name: "Home", shortName: "HOM", squad: home },
    away: { side: "away", name: "Away", shortName: "AWY", squad: away },
    controlled: { side: "home", playerId: controlledId },
  });
  const cam = createCamera(U11_9V9, 780, 1688);
  setInsets(cam, 104, 240);
  const visuals = deriveVisuals(createPresentation(), state, cam, 50, 1, 0);
  const base: RenderOptions = {
    controlledId,
    moment: null,
    optionAnchors: new Map(),
    slow: 0,
    major: false,
    visuals,
    sprites,
    ballHeightM: 0,
    timeS: 1,
  };
  return { state, base, controlledId, cam };
}

describe("pitch frame", () => {
  it("draws a whole frame on a phone viewport within the documented draw-call budget", () => {
    const { state, base, cam } = scene();
    const withSprites = countingContext();
    render(withSprites.ctx, cam, state, base);
    expect(withSprites.count("drawImage")).toBe(state.players.length);
    expect(withSprites.paints()).toBeLessThanOrEqual(320);
    expect(withSprites.total()).toBeLessThanOrEqual(1200);

    const fallback = countingContext();
    render(fallback.ctx, cam, state, { ...base, sprites: null });
    expect(fallback.count("drawImage")).toBe(0);
    expect(fallback.paints()).toBeLessThanOrEqual(320);
  });

  it("never mutates the match state it presents", () => {
    const { state, base, cam } = scene();
    const before = JSON.stringify(state);
    const { ctx } = countingContext();
    render(ctx, cam, state, base);
    render(ctx, cam, state, { ...base, ballPos: { x: 10, y: 10 }, ballHeightM: 1.2, slow: 1, major: true, momentAge: 0.2 });
    expect(JSON.stringify(state)).toBe(before);
  });
});

const fakeMoment = (playerId: string): NonNullable<RenderOptions["moment"]> => ({ playerId, major: false, options: [] }) as unknown as NonNullable<RenderOptions["moment"]>;

describe("golden-moment effects", () => {
  const pulses: GroundPulse[] = [
    { pos: { x: 30, y: 20 }, age: 0.1, tone: "commit" },
    { pos: { x: 31, y: 21 }, age: 0.5, tone: "good" },
    { pos: { x: 32, y: 22 }, age: 0.8, tone: "poor" },
  ];

  it("adds ground pulses and a focus ripple as extra ellipse strokes only", () => {
    const { state, base, cam, controlledId } = scene();
    const plain = countingContext();
    render(plain.ctx, cam, state, base);
    const moment = fakeMoment(controlledId);

    const withEffects = countingContext();
    render(withEffects.ctx, cam, state, { ...base, moment, momentAge: 0.1, pulses });
    expect(withEffects.count("ellipse")).toBeGreaterThan(plain.count("ellipse"));
    expect(withEffects.count("drawImage")).toBe(plain.count("drawImage"));
  });

  it("stops drawing a ripple once the moment is older than its life and ignores expired pulses", () => {
    const { state, base, cam, controlledId } = scene();
    const moment = fakeMoment(controlledId);
    const young = countingContext();
    render(young.ctx, cam, state, { ...base, moment, momentAge: 0.1 });
    const old = countingContext();
    render(old.ctx, cam, state, { ...base, moment, momentAge: 5 });
    expect(old.count("ellipse")).toBeLessThan(young.count("ellipse"));

    const none = countingContext();
    render(none.ctx, cam, state, { ...base, pulses: [] });
    const expired = countingContext();
    render(expired.ctx, cam, state, { ...base, pulses: [{ pos: { x: 30, y: 20 }, age: PULSE_LIFE_S + 1, tone: "good" }] });
    expect(expired.total()).toBe(none.total());
  });

  it("letterboxes only major moments while slowed", () => {
    const { state, base, cam } = scene();
    const minor = countingContext();
    render(minor.ctx, cam, state, { ...base, slow: 1, major: false });
    const major = countingContext();
    render(major.ctx, cam, state, { ...base, slow: 1, major: true });
    expect(major.count("fillRect")).toBe(minor.count("fillRect") + 2);
  });
});
