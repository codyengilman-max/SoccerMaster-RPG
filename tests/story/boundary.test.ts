import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { PLAYER_ID, resolvePerson } from "../../src/campaign/campaign";
import { campaignMatchConfig } from "../../src/campaign/match";
import type { Fixture } from "../../src/calendar/competitions";
import { createRuntime, frame, liveAnchor, select, setAccessible, tapTarget } from "../../src/match/runtime";
import { DEFAULT_ACCESSIBILITY } from "../../src/minigame/contract";
import { start } from "../../src/minigame/machine";
import { adjustRelation } from "../../src/story/memory";
import { completeMinigame, launchMinigame } from "../../src/story/episode";
import { chooseInScene, continueScene, takeQueuedScene, viewScene } from "../../src/story/flow";
import { LESSON_FACTS, lessonById, lessonFacts, lessonMoments } from "../../src/story/lesson";
import { buildReport } from "../../src/match/report";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { pacingFor } from "../../src/tactics/recognition";
import { ROLE_BY_NUMBER } from "../../src/sim/types";
import { slotActions, takeAction } from "../../src/campaign/week";
import type { Session } from "../../src/app/session";
import { joinedSession } from "../campaign/joined";
import { playGp, playWckPerfect, GP_PERFECT, type GpSession, type WckSession } from "../minigame/helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);

/**
 * Engine boundary (Story Engine v2 §3): the soccer engine is the only authority for official-match
 * actions, grades, probabilities, scores and next states. Nothing a minigame or the story records
 * may reach any of those — proven here by playing the same fixture with and without a week of
 * story consequences and requiring an identical match.
 */

function toHomeroom(s: Session): void {
  const c = s.campaign;
  for (let i = 0; i < 60 && c.scene !== "ep1.homeroom"; i++) {
    if (c.scene) {
      const v = viewScene(c, s.scenes)!;
      if (v.choices.length) chooseInScene(c, s.scenes, v.choices[0]!.id);
      else continueScene(c, s.scenes);
      continue;
    }
    if (takeQueuedScene(c, s.scenes)) continue;
    const acts = slotActions(c);
    const r = takeAction(c, (acts.find((a) => !a.launch) ?? acts[0]!).id);
    if (!r.ok) throw new Error(r.reason);
  }
  if (c.scene !== "ep1.homeroom") throw new Error("homeroom not reached");
}

/** Play the next Batavia fixture through the real runtime, deterministic accessible input, and return the report. */
function playFixture(s: Session) {
  const c = s.campaign;
  const fixture = c.competitions.fixtures.find((f: Fixture) => !f.result && (f.homeClubId === "batavia" || f.awayClubId === "batavia"))!;
  const cfg = campaignMatchConfig(c, fixture);
  const rt = createRuntime(cfg, catalog, { pacing: pacingFor(ROLE_BY_NUMBER[c.player.position]) });
  setAccessible(rt, true);
  rt.fast = true;
  for (let i = 0; i < 2_000_000; i++) {
    const r = frame(rt, 1000);
    if (r.opened) {
      const first = r.opened.options[0]!;
      if (!select(rt, first.id) && rt.active) tapTarget(rt, liveAnchor(rt, first) ?? rt.state.ball.pos);
    }
    if (r.finished) break;
  }
  const report = buildReport(rt.state, rt.session.records, { fixtureId: fixture.id, homeClubId: fixture.homeClubId, awayClubId: fixture.awayClubId });
  return { cfg, report, records: rt.session.records };
}

