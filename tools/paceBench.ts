/*
 * Real-time pace benchmark (docs/PERFORMANCE.md "match duration"). Runs complete matches through the
 * headless pace harness (src/perf/pace.ts) and prints how much real play time each one costs, split
 * by runtime phase, against the 5–7 minute preferred / 4–8 minute acceptable band, together with the
 * moment count (12–18 direct involvements). Player models: quick (~3 s per answer), typical (~8 s),
 * slow (~13 s), timeout (never answers — the engine plays every moment on).
 *
 * Usage: npm run pace -- [seeds=4] [role=CM|all] [player=typical|quick|slow|timeout|all] [fps=60] [json]
 */
import catalogJson from "../content/catalog/provisional-u11.json";
import { ACCEPTABLE_BAND_MS, formatRealTime } from "../src/match/pace";
import { runPace, type PaceRun, type PlayerModel } from "../src/perf/pace";
import { ROLE_BY_NUMBER, type RoleId } from "../src/sim/types";
import { loadCatalog, type CatalogFile } from "../src/tactics/catalog";
import { DIRECT_RANGE } from "../src/tactics/recognition";

const seeds = Number(process.argv[2] ?? 4);
const roleArg = process.argv[3] ?? "CM";
const roles: RoleId[] = roleArg === "all" ? Object.values(ROLE_BY_NUMBER) : [roleArg as RoleId];
const playerArg = process.argv[4] ?? "typical";
const fps = Number(process.argv[5] ?? 60);
const asJson = process.argv.includes("json");
const players: PlayerModel[] = playerArg === "all" ? ["quick", "typical", "slow", "timeout"] : [playerArg as PlayerModel];
const catalog = loadCatalog(catalogJson as CatalogFile);

const runs: PaceRun[] = [];
for (const role of roles) for (const player of players) for (let i = 0; i < seeds; i++) runs.push(runPace(catalog, 2000 + i, role, player, fps));

if (asJson) {
  console.log(JSON.stringify(runs, null, 2));
} else {
  console.log(`pace bench · role ${roleArg} · ${seeds} complete matches per player model · ${fps} Hz frames`);
  for (const r of runs) {
    const ph = r.byPhase;
    const inv = r.byInvolvement;
    console.log(
      `  ${r.role.padEnd(2)} seed ${r.seed} ${r.player.padEnd(7)} real ${formatRealTime(r.realMs)} (${r.withinPreferred ? "preferred" : r.withinAcceptable ? "acceptable" : "OUT OF BAND"})` +
        ` · ${r.moments} moments (first touch ${inv.first_touch}, on ball ${inv.on_ball}, positioning ${inv.off_ball}; ${r.possessions} touches) · ${r.options[0]}–${r.options[1]} answers · ${r.timeouts} timeouts` +
        ` · ${r.simMinutes.toFixed(0)} sim min · ${r.score}` +
        ` · lead-in ${formatRealTime(ph.lead_in)} · answer ${formatRealTime(ph.question + ph.timer)} · consequence ${formatRealTime(ph.resolving)} · feedback ${formatRealTime(ph.feedback)} · skipped ${formatRealTime(ph.routine)} (max ${r.maxTicksPerFrame} ticks/frame) · half time ${formatRealTime(ph.halftime)}`,
    );
  }
  const sorted = [...runs].sort((a, b) => a.realMs - b.realMs);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  console.log(`  duration: min ${formatRealTime(sorted[0]!.realMs)} · median ${formatRealTime(med.realMs)} · max ${formatRealTime(sorted[sorted.length - 1]!.realMs)}`);
  // the ceiling binds every player model; the floor binds the typical player only (no waiting is added to slow a quick answerer down)
  const inBand = (r: PaceRun): boolean => r.withinAcceptable || (r.player === "quick" && r.realMs < ACCEPTABLE_BAND_MS[0]);
  const ok = runs.every((r) => inBand(r) && r.moments >= DIRECT_RANGE[0] && r.moments <= DIRECT_RANGE[1] && Math.round(r.simMinutes) === 60);
  console.log(`  target: 5:00–7:00 preferred (4:00–8:00 acceptable) for a complete 60-minute match with ${DIRECT_RANGE[0]}–${DIRECT_RANGE[1]} direct-involvement moments; a quick answerer may finish under 4:00`);
  console.log(ok ? "  PASS" : "  FAIL");
  if (!ok) process.exitCode = 1;
}
