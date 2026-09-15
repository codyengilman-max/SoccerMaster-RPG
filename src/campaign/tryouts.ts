import tryoutsFile from "../../content/rules/tryouts-u11.json";
import type { AgeGroup } from "../calendar/competitions";
import { formatDay, type CampaignDay } from "../calendar/date";
import { addCommitment, attendance, slotsFor, type Slot } from "../calendar/schedule";
import { joinRoster, openPlaces, rosterOf, type Club, type Roster } from "../roster/roster";
import { applyEffect, type Effect } from "../story/consequences";
import type { Summary as SmallSidedSummary } from "../training/smallSided";
import { resolvePerson, type CampaignState } from "./campaign";
import { seasonSummary, SEASON_FACTS } from "./season";
import { FRIEND_ID, HOME_CLUB_ID, PLAYER_ID, playerClubId, storyContext, touch } from "./state";

/**
 * Season-end tryouts and the first transfer opportunity (spec §18). Every club builds next
 * season's roster with an explicit capacity; a club offers a place only when its authored evidence
 * requirements hold against verified campaign state and it still has an open place. Invitations
 * and recruiters' promises are recorded when they are made; an offer is a separate record; a
 * transfer happens only when the user accepts an offer and the roster module admits them. Story
 * text reads this state — it never creates it.
 */

export type SessionActivity = "1v1" | "2v2" | "3v2";
export type EvidenceKey =
  | "attendance"
  | "matches"
  | "goals"
  | "technical"
  | "tactical"
  | "physical"
  | "school"
  | "responsibility"
  | "pathway"
  | "coach"
  | "session_reads"
  | "session_touch";

export interface Requirement {
  evidence: EvidenceKey;
  min: number;
}

export interface ClubRule {
  clubId: string;
  capacity: number;
  reserved: number;
  recruiter: string;
  session: SessionActivity | null;
  invites: boolean;
  invitesWhen: Requirement[];
  requires: Requirement[];
  promise: { text: string; keptBy: "offer" | "next_season" } | null;
}

interface RulesFile {
  nextAgeGroup: AgeGroup;
  sessionsPerDay: number;
  decisionDays: number;
  inviteCount: number;
  evidence: Record<EvidenceKey, string>;
  clubs: {
    clubId: string;
    capacity: number;
    reserved: number;
    recruiter: string;
    session: string | null;
    invites: boolean;
    invitesWhen?: { evidence: string; min: number }[];
    requires: { evidence: string; min: number }[];
    promise: { text: string; keptBy: string } | null;
  }[];
}

const rules = tryoutsFile as unknown as RulesFile;

const asReq = (r: { evidence: string; min: number }): Requirement => ({ evidence: r.evidence as EvidenceKey, min: r.min });

export const CLUB_RULES: readonly ClubRule[] = rules.clubs.map((k) => ({
  clubId: k.clubId,
  capacity: k.capacity,
  reserved: k.reserved,
  recruiter: k.recruiter,
  session: (k.session as SessionActivity | null) ?? null,
  invites: k.invites,
  invitesWhen: (k.invitesWhen ?? []).map(asReq),
  requires: k.requires.map(asReq),
  promise: k.promise ? { text: k.promise.text, keptBy: k.promise.keptBy === "offer" ? "offer" : "next_season" } : null,
}));

export const NEXT_AGE_GROUP: AgeGroup = rules.nextAgeGroup;
export const DECISION_DAYS: number = rules.decisionDays;
export const SESSIONS_PER_DAY: number = rules.sessionsPerDay;
export const INVITE_COUNT: number = rules.inviteCount;
export const EVIDENCE_LABEL: Readonly<Record<EvidenceKey, string>> = rules.evidence;
export const INVITATIONS_UNLOCK = "tryout_invitations";

export const TRYOUT_FACTS = {
  invitedClubs: "tryout_invited_clubs",
  inviteCount: "tryout_invite_count",
  week: "tryouts_week",
  sessionsPlayed: "tryout_sessions_played",
  lastClub: "tryout_last_club",
  lastReads: "tryout_last_reads",
  lastTouch: "tryout_last_touch",
  offersDecided: "tryout_offers_decided",
  offerCount: "tryout_offer_count",
  offersList: "tryout_offers",
  offerHome: "tryout_offer_home",
  brokenClub: "tryout_promise_broken_club",
  nextClub: "tryout_next_club",
  friendClub: "tryout_friend_club",
  friendApart: "tryout_friend_apart",
  unattached: "tryout_unattached",
  strikerClub: "tryout_striker_club",
} as const;

