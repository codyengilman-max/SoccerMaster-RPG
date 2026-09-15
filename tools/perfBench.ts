/*
 * Headless performance benchmark (docs/PERFORMANCE.md). Drives the real match runtime at a fixed
 * 60 Hz frame cadence with a scripted user, times `frame()` (simulation + tactics) and the canvas
 * renderer against a counting stub context, and prints the same summary the in-app probe shows.
 *
 * Numbers from this tool are CPU costs on the machine running it, not phone frame rates: they
 * establish that the per-frame work fits the budget with headroom. Device evidence must come from
 * the in-app probe (`?perf` in the URL) on representative phones.
 *
 * Usage: npm run perf -- [seeds=3] [role=CM] [json]
 */
import catalogJson from "../content/catalog/provisional-u11.json";
import { createRuntime, frame, releaseGesture, select, type MatchRuntime } from "../src/match/runtime";
import { isFinished } from "../src/sim/engine";
import { formatSummary, summarize, type FrameSample, type ProbeSummary } from "../src/perf/probe";
import { createCamera, follow, frameFor } from "../src/render/camera";
import { render } from "../src/render/pitch";
import { Rng } from "../src/sim/rng";
import { U11_9V9 } from "../src/sim/rules";
import { generateSquad } from "../src/sim/squad";
import { ROLE_BY_NUMBER, type RoleId, type RoleNumber } from "../src/sim/types";
import { loadCatalog, type CatalogFile } from "../src/tactics/catalog";
import { pacingFor } from "../src/tactics/recognition";

const seeds = Number(process.argv[2] ?? 3);
const roleArg = (process.argv[3] ?? "CM") as RoleId;
const asJson = process.argv.includes("json");
const FRAME_MS = 1000 / 60;
/** Phone-sized canvas at 2× device pixel ratio. */
const VIEW = { w: 390 * 2, h: 560 * 2 };

const roleNumber = (Object.keys(ROLE_BY_NUMBER) as unknown as string[]).map(Number).find((n) => ROLE_BY_NUMBER[n as RoleNumber] === roleArg) as RoleNumber | undefined;
if (!roleNumber) throw new Error(`unknown role ${roleArg}`);
const catalog = loadCatalog(catalogJson as CatalogFile);

/**
 * A CanvasRenderingContext2D stand-in that counts calls. Every method is a no-op; `create*`
 * factories (gradients, patterns) return another counting stub so `addColorStop` etc. work.
 */
function countingContext(): { ctx: CanvasRenderingContext2D; calls: () => number; reset: () => void } {
  let n = 0;
  const stub = (): unknown => {
    const target: Record<string | symbol, unknown> = {};
    return new Proxy(target, {
      get(t, key) {
        if (key in t) return t[key];
        return (..._args: unknown[]) => {
          n++;
          return typeof key === "string" && key.startsWith("create") ? stub() : undefined;
        };
      },
      set(t, key, value) {
        t[key] = value;
        return true;
      },
    });
  };
  return { ctx: stub() as CanvasRenderingContext2D, calls: () => n, reset: () => (n = 0) };
}

interface MatchBench {
  seed: number;
  summary: ProbeSummary;
  drawCallsP95: number;
  moments: number;
  simMinutes: number;
}

