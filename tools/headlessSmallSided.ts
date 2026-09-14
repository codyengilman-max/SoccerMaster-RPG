import { ACTIVITIES, bestOf, createDrill, runHeadless, summarize, type Activity, type Option } from "../src/training/smallSided";

/** Calibration: best / worst / timeout policies per activity across seeds (npm run sim:smallsided). */

type Policy = (opts: readonly Option[]) => { optionId: string; accuracy: number } | null;

const policies: Record<string, Policy> = {
  best_clean: (o) => ({ optionId: bestOf(o).id, accuracy: 0.95 }),
  best_loose: (o) => ({ optionId: bestOf(o).id, accuracy: 0.3 }),
  worst_clean: (o) => ({ optionId: [...o].sort((a, b) => a.score - b.score)[0]!.id, accuracy: 0.95 }),
  timeout: () => null,
};

for (const act of ACTIVITIES) {
  console.log(`\n== ${act}`);
  for (const [name, pol] of Object.entries(policies)) {
    const agg = { success: 0, partial: 0, failure: 0, strong: 0, weak: 0, timeout: 0, n: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const s = summarize(runHeadless(createDrill(act as Activity, seed, { reps: 6 }), (_d, o) => pol(o)));
      agg.success += s.outcomes.success;
      agg.partial += s.outcomes.partial;
      agg.failure += s.outcomes.failure;
      agg.strong += s.decisions.strong;
      agg.weak += s.decisions.weak;
      agg.timeout += s.decisions.timeout;
      agg.n += s.reps;
    }
    const pct = (x: number) => `${Math.round((100 * x) / agg.n)}%`;
    console.log(`${name.padEnd(12)} success ${pct(agg.success)} partial ${pct(agg.partial)} failure ${pct(agg.failure)} | strong ${pct(agg.strong)} weak ${pct(agg.weak)} timeout ${pct(agg.timeout)}`);
  }
  const bestIds = new Map<string, number>();
  for (let seed = 1; seed <= 40; seed++) {
    const d = createDrill(act as Activity, seed, { reps: 6 });
    runHeadless(d, (_d, o) => ({ optionId: bestOf(o).id, accuracy: 0.9 }));
    for (const r of d.records) bestIds.set(r.bestId, (bestIds.get(r.bestId) ?? 0) + 1);
  }
  console.log("best options:", [...bestIds.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
}
