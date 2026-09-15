import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import progressionJson from "../../content/rules/progression-u11.json";
import { resumeSession } from "../../src/app/session";
import { weekday } from "../../src/calendar/date";
import { advanceDays, CAST_ROLES, FRIEND_ID, PLAYER_ID, resolvePerson, storyContext, type CampaignKind } from "../../src/campaign/campaign";
import { MATCH_FACTS, nextStreak } from "../../src/campaign/match";
import { seasonPhase } from "../../src/campaign/season";
import { PARK_DAY_FACT, parkAvailable, slotActions, takeAction } from "../../src/campaign/week";
import { MemoryStore } from "../../src/save/save";
import {
  announceUnlocks,
  ARC_FACTS,
  arcScenes,
  CENTRAL_QUESTION,
  milestoneScenes,
  optionalScene,
  optionalScenesFor,
  planArc,
  unlockSceneId,
} from "../../src/story/arc";
import { knows, type Effect } from "../../src/story/consequences";
import { campaignScenes, chooseInScene, continueScene, enterScene, openRepairs, personName, takeQueuedScene, takeRepair, viewScene } from "../../src/story/flow";
import { adjustRelationship, createProgression, GRANTS, refreshUnlocks, TRACKS, UNLOCKS, unlockViews } from "../../src/story/progression";
import { LOCATIONS, sceneEligible, TONES, toneReport } from "../../src/story/scenes";
import { createDrill, runHeadless, summarize } from "../../src/training/firstTouch";
import { PARK_FACTS, recordFirstTouch } from "../../src/training/record";
import { drainScenes, joinedSession } from "../campaign/joined";

type S = ReturnType<typeof joinedSession>;
const KINDS: readonly CampaignKind[] = ["boys", "girls"];

/** What the hub does on mount: surface any due queued scene and play it through with first choices. */
function hub(s: S): string[] {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 20 && (s.campaign.scene || takeQueuedScene(s.campaign, s.scenes))) seen.push(...drainScenes(s));
  return seen;
}

/** Live to `day` answering scenes with first choices as they come. */
function liveTo(s: S, day: number): string[] {
  const seen: string[] = [];
  while (s.campaign.day < day) {
    seen.push(...hub(s));
    advanceDays(s.campaign, 1);
  }
  seen.push(...hub(s));
  return seen;
}

const fallStart = (s: S): number => s.campaign.competitions.leagues.find((l) => l.term === "fall")!.startDay;

/** Take immediate actions until the current slot offers `id`. */
function reach(s: S, id: string, maxSlots = 60): void {
  const c = s.campaign;
  for (let i = 0; i < maxSlots; i++) {
    hub(s);
    if (slotActions(c).some((a) => a.id === id)) return;
    const acts = slotActions(c);
    const pick = acts.find((a) => !a.launch && !a.sceneId) ?? acts[0]!;
    const r = takeAction(c, pick.id);
    if (!r.ok) throw new Error(r.reason);
  }
  throw new Error(`never reached ${id}`);
}

const effectsOf = (kind: CampaignKind): Effect[] =>
  arcScenes(kind).flatMap((sc) => sc.choices.flatMap((ch) => [...ch.immediate, ...ch.delayed.flatMap((d) => d.effects), ...ch.repair.flatMap((r) => r.effects)]));

