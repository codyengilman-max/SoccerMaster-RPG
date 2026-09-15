import { beforeAll, describe, expect, it } from "vitest";
import clubsFile from "../../content/story/clubs.json";
import tryoutRules from "../../content/rules/tryouts-u11.json";
import { resumeSession, type Session } from "../../src/app/session";
import { dayOfIso, formatDay, weekday } from "../../src/calendar/date";
import { commitmentsOn, markAttended } from "../../src/calendar/schedule";
import { advanceDays, FRIEND_ID, PLAYER_ID, playerClubId, TRYOUTS_DAY, type CampaignState } from "../../src/campaign/campaign";
import { SEASON_FACTS, seasonReviewDay } from "../../src/campaign/season";
import {
  acceptOffer,
  createTryoutState,
  declineOffer,
  destinationClubs,
  decideOffers,
  expireOffers,
  issueInvitations,
  nextRoster,
  planTryouts,
  recordTryoutSession,
  recruitPromiseId,
  requirementViews,
  sessionOptions,
  syncTryouts,
  TRYOUT_FACTS,
  TRYOUT_SCENES,
  tryoutClubs,
  tryoutPhase,
  tryoutsView,
  tryoutsWeekStart,
} from "../../src/campaign/tryouts";
import { campaignMatchConfig, fixtureById } from "../../src/campaign/match";
import { completeMatch, completeTryout, slotActions, takeAction } from "../../src/campaign/week";
import { buildReport } from "../../src/match/report";
import { isPoolPlayer, openPlaces, rosterOf } from "../../src/roster/roster";
import { runHeadless as runMatch } from "../../src/sim/engine";
import { deserialize, MemoryStore, migrate, SAVE_VERSION, serialize } from "../../src/save/save";
import { chooseInScene, takeQueuedScene, viewScene } from "../../src/story/flow";
import { createDrill, runHeadless, summarize, type Summary } from "../../src/training/smallSided";
import { drainScenes, joinedSession } from "./joined";

const D = dayOfIso;
const HOME = "batavia";
const DESTINATIONS = ["camelback", "mesaverde", "redrock", "saguaro", "sonoran"];

const PRE_SLOT = "pre-review";

/** Play a pending league/tournament match headlessly and complete it, so match evidence is real. */
function playMatch(c: CampaignState): void {
  const p = c.pending;
  if (!p || p.kind !== "match") throw new Error("no match pending");
  const fx = fixtureById(c, p.fixtureId);
  const st = runMatch(campaignMatchConfig(c, fx));
  completeMatch(c, buildReport(st, [], { fixtureId: fx.id, homeClubId: fx.homeClubId, awayClubId: fx.awayClubId, isPool: isPoolPlayer }));
}

/**
 * Play the U11 season to the season review: every training attended, every match played (so attendance,
 * match and coach evidence are genuine). Saves the day before the review under `PRE_SLOT` and the review day
 * as the autosave.
 */
function seasonEnd(store: MemoryStore): Session {
  const s = joinedSession({}, store);
  const c = s.campaign;
  const review = seasonReviewDay(c);
  while (c.day < review) {
    drain(s);
    for (const k of commitmentsOn(c.schedule, c.day)) if (k.kind === "training" && k.status === "scheduled") markAttended(c.schedule, k.id);
    let guard = 0;
    while (guard++ < 4) {
      const a = slotActions(c).find((x) => x.id === "play_match");
      if (!a || !takeAction(c, a.id).ok) break;
      playMatch(c);
      drain(s);
    }
    if (c.day === review - 1) store.write(PRE_SLOT, serialize(c, PRE_SLOT));
    advanceDays(c, 1);
  }
  drain(s);
  expect(c.story.facts[SEASON_FACTS.reviewed]).toBe(true);
  s.save();
  return s;
}

function drain(s: Session): string[] {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 30 && (s.campaign.scene || takeQueuedScene(s.campaign, s.scenes))) seen.push(...drainScenes(s));
  return seen;
}

