import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCancelGesture, readGesture } from "../src/gesture/gesture";
import { Rng } from "../src/sim/rng";
import {
  GATES,
  RECEIVE_POINT,
  commitGate,
  createDrill,
  current,
  openness,
  readDraw,
  readTap,
  step,
  summarize,
  type DrillState,
  type GateId,
  type RepRecord,
} from "../src/training/firstTouch";

/**
 * Emits the cross-language parity fixture consumed by the Unity EditMode tests
 * (unity/Assets/SoccerMaster/Tests/EditMode/FirstTouchParityTests.cs). The web
 * implementation is the oracle: every number here is produced by running the
 * TypeScript drill, never typed by hand. Regenerate with `npm run native:fixtures`
 * whenever src/training/firstTouch.ts, src/gesture/gesture.ts, src/sim/rng.ts or
 * src/sim/geometry.ts change.
 */

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../unity/Assets/SoccerMaster/Tests/Fixtures/first_touch_parity.json");

type Policy = "best" | "worst" | "none";

const policyFor = (kind: Policy) => (rec: RepRecord): { gate: GateId; accuracy: number } | null => {
  if (kind === "none") return null;
  if (kind === "best") return { gate: rec.bestGate, accuracy: 0.9 };
  const o = openness(rec.defenderFrom);
  const worst = GATES.map((g) => g.id).sort((a, b) => o[a] - o[b])[0]!;
  return { gate: worst, accuracy: 0.2 };
};

interface Frame {
  timeMs: number;
  phase: string;
  windowMs: number;
  acc: number;
  rngState: number;
  ballX: number;
  ballY: number;
  ballVx: number;
  ballVy: number;
  playerX: number;
  playerY: number;
  defenderX: number;
  defenderY: number;
  events: string[];
}

const frame = (d: DrillState, events: string[]): Frame => ({
  timeMs: d.timeMs,
  phase: d.phase,
  windowMs: d.windowMs,
  acc: d.acc,
  rngState: d.rngState,
  ballX: d.ball.pos.x,
  ballY: d.ball.pos.y,
  ballVx: d.ball.vel.x,
  ballVy: d.ball.vel.y,
  playerX: d.player.x,
  playerY: d.player.y,
  defenderX: d.defender.pos.x,
  defenderY: d.defender.pos.y,
  events,
});

const record = (r: RepRecord) => ({
  index: r.index,
  defenderFromX: r.defenderFrom.x,
  defenderFromY: r.defenderFrom.y,
  bestGate: r.bestGate,
  chosenGate: r.chosenGate ?? "",
  decision: r.decision,
  accuracy: r.accuracy,
  execution: r.execution ?? "",
  outcome: r.outcome ?? "",
});

/** Runs the drill with the same 100 ms cadence as `runHeadless`, keeping every frame. */
function run(seed: number, reps: number, accessible: boolean, policy: Policy, stepMs: number, maxSteps: number) {
  const d = createDrill(seed, reps, accessible);
  const pick = policyFor(policy);
  const frames: Frame[] = [frame(d, d.events.map((e) => e.type))];
  for (let i = 0; i < maxSteps && d.phase !== "done"; i++) {
    const evs: string[] = step(d, stepMs).map((e) => e.type);
    if (evs.includes("window_open")) {
      const choice = pick(current(d)!);
      if (choice) {
        const rec = commitGate(d, choice.gate, choice.accuracy);
        evs.push(`commit:${choice.gate}:${rec?.decision ?? "null"}`);
      }
    }
    frames.push(frame(d, evs));
  }
  const s = summarize(d);
  return {
    seed,
    reps,
    accessible,
    policy,
    stepMs,
    frames,
    records: d.records.map(record),
    summary: {
      reps: s.reps,
      strong: s.decisions.strong,
      acceptable: s.decisions.acceptable,
      weak: s.decisions.weak,
      timeout: s.decisions.timeout,
      clean: s.executions.clean,
      ok: s.executions.ok,
      loose: s.executions.loose,
      through: s.outcomes.through,
      wide: s.outcomes.wide,
      intercepted: s.outcomes.intercepted,
      meanAccuracy: s.meanAccuracy,
      reads: s.reads,
      touch: s.touch,
    },
  };
}