export const TRYOUT_SCENES = {
  week: "tryouts.week",
  day: "tryouts.day",
  offers: "tryouts.offers",
  noOffer: "tryouts.no_offer",
  promiseBroken: "tryouts.promise_broken",
  stay: "tryouts.stay",
  leave: "tryouts.leave",
  friendApart: "tryouts.friend_apart",
  friendWith: "tryouts.friend_with",
  expired: "tryouts.expired",
  declinedAll: "tryouts.declined_all",
} as const;

export const recruitPromiseId = (clubId: string): string => `promise.recruit:${clubId}`;

// ------------------------------------------------------------ state

export interface TryoutSession {
  clubId: string;
  day: CampaignDay;
  activity: SessionActivity;
  reps: number;
  strongReads: number;
  cleanExecutions: number;
}

export type OfferStatus = "open" | "accepted" | "declined" | "expired";

export interface TryoutOffer {
  clubId: string;
  madeDay: CampaignDay;
  expiresDay: CampaignDay;
  /** Open places on the club's next-season roster when the offer was made. */
  placesAtOffer: number;
  status: OfferStatus;
}

export interface TryoutState {
  /** The authored tryout date (mid-May). */
  day: CampaignDay;
  /** Next-season rosters exist and returning players are placed. */
  planned: boolean;
  /** Clubs that invited the player, in the order they did. */
  invitations: string[];
  sessions: TryoutSession[];
  offers: TryoutOffer[];
  offersDecidedDay: CampaignDay | null;
  /** Where the player will play next season, once an offer is accepted, and the club they came from. */
  decided: { clubId: string; from: string; day: CampaignDay } | null;
  /** The friend's next-season club, once resolved. */
  friendClubId: string | null;
}

export const createTryoutState = (day: CampaignDay): TryoutState => ({
  day,
  planned: false,
  invitations: [],
  sessions: [],
  offers: [],
  offersDecidedDay: null,
  decided: null,
  friendClubId: null,
});

// ------------------------------------------------------------ clubs and timing

/** Every club holding tryouts: the league clubs with authored rules; guest (tournament-only) clubs never do. */
export const tryoutClubs = (c: CampaignState): Club[] => c.roster.clubs.filter((k) => !k.guest && CLUB_RULES.some((r) => r.clubId === k.id));

/** The five clubs the player could move to: every tryout club except their own. */
export const destinationClubs = (c: CampaignState): Club[] => {
  const mine = playerClubId(c);
  return tryoutClubs(c).filter((k) => k.id !== mine);
};

export const clubRule = (clubId: string): ClubRule | undefined => CLUB_RULES.find((r) => r.clubId === clubId);

export const tryoutsDay = (c: CampaignState): CampaignDay => c.tryouts.day;

/** Tryout week opens on the Monday before the tryout date; the season must have been reviewed. */
export const tryoutsWeekStart = (c: CampaignState): CampaignDay => c.tryouts.day - 5;

export const seasonReviewed = (c: CampaignState): boolean => c.story.facts[SEASON_FACTS.reviewed] === true;

export const nextRoster = (c: CampaignState, clubId: string): Roster | undefined => rosterOf(c.roster, clubId, NEXT_AGE_GROUP);

/** Places open on a club's next-season roster (0 until the rosters are built). */
export function openSpots(c: CampaignState, clubId: string): number {
  const r = nextRoster(c, clubId);
  return r ? openPlaces(r) : 0;
}

const TRYOUT_SLOTS = (day: CampaignDay): Slot[] => slotsFor(day).filter((s) => s !== "school").slice(0, SESSIONS_PER_DAY);

export const tryoutCommitmentId = (day: CampaignDay, slot: Slot): string => `tryout-${day}-${slot}`;

// ------------------------------------------------------------ evidence

export interface EvidenceView {
  key: EvidenceKey;
  label: string;
  /** null = no evidence exists yet (e.g. the club's session was not attended). */
  value: number | null;
}