function liveTo(s: Session, day: number): string[] {
  const seen: string[] = [];
  while (s.campaign.day < day) {
    seen.push(...drain(s));
    advanceDays(s.campaign, 1);
  }
  seen.push(...drain(s));
  return seen;
}

/** A session played well: every rep the best read, clean execution. */
const strongSession = (c: CampaignState, activity: "1v1" | "2v2" | "3v2", salt = 0): Summary =>
  summarize(runHeadless(createDrill(activity, c.seed ^ c.day ^ salt, { reps: 6 }), (_d, o) => ({ optionId: [...o].sort((a, b) => b.score - a.score)[0]!.id, accuracy: 0.9 })));

/** A session played badly: the worst read every rep, loose execution. */
const weakSession = (c: CampaignState, activity: "1v1" | "2v2" | "3v2"): Summary =>
  summarize(runHeadless(createDrill(activity, c.seed ^ c.day, { reps: 6 }), (_d, o) => ({ optionId: [...o].sort((a, b) => a.score - b.score)[0]!.id, accuracy: 0.1 })));

const seasonStore = new MemoryStore();
let base: Session;
beforeAll(() => {
  base = seasonEnd(seasonStore);
}, 300_000);

/** A fresh copy of the season-end campaign on the review Monday (the save round-trips, so the copy is exact). */
const fresh = (): Session => resumeSession(seasonStore)!;
/** A fresh copy of the day before the review: nothing about tryouts has happened yet. */
const beforeReview = (): Session => resumeSession(seasonStore, PRE_SLOT)!;

/** Fresh copy moved into tryout week, `prep` applied the day before so it shapes invitations. */
function atTryoutWeek(prep?: (c: CampaignState) => void): Session {
  const s = beforeReview();
  const c = s.campaign;
  prep?.(c);
  liveTo(s, tryoutsWeekStart(c));
  expect(c.tryouts.planned).toBe(true);
  return s;
}

/** Fresh copy at the morning after tryouts with the given sessions played; offers decided. */
function withOffers(play: { clubId: string; strong: boolean }[], prep?: (c: CampaignState) => void): Session {
  const s = atTryoutWeek(prep);
  const c = s.campaign;
  liveTo(s, c.tryouts.day);
  for (const { clubId, strong } of play) {
    const opt = sessionOptions(c).find((o) => o.clubId === clubId)!;
    recordTryoutSession(c, clubId, strong ? strongSession(c, opt.activity) : weakSession(c, opt.activity));
  }
  advanceDays(c, 1);
  expect(c.tryouts.offersDecidedDay).toBe(c.day);
  return s;
}

/**
 * Invitations go out the day the pathway unlock is reached, on the evidence of that day. To test a
 * different invitation outcome the test withdraws what went out and sets the tracks the gates read;
 * the next day's sync re-issues them from the new state.
 */
const reinvite =
  (tracks: Partial<CampaignState["progression"]["tracks"]>, unlocked = true) =>
  (c: CampaignState): void => {
    c.tryouts.invitations = [];
    c.story.promises = c.story.promises.filter((p) => !p.id.startsWith("promise.recruit:"));
    delete c.story.facts[TRYOUT_FACTS.invitedClubs];
    delete c.story.facts[TRYOUT_FACTS.inviteCount];
    if (!unlocked) c.progression.unlocked = c.progression.unlocked.filter((u) => u !== "tryout_invitations");
    Object.assign(c.progression.tracks, tracks);
  };

const pathwayUnlocked = reinvite({ pathway: 30, tactical: 60, technical: 60 });