const rngFixture = (seed: number, n: number) => {
  const r = new Rng(seed);
  const next: number[] = [];
  for (let i = 0; i < n; i++) next.push(r.next());
  const ints: number[] = [];
  for (let i = 0; i < n; i++) ints.push(r.int(0, 6));
  const gaussians: number[] = [];
  for (let i = 0; i < n; i++) gaussians.push(r.gaussian());
  return { seed, next, ints, gaussians, state: r.snapshot() };
};

const pathTo = (target: { x: number; y: number }, wobble = 0) => [
  RECEIVE_POINT,
  { x: (RECEIVE_POINT.x + target.x) / 2, y: (RECEIVE_POINT.y + target.y) / 2 + wobble },
  target,
];

const draws = [
  pathTo(GATES[0]!.center),
  pathTo(GATES[1]!.center, 0.8),
  pathTo(GATES[2]!.center, -1.3),
  pathTo({ x: 15, y: 6 }),
  [RECEIVE_POINT, { x: RECEIVE_POINT.x - 4, y: RECEIVE_POINT.y }],
  [RECEIVE_POINT, { x: RECEIVE_POINT.x + 0.5, y: RECEIVE_POINT.y + 0.4 }],
  [RECEIVE_POINT],
  [RECEIVE_POINT, { x: 16, y: 9 }, { x: 10.5, y: 9.2 }],
];

const taps = [
  { x: GATES[2]!.center.x + 0.5, y: GATES[2]!.center.y },
  { x: 1, y: 1 },
  GATES[1]!.center,
  { x: 19, y: 5 },
  { x: RECEIVE_POINT.x + 0.2, y: RECEIVE_POINT.y },
];

const gestures = draws.map((points) => {
  const g = readGesture(points);
  const d = readDraw(points);
  return {
    points: points.map((p) => ({ x: p.x, y: p.y })),
    valid: g !== null,
    directionX: g?.direction.x ?? 0,
    directionY: g?.direction.y ?? 0,
    length: g?.length ?? 0,
    straightness: g?.straightness ?? 0,
    reach: g?.reach ?? 0,
    cancel: isCancelGesture(points),
    gate: d.gate ?? "",
    accuracy: d.accuracy,
  };
});

const tapReads = taps.map((p) => {
  const d = readTap(p);
  return { x: p.x, y: p.y, gate: d.gate ?? "", accuracy: d.accuracy };
});

const fixture = {
  generator: "tools/nativeFixtures.ts",
  source: ["src/training/firstTouch.ts", "src/gesture/gesture.ts", "src/sim/rng.ts", "src/sim/geometry.ts"],
  gates: GATES.map((g) => ({ id: g.id, cx: g.center.x, cy: g.center.y, ax: g.a.x, ay: g.a.y, bx: g.b.x, by: g.b.y })),
  rng: [rngFixture(0, 16), rngFixture(7, 16), rngFixture(0xffffffff, 8), rngFixture(-1, 8)],
  runs: [
    run(7, 6, false, "best", 100, 20_000),
    run(3, 6, false, "best", 100, 20_000),
    run(3, 6, false, "worst", 100, 20_000),
    run(1, 6, false, "best", 100, 20_000),
    run(2, 6, false, "best", 100, 20_000),
    run(5, 1, false, "none", 100, 2_000),
    run(4, 1, true, "none", 3000, 200),
    run(9, 2, false, "best", 50, 20_000),
    run(11, 3, false, "worst", 33, 20_000),
  ],
  gestures,
  taps: tapReads,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(fixture)}\n`);
const frames = fixture.runs.reduce((n, r) => n + r.frames.length, 0);
console.log(`wrote ${OUT}: ${fixture.runs.length} runs, ${frames} frames, ${gestures.length} gestures, ${tapReads.length} taps`);