const pct = (n: number, of: number): number => (of > 0 ? Math.round((100 * n) / of) : 0);

function sessionAt(c: CampaignState, clubId: string): TryoutSession | undefined {
  return c.tryouts.sessions.find((s) => s.clubId === clubId);
}

/** One piece of evidence, read from verified campaign state. */
export function evidenceValue(c: CampaignState, key: EvidenceKey, clubId: string): number | null {
  switch (key) {
    case "attendance": {
      const a = attendance(c.schedule, "training", c.day);
      return a.mandatoryScheduled ? pct(a.attended, a.mandatoryScheduled) : 0;
    }
    case "matches":
      return seasonSummary(c).matchesPlayed;
    case "goals":
      return seasonSummary(c).goals;
    case "technical":
    case "tactical":
    case "physical":
    case "school":
    case "responsibility":
    case "pathway":
      return c.progression.tracks[key];
    case "coach":
      return c.progression.relationships["coach"] ?? 0;
    case "session_reads": {
      const s = sessionAt(c, clubId);
      return s ? pct(s.strongReads, s.reps) : null;
    }
    case "session_touch": {
      const s = sessionAt(c, clubId);
      return s ? pct(s.cleanExecutions, s.reps) : null;
    }
  }
}

export interface RequirementView extends Requirement {
  label: string;
  value: number | null;
  met: boolean;
}

export function requirementViews(c: CampaignState, clubId: string, reqs: readonly Requirement[]): RequirementView[] {
  return reqs.map((r) => {
    const value = evidenceValue(c, r.evidence, clubId);
    return { ...r, label: EVIDENCE_LABEL[r.evidence], value, met: value !== null && value >= r.min };
  });
}

export const requirementsMet = (c: CampaignState, clubId: string, reqs: readonly Requirement[]): boolean =>
  requirementViews(c, clubId, reqs).every((r) => r.met);

// ------------------------------------------------------------ planning (idempotent, day-driven)

const clubName = (c: CampaignState, id: string): string => c.roster.clubs.find((k) => k.id === id)?.name ?? id;

/**
 * Invitations go out when the pathway unlock is reached: the clubs that invite are those whose
 * authored `invitesWhen` evidence already holds, best club first, up to the invite count. Each
 * inviting recruiter's promise is recorded as a promise — not as an offer.
 */
export function issueInvitations(c: CampaignState): string[] {
  if (c.tryouts.invitations.length || !c.progression.unlocked.includes(INVITATIONS_UNLOCK)) return [];
  const invited = destinationClubs(c)
    .map((k) => ({ club: k, rule: clubRule(k.id)! }))
    .filter(({ rule }) => rule.invites && requirementsMet(c, rule.clubId, rule.invitesWhen))
    .sort((a, b) => b.club.quality - a.club.quality || a.club.id.localeCompare(b.club.id))
    .slice(0, INVITE_COUNT);
  c.tryouts.invitations = invited.map((x) => x.club.id);
  const ctx = storyContext(c);
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.invitedClubs, value: invited.map((x) => x.club.name).join(" and ") || "No club" });
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.inviteCount, value: invited.length });
  for (const { rule } of invited) {
    if (rule.promise) applyEffect(ctx, { type: "promise", id: recruitPromiseId(rule.clubId), by: rule.recruiter, text: rule.promise.text });
  }
  touch(c);
  return c.tryouts.invitations;
}

/**
 * Tryout week: build every club's next-season roster with its explicit capacity and reserved
 * places, put the named teammates who are staying on the home club's roster (the striker who
 * chose a Sonoran trial goes there instead), and schedule the tryout sessions on the day.
 */
