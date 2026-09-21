import { describe, expect, it } from "vitest";
import { AVATAR_LOOKS, drawAvatar } from "../../src/render/avatar";
import { APPEARANCE_PRESETS } from "../../src/ui/createScreen";

/** Records the 2D calls so we can assert what a preset draws without a real canvas. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: string[]; fills: string[] } {
  const calls: string[] = [];
  const fills: string[] = [];
  const gradient = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    scale: () => calls.push("scale"),
    fillRect: () => calls.push("fillRect"),
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    quadraticCurveTo: () => calls.push("quadraticCurveTo"),
    arc: () => calls.push("arc"),
    ellipse: () => calls.push("ellipse"),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke"),
    createRadialGradient: () => gradient,
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    strokeStyle: "",
  };
  let fillStyle: unknown = "";
  Object.defineProperty(target, "fillStyle", {
    get: () => fillStyle,
    set: (v: unknown) => {
      fillStyle = v;
      if (typeof v === "string") fills.push(v);
    },
  });
  return { ctx: target as unknown as CanvasRenderingContext2D, calls, fills };
}

describe("appearance preset portraits", () => {
  it("has exactly one look per saved appearance id, in preset order", () => {
    expect(AVATAR_LOOKS).toHaveLength(APPEARANCE_PRESETS.length);
    expect(AVATAR_LOOKS.map((l) => l.style)).toEqual(["short", "curly", "tiedBack", "buzz", "braids", "shortGlasses"]);
  });

  it("draws every preset with its own skin and hair colours and balances save/restore", () => {
    const seen = new Set<string>();
    for (let i = 0; i < APPEARANCE_PRESETS.length; i++) {
      const { ctx, calls, fills } = recordingContext();
      drawAvatar(ctx, i, 64);
      expect(calls.filter((c) => c === "save")).toHaveLength(1);
      expect(calls.filter((c) => c === "restore")).toHaveLength(1);
      expect(fills).toContain(AVATAR_LOOKS[i]!.skin);
      expect(fills).toContain(AVATAR_LOOKS[i]!.hair);
      seen.add(`${AVATAR_LOOKS[i]!.skin}/${AVATAR_LOOKS[i]!.style}`);
    }
    expect(seen.size).toBe(APPEARANCE_PRESETS.length);
  });

  it("differs between presets so previews are distinguishable", () => {
    const shapes = AVATAR_LOOKS.map((_, i) => {
      const { ctx, calls } = recordingContext();
      drawAvatar(ctx, i, 64);
      return calls.join(",");
    });
    expect(new Set(shapes).size).toBe(AVATAR_LOOKS.length);
  });

  it("wraps out-of-range ids instead of throwing (older saves stay loadable)", () => {
    const { ctx } = recordingContext();
    expect(() => drawAvatar(ctx, 99, 32)).not.toThrow();
    expect(() => drawAvatar(ctx, -1, 32)).not.toThrow();
  });
});
