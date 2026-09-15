import { describe, expect, it } from "vitest";
import { resumeSession } from "../../src/app/session";
import { mondayOf, weekday } from "../../src/calendar/date";
import { FRIEND_ID } from "../../src/campaign/campaign";
import { chooseHobby, currentHobby, HOBBIES, HOBBY_FACTS, hobbyAvailable, hobbySessions, hobbyView, recordHobby } from "../../src/campaign/hobbies";
import { cancelPending, completeJuggling, FATIGUE, fatigue, jugglingAvailable, slotActions, takeAction, trainingActivity } from "../../src/campaign/week";
import { MemoryStore } from "../../src/save/save";
import { campaignScenes, takeQueuedScene, viewScene } from "../../src/story/flow";
import { createJuggle, runHeadless, summarize } from "../../src/training/juggling";
import { JUGGLING_FACTS, JUGGLING_MILESTONES, recordJuggling } from "../../src/training/record";
import { ACTIVITIES, ACTIVITY_OBJECTIVE } from "../../src/training/smallSided";
import { drainScenes, joinedSession } from "./joined";

const hub = (s: ReturnType<typeof joinedSession>): string[] => {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 10 && (s.campaign.scene || takeQueuedScene(s.campaign, s.scenes))) seen.push(...drainScenes(s));
  return seen;
};

/** Take rest/school/etc. until the current slot offers `id`. */
function reach(s: ReturnType<typeof joinedSession>, id: string, maxSlots = 60): void {
  const c = s.campaign;
  for (let i = 0; i < maxSlots; i++) {
    hub(s);
    const acts = slotActions(c);
    if (acts.some((a) => a.id === id)) return;
    const pick = acts.find((a) => a.id === "rest" || a.id === "school") ?? acts.find((a) => !a.launch) ?? acts[0]!;
    const r = takeAction(c, pick.id, pick.hobbyId);
    if (!r.ok) throw new Error(r.reason);
  }
  throw new Error(`never reached ${id}`);
}

describe("training programme: five small-sided activities", () => {
  it("rondo and transition are in the weekly rotation, each week has three different activities, and every activity names its concepts", () => {
    expect(ACTIVITIES).toEqual(["1v1", "2v2", "3v2", "rondo", "transition"]);
    const s = joinedSession();
    const seen = new Set<string>();
    for (let d = s.campaign.day; d < s.campaign.day + 7 * ACTIVITIES.length; d++) {
      const w = weekday(d);
      if (w !== "Tue" && w !== "Thu" && w !== "Fri") continue;
      seen.add(trainingActivity(d));
    }
    expect([...seen].sort()).toEqual([...ACTIVITIES].sort());
    for (let monday = mondayOf(s.campaign.day); monday < s.campaign.day + 7 * ACTIVITIES.length; monday += 7) {
      const days = [monday + 1, monday + 3, monday + 4];
      expect(days.map(weekday)).toEqual(["Tue", "Thu", "Fri"]);
      expect(new Set(days.map(trainingActivity)).size).toBe(3);
    }
    for (const a of ACTIVITIES) expect(ACTIVITY_OBJECTIVE[a].concepts.length).toBeGreaterThan(0);
  });
});