describe("U11 arc content", () => {
  it("states the season's central question exactly as the spec does", () => {
    const spec = readFileSync("spec/SOCCERMASTER_RPG_STANDALONE_V1_1.md", "utf8");
    expect(spec).toContain(CENTRAL_QUESTION);
    expect(CENTRAL_QUESTION.startsWith("Can this new team become something worth believing in")).toBe(true);
  });

  it.each(KINDS)("%s: every arc scene is well-formed and every reference resolves", (kind) => {
    const s = joinedSession({ kind });
    const c = s.campaign;
    const all = campaignScenes(kind);
    const ids = new Set(all.map((x) => x.id));
    const rosterIds = new Set(c.roster.people.map((p) => p.id));
    for (const sc of arcScenes(kind)) {
      expect(LOCATIONS).toContain(sc.location);
      expect(TONES).toContain(sc.tone);
      expect(sc.reviewStatus).toBe("proposal");
      if (sc.next) expect(ids.has(sc.next)).toBe(true);
      if (sc.auto) expect(sc.once).toBe(true);
      if (sc.optional) expect(["lunch_spot", "car", "park"]).toContain(sc.location);
      for (const l of sc.lines) if (l.speaker && l.speaker !== PLAYER_ID) expect(rosterIds.has(resolvePerson(kind, l.speaker))).toBe(true);
      for (const ch of sc.choices) {
        if (ch.next) expect(ids.has(ch.next)).toBe(true);
        for (const r of ch.repair) for (const cancel of r.cancels) expect(ch.delayed.map((d) => d.id)).toContain(cancel);
        for (const e of [...ch.immediate, ...ch.delayed.flatMap((d) => d.effects), ...ch.repair.flatMap((r) => r.effects)]) {
          if (e.type === "queue_scene") expect(ids.has(e.sceneId)).toBe(true);
          if (e.type === "relationship" || e.type === "learn") expect(rosterIds.has(resolvePerson(kind, e.personId))).toBe(true);
        }
      }
    }
    const choiceIds = all.flatMap((sc) => sc.choices.map((ch) => ch.id));
    expect(new Set(choiceIds).size).toBe(choiceIds.length);
    expect(new Set(all.map((sc) => sc.id)).size).toBe(all.length);
  });

  it("authors an unlock scene for every explicit unlock rule", () => {
    for (const kind of KINDS) {
      const ids = new Set(arcScenes(kind).map((sc) => sc.id));
      for (const u of UNLOCKS) expect(ids.has(unlockSceneId(u.id))).toBe(true);
    }
  });

  it("covers school, lunch, car, park, home and training locations with milestones and optional interactions", () => {
    const scenes = arcScenes("boys");
    const locations = new Set(scenes.map((sc) => sc.location));
    for (const loc of ["school", "lunch_spot", "car", "park", "home", "training_field"]) expect(locations.has(loc as never)).toBe(true);
    const optional = optionalScenesFor("boys");
    expect(new Set(optional.map((sc) => sc.location))).toEqual(new Set(["lunch_spot", "car", "park"]));
    expect(milestoneScenes("boys").length).toBeGreaterThanOrEqual(10);
    expect(scenes.filter((sc) => sc.location === "training_field" || sc.location === "lunch_spot").length).toBeGreaterThan(0);
  });

  it("story never touches soccer attributes: no technical/physical track effects, only relationships, facts, knowledge and small authored tracks", () => {
    for (const kind of KINDS) {
      const tracks = effectsOf(kind).flatMap((e) => (e.type === "track" ? [e.track] : []));
      expect(tracks).not.toContain("technical");
      expect(tracks).not.toContain("physical");
      for (const e of effectsOf(kind)) expect(["relationship", "track", "set_fact", "clear_fact", "learn", "queue_scene", "promise", "deliver", "flag"]).toContain(e.type);
    }
  });

  it("boys' and girls' campaigns share the arc but differ where authored (keeper and family car)", () => {
    const boys = new Map(arcScenes("boys").map((sc) => [sc.id, sc]));
    const girls = new Map(arcScenes("girls").map((sc) => [sc.id, sc]));
    expect([...boys.keys()].sort()).toEqual([...girls.keys()].sort());
    const text = (sc: { lines: { text: string }[] }): string => sc.lines.map((l) => l.text).join("\n");
    for (const id of ["arc.keeper", "arc.holiday_car"]) expect(text(boys.get(id)!)).not.toBe(text(girls.get(id)!));
    expect(text(boys.get("arc.question")!)).toBe(text(girls.get("arc.question")!));
    expect(text(boys.get("arc.holiday_car")!)).toContain("Dad");
    expect(text(girls.get("arc.holiday_car")!)).toContain("Mom");
    const b = joinedSession({ kind: "boys" }).campaign;
    const g = joinedSession({ kind: "girls" }).campaign;
    for (const role of CAST_ROLES) {
      expect(personName(b, role)).not.toBe(role);
      expect(personName(g, role)).not.toBe(role);
      expect(personName(b, role)).not.toBe(personName(g, role));
    }
    expect(personName(b, "keeper")).toBe("Owen Petrakis");
    expect(personName(g, "keeper")).toBe("Rosa Delgado");
  });

  it("tone report covers all three editorial tones with everyday life the largest share", () => {
    for (const kind of KINDS) {
      const r = toneReport(arcScenes(kind));
      expect(r.total).toBe(arcScenes(kind).length);
      expect(r.share.everyday).toBeGreaterThan(0);
      expect(r.share.reward).toBeGreaterThan(0);
      expect(r.share.adversity).toBeGreaterThan(0);
      expect(r.share.everyday).toBeGreaterThan(r.share.reward);
      expect(r.share.everyday).toBeGreaterThan(r.share.adversity);
      expect(r.target).toEqual({ reward: 0.3, adversity: 0.15, everyday: 0.55 });
    }
  });
});

