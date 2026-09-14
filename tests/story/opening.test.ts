import { describe, expect, it } from "vitest";
import { weekday } from "../../src/calendar/date";
import { advanceDays, createCampaign, playerClubId, storyContext, type CampaignKind, type CampaignState } from "../../src/campaign/campaign";
import { loadCampaign, MemoryStore, saveCampaign } from "../../src/save/save";
import {
  chooseInScene,
  continueScene,
  enterScene,
  openingScenes,
  openingStatus,
  sceneVars,
  startOpening,
  takeQueuedScene,
  viewScene,
} from "../../src/story/flow";
import { toneReport } from "../../src/story/scenes";
import { createDrill, runHeadless, summarize } from "../../src/training/firstTouch";
import { recordFirstTouch } from "../../src/training/record";

const profile = { name: "Sam Rivera", appearance: 2, foot: "right" as const, birthMonth: 3 as const, position: 8 as const };

const fresh = (kind: CampaignKind = "boys"): CampaignState => createCampaign({ kind, player: profile, seed: 11 });

/** Play the opening up to the debrief with the given invite/parent/join choices. */
function playOpening(c: CampaignState, picks: { invite?: string; parent?: string; drillPolicy?: "best" | "worst" } = {}) {
  const scenes = openingScenes(c.kind);
  startOpening(c);
  expect(c.scene).toBe("open.kickabout");
  expect(continueScene(c, scenes)?.scene.id).toBe("open.invite");
  const inv = chooseInScene(c, scenes, picks.invite ?? "open.invite.curious");
  expect(inv.ok).toBe(true);
  expect(c.scene).toBe("open.parent");
  const par = chooseInScene(c, scenes, picks.parent ?? "open.parent.one_visit");
  expect(par.ok).toBe(true);
  expect(c.scene).toBe("open.arrive");
  expect(continueScene(c, scenes)?.scene.id).toBe("open.coach");
  expect(continueScene(c, scenes)?.scene.id).toBe("open.activity");
  const view = viewScene(c, scenes)!;
  expect(view.scene.activity).toBe("first_touch");
  const drill = runHeadless(createDrill(c.seed), (_d, rec) => ({ gate: picks.drillPolicy === "worst" ? (rec.bestGate === "left" ? "right" : "left") : rec.bestGate, accuracy: picks.drillPolicy === "worst" ? 0.2 : 0.9 }));
  recordFirstTouch(c, summarize(drill));
  expect(continueScene(c, scenes)?.scene.id).toBe("open.debrief");
  return scenes;
}

