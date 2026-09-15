import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import packageJson from "../../package.json";
import { acceptResponse, AuthoredProvider, nextToken } from "../../src/ai/provider";
import { resumeSession } from "../../src/app/session";
import { ingestResult, stateQualification, tournamentEligibility, type Tournament } from "../../src/calendar/competitions";
import { currentLeagueId, eligibilityNow, fixturesFor, FRIEND_ID, PLAYER_ID } from "../../src/campaign/campaign";
import { campaignMatchConfig, completeCampaignMatch, fixtureById, MATCH_FACTS, reportFromRuntime } from "../../src/campaign/match";
import { abandonPending, completeMatch, completeTraining, slotActions, takeAction, weekView } from "../../src/campaign/week";
import { isCancelGesture } from "../../src/gesture/gesture";
import type { MatchReport } from "../../src/match/report";
import {
  cancel,
  createRuntime,
  frame,
  liveAnchor,
  previewGesture,
  releaseGesture,
  select,
  setAccessible,
  tapTarget,
  type MatchRuntime,
  type MomentClosed,
} from "../../src/match/runtime";
import { deserialize, MemoryStore, serialize } from "../../src/save/save";
import { createMatch } from "../../src/sim/engine";
import { playerById } from "../../src/sim/perception";
import { ROLE_BY_NUMBER } from "../../src/sim/types";
import { applyChoice, processDue } from "../../src/story/consequences";
import { chooseInScene, sceneVars, scopedChoice, takeQueuedScene, viewScene } from "../../src/story/flow";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { coverageReport } from "../../src/tactics/coverage";
import { createRecognizer, pacingFor, recognize } from "../../src/tactics/recognition";
import { bestOf, createDrill, runHeadless, summarize } from "../../src/training/smallSided";
import { testConfig } from "../helpers";
import { drainScenes, joinedSession } from "../campaign/joined";

/**
 * Spec §24 acceptance checks, one `it` per check, in order. Each check is exercised end to end
 * through the public campaign / match APIs; docs/ACCEPTANCE.md maps every check to this file, to
 * the supporting module tests, and (for 17 and 18) to the manual mobile procedure this file can only
 * pre-verify statically.
 */

const catalog = loadCatalog(catalogJson as CatalogFile);
const ROOT = join(__dirname, "..", "..");

type Joined = ReturnType<typeof joinedSession>;

function hub(s: Joined): string[] {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 10 && (s.campaign.scene || takeQueuedScene(s.campaign, s.scenes))) seen.push(...drainScenes(s));
  return seen;
}

function reach(s: Joined, id: string, maxSlots = 60): void {
  for (let i = 0; i < maxSlots; i++) {
    hub(s);
    const acts = slotActions(s.campaign);
    if (acts.some((a) => a.id === id)) return;
    const pick = acts.find((a) => !a.launch) ?? acts[0]!;
    const r = takeAction(s.campaign, pick.id);
    if (!r.ok) throw new Error(r.reason);
  }
  throw new Error(`never reached ${id}`);
}

const bestPolicy = (_d: unknown, o: readonly { id: string; score: number }[]) => ({ optionId: bestOf(o as never).id, accuracy: 0.85 });

function train(s: Joined): void {
  const r = takeAction(s.campaign, "train");
  if (!r.ok || !r.launch || r.launch.kind !== "training") throw new Error("training not launched");
  completeTraining(s.campaign, summarize(runHeadless(createDrill(r.launch.activity, s.campaign.seed ^ s.campaign.day, { reps: 4 }), bestPolicy)));
}

/** Run until a moment opens (or full time). */
function untilMoment(rt: MatchRuntime): boolean {
  for (let i = 0; i < 400_000; i++) {
    const r = frame(rt, 50);
    if (r.opened) return true;
    if (r.finished) return false;
  }
  throw new Error("no moment");
}

/** Play to full time answering every moment with the first option (tap alternative for drawn ones). */
function playToFullTime(rt: MatchRuntime, onFrame?: (rt: MatchRuntime) => void): MomentClosed[] {
  setAccessible(rt, true);
  rt.fast = true;
  const closed: MomentClosed[] = [];
  for (let i = 0; i < 2_000_000; i++) {
    const r = frame(rt, 1000);
    if (r.closed) closed.push(r.closed);
    if (r.opened) {
      const first = r.opened.options[0]!;
      const now = select(rt, first.id) ?? (rt.active ? tapTarget(rt, liveAnchor(rt, first) ?? rt.state.ball.pos) : null);
      if (now) closed.push(now);
    }
    onFrame?.(rt);
    if (r.finished) return closed;
  }
  throw new Error("match did not finish");
}

