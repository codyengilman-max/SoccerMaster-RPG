import { newSession } from "../src/app/session";
import { standings } from "../src/calendar/competitions";
import { formatDay } from "../src/calendar/date";
import { fixturesFor, playerClubId, type CreateOptions } from "../src/campaign/campaign";
import { campaignMatchConfig } from "../src/campaign/match";
import { seasonPhase, seasonSummary, tournamentViews } from "../src/campaign/season";
import { acceptOffer, destinationClubs, tryoutsView } from "../src/campaign/tryouts";
import { completeMatch, completeTraining, completeTryout, skipToNextEvent, slotActions, takeAction } from "../src/campaign/week";
import { buildReport } from "../src/match/report";
import { isPoolPlayer } from "../src/roster/roster";
import { MemoryStore } from "../src/save/save";
import { runHeadless as runMatch } from "../src/sim/engine";
import { CENTRAL_QUESTION, arcScenes } from "../src/story/arc";
import { chooseInScene, continueScene, takeQueuedScene, viewScene } from "../src/story/flow";
import { unlockViews } from "../src/story/progression";
import { createDrill as createFT, runHeadless as runFT, summarize as sumFT } from "../src/training/firstTouch";
import { recordFirstTouch } from "../src/training/record";
import { createDrill, runHeadless, summarize } from "../src/training/smallSided";

/**
 * Headless season smoke: join FC Batavia, then live the U11 season attending everything, playing
 * every match with the engine, answering every scene with its first choice, and skipping free time.
 * Prints the season as it happens and checks the invariants spec §17 cares about at the end.
 */

const seed = Number(process.argv[2] ?? 11);
const opts: CreateOptions = { kind: "girls", player: { name: "Ana", appearance: 2, foot: "left", birthMonth: 3, position: 8 }, seed };
const s = newSession(new MemoryStore(), opts);
const c = s.campaign;
continueScene(c, s.scenes);
chooseInScene(c, s.scenes, "open.invite.together");
chooseInScene(c, s.scenes, "open.parent.one_visit");
continueScene(c, s.scenes);
continueScene(c, s.scenes);
recordFirstTouch(c, sumFT(runFT(createFT(c.seed ^ c.day), (_d, rec) => ({ gate: rec.bestGate, accuracy: 0.9 }))));
continueScene(c, s.scenes);
continueScene(c, s.scenes);
const join = viewScene(c, s.scenes)!.choices.find((ch) => ch.immediate.some((e) => e.type === "flag" && e.id === "join:batavia"))!;
chooseInScene(c, s.scenes, join.id);
while (c.scene) continueScene(c, s.scenes);
const club = playerClubId(c)!;
console.log(`joined ${club} on ${formatDay(c.day)}; league fixtures ${fixturesFor(c, club).filter((f) => f.kind === "league").length}`);

let phase = seasonPhase(c);
let played = 0;
const seenScenes = new Map<string, number>();
for (let step = 0; step < 5000 && c.story.facts["season_reviewed"] !== true; step++) {
  const p = seasonPhase(c);
  if (p !== phase) {
    phase = p;
    console.log(`\n== ${p} (${formatDay(c.day)}) ==`);
  }
  if (!c.scene) takeQueuedScene(c, s.scenes);
  if (c.scene) {
    const view = viewScene(c, s.scenes)!;
    seenScenes.set(view.scene.id, (seenScenes.get(view.scene.id) ?? 0) + 1);
    if (view.scene.id.startsWith("season.")) console.log(`  scene ${view.scene.id}: ${view.lines.map((l) => l.text).join(" | ").slice(0, 200)}`);
    if (view.choices.length) chooseInScene(c, s.scenes, view.choices[0]!.id);
    else continueScene(c, s.scenes);
    continue;
  }
  const actions = slotActions(c);
  const pick = actions.find((a) => a.id === "train") ?? actions.find((a) => a.id === "play_match");
  if (!pick) {
    const r = skipToNextEvent(c);
    if (r.stoppedAt === "cap") console.log(`  skipped ${r.slots} slots (cap) at ${formatDay(c.day)}`);
    continue;
  }
  const r = takeAction(c, pick.id);
  if (!r.ok) throw new Error(r.reason);
  if (!r.launch) continue;
  if (r.launch.kind === "training") {
    const d = runHeadless(createDrill(r.launch.activity, c.seed ^ c.day, { reps: 5 }), (_d, o) => ({ optionId: [...o].sort((a, b) => b.score - a.score)[0]!.id, accuracy: 0.85 }));
    completeTraining(c, summarize(d));
  } else if (r.launch.kind === "match") {
    const fx = c.competitions.fixtures.find((f) => f.id === (r.launch as { fixtureId: string }).fixtureId)!;
    const st = runMatch(campaignMatchConfig(c, fx));
    const rep = buildReport(st, [], { fixtureId: fx.id, homeClubId: fx.homeClubId, awayClubId: fx.awayClubId, isPool: isPoolPlayer });
    const m = completeMatch(c, rep);
    played++;
    const moved = fx.movedFromDay !== undefined ? ` (moved from ${formatDay(fx.movedFromDay)})` : "";
    console.log(`  ${formatDay(c.day)} ${fx.kind} ${fx.id}${moved}: ${fx.homeClubId} ${rep.score.home}–${rep.score.away} ${fx.awayClubId} ok=${m.match.ok}`);
  }
  s.save();
}

