import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import catalogJson from "../content/catalog/provisional-u11.json";
import { createMatch, isFinished, tick } from "../src/sim/engine";
import { Rng } from "../src/sim/rng";
import { U11_9V9 } from "../src/sim/rules";
import { generateSquad } from "../src/sim/squad";
import { ROLE_BY_NUMBER, type MatchEvent, type MatchState, type PlayerCommand, type RoleId, type RoleNumber } from "../src/sim/types";
import { loadCatalog, type CatalogFile } from "../src/tactics/catalog";
import type { CommittedIntent, DecisionRecord, MomentRecord, TacticalMoment } from "../src/tactics/moments";
import { fourAnswerPacingFor, pacingFor } from "../src/tactics/recognition";
import { commit, createSession, feedbackFor, observe, timeout, type CommitResult } from "../src/tactics/session";

/**
 * Emits the cross-language parity fixture for the tactical-moment slice
 * (unity/Assets/SoccerMaster/Tests/Fixtures/tactics_parity.json). The web implementation is the
 * oracle: whole official matches are run headless with a scripted user, and everything the native
 * port must reproduce is written down — the engine trace (sampled ball/rng/score/phase plus every
 * event), every recognised moment with its hidden option metadata, every commit (decision grade,
 * attribution, issued command) and every settled execution/outcome. Regenerate with
 * `npm run native:fixtures:tactics` whenever src/sim/** or src/tactics/** change.
 */

const OUT = process.env.SM_FIXTURE_OUT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../unity/Assets/SoccerMaster/Tests/Fixtures/tactics_parity.json");
const CATALOG_OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../unity/Assets/SoccerMaster/Resources/SoccerMaster/Catalog/provisional-u11.json");

type Policy = "cycle" | "delayed";

interface RunSpec {
  seed: number;
  role: RoleId;
  policy: Policy;
  /** Pin the displayed window to exactly four answers (the native contract). */
  four: boolean;
}

const RUNS: RunSpec[] = [
  { seed: 7, role: "RW", policy: "cycle", four: true },
  { seed: 11, role: "CM", policy: "delayed", four: true },
  { seed: 3, role: "GK", policy: "cycle", four: true },
  { seed: 5, role: "CB", policy: "delayed", four: false },
];

/** Debug knobs (not used by `npm run native:fixtures:tactics`): SM_FIXTURE_SEEDS=7,11 restricts the runs, SM_FIXTURE_DENSE=1 samples every tick, SM_FIXTURE_OUT overrides the fixture path. */
const DENSE = process.env.SM_FIXTURE_DENSE === "1";
const SEED_FILTER = process.env.SM_FIXTURE_SEEDS ? new Set(process.env.SM_FIXTURE_SEEDS.split(",").map((s) => Number(s))) : null;
const SAMPLE_EVERY_TICK_UNTIL = DENSE ? Number.MAX_SAFE_INTEGER : 200;
const SAMPLE_STRIDE = 100;

const f9 = (n: number) => n.toFixed(9);

/** One line per event: the fields the native trace must reproduce (positions are covered by the samples). */
function eventLine(e: MatchEvent): string {
  switch (e.type) {
    case "kickoff":
      return `${e.tick}|kickoff|${e.side}`;
    case "pass":
      return `${e.tick}|pass|${e.from}|${e.to ?? ""}|${e.side}|${f9(e.error)}`;
    case "receive":
      return `${e.tick}|receive|${e.player}|${e.from ?? ""}|${e.clean ? 1 : 0}`;
    case "carry":
      return `${e.tick}|carry|${e.player}`;
    case "shot":
      return `${e.tick}|shot|${e.player}|${e.side}|${e.onTarget ? 1 : 0}|${f9(e.error)}`;
    case "save":
      return `${e.tick}|save|${e.keeper}|${e.shooter}`;
    case "goal":
      return `${e.tick}|goal|${e.scorer}|${e.side}|${e.assist ?? ""}`;
    case "interception":
      return `${e.tick}|interception|${e.player}|${e.from ?? ""}`;
    case "recovery":
      return `${e.tick}|recovery|${e.player}`;
    case "tackle":
      return `${e.tick}|tackle|${e.player}|${e.victim}|${e.won ? 1 : 0}`;
    case "possession_change":
      return `${e.tick}|possession_change|${e.to}|${e.reason}`;
    case "out_of_play":
      return `${e.tick}|out_of_play|${e.restart}|${e.side}`;
    case "offside":
      return `${e.tick}|offside|${e.player}|${e.side}`;
    case "restart":
      return `${e.tick}|restart|${e.restart}|${e.side}|${e.taker}`;
    case "half_time":
      return `${e.tick}|half_time`;
    case "full_time":
      return `${e.tick}|full_time|${e.home}|${e.away}`;
  }
}