describe("timing", () => {
  it("tryouts are on the authored mid-May Saturday, after the season review", () => {
    expect(TRYOUTS_DAY).toBe(D("2027-05-15"));
    expect(weekday(TRYOUTS_DAY)).toBe("Sat");
    expect(formatDay(base.campaign.tryouts.day)).toBe("Sat 15 May");
    expect(seasonReviewDay(base.campaign)).toBeLessThanOrEqual(tryoutsWeekStart(base.campaign));
    expect(weekday(tryoutsWeekStart(base.campaign))).toBe("Mon");
  });

  it("nothing is planned, invited or offered before tryout week; the week plans rosters and two sessions on the day", () => {
    const s = beforeReview();
    const c = s.campaign;
    expect(c.day).toBe(tryoutsWeekStart(c) - 1);
    expect(["before", "invited"]).toContain(tryoutPhase(c));
    expect(planTryouts(c)).toBe(false);
    expect(decideOffers(c)).toBeNull();
    expect(c.tryouts.offers).toEqual([]);
    expect(nextRoster(c, HOME)).toBeUndefined();
    expect(c.tryouts.planned).toBe(false);
    advanceDays(c, 1);
    expect(c.tryouts.planned).toBe(true);
    expect(tryoutPhase(c)).toBe("week");
    expect(planTryouts(c)).toBe(false);
    const sessions = commitmentsOn(c.schedule, c.tryouts.day).filter((k) => k.kind === "tryout");
    expect(sessions).toHaveLength(tryoutRules.sessionsPerDay);
    expect(sessions.every((k) => !k.mandatory)).toBe(true);
    expect(c.schedule.commitments.filter((k) => k.kind === "training" && k.status === "scheduled" && k.day >= c.day)).toEqual([]);
    expect(drain(s)).toContain(TRYOUT_SCENES.week);
    expect(c.tryouts.offers).toEqual([]);
    liveTo(s, c.tryouts.day);
    expect(tryoutPhase(c)).toBe("day");
    expect(c.tryouts.offersDecidedDay).toBeNull();
  });

  it("the week only opens once the season is reviewed, even on the right Monday", () => {
    const c = beforeReview().campaign;
    c.day = tryoutsWeekStart(c);
    expect(c.story.facts[SEASON_FACTS.reviewed]).toBeUndefined();
    expect(planTryouts(c)).toBe(false);
    c.story.facts[SEASON_FACTS.reviewed] = true;
    expect(planTryouts(c)).toBe(true);
    expect(planTryouts(c)).toBe(false);
  });
});

describe("clubs and capacity", () => {
  it("five fictional destination clubs from the content, never a guest club, never the player's own", () => {
    const c = fresh().campaign;
    expect(destinationClubs(c).map((k) => k.id).sort()).toEqual(DESTINATIONS);
    expect(tryoutClubs(c).map((k) => k.id).sort()).toEqual([HOME, ...DESTINATIONS].sort());
    expect(destinationClubs(c).some((k) => k.guest)).toBe(false);
    const guests = (clubsFile.clubs as { id: string; guest?: boolean }[]).filter((k) => k.guest).map((k) => k.id);
    expect(guests.length).toBeGreaterThan(0);
    for (const g of guests) expect(tryoutClubs(c).map((k) => k.id)).not.toContain(g);
    for (const k of destinationClubs(c)) expect(k.attraction.length).toBeGreaterThan(10);
  });

  it("every club's next-season roster has an explicit capacity and returning players reserved; the view shows the open places", () => {
    const c = atTryoutWeek().campaign;
    for (const rule of tryoutRules.clubs) {
      const r = nextRoster(c, rule.clubId)!;
      expect(r.capacity).toBe(rule.capacity);
      expect(r.reserved).toBe(rule.reserved);
      expect(openPlaces(r)).toBe(rule.capacity - rule.reserved - r.playerIds.length);
    }
    const home = nextRoster(c, HOME)!;
    expect(home.playerIds).not.toContain(PLAYER_ID);
    expect(home.playerIds).not.toContain(FRIEND_ID);
    expect(home.playerIds.length).toBeGreaterThan(0);
    const v = tryoutsView(c);
    for (const k of v.clubs) {
      expect(k.capacity).toBe(nextRoster(c, k.clubId)!.capacity);
      expect(k.places).toBe(openPlaces(nextRoster(c, k.clubId)!));
    }
    expect(v.clubs[0]!.home).toBe(true);
  });
});

