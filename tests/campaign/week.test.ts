import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { standings } from "../../src/calendar/competitions";
import { mondayOf, weekday } from "../../src/calendar/date";
import { advanceDays, currentLeagueId, eligibilityPreview, FRIEND_ID, fixturesFor, PLAYER_ID, scheduleWeek } from "../../src/campaign/campaign";
import { campaignMatchConfig, completeCampaignMatch, fixtureById, MATCH_FACTS, reportFromRuntime, weekAttendance } from "../../src/campaign/match";
import {
  abandonPending,
  cancelPending,
  completeCrossbar,
  completeHomeSkill,
  completeMatch,
  completeTraining,
  CROSSBAR_DAY_FACT,
  FATIGUE,
  fatigue,
  inRegularWeek,
  isTired,
  MISSED_FACTS,
  slotActions,
  takeAction,
  trainingActivity,
  weekView,
} from "../../src/campaign/week";
import { createRuntime } from "../../src/match/runtime";
import { playToFullTime } from "../helpers";
import { playedIn, resultFor } from "../../src/match/report";
import { resumeSession } from "../../src/app/session";
import { MemoryStore } from "../../src/save/save";
import { sceneVars, takeQueuedScene, viewScene } from "../../src/story/flow";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { pacingFor } from "../../src/tactics/recognition";
import { ROLE_BY_NUMBER } from "../../src/sim/types";
import { createChallenge, friendShoots, shoot, summarize as sumCrossbar } from "../../src/training/crossbar";
import { assignmentById, nextAssignment, practised, report, revisit, selfReportedMinutes, stageOf, watchDemonstration } from "../../src/training/homeSkill";
import { bestOf, createDrill, runHeadless, summarize, type Summary } from "../../src/training/smallSided";
import { drainScenes, joinedSession } from "./joined";

const catalog = loadCatalog(catalogJson as CatalogFile);

/** What the hub does on mount: surface any due queued scene and play it through. */
const hub = (s: ReturnType<typeof joinedSession>): string[] => {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 10 && (s.campaign.scene || takeQueuedScene(s.campaign, s.scenes))) seen.push(...drainScenes(s));
  return seen;
};

/** Take immediate actions until the current slot offers `id` (or the day changes `maxSlots` times). */
function reach(s: ReturnType<typeof joinedSession>, id: string, maxSlots = 60): void {
  const c = s.campaign;
  for (let i = 0; i < maxSlots; i++) {
    hub(s);
    const acts = slotActions(c);
    if (acts.some((a) => a.id === id)) return;
    const pick = acts.find((a) => !a.launch) ?? acts[0]!;
    const r = takeAction(c, pick.id);
    if (!r.ok) throw new Error(r.reason);
  }
  throw new Error(`never reached ${id}`);
}

const bestPolicy = (_d: unknown, o: readonly { id: string; score: number }[]) => ({ optionId: bestOf(o as never).id, accuracy: 0.85 });

function playTraining(s: ReturnType<typeof joinedSession>): Summary {
  const c = s.campaign;
  const r = takeAction(c, "train");
  if (!r.ok || !r.launch || r.launch.kind !== "training") throw new Error("training not launched");
  expect(c.pending).toEqual(r.launch);
  const d = runHeadless(createDrill(r.launch.activity, c.seed ^ c.day, { reps: 4 }), bestPolicy);
  const summary = summarize(d);
  completeTraining(c, summary);
  return summary;
}