const cmdJson = (c: PlayerCommand | null | undefined): Record<string, unknown> | null => (c ? (JSON.parse(JSON.stringify(c)) as Record<string, unknown>) : null);

const momentJson = (m: TacticalMoment) => ({
  id: m.id,
  tick: m.tick,
  timeMs: m.timeMs,
  entryId: m.entryId,
  title: m.title,
  category: m.category,
  phase: m.phase,
  role: m.role,
  playerId: m.playerId,
  cues: m.cues,
  options: m.options.map((o) => ({
    id: o.id,
    actionId: o.actionId,
    label: o.label,
    intent: o.intent,
    drawn: o.drawn,
    command: cmdJson(o.command),
    anchor: o.anchor ? { x: o.anchor.x, y: o.anchor.y } : null,
    score: o.score,
    feasibility: o.feasibility,
    reasons: o.reasons,
    receiver: o.receiver ?? null,
    sourceEntryId: o.sourceEntryId ?? null,
  })),
  difficulty: { ...m.difficulty },
  major: m.major,
  involvement: m.involvement,
  read: { ...m.read },
});

const decisionJson = (d: DecisionRecord) => ({
  momentId: d.momentId,
  chosenOptionId: d.chosenOptionId,
  quality: d.quality,
  band: d.band,
  bestOptionId: d.bestOptionId,
  explanation: d.explanation,
  commitTick: d.commitTick,
});

const actedJson = (a: CommittedIntent | null) =>
  a ? { momentId: a.momentId, actor: a.actor, optionId: a.optionId, label: a.label, command: cmdJson(a.command), commitTick: a.commitTick } : null;

/** `tick|rng|ballX|ballY|status|owner|phase|home|away|events` with the ball to 9 decimals. */
const sample = (s: MatchState) =>
  `${s.clock.tick}|${s.rngState}|${f9(s.ball.pos.x)}|${f9(s.ball.pos.y)}|${s.ball.status}|${s.ball.owner ?? ""}|${s.phase.kind}|${s.score.home}|${s.score.away}|${s.events.length}`;

