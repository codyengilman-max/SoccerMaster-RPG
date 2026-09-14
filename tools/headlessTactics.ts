/*
 * Run one match with a controlled player and a scripted "user" that answers every tactical moment,
 * then print the coverage report. Usage: npm run sim:tactics -- [seed] [role] [policy]
 *   role:   GK RB LB CB DM CM RW ST LW      (default CM)
 *   policy: best | random | worst | timeout (default random)
 */
import catalogJson from "../content/catalog/provisional-u11.json";
import { createMatch, isFinished, tick } from "../src/sim/engine";
import { Rng } from "../src/sim/rng";
import { U11_9V9 } from "../src/sim/rules";
import { generateSquad } from "../src/sim/squad";
import { ROLE_BY_NUMBER, type RoleId, type RoleNumber } from "../src/sim/types";
import { loadCatalog, type CatalogFile } from "../src/tactics/catalog";
import { coverageReport } from "../src/tactics/coverage";
import { pacingFor } from "../src/tactics/recognition";
import { commit, createSession, observe, timeout } from "../src/tactics/session";

const seed = Number(process.argv[2] ?? 42);
const roleArg = (process.argv[3] ?? "CM") as RoleId;
const policy = process.argv[4] ?? "random";

const roleNumber = (Object.keys(ROLE_BY_NUMBER) as unknown as string[]).map(Number).find((n) => ROLE_BY_NUMBER[n as RoleNumber] === roleArg) as RoleNumber | undefined;
if (!roleNumber) throw new Error(`unknown role ${roleArg}`);

const home = generateSquad(seed * 7 + 1, "H", 55);
const away = generateSquad(seed * 7 + 2, "A", 55);
const me = home.find((p) => p.role === roleNumber);
if (!me) throw new Error("role missing from squad");

const catalog = loadCatalog(catalogJson as CatalogFile);
const session = createSession(catalog, pacingFor(roleArg));
const state = createMatch({
  matchId: `tactics-${seed}`,
  seed,
  rules: U11_9V9,
  home: { side: "home", name: "Home", shortName: "HOM", squad: home },
  away: { side: "away", name: "Away", shortName: "AWY", squad: away },
  controlled: { side: "home", playerId: me.id },
});
const user = new Rng(seed ^ 0x9e3779b9);
let pendingUntil = -1;

const t0 = Date.now();
while (!isFinished(state)) {
  const moment = observe(session, state);
  if (moment) {
    // slow motion: a 1–3 s real decision at 0.12× is 0.12–0.36 simulated seconds (2–7 ticks)
    pendingUntil = state.clock.tick + user.int(2, 8);
  }
  if (session.active && state.clock.tick >= pendingUntil) {
    const m = session.active;
    const sorted = [...m.options].sort((a, b) => b.score - a.score);
    if (policy === "timeout") timeout(session, state);
    else {
      const pick = policy === "best" ? sorted[0] : policy === "worst" ? sorted[sorted.length - 1] : user.pick(m.options);
      if (pick) commit(session, state, pick.id, policy === "best" ? 1 : user.range(0.6, 1));
    }
  }
  tick(state);
}
const wall = Date.now() - t0;

const rep = coverageReport(session.records, session.pacing);
console.log(`seed ${seed} role ${roleArg} policy ${policy} — score ${state.score.home}-${state.score.away} (${wall} ms)`);
console.log(`moments ${rep.total}  with-ball ${rep.onBall}  on_ball ${rep.byCategory.on_ball} off_ball ${rep.byCategory.off_ball} defending ${rep.byCategory.defending} transition ${rep.byCategory.transition}`);
console.log(`difficulty easy ${rep.byDifficulty.easy} medium ${rep.byDifficulty.medium} hard ${rep.byDifficulty.hard}  major ${rep.major}  unique entries ${rep.uniqueEntries}`);
console.log(`decisions`, rep.decisions);
console.log(`outcomes`, rep.outcomes);
console.log(`rejects`, session.rejects);
if (rep.shortfalls.length) console.log(`shortfalls: ${rep.shortfalls.join("; ")}`);
for (const r of session.records.slice(0, 6)) {
  const min = (r.moment.timeMs / 60000).toFixed(1);
  console.log(`  ${min}' ${r.moment.entryId} [${r.moment.difficulty.band}] ${r.moment.options.map((o) => o.label).join(" | ")} → ${r.decision.band} / ${r.execution?.band ?? "-"} / ${r.outcome?.result ?? "-"}`);
}