describe("invitations, evidence and offers", () => {
  it("no pathway unlock, no invitations; with it the best clubs whose gate holds invite, deterministically, up to the count", () => {
    const locked = atTryoutWeek(reinvite({ pathway: 0 }, false)).campaign;
    expect(locked.progression.unlocked).not.toContain("tryout_invitations");
    expect(locked.tryouts.invitations).toEqual([]);
    expect(issueInvitations(locked)).toEqual([]);
    const t = atTryoutWeek(pathwayUnlocked).campaign;
    expect(t.tryouts.invitations.length).toBeLessThanOrEqual(tryoutRules.inviteCount);
    expect(t.tryouts.invitations).toContain("sonoran");
    expect(t.tryouts.invitations).not.toContain(HOME);
    expect(t.story.facts[TRYOUT_FACTS.inviteCount]).toBe(t.tryouts.invitations.length);
    const again = atTryoutWeek(pathwayUnlocked).campaign;
    expect(again.tryouts.invitations).toEqual(t.tryouts.invitations);
    expect(again.story.facts[TRYOUT_FACTS.invitedClubs]).toBe(t.story.facts[TRYOUT_FACTS.invitedClubs]);
  });

  it("an invitation records the recruiter's promise as a promise, not an offer", () => {
    const c = atTryoutWeek(pathwayUnlocked).campaign;
    const p = c.story.promises.find((x) => x.id === recruitPromiseId("sonoran"))!;
    expect(p).toBeDefined();
    expect(p.by).toBe("sonoran-coach");
    expect(p.delivered).toBe(false);
    expect(p.brokenDay).toBeUndefined();
    expect(c.tryouts.offers).toEqual([]);
    expect(tryoutsView(c).clubs.find((k) => k.clubId === "sonoran")!.promise?.status).toBe("open");
  });

  it("session evidence exists only once the session is played, and story facts cannot fake it", () => {
    const s = atTryoutWeek();
    const c = s.campaign;
    liveTo(s, c.tryouts.day);
    const before = requirementViews(c, "saguaro", tryoutRules.clubs.find((r) => r.clubId === "saguaro")!.requires as never);
    expect(before.map((r) => r.value)).toEqual([null]);
    expect(before[0]!.met).toBe(false);
    c.story.facts["tryout_last_reads"] = "sharp";
    expect(requirementViews(c, "saguaro", before)[0]!.value).toBeNull();
    recordTryoutSession(c, "saguaro", strongSession(c, "2v2"));
    const after = requirementViews(c, "saguaro", before);
    expect(after[0]!.value).toBeGreaterThan(0);
    expect(c.tryouts.sessions.map((x) => x.clubId)).toEqual(["saguaro"]);
    expect(requirementViews(c, "redrock", tryoutRules.clubs.find((r) => r.clubId === "redrock")!.requires as never).some((r) => r.value === null)).toBe(true);
  });

  it("the tryout day offers one action per club still to try, launches a playable session, and the second slot allows another club", () => {
    const s = atTryoutWeek();
    const c = s.campaign;
    liveTo(s, c.tryouts.day);
    const actions = slotActions(c);
    const tryouts = actions.filter((a) => a.id === "tryout");
    expect(tryouts.map((a) => a.clubId).sort()).toEqual(DESTINATIONS);
    expect(actions.some((a) => a.id === "skip_tryout")).toBe(true);
    expect(takeAction(c, "tryout").ok).toBe(true);
    expect(c.pending?.kind).toBe("tryout");
    c.pending = null;
    const r = takeAction(c, "tryout", "mesaverde");
    expect(r.ok && r.launch?.kind === "tryout" && r.launch.clubId === "mesaverde").toBe(true);
    const done = completeTryout(c, strongSession(c, "2v2"));
    expect(done.effects.some((e) => e.type === "track" && e.track === "pathway")).toBe(true);
    expect(c.tryouts.sessions).toHaveLength(1);
    expect(c.schedule.commitments.find((k) => k.kind === "tryout" && k.status === "attended")).toBeDefined();
    expect(slotActions(c).filter((a) => a.id === "tryout").map((a) => a.clubId)).not.toContain("mesaverde");
    expect(tryoutsView(c).sessionsLeft).toBe(1);
  });

  it("offers need every requirement to hold and an open place; nothing offers without the session it asked for", () => {
    const s = withOffers([{ clubId: "saguaro", strong: true }], (c) => {
      pathwayUnlocked(c);
      c.progression.tracks.technical = 10;
    });
    const c = s.campaign;
    const ids = c.tryouts.offers.map((o) => o.clubId);
    expect(ids).toContain("saguaro");
    expect(ids).not.toContain("redrock");
    expect(ids).not.toContain("camelback");
    expect(ids).not.toContain("mesaverde");
    expect(ids).toContain(HOME);
    for (const o of c.tryouts.offers) {
      expect(o.status).toBe("open");
      expect(o.expiresDay).toBe(c.day + tryoutRules.decisionDays);
      expect(o.placesAtOffer).toBeGreaterThan(0);
    }
    expect(c.story.facts[TRYOUT_FACTS.offerCount]).toBe(ids.length);
    expect(drain(s)).toContain(TRYOUT_SCENES.offers);
  });

  it("a weak session earns no offer; a full roster earns none even with the evidence", () => {
    const weak = withOffers([{ clubId: "saguaro", strong: false }]).campaign;
    expect(weak.tryouts.offers.map((o) => o.clubId)).not.toContain("saguaro");
    const s = atTryoutWeek();
    const c = s.campaign;
    const r = nextRoster(c, "saguaro")!;
    r.reserved = r.capacity;
    liveTo(s, c.tryouts.day);
    recordTryoutSession(c, "saguaro", strongSession(c, "2v2"));
    expect(tryoutsView(c).clubs.find((k) => k.clubId === "saguaro")!.eligible).toBe(true);
    advanceDays(c, 1);
    expect(c.tryouts.offers.map((o) => o.clubId)).not.toContain("saguaro");
  });

  it("no offer at all: the no-offer scene plays, the player is unattached and the friend re-signs at home", () => {
    const s = withOffers([], (c) => {
      for (const k of c.schedule.commitments) if (k.kind === "training" && k.status === "attended") k.status = "missed";
    });
    const c = s.campaign;
    expect(c.tryouts.offers).toEqual([]);
    expect(drain(s)).toContain(TRYOUT_SCENES.noOffer);
    expect(c.story.facts[TRYOUT_FACTS.unattached]).toBe(true);
    expect(tryoutPhase(c)).toBe("unattached");
    expect(c.tryouts.friendClubId).toBe(HOME);
  });
});