export function planTryouts(c: CampaignState): boolean {
  if (c.tryouts.planned || !seasonReviewed(c) || c.day < tryoutsWeekStart(c)) return false;
  const mine = playerClubId(c);
  if (!mine) return false;
  for (const rule of CLUB_RULES) {
    if (!c.roster.clubs.some((k) => k.id === rule.clubId && !k.guest)) continue;
    if (!nextRoster(c, rule.clubId)) {
      c.roster.rosters.push({ clubId: rule.clubId, ageGroup: NEXT_AGE_GROUP, playerIds: [], capacity: rule.capacity, reserved: rule.reserved });
    }
  }
  const striker = resolvePerson(c.kind, "striker");
  const strikerLeaves = c.story.facts["striker_decision"] === "trial";
  const ctx = storyContext(c);
  if (strikerLeaves && joinRoster(c.roster, striker, "sonoran", NEXT_AGE_GROUP).ok) {
    applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.strikerClub, value: clubName(c, "sonoran") });
  }
  const current = rosterOf(c.roster, mine, c.ageGroup);
  for (const id of [...(current?.playerIds ?? [])]) {
    if (id === PLAYER_ID || id === FRIEND_ID || id === striker) continue;
    joinRoster(c.roster, id, mine, NEXT_AGE_GROUP);
  }
  if (!strikerLeaves && current?.playerIds.includes(striker)) joinRoster(c.roster, striker, mine, NEXT_AGE_GROUP);
  for (const k of c.schedule.commitments) if (k.kind === "training" && k.status === "scheduled" && k.day >= c.day) k.status = "cancelled";
  const day = c.tryouts.day;
  TRYOUT_SLOTS(day).forEach((slot, i) => {
    addCommitment(c.schedule, {
      id: tryoutCommitmentId(day, slot),
      day,
      slot,
      kind: "tryout",
      title: `Tryouts · session ${i + 1}`,
      mandatory: false,
      refId: null,
      minutes: 90,
      status: "scheduled",
    });
  });
  c.tryouts.planned = true;
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.week, value: true });
  applyEffect(ctx, { type: "queue_scene", sceneId: TRYOUT_SCENES.week, onDay: c.day });
  applyEffect(ctx, { type: "queue_scene", sceneId: TRYOUT_SCENES.day, onDay: day });
  touch(c);
  return true;
}

export interface OfferDecision {
  offers: TryoutOffer[];
  kept: string[];
  broken: string[];
}

/**
 * The morning after tryouts every club decides. An offer needs all of the club's evidence
 * requirements to hold (session evidence exists only for sessions actually played) and an open
 * place on its next-season roster. Recruiters' promises kept by an offer are delivered by the
 * offer and broken by its absence; promises about next season stay open either way.
 */
export function decideOffers(c: CampaignState): OfferDecision | null {
  if (!c.tryouts.planned || c.tryouts.offersDecidedDay !== null || c.day <= c.tryouts.day) return null;
  const offers: TryoutOffer[] = [];
  const kept: string[] = [];
  const broken: string[] = [];
  const ctx = storyContext(c);
  for (const club of tryoutClubs(c)) {
    const rule = clubRule(club.id)!;
    const places = openSpots(c, club.id);
    const offered = places > 0 && requirementsMet(c, club.id, rule.requires);
    if (offered) offers.push({ clubId: club.id, madeDay: c.day, expiresDay: c.day + DECISION_DAYS, placesAtOffer: places, status: "open" });
    const promise = c.story.promises.find((p) => p.id === recruitPromiseId(club.id));
    if (promise && rule.promise?.keptBy === "offer") {
      if (offered) {
        applyEffect(ctx, { type: "deliver", promiseId: promise.id });
        kept.push(club.id);
      } else {
        applyEffect(ctx, { type: "break_promise", promiseId: promise.id });
        broken.push(club.id);
      }
    }
  }
  c.tryouts.offers = offers;
  c.tryouts.offersDecidedDay = c.day;
  const mine = playerClubId(c);
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.offersDecided, value: true });
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.offerCount, value: offers.length });
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.offersList, value: offers.map((o) => clubName(c, o.clubId)).join(", ") || "none" });
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.offerHome, value: offers.some((o) => o.clubId === mine) });
  for (const id of ["parent", "friend", "coach"]) {
    applyEffect(ctx, { type: "learn", personId: id, factId: TRYOUT_FACTS.offerCount });
    applyEffect(ctx, { type: "learn", personId: id, factId: TRYOUT_FACTS.offerHome });
  }
  if (broken.length) {
    applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.brokenClub, value: broken.map((id) => clubName(c, id)).join(" and ") });
    applyEffect(ctx, { type: "learn", personId: "parent", factId: TRYOUT_FACTS.brokenClub });
  }
  applyEffect(ctx, { type: "queue_scene", sceneId: offers.length ? TRYOUT_SCENES.offers : TRYOUT_SCENES.noOffer, onDay: c.day });
  if (broken.length) applyEffect(ctx, { type: "queue_scene", sceneId: TRYOUT_SCENES.promiseBroken, onDay: c.day + 1 });
  touch(c);
  return { offers, kept, broken };
}