function runOne(spec: RunSpec) {
  const roleNumber = (Object.keys(ROLE_BY_NUMBER) as unknown as string[]).map(Number).find((n) => ROLE_BY_NUMBER[n as RoleNumber] === spec.role) as RoleNumber | undefined;
  if (!roleNumber) throw new Error(`unknown role ${spec.role}`);
  const home = generateSquad(spec.seed * 7 + 1, "H", 55);
  const away = generateSquad(spec.seed * 7 + 2, "A", 55);
  const me = home.find((p) => p.role === roleNumber);
  if (!me) throw new Error("role missing from squad");

  const catalog = loadCatalog(catalogJson as CatalogFile);
  const pacing = spec.four ? fourAnswerPacingFor(spec.role) : pacingFor(spec.role);
  const session = createSession(catalog, pacing);
  const state = createMatch({
    matchId: `tactics-parity-${spec.seed}`,
    seed: spec.seed,
    rules: U11_9V9,
    home: { side: "home", name: "Home", shortName: "HOM", squad: home },
    away: { side: "away", name: "Away", shortName: "AWY", squad: away },
    controlled: { side: "home", playerId: me.id },
  });
  const user = new Rng(spec.seed ^ 0x9e3779b9);

  const samples: string[] = [];
  const moments: ReturnType<typeof momentJson>[] = [];
  const commits: unknown[] = [];
  const seen = new Set<MomentRecord>();
  const settled: unknown[] = [];
  let pendingUntil = -1;
  let seq = 0;

  const recordCommit = (kind: "commit" | "timeout", moment: TacticalMoment, optionId: string | null, res: CommitResult) => {
    commits.push({ kind, momentId: moment.id, tick: state.clock.tick, optionId, status: res.status, decision: decisionJson(res.decision), acted: actedJson(res.acted), issued: cmdJson(res.issued) });
  };
  const collectSettled = () => {
    for (const r of session.records) {
      if (seen.has(r) || !r.outcome) continue;
      seen.add(r);
      settled.push({
        momentId: r.moment.id,
        execution: r.execution
          ? { actor: r.execution.actor, quality: r.execution.quality, band: r.execution.band, pressureAtCommit: r.execution.pressureAtCommit, fatigueAtCommit: r.execution.fatigueAtCommit }
          : null,
        outcome: { result: r.outcome.result, summary: r.outcome.summary, eventIds: r.outcome.eventIds, resolvedTick: r.outcome.resolvedTick },
        feedback: feedbackFor(session, r),
      });
    }
  };

  const trace: string[] = [];
  while (!isFinished(state)) {
    const t = state.clock.tick;
    if (process.env.SM_FIXTURE_TRACE) trace.push(`${t}|${state.ball.pos.x}|${state.ball.pos.y}|${state.ball.vel.x}|${state.ball.vel.y}|${state.ball.status}|${state.ball.owner ?? ""}|${state.players.map((p) => `${p.id}:${p.pos.x},${p.pos.y}`).join(";")}`);
    if (t <= SAMPLE_EVERY_TICK_UNTIL || t % SAMPLE_STRIDE === 0) samples.push(sample(state));
    const moment = observe(session, state);
    if (moment) {
      moments.push(momentJson(moment));
      // "cycle" answers on the recognition tick exactly as the runtime does (the field is frozen);
      // "delayed" lets the field move 2–7 ticks first so commit-time re-instantiation is exercised.
      pendingUntil = spec.policy === "cycle" ? t : t + user.int(2, 8);
    }
    if (session.active && t >= pendingUntil) {
      const m = session.active;
      const n = seq++;
      if (n % 5 === 4) recordCommit("timeout", m, null, timeout(session, state));
      else {
        const pick = m.options[n % m.options.length]!;
        recordCommit("commit", m, pick.id, commit(session, state, pick.id));
      }
    }
    collectSettled();
    tick(state);
  }
  observe(session, state);
  collectSettled();
  samples.push(sample(state));

  const events = state.events.map(eventLine);
  if (process.env.SM_FIXTURE_TRACE) writeFileSync(process.env.SM_FIXTURE_TRACE, trace.join("\n"));
  return {
    seed: spec.seed,
    role: spec.role,
    policy: spec.policy,
    four: spec.four,
    quality: 55,
    controlledId: me.id,

    sampleEveryTickUntil: SAMPLE_EVERY_TICK_UNTIL,
    sampleStride: SAMPLE_STRIDE,
    samples,
    events,
    moments,
    commits,
    settled,
    rejects: session.rejects,
    final: { tick: state.clock.tick, home: state.score.home, away: state.score.away, events: state.events.length, rng: state.rngState, records: session.records.length, open: session.open.length },
  };
}

const t0 = Date.now();
const runs = RUNS.filter((r) => !SEED_FILTER || SEED_FILTER.has(r.seed)).map((r) => {
  const out = runOne(r);
  console.log(`seed ${r.seed} ${r.role} ${r.policy}${r.four ? " four" : ""}: ${out.final.home}-${out.final.away}, ${out.moments.length} moments, ${out.commits.length} commits, ${out.settled.length} settled, ${out.events.length} events, ${out.samples.length} samples`);
  return out;
});
const fixture = {
  generator: "tools/nativeTacticsFixtures.ts",
  catalog: { path: "content/catalog/provisional-u11.json", id: (catalogJson as CatalogFile).id, version: (catalogJson as CatalogFile).version, entries: (catalogJson as CatalogFile).entries.length },
  runs,
};
const text = JSON.stringify(fixture);
if (/\bnull\b/.test(JSON.stringify(runs.flatMap((r) => r.moments.map((m) => m.read))))) throw new Error("non-finite feature value in a field read");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
mkdirSync(dirname(CATALOG_OUT), { recursive: true });
if (!process.env.SM_FIXTURE_OUT) writeFileSync(CATALOG_OUT, JSON.stringify(catalogJson));
console.log(`wrote ${OUT} (${(text.length / 1024).toFixed(0)} KiB) in ${Date.now() - t0} ms; catalog copied to ${CATALOG_OUT}`);
