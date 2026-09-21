import { newSession, type Session } from "../../src/app/session";
import type { CreateOptions } from "../../src/campaign/campaign";
import { DEFAULT_ACCESSIBILITY } from "../../src/minigame/contract";
import { start, tick } from "../../src/minigame/machine";
import { gameLogic } from "../../src/minigame/registry";
import { MemoryStore } from "../../src/save/save";
import { completeMinigame, launchMinigame } from "../../src/story/episode";
import { chooseInScene, continueScene, viewScene } from "../../src/story/flow";
import { createDrill, runHeadless, summarize } from "../../src/training/firstTouch";
import { recordFirstTouch } from "../../src/training/record";

export const JOIN_OPTS: CreateOptions = { kind: "boys", player: { name: "Sam", appearance: 1, foot: "right", birthMonth: 5, position: 9 }, seed: 7 };

/** Play the U11 opening through to joining FC Batavia and drain the remaining opening scenes. */
export function joinedSession(overrides: Partial<CreateOptions> = {}, store = new MemoryStore()): Session {
  const s = newSession(store, { ...JOIN_OPTS, ...overrides });
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

/**
 * Play the current scene's minigame without touching the controls: the session is ticked until
 * the game ends on its own (the player is knocked out / the clock runs out) and the verified
 * result is committed, so the story continues down whichever continuation that result earns.
 */
export function playMinigameHeadless(s: Session): void {
  const c = s.campaign;
  const session = launchMinigame(c, s.scenes, DEFAULT_ACCESSIBILITY, 0);
  const logic = gameLogic(session.config.gameId)!;
  start(session);
  let guard = 0;
  while (session.phase === "active" && guard++ < 20_000) tick(session, logic, 50, session.elapsedMs + 50);
  const r = completeMinigame(c, s.scenes, session);
  if (!r.ok) throw new Error(`headless minigame not committed: ${r.reason}`);
}

/** Resolve any current / queued scenes by taking the first choice (and playing minigames hands-off), so the hub is reachable. */
export function drainScenes(s: Session): string[] {
  const seen: string[] = [];
  const c = s.campaign;
  let guard = 0;
  while (c.scene && guard++ < 40) {
    const v = viewScene(c, s.scenes)!;
    seen.push(v.scene.id);
    if (v.minigame) playMinigameHeadless(s);
    else if (v.choices.length) chooseInScene(c, s.scenes, v.choices[0]!.id);
    else continueScene(c, s.scenes);
  }
  return seen;
}
