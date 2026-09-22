/*
 * Engine-truth and soccer-accuracy review of one complete answer-only match (docs/ACCEPTANCE.md,
 * Review 1 / Review 2). Plays the real MatchRuntime for a role and seed with a scripted player, and
 * for every direct-involvement moment prints the frozen field, the question, every displayed answer
 * with its engine score and the exact command it maps to, the engine's own highest-scoring option,
 * the answer chosen, the command actually issued, the decision / execution / outcome records and the
 * event-ledger entries the outcome cites. Every claim is re-derived from the simulation state at the
 * frozen tick, and the tool exits non-zero on any of:
 *   - an answer that does not instantiate in the frozen state or maps to a different command;
 *   - the engine's best on-ball option missing without a documented exclusion;
 *   - the issued command differing from the chosen answer's command;
 *   - a decision grade influenced by the outcome (checked by re-grading in the frozen state);
 *   - an outcome citing an event that is not in the ledger or precedes the commit;
 *   - a timeout carrying a user grade or a user actor;
 *   - a clock or score that disagrees with the ledger; fewer than 12 or more than 18 moments.
 *
 * Usage: npx tsx tools/reviewMatch.ts [role=CM] [seed=2000] [player=typical|quick|slow|timeout] [policy=random|best|worst] [md]
 */
import catalogJson from "../content/catalog/provisional-u11.json";
import { intelligenceReport } from "../src/match/intelligence";
import { formatRealTime } from "../src/match/pace";
import { answer, frame, ready, totalRealMs, type MomentClosed } from "../src/match/runtime";
import { evaluateOnBall } from "../src/sim/ai";
import { isFinished } from "../src/sim/engine";
import { opponents, playerById, pressureAt, teammates } from "../src/sim/perception";
import { Rng } from "../src/sim/rng";
import { ROLE_BY_NUMBER, type MatchEvent, type MatchState, type PlayerCommand, type RoleId } from "../src/sim/types";
import { loadCatalog, type CatalogFile } from "../src/tactics/catalog";
import { isDocumentedExclusion } from "../src/tactics/exclusions";
import { gradeDecision } from "../src/tactics/grading";
import { instantiateIntent } from "../src/tactics/intents";
import type { TacticalMoment } from "../src/tactics/moments";
import { ANSWER_MS as MODEL_ANSWER_MS, paceRuntime, type PlayerModel } from "../src/perf/pace";
import { questionFor } from "../src/match/runtime";
import { DIRECT_RANGE } from "../src/tactics/recognition";

const role = (process.argv[2] ?? "CM") as RoleId;
const seed = Number(process.argv[3] ?? 2000);
const player = (process.argv[4] ?? "typical") as PlayerModel;
const policy = (process.argv[5] ?? "random") as "random" | "best" | "worst";
const md = process.argv.includes("md");
const FRAME_MS = 1000 / 60;

const catalog = loadCatalog(catalogJson as CatalogFile);
const { runtime, me } = paceRuntime(catalog, seed, role);
const user = new Rng(seed ^ 0x2b7e1516);