console.log("\nseason summary", JSON.stringify(seasonSummary(c)));
for (const v of tournamentViews(c)) {
  console.log(`  ${v.tournament.id.padEnd(14)} ${v.status.padEnd(8)} ${v.summary ? `${v.summary.won}-${v.summary.drawn}-${v.summary.lost} ${v.summary.outcome}` : v.reasons.join("; ")}`);
}
for (const l of c.competitions.leagues) {
  console.log(`  ${l.name}`);
  for (const r of standings(c.competitions, l.id, c.day)) console.log(`    ${r.clubId.padEnd(10)} P${r.played} W${r.won} D${r.drawn} L${r.lost} ${r.goalsFor}-${r.goalsAgainst} ${r.points}pts`);
}
console.log("scenes", Object.fromEntries(seenScenes));
console.log("facts", JSON.stringify(c.story.facts));
console.log(`\narc: ${CENTRAL_QUESTION}`);
const milestones = arcScenes(c.kind).filter((sc) => sc.auto);
const arcPlayed = milestones.filter((sc) => seenScenes.has(sc.id)).length;
console.log(`  milestones played ${arcPlayed}/${milestones.length}: ${milestones.map((sc) => `${sc.id}${seenScenes.has(sc.id) ? "" : "(-)"}`).join(" ")}`);
console.log("  tracks", JSON.stringify(c.progression.tracks));
console.log("  relationships", JSON.stringify(c.progression.relationships));
for (const u of unlockViews(c.progression)) {
  const reqs = u.requirements.map((r) => `${r.requirement.track ?? r.requirement.personId} ${r.value}/${r.requirement.min}`);
  console.log(`  ${u.unlocked ? "[x]" : "[ ]"} ${u.rule.id.padEnd(22)} ${reqs.join(", ")}`);
}