/** Open offers past their deadline lapse; with nothing left to accept the player is unattached for next season. */
export function expireOffers(c: CampaignState): string[] {
  const expired: string[] = [];
  for (const o of c.tryouts.offers) {
    if (o.status === "open" && c.day > o.expiresDay) {
      o.status = "expired";
      expired.push(o.clubId);
    }
  }
  if (c.tryouts.offersDecidedDay !== null && !c.tryouts.decided && !c.tryouts.offers.some((o) => o.status === "open") && c.story.facts[TRYOUT_FACTS.unattached] !== true) {
    const ctx = storyContext(c);
    applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.unattached, value: true });
    applyEffect(ctx, { type: "learn", personId: "parent", factId: TRYOUT_FACTS.unattached });
    if (c.tryouts.offers.some((o) => o.status === "expired")) applyEffect(ctx, { type: "queue_scene", sceneId: TRYOUT_SCENES.expired, onDay: c.day });
    else if (c.tryouts.offers.length) applyEffect(ctx, { type: "queue_scene", sceneId: TRYOUT_SCENES.declinedAll, onDay: c.day });
    resolveFriend(c);
  }
  if (expired.length) touch(c);
  return expired;
}

/** Everything the calendar owes the tryouts on the current day. Safe to call repeatedly. */
export function syncTryouts(c: CampaignState): void {
  issueInvitations(c);
  planTryouts(c);
  decideOffers(c);
  expireOffers(c);
}

// ------------------------------------------------------------ the tryout day

export interface TryoutSessionOption {
  clubId: string;
  name: string;
  activity: SessionActivity;
  invited: boolean;
  /** Already played this club's session. */
  played: boolean;
}

/** Clubs whose session the player can still attend today (the home club does not ask returning players to try out). */
export function sessionOptions(c: CampaignState): TryoutSessionOption[] {
  return destinationClubs(c)
    .map((k) => ({ club: k, rule: clubRule(k.id)! }))
    .filter(({ rule }) => rule.session !== null)
    .map(({ club, rule }) => ({
      clubId: club.id,
      name: club.name,
      activity: rule.session!,
      invited: c.tryouts.invitations.includes(club.id),
      played: c.tryouts.sessions.some((s) => s.clubId === club.id),
    }));
}

/** Verified evidence from a played session, kept per club; the recruiter and the friend saw it. */
export function recordTryoutSession(c: CampaignState, clubId: string, s: SmallSidedSummary): Effect[] {
  if (!c.tryouts.sessions.some((x) => x.clubId === clubId)) {
    c.tryouts.sessions.push({ clubId, day: c.day, activity: s.activityId as SessionActivity, reps: s.reps, strongReads: s.decisions.strong, cleanExecutions: s.executions.clean });
  }
  const played = typeof c.story.facts[TRYOUT_FACTS.sessionsPlayed] === "number" ? (c.story.facts[TRYOUT_FACTS.sessionsPlayed] as number) : 0;
  const rule = clubRule(clubId);
  const effects: Effect[] = [
    { type: "set_fact", id: TRYOUT_FACTS.sessionsPlayed, value: played + 1 },
    { type: "set_fact", id: TRYOUT_FACTS.lastClub, value: clubName(c, clubId) },
    { type: "set_fact", id: TRYOUT_FACTS.lastReads, value: s.reads },
    { type: "set_fact", id: TRYOUT_FACTS.lastTouch, value: s.touch },
    { type: "learn", personId: "friend", factId: TRYOUT_FACTS.lastClub },
    { type: "learn", personId: "parent", factId: TRYOUT_FACTS.lastClub },
    { type: "track", track: "pathway", delta: 1 },
  ];
  if (rule) effects.push({ type: "learn", personId: rule.recruiter, factId: TRYOUT_FACTS.lastReads }, { type: "learn", personId: rule.recruiter, factId: TRYOUT_FACTS.lastTouch });
  const ctx = storyContext(c);
  for (const e of effects) applyEffect(ctx, e);
  touch(c);
  return effects;
}

