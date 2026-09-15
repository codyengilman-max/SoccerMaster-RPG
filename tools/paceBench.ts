/*
 * Real-time pace benchmark (docs/PERFORMANCE.md "match duration"). Runs complete matches through the
 * headless pace harness (src/perf/pace.ts) and prints how much real play time each one costs, split
 * by pace phase, against the 6–8 minute target. Player models: quick (~1.5 s per decision), typical
 * (~4 s), slow (lets every window time out — the worst case).
 *
 * Usage: npm run pace -- [seeds=4] [role=CM] [player=typical|quick|slow|all] [fps=60] [json]
 */
import catalogJson from "../content/catalog/provisional-u11.json";
import { formatRealTime } from "../src/match/pace";
import { runPace, type PaceRun, type PlayerModel } from "../src/perf/pace";
import type { RoleId } from "../src/sim/types";
import { loadCatalog, type CatalogFile } from "../src/tactics/catalog";

const seeds = Number(process.argv[2] ?? 4);
const role = (process.argv[3] ?? "CM") as RoleId;
const playerArg = process.argv[4] ?? "typical";
const fps = Number(process.argv[5] ?? 60);
const asJson = process.argv.includes("json");
const players: PlayerModel[] = playerArg === "all" ? ["quick", "typical", "slow"] : [playerArg as PlayerModel];
const catalog = loadCatalog(catalogJson as CatalogFile);

const runs: PaceRun[] = [];
for (const player of players) for (let i = 0; i < seeds; i++) runs.push(runPace(catalog, 2000 + i, role, player, fps));

if (asJson) {
  console.log(JSON.stringify(runs, null, 2));
} else {
  console.log(`pace bench · role ${role} · ${seeds} complete matches per player model · ${fps} Hz frames`);
  for (const r of runs) {
    const ph = r.byPhase;
    console.log(
      `  seed ${r.seed} ${r.player.padEnd(7)} real ${formatRealTime(r.realMs)} (${r.withinBand ? "in band" : "OUT OF BAND"})` +
        ` · ${r.moments} moments (${r.onBall} on ball) · ${r.simMinutes.toFixed(0)} sim min · ${r.score}` +
        ` · decisions ${formatRealTime(ph.window)} · live ${formatRealTime(ph.aftermath)} · fast-forward ${formatRealTime(ph.routine)} (peak ×${r.peakScale.toFixed(0)}, max ${r.maxTicksPerFrame} ticks/frame) · half time ${formatRealTime(ph.halftime)}`,
    );
  }
  const ok = runs.every((r) => r.withinBand && r.moments >= 18 && r.moments <= 25);
  console.log(`  target: 6:00–8:00 real time for a complete 60-minute match with 18–25 tactical moments`);
  console.log(ok ? "  PASS" : "  FAIL");
  if (!ok) process.exitCode = 1;
}