describe("juggling in the yard", () => {
  it("is a free-slot solo activity, once a day, cancellable, that records verified touches, a personal best and a milestone moment", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "juggle");
    expect(jugglingAvailable(c)).toBe(true);
    const r = takeAction(c, "juggle");
    expect(r.ok && r.launch?.kind === "juggling").toBe(true);
    expect(cancelPending(c)).toBe(true);
    expect(slotActions(c).some((a) => a.id === "juggle")).toBe(true);
    takeAction(c, "juggle");
    const verifiedBefore = c.progression.verified["juggling"] ?? 0;
    const tech = c.progression.tracks.technical;
    const f0 = fatigue(c);
    const day = c.day;
    const sum = summarize(runHeadless(createJuggle(c.seed ^ (c.day * 23)), (i) => (i % 13 === 12 ? 260 : 50)));
    expect(sum.best).toBeGreaterThanOrEqual(10);
    const eff = completeJuggling(c, sum).effects;
    expect(c.pending).toBeNull();
    expect(c.progression.verified["juggling"]).toBe(verifiedBefore + sum.total);
    expect(c.story.facts[JUGGLING_FACTS.best]).toBe(sum.best);
    expect(c.story.facts[JUGGLING_FACTS.day]).toBe(day);
    expect(c.progression.tracks.technical).toBe(tech + 1);
    if (c.day === day) expect(fatigue(c)).toBe(Math.min(FATIGUE.max, f0 + FATIGUE.juggling));
    const queued = eff.filter((e) => e.type === "queue_scene");
    expect(queued).toHaveLength(1);
    const crossed = JUGGLING_MILESTONES.filter((m) => m.touches <= sum.best).at(-1)!;
    expect(queued[0]).toMatchObject({ sceneId: crossed.sceneId });
    if (c.day === day) expect(jugglingAvailable(c)).toBe(false);
    const seen = hub(s);
    expect(seen).toContain(crossed.sceneId);
  });

  it("only the highest milestone crossed is queued, improving a best later queues the next, and a worse session never lowers the record", () => {
    const s = joinedSession();
    const c = s.campaign;
    const play = (best: number) => recordJuggling(c, { best, runs: [best], total: best, perfect: best, good: 0, loose: 0, capped: best >= 50 });
    expect(play(30).filter((e) => e.type === "queue_scene")).toEqual([{ type: "queue_scene", sceneId: "hobby.juggle_twenty_five", onDay: c.day }]);
    expect(play(12).filter((e) => e.type === "queue_scene")).toEqual([]);
    expect(c.story.facts[JUGGLING_FACTS.best]).toBe(30);
    expect(c.story.facts[JUGGLING_FACTS.last]).toBe(12);
    const wellbeing = c.progression.tracks.wellbeing;
    expect(play(50).filter((e) => e.type === "queue_scene")).toEqual([{ type: "queue_scene", sceneId: "hobby.juggle_fifty", onDay: c.day }]);
    expect(c.progression.tracks.wellbeing).toBe(wellbeing + 1);
    expect(c.story.facts[JUGGLING_FACTS.sessions]).toBe(3);
  });

  it("every milestone scene exists in both campaigns and reads the record it was queued for", () => {
    for (const kind of ["boys", "girls"] as const) {
      const scenes = campaignScenes(kind);
      for (const m of JUGGLING_MILESTONES) {
        const scene = scenes.find((x) => x.id === m.sceneId)!;
        expect(scene).toBeDefined();
        expect(scene.eligibility).toContainEqual({ type: "fact", id: JUGGLING_FACTS.best, min: m.touches });
        expect(scene.reviewStatus).toBe("proposal");
      }
    }
  });
});

