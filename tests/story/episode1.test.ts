import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { weekday } from "../../src/calendar/date";
import { PLAYER_ID, resolvePerson } from "../../src/campaign/campaign";
import { campaignMatchConfig, fixtureById, reportFromRuntime } from "../../src/campaign/match";
import { completeMatch, slotActions, takeAction } from "../../src/campaign/week";
import { createRuntime, frame, liveAnchor, select, setAccessible, tapTarget, type MatchRuntime } from "../../src/match/runtime";
import { DEFAULT_ACCESSIBILITY, type GameLogic } from "../../src/minigame/contract";
import { exit, resume, start, tick, type MinigameSession } from "../../src/minigame/machine";
import { gameLogic } from "../../src/minigame/registry";
import { resumeSession, type Session } from "../../src/app/session";
import { MemoryStore } from "../../src/save/save";
import { ROLE_BY_NUMBER } from "../../src/sim/types";
import { knows } from "../../src/story/consequences";
import { cancelMinigame, checkpointMinigame, completeMinigame, launchMinigame, pendingMinigame } from "../../src/story/episode";
import { chooseInScene, continueScene, takeQueuedScene, viewScene } from "../../src/story/flow";
import { validateLedger } from "../../src/story/ledger";
import { activeLessonCue, LESSON_FACTS } from "../../src/story/lesson";
import { relationOf, remembers } from "../../src/story/memory";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { pacingFor } from "../../src/tactics/recognition";
import { drainScenes, joinedSession, playMinigameHeadless } from "../campaign/joined";
import { GP_PERFECT, playGp, playWckPerfect, type GpSession, type WckSession } from "../minigame/helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);

/**
 * Episode One (Story Engine v2 §7) end to end, headless:
 *   school story trigger → playable minigame → verified result → relationship reaction →
 *   club training / home decision → official match → Monday consequence → next-episode hook.
 */

/** Advance the week (taking non-launching slot actions, draining unrelated scenes) until the named scene is current. */
function untilScene(s: Session, id: string, maxSlots = 80): void {
  const c = s.campaign;
  for (let i = 0; i < maxSlots; i++) {
    if (c.scene === id) return;
    if (c.scene) {
      drainOne(s);
      continue;
    }
    if (takeQueuedScene(c, s.scenes)) continue;
    const acts = slotActions(c);
    const pick = acts.find((a) => !a.launch) ?? acts[0]!;
    const r = takeAction(c, pick.id);
    if (!r.ok) throw new Error(r.reason);
  }
  throw new Error(`never reached ${id} (day ${c.day} ${weekday(c.day)}, scene ${c.scene}, queued ${c.story.queuedScenes.map((q) => q.sceneId).join(",")})`);
}

function drainOne(s: Session): void {
  const c = s.campaign;
  const v = viewScene(c, s.scenes)!;
  if (v.minigame) playMinigameHeadless(s);
  else if (v.choices.length) chooseInScene(c, s.scenes, v.choices[0]!.id);
  else continueScene(c, s.scenes);
}

function playToFullTime(rt: MatchRuntime): void {
  setAccessible(rt, true);
  rt.fast = true;
  for (let i = 0; i < 2_000_000; i++) {
    const r = frame(rt, 1000);
    if (r.opened) {
      const first = r.opened.options[0]!;
      if (!select(rt, first.id) && rt.active) tapTarget(rt, liveAnchor(rt, first) ?? rt.state.ball.pos);
    }
    if (r.finished) return;
  }
  throw new Error("match did not finish");
}

/** Reach Saturday's match slot, play the fixture through the real runtime and commit the report. */
function playOfficialMatch(s: Session): ReturnType<typeof reportFromRuntime> {
  const c = s.campaign;
  for (let i = 0; i < 80; i++) {
    if (c.scene) {
      drainOne(s);
      continue;
    }
    if (takeQueuedScene(c, s.scenes)) continue;
    const acts = slotActions(c);
    const match = acts.find((a) => a.launch?.kind === "match");
    if (match) {
      const r = takeAction(c, match.id);
      if (!r.ok || !r.launch || r.launch.kind !== "match") throw new Error("match not launched");
      const fixture = fixtureById(c, r.launch.fixtureId);
      const rt = createRuntime(campaignMatchConfig(c, fixture), catalog, { pacing: pacingFor(ROLE_BY_NUMBER[c.player.position]) });
      playToFullTime(rt);
      const rep = reportFromRuntime(rt, fixture);
      completeMatch(c, rep);
      return rep;
    }
    const pick = acts.find((a) => !a.launch) ?? acts[0]!;
    const r = takeAction(c, pick.id);
    if (!r.ok) throw new Error(r.reason);
  }
  throw new Error("no match reached");
}