describe("arc planner", () => {
  it("queues nothing in preseason and one milestone per week once its evidence exists", () => {
    const s = joinedSession();
    const c = s.campaign;
    expect(seasonPhase(c)).toBe("preseason");
    expect(planArc(c)).toBeNull();
    expect(c.story.queuedScenes.filter((q) => q.sceneId.startsWith("arc."))).toEqual([]);

    liveTo(s, fallStart(s));
    expect(c.story.facts[ARC_FACTS.phase]).toBe("fall");
    expect(planArc(c)).toBeNull();
    c.story.facts[MATCH_FACTS.leaguePlayed] = 1;
    expect(planArc(c)).toBe("arc.question");
    const q = c.story.queuedScenes.find((x) => x.sceneId === "arc.question")!;
    expect(weekday(q.onDay!)).toBe("Wed");
    expect(q.onDay!).toBeGreaterThanOrEqual(c.day);
    c.story.facts[MATCH_FACTS.leaguePlayed] = 3;
    expect(planArc(c)).toBeNull();
    advanceDays(c, 7);
    expect(c.story.queuedScenes.some((x) => x.sceneId === "arc.sibling_rumour")).toBe(true);
  });

  it("milestones read the streak the player actually played: a run and a slump are mutually exclusive", () => {
    const s = joinedSession();
    const c = s.campaign;
    liveTo(s, fallStart(s));
    const run = arcScenes("boys").find((x) => x.id === "arc.run")!;
    const slump = arcScenes("boys").find((x) => x.id === "arc.slump")!;
    c.story.facts[MATCH_FACTS.streak] = 2;
    expect(sceneEligible(storyContext(c), run)).toBe(true);
    expect(sceneEligible(storyContext(c), slump)).toBe(false);
    c.story.facts[MATCH_FACTS.streak] = -2;
    expect(sceneEligible(storyContext(c), run)).toBe(false);
    expect(sceneEligible(storyContext(c), slump)).toBe(true);
    expect(nextStreak(0, "win")).toBe(1);
    expect(nextStreak(2, "win")).toBe(3);
    expect(nextStreak(2, "loss")).toBe(-1);
    expect(nextStreak(-1, "loss")).toBe(-2);
    expect(nextStreak(3, "draw")).toBe(0);
  });

  it("fixes the fall finish once fall is over and the winter reflection reads it", () => {
    const s = joinedSession();
    const c = s.campaign;
    const fall = c.competitions.leagues.find((l) => l.term === "fall")!;
    liveTo(s, fall.endDay + 1);
    expect(c.story.facts[ARC_FACTS.phase]).toBe("winter");
    const pos = c.story.facts[ARC_FACTS.fallPosition];
    expect(typeof pos).toBe("number");
    expect(pos as number).toBeGreaterThanOrEqual(1);
    enterScene(c, s.scenes, "arc.fall_table");
    const v = viewScene(c, s.scenes)!;
    const joined = v.lines.map((l) => l.text).join(" ");
    expect(joined).not.toContain("{fall_finish}");
    expect(joined).toMatch(/\d+(st|nd|rd|th)/);
    drainScenes(s);
  });

  it("announces an unlock through its authored scene exactly once", () => {
    const s = joinedSession();
    const c = s.campaign;
    liveTo(s, fallStart(s));
    hub(s);
    c.progression.relationships[FRIEND_ID] = 20;
    expect(refreshUnlocks(c.progression)).toContain("friend_park_sessions");
    expect(announceUnlocks(c)).toEqual([unlockSceneId("friend_park_sessions")]);
    expect(announceUnlocks(c)).toEqual([]);
    const seen = hub(s);
    expect(seen).toContain("unlock.friend_park_sessions");
    expect(c.story.queuedScenes.some((q) => q.sceneId === "unlock.friend_park_sessions")).toBe(false);
  });
});

