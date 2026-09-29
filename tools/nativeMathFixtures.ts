/**
 * Records V8's results for the transcendental functions the canonical engine uses (sin, cos, acos,
 * atan, atan2) so the C# port (`Fdlibm.cs`) can be checked bit-for-bit. Host libm implementations
 * differ from V8's fdlibm in the last bit for roughly 6% of arguments, which is enough to break
 * simulation parity after a few thousand ticks.
 *
 *   npx tsx tools/nativeMathFixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../unity/Assets/SoccerMaster/Tests/Fixtures/math_parity.json");

type Fn = "sin" | "cos" | "acos" | "atan" | "atan2";

let s = 0x2545f491;
const rnd = () => {
  s = (s * 1664525 + 1013904223) >>> 0;
  return s / 4294967296;
};
const str = (n: number) => (Object.is(n, -0) ? "-0" : String(n));

const lines: string[] = [];
const push = (fn: Fn, ...args: number[]) => lines.push([fn, ...args.map(str), str(Math[fn](...(args as [number, number])))].join("|"));

const scales = [1e-3, 0.1, 1, 3, 10, 100, 1e4];
for (let i = 0; i < 1500; i++) {
  const scale = scales[i % scales.length];
  const x = (rnd() * 2 - 1) * scale;
  const y = (rnd() * 2 - 1) * scale;
  push("sin", x);
  push("cos", x);
  push("acos", Math.max(-1, Math.min(1, x / scale)));
  push("atan", x);
  push("atan2", y, x);
}
for (const x of [0, -0, 1, -1, 0.5, -0.5, Math.PI / 4, Math.PI / 2, Math.PI, 2 * Math.PI, 1e-20, 1e300]) {
  push("sin", x);
  push("cos", x);
  push("atan", x);
  push("atan2", x, 1);
  push("atan2", 1, x);
  push("atan2", x, -1);
}

const fixture = { generator: "tools/nativeMathFixtures.ts", cases: lines };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture));
console.log(`wrote ${OUT} (${lines.length} cases)`);