describe("promises are not offers", () => {
  it("a recruiter's promise kept by an offer is delivered by the offer and broken by its absence, with a scene", () => {
    const kept = withOffers([{ clubId: "sonoran", strong: true }], pathwayUnlocked).campaign;
    const kp = kept.story.promises.find((p) => p.id === recruitPromiseId("sonoran"))!;
    expect(kept.tryouts.offers.map((o) => o.clubId)).toContain("sonoran");
    expect(kp.delivered).toBe(true);
    expect(kp.brokenDay).toBeUndefined();

    const s = withOffers([{ clubId: "saguaro", strong: true }], pathwayUnlocked);
    const broken = s.campaign;
    const bp = broken.story.promises.find((p) => p.id === recruitPromiseId("sonoran"))!;
    expect(broken.tryouts.offers.map((o) => o.clubId)).not.toContain("sonoran");
    expect(bp.delivered).toBe(false);
    expect(bp.brokenDay).toBe(broken.day);
    expect(broken.story.facts[TRYOUT_FACTS.brokenClub]).toBe("Sonoran United");
    expect(tryoutsView(broken).clubs.find((k) => k.clubId === "sonoran")!.promise?.status).toBe("broken");
    const seen = liveTo(s, broken.day + 1);
    expect(seen).toContain(TRYOUT_SCENES.promiseBroken);
  });

  it("a promise about next season stays open whether or not the club offers", () => {
    const c = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked).campaign;
    expect(c.tryouts.invitations).toContain("camelback");
    expect(c.tryouts.offers.map((o) => o.clubId)).toContain("camelback");
    const p = c.story.promises.find((x) => x.id === recruitPromiseId("camelback"))!;
    expect(p.delivered).toBe(false);
    expect(p.brokenDay).toBeUndefined();
    expect(tryoutsView(c).clubs.find((k) => k.clubId === "camelback")!.promise?.keptBy).toBe("next_season");
  });
});