// ------------------------------------------------------------ decisions

export type AcceptResult =
  | { ok: true; clubId: string; moved: boolean; friendClubId: string | null }
  | { ok: false; reason: "no_offer" | "not_open" | "expired" | "decided" | "full" | "no_roster" };

/**
 * Accept an offer: the only way the player changes club. The roster module admits the player to
 * next season's roster (or refuses when the place has gone); other offers are declined. Position,
 * attributes, relationships and knowledge are untouched — they belong to the person, not the club.
 */
export function acceptOffer(c: CampaignState, clubId: string): AcceptResult {
  if (c.tryouts.decided) return { ok: false, reason: "decided" };
  const offer = c.tryouts.offers.find((o) => o.clubId === clubId);
  if (!offer) return { ok: false, reason: "no_offer" };
  if (offer.status === "expired" || c.day > offer.expiresDay) return { ok: false, reason: "expired" };
  if (offer.status !== "open") return { ok: false, reason: "not_open" };
  const from = playerClubId(c) ?? HOME_CLUB_ID;
  const joined = joinRoster(c.roster, PLAYER_ID, clubId, NEXT_AGE_GROUP);
  if (!joined.ok) return { ok: false, reason: joined.reason === "full" ? "full" : "no_roster" };
  offer.status = "accepted";
  for (const o of c.tryouts.offers) if (o.status === "open") o.status = "declined";
  c.tryouts.decided = { clubId, from, day: c.day };
  const moved = from !== clubId;
  const ctx = storyContext(c);
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.nextClub, value: clubName(c, clubId) });
  for (const id of ["parent", "friend", "coach"]) applyEffect(ctx, { type: "learn", personId: id, factId: TRYOUT_FACTS.nextClub });
  const friendClubId = resolveFriend(c);
  applyEffect(ctx, { type: "queue_scene", sceneId: moved ? TRYOUT_SCENES.leave : TRYOUT_SCENES.stay, onDay: c.day });
  if (friendClubId) {
    applyEffect(ctx, { type: "queue_scene", sceneId: friendClubId === clubId ? TRYOUT_SCENES.friendWith : TRYOUT_SCENES.friendApart, onDay: c.day + 1 });
  }
  touch(c);
  return { ok: true, clubId, moved, friendClubId };
}

export type DeclineResult = { ok: true } | { ok: false; reason: "no_offer" | "not_open" | "decided" };

/** Turn one offer down without accepting another; the place goes back to the club. */
export function declineOffer(c: CampaignState, clubId: string): DeclineResult {
  if (c.tryouts.decided) return { ok: false, reason: "decided" };
  const offer = c.tryouts.offers.find((o) => o.clubId === clubId);
  if (!offer) return { ok: false, reason: "no_offer" };
  if (offer.status !== "open") return { ok: false, reason: "not_open" };
  offer.status = "declined";
  touch(c);
  expireOffers(c);
  return { ok: true };
}

/**
 * The friend's next season. With the "together" stance the friend follows the player when the
 * destination still has a place; otherwise (or when the player is unattached) the friend re-signs
 * at the home club. The friendship itself is a relationship on the person and does not move.
 */
export function resolveFriend(c: CampaignState): string | null {
  if (c.tryouts.friendClubId) return c.tryouts.friendClubId;
  if (!c.roster.people.some((p) => p.id === FRIEND_ID)) return null;
  const together = c.story.facts["tryout_stance"] === "together";
  const target = c.tryouts.decided?.clubId ?? null;
  const ctx = storyContext(c);
  let club: string | null = null;
  if (together && target && target !== HOME_CLUB_ID && joinRoster(c.roster, FRIEND_ID, target, NEXT_AGE_GROUP).ok) club = target;
  else if (joinRoster(c.roster, FRIEND_ID, HOME_CLUB_ID, NEXT_AGE_GROUP).ok) club = HOME_CLUB_ID;
  if (!club) return null;
  c.tryouts.friendClubId = club;
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.friendClub, value: clubName(c, club) });
  applyEffect(ctx, { type: "set_fact", id: TRYOUT_FACTS.friendApart, value: target !== null && target !== club });
  applyEffect(ctx, { type: "learn", personId: "friend", factId: TRYOUT_FACTS.friendClub });
  applyEffect(ctx, { type: "learn", personId: "parent", factId: TRYOUT_FACTS.friendClub });
  touch(c);
  return club;
}