describe("regular week: calendar and slot actions", () => {
  it("joining schedules the week — three trainings, school every weekday — and rescheduling is idempotent", () => {
    const s = joinedSession();
    const c = s.campaign;
    expect(inRegularWeek(c)).toBe(true);
    const monday = mondayOf(c.day);
    const before = c.schedule.commitments.length;
    scheduleWeek(c, monday);
    expect(c.schedule.commitments.length).toBe(before);
    const week = c.schedule.commitments.filter((k) => k.day >= monday && k.day < monday + 7);
    expect(week.every((k) => k.day >= c.day)).toBe(true);
    expect(week.filter((k) => k.kind === "training").every((k) => ["Tue", "Thu", "Fri"].includes(weekday(k.day)))).toBe(true);
    expect(new Set(week.map((k) => `${k.day}:${k.slot}`)).size).toBe(week.length);

    const nextMonday = monday + 7;
    advanceDays(c, nextMonday - c.day);
    const full = c.schedule.commitments.filter((k) => k.day >= nextMonday && k.day < nextMonday + 7);
    expect(full.filter((k) => k.kind === "training").map((k) => weekday(k.day))).toEqual(["Tue", "Thu", "Fri"]);
    expect(full.filter((k) => k.kind === "school")).toHaveLength(5);
    expect(full.filter((k) => k.kind === "match").map((k) => weekday(k.day))).toEqual(["Sat"]);
    scheduleWeek(c, nextMonday);
    expect(c.schedule.commitments.filter((k) => k.day >= nextMonday && k.day < nextMonday + 7)).toEqual(full);
  });

  it("the three trainings in a week are three different activities and rotate week to week", () => {
    const mon = 7 * 10;
    const w1 = [mon + 1, mon + 3, mon + 4].map(trainingActivity);
    const w2 = [mon + 8, mon + 10, mon + 11].map(trainingActivity);
    expect(new Set(w1).size).toBe(3);
    expect(w1).not.toEqual(w2);
    expect(new Set(w2).size).toBe(3);
  });

  it("school slots allow only school; the phone (friend) is unavailable there; training slots offer train or skip", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "school");
    const school = slotActions(c);
    expect(school[0]!.id).toBe("school");
    expect(school.every((a) => a.commitmentId === school[0]!.commitmentId)).toBe(true);
    expect(school.map((a) => a.id)).not.toContain("friend_crossbar");
    reach(s, "train");
    const ids = slotActions(c).map((a) => a.id);
    expect(ids).toContain("train");
    expect(ids).toContain("skip_training");
    expect(ids).not.toContain("friend_crossbar");
  });

  it("training counts as verified evidence and attends the commitment; rest is a real alternative that lowers fatigue", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "train");
    const k = slotActions(c).find((a) => a.id === "train")!.commitmentId!;
    const f0 = fatigue(c);
    const summary = playTraining(s);
    expect(c.pending).toBeNull();
    expect(c.schedule.commitments.find((x) => x.id === k)!.status).toBe("attended");
    expect(c.progression.verified[`train_${summary.activityId}`]).toBe(summary.reps);
    expect(c.progression.verified["train_reads_strong"]).toBe(summary.decisions.strong);
    expect(fatigue(c)).toBe(f0 + FATIGUE.training);
    reach(s, "rest");
    const f1 = fatigue(c);
    takeAction(c, "rest");
    expect(fatigue(c)).toBe(Math.max(0, f1 + FATIGUE.rest));
  });

  it("skipping training marks it missed now and the coach follows up next day with the right weekday", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "train");
    const day = c.day;
    const k = slotActions(c).find((a) => a.id === "skip_training")!.commitmentId!;
    const r = takeAction(c, "skip_training");
    expect(r.ok).toBe(true);
    expect(c.schedule.commitments.find((x) => x.id === k)!.status).toBe("missed");
    expect(c.story.facts[MISSED_FACTS.recent]).toBe(true);
    expect(c.story.facts[MISSED_FACTS.count]).toBe(1);
    expect(c.story.queuedScenes.some((q) => q.sceneId === "week.missed_followup" && q.onDay === day + 1)).toBe(true);
    expect(c.story.knowledge["coach"]?.includes(MISSED_FACTS.recent)).toBe(true);
    const seen: string[] = [];
    let guard = 0;
    while (!seen.includes("week.missed_followup") && guard++ < 12) {
      if (!c.scene && !takeQueuedScene(c, s.scenes)) {
        const acts = slotActions(c);
        takeAction(c, (acts.find((a) => !a.launch) ?? acts[0]!).id);
        continue;
      }
      if (c.scene === "week.missed_followup") {
        expect(c.day).toBe(day + 1);
        expect(sceneVars(c)["missed_day"]).toBe(weekday(day));
      }
      seen.push(...drainScenes(s));
    }
    expect(seen).toContain("week.missed_followup");
  });

  it("walking out of training abandons it: the commitment is missed and the slot ends", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "train");
    const k = slotActions(c).find((a) => a.id === "train")!.commitmentId!;
    takeAction(c, "train");
    expect(cancelPending(c)).toBe(false);
    const end = abandonPending(c);
    expect(end).not.toBeNull();
    expect(c.pending).toBeNull();
    expect(c.schedule.commitments.find((x) => x.id === k)!.status).toBe("missed");
  });

  it("weekView covers Monday to Sunday with the current slot marked and commitments in their slots", () => {
    const s = joinedSession();
    const c = s.campaign;
    const view = weekView(c);
    expect(view.map((d) => d.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(view.filter((d) => d.slots.some((x) => x.current))).toHaveLength(1);
    const fri = view.find((d) => d.weekday === "Fri")!;
    expect(fri.slots.find((x) => x.slot === "afternoon")!.commitment?.kind).toBe("training");
    expect(fri.slots.find((x) => x.slot === "school")!.commitment?.kind).toBe("school");
    expect(view[5]!.slots).toHaveLength(3);
    expect(view[0]!.slots.every((x) => x.past)).toBe(true);
  });
});