describe("the decision", () => {
  const snapshot = (c: CampaignState) => ({
    person: JSON.parse(JSON.stringify(c.roster.people.find((p) => p.id === PLAYER_ID))) as Record<string, unknown>,
    attributes: JSON.parse(JSON.stringify(c.roster.attributes[PLAYER_ID] ?? null)) as unknown,
    position: c.player.position,
    tracks: { ...c.progression.tracks },
    relationships: { ...c.progression.relationships },
    knowledge: JSON.parse(JSON.stringify(c.story.knowledge)) as Record<string, string[]>,
  });

  it("accepting moves the player to the destination's next-season roster and nowhere else; the person is untouched", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked);
    const c = s.campaign;
    drain(s);
    const before = snapshot(c);
    const r = acceptOffer(c, "camelback");
    expect(r).toMatchObject({ ok: true, clubId: "camelback", moved: true });
    expect(playerClubId(c)).toBe("camelback");
    expect(nextRoster(c, "camelback")!.playerIds).toContain(PLAYER_ID);
    expect(c.roster.rosters.filter((x) => x.playerIds.includes(PLAYER_ID))).toHaveLength(1);
    expect(rosterOf(c.roster, HOME, "U11")!.playerIds).not.toContain(PLAYER_ID);
    expect(c.tryouts.decided).toEqual({ clubId: "camelback", from: HOME, day: c.day });
    expect(c.tryouts.offers.find((o) => o.clubId === "camelback")!.status).toBe("accepted");
    expect(c.tryouts.offers.filter((o) => o.clubId !== "camelback").every((o) => o.status === "declined")).toBe(true);
    const after = snapshot(c);
    expect({ ...after.person, clubId: HOME }).toEqual(before.person);
    expect(after.attributes).toEqual(before.attributes);
    expect(after.position).toBe(before.position);
    expect(after.tracks).toEqual(before.tracks);
    expect(after.relationships).toEqual(before.relationships);
    for (const [id, facts] of Object.entries(before.knowledge)) expect(after.knowledge[id]).toEqual(expect.arrayContaining(facts));
    expect(acceptOffer(c, "camelback")).toEqual({ ok: false, reason: "decided" });
    expect(acceptOffer(c, HOME)).toEqual({ ok: false, reason: "decided" });
    expect(tryoutsView(c).decided).toEqual({ clubId: "camelback", name: "Camelback Athletic", moved: true });
    expect(drain(s)).toContain(TRYOUT_SCENES.leave);
  });

  it("staying is an explicit acceptance of the home club's offer", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked);
    const c = s.campaign;
    drain(s);
    expect(acceptOffer(c, HOME)).toMatchObject({ ok: true, moved: false });
    expect(playerClubId(c)).toBe(HOME);
    expect(nextRoster(c, HOME)!.playerIds).toContain(PLAYER_ID);
    expect(nextRoster(c, "camelback")!.playerIds).not.toContain(PLAYER_ID);
    expect(tryoutsView(c).decided?.moved).toBe(false);
    expect(drain(s)).toContain(TRYOUT_SCENES.stay);
  });

  it("an offer alone changes nothing: the roster only moves on acceptance, and a place that has gone refuses", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked);
    const c = s.campaign;
    expect(playerClubId(c)).toBe(HOME);
    expect(nextRoster(c, "camelback")!.playerIds).not.toContain(PLAYER_ID);
    const r = nextRoster(c, "camelback")!;
    r.reserved = r.capacity;
    expect(acceptOffer(c, "camelback")).toEqual({ ok: false, reason: "full" });
    expect(c.tryouts.decided).toBeNull();
    expect(c.tryouts.offers.find((o) => o.clubId === "camelback")!.status).toBe("open");
    expect(playerClubId(c)).toBe(HOME);
  });

  it("declining one offer leaves the others open; declining them all leaves the player unattached", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked);
    const c = s.campaign;
    drain(s);
    expect(declineOffer(c, "camelback")).toEqual({ ok: true });
    expect(c.tryouts.offers.find((o) => o.clubId === "camelback")!.status).toBe("declined");
    expect(c.tryouts.offers.find((o) => o.clubId === HOME)!.status).toBe("open");
    expect(c.tryouts.decided).toBeNull();
    expect(declineOffer(c, "camelback")).toEqual({ ok: false, reason: "not_open" });
    expect(declineOffer(c, HOME)).toEqual({ ok: true });
    expect(c.story.facts[TRYOUT_FACTS.unattached]).toBe(true);
    expect(tryoutPhase(c)).toBe("unattached");
    expect(acceptOffer(c, HOME)).toEqual({ ok: false, reason: "not_open" });
    expect(drain(s)).toContain(TRYOUT_SCENES.declinedAll);
    expect(c.tryouts.friendClubId).toBe(HOME);
  });

  it("offers lapse after the decision window; a lapsed offer cannot be accepted", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked);
    const c = s.campaign;
    drain(s);
    const deadline = tryoutsView(c).deadline!;
    expect(deadline).toBe(c.day + tryoutRules.decisionDays);
    liveTo(s, deadline);
    expect(c.tryouts.offers.every((o) => o.status === "open")).toBe(true);
    expect(expireOffers(c)).toEqual([]);
    advanceDays(c, 1);
    expect(c.tryouts.offers.every((o) => o.status === "expired")).toBe(true);
    expect(acceptOffer(c, "camelback")).toEqual({ ok: false, reason: "expired" });
    expect(c.story.facts[TRYOUT_FACTS.unattached]).toBe(true);
    expect(drain(s)).toContain(TRYOUT_SCENES.expired);
    expect(playerClubId(c)).toBe(HOME);
    expect(c.roster.rosters.filter((r) => r.ageGroup === "U12").some((r) => r.playerIds.includes(PLAYER_ID))).toBe(false);
  });
});

