import type { SquadPlayer } from "../sim/engine";
import { hashSeed } from "../sim/rng";
import { generateSquad } from "../sim/squad";
import { ROLE_NUMBERS, type Attributes, type RoleNumber } from "../sim/types";
import type { AgeGroup } from "../calendar/competitions";

/**
 * Clubs, people and rosters (spec §5, §18, §22). A story character who plays soccer *is* a roster
 * entry: `Person.id` is the id the simulation uses for that player, so dialogue can check who was
 * actually on the field (acceptance 3, 11). Names and biographies are proposals until reviewed
 * (OPEN_QUESTIONS #3, #14).
 */

export type ReviewStatus = "proposal" | "reviewed";

export interface Club {
  id: string;
  name: string;
  shortName: string;
  /** What the club is genuinely good at — every club needs a credible attraction (spec §18). */
  attraction: string;
  /** Ambient squad quality used for generated opponents (0–100, provisional). */
  quality: number;
  colors: { primary: string; secondary: string };
  /** Met only at tournaments: never in the metro league, never a tryout destination. */
  guest?: boolean;
  reviewStatus: ReviewStatus;
}

export type PersonRole = "player" | "coach" | "parent" | "sibling" | "teacher" | "other";

export interface Person {
  id: string;
  name: string;
  role: PersonRole;
  /** For players: current club and preferred shirt/role. */
  clubId: string | null;
  shirt: RoleNumber | null;
  /** Free-text notes for writers; never read by code. */
  bio: string;
  reviewStatus: ReviewStatus;
}

export interface Roster {
  clubId: string;
  ageGroup: AgeGroup;
  /** Person ids. Length ≤ capacity. */
  playerIds: string[];
  capacity: number;
}

export interface RosterState {
  clubs: Club[];
  people: Person[];
  rosters: Roster[];
  /** Person attributes for people who play; generated deterministically when missing. */
  attributes: Record<string, Attributes>;
}

export const createRosterState = (): RosterState => ({ clubs: [], people: [], rosters: [], attributes: {} });

export const personById = (st: RosterState, id: string): Person | undefined => st.people.find((p) => p.id === id);
export const clubById = (st: RosterState, id: string): Club | undefined => st.clubs.find((c) => c.id === id);
export const rosterOf = (st: RosterState, clubId: string, ageGroup: AgeGroup): Roster | undefined =>
  st.rosters.find((r) => r.clubId === clubId && r.ageGroup === ageGroup);

export type JoinResult = { ok: true } | { ok: false; reason: "no_roster" | "full" | "already_member" | "not_player" };

/** Add a player to a roster; capacity is explicit and never exceeded (spec §18). */
export function joinRoster(st: RosterState, personId: string, clubId: string, ageGroup: AgeGroup): JoinResult {
  const person = personById(st, personId);
  if (!person || person.role !== "player") return { ok: false, reason: "not_player" };
  const roster = rosterOf(st, clubId, ageGroup);
  if (!roster) return { ok: false, reason: "no_roster" };
  if (roster.playerIds.includes(personId)) return { ok: false, reason: "already_member" };
  if (roster.playerIds.length >= roster.capacity) return { ok: false, reason: "full" };
  for (const r of st.rosters) {
    const i = r.playerIds.indexOf(personId);
    if (i >= 0) r.playerIds.splice(i, 1);
  }
  roster.playerIds.push(personId);
  person.clubId = clubId;
  return { ok: true };
}

export function leaveRoster(st: RosterState, personId: string): void {
  for (const r of st.rosters) {
    const i = r.playerIds.indexOf(personId);
    if (i >= 0) r.playerIds.splice(i, 1);
  }
  const p = personById(st, personId);
  if (p) p.clubId = null;
}

/** Deterministic attributes for a person (stable across saves because they are stored once generated). */
export function attributesFor(st: RosterState, personId: string, quality: number): Attributes {
  const have = st.attributes[personId];
  if (have) return have;
  const person = personById(st, personId);
  const shirt = person?.shirt ?? 8;
  const gen = generateSquad(hashSeed(personId), personId, quality).find((p) => p.role === shirt)!;
  st.attributes[personId] = gen.attributes;
  return gen.attributes;
}

const priority = (mustStart: readonly string[], id: string): number => {
  const i = mustStart.indexOf(id);
  return i < 0 ? mustStart.length : i;
};

/**
 * Build the nine starters for a club's match from its roster: `mustStart` people (the user) take
 * their shirt first, then everyone else's preferred shirt, then remaining shirts; missing shirts
 * are filled by generated "pool" players whose ids are marked so dialogue never treats them as
 * named characters. People left over are the bench and do not appear in the report.
 */
export function squadFor(st: RosterState, clubId: string, ageGroup: AgeGroup, seed: number, mustStart: readonly string[] = []): SquadPlayer[] {
  const club = clubById(st, clubId);
  const quality = club?.quality ?? 50;
  const roster = rosterOf(st, clubId, ageGroup);
  const members = (roster?.playerIds ?? [])
    .map((id) => personById(st, id))
    .filter((p): p is Person => !!p)
    .sort((a, b) => priority(mustStart, a.id) - priority(mustStart, b.id));
  const taken = new Map<RoleNumber, Person>();
  const spare: Person[] = [];
  for (const m of members) {
    if (m.shirt !== null && !taken.has(m.shirt)) taken.set(m.shirt, m);
    else spare.push(m);
  }
  // A must-start person whose shirt is gone takes the nearest shirt, moving a teammate to the bench if needed.
  for (const m of [...spare]) {
    if (!mustStart.includes(m.id)) continue;
    const free = ROLE_NUMBERS.filter((r) => !taken.has(r));
    const target = free.length ? free : ROLE_NUMBERS.filter((r) => !mustStart.includes(taken.get(r)!.id) && (r !== 1 || m.shirt === 1));
    const want = ROLE_NUMBERS.indexOf(m.shirt ?? 8);
    const shirt = [...target].sort((a, b) => Math.abs(ROLE_NUMBERS.indexOf(a) - want) - Math.abs(ROLE_NUMBERS.indexOf(b) - want))[0];
    if (shirt === undefined) continue;
    const bumped = taken.get(shirt);
    taken.set(shirt, m);
    spare.splice(spare.indexOf(m), 1);
    if (bumped) spare.push(bumped);
  }
  const out: SquadPlayer[] = [];
  const pool = generateSquad(seed, `${clubId}-pool`, quality);
  for (const role of ROLE_NUMBERS) {
    const person = taken.get(role) ?? spare.shift();
    if (person) {
      out.push({ id: person.id, name: person.name, role, attributes: attributesFor(st, person.id, quality) });
    } else {
      const p = pool.find((x) => x.role === role)!;
      out.push({ ...p, name: `${club?.shortName ?? clubId} #${role}` });
    }
  }
  return out;
}

export const isPoolPlayer = (playerId: string): boolean => playerId.includes("-pool-");

/** People who were actually on the field for a match, by side — the guard behind spec §5 ("dialogue cannot describe a friend participating in a match where they were absent"). */
export function participants(squads: { home: SquadPlayer[]; away: SquadPlayer[] }): { home: string[]; away: string[] } {
  return {
    home: squads.home.map((p) => p.id).filter((id) => !isPoolPlayer(id)),
    away: squads.away.map((p) => p.id).filter((id) => !isPoolPlayer(id)),
  };
}