describe("engine boundary: story and minigames cannot touch the official match", () => {
  it("a week of recess wins, presentation grades, relationship swings and memories leaves the official match bit-identical", () => {
    const clean = joinedSession({ seed: 13 });
    const lived = joinedSession({ seed: 13 });
    toHomeroom(clean);
    toHomeroom(lived);
    const cLived = lived.campaign;
    const rival = resolvePerson(cLived.kind, "rival");
    const friend = resolvePerson(cLived.kind, "friend");

    // Pile on everything the story layer is allowed to do.
    chooseInScene(cLived, lived.scenes, "ep1.homeroom.in");
    const wck = launchMinigame(cLived, lived.scenes, DEFAULT_ACCESSIBILITY, 0) as WckSession;
    start(wck);
    playWckPerfect(wck);
    expect(completeMinigame(cLived, lived.scenes, wck).ok).toBe(true);
    continueScene(cLived, lived.scenes);
    // Force the presentation scene rather than walking the calendar, so both campaigns stay on the same day.
    cLived.scene = "ep1.presentation";
    const gp = launchMinigame(cLived, lived.scenes, DEFAULT_ACCESSIBILITY, 0) as GpSession;
    start(gp);
    playGp(gp, GP_PERFECT);
    expect(completeMinigame(cLived, lived.scenes, gp).ok).toBe(true);
    for (const dim of ["trust", "respect", "loyalty", "jealousy", "dependence", "competitive_tension"] as const) {
      adjustRelation(cLived.story.memory, rival, dim, 3);
      adjustRelation(cLived.story.memory, friend, dim, -3);
    }
    cLived.story.facts[LESSON_FACTS.active] = "scan_before_receive";
    cLived.story.facts["mg:world_cup_knockout:plays"] = 99;
    cLived.story.flags.push("boundary_probe");
    expect(cLived.story.ledger.filter((e) => e.kind === "minigame")).toHaveLength(2);
    expect(clean.campaign.story.ledger).toHaveLength(0);
    expect(clean.campaign.day).toBe(cLived.day);

    const a = playFixture(clean);
    const b = playFixture(lived);
    // Same official inputs...
    expect(b.cfg).toEqual(a.cfg);
    expect(JSON.stringify(cLived.roster.attributes)).toBe(JSON.stringify(clean.campaign.roster.attributes));
    // ...same official actions, probabilities, grades and score.
    expect(b.records).toEqual(a.records);
    expect(b.report.score).toEqual(a.report.score);
    expect(b.report.moments).toEqual(a.report.moments);
    expect(b.report.eventId).toBe(a.report.eventId);
    expect({ ...b.report, eventId: "" }).toEqual({ ...a.report, eventId: "" });
  });

  it("minigame and lesson facts live in their own namespaces, so no match input can read them by accident", () => {
    const s = joinedSession({ seed: 2 });
    toHomeroom(s);
    const c = s.campaign;
    chooseInScene(c, s.scenes, "ep1.homeroom.in");
    const wck = launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 0) as WckSession;
    start(wck);
    playWckPerfect(wck);
    const done = completeMinigame(c, s.scenes, wck);
    expect(done.ok).toBe(true);
    const written = Object.keys(c.story.facts).filter((k) => k.startsWith("mg:"));
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((k) => k.startsWith("mg:"))).toBe(true);
    expect(Object.values(LESSON_FACTS).every((k) => k.startsWith("lesson:"))).toBe(true);
    // A result's relationship effects are the only channel out, and they target people, not players' attributes.
    if (done.ok) {
      for (const e of done.result.relationshipEffects) {
        expect(["trust", "respect", "loyalty", "jealousy", "dependence", "competitive_tension"]).toContain(e.dimension);
        expect(e.personId).not.toBe(PLAYER_ID);
      }
    }
  });

  it("the lesson layer can only read moments the engine recorded — it cannot add, grade or re-grade one", () => {
    const lesson = lessonById("scan_before_receive")!;
    const empty = buildReport(
      // A finished report with no faced moments.
      { ...createRuntime(campaignMatchConfig(joinedSession({ seed: 1 }).campaign, joinedSession({ seed: 1 }).campaign.competitions.fixtures.find((f) => f.homeClubId === "batavia" || f.awayClubId === "batavia")!), catalog).state },
      [],
      { fixtureId: null, homeClubId: "batavia", awayClubId: "x" },
    );
    expect(lessonMoments(lesson, "CM", empty)).toEqual([]);
    const facts = lessonFacts(lesson, "CM", empty, 4);
    expect(facts).toContainEqual({ type: "set_fact", id: LESSON_FACTS.verdict, value: "not_faced" });
    expect(facts).toContainEqual({ type: "set_fact", id: LESSON_FACTS.faced, value: 0 });
    expect(facts).toContainEqual({ type: "set_fact", id: LESSON_FACTS.facedTotal, value: 4 });
    // Every effect the lesson emits is a fact or a knowledge entry — never a relation, attribute or score change.
    expect(facts.every((f) => f.type === "set_fact" || f.type === "learn")).toBe(true);
  });
});