describe("friendships across clubs", () => {
  it("with the 'together' stance the friend follows to a destination with a place; the friendship value does not move", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], (c) => {
      pathwayUnlocked(c);
      c.story.facts["tryout_stance"] = "together";
    });
    const c = s.campaign;
    drain(s);
    const friendship = c.progression.relationships[FRIEND_ID];
    acceptOffer(c, "camelback");
    expect(c.tryouts.friendClubId).toBe("camelback");
    expect(nextRoster(c, "camelback")!.playerIds).toEqual(expect.arrayContaining([PLAYER_ID, FRIEND_ID]));
    expect(c.story.facts[TRYOUT_FACTS.friendApart]).toBe(false);
    expect(c.progression.relationships[FRIEND_ID]).toBe(friendship);
    expect(tryoutsView(c).friend).toEqual({ name: c.roster.people.find((p) => p.id === FRIEND_ID)!.name, clubName: "Camelback Athletic", apart: false });
    expect(liveTo(s, c.day + 1)).toContain(TRYOUT_SCENES.friendWith);
  });

  it("without it the friend re-signs at home and the friendship survives the split with its knowledge intact", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], (c) => {
      pathwayUnlocked(c);
      c.story.facts["tryout_stance"] = "own_path";
    });
    const c = s.campaign;
    drain(s);
    const friendship = c.progression.relationships[FRIEND_ID];
    const known = [...(c.story.knowledge[FRIEND_ID] ?? [])];
    expect(known.length).toBeGreaterThan(0);
    acceptOffer(c, "camelback");
    expect(c.tryouts.friendClubId).toBe(HOME);
    expect(nextRoster(c, HOME)!.playerIds).toContain(FRIEND_ID);
    expect(nextRoster(c, "camelback")!.playerIds).not.toContain(FRIEND_ID);
    expect(c.story.facts[TRYOUT_FACTS.friendApart]).toBe(true);
    expect(c.progression.relationships[FRIEND_ID]).toBe(friendship);
    expect(c.story.knowledge[FRIEND_ID]).toEqual(expect.arrayContaining(known));
    expect(c.roster.people.find((p) => p.id === FRIEND_ID)!.clubId).toBe(HOME);
    expect(tryoutsView(c).friend?.apart).toBe(true);
    expect(liveTo(s, c.day + 1)).toContain(TRYOUT_SCENES.friendApart);
  });

  it("the friend cannot follow into a full roster", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], (c) => {
      pathwayUnlocked(c);
      c.story.facts["tryout_stance"] = "together";
    });
    const c = s.campaign;
    const r = nextRoster(c, "camelback")!;
    r.reserved = r.capacity - 1;
    expect(acceptOffer(c, "camelback").ok).toBe(true);
    expect(c.tryouts.friendClubId).toBe(HOME);
    expect(openPlaces(r)).toBe(0);
  });
});