describe("optional interactions", () => {
  it("lunch is offered from the school slot, enters its scene, moves the slot and then cools down", () => {
    const s = joinedSession();
    const c = s.campaign;
    liveTo(s, fallStart(s));
    reach(s, "lunch");
    const lunch = slotActions(c).find((a) => a.id === "lunch")!;
    expect(lunch.sceneId).toBe("arc.lunch.table");
    expect(lunch.commitmentId).toBe(slotActions(c).find((a) => a.id === "school")!.commitmentId);
    const day = c.day;
    const r = takeAction(c, "lunch");
    expect(r.ok).toBe(true);
    expect(c.scene).toBe("arc.lunch.table");
    expect(c.day === day ? c.slot !== "school" : true).toBe(true);
    const v = viewScene(c, s.scenes)!;
    expect(v.choices.length).toBeGreaterThan(0);
    expect(v.lines.every((l) => !l.text.includes("{"))).toBe(true);
    drainScenes(s);
    expect(optionalScene(c, "lunch_spot")).toBeNull();
    advanceDays(c, 7);
    expect(optionalScene(c, "lunch_spot")?.id).toBe("arc.lunch.table");
  });

  it("the family car ride is offered in the evening and at weekends; the honest conversation waits for the parent's trust", () => {
    const s = joinedSession();
    const c = s.campaign;
    liveTo(s, fallStart(s));
    reach(s, "car_ride");
    expect(["evening", "morning", "afternoon", "school"]).toContain(c.slot);
    const car = slotActions(c).find((a) => a.id === "car_ride")!;
    expect(car.sceneId).toBe("arc.car.errands");
    expect(optionalScene(c, "car")?.id).toBe("arc.car.errands");
    expect(takeAction(c, "car_ride").ok).toBe(true);
    expect(c.scene).toBe("arc.car.errands");
    expect(chooseInScene(c, s.scenes, "arc.car.errands.ask").ok).toBe(true);
    hub(s);
    expect(optionalScene(c, "car")).toBeNull();
    c.progression.relationships["parent"] = 20;
    c.progression.tracks.school = 65;
    refreshUnlocks(c.progression);
    expect(c.progression.unlocked).toContain("parent_trusts_you");
    expect(optionalScene(c, "car")?.id).toBe("arc.car.honest");
  });

  it("park sessions are a relationship unlock: gated, once a day, evenings only with the parent's trust, and a verified first-touch session the friend witnesses", () => {
    const s = joinedSession();
    const c = s.campaign;
    liveTo(s, fallStart(s));
    reach(s, "rest");
    while (weekday(c.day) === "Sat" || weekday(c.day) === "Sun" || c.slot !== "afternoon") {
      const acts = slotActions(c);
      const pick = acts.find((a) => !a.launch && !a.sceneId)!;
      takeAction(c, pick.id);
      hub(s);
    }
    expect(parkAvailable(c)).toBe(false);
    expect(slotActions(c).map((a) => a.id)).not.toContain("park_session");
    c.progression.relationships[FRIEND_ID] = 25;
    refreshUnlocks(c.progression);
    hub(s);
    expect(parkAvailable(c)).toBe(true);
    const park = slotActions(c).find((a) => a.id === "park_session")!;
    expect(park.sceneId).toBe("arc.park.session");
    const technical = c.progression.tracks.technical;
    const day = c.day;
    expect(takeAction(c, "park_session").ok).toBe(true);
    expect(c.scene).toBe("arc.park.session");
    expect(c.story.facts[PARK_DAY_FACT]).toBe(day);
    const scene = viewScene(c, s.scenes)!.scene;
    expect(scene.activity).toBe("first_touch");
    recordFirstTouch(c, summarize(runHeadless(createDrill(c.seed ^ c.day), (_d, rec) => ({ gate: rec.bestGate, accuracy: 0.95 }))), "park");
    expect(knows(c.story, FRIEND_ID, PARK_FACTS.touch)).toBe(true);
    expect(knows(c.story, "coach", PARK_FACTS.touch)).toBe(false);
    expect(c.progression.verified["park_first_touch"]).toBeGreaterThan(0);
    expect(c.progression.tracks.technical).toBeGreaterThanOrEqual(technical);
    continueScene(c, s.scenes);
    expect(c.scene).toBe("arc.park.after");
    const after = viewScene(c, s.scenes)!;
    if (c.story.facts[PARK_FACTS.touch] === "clean") expect(after.lines.some((l) => l.text.includes("Clean"))).toBe(true);
    drainScenes(s);
    if (c.day === day) expect(parkAvailable(c)).toBe(false);
    const evening = { ...c, slot: "evening" as const, day: day + 1 };
    evening.story = { ...c.story, facts: { ...c.story.facts } };
    delete evening.story.facts[PARK_DAY_FACT];
    while (weekday(evening.day) === "Sat" || weekday(evening.day) === "Sun") evening.day++;
    expect(parkAvailable(evening)).toBe(false);
    evening.progression = { ...c.progression, unlocked: [...c.progression.unlocked, "parent_trusts_you"] };
    expect(parkAvailable(evening)).toBe(true);
  });
});

