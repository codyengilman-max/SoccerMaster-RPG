import type { CampaignKind } from "../src/campaign/campaign";
import { arcScenes, milestoneScenes, optionalScenesFor } from "../src/story/arc";
import { campaignScenes } from "../src/story/flow";
import { toneReport, type Scene, type Tone } from "../src/story/scenes";

/**
 * Editorial-mix report (spec §6: ~30% reward, ~15% concentrated adversity, ~55% everyday life,
 * connection, discovery and humour). Counts authored scene tags per campaign and per layer; the
 * tags never touch results. Exits non-zero if either campaign's authored arc has a tone missing
 * or drifts more than the tolerance from the target.
 */

const TOLERANCE = 0.15;
const KINDS: readonly CampaignKind[] = ["boys", "girls"];
const pct = (x: number): string => `${Math.round(x * 100)}%`;

function line(label: string, scenes: readonly Scene[]): void {
  const r = toneReport(scenes);
  const tones: Tone[] = ["reward", "adversity", "everyday"];
  const parts = tones.map((t) => `${t} ${pct(r.share[t])} (${scenes.filter((s) => s.tone === t).length}; target ${pct(r.target[t])})`);
  console.log(`  ${label.padEnd(22)} ${String(r.total).padStart(3)} scenes  ${parts.join("  ")}`);
}

let failed = false;
for (const kind of KINDS) {
  console.log(`${kind}`);
  const all = campaignScenes(kind);
  line("all authored", all);
  line("opening", all.filter((s) => s.id.startsWith("open.")));
  line("week", all.filter((s) => s.id.startsWith("week.")));
  line("season/tournament", all.filter((s) => s.id.startsWith("season.") || s.id.startsWith("tournament.")));
  line("tryouts", all.filter((s) => s.id.startsWith("tryouts.")));
  line("hobbies", all.filter((s) => s.id.startsWith("hobby.")));
  const arc = arcScenes(kind);
  line("U11 arc", arc);
  line("  milestones", milestoneScenes(kind));
  line("  optional", optionalScenesFor(kind));
  line("  unlock", arc.filter((s) => s.id.startsWith("unlock.")));
  const locations = new Map<string, number>();
  for (const s of arc) locations.set(s.location, (locations.get(s.location) ?? 0) + 1);
  console.log(`  arc locations: ${[...locations.entries()].map(([l, n]) => `${l} ${n}`).join(", ")}`);
  const proposals = all.filter((s) => s.reviewStatus === "proposal").length;
  console.log(`  review status: ${proposals}/${all.length} scenes still "proposal"`);

  const r = toneReport(arc);
  for (const t of ["reward", "adversity", "everyday"] as const) {
    if (r.share[t] === 0) {
      console.error(`  FAIL ${kind}: arc has no ${t} scenes`);
      failed = true;
    } else if (Math.abs(r.share[t] - r.target[t]) > TOLERANCE) {
      console.error(`  FAIL ${kind}: arc ${t} share ${pct(r.share[t])} is more than ${pct(TOLERANCE)} from target ${pct(r.target[t])}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