const wckOf = (session: MinigameSession<unknown, unknown>): WckSession => session as WckSession;
const gpOf = (session: MinigameSession<unknown, unknown>): GpSession => session as GpSession;
const logicOf = <S, I>(s: MinigameSession<S, I>): GameLogic<S, I> => gameLogic(s.config.gameId) as GameLogic<S, I>;

describe("Episode One: the full story → minigame → match → Monday loop", () => {
  it("runs the winning route: invitation, recess knockout, rival memory, project, Coach Code's lesson, match cue, Monday consequence, hook", () => {
    const s = joinedSession({ seed: 11 });
    const c = s.campaign;
    const rival = resolvePerson(c.kind, "rival");
    const friend = resolvePerson(c.kind, "friend");

    // 1. School story trigger: Monday homeroom, best-friend invitation, rival-club classmate.
    untilScene(s, "ep1.homeroom");
    expect(weekday(c.day)).toBe("Mon");
    const homeroom = viewScene(c, s.scenes)!;
    expect(homeroom.scene.location).toBe("school");
    expect(homeroom.lines.some((l) => l.speaker === "rival" && /Sonoran|Batavia/.test(l.text))).toBe(true);
    expect(homeroom.lines.some((l) => /knockout/i.test(l.text))).toBe(true);
    expect(homeroom.lines.some((l) => l.speaker === "friend")).toBe(true);
    expect(homeroom.choices.map((ch) => ch.id)).toEqual(["ep1.homeroom.in", "ep1.homeroom.watch"]);
    const trustBefore = relationOf(c.story.memory, friend).trust;
    const inRes = chooseInScene(c, s.scenes, "ep1.homeroom.in");
    expect(inRes.ok && inRes.next?.scene.id).toBe("ep1.recess");
    expect(relationOf(c.story.memory, friend).trust).toBe(trustBefore + 1);

    // 2. Playable recess sequence: the scene cannot continue until the game has been played and committed.
    const recess = viewScene(c, s.scenes)!;
    expect(recess.minigame?.gameId).toBe("world_cup_knockout");
    expect(continueScene(c, s.scenes)).toBeNull();
    expect(c.scene).toBe("ep1.recess");
    const matchCfgBefore = JSON.stringify(campaignMatchConfig(c, c.competitions.fixtures.find((f) => !f.result && (f.homeClubId === "batavia" || f.awayClubId === "batavia"))!));
    const attributesBefore = JSON.stringify(c.roster.attributes);

    const session = wckOf(launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 1000));
    expect(c.pending).toMatchObject({ kind: "minigame", sceneId: "ep1.recess" });
    expect(session.config.participantIds).toEqual([PLAYER_ID, friend, rival, "cm-leah", "cm-tobias", "cm-hana", "cm-ravi", "cm-sol"]);
    expect(session.config.locationId).toBe("school");
    expect(session.config.ageBand).toBe("U11-U12");
    expect(session.config.episodeId).toBe("ep1");
    // The rival is the best player at recess — from who they are, not from any match attribute.
    expect(session.config.skills![rival]).toBeGreaterThan(session.config.skills![friend]!);
    expect(completeMinigame(c, s.scenes, session)).toEqual({ ok: false, reason: "unfinished" });

    // Save/reload mid-game: the pending session comes back paused and can be finished after reload.
    start(session);
    playWckPerfect(session, 20_000);
    expect(session.phase).toBe("active");
    expect(checkpointMinigame(c, session)).toBe(true);
    s.save();

    playWckPerfect(session);
    expect(session.phase).toBe("resolved");
    expect(session.result!.outcomeTier).toBe("success");
    const respectBefore = relationOf(c.story.memory, rival).respect;
    const done = completeMinigame(c, s.scenes, session);
    expect(done.ok).toBe(true);
    if (!done.ok) return;

    // 3. Verified result → ledger, facts, relationship reaction, memory — and the authored continuation.
    expect(c.story.ledger.at(-1)).toMatchObject({ kind: "minigame", source: "minigame_engine", id: done.eventId });
    expect(validateLedger(c.story.ledger)).toEqual([]);
    expect(c.story.facts["mg:world_cup_knockout:outcome"]).toBe("success");
    expect(c.story.facts["mg:world_cup_knockout:plays"]).toBe(1);
    expect(c.story.facts["mg:last_continuation"]).toBe("success");
    expect(relationOf(c.story.memory, rival).respect).toBeGreaterThan(respectBefore);
    expect(relationOf(c.story.memory, rival).competitive_tension).toBeGreaterThan(0);
    expect(remembers(c.story.memory, rival, "mg:ep1:world_cup_knockout", c.day, "impressed")).toBe(true);
    expect(c.pending).toBeNull();
    expect(done.next?.scene.id).toBe("ep1.recess_won");
    expect(c.scene).toBe("ep1.recess_won");
    const won = viewScene(c, s.scenes)!;
    expect(won.lines.some((l) => l.speaker === "rival" && /doesn't count on Saturdays/.test(l.text))).toBe(true);
    expect(won.lines.some((l) => /8 started/.test(l.text))).toBe(true);

    // The same session cannot be applied twice.
    c.pending = { kind: "minigame", sceneId: "ep1.recess", session };
    expect(completeMinigame(c, s.scenes, session)).toEqual({ ok: false, reason: "duplicate" });
    expect(c.story.facts["mg:world_cup_knockout:plays"]).toBe(1);
    expect(c.story.ledger.filter((e) => e.id === done.eventId)).toHaveLength(1);
    c.pending = null;

    // Engine boundary: nothing about the official match changed because of recess.
    expect(JSON.stringify(c.roster.attributes)).toBe(attributesBefore);
    expect(JSON.stringify(campaignMatchConfig(c, c.competitions.fixtures.find((f) => !f.result && (f.homeClubId === "batavia" || f.awayClubId === "batavia"))!))).toBe(matchCfgBefore);

    // 4. Age-appropriate classroom activity assigned, then Tuesday: FC Batavia training with Coach Code.
    continueScene(c, s.scenes);
    expect(c.scene).toBe("ep1.project_assign");
    expect(viewScene(c, s.scenes)!.lines.some((l) => l.speaker === "teacher" && /pizza|fractions/i.test(l.text))).toBe(true);
    untilScene(s, "ep1.coach_lesson");
    expect(weekday(c.day)).toBe("Tue");
    expect(viewScene(c, s.scenes)!.scene.location).toBe("training_field");
    chooseInScene(c, s.scenes, "ep1.coach_lesson.ask");
    expect(c.story.facts[LESSON_FACTS.active]).toBe("scan_before_receive");
    expect(knows(c.story, "coach", LESSON_FACTS.active)).toBe(true);
    const role = ROLE_BY_NUMBER[c.player.position];
    const cue = activeLessonCue(c.story.facts, role);
    expect(cue).not.toBeNull();
    expect(cue!.entryIds.length).toBeGreaterThan(0);
    expect(cue!.entryIds.every((id) => catalog.entries.some((e) => e.id === id))).toBe(true);

    // 5. Wednesday: the group presentation (the academic minigame) in the same episode.
    untilScene(s, "ep1.presentation");
    expect(weekday(c.day)).toBe("Wed");
    const pres = viewScene(c, s.scenes)!;
    expect(pres.minigame?.gameId).toBe("group_presentation");
    // Trust from the invitation shows in what the friend says.
    expect(pres.lines.some((l) => l.speaker === "friend" && /I trust you/.test(l.text))).toBe(true);
    const gp = gpOf(launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 5000));
    expect(gp.config.participantIds).toEqual([PLAYER_ID, friend, rival]);
    expect(gp.config.ruleVariant).toBe("fractions_pizza");
    start(gp);
    playGp(gp, GP_PERFECT);
    expect(gp.phase).toBe("resolved");
    const gpDone = completeMinigame(c, s.scenes, gp);
    expect(gpDone.ok).toBe(true);
    if (!gpDone.ok) return;
    expect(gpDone.result.outcomeTier).toBe("success");
    expect(c.scene).toBe("ep1.presentation_strong");
    expect(remembers(c.story.memory, "teacher", "mg:ep1:group_presentation", c.day, "proud")).toBe(true);
    expect(c.story.ledger.filter((e) => e.kind === "minigame")).toHaveLength(2);

    // 6. Home decision.
    continueScene(c, s.scenes);
    expect(c.scene).toBe("ep1.home_decision");
    expect(viewScene(c, s.scenes)!.scene.location).toBe("home");
    chooseInScene(c, s.scenes, "ep1.home_decision.practice");
    expect(c.story.facts.ep1_prep).toBe("practice");

    // 7. Official match: the soccer engine plays it; the lesson only reads the report afterwards.
    const rep = playOfficialMatch(s);
    expect(rep.finished).toBe(true);
    const matchEntry = c.story.ledger.find((e) => e.kind === "match");
    expect(matchEntry).toMatchObject({ source: "soccer_engine", payload: { eventId: rep.eventId, score: rep.score } });
    expect(["applied", "mixed", "missed", "not_faced"]).toContain(c.story.facts[LESSON_FACTS.verdict]);
    const faced = c.story.facts[LESSON_FACTS.faced];
    expect(typeof faced).toBe("number");
    expect(faced).toBe(rep.moments.faced.filter((m) => cue!.entryIds.includes(m.entryId)).length);
    expect(validateLedger(c.story.ledger)).toEqual([]);

    // 8. Monday consequence: only what was recorded is talked about; the rival still remembers recess.
    untilScene(s, "ep1.monday");
    expect(weekday(c.day)).toBe("Mon");
    const monday = viewScene(c, s.scenes)!;
    const texts = monday.lines.map((l) => l.text);
    expect(texts.some((t) => t.includes(`${rep.score.home}`) || /didn't play Saturday/.test(t))).toBe(true);
    expect(texts.filter((t) => /Text from/.test(t))).toHaveLength(1);
    if (c.story.facts[LESSON_FACTS.verdict] !== "not_faced") expect(texts.some((t) => t.includes(`${faced}`))).toBe(true);
    expect(texts.some((t) => /winning Knockout/.test(t))).toBe(true);
    expect(texts.some((t) => /walking off halfway/.test(t))).toBe(false);
    expect(monday.choices.length).toBeGreaterThan(0);
    // Persistent relationship consequence carried the whole week.
    expect(relationOf(c.story.memory, rival).respect).toBeGreaterThan(respectBefore);
    // Continuation hook into the next episode.
    const pick = chooseInScene(c, s.scenes, monday.choices[0]!.id);
    expect(pick.ok).toBe(true);
    expect(c.story.facts.ep2_hook).toBe("tight_space");
    expect(c.scene).toBeNull();
  });

  it("resumes a saved mid-game session paused from the campaign save and finishes it after reload", () => {
    const store = new MemoryStore();
    const s = joinedSession({ seed: 5 }, store);
    const c = s.campaign;
    untilScene(s, "ep1.homeroom");
    chooseInScene(c, s.scenes, "ep1.homeroom.in");
    const live = wckOf(launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 0));
    start(live);
    playWckPerfect(live, 15_000);
    expect(live.phase).toBe("active");
    checkpointMinigame(c, live);
    s.save();

    const again = resumeSession(store)!;
    const pending = pendingMinigame(again.campaign);
    expect(pending?.sceneId).toBe("ep1.recess");
    const back = wckOf(pending!.session);
    expect(back.phase).toBe("paused");
    expect(back.events.at(-1)).toMatchObject({ type: "paused", detail: "restored" });
    expect(back.elapsedMs).toBe(live.elapsedMs);
    // The restored session is now the canonical pending one (not a stale copy).
    expect(again.campaign.pending).toMatchObject({ kind: "minigame", session: back });
    expect(again.campaign.scene).toBe("ep1.recess");
    // Finishing after reload continues the story down the earned route.
    expect(resume(back).ok).toBe(true);
    playWckPerfect(back);
    expect(back.phase).toBe("resolved");
    const done = completeMinigame(again.campaign, again.scenes, back);
    expect(done.ok).toBe(true);
    expect(again.campaign.scene).toMatch(/^ep1\.recess_/);
    expect(validateLedger(again.campaign.story.ledger)).toEqual([]);
  });

  it("a walk-out, a knockout and the bell all continue the story, and the Monday scene remembers the walk-out", () => {
    const s = joinedSession({ seed: 3 });
    const c = s.campaign;
    const rival = resolvePerson(c.kind, "rival");
    untilScene(s, "ep1.homeroom");
    chooseInScene(c, s.scenes, "ep1.homeroom.in");
    const live = wckOf(launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 0));
    start(live);
    playWckPerfect(live, 10_000);
    expect(exit(live, logicOf(live), 10_000).ok).toBe(true);
    const done = completeMinigame(c, s.scenes, live);
    expect(done.ok && done.result.exitReason).toBe("voluntary_exit");
    expect(c.scene).toBe("ep1.recess_left");
    expect(remembers(c.story.memory, rival, "mg:ep1:world_cup_knockout", c.day, "annoyed")).toBe(true);
    expect(relationOf(c.story.memory, rival).respect).toBeLessThan(0);
    // The story keeps going through the same beats; the untouched presentation is played hands-off.
    continueScene(c, s.scenes);
    expect(c.scene).toBe("ep1.project_assign");
    untilScene(s, "ep1.presentation");
    const gp = gpOf(launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 0));
    start(gp);
    // Never finishing the set-up: the bell ends it.
    const logic = logicOf(gp);
    while (gp.phase === "active") tick(gp, logic, 50, gp.elapsedMs + 50);
    expect(gp.result!.exitReason).toBe("timeout");
    expect(completeMinigame(c, s.scenes, gp).ok).toBe(true);
    expect(c.scene).toBe("ep1.presentation_bell");
    continueScene(c, s.scenes);
    expect(c.scene).toBe("ep1.home_decision");
    chooseInScene(c, s.scenes, "ep1.home_decision.homework");
    playOfficialMatch(s);
    untilScene(s, "ep1.monday");
    const texts = viewScene(c, s.scenes)!.lines.map((l) => l.text);
    expect(texts.some((t) => /walking off halfway/.test(t))).toBe(true);
    expect(texts.some((t) => /winning Knockout/.test(t))).toBe(false);
  });

  it("watching from the side is a real route too, and a game that never started can be cancelled without a trace", () => {
    const s = joinedSession({ seed: 8 });
    const c = s.campaign;
    untilScene(s, "ep1.homeroom");
    const r = chooseInScene(c, s.scenes, "ep1.homeroom.watch");
    expect(r.ok && r.next?.scene.id).toBe("ep1.recess_watch");
    expect(c.story.facts.ep1_recess).toBe("watched");
    expect(c.story.ledger).toHaveLength(0);
    continueScene(c, s.scenes);
    expect(c.scene).toBe("ep1.project_assign");
    untilScene(s, "ep1.presentation");
    launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 0);
    expect(c.pending).not.toBeNull();
    expect(cancelMinigame(c)).toBe(true);
    expect(c.pending).toBeNull();
    expect(c.story.ledger).toHaveLength(0);
    expect(viewScene(c, s.scenes)!.minigame).not.toBeNull();
    // A tampered result never reaches the ledger.
    const gp = gpOf(launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 0));
    start(gp);
    playGp(gp, GP_PERFECT);
    (gp.result as { outcomeTier: string }).outcomeTier = "legendary";
    expect(completeMinigame(c, s.scenes, gp)).toEqual({ ok: false, reason: "invalid" });
    expect(c.story.ledger).toHaveLength(0);
    expect(c.pending).not.toBeNull();
  });

  it("drains the whole episode hands-off from a fresh save, for every campaign", () => {
    for (const kind of ["boys", "girls"] as const) {
      const s = joinedSession({ kind, seed: 21 });
      const c = s.campaign;
      untilScene(s, "ep1.homeroom");
      const seen = new Set<string>();
      for (let i = 0; i < 60 && !seen.has("ep1.monday"); i++) {
        if (c.scene) {
          seen.add(c.scene);
          if (c.scene === "ep1.monday") break;
          for (const id of drainScenes(s)) seen.add(id);
          continue;
        }
        if (takeQueuedScene(c, s.scenes)) continue;
        const acts = slotActions(c);
        const match = acts.find((a) => a.launch?.kind === "match");
        if (match) {
          playOfficialMatch(s);
          continue;
        }
        const pick = acts.find((a) => !a.launch) ?? acts[0]!;
        const t = takeAction(c, pick.id);
        if (!t.ok) throw new Error(t.reason);
      }
      expect([...seen]).toEqual(expect.arrayContaining(["ep1.homeroom", "ep1.project_assign", "ep1.coach_lesson", "ep1.presentation", "ep1.home_decision", "ep1.monday"]));
      expect(validateLedger(c.story.ledger)).toEqual([]);
      expect(c.story.ledger.filter((e) => e.kind === "minigame").length).toBeGreaterThanOrEqual(1);
      expect(c.story.ledger.some((e) => e.kind === "match")).toBe(true);
    }
  });
});