describe("U11 opening", () => {
  it.each(["boys", "girls"] as const)("%s campaign runs the spec §4 sequence in order and all scenes resolve", (kind) => {
    const c = fresh(kind);
    const scenes = openingScenes(kind);
    const ids = new Set(scenes.map((s) => s.id));
    for (const s of scenes) {
      if (s.next) expect(ids.has(s.next), `${s.id} -> ${s.next}`).toBe(true);
      for (const ch of s.choices) {
        if (ch.next) expect(ids.has(ch.next), `${ch.id} -> ${ch.next}`).toBe(true);
        for (const e of ch.immediate) if (e.type === "queue_scene") expect(ids.has(e.sceneId)).toBe(true);
      }
    }
    playOpening(c);
    expect(c.story.applied).toContain("scene:open.kickabout");
    expect(c.story.applied).toContain("scene:open.activity");
    const vars = sceneVars(c);
    expect(vars.friend).toBe(kind === "boys" ? "Mateo Aldana" : "Nia Okonkwo");
    expect(vars.parent).toBe(kind === "boys" ? "Dad" : "Mom");
    expect(vars.coach).toBe("Coach Code");
    expect(vars.position).toBe("central mid");
    const view = viewScene(c, scenes)!;
    for (const l of view.lines) expect(l.text).not.toMatch(/\{[a-z]+\}/);
  });

  it("offers the four feelings for the invitation and none of them assigns a personality", () => {
    const c = fresh();
    const scenes = openingScenes("boys");
    startOpening(c);
    continueScene(c, scenes);
    const view = viewScene(c, scenes)!;
    expect(view.choices.map((ch) => ch.id).sort()).toEqual(["open.invite.ambition", "open.invite.curious", "open.invite.together", "open.invite.unsure"]);
    for (const ch of view.choices) {
      const facts = ch.immediate.filter((e) => e.type === "set_fact").map((e) => (e.type === "set_fact" ? e.id : ""));
      expect(facts).toEqual(["first_feeling"]);
    }
    const r = chooseInScene(c, scenes, "open.invite.together");
    expect(r.ok && r.response.length).toBeGreaterThan(0);
    expect(c.story.facts["first_feeling"]).toBe("together");
    expect(c.story.knowledge["friend"]).toContain("first_feeling");
    expect(chooseInScene(c, scenes, "open.invite.curious").ok).toBe(false);
  });

  it("moves the calendar to Thursday for the visit and records it as a one-off attended commitment", () => {
    const c = fresh();
    playOpening(c);
    expect(weekday(c.day)).toBe("Thu");
    const visit = c.schedule.commitments.filter((k) => k.kind === "visit");
    expect(visit).toHaveLength(1);
    expect(visit[0]!.status).toBe("attended");
    expect(visit[0]!.day).toBe(c.day);
    expect(c.schedule.commitments.filter((k) => k.kind === "training")).toHaveLength(0);
  });

  it("parent choices carry consequences as data: school-first promise and a missed-visit delayed effect", () => {
    const c = fresh();
    const scenes = openingScenes("boys");
    startOpening(c);
    continueScene(c, scenes);
    chooseInScene(c, scenes, "open.invite.ambition");
    const view = viewScene(c, scenes)!;
    expect(view.choices.length).toBeGreaterThanOrEqual(3);
    const r = chooseInScene(c, scenes, "open.parent.ride");
    expect(r.ok).toBe(true);
    expect(c.story.facts["visit_allowed"]).toBe(true);
    expect(c.story.pending.length).toBeGreaterThan(0);
    expect(c.scene).toBe("open.arrive");
  });

  it("debrief only says what Coach Code saw in the activity", () => {
    const sharp = fresh();
    playOpening(sharp, { drillPolicy: "best" });
    expect(sharp.story.facts["intro_reads"]).toBe("sharp");
    expect(sharp.story.knowledge["coach"]).toContain("intro_reads");
    const sharpView = viewScene(sharp, openingScenes("boys"))!;
    const coachLines = sharpView.lines.filter((l) => l.speaker === "coach").map((l) => l.text);
    expect(coachLines.length).toBeGreaterThan(0);

    const rushed = fresh();
    playOpening(rushed, { drillPolicy: "worst" });
    expect(rushed.story.facts["intro_reads"]).toBe("rushed");
    const rushedView = viewScene(rushed, openingScenes("boys"))!;
    expect(rushedView.lines.map((l) => l.text)).not.toEqual(sharpView.lines.map((l) => l.text));

    // a coach who never saw the drill says nothing about it
    const blind = fresh();
    blind.scene = "open.debrief";
    const blindView = viewScene(blind, openingScenes("boys"))!;
    expect(blindView.lines.filter((l) => l.speaker === "coach" && /touch|read|look/i.test(l.text))).toHaveLength(0);
  });

  it.each(["boys", "girls"] as const)("%s parent's second-hand report at home never contradicts the drill evidence", (kind) => {
    const praiseFor = (policy: "best" | "worst") => {
      const c = fresh(kind);
      const scenes = playOpening(c, { parent: "open.parent.ride", drillPolicy: policy });
      continueScene(c, scenes);
      expect(c.scene).toBe("open.join");
      return viewScene(c, scenes)!.lines.filter((l) => l.speaker === "parent").map((l) => l.text);
    };
    const good = praiseFor("best");
    const poor = praiseFor("worst");
    expect(good.length).toBe(poor.length);
    expect(good).not.toEqual(poor);
    expect(poor.some((t) => /looked up|belonged/.test(t))).toBe(false);
  });

  it("joining FC Batavia puts the player on the roster; thinking it over queues Sunday's decision", () => {
    const c = fresh();
    const scenes = playOpening(c);
    expect(playerClubId(c)).toBeNull();
    expect(continueScene(c, scenes)?.scene.id).toBe("open.join");
    const r = chooseInScene(c, scenes, "open.join.yes");
    expect(r.ok).toBe(true);
    expect(playerClubId(c)).toBe("batavia");
    expect(c.scene).toBeNull();
    expect(openingStatus(c)).toBe("joined");

    const d = fresh("girls");
    const gs = playOpening(d);
    continueScene(d, gs);
    expect(chooseInScene(d, gs, "open.join.think").ok).toBe(true);
    expect(playerClubId(d)).toBeNull();
    expect(openingStatus(d)).toBe("undecided");
    expect(takeQueuedScene(d, gs)).toBeNull();
    expect(d.story.pending.map((p) => p.delayedId)).toContain("sunday");
    advanceDays(d, 3);
    expect(d.story.queuedScenes.map((q) => q.sceneId)).toEqual(["open.decide"]);
    const q = takeQueuedScene(d, gs);
    expect(q?.scene.id).toBe("open.decide");
    expect(weekday(d.day)).toBe("Sun");
    expect(chooseInScene(d, gs, "open.decide.join").ok).toBe(true);
    expect(playerClubId(d)).toBe("batavia");
  });

  it("survives save/resume mid-scene", () => {
    const c = fresh();
    const scenes = openingScenes("boys");
    startOpening(c);
    continueScene(c, scenes);
    chooseInScene(c, scenes, "open.invite.unsure");
    const store = new MemoryStore();
    saveCampaign(store, "slot1", c);
    const back = loadCampaign(store, "slot1")!;
    expect(back.scene).toBe("open.parent");
    expect(viewScene(back, scenes)!.choices.length).toBeGreaterThan(0);
    expect(chooseInScene(back, scenes, "open.parent.one_visit").ok).toBe(true);
    expect(back.scene).toBe("open.arrive");
  });

  it("weekday-pinned scenes advance the campaign without re-entering a later day", () => {
    const c = fresh();
    const scenes = openingScenes("boys");
    const r = enterScene(c, scenes, "open.arrive");
    expect(r.advanced?.to).toBe(3);
    expect(weekday(c.day)).toBe("Thu");
    const again = enterScene(c, scenes, "open.arrive");
    expect(again.advanced).toBeNull();
    expect(c.schedule.commitments.filter((k) => k.kind === "visit")).toHaveLength(1);
  });

  it("opening content reports its tone mix and is marked as a proposal", () => {
    const scenes = openingScenes("boys");
    const report = toneReport(scenes);
    expect(report.share.everyday).toBeGreaterThan(0);
    expect(scenes.every((s) => s.reviewStatus === "proposal")).toBe(true);
    expect(storyContext(fresh()).story.applied).toEqual([]);
  });
});