const fails: string[] = [];
// soccer-accuracy view: how the catalog's graded best compares with the engine's own best (informational)
let onBall = 0;
let agree = 0;
const wideGap: string[] = [];
const fail = (s: string): void => {
  fails.push(s);
};
const key = (c: PlayerCommand): string => JSON.stringify(c);
const clock = (state: MatchState): string => {
  const s = Math.floor(state.clock.timeMs / 1000);
  return `H${state.clock.half} ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const cloneState = (s: MatchState): MatchState => structuredClone(s);
const name = (state: MatchState, id: string | null | undefined): string => {
  if (!id) return "-";
  const p = state.players.find((q) => q.id === id);
  return p ? `${p.name} (${p.side === "home" ? "us" : "them"} ${ROLE_BY_NUMBER[p.role]})` : id;
};
const describe = (state: MatchState, c: PlayerCommand): string => {
  switch (c.type) {
    case "pass":
      return `pass → ${name(state, c.receiver)} @(${c.target.x.toFixed(1)},${c.target.y.toFixed(1)})`;
    case "carry":
      return `carry ${c.distance.toFixed(1)} m dir(${c.direction.x.toFixed(2)},${c.direction.y.toFixed(2)})`;
    case "shoot":
      return `shoot @(${c.target.x.toFixed(1)},${c.target.y.toFixed(1)})`;
    case "first_touch":
      return `first touch dir(${c.direction.x.toFixed(2)},${c.direction.y.toFixed(2)})`;
    case "move":
      return `move → (${c.target.x.toFixed(1)},${c.target.y.toFixed(1)})`;
    case "hold":
      return "hold";
    case "press":
      return `press ${name(state, c.target)}`;
    case "screen":
      return `screen ${name(state, c.from)} → ${name(state, c.to)}`;
  }
};
const eventLine = (state: MatchState, e: MatchEvent): string => {
  switch (e.type) {
    case "pass":
      return `pass ${name(state, e.from)} → ${name(state, e.to)} err ${e.error.toFixed(2)}`;
    case "receive":
      return `receive ${name(state, e.player)} from ${name(state, e.from)} ${e.clean ? "clean" : "loose"}`;
    case "carry":
      return `carry ${name(state, e.player)} (${e.from.x.toFixed(0)},${e.from.y.toFixed(0)})→(${e.to.x.toFixed(0)},${e.to.y.toFixed(0)})`;
    case "shot":
      return `shot ${name(state, e.player)} ${e.onTarget ? "on target" : "off target"} err ${e.error.toFixed(2)}`;
    case "save":
      return `save ${name(state, e.keeper)} from ${name(state, e.shooter)}`;
    case "goal":
      return `GOAL ${e.side} ${name(state, e.scorer)}${e.assist ? ` assist ${name(state, e.assist)}` : ""}`;
    case "interception":
      return `interception ${name(state, e.player)} from ${name(state, e.from)}`;
    case "recovery":
      return `recovery ${name(state, e.player)}`;
    case "tackle":
      return `tackle ${name(state, e.player)} on ${name(state, e.victim)} ${e.won ? "won" : "lost"}`;
    case "possession_change":
      return `possession → ${e.to} (${e.reason})`;
    case "out_of_play":
      return `out of play → ${e.restart} ${e.side}`;
    case "offside":
      return `offside ${name(state, e.player)}`;
    case "restart":
      return `${e.restart} ${e.side} taker ${name(state, e.taker)}`;
    case "kickoff":
      return `kickoff ${e.side}`;
    case "half_time":
      return "half time";
    case "full_time":
      return `full time ${e.home}-${e.away}`;
  }
};

interface Frozen {
  n: number;
  moment: TacticalMoment;
  state: MatchState;
  lines: string[];
  chosen: string | null;
}

const frozen: Frozen[] = [];
const closedRecords: MomentClosed[] = [];
let answerIn = -1;
let lastTick = -1;
let n = 0;
const out: string[] = [];
const h = (s: string): void => {
  out.push(md ? `\n### ${s}\n` : `\n=== ${s}`);
};
const li = (s: string): void => {
  out.push(md ? `- ${s}` : `  ${s}`);
};