// Season-end tryouts: play every session on offer, then accept the first open offer away from home (or stay).
console.log(`\n== tryouts (${formatDay(c.tryouts.day)}) ==`);
let relationshipsChangedByTransfer = false;
const positionBefore = c.roster.people.find((p) => p.id === "player")!.shirt;
// Everything about the player a transfer must leave alone (club membership is the one thing it changes).
const transferInvariants = (): string => {
  const { clubId: _club, ...person } = c.roster.people.find((p) => p.id === "player")!;
  return JSON.stringify([c.progression.relationships, c.progression.tracks, person, c.roster.attributes["player"], c.player.position]);
};
let sessionsPlayed = 0;
for (let step = 0; step < 500 && !c.tryouts.offersDecidedDay; step++) {
  if (!c.scene) takeQueuedScene(c, s.scenes);
  if (c.scene) {
    const view = viewScene(c, s.scenes)!;
    seenScenes.set(view.scene.id, (seenScenes.get(view.scene.id) ?? 0) + 1);
    if (view.scene.id.startsWith("tryouts.") || view.scene.id.startsWith("season.")) console.log(`  scene ${view.scene.id}: ${view.lines.map((l) => l.text).join(" | ").slice(0, 200)}`);
    if (view.choices.length) chooseInScene(c, s.scenes, view.choices[0]!.id);
    else continueScene(c, s.scenes);
    continue;
  }
  const tryout = slotActions(c).find((a) => a.id === "tryout");
  if (!tryout) {
    skipToNextEvent(c);
    continue;
  }
  const r = takeAction(c, tryout.id, tryout.clubId);
  if (!r.ok || !r.launch || r.launch.kind !== "tryout") throw new Error("tryout did not launch");
  const d = runHeadless(createDrill(r.launch.activity, c.seed ^ c.day ^ sessionsPlayed, { reps: 6 }), (_d, o) => ({ optionId: [...o].sort((a, b) => b.score - a.score)[0]!.id, accuracy: 0.85 }));
  completeTryout(c, summarize(d));
  sessionsPlayed++;
  console.log(`  ${formatDay(c.day)} session at ${r.launch.clubId} (${r.launch.activity})`);
  s.save();
}
const tv = tryoutsView(c);
console.log(`  invitations ${tv.clubs.filter((k) => k.invited).map((k) => k.name).join(", ") || "none"}`);
for (const k of tv.clubs) {
  const reqs = k.requirements.map((r) => `${r.evidence} ${r.value ?? "?"}/${r.min}${r.met ? "" : "!"}`).join(", ");
  console.log(`  ${k.name.padEnd(18)} ${String(k.places ?? "?").padStart(2)}/${k.capacity ?? "?"} open  ${k.invited ? "invited " : ""}${k.session ? `session ${k.session.played ? "played" : "open"} ` : ""}${k.promise ? `promise:${k.promise.status} ` : ""}${k.offer ? `OFFER:${k.offer.status} ` : ""}${k.eligible ? "eligible" : "not eligible"}  [${reqs}]`);
}
const offers = tv.clubs.filter((k) => k.offer?.status === "open");
const away = offers.find((k) => k.clubId !== club) ?? offers[0];
if (away) {
  const before = transferInvariants();
  const acc = acceptOffer(c, away.clubId);
  relationshipsChangedByTransfer = transferInvariants() !== before;
  console.log(`  accepted ${away.name}: ${acc.ok ? "ok" : acc.reason}`);
}
for (let step = 0; step < 60; step++) {
  if (!c.scene) takeQueuedScene(c, s.scenes);
  if (c.scene) {
    const view = viewScene(c, s.scenes)!;
    seenScenes.set(view.scene.id, (seenScenes.get(view.scene.id) ?? 0) + 1);
    if (view.scene.id.startsWith("tryouts.")) console.log(`  scene ${view.scene.id}: ${view.lines.map((l) => l.text).join(" | ").slice(0, 200)}`);
    if (view.choices.length) chooseInScene(c, s.scenes, view.choices[0]!.id);
    else continueScene(c, s.scenes);
    continue;
  }
  if (step > 40) break;
  skipToNextEvent(c);
}
const after = tryoutsView(c);
console.log(`  next season: ${after.decided ? `${after.decided.name}${after.decided.moved ? " (moved)" : " (stayed)"}` : "undecided"}; friend at ${after.friend?.clubName ?? "?"} (${after.friend?.apart ? "apart" : "together"})`);
console.log(`  promises ${JSON.stringify(c.story.promises.map((p) => ({ id: p.id, delivered: p.delivered, broken: p.brokenDay !== undefined })))}`);

const destinations = destinationClubs(c);
const nextRosters = c.roster.rosters.filter((r) => r.ageGroup === "U12");
const overfull = nextRosters.filter((r) => r.playerIds.length + (r.reserved ?? 0) > r.capacity);
const league = c.competitions.fixtures.filter((f) => f.kind === "league");
const unplayed = league.filter((f) => !f.result);
const dup = new Set(c.competitions.appliedEventIds).size !== c.competitions.appliedEventIds.length;
const tournamentInTable = c.competitions.leagues.some((l) => standings(c.competitions, l.id, c.day).some((r) => r.played > league.filter((f) => f.competitionId === l.id && (f.homeClubId === r.clubId || f.awayClubId === r.clubId)).length));
const problems = [
  unplayed.length ? `${unplayed.length} league fixtures without a result` : null,
  dup ? "duplicate applied event ids" : null,
  tournamentInTable ? "tournament results leaked into a league table" : null,
  c.story.facts["season_reviewed"] !== true ? "season never closed" : null,
  played < 15 ? `only ${played} matches played on screen` : null,
  arcPlayed < 6 ? `only ${arcPlayed} arc milestones played` : null,
  destinations.length !== 5 || destinations.some((k) => k.guest) ? `expected five non-guest destination clubs, got ${destinations.map((k) => k.id).join(",")}` : null,
  sessionsPlayed === 0 ? "no tryout session was played" : null,
  !c.tryouts.offersDecidedDay ? "offers were never decided" : null,
  overfull.length ? `next-season rosters over capacity: ${overfull.map((r) => r.clubId).join(",")}` : null,
  relationshipsChangedByTransfer ? "relationships, tracks or the player record changed by the transfer itself" : null,
  c.roster.people.find((p) => p.id === "player")!.shirt !== positionBefore ? "position changed across the transfer" : null,
];
const bad = problems.filter((x): x is string => x !== null);
console.log(bad.length ? `FAIL: ${bad.join("; ")}` : `PASS (${played} matches played, day ${c.day})`);
if (bad.length) process.exit(1);