describe("regular week: optional activities", () => {
  it("the crossbar challenge is optional, once a day, cancellable, and never soccer-training evidence", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "friend_crossbar");
    const before = { ...c.progression.verified };
    const rel = c.progression.relationships[FRIEND_ID] ?? 0;
    takeAction(c, "friend_crossbar");
    expect(c.pending).toEqual({ kind: "crossbar" });
    expect(cancelPending(c)).toBe(true);
    expect(slotActions(c).some((a) => a.id === "friend_crossbar")).toBe(true);
    takeAction(c, "friend_crossbar");
    const ch = createChallenge(c.seed ^ (c.day * 17));
    const replay = createChallenge(c.seed ^ (c.day * 17));
    while (ch.turn) {
      if (ch.turn === "you") {
        shoot(ch, { x: 6, y: 2 }, 0.8);
        shoot(replay, { x: 6, y: 2 }, 0.8);
      } else {
        friendShoots(ch);
        friendShoots(replay);
      }
    }
    expect(ch.attempts).toEqual(replay.attempts);
    expect(ch.attempts).toHaveLength(10);
    const day = c.day;
    completeCrossbar(c, sumCrossbar(ch));
    expect(c.story.facts[CROSSBAR_DAY_FACT]).toBe(day);
    expect(c.progression.verified).toEqual(before);
    expect(c.progression.relationships[FRIEND_ID] ?? 0).toBeGreaterThan(rel);
    if (c.day === day) expect(slotActions(c).some((a) => a.id === "friend_crossbar")).toBe(false);
  });

  it("home practice walks watch → practise → report → revisit, keeps minutes self-reported, and never invents a video", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "home_skill");
    const a = nextAssignment(c)!;
    expect(a.demonstration.url).toBeNull();
    expect(a.demonstration.approved).toBe(false);
    expect(stageOf(c, a.id)).toBe("watch");
    const r = takeAction(c, "home_skill");
    expect(r.ok && r.launch?.kind === "home_skill" && r.launch.assignmentId === a.id).toBe(true);
    expect(cancelPending(c)).toBe(true);
    expect(slotActions(c).some((x) => x.id === "home_skill")).toBe(true);

    const verified = { ...c.progression.verified };
    takeAction(c, "home_skill");
    completeHomeSkill(c, watchDemonstration(c, a.id));
    expect(stageOf(c, a.id)).toBe("practise");
    reach(s, "home_skill");
    takeAction(c, "home_skill");
    completeHomeSkill(c, practised(c, a.id, 15));
    expect(selfReportedMinutes(c, a.skill)).toBe(15);
    expect(c.progression.verified).toEqual(verified);
    reach(s, "home_skill");
    takeAction(c, "home_skill");
    completeHomeSkill(c, report(c, a.id, a.observations[0]!.id));
    expect(c.story.facts["practised_at_home"]).toBe(true);
    reach(s, "home_skill");
    takeAction(c, "home_skill");
    const rv = revisit(c, a.id)!;
    expect(rv.text).toBe(assignmentById(a.id)!.revisit);
    completeHomeSkill(c, rv.effects);
    expect(stageOf(c, a.id)).toBe("done");
    expect(nextAssignment(c)?.id).not.toBe(a.id);
    expect(c.progression.verified).toEqual(verified);
  });

  it("stacking training and matches makes you tired, which narrows the training window and is visible in the hub", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "train");
    expect(isTired(c)).toBe(false);
    expect(slotActions(c).find((a) => a.id === "train")!.detail).not.toMatch(/tired/);
    c.story.facts["fatigue"] = FATIGUE.max - 1;
    expect(isTired(c)).toBe(true);
    expect(slotActions(c).find((a) => a.id === "train")!.detail).toMatch(/tired/);
  });
});