for (let f = 0; f < 5_000_000 && !isFinished(runtime.state); f++) {
  const res = frame(runtime, FRAME_MS);
  if (runtime.state.clock.tick < lastTick) fail(`clock went backwards at frame ${f}`);
  lastTick = runtime.state.clock.tick;

  if (runtime.phase === "question" && runtime.active && !runtime.active.timerRunning) {
    // the screen has painted the question: inspect the frozen state, then start the timer
    const m = runtime.active.moment;
    const state = cloneState(runtime.state);
    n++;
    const p = playerById(state, m.playerId);
    const opps = opponents(state, p.side);
    const mates = teammates(state, p.side).filter((q) => q.id !== p.id);
    const near = opps.map((o) => ({ o, d: Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y) })).sort((a, b) => a.d - b.d).slice(0, 3);
    const lines: string[] = [];
    h(`Moment ${n} · ${clock(state)} · score ${state.score.home}-${state.score.away} · ${m.entryId} "${m.title}" [${m.category}/${m.phase}/${m.involvement}] difficulty ${m.difficulty.band} · tick ${state.clock.tick}`);
    li(`Frozen field: me ${p.name} (${ROLE_BY_NUMBER[p.role]}) at (${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}); ball ${state.ball.status}${state.ball.owner ? ` owner ${name(state, state.ball.owner)}` : ""}${state.ball.passFrom ? ` pass from ${name(state, state.ball.passFrom)}` : ""} at (${state.ball.pos.x.toFixed(1)}, ${state.ball.pos.y.toFixed(1)}); pressure ${pressureAt(p.pos, opps).toFixed(2)}; nearest opponents ${near.map((x) => `${ROLE_BY_NUMBER[x.o.role]} ${x.d.toFixed(1)} m`).join(", ")}`);
    li(`Read: hasBall ${m.read.hasBall} receiving ${m.read.receiving} pressure ${m.read.pressure.toFixed(2)} spaceAhead ${m.read.spaceAhead.toFixed(2)} spaceFarSide ${m.read.spaceFarSide.toFixed(2)} spaceNearSide ${m.read.spaceNearSide.toFixed(2)} progress ${m.read.progress.toFixed(2)} openLanes ${m.read.openLanes} progressiveLanes ${m.read.progressiveLanes} shotWindow ${(m.read.shotWindow * 57.3).toFixed(0)}° behindLine ${m.read.spaceBehindLine.toFixed(0)} m`);
    li(`Question: ${questionFor(m)}`);
    li(`Cues (shown): ${m.cues.join(" / ")}`);
    if (m.options.length < 3 || m.options.length > 6) fail(`moment ${n}: ${m.options.length} answers`);
    // engine's own view of the same frozen state
    const engine = m.read.hasBall === 1 ? evaluateOnBall(state, p) : [];
    const best = engine.length ? engine.reduce((a, b) => (b.score > a.score ? b : a)) : null;
    const shownKeys = new Set(m.options.map((o) => key(o.command)));
    for (const o of [...m.options].sort((a, b) => b.score - a.score)) {
      const inst = instantiateIntent(state, p, o.intent);
      let check = "ok";
      if (!inst) {
        check = "NOT AVAILABLE";
        fail(`moment ${n}: answer "${o.label}" does not instantiate in the frozen state`);
      } else if (key(inst.command) !== key(o.command)) {
        check = "COMMAND MISMATCH";
        fail(`moment ${n}: answer "${o.label}" re-instantiates to ${key(inst.command)} but displays ${key(o.command)}`);
      }
      const engineMatch = engine.find((e) => key(e.command) === key(o.command));
      li(`Answer ${o.id.split(":").pop()} "${o.label}" (${o.actionId}) → ${describe(state, o.command)} · score ${o.score.toFixed(2)} feasibility ${o.feasibility.toFixed(2)}${engineMatch ? ` · engine ${engineMatch.kind} ${engineMatch.score.toFixed(2)}` : ""} · ${check} · ${o.reasons.slice(0, 2).join("; ")}`);
    }
    if (best) {
      const shown = shownKeys.has(key(best.command));
      const excluded = !shown && isDocumentedExclusion(m.role, best.kind);
      const top = [...m.options].sort((a, b) => b.score - a.score)[0]!;
      const topEngine = engine.find((e) => key(e.command) === key(top.command));
      onBall++;
      if (key(top.command) === key(best.command)) agree++;
      else if (best.score - (topEngine?.score ?? -1) > 0.6) wideGap.push(`moment ${n}: graded best "${top.label}" (engine ${topEngine ? topEngine.score.toFixed(2) : "no such option"}) vs engine best ${best.kind} ${best.score.toFixed(2)}`);
      li(`Engine best (evaluateOnBall): ${best.kind} ${describe(state, best.command)} score ${best.score.toFixed(2)} · ${shown ? "SHOWN" : excluded ? "not shown — documented exclusion" : "MISSING"}`);
      if (!shown && !excluded) fail(`moment ${n}: engine best ${best.kind} ${key(best.command)} not among the answers`);
    } else {
      li(`Engine best: n/a (${m.read.receiving === 1 ? "ball arriving — first-touch decision" : "positioning decision"}; answers scored by scoreAction from the read)`);
    }
    frozen.push({ n, moment: m, state, lines, chosen: null });
    ready(runtime);
    answerIn = Number.isFinite(MODEL_ANSWER_MS[player]) ? Math.round(MODEL_ANSWER_MS[player] / FRAME_MS) : -1;
  }
  if (runtime.phase === "timer" && answerIn > 0 && --answerIn === 0) {
    const opts = runtime.active!.moment.options;
    const sorted = [...opts].sort((a, b) => b.score - a.score);
    const pick = policy === "best" ? sorted[0]! : policy === "worst" ? sorted[sorted.length - 1]! : opts[Math.floor(user.next() * opts.length)]!;
    frozen[frozen.length - 1]!.chosen = pick.id;
    answer(runtime, pick.id);
  }
  if (res.closed) {
    closedRecords.push(res.closed);
    const fz = frozen[frozen.length - 1]!;
    const rec = res.closed.record;
    const state = runtime.state;
    const d = rec.decision;
    const chosenOpt = fz.moment.options.find((o) => o.id === fz.chosen) ?? null;
    li(`Selected: ${fz.chosen ? `"${chosenOpt?.label}" (${chosenOpt?.actionId})` : "— (timer expired)"} · close reason ${res.closed.reason}`);
    li(`Decision: band ${d.band} quality ${d.quality === null ? "none" : d.quality.toFixed(2)} · best answer "${fz.moment.options.find((o) => o.id === d.bestOptionId)?.label ?? d.bestOptionId}" · graded at tick ${d.commitTick}`);
    for (const line of d.explanation) li(`  why: ${line}`);
    if (rec.acted) {
      li(`Issued: actor ${rec.acted.actor} · "${rec.acted.label}" → ${describe(fz.state, rec.acted.command)} at tick ${rec.acted.commitTick}`);
      if (res.closed.reason === "committed") {
        if (!chosenOpt) fail(`moment ${fz.n}: committed without a chosen option`);
        else if (key(chosenOpt.command) !== key(rec.acted.command)) fail(`moment ${fz.n}: UI chose ${key(chosenOpt.command)} but the engine executed ${key(rec.acted.command)}`);
        if (rec.acted.actor !== "user") fail(`moment ${fz.n}: committed answer attributed to ${rec.acted.actor}`);
        if (rec.acted.commitTick !== fz.state.clock.tick) fail(`moment ${fz.n}: committed at tick ${rec.acted.commitTick}, frozen at ${fz.state.clock.tick}`);
        // decision grade must be reproducible from the frozen state alone (outcome cannot influence it)
        const again = gradeDecision(fz.state, catalog, fz.moment, chosenOpt!.id);
        if (again.quality !== d.quality || again.band !== d.band || again.bestOptionId !== d.bestOptionId) fail(`moment ${fz.n}: decision grade not reproducible from the frozen state (${again.band} ${again.quality} vs ${d.band} ${d.quality})`);
      }
      if (res.closed.reason === "timeout") {
        if (d.quality !== null || d.band !== "timeout") fail(`moment ${fz.n}: timeout carries a user grade`);
        if (rec.acted.actor !== "engine") fail(`moment ${fz.n}: timeout action attributed to ${rec.acted.actor}`);
      }
    } else li("Issued: nothing (play stopped before the answer could be executed)");
    if (rec.execution) li(`Execution: actor ${rec.execution.actor} · ${rec.execution.band} (quality ${rec.execution.quality.toFixed(2)}, pressure ${rec.execution.pressureAtCommit.toFixed(2)}, fatigue ${rec.execution.fatigueAtCommit.toFixed(2)})`);
    if (rec.outcome) {
      li(`Outcome: ${rec.outcome.result} — ${rec.outcome.summary} (resolved tick ${rec.outcome.resolvedTick}, +${((rec.outcome.resolvedTick - d.commitTick) * 50) / 1000}s)`);
      for (const id of rec.outcome.eventIds) {
        const e = state.events.find((x) => x.id === id);
        if (!e) fail(`moment ${fz.n}: outcome cites event ${id} which is not in the ledger`);
        else {
          if (e.tick < d.commitTick) fail(`moment ${fz.n}: outcome cites event ${id} from before the commit`);
          li(`  ledger ${e.id} t${e.tick}: ${eventLine(state, e)}`);
        }
      }
      if (rec.outcome.eventIds.length === 0) li("  ledger: no events cited (outcome from ball/possession state)");
      // feedback must not invent an event: every claim in the summary needs a ledger entry (or ball ownership) behind it
      const cited = rec.outcome.eventIds.map((id) => state.events.find((x) => x.id === id)).filter((e): e is MatchEvent => e !== undefined);
      const s = rec.outcome.summary;
      const wasOnBall = fz.moment.read.hasBall === 1;
      if (/^(Held the ball|Carried|Took the touch)/.test(s) && !wasOnBall) fail(`moment ${fz.n}: outcome "${s}" claims a ball action but the player was off the ball`);
      if (/^Goal for your team/.test(s) && !cited.some((e) => e.type === "goal" && e.side === "home")) fail(`moment ${fz.n}: outcome claims a goal for with no goal event`);
      if (/^Goal conceded/.test(s) && !cited.some((e) => e.type === "goal" && e.side === "away")) fail(`moment ${fz.n}: outcome claims a goal against with no goal event`);
      if (/^Shot (saved|cleared|off target)/.test(s) && !cited.some((e) => e.type === "shot" && e.player === fz.moment.playerId)) fail(`moment ${fz.n}: outcome describes a shot the player did not take`);
      if (/^Pass (reached|intercepted)/.test(s) && !cited.some((e) => e.type === "pass" && e.from === fz.moment.playerId)) fail(`moment ${fz.n}: outcome describes a pass the player did not play`);
      if (/then passed/.test(s) && !cited.some((e) => e.type === "pass" && e.from === fz.moment.playerId)) fail(`moment ${fz.n}: outcome describes a pass the player did not play`);
      if (/^Ball won back/.test(s) && !cited.some((e) => e.type === "possession_change" && e.to === "home")) fail(`moment ${fz.n}: outcome claims a regain with no possession change`);
      if (/^You received the ball/.test(s) && !cited.some((e) => e.type === "receive" && e.player === fz.moment.playerId)) fail(`moment ${fz.n}: outcome claims a receive with no receive event`);
    }
    li(`Next state: ${clock(state)} · score ${state.score.home}-${state.score.away} · ball ${state.ball.status}${state.ball.owner ? ` with ${name(state, state.ball.owner)}` : ""} · possession ${state.possession ?? "-"}`);
    if (runtime.active?.feedback) for (const line of runtime.active.feedback) li(`Feedback shown: ${line}`);
  }
}