function benchMatch(seed: number): MatchBench {
  const home = generateSquad(seed * 7 + 1, "H", 55);
  const away = generateSquad(seed * 7 + 2, "A", 55);
  const me = home.find((p) => p.role === roleNumber);
  if (!me) throw new Error("role missing from squad");
  const runtime: MatchRuntime = createRuntime(
    {
      matchId: `perf-${seed}`,
      seed,
      rules: U11_9V9,
      home: { side: "home", name: "Home", shortName: "HOM", squad: home },
      away: { side: "away", name: "Away", shortName: "AWY", squad: away },
      controlled: { side: "home", playerId: me.id },
    },
    catalog,
    { pacing: pacingFor(roleArg) },
  );
  const user = new Rng(seed ^ 0x51ed270b);
  const cam = createCamera(U11_9V9, VIEW.w, VIEW.h);
  const { ctx, calls, reset } = countingContext();
  const samples: FrameSample[] = [];
  const drawCalls: number[] = [];
  const anchors = new Map<string, { x: number; y: number }>();
  let slow = 0;
  let answerIn = 0;

  // a 60-minute match at 60 Hz is ~216k frames plus slow-motion windows
  for (let f = 0; f < 400_000 && !isFinished(runtime.state); f++) {
    const t0 = performance.now();
    const res = frame(runtime, FRAME_MS);
    // scripted user: answer each moment ~0.8 s in, half by drawing, half by choosing
    if (res.opened) answerIn = Math.round(800 / FRAME_MS);
    if (runtime.active && --answerIn === 0) {
      const opts = runtime.active.moment.options;
      const pick = opts[Math.floor(user.next() * opts.length)]!;
      const me2 = runtime.state.players.find((p) => p.id === runtime.active!.moment.playerId)!;
      if (pick.drawn && user.next() < 0.5) {
        const to = pick.anchor ?? me2.pos;
        releaseGesture(runtime, [me2.pos, { x: (me2.pos.x + to.x) / 2, y: (me2.pos.y + to.y) / 2 }, to]);
      } else select(runtime, pick.id);
    }
    const t1 = performance.now();

    const st = runtime.state;
    const w = runtime.active;
    slow += ((w ? 1 : 0) - slow) * 0.15;
    anchors.clear();
    const ctrl = st.players.find((p) => p.id === me.id) ?? null;
    follow(cam, st.rules, frameFor(st.rules, st.ball.pos, ctrl?.pos ?? null, !!w, w?.moment.major ?? false), w ? 0.12 : 0.08);
    reset();
    render(ctx, cam, st, { controlledId: me.id, window: w, optionAnchors: anchors, slow, major: w?.moment.major ?? false });
    drawCalls.push(calls());
    samples.push({ frameMs: FRAME_MS, simMs: t1 - t0, renderMs: performance.now() - t1, ticks: res.ticks });
  }
  drawCalls.sort((a, b) => a - b);
  return {
    seed,
    summary: summarize(samples),
    drawCallsP95: drawCalls[Math.max(0, Math.ceil(0.95 * drawCalls.length) - 1)] ?? 0,
    moments: runtime.session.records.length,
    simMinutes: runtime.state.clock.timeMs / 60_000,
  };
}

const results: MatchBench[] = [];
for (let i = 0; i < seeds; i++) results.push(benchMatch(1000 + i));

const worstSim = Math.max(...results.map((r) => r.summary.simP95));
const worstRender = Math.max(...results.map((r) => r.summary.renderP95));
const worstDraw = Math.max(...results.map((r) => r.drawCallsP95));

if (asJson) {
  console.log(JSON.stringify({ role: roleArg, view: VIEW, results, worst: { simP95: worstSim, renderP95: worstRender, drawCallsP95: worstDraw } }, null, 2));
} else {
  console.log(`perf bench · role ${roleArg} · ${seeds} full matches at 60 Hz · stub canvas ${VIEW.w}×${VIEW.h}`);
  for (const r of results) {
    console.log(`  seed ${r.seed}: ${r.summary.frames} frames, ${r.simMinutes.toFixed(0)} sim min, ${r.moments} moments · sim p50 ${r.summary.simP50.toFixed(3)} p95 ${r.summary.simP95.toFixed(3)} ms · draw-call path p95 ${r.summary.renderP95.toFixed(3)} ms · draw calls p95 ${r.drawCallsP95}`);
  }
  console.log(`  worst p95: sim ${worstSim.toFixed(3)} ms · render path ${worstRender.toFixed(3)} ms · draw calls ${worstDraw}`);
  console.log(`  budget (docs/PERFORMANCE.md): sim ≤ 4 ms, render path ≤ 4 ms, draw calls ≤ 600 per frame`);
  console.log(`  sample: ${formatSummary(results[0]!.summary)}`);
  const ok = worstSim <= 4 && worstRender <= 4 && worstDraw <= 600;
  console.log(ok ? "  PASS (CPU budget on this machine — not phone evidence)" : "  FAIL");
  if (!ok) process.exitCode = 1;
}
