/*
 * Emit autosave JSON for the visual review states (docs/VISUAL_REVIEW.md): a fresh campaign paused
 * on the best-friend invitation, a joined campaign at the weekly hub, and the same campaign at its
 * first training slot, the day the club enters its first tournament (family scene queued), and the
 * Monday after that weekend. Prints one JSON object `{ invite, hub, training, entered, afterCup }`
 * whose values go straight into localStorage key `smrpg:save:auto`.
 * Usage: npx tsx tools/reviewSaves.ts [kind=boys]
 */
import { newSession, type Session } from "../src/app/session";
import { advanceDays, type CreateOptions } from "../src/campaign/campaign";
import { slotActions, takeAction } from "../src/campaign/week";
import { MemoryStore } from "../src/save/save";
import { chooseInScene, continueScene, takeQueuedScene, viewScene } from "../src/story/flow";
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

/** Live day by day (scenes answered with their first choice, matches left to the model) until `stop` says so. */
function liveUntil(s: Session, stop: () => boolean): void {
  const c = s.campaign;
  for (let guard = 0; guard < 400 && !stop(); guard++) {
    if (!c.scene) takeQueuedScene(c, s.scenes);
    if (c.scene) {
      const v = viewScene(c, s.scenes)!;
      if (v.choices.length) chooseInScene(c, s.scenes, v.choices[0]!.id);
      else continueScene(c, s.scenes);
      continue;
    }
    advanceDays(c, 1);
  }
}

function entered(): string {
  const store = new MemoryStore();
  const s = joined(store);
  liveUntil(s, () => s.campaign.competitions.entered.length > 0);
  s.save();
  return store.read("auto")!;
}

function afterCup(): string {
  const store = new MemoryStore();
  const s = joined(store);
  const c = s.campaign;
  liveUntil(s, () => c.competitions.entered.length > 0);
  const t = c.competitions.tournaments.find((x) => x.id === c.competitions.entered[0])!;
  liveUntil(s, () => c.day > t.day + 2);
  s.save();
  return store.read("auto")!;
}

console.log(JSON.stringify({ invite: invite(), hub: hub(), training: training(), entered: entered(), afterCup: afterCup() }));