/** The campaign's next match: launch it, play it headless through the browser runtime, return the report. */
function playCampaignMatch(s: Joined): { report: MatchReport; fixtureId: string; closed: MomentClosed[]; rt: MatchRuntime } {
  const c = s.campaign;
  reach(s, "play_match");
  const r = takeAction(c, "play_match");
  if (!r.ok || !r.launch || r.launch.kind !== "match") throw new Error("match not launched");
  const fixture = fixtureById(c, r.launch.fixtureId);
  const rt = createRuntime(campaignMatchConfig(c, fixture), catalog, { pacing: pacingFor(ROLE_BY_NUMBER[c.player.position]) });
  const closed = playToFullTime(rt);
  return { report: reportFromRuntime(rt, fixture), fixtureId: fixture.id, closed, rt };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|json|css|html)$/.test(name)) out.push(p);
  }
  return out;
}

describe("spec §24 acceptance checks", () => {
  it("1. no dependency on the previous project exists", () => {
    const pkg = packageJson as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      expect(version, name).not.toMatch(/github|git\+|file:|link:/);
    }
    const files = ["src", "content", "tests", "tools", "public"].flatMap((d) => sourceFiles(join(ROOT, d)));
    files.push(join(ROOT, "index.html"), join(ROOT, "vite.config.ts"), join(ROOT, "package.json"));
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const rel = relative(ROOT, f);
      // the old repository, by URL or by package name, never appears in code or content
      expect(text, rel).not.toMatch(/codyengilman-max\/SoccerMaster(?!-RPG)/);
      expect(text, rel).not.toMatch(/from\s+["'](?:soccermaster|@soccermaster)/i);
      // every relative import resolves inside this repository
      const depth = rel.split("/").length - 1;
      for (const m of text.matchAll(/from\s+["']((?:\.\.\/)+)/g)) {
        expect(m[1]!.split("../").length - 1, `${rel}: ${m[0]}`).toBeLessThanOrEqual(depth);
      }
    }
  });

  it("2. the selected role remains locked throughout a match", () => {
    const s = joinedSession();
    const c = s.campaign;
    const position = c.player.position;
    let frames = 0;
    const { report, rt } = (() => {
      reach(s, "play_match");
      const r = takeAction(c, "play_match");
      if (!r.ok || !r.launch || r.launch.kind !== "match") throw new Error("match not launched");
      const fixture = fixtureById(c, r.launch.fixtureId);
      const rt = createRuntime(campaignMatchConfig(c, fixture), catalog);
      playToFullTime(rt, (x) => {
        frames++;
        const me = playerById(x.state, PLAYER_ID);
        expect(me.role).toBe(position);
        expect(x.state.controlled?.playerId).toBe(PLAYER_ID);
      });
      return { report: reportFromRuntime(rt, fixture), rt };
    })();
    expect(frames).toBeGreaterThan(100);
    expect(report.finished).toBe(true);
    expect(rt.session.records.every((m) => m.moment.role === ROLE_BY_NUMBER[position])).toBe(true);
    expect(c.player.position).toBe(position);
  });

  it("3. story characters map consistently to roster identities", () => {
    for (const kind of ["boys", "girls"] as const) {
      const s = joinedSession({ kind });
      const c = s.campaign;
      const friend = c.roster.people.find((p) => p.id === FRIEND_ID)!;
      const me = c.roster.people.find((p) => p.id === PLAYER_ID)!;
      expect(me.name).toBe(c.player.name);
      expect(sceneVars(c).friend).toBe(friend.name);
      const fixture = fixturesFor(c, "batavia")[0]!;
      const cfg = campaignMatchConfig(c, fixture);
      const mine = cfg.controlled!.side === "home" ? cfg.home.squad : cfg.away.squad;
      const meOnPitch = mine.find((p) => p.id === PLAYER_ID)!;
      const friendOnPitch = mine.find((p) => p.id === FRIEND_ID)!;
      expect(meOnPitch.name).toBe(me.name);
      expect(friendOnPitch.name).toBe(friend.name);
      for (const p of mine.filter((q) => !q.id.includes("-pool-"))) {
        const person = c.roster.people.find((q) => q.id === p.id)!;
        expect(person, p.id).toBeDefined();
        expect(person.name).toBe(p.name);
        expect(person.clubId).toBe("batavia");
      }
    }
  });

  it("4. slow motion advances the real simulation", () => {
    const s = joinedSession();
    const fixture = fixturesFor(s.campaign, "batavia")[0]!;
    const rt = createRuntime(campaignMatchConfig(s.campaign, fixture), catalog);
    expect(untilMoment(rt)).toBe(true);
    const w = rt.active!;
    const tick0 = rt.state.clock.tick;
    const ball0 = { ...rt.state.ball.pos };
    const others0 = rt.state.players.filter((p) => p.id !== w.moment.playerId).map((p) => ({ ...p.pos }));
    let ticks = 0;
    for (let i = 0; i < 6 && rt.active; i++) ticks += frame(rt, 100).ticks;
    expect(rt.active).toBe(w);
    expect(ticks).toBeGreaterThan(0);
    expect(rt.state.clock.tick).toBe(tick0 + ticks);
    // slow motion is fewer ticks per real millisecond, not a frozen world
    expect(ticks).toBeLessThan((600 / 1000) * 20);
    const moved =
      rt.state.players.filter((p) => p.id !== w.moment.playerId).some((p, i) => p.pos.x !== others0[i]!.x || p.pos.y !== others0[i]!.y) ||
      rt.state.ball.pos.x !== ball0.x ||
      rt.state.ball.pos.y !== ball0.y;
    expect(moved).toBe(true);
  });

  it("5. gesture commitment uses the current field state", () => {
    const s = joinedSession();
    const fixture = fixturesFor(s.campaign, "batavia")[0]!;
    const rt = createRuntime(campaignMatchConfig(s.campaign, fixture), catalog);
    let found = false;
    for (let guard = 0; guard < 40 && !found; guard++) {
      if (!untilMoment(rt)) break;
      const w = rt.active!;
      const drawn = w.moment.options.find((o) => o.drawn && o.receiver);
      if (!drawn) {
        select(rt, w.moment.options[0]!.id) ?? (rt.active && tapTarget(rt, rt.state.ball.pos));
        continue;
      }
      found = true;
      select(rt, drawn.id);
      expect(rt.active?.stage).toBe("drawing");
      const staleAnchor = { ...drawn.anchor! };
      const openTick = w.moment.tick;
      for (let i = 0; i < 8 && rt.active; i++) frame(rt, 100);
      expect(rt.active).toBe(w);
      const me = playerById(rt.state, w.moment.playerId);
      const live = liveAnchor(rt, drawn)!;
      const closed = releaseGesture(rt, [me.pos, { x: (me.pos.x + live.x) / 2, y: (me.pos.y + live.y) / 2 }, live])!;
      expect(closed.reason).toBe("committed");
      expect(closed.record.decision.commitTick).toBe(rt.state.clock.tick);
      expect(closed.record.decision.commitTick).toBeGreaterThan(openTick);
      // the receiver's live position is the reference, not the snapshot taken when the moment opened
      const receiver = playerById(rt.state, drawn.receiver!);
      expect(live).toEqual(receiver.pos);
      if (live.x !== staleAnchor.x || live.y !== staleAnchor.y) {
        expect(closed.record.execution!.intentAccuracy).toBeGreaterThan(0.9);
      }
    }
    expect(found).toBe(true);
  });

  it("6. choice and drawing count as one tactical moment", () => {
    const s = joinedSession();
    const fixture = fixturesFor(s.campaign, "batavia")[0]!;
    const rt = createRuntime(campaignMatchConfig(s.campaign, fixture), catalog);
    let found = false;
    for (let guard = 0; guard < 40 && !found; guard++) {
      if (!untilMoment(rt)) break;
      const w = rt.active!;
      const drawn = w.moment.options.find((o) => o.drawn && o.anchor);
      if (!drawn) {
        select(rt, w.moment.options[0]!.id) ?? (rt.active && tapTarget(rt, rt.state.ball.pos));
        continue;
      }
      found = true;
      const records = rt.session.records.length;
      expect(select(rt, drawn.id)).toBeNull();
      expect(rt.session.records).toHaveLength(records);
      const me = playerById(rt.state, w.moment.playerId);
      const to = liveAnchor(rt, drawn)!;
      expect(previewGesture(rt, [me.pos, to])).not.toBeNull();
      expect(rt.session.records).toHaveLength(records);
      const closed = releaseGesture(rt, [me.pos, to])!;
      expect(rt.session.records).toHaveLength(records + 1);
      expect(closed.record.moment.id).toBe(w.moment.id);
      expect(closed.record.decision.chosenOptionId).toBe(drawn.id);
      expect(closed.record.execution!.intentAccuracy).toBeGreaterThan(0.9);
      expect(rt.active).toBeNull();
    }
    expect(found).toBe(true);
  });

  it("7. decision quality, execution and outcome remain separate", () => {
    const s = joinedSession();
    const { report, rt } = playCampaignMatch(s);
    const records = rt.session.records;
    expect(records.length).toBeGreaterThan(5);
    for (const r of records) {
      expect(r.decision.momentId).toBe(r.moment.id);
      if (r.execution) expect(["clean", "loose", "poor"]).toContain(r.execution.band);
      if (r.outcome) expect(["success", "partial", "failure", "neutral"]).toContain(r.outcome.result);
    }
    const graded = records.filter((r) => r.decision.quality !== null && r.outcome);
    const bands = new Set(graded.map((r) => r.decision.band));
    const results = new Set(graded.map((r) => r.outcome!.result));
    // neither channel is a relabelling of the other
    const sameDecisionDifferentOutcome = graded.some((a) => graded.some((b) => a.decision.band === b.decision.band && a.outcome!.result !== b.outcome!.result));
    expect(sameDecisionDifferentOutcome || bands.size === 1 || results.size === 1).toBe(true);
    expect(report.moments.decisions.strong + report.moments.decisions.acceptable + report.moments.decisions.weak + report.moments.decisions.timeout + report.moments.decisions.intent_unavailable).toBe(report.moments.total);
    expect(Array.isArray(report.moments.goodReadPoorExecution)).toBe(true);
    expect(Array.isArray(report.moments.poorReadGoodOutcome)).toBe(true);
  });

  it("8. play continues from the actual outcome without resetting", () => {
    const s = joinedSession();
    const fixture = fixturesFor(s.campaign, "batavia")[0]!;
    const rt = createRuntime(campaignMatchConfig(s.campaign, fixture), catalog);
    let lastTick = -1;
    let lastEventCount = 0;
    let commits = 0;
    for (let i = 0; i < 2_000_000; i++) {
      const r = frame(rt, 200);
      expect(rt.state.clock.tick).toBeGreaterThanOrEqual(lastTick);
      expect(rt.state.events.length).toBeGreaterThanOrEqual(lastEventCount);
      lastTick = rt.state.clock.tick;
      lastEventCount = rt.state.events.length;
      if (r.opened) {
        const scoreBefore = { ...rt.state.score };
        const first = r.opened.options[0]!;
        setAccessible(rt, true);
        const closed = select(rt, first.id) ?? (rt.active ? tapTarget(rt, liveAnchor(rt, first) ?? rt.state.ball.pos) : null);
        if (closed) {
          commits++;
          const tickAtCommit = rt.state.clock.tick;
          const after = frame(rt, 200);
          expect(after.ticks).toBeGreaterThan(0);
          expect(rt.state.clock.tick).toBe(tickAtCommit + after.ticks);
          expect(rt.state.score.home).toBeGreaterThanOrEqual(scoreBefore.home);
          expect(rt.state.score.away).toBeGreaterThanOrEqual(scoreBefore.away);
        }
      }
      if (r.finished) break;
    }
    expect(commits).toBeGreaterThan(3);
    expect(rt.state.events.filter((e) => e.type === "kickoff").length).toBeGreaterThanOrEqual(2);
  });

  it("9. tactical triggers reject unsuitable states", () => {
    const uncontrolled = createMatch(testConfig(3));
    expect(recognize(uncontrolled, catalog, createRecognizer()).reject).toBe("no_controlled_player");
    const s = joinedSession();
    const fixture = fixturesFor(s.campaign, "batavia")[0]!;
    const state = createMatch(campaignMatchConfig(s.campaign, fixture));
    expect(state.phase.kind).not.toBe("open_play");
    expect(recognize(state, catalog, createRecognizer()).reject).toBe("not_open_play");
    const rt = createRuntime(campaignMatchConfig(s.campaign, fixture), catalog);
    expect(untilMoment(rt)).toBe(true);
    expect(recognize(rt.state, catalog, rt.session.recognizer).reject).toBe("moment_pending");
  });

  it("10. moment coverage and difficulty are measurable", () => {
    const s = joinedSession();
    const { rt } = playCampaignMatch(s);
    const pacing = pacingFor(ROLE_BY_NUMBER[s.campaign.player.position]);
    const rep = coverageReport(rt.session.records, pacing);
    expect(rep.total).toBe(rt.session.records.length);
    expect(rep.byDifficulty.easy + rep.byDifficulty.medium + rep.byDifficulty.hard).toBe(rep.total);
    expect(rep.byCategory.on_ball + rep.byCategory.off_ball + rep.byCategory.defending + rep.byCategory.transition).toBe(rep.total);
    expect(rep.uniqueEntries).toBeGreaterThan(0);
    expect(Array.isArray(rep.shortfalls)).toBe(true);
    if (rep.total < pacing.total[0]) expect(rep.shortfalls.some((x) => /moments/.test(x))).toBe(true);
    if (rep.total >= pacing.total[0] && rep.total <= pacing.total[1] && rep.onBall >= pacing.onBall[0]) {
      expect(rep.shortfalls.every((x) => !/only \d+ moments|exceeds target/.test(x))).toBe(true);
    }
  });

  it("11. saves preserve pending story consequences and competition records", () => {
    const store = new MemoryStore();
    const s = joinedSession({}, store);
    const c = s.campaign;
    const { report } = playCampaignMatch(s);
    completeMatch(c, report);
    if (!c.scene) takeQueuedScene(c, s.scenes);
    expect(c.scene).toBe("week.coach_word");
    const v = viewScene(c, s.scenes)!;
    const promise = v.choices.find((ch) => ch.id === "week.coach.own_it") ?? v.choices.find((ch) => ch.id === "week.coach.shrug")!;
    chooseInScene(c, s.scenes, promise.id);
    hub(s);
    const pendingBefore = c.story.pending.length;
    const appliedBefore = [...c.competitions.appliedEventIds];
    s.save();
    const r = resumeSession(store)!;
    expect(r.campaign.story.pending).toEqual(c.story.pending);
    expect(r.campaign.story.pending.length).toBe(pendingBefore);
    expect(r.campaign.story.queuedScenes).toEqual(c.story.queuedScenes);
    expect(r.campaign.story.promises).toEqual(c.story.promises);
    expect(r.campaign.competitions.appliedEventIds).toEqual(appliedBefore);
    expect(fixtureById(r.campaign, report.fixtureId!).result).toEqual(fixtureById(c, report.fixtureId!).result);
    expect(r.campaign.reports.map((x) => x.eventId)).toEqual(c.reports.map((x) => x.eventId));
    expect(r.campaign.schedule.commitments).toEqual(c.schedule.commitments);
    expect(r.campaign.progression).toEqual(c.progression);
    const file = deserialize(serialize(c, "auto"));
    expect(file.campaign).toEqual(c);
  });

  it("12. duplicate events cannot apply effects twice", () => {
    const s = joinedSession();
    const c = s.campaign;
    const { report } = playCampaignMatch(s);
    const done = completeMatch(c, report);
    expect(done.match.ok && !done.match.duplicate).toBe(true);
    const snapshot = JSON.stringify({ facts: c.story.facts, progression: c.progression, queued: c.story.queuedScenes, applied: c.competitions.appliedEventIds, reports: c.reports.length });
    const again = completeCampaignMatch(c, report);
    expect(again.ok && again.duplicate).toBe(true);
    expect(JSON.stringify({ facts: c.story.facts, progression: c.progression, queued: c.story.queuedScenes, applied: c.competitions.appliedEventIds, reports: c.reports.length })).toBe(snapshot);
    const dup = ingestResult(c.competitions, report.fixtureId!, { eventId: report.eventId, homeGoals: report.score.home, awayGoals: report.score.away });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe("duplicate_event");

    // story choices: the same scoped choice cannot apply its effects twice
    if (!c.scene) takeQueuedScene(c, s.scenes);
    const v = viewScene(c, s.scenes)!;
    const choice = v.choices[0]!;
    const scoped = scopedChoice(v.scene, choice, c.day);
    const first = chooseInScene(c, s.scenes, choice.id);
    expect(first.ok).toBe(true);
    expect(c.story.applied).toContain(scoped.id);
    const ctx = { story: c.story, progression: c.progression, day: c.day };
    const relBefore = { ...c.progression.relationships };
    const twice = applyChoice(ctx, scoped);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.reason).toBe("duplicate");
    expect(c.progression.relationships).toEqual(relBefore);
    // delayed consequences fire once
    const firedNow = processDue(ctx);
    const firedAgain = processDue(ctx);
    expect(firedAgain.filter((f) => firedNow.some((g) => g.key === f.key))).toEqual([]);
  });

  it("13. U11/U12 cannot enter either major national event", () => {
    const s = joinedSession();
    const c = s.campaign;
    const majors = c.competitions.tournaments.filter((t) => t.major);
    expect(majors.map((t) => t.id).sort()).toEqual(["lone-star", "pacific-wave"]);
    for (const age of ["U11", "U12"] as const) {
      c.ageGroup = age;
      const now = eligibilityNow(c);
      for (const t of majors) {
        const e = now.find((x) => x.tournamentId === t.id)!;
        expect(e.eligible).toBe(false);
        expect(e.reasons.some((r) => /before U13/.test(r))).toBe(true);
      }
    }
    // a perfect league record changes nothing
    const leagueId = currentLeagueId(c)!;
    for (const f of c.competitions.fixtures.filter((x) => x.competitionId === leagueId && (x.homeClubId === "batavia" || x.awayClubId === "batavia"))) {
      const home = f.homeClubId === "batavia";
      ingestResult(c.competitions, f.id, { eventId: `acc13-${f.id}`, homeGoals: home ? 3 : 0, awayGoals: home ? 0 : 3 });
    }
    for (const age of ["U11", "U12"] as const) {
      for (const t of majors) {
        const e = tournamentEligibility(c.competitions, t, { clubId: "batavia", ageGroup: age, leagueId, asOfDay: 10_000 });
        expect(e.eligible).toBe(false);
      }
      for (const t of c.competitions.tournaments.filter((x) => !x.major && x.requirement === "record_500")) {
        expect(tournamentEligibility(c.competitions, t, { clubId: "batavia", ageGroup: age, leagueId, asOfDay: 10_000 }).eligible).toBe(true);
      }
    }
  });

  it("14. state qualification uses league evidence available at the cutoff", () => {
    const s = joinedSession();
    const c = s.campaign;
    const leagueId = currentLeagueId(c)!;
    const mine = c.competitions.fixtures.filter((f) => f.competitionId === leagueId && (f.homeClubId === "batavia" || f.awayClubId === "batavia")).sort((a, b) => a.day - b.day);
    expect(mine.length).toBeGreaterThan(2);
    const cutoff = mine[1]!.day;
    const state: Tournament = { ...c.competitions.tournaments.find((t) => t.requirement === "state_qualification")!, cutoffDay: cutoff };
    const win = (f: (typeof mine)[number], ev: string) => {
      const home = f.homeClubId === "batavia";
      expect(ingestResult(c.competitions, f.id, { eventId: ev, homeGoals: home ? 2 : 0, awayGoals: home ? 0 : 2 }).ok).toBe(true);
    };
    const lose = (f: (typeof mine)[number], ev: string) => {
      const home = f.homeClubId === "batavia";
      expect(ingestResult(c.competitions, f.id, { eventId: ev, homeGoals: home ? 0 : 4, awayGoals: home ? 4 : 0 }).ok).toBe(true);
    };
    // the rest of the league plays its whole season (home wins), so later rounds exist as evidence
    for (const f of c.competitions.fixtures.filter((x) => x.competitionId === leagueId && !mine.includes(x))) {
      expect(ingestResult(c.competitions, f.id, { eventId: `acc14-${f.id}`, homeGoals: 1, awayGoals: 0 }).ok).toBe(true);
    }
    win(mine[0]!, "acc14-0");
    win(mine[1]!, "acc14-1");
    const atCutoff = stateQualification(c.competitions, leagueId, "batavia", state);
    expect(atCutoff.qualified).toBe(true);
    expect(atCutoff.snapshot.every((row) => row.played <= 2)).toBe(true);
    // Batavia then loses every remaining round; the decision taken at the cutoff does not move
    for (const f of mine.slice(2)) lose(f, `acc14-${f.id}`);
    const afterLosses = stateQualification(c.competitions, leagueId, "batavia", state);
    expect(afterLosses).toEqual(atCutoff);
    const lateCutoff = stateQualification(c.competitions, leagueId, "batavia", { ...state, cutoffDay: mine[mine.length - 1]!.day });
    expect(lateCutoff.qualified).toBe(false);
    // and the eligibility view never reads past the day the question is asked
    const early = tournamentEligibility(c.competitions, state, { clubId: "batavia", ageGroup: "U11", leagueId, asOfDay: mine[0]!.day - 1 });
    expect(early.eligible).toBe(false);
    expect(early.reasons.length).toBeGreaterThan(0);
  });

  it("15. different first-week commitments produce meaningfully different later interactions, with identical match scores", () => {
    // Two campaigns with the same seed, name and position: A attends every session and reports home
    // practice; B skips training. The match itself is the same deterministic fixture and report.
    const A = joinedSession();
    const B = joinedSession();
    const run = (s: Joined, attend: boolean) => {
      const c = s.campaign;
      for (let guard = 0; guard < 60; guard++) {
        hub(s);
        const acts = slotActions(c);
        if (acts.some((a) => a.id === "play_match")) break;
        if (acts.some((a) => a.id === "train")) {
          if (attend) train(s);
          else {
            const r = takeAction(c, "train");
            if (!r.ok) throw new Error(r.reason);
            abandonPending(c);
          }
          continue;
        }
        const pick = acts.find((a) => !a.launch) ?? acts[0]!;
        const r = takeAction(c, pick.id);
        if (!r.ok) throw new Error(r.reason);
      }
    };
    run(A, true);
    run(B, false);
    expect(A.campaign.day).toBe(B.campaign.day);
    const rA = takeAction(A.campaign, "play_match");
    const rB = takeAction(B.campaign, "play_match");
    if (!rA.ok || !rA.launch || rA.launch.kind !== "match" || !rB.ok || !rB.launch || rB.launch.kind !== "match") throw new Error("match not launched");
    expect(rA.launch.fixtureId).toBe(rB.launch.fixtureId);
    const fixture = fixtureById(A.campaign, rA.launch.fixtureId);
    const cfgA = campaignMatchConfig(A.campaign, fixture);
    const cfgB = campaignMatchConfig(B.campaign, fixture);
    expect(cfgB).toEqual(cfgA);
    const rt = createRuntime(cfgA, catalog);
    playToFullTime(rt);
    const report = reportFromRuntime(rt, fixture);
    completeMatch(A.campaign, report);
    completeMatch(B.campaign, report);
    expect(A.campaign.story.facts[MATCH_FACTS.score]).toBe(B.campaign.story.facts[MATCH_FACTS.score]);
    expect(A.campaign.story.facts[MATCH_FACTS.result]).toBe(B.campaign.story.facts[MATCH_FACTS.result]);
    expect(A.campaign.story.facts[MATCH_FACTS.weekMissed]).toBe(0);
    expect(B.campaign.story.facts[MATCH_FACTS.weekMissed]).toBeGreaterThan(0);

    // B was already pulled aside by the coach for missing; A never was.
    expect(B.campaign.story.facts["trainings_missed"]).toBeGreaterThan(0);
    expect(A.campaign.story.facts["trainings_missed"]).toBeUndefined();

    // Same scoreline, different coach conversation: A is offered the warm-up; B is asked to own the miss.
    if (!A.campaign.scene) takeQueuedScene(A.campaign, A.scenes);
    if (!B.campaign.scene) takeQueuedScene(B.campaign, B.scenes);
    expect(A.campaign.scene).toBe("week.coach_word");
    expect(B.campaign.scene).toBe("week.coach_word");
    const vA = viewScene(A.campaign, A.scenes)!;
    const vB = viewScene(B.campaign, B.scenes)!;
    expect(vA.lines.map((l) => l.text)).not.toEqual(vB.lines.map((l) => l.text));
    const idsA = vA.choices.map((ch) => ch.id);
    const idsB = vB.choices.map((ch) => ch.id);
    expect(idsA).toContain("week.coach.lead_warmup");
    expect(idsA).not.toContain("week.coach.own_it");
    expect(idsB).toContain("week.coach.own_it");
    expect(idsB).not.toContain("week.coach.lead_warmup");

    // The opportunity is real state, not just a line: A can take it and it is remembered.
    const took = chooseInScene(A.campaign, A.scenes, "week.coach.lead_warmup");
    expect(took.ok).toBe(true);
    expect(A.campaign.story.flags).toContain("lead_warmup");
    const owned = chooseInScene(B.campaign, B.scenes, "week.coach.own_it");
    expect(owned.ok).toBe(true);
    expect(B.campaign.story.pending.some((p) => p.delayedId === "attendance_checked")).toBe(true);
    expect(A.campaign.story.pending.some((p) => p.delayedId === "attendance_checked")).toBe(false);
    // relationships diverged for reasons unrelated to the score
    expect(A.campaign.progression.relationships["coach"]).not.toBe(B.campaign.progression.relationships["coach"]);
  });

  it("16. the prototype remains playable without AI", () => {
    const provider = new AuthoredProvider();
    expect(provider.available()).toBe(false);
    const req = { token: nextToken(), sceneId: "x", speakerId: "coach", authored: "Authored line.", revision: 1, approvedFacts: {}, choiceMeaning: null };
    const fallback = acceptResponse(req, null, 1);
    expect(fallback.ok).toBe(false);
    expect(fallback.text).toBe("Authored line.");
    // no source module reaches for a network or model API
    for (const f of sourceFiles(join(ROOT, "src"))) {
      const text = readFileSync(f, "utf8");
      const rel = relative(ROOT, f);
      expect(text, rel).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|openai|anthropic|api\.[a-z]+\.com/i);
    }
    // the whole opening and a week of play run under Node with no browser or network
    const s = joinedSession();
    reach(s, "train");
    train(s);
    reach(s, "play_match");
    expect(weekView(s.campaign).length).toBe(7);
  });

  it("17. drawing, cancellation and accessible alternatives function on mobile (static preconditions; manual procedure in docs/ACCEPTANCE.md)", () => {
    const pointer = readFileSync(join(ROOT, "src/gesture/pointer.ts"), "utf8");
    expect(pointer).toMatch(/pointerdown/);
    expect(pointer).toMatch(/pointermove/);
    expect(pointer).toMatch(/pointerup/);
    expect(pointer).toMatch(/pointercancel/);
    expect(pointer).not.toMatch(/mousedown|touchstart/);
    const css = readFileSync(join(ROOT, "src/ui/theme.css"), "utf8");
    expect(css).toMatch(/\.stage canvas\s*{[^}]*touch-action:\s*none/);
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    expect(html).toMatch(/name="viewport" content="width=device-width, initial-scale=1/);
    const screen = readFileSync(join(ROOT, "src/ui/matchScreen.ts"), "utf8");
    expect(screen).toMatch(/toggle accessible/);
    expect(screen).toMatch(/class="cancel"/);
    // cancel by dragging back to the origin; a second finger cancels via pointercancel
    expect(isCancelGesture([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0.2, y: 0.1 }])).toBe(true);
    expect(isCancelGesture([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 0 }])).toBe(false);
    // the runtime honours cancel and the tap alternative mid-moment
    const s = joinedSession();
    const fixture = fixturesFor(s.campaign, "batavia")[0]!;
    const rt = createRuntime(campaignMatchConfig(s.campaign, fixture), catalog);
    let checked = false;
    for (let guard = 0; guard < 40 && !checked; guard++) {
      if (!untilMoment(rt)) break;
      const w = rt.active!;
      const drawn = w.moment.options.find((o) => o.drawn && o.anchor);
      if (!drawn) {
        select(rt, w.moment.options[0]!.id) ?? (rt.active && tapTarget(rt, rt.state.ball.pos));
        continue;
      }
      checked = true;
      select(rt, drawn.id);
      const me = playerById(rt.state, w.moment.playerId);
      expect(releaseGesture(rt, [me.pos, { x: me.pos.x + 3, y: me.pos.y }, me.pos])).toBeNull();
      expect(rt.active).toBe(w);
      expect(w.stage).toBe("reading");
      select(rt, drawn.id);
      cancel(rt);
      expect(w.stage).toBe("reading");
      expect(rt.active).toBe(w);
      setAccessible(rt, true);
      select(rt, drawn.id);
      expect(w.stage).toBe("targeting");
      const closed = tapTarget(rt, liveAnchor(rt, drawn)!)!;
      expect(closed.reason).toBe("committed");
      expect(closed.record.execution!.intentAccuracy).toBeGreaterThan(0.9);
    }
    expect(checked).toBe(true);
  });

  it("18. tactical information remains readable during cinematic presentation (static preconditions; manual procedure in docs/ACCEPTANCE.md)", () => {
    const css = readFileSync(join(ROOT, "src/ui/theme.css"), "utf8");
    const rule = (selector: string): string => {
      const m = css.match(new RegExp(`${selector.replace(/[.\s]/g, (ch) => (ch === "." ? "\\." : "\\s+"))}\\s*{([^}]*)}`));
      if (!m) throw new Error(`no rule for ${selector}`);
      return m[1]!;
    };
    // the option panel is a solid, high-contrast surface, not text over moving grass
    expect(rule(".panel")).toMatch(/rgba\(6, 16, 31, 0\.9\d?\)/);
    expect(rule(".moment .title")).toMatch(/font-weight:\s*700/);
    // touch targets ≥ 44 CSS px (2.9rem ≈ 46px at 16px root)
    const minHeight = Number(rule(".option").match(/min-height:\s*([\d.]+)rem/)![1]);
    expect(minHeight * 16).toBeGreaterThanOrEqual(44);
    // the window bar and countdown stay legible over the pitch
    expect(rule(".window .left")).toMatch(/text-shadow/);
    // nothing in the theme shrinks match text below ~12px
    for (const m of css.matchAll(/font-size:\s*([\d.]+)rem/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0.75);
    // the HUD and panel are part of the match grid, never hidden while a moment is open
    expect(rule(".match")).toMatch(/grid-template-rows:\s*auto 1fr auto auto/);
    const screen = readFileSync(join(ROOT, "src/ui/matchScreen.ts"), "utf8");
    expect(screen).toMatch(/aria-live="polite"/);
    expect(screen).toMatch(/role="group" aria-label="tactical options"/);
    // every option a moment offers has a label to read and a reason to show
    const s = joinedSession();
    const fixture = fixturesFor(s.campaign, "batavia")[0]!;
    const rt = createRuntime(campaignMatchConfig(s.campaign, fixture), catalog);
    expect(untilMoment(rt)).toBe(true);
    const m = rt.active!.moment;
    expect(m.title.length).toBeGreaterThan(0);
    expect(m.cues.length).toBeGreaterThan(0);
    expect(m.options.length).toBeGreaterThanOrEqual(2);
    for (const o of m.options) expect(o.label.length).toBeGreaterThan(0);
  });
});