// ---------------------------------------------------------------- full-time truth
const st = runtime.state;
const goals = st.events.filter((e) => e.type === "goal");
const gh = goals.filter((e) => e.type === "goal" && e.side === "home").length;
const ga = goals.filter((e) => e.type === "goal" && e.side === "away").length;
if (gh !== st.score.home || ga !== st.score.away) fail(`scoreboard ${st.score.home}-${st.score.away} disagrees with ledger goals ${gh}-${ga}`);
const ft = st.events.find((e) => e.type === "full_time");
if (!ft || ft.type !== "full_time" || ft.home !== st.score.home || ft.away !== st.score.away) fail("full_time event missing or disagrees with the scoreboard");
const records = runtime.session.records;
if (records.length !== n) fail(`recorded ${records.length} moments, inspected ${n}`);
if (n < DIRECT_RANGE[0] || n > DIRECT_RANGE[1]) fail(`${n} moments outside ${DIRECT_RANGE[0]}–${DIRECT_RANGE[1]}`);
const myTouches = st.events.filter((e) => e.type === "receive" && e.player === me).length;
const report = intelligenceReport(st, records);

h(`Full time · ${clock(st)} · ${st.score.home}-${st.score.away} · ledger goals ${gh}-${ga} · ${st.events.length} events · ${n} moments · my receives in ledger ${myTouches} · real time ${formatRealTime(totalRealMs(runtime))}`);
li(`Result ${report.result.verified ? "verified" : "UNVERIFIED"}: ${report.result.forControlled ?? "n/a"} ${report.result.score.home}-${report.result.score.away} (ledger goals ${report.result.goalsInLedger})`);
li(`Overall decision: ${report.overall.band ?? "n/a"} ${report.overall.quality === null ? "" : report.overall.quality.toFixed(2)} (${report.answered} answered, ${report.timeouts} timeouts, ${report.engineActed} engine-acted)`);
li(`Strongest: ${report.strongest ? `${report.strongest.label} ${report.strongest.quality?.toFixed(2)}` : "n/a"} · weakest: ${report.weakest ? `${report.weakest.label} ${report.weakest.quality?.toFixed(2)}` : "n/a"}`);
for (const c of report.categories) li(`${c.label}: ${c.graded ? `${c.quality?.toFixed(2)} over ${c.graded} graded of ${c.moments} (best answer ${c.best}×)` : `${c.moments} moments, none graded`}`);
li(`Correct decisions that failed in execution: ${report.correctButFailed.length} · poor decisions with favourable outcomes: ${report.poorButFavorable.length}`);
li(`Coach Code: ${report.teachingPoint}`);
li(`Soccer accuracy: graded-best answer equals engine best in ${agree}/${onBall} on-ball moments; ${wideGap.length} with an engine gap > 0.6${wideGap.length ? ":" : ""}`);
for (const w of wideGap) li(`  ${w}`);
for (const r of records) {
  const mine = r.moment.options.find((o) => o.id === r.decision.chosenOptionId);
  li(`#${records.indexOf(r) + 1} ${r.moment.entryId} · answers ${r.moment.options.length} · chose ${mine ? `"${mine.label}"` : "—"} · decision ${r.decision.band}${r.decision.quality === null ? "" : ` ${r.decision.quality.toFixed(2)}`} · execution ${r.execution ? `${r.execution.actor}/${r.execution.band}` : "—"} · outcome ${r.outcome?.result ?? "—"}`);
}

console.log(out.join("\n"));
console.log(md ? `\n**Checks:** ${fails.length === 0 ? "all engine-truth checks passed" : fails.length + " FAILED"}` : `\nchecks: ${fails.length === 0 ? "PASS" : "FAIL"}`);
for (const f of fails) console.log(`  FAIL ${f}`);
if (fails.length) process.exitCode = 1;