describe("regular week: campaign match through the runtime", () => {
  it("starts from the roster with the player controlled in their locked position, persists the report, ingests once, and grounds the postgame", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "play_match");
    const r = takeAction(c, "play_match");
    if (!r.ok || !r.launch || r.launch.kind !== "match") throw new Error("match not launched");
    const fixture = fixtureById(c, r.launch.fixtureId);
    expect(fixture.result).toBeNull();

    const cfg = campaignMatchConfig(c, fixture);
    const mine = cfg.controlled!.side === "home" ? cfg.home.squad : cfg.away.squad;
    const me = mine.find((p) => p.id === PLAYER_ID)!;
    expect(me.role).toBe(c.player.position);
    expect(me.name).toBe(c.player.name);
    expect(mine.some((p) => p.id === FRIEND_ID)).toBe(true);
    expect(mine).toHaveLength(9);
    const names = c.roster.people.filter((p) => p.clubId === "batavia").map((p) => p.name);
    expect(mine.filter((p) => !p.id.includes("-pool-")).every((p) => names.includes(p.name))).toBe(true);

    const rt = createRuntime(cfg, catalog, { pacing: pacingFor(ROLE_BY_NUMBER[c.player.position]) });
    playToFullTime(rt);
    expect(rt.state.players.find((p) => p.id === PLAYER_ID)!.role).toBe(c.player.position);
    const rep = reportFromRuntime(rt, fixture);
    expect(rep.finished).toBe(true);
    expect(rep.fixtureId).toBe(fixture.id);
    expect(rep.moments.total).toBe(rt.session.records.length);

    const before = c.reports.length;
    const done = completeMatch(c, rep);
    expect(done.match.ok).toBe(true);
    expect(done.match.ok && !done.match.duplicate).toBe(true);
    expect(c.reports).toHaveLength(before + 1);
    expect(c.pending).toBeNull();
    expect(fixtureById(c, fixture.id).result).toMatchObject({ homeGoals: rep.score.home, awayGoals: rep.score.away, eventId: rep.eventId });
    const table = standings(c.competitions, currentLeagueId(c)!, c.day);
    expect(table.find((row) => row.clubId === "batavia")!.played).toBe(fixture.kind === "league" ? 1 : 0);

    expect(() => completeMatch(c, rep)).toThrow(/no match pending/);
    const again = completeCampaignMatch(c, rep);
    expect(again.ok && again.duplicate).toBe(true);
    expect(c.reports).toHaveLength(before + 1);
    const queuedPostgame = c.story.queuedScenes.filter((q) => q.sceneId === "week.postgame").length + (c.scene === "week.postgame" ? 1 : 0);
    expect(queuedPostgame).toBe(1);

    const side = cfg.controlled!.side;
    expect(c.story.facts[MATCH_FACTS.result]).toBe(resultFor(rep, side));
    expect(c.story.facts[MATCH_FACTS.friendPlayed]).toBe(playedIn(rep, FRIEND_ID));
    expect(c.story.facts[MATCH_FACTS.moments]).toBe(rep.moments.total);
    if (rep.moments.total === 0) expect(c.story.facts[MATCH_FACTS.reads]).toBe("none");

    // the coach's word comes before the postgame and is grounded in this week's attendance
    expect(c.story.facts[MATCH_FACTS.weekTrained]).toBe(weekAttendance(c, c.day).attended);
    expect(c.story.facts[MATCH_FACTS.weekMissed]).toBe(weekAttendance(c, c.day).missed);
    expect(c.story.knowledge["coach"]).toContain(MATCH_FACTS.weekTrained);
    const seen = hub(s);
    expect(seen.indexOf("week.coach_word")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("week.coach_word")).toBeLessThan(seen.indexOf("week.postgame"));
    expect(seen).toContain("week.friend_after_match");
  });

  it("weekAttendance counts only training commitments in the seven days up to the match", () => {
    const s = joinedSession();
    const c = s.campaign;
    const day = c.day + 9;
    const k = (kind: "training" | "school" | "match", d: number, status: "attended" | "missed" | "scheduled") =>
      ({ id: `${kind}-${d}`, day: d, slot: "afternoon" as const, kind, title: kind, mandatory: true, refId: null, minutes: 60, status });
    c.schedule.commitments = [
      k("training", day - 7, "attended"),
      k("training", day - 6, "attended"),
      k("training", day - 2, "missed"),
      k("training", day, "scheduled"),
      k("training", day + 1, "attended"),
      k("school", day - 1, "attended"),
      k("match", day, "scheduled"),
    ];
    expect(weekAttendance(c, day)).toEqual({ attended: 1, missed: 1 });
  });

  it("a league fixture updates the table and the eligibility preview; the earlier friendly never did", () => {
    const s = joinedSession();
    const c = s.campaign;
    const league = fixturesFor(c, "batavia").find((f) => f.kind === "league")!;
    advanceDays(c, league.day - c.day);
    hub(s);
    const r = takeAction(c, "play_match");
    if (!r.ok || !r.launch || r.launch.kind !== "match") throw new Error("match not launched");
    expect(r.launch.fixtureId).toBe(league.id);
    const rt = createRuntime(campaignMatchConfig(c, league), catalog);
    playToFullTime(rt);
    const rep = reportFromRuntime(rt, league);
    const done = completeMatch(c, rep);
    expect(done.match.ok).toBe(true);
    const row = standings(c.competitions, league.competitionId, c.day).find((x) => x.clubId === "batavia")!;
    expect(row.played).toBe(1);
    const side = league.homeClubId === "batavia" ? "home" : "away";
    expect(row.points).toBe(resultFor(rep, side) === "win" ? 3 : resultFor(rep, side) === "draw" ? 1 : 0);
    expect(c.story.facts[MATCH_FACTS.kind]).toBe("league");
    expect(eligibilityPreview(c).length).toBeGreaterThan(0);
  });

  it("postgame lines never claim the friend played when the report says otherwise", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "play_match");
    const r = takeAction(c, "play_match");
    if (!r.ok || !r.launch || r.launch.kind !== "match") throw new Error("match not launched");
    const fixture = fixtureById(c, r.launch.fixtureId);
    const rt = createRuntime(campaignMatchConfig(c, fixture), catalog);
    playToFullTime(rt);
    const rep = reportFromRuntime(rt, fixture);
    const side = fixture.homeClubId === "batavia" ? "home" : "away";
    rep.participants[side] = rep.participants[side].filter((id) => id !== FRIEND_ID);
    rep.lines = rep.lines.filter((l) => l.playerId !== FRIEND_ID);
    expect(playedIn(rep, FRIEND_ID)).toBe(false);
    completeMatch(c, rep);
    expect(c.story.facts[MATCH_FACTS.friendPlayed]).toBe(false);
    takeQueuedScene(c, s.scenes);
    expect(c.scene).toBe("week.postgame");
    const v = viewScene(c, s.scenes)!;
    const friend = c.roster.people.find((p) => p.id === FRIEND_ID)!.name;
    const texts = v.lines.map((l) => l.text);
    expect(texts).not.toContain(`${friend} took that goal well.`);
    expect(texts).toContain(`Shame ${friend} wasn't out there with you.`);
  });
});