describe("explicit progression rules", () => {
  it("the JSON rule table and the TypeScript model agree", () => {
    const file = progressionJson as { tracks: Record<string, { label: string; movedBy: string[] }>; unlocks: { id: string; grants: string; requires: { track?: string; personId?: string; min: number }[] }[] };
    expect(Object.keys(file.tracks).sort()).toEqual([...TRACKS].sort());
    expect(UNLOCKS.map((u) => u.id)).toEqual(file.unlocks.map((u) => u.id));
    for (const u of UNLOCKS) {
      expect(GRANTS).toContain(u.grants);
      expect(u.opens.length).toBeGreaterThan(10);
      expect(u.requires.length).toBeGreaterThan(0);
      for (const q of u.requires) {
        if (q.track) expect(TRACKS).toContain(q.track);
        else expect(["friend", "parent", "coach", ...CAST_ROLES]).toContain(q.personId);
        expect(q.min).toBeGreaterThan(0);
      }
    }
    for (const t of TRACKS) expect(file.tracks[t]!.movedBy.length).toBeGreaterThan(0);
  });

  it("unlock views show every requirement and where the player stands; track gates and relationship gates both hold", () => {
    const p = createProgression();
    const views = unlockViews(p);
    expect(views.map((v) => v.rule.id)).toEqual(UNLOCKS.map((u) => u.id));
    const captain = views.find((v) => v.rule.id === "captain_conversation")!;
    expect(captain.unlocked).toBe(false);
    expect(captain.requirements.map((r) => [r.requirement.track, r.value, r.met])).toEqual([
      ["tactical", 20, false],
      ["responsibility", 40, false],
    ]);
    p.tracks.tactical = 45;
    p.tracks.responsibility = 59;
    expect(refreshUnlocks(p)).toEqual([]);
    p.tracks.responsibility = 60;
    expect(refreshUnlocks(p)).toEqual(["captain_conversation"]);
    const coach = unlockViews(p).find((v) => v.rule.id === "coach_extra_feedback")!;
    expect(coach.requirements.find((r) => r.requirement.personId === "coach")!.met).toBe(false);
    adjustRelationship(p, "coach", 25);
    expect(refreshUnlocks(p)).toEqual(["coach_extra_feedback"]);
    expect(unlockViews(p).find((v) => v.rule.id === "coach_extra_feedback")!.unlocked).toBe(true);
  });

  it("relationships gate conversations, activities, support and opportunities — never attributes", () => {
    const p = createProgression();
    const before = { ...p.tracks };
    for (const id of ["friend", "parent", "coach", ...CAST_ROLES]) adjustRelationship(p, id, 100);
    refreshUnlocks(p);
    expect(p.tracks).toEqual(before);
    expect(p.unlocked).toContain("friend_park_sessions");
    for (const u of UNLOCKS) expect(["conversation", "activity", "support", "opportunity"]).toContain(u.grants);
  });
});