// ------------------------------------------------------------ views

export type PromiseStatus = "open" | "delivered" | "broken";

export interface ClubTryoutView {
  clubId: string;
  name: string;
  attraction: string;
  home: boolean;
  invited: boolean;
  session: { activity: SessionActivity; played: TryoutSession | null } | null;
  capacity: number | null;
  reserved: number;
  /** Open places on next season's roster; null before the rosters exist. */
  places: number | null;
  requirements: RequirementView[];
  /** All evidence requirements hold right now. */
  eligible: boolean;
  offer: TryoutOffer | null;
  promise: { by: string; text: string; status: PromiseStatus; keptBy: "offer" | "next_season" } | null;
  /** Where the player will play next season, if that is here. */
  chosen: boolean;
}

export type TryoutPhase = "before" | "invited" | "week" | "day" | "offers" | "decided" | "unattached";

export function tryoutPhase(c: CampaignState): TryoutPhase {
  if (c.tryouts.decided) return "decided";
  if (c.story.facts[TRYOUT_FACTS.unattached] === true) return "unattached";
  if (c.tryouts.offersDecidedDay !== null) return "offers";
  if (c.tryouts.planned && c.day === c.tryouts.day) return "day";
  if (c.tryouts.planned) return "week";
  if (c.tryouts.invitations.length) return "invited";
  return "before";
}

export interface TryoutsView {
  phase: TryoutPhase;
  day: CampaignDay;
  dayLabel: string;
  clubs: ClubTryoutView[];
  sessionsLeft: number;
  decided: { clubId: string; name: string; moved: boolean } | null;
  friend: { name: string; clubName: string; apart: boolean } | null;
  deadline: CampaignDay | null;
}

export function tryoutsView(c: CampaignState): TryoutsView {
  const home = c.tryouts.decided?.from ?? playerClubId(c);
  const clubs = tryoutClubs(c)
    .map((k) => {
      const rule = clubRule(k.id)!;
      const next = nextRoster(c, k.id);
      const promise = c.story.promises.find((p) => p.id === recruitPromiseId(k.id));
      return {
        clubId: k.id,
        name: k.name,
        attraction: k.attraction,
        home: k.id === home,
        invited: c.tryouts.invitations.includes(k.id),
        session: rule.session ? { activity: rule.session, played: sessionAt(c, k.id) ?? null } : null,
        capacity: next?.capacity ?? null,
        reserved: next?.reserved ?? rule.reserved,
        places: next ? openPlaces(next) : null,
        requirements: requirementViews(c, k.id, rule.requires),
        eligible: requirementsMet(c, k.id, rule.requires),
        offer: c.tryouts.offers.find((o) => o.clubId === k.id) ?? null,
        promise:
          promise && rule.promise
            ? { by: promise.by, text: promise.text, status: promise.delivered ? "delivered" : promise.brokenDay !== undefined ? "broken" : "open", keptBy: rule.promise.keptBy }
            : null,
        chosen: c.tryouts.decided?.clubId === k.id,
      } satisfies ClubTryoutView;
    })
    .sort((a, b) => Number(b.home) - Number(a.home) || a.name.localeCompare(b.name));
  const friendName = c.roster.people.find((p) => p.id === FRIEND_ID)?.name ?? null;
  const open = c.tryouts.offers.filter((o) => o.status === "open");
  return {
    phase: tryoutPhase(c),
    day: c.tryouts.day,
    dayLabel: formatDay(c.tryouts.day),
    clubs,
    sessionsLeft: Math.max(0, SESSIONS_PER_DAY - c.tryouts.sessions.length),
    decided: c.tryouts.decided
      ? { clubId: c.tryouts.decided.clubId, name: clubName(c, c.tryouts.decided.clubId), moved: c.tryouts.decided.clubId !== c.tryouts.decided.from }
      : null,
    friend:
      friendName && c.tryouts.friendClubId
        ? { name: friendName, clubName: clubName(c, c.tryouts.friendClubId), apart: c.story.facts[TRYOUT_FACTS.friendApart] === true }
        : null,
    deadline: open.length ? Math.min(...open.map((o) => o.expiresDay)) : null,
  };
}