describe("regular week: save/resume and previews", () => {
  it("resuming mid-week restores slot, pending activity, commitments, reports and queued scenes", () => {
    const store = new MemoryStore();
    const s = joinedSession({}, store);
    const c = s.campaign;
    reach(s, "train");
    playTraining(s);
    reach(s, "home_skill");
    takeAction(c, "home_skill");
    s.save();
    const r = resumeSession(store)!;
    expect(r.campaign.day).toBe(c.day);
    expect(r.campaign.slot).toBe(c.slot);
    expect(r.campaign.pending).toEqual(c.pending);
    expect(r.campaign.schedule.commitments).toEqual(c.schedule.commitments);
    expect(r.campaign.progression.verified).toEqual(c.progression.verified);
    expect(r.campaign.story.queuedScenes).toEqual(c.story.queuedScenes);
    expect(r.campaign.reports).toEqual(c.reports);
    expect(slotActions(r.campaign)).toEqual([]);
    expect(cancelPending(r.campaign)).toBe(true);
    expect(slotActions(r.campaign).length).toBeGreaterThan(0);
  });

  it("the tournament-eligibility preview is available from the hub and the friendly does not count towards it", () => {
    const s = joinedSession();
    const c = s.campaign;
    const paths = eligibilityPreview(c);
    expect(paths.length).toBeGreaterThan(0);
    const friendly = fixturesFor(c, "batavia").find((f) => f.kind === "friendly");
    expect(friendly).toBeDefined();
    const leagueId = currentLeagueId(c)!;
    const table = standings(c.competitions, leagueId, c.day + 400);
    expect(table.every((row) => row.played === 0)).toBe(true);
    advanceDays(c, 1);
    expect(eligibilityPreview(c).map((p) => p.label)).toEqual(paths.map((p) => p.label));
  });
});