describe("hobbies", () => {
  it("are offered in free afternoons and evenings until one is picked, then only that one, once a day; a session rests and lifts wellbeing without touching soccer evidence", () => {
    const s = joinedSession();
    const c = s.campaign;
    reach(s, "hobby");
    expect(currentHobby(c)).toBeNull();
    const offered = slotActions(c).filter((a) => a.id === "hobby");
    expect(offered.map((a) => a.hobbyId).sort()).toEqual(HOBBIES.map((h) => h.id).sort());
    const verified = { ...c.progression.verified };
    const wellbeing = c.progression.tracks.wellbeing;
    c.story.facts["fatigue"] = 4;
    const day = c.day;
    const r = takeAction(c, "hobby", "drawing");
    expect(r.ok && r.launch === null).toBe(true);
    expect(currentHobby(c)?.id).toBe("drawing");
    expect(hobbySessions(c)).toBe(1);
    expect(c.story.facts[HOBBY_FACTS.day]).toBe(day);
    expect(c.progression.tracks.wellbeing).toBe(wellbeing + 1);
    expect(c.progression.verified).toEqual(verified);
    if (c.day === day) {
      expect(fatigue(c)).toBe(3);
      expect(hobbyAvailable(c)).toBe(false);
    }
    reach(s, "hobby");
    const again = slotActions(c).filter((a) => a.id === "hobby");
    expect(again).toHaveLength(1);
    expect(again[0]!.hobbyId).toBe("drawing");
    expect(again[0]!.label).toBe("Drawing");
  });

  it("every-n effects land on schedule: reading helps school every second session, games cost it every third", () => {
    const s = joinedSession();
    const c = s.campaign;
    const school = c.progression.tracks.school;
    recordHobby(c, "reading");
    expect(c.progression.tracks.school).toBe(school);
    recordHobby(c, "reading");
    expect(c.progression.tracks.school).toBe(school + 1);
    chooseHobby(c, "games");
    expect(hobbySessions(c)).toBe(0);
    expect(c.story.facts[HOBBY_FACTS.total]).toBe(2);
    recordHobby(c, "games");
    recordHobby(c, "games");
    expect(c.progression.tracks.school).toBe(school + 1);
    recordHobby(c, "games");
    expect(c.progression.tracks.school).toBe(school);
  });

  it("the 3rd and 7th sessions queue the hobby's authored moments, which exist for both campaigns and are gated on the hobby still being current", () => {
    const s = joinedSession();
    const c = s.campaign;
    for (const h of HOBBIES) {
      for (const kind of ["boys", "girls"] as const) {
        for (const m of h.milestones) {
          const scene = campaignScenes(kind).find((x) => x.id === m.sceneId)!;
          expect(scene, `${kind} ${m.sceneId}`).toBeDefined();
          expect(scene.eligibility).toContainEqual({ type: "fact", id: HOBBY_FACTS.id, equals: h.id });
          expect(scene.once).toBe(true);
          expect(scene.choices.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
    chooseHobby(c, "guitar");
    const queued: string[] = [];
    for (let i = 0; i < 7; i++) queued.push(...recordHobby(c, "guitar").flatMap((e) => (e.type === "queue_scene" ? [e.sceneId] : [])));
    expect(queued).toEqual(["hobby.guitar.noticed", "hobby.guitar.share"]);
    expect(takeQueuedScene(c, s.scenes)).toBeTruthy();
    expect(viewScene(c, s.scenes)!.scene.id).toBe("hobby.guitar.noticed");
    const friend = c.progression.relationships[FRIEND_ID] ?? 0;
    drainScenes(s);
    hub(s);
    expect(c.progression.relationships[FRIEND_ID] ?? 0).toBeGreaterThan(friend);
    expect(hobbyView(c).next).toBeNull();
  });

  it("the games moment sets up a parent promise with a delayed school cost and a repair, and hobby/juggling state survives save and resume", () => {
    const store = new MemoryStore();
    const s = joinedSession({}, store);
    const c = s.campaign;
    chooseHobby(c, "games");
    for (let i = 0; i < 3; i++) recordHobby(c, "games");
    expect(takeQueuedScene(c, s.scenes)).toBeTruthy();
    const v = viewScene(c, s.scenes)!;
    expect(v.scene.id).toBe("hobby.games.noticed");
    const push = v.choices.find((ch) => ch.id === "hobby.games.noticed.push")!;
    expect(push.delayed[0]!.unless).toContainEqual({ type: "fact", id: "games_cutoff", equals: true });
    expect(push.repair[0]!.cancels).toEqual([push.delayed[0]!.id]);
    recordJuggling(c, { best: 14, runs: [3, 14, 9], total: 26, perfect: 10, good: 12, loose: 4, capped: false });
    s.save();
    const back = resumeSession(store)!;
    expect(currentHobby(back.campaign)?.id).toBe("games");
    expect(hobbySessions(back.campaign)).toBe(3);
    expect(back.campaign.story.facts[JUGGLING_FACTS.best]).toBe(14);
    expect(back.campaign.scene).toBe("hobby.games.noticed");
  });
});
