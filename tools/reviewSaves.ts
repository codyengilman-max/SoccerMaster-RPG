/*
 * Emit autosave JSON for the visual review states (docs/VISUAL_REVIEW.md): a fresh campaign paused
 * on the best-friend invitation, a joined campaign at the weekly hub, and the same campaign at its
 * first training slot. Prints one JSON object `{ invite, hub, training }` whose values go straight
 * into localStorage key `smrpg:save:auto`.
 * Usage: npx tsx tools/reviewSaves.ts [kind=boys]
 */
import { newSession, type Session } from "../src/app/session";
import type { CreateOptions } from "../src/campaign/campaign";
import { slotActions, takeAction } from "../src/campaign/week";
import { MemoryStore } from "../src/save/save";
import { chooseInScene, continueScene, viewScene } from "../src/story/flow";
import { createDrill, runHeadless, summarize } from "../src/training/firstTouch";
import { recordFirstTouch } from "../src/training/record";

const kind = (process.argv[2] ?? "boys") as CreateOptions["kind"];
const opts: CreateOptions = { kind, player: { name: kind === "boys" ? "Sam" : "Maya", appearance: 1, foot: "right", birthMonth: 5, position: 9 }, seed: 7 };

function invite(): string {
  const store = new MemoryStore();
  const s = newSession(store, opts);
  let guard = 0;
  while (s.campaign.scene && viewScene(s.campaign, s.scenes)!.scene.id !== "open.invite" && guard++ < 10) continueScene(s.campaign, s.scenes);
  s.save();
  return store.read("auto")!;
}

function joined(store: MemoryStore): Session {
  const s = newSession(store, opts);
  const c = s.campaign;
  continueScene(c, s.scenes);
  chooseInScene(c, s.scenes, "open.invite.together");
  chooseInScene(c, s.scenes, "open.parent.one_visit");
  continueScene(c, s.scenes);
  continueScene(c, s.scenes);
  recordFirstTouch(c, summarize(runHeadless(createDrill(c.seed ^ c.day), (_d, rec) => ({ gate: rec.bestGate, accuracy: 0.9 }))));
  continueScene(c, s.scenes);
  continueScene(c, s.scenes);
  const v = viewScene(c, s.scenes)!;
  const join = v.choices.find((ch) => ch.immediate.some((e) => e.type === "flag" && e.id === "join:batavia"))!;
  chooseInScene(c, s.scenes, join.id);
  let guard = 0;
  while (c.scene && guard++ < 20) continueScene(c, s.scenes);
  s.save();
  return s;
}

function hub(): string {
  const store = new MemoryStore();
  joined(store);
  return store.read("auto")!;
}

/** Rest / go to school slot by slot until "Go to training" is on offer, resolving any scene with its first choice. */
function training(): string {
  const store = new MemoryStore();
  const s = joined(store);
  const c = s.campaign;
  for (let guard = 0; guard < 30; guard++) {
    if (c.scene) {
      const v = viewScene(c, s.scenes)!;
      if (v.choices.length) chooseInScene(c, s.scenes, v.choices[0]!.id);
      else continueScene(c, s.scenes);
      continue;
    }
    const actions = slotActions(c);
    if (actions.some((a) => a.id === "train")) break;
    takeAction(c, actions.some((a) => a.id === "school") ? "school" : "rest");
  }
  s.save();
  return store.read("auto")!;
}

console.log(JSON.stringify({ invite: invite(), hub: hub(), training: training() }));