describe("saves", () => {
  it("tryout state, offers, promises, rosters and the changed club all survive a save and resume", () => {
    const store = new MemoryStore();
    const s = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked);
    const c = s.campaign;
    drain(s);
    acceptOffer(c, "camelback");
    store.write("a", serialize(c, "a"));
    const r = resumeSession(store, "a")!;
    expect(r.campaign).toEqual(JSON.parse(JSON.stringify(c)));
    expect(r.campaign.tryouts.decided?.clubId).toBe("camelback");
    expect(playerClubId(r.campaign)).toBe("camelback");
    expect(r.campaign.story.promises.find((p) => p.id === recruitPromiseId("sonoran"))?.brokenDay).toBeDefined();
    expect(tryoutsView(r.campaign)).toEqual(tryoutsView(c));
  });

  it("a v3 save gains an empty tryout state on the authored day and the recruiters", () => {
    const c = fresh().campaign;
    const old = JSON.parse(serialize(c, "a")) as { version: number; campaign: Record<string, unknown> };
    old.version = 3;
    delete old.campaign["tryouts"];
    const people = (old.campaign["roster"] as { people: { id: string }[] }).people;
    (old.campaign["roster"] as { people: { id: string }[] }).people = people.filter((p) => !p.id.endsWith("-coach"));
    const migrated = migrate(old as unknown as Record<string, unknown>) as unknown as { version: number; campaign: CampaignState };
    expect(migrated.version).toBe(SAVE_VERSION);
    expect(migrated.campaign.tryouts).toEqual(createTryoutState(TRYOUTS_DAY));
    expect(migrated.campaign.roster.people.some((p) => p.id === "sonoran-coach")).toBe(true);
    const loaded = deserialize(JSON.stringify(old)).campaign;
    expect(loaded.tryouts.day).toBe(TRYOUTS_DAY);
    expect(syncTryouts(loaded)).toBeUndefined();
  });
});

describe("authored content", () => {
  it("every tryout scene is a proposal, and the offers scene reads the offer facts rather than inventing them", () => {
    const s = withOffers([{ clubId: "camelback", strong: true }], pathwayUnlocked);
    const c = s.campaign;
    takeQueuedScene(c, s.scenes);
    const v = viewScene(c, s.scenes)!;
    expect(v.scene.id).toBe(TRYOUT_SCENES.offers);
    expect(v.scene.reviewStatus).toBe("proposal");
    const text = v.lines.map((l) => l.text).join(" ");
    expect(text).toContain("Camelback Athletic");
    expect(text).not.toContain("Saguaro");
    expect(v.choices.length).toBeGreaterThan(0);
    const before = { offers: JSON.parse(JSON.stringify(c.tryouts.offers)) as unknown, club: playerClubId(c) };
    chooseInScene(c, s.scenes, v.choices[0]!.id);
    expect(c.tryouts.offers).toEqual(before.offers);
    expect(playerClubId(c)).toBe(before.club);
    expect(c.tryouts.decided).toBeNull();
  });
});
