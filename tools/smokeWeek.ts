import { newSession } from "../src/app/session";
import { fixturesFor, playerClubId, type CreateOptions } from "../src/campaign/campaign";
import { campaignMatchConfig } from "../src/campaign/match";
import { completeCrossbar, completeHomeSkill, completeMatch, completeTraining, fatigue, slotActions, takeAction, weekView } from "../src/campaign/week";
import { buildReport } from "../src/match/report";
import { isPoolPlayer } from "../src/roster/roster";
import { runHeadless as runMatch } from "../src/sim/engine";
import { MemoryStore } from "../src/save/save";
import { chooseInScene, continueScene, viewScene } from "../src/story/flow";
import { createChallenge, friendShoots, shoot, summarize as sumCrossbar } from "../src/training/crossbar";
import { createDrill as createFT, runHeadless as runFT, summarize as sumFT } from "../src/training/firstTouch";
import { assignmentById, practised, report, revisit, stageOf, watchDemonstration } from "../src/training/homeSkill";
import { recordFirstTouch } from "../src/training/record";
import { createDrill, runHeadless, summarize } from "../src/training/smallSided";

const opts: CreateOptions = { kind: "boys", player: { name: "Sam", appearance: 1, foot: "right", birthMonth: 5, position: 9 }, seed: 7 };
const store = new MemoryStore();
const s = newSession(store, opts);
const c = s.campaign;
continueScene(c, s.scenes);
chooseInScene(c, s.scenes, "open.invite.together");
chooseInScene(c, s.scenes, "open.parent.one_visit");
continueScene(c, s.scenes);
continueScene(c, s.scenes);
recordFirstTouch(c, sumFT(runFT(createFT(c.seed ^ c.day), (_d, rec) => ({ gate: rec.bestGate, accuracy: 0.9 }))));
continueScene(c, s.scenes);
continueScene(c, s.scenes);
const v = viewScene(c, s.scenes)!;
const join = v.choices.find((ch) => ch.immediate.some((e) => e.type === "flag" && e.id === "join:batavia"))!;
chooseInScene(c, s.scenes, join.id);
console.log("joined", playerClubId(c), "day", c.day, "scene", c.scene, "queued", c.story.queuedScenes);
while (c.scene) continueScene(c, s.scenes);
console.log("fixtures", fixturesFor(c, "batavia").slice(0, 4).map((f) => `${f.kind}@${f.day}`));

for (let step = 0; step < 60 && c.day < 30; step++) {
  if (c.scene) {
    const view = viewScene(c, s.scenes)!;
    console.log(`  scene ${view.scene.id}: ${view.lines.map((l) => l.text).join(" | ").slice(0, 160)}`);
    if (view.choices.length) chooseInScene(c, s.scenes, view.choices[0]!.id);
    else continueScene(c, s.scenes);
    continue;
  }
  const actions = slotActions(c);
  const pick = actions.find((a) => a.id === "train") ?? actions.find((a) => a.id === "play_match") ?? actions.find((a) => a.id === "friend_crossbar") ?? actions[0]!;
  console.log(`day ${c.day} ${c.slot} fatigue ${fatigue(c)} -> ${pick.id} [${actions.map((a) => a.id).join(",")}]`);
  const r = takeAction(c, pick.id);
  if (!r.ok) throw new Error(r.reason);
  if (r.launch) {
    if (r.launch.kind === "training") {
      const d = runHeadless(createDrill(r.launch.activity, c.seed ^ c.day, { reps: 5 }), (_d, opts) => ({ optionId: [...opts].sort((a, b) => b.score - a.score)[0]!.id, accuracy: 0.85 }));
      completeTraining(c, summarize(d));
    } else if (r.launch.kind === "match") {
      const fx = c.competitions.fixtures.find((f) => f.id === (r.launch as { fixtureId: string }).fixtureId)!;
      const st = runMatch(campaignMatchConfig(c, fx));
      const rep = buildReport(st, [], { fixtureId: fx.id, homeClubId: fx.homeClubId, awayClubId: fx.awayClubId, isPool: isPoolPlayer });
      const m = completeMatch(c, rep);
      console.log("  match", rep.score, m.match, "facts", c.story.facts["last_result"], c.story.facts["last_friend_played"]);
    } else if (r.launch.kind === "crossbar") {
      const ch = createChallenge(c.seed);
      while (ch.turn) {
        if (ch.turn === "you") shoot(ch, { x: 0, y: 2.44 }, 0.8);
        else friendShoots(ch);
      }
      completeCrossbar(c, sumCrossbar(ch));
    } else {
      const id = r.launch.assignmentId;
      const stage = stageOf(c, id);
      const eff =
        stage === "watch" ? watchDemonstration(c, id)
        : stage === "practise" ? practised(c, id, 15)
        : stage === "report" ? report(c, id, assignmentById(id)!.observations[0]!.id)
        : revisit(c, id)?.effects ?? [];
      completeHomeSkill(c, eff);
    }
  }
  s.save();
}
console.log(weekView(c).map((d) => `${d.weekday}:${d.slots.map((x) => x.commitment?.kind ?? "-").join("/")}`).join(" "));
console.log("verified", c.progression.verified, "facts", c.story.facts);