describe("consequences in the arc", () => {
  function atSlump(kind: CampaignKind = "boys"): S {
    const s = joinedSession({ kind });
    const c = s.campaign;
    liveTo(s, fallStart(s));
    hub(s);
    c.story.facts[MATCH_FACTS.streak] = -2;
    enterScene(c, s.scenes, "arc.slump");
    return s;
  }

  it("a delayed consequence lands unless the world moved on, and a repair inside its window cancels it", () => {
    const s = atSlump();
    const c = s.campaign;
    c.progression.relationships[FRIEND_ID] = 10;
    const day = c.day;
    expect(chooseInScene(c, s.scenes, "arc.slump.drawer").ok).toBe(true);
    expect(c.story.pending.some((p) => p.key === "arc.slump.drawer:left_hanging")).toBe(true);
    const open = openRepairs(c, s.scenes);
    expect(open.map((r) => r.repair.id)).toEqual(["answer_late"]);
    expect(open[0]!.untilDay).toBe(day + 3);
    expect(open[0]!.label).not.toContain("{friend}");
    const rel = c.progression.relationships[FRIEND_ID]!;
    const r = takeRepair(c, s.scenes, open[0]!.choice.id, "answer_late");
    expect(r.ok).toBe(true);
    expect(c.progression.relationships[FRIEND_ID]).toBe(rel + 2);
    expect(c.story.pending.some((p) => p.key === "arc.slump.drawer:left_hanging")).toBe(false);
    expect(openRepairs(c, s.scenes)).toEqual([]);
    liveTo(s, day + 5);
    expect(c.story.facts["friend_left_hanging"]).toBeUndefined();
  });

  it("an unrepaired consequence fires once when due and is dropped when its premise no longer holds", () => {
    const s = atSlump();
    const c = s.campaign;
    c.progression.relationships[FRIEND_ID] = 10;
    const day = c.day;
    chooseInScene(c, s.scenes, "arc.slump.drawer");
    const rel = c.progression.relationships[FRIEND_ID]!;
    liveTo(s, day + 4);
    expect(c.story.facts["friend_left_hanging"]).toBe(true);
    expect(c.progression.relationships[FRIEND_ID]).toBeLessThan(rel);
    expect(openRepairs(c, s.scenes)).toEqual([]);
    expect(c.story.pending.some((p) => p.key === "arc.slump.drawer:left_hanging")).toBe(false);

    const t = atSlump("girls");
    const d = t.campaign;
    d.progression.relationships[FRIEND_ID] = 30;
    chooseInScene(d, t.scenes, "arc.slump.drawer");
    liveTo(t, d.day + 4);
    expect(d.story.facts["friend_left_hanging"]).toBeUndefined();
    expect(d.story.dropped.some((x) => x.key === "arc.slump.drawer:left_hanging")).toBe(true);
  });

  it("repairs expire with their window; once-only milestones expire with the phase that authored them", () => {
    const s = atSlump();
    const c = s.campaign;
    c.progression.relationships[FRIEND_ID] = 10;
    chooseInScene(c, s.scenes, "arc.slump.drawer");
    advanceDays(c, 4);
    expect(openRepairs(c, s.scenes)).toEqual([]);
    expect(takeRepair(c, s.scenes, "arc.slump.drawer", "answer_late")).toEqual({ ok: false, reason: "unavailable" });
    const question = arcScenes("boys").find((x) => x.id === "arc.question")!;
    c.story.facts[MATCH_FACTS.leaguePlayed] = 5;
    c.story.facts[ARC_FACTS.phase] = "fall";
    expect(sceneEligible(storyContext(c), question)).toBe(true);
    c.story.facts[ARC_FACTS.phase] = "winter";
    expect(sceneEligible(storyContext(c), question)).toBe(false);
  });

  it("characters keep what they learn: the coach only knows about the striker's rumour if you told him", () => {
    for (const [choice, coachKnows] of [
      ["arc.rumour.coach", true],
      ["arc.rumour.stay", false],
    ] as const) {
      const s = joinedSession();
      const c = s.campaign;
      liveTo(s, fallStart(s));
      hub(s);
      enterScene(c, s.scenes, "arc.sibling_rumour");
      expect(chooseInScene(c, s.scenes, choice).ok).toBe(true);
      expect(c.story.facts["striker_tempted"]).toBe(true);
      expect(knows(c.story, "striker", "striker_tempted")).toBe(true);
      expect(knows(c.story, "coach", "striker_tempted")).toBe(coachKnows);
      const lunch = arcScenes("boys").find((x) => x.id === "arc.lunch.striker")!;
      expect(sceneEligible(storyContext(c), lunch)).toBe((c.progression.relationships["striker"] ?? 0) <= 4);
    }
  });

  it("story and progression state survive save and resume", () => {
    const store = new MemoryStore();
    const s = joinedSession({}, store);
    const c = s.campaign;
    liveTo(s, fallStart(s));
    hub(s);
    c.story.facts[MATCH_FACTS.streak] = -2;
    enterScene(c, s.scenes, "arc.slump");
    chooseInScene(c, s.scenes, "arc.slump.drawer");
    c.progression.relationships[FRIEND_ID] = 22;
    c.progression.tracks.responsibility = 50;
    refreshUnlocks(c.progression);
    announceUnlocks(c);
    s.save();
    const back = resumeSession(store)!;
    const d = back.campaign;
    expect(d.progression).toEqual(c.progression);
    expect(d.story.pending).toEqual(c.story.pending);
    expect(d.story.queuedScenes).toEqual(c.story.queuedScenes);
    expect(d.story.appliedDays).toEqual(c.story.appliedDays);
    expect(d.story.knowledge).toEqual(c.story.knowledge);
    expect(openRepairs(d, back.scenes).map((r) => r.repair.id)).toEqual(["answer_late"]);
    expect(unlockViews(d.progression).find((v) => v.rule.id === "friend_park_sessions")!.unlocked).toBe(true);
  });
});
