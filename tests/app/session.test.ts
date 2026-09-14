import { describe, expect, it } from "vitest";
import { AUTOSAVE_SLOT, newSession, resumeSession, savedSummary } from "../../src/app/session";
import { playerClubId, type CreateOptions } from "../../src/campaign/campaign";
import { MemoryStore } from "../../src/save/save";
import { chooseInScene, continueScene, openingStatus, viewScene } from "../../src/story/flow";
import { createDrill, runHeadless, summarize } from "../../src/training/firstTouch";
import { recordFirstTouch } from "../../src/training/record";

const opts: CreateOptions = { kind: "girls", player: { name: "Ria", appearance: 2, foot: "left", birthMonth: 4, position: 7 }, seed: 99 };

describe("app session (start → create → opening → resume)", () => {
  it("a new session starts at the kick-about and autosaves immediately", () => {
    const store = new MemoryStore();
    expect(savedSummary(store)).toBeNull();
    const s = newSession(store, opts);
    expect(s.campaign.scene).toBe("open.kickabout");
    expect(savedSummary(store)?.playerName).toBe("Ria");
    expect(savedSummary(store)?.kind).toBe("girls");
  });

  it("resuming mid-opening continues from the saved scene with choices intact", () => {
    const store = new MemoryStore();
    const s = newSession(store, opts);
    continueScene(s.campaign, s.scenes); // kickabout → invite
    s.save();
    const r = resumeSession(store)!;
    expect(r.campaign.scene).toBe("open.invite");
    const v = viewScene(r.campaign, r.scenes)!;
    expect(v.choices.map((c) => c.id)).toEqual(["open.invite.curious", "open.invite.unsure", "open.invite.ambition", "open.invite.together"]);
    expect(v.lines.every((l) => !l.text.includes("{"))).toBe(true);
  });

  it("the drill result feeds the debrief and joining puts the player on the roster; the save reflects it", () => {
    const store = new MemoryStore();
    const s = newSession(store, opts);
    const c = s.campaign;
    continueScene(c, s.scenes);
    chooseInScene(c, s.scenes, "open.invite.together");
    chooseInScene(c, s.scenes, "open.parent.one_visit");
    continueScene(c, s.scenes); // arrive → coach
    continueScene(c, s.scenes); // coach → activity
    expect(c.scene).toBe("open.activity");
    const drill = runHeadless(createDrill(c.seed ^ c.day), (_d, rec) => ({ gate: rec.bestGate, accuracy: 0.9 }));
    recordFirstTouch(c, summarize(drill));
    continueScene(c, s.scenes); // activity → debrief
    expect(c.scene).toBe("open.debrief");
    expect(c.story.facts["intro_reads"]).toBe("sharp");
    continueScene(c, s.scenes); // debrief → join
    const v = viewScene(c, s.scenes)!;
    const join = v.choices.find((ch) => ch.immediate.some((e) => e.type === "flag" && e.id === "join:batavia"))!;
    chooseInScene(c, s.scenes, join.id);
    s.save();
    expect(playerClubId(c)).toBe("batavia");
    const r = resumeSession(store)!;
    expect(playerClubId(r.campaign)).toBe("batavia");
    expect(openingStatus(r.campaign)).toBe("joined");
  });

  it("starting a new campaign replaces the autosave slot", () => {
    const store = new MemoryStore();
    newSession(store, opts);
    store.remove(AUTOSAVE_SLOT);
    const s2 = newSession(store, { ...opts, player: { ...opts.player, name: "Noor" } });
    expect(store.list()).toHaveLength(1);
    expect(savedSummary(store)?.playerName).toBe("Noor");
    expect(s2.campaign.scene).toBe("open.kickabout");
  });
});
