import { describe, expect, it } from "vitest";
import { continuationOf, validateResult, type OutcomeTier } from "../../src/minigame/contract";
import { exit, input, pause, replay, restore, resume, tick } from "../../src/minigame/machine";
import { gameLogic, implementedGames } from "../../src/minigame/registry";
import { placeOf, WCK_TIMING, WCK_VARIANTS, worldCupKnockout, type WckVariant } from "../../src/minigame/worldCupKnockout";
import { cfg, idle, newWck, playWckAverage, playWckPerfect, playWckReckless, STEP, WCK_PLAYERS } from "./helpers";

describe("World Cup Knockout", () => {
  it("is registered and refuses fewer than six players", () => {
    expect(implementedGames()).toContain("world_cup_knockout");
    expect(gameLogic("world_cup_knockout")).toBe(worldCupKnockout);
    expect(() => worldCupKnockout.create(cfg("world_cup_knockout", { participantIds: WCK_PLAYERS.slice(0, 5) }))).toThrow(/6–10/);
    const ten = worldCupKnockout.create(cfg("world_cup_knockout", { participantIds: [...WCK_PLAYERS, "a", "b", "c", "d", "e"] }));
    expect(ten.attackers).toHaveLength(WCK_TIMING.maxPlayers);
  });

  it("creates the same setup for the same seed and a different one for another", () => {
    const a = worldCupKnockout.create(cfg("world_cup_knockout"));
    const b = worldCupKnockout.create(cfg("world_cup_knockout"));
    const c = worldCupKnockout.create(cfg("world_cup_knockout", { seed: 8 }));
    expect(a).toEqual(b);
    expect(a.round.landing).not.toEqual(c.round.landing);
    expect(a.attackers[0]!.id).toBe("player");
  });

  it("a composed player who asks, opens the touch and finishes away from the blocker wins", () => {
    const s = newWck();
    playWckPerfect(s);
    expect(s.phase).toBe("resolved");
    const r = s.result!;
    expect(validateResult(r)).toBe(true);
    expect(r.exitReason).toBe("completed");
    expect(r.outcomeTier).toBe("success");
    expect(r.summary.place).toBe(1);
    expect(r.summary.strikes).toBe(0);
    expect(r.summary.winner).toBe("player");
    expect(placeOf(s.game, "player")).toBe(1);
    const tags = r.witnessedBehavior.map((w) => w.tag);
    expect(tags).toEqual(expect.arrayContaining(["won_knockout", "composed_first_touch", "asked_for_ball", "stayed_to_the_end"]));
    expect(tags).not.toContain("left_mid_game");
    for (const w of r.witnessedBehavior) expect(w.witnessIds).toEqual(WCK_PLAYERS.slice(1));
    expect(r.relationshipEffects.every((e) => e.dimension === "respect" && e.delta === 1)).toBe(true);
    expect(r.relationshipEffects.map((e) => e.personId).sort()).toEqual(WCK_PLAYERS.slice(1).sort());
    // Every serve, touch, shot, goal and strike is on the record, each with an actor and a game time.
    const kinds = new Set(r.verifiedActions.map((a) => a.kind));
    expect(kinds).toEqual(expect.any(Set));
    for (const k of ["serve", "call", "touch", "shoot", "goal", "eliminated"]) expect(kinds.has(k)).toBe(true);
    expect(r.verifiedActions.every((a) => typeof a.atMs === "number" && a.actorId.length > 0)).toBe(true);
    const mine = r.verifiedActions.filter((a) => a.actorId === "player" && a.quality);
    expect(mine.every((a) => a.quality === "strong")).toBe(true);
    expect(s.elapsedMs).toBeLessThan(WCK_TIMING.timeLimitMs);
  });

  it("grades a first touch by where the pressure is and a shot by timing and the blocker's side", () => {
    const s = newWck();
    const g = s.game;
    // Wait for our serve.
    while (g.phase !== "incoming") {
      if (g.phase === "serve_wait" && !g.round.called) input(s, worldCupKnockout, { type: "call" }, s.elapsedMs);
      tick(s, worldCupKnockout, STEP);
    }
    // Touching into the pressure is the weak read.
    input(s, worldCupKnockout, { type: "touch", dir: g.round.pressure }, s.elapsedMs);
    expect(g.round.touch).toBe("weak");
    expect(g.phase).toBe("possession");
    // Shooting into the blocker before the ball is set: weak direction, weak timing, a strike — never a goal.
    input(s, worldCupKnockout, { type: "shoot", dir: g.round.blocker }, s.elapsedMs);
    expect(g.round.shot).toMatchObject({ timing: "weak", direction: "weak" });
    const shot = s.game.actions.filter((a) => a.kind === "shoot").at(-1)!;
    expect(shot.quality).toBe("weak");
    expect(shot.detail).toMatchObject({ blocker: g.round.blocker });
    expect(g.round.result).toBe("strike");
    expect(["rushed", "blocked", "missed"]).toContain(g.round.why);
  });

  it("doing nothing costs the possession clock: strikes, elimination and a low place", () => {
    const s = newWck();
    idle(s, worldCupKnockout);
    expect(s.phase).toBe("resolved");
    const r = s.result!;
    expect(r.exitReason).toBe("completed");
    expect(r.summary.strikes).toBe(WCK_VARIANTS.classic.strikesToOut);
    expect(r.summary.goals).toBe(0);
    const strikes = r.verifiedActions.filter((a) => a.kind === "strike" && a.actorId === "player");
    expect(strikes.every((a) => a.detail?.why === "clock")).toBe(true);
    // An untaken touch is taken for you, and marked weak.
    expect(r.verifiedActions.some((a) => a.kind === "touch" && a.actorId === "player" && a.quality === "weak" && a.detail?.auto === true)).toBe(true);
    // Being out first of six is the failure route.
    expect(r.outcomeTier).toBe("failure");
    expect(r.witnessedBehavior.map((w) => w.tag)).toContain("out_first");
    expect(r.witnessedBehavior.map((w) => w.tag)).toContain("eliminated");
    expect(r.outcomeTier).not.toBe("success");
  });

  it("every completed knockout ends with exactly one attacker still in, who is the winner and 1st place", () => {
    const styles = [playWckPerfect, playWckAverage, playWckReckless, (s: ReturnType<typeof newWck>) => idle(s, worldCupKnockout)];
    let waived = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const play of styles) {
        const s = newWck({ seed });
        play(s);
        expect(s.phase).toBe("resolved");
        const r = s.result!;
        if (r.exitReason !== "completed") continue;
        const live = s.game.attackers.filter((a) => a.outRound === null);
        expect(live).toHaveLength(1);
        expect(r.summary.winner).toBe(live[0]!.id);
        expect(placeOf(s.game, live[0]!.id)).toBe(1);
        // The last one standing keeps at most strikesToOut - 1 strikes; nobody is out at the same rank.
        expect(live[0]!.strikes).toBeLessThan(s.game.strikesToOut);
        const places = s.game.attackers.map((a) => placeOf(s.game, a.id)).sort((a, b) => a - b);
        expect(places).toEqual(s.game.attackers.map((_, i) => i + 1));
        if (r.verifiedActions.some((a) => a.kind === "strike" && a.detail?.lastStanding === true)) waived++;
      }
    }
    expect(waived).toBeGreaterThan(0);
  });

  it("a rushed finish into the blocker is the failure route, whatever the seed", () => {
    let failures = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = newWck({ seed });
      playWckReckless(s);
      expect(s.phase).toBe("resolved");
      expect(s.result!.summary.strikes).toBe(WCK_VARIANTS.classic.strikesToOut);
      if (s.result!.outcomeTier === "failure") failures++;
    }
    expect(failures).toBeGreaterThanOrEqual(16);
  });

  it("maps place to tier, and an ordinary player lands in the middle often enough to reach partial", () => {
    const seen = new Map<OutcomeTier, number>();
    for (let seed = 1; seed <= 40; seed++) {
      const s = newWck({ seed });
      playWckAverage(s);
      expect(s.phase).toBe("resolved");
      const r = s.result!;
      expect(r.exitReason).toBe("completed");
      seen.set(r.outcomeTier, (seen.get(r.outcomeTier) ?? 0) + 1);
      const place = r.summary.place as number;
      const half = Math.ceil(WCK_PLAYERS.length / 2);
      expect(r.outcomeTier).toBe(place === 1 ? "success" : place <= half ? "partial" : "failure");
    }
    expect(seen.get("partial") ?? 0).toBeGreaterThan(0);
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it("voluntary exit mid-game is recorded as leaving, costs respect, and continues on the voluntary_exit route", () => {
    const s = newWck();
    playWckPerfect(s, 15_000);
    expect(s.phase).toBe("active");
    expect(exit(s, worldCupKnockout, 2000).ok).toBe(true);
    expect(s.phase).toBe("abandoned");
    const r = s.result!;
    expect(r.exitReason).toBe("voluntary_exit");
    expect(continuationOf(r)).toBe("voluntary_exit");
    expect(r.witnessedBehavior.map((w) => w.tag)).toContain("left_mid_game");
    expect(r.witnessedBehavior.map((w) => w.tag)).not.toContain("stayed_to_the_end");
    expect(r.relationshipEffects.every((e) => e.dimension === "respect" && e.delta === -1)).toBe(true);
    expect(r.summary.finished).toBe(false);
    expect(r.resolvedAt).toBe(2000);
  });

  it("times out on the recess bell when the knockout drags past its limit", () => {
    // Ten attackers, none of them any good: strikes are slow to come, so the bell wins.
    const ids = [...WCK_PLAYERS, "a", "b", "c", "d"];
    const skills: Record<string, number> = {};
    for (const id of ids.slice(1)) skills[id] = 1;
    let s = newWck({ participantIds: ids, skills, seed: 1 });
    for (let seed = 1; seed <= 30 && s.result?.exitReason !== "timeout"; seed++) {
      s = newWck({ participantIds: ids, skills, seed });
      playWckPerfect(s);
      expect(s.phase).toBe("resolved");
    }
    expect(s.result!.exitReason).toBe("timeout");
    expect(s.elapsedMs).toBe(WCK_TIMING.timeLimitMs);
    expect(continuationOf(s.result!)).toBe("timeout");
    expect(["partial", "failure"]).toContain(s.result!.outcomeTier);
    expect(s.result!.summary.finished).toBe(false);
  });

  it("pauses between rounds, survives a save/reload, and finishes the same as an uninterrupted game", () => {
    const straight = newWck({ seed: 11 });
    playWckPerfect(straight);

    const s = newWck({ seed: 11 });
    // Play until the second round boundary.
    while (s.phase === "active" && s.game.round.n < 3) playWckPerfect(s, s.elapsedMs + STEP);
    expect(s.game.phase).toBe("serve_wait");
    expect(worldCupKnockout.checkpoint(s.game)).toBe(`round:${s.game.round.n}`);
    expect(pause(s).ok).toBe(true);
    const saved = JSON.stringify(s);
    const back = restore<typeof s.game, Parameters<typeof playWckPerfect>[0]["inputs"][number]["input"]>(JSON.parse(saved));
    expect(back).not.toBeNull();
    expect(back!.phase).toBe("paused");
    expect(resume(back!).ok).toBe(true);
    playWckPerfect(back!);
    expect(back!.phase).toBe("resolved");
    expect(back!.result!.outcomeTier).toBe(straight.result!.outcomeTier);
    expect(back!.result!.summary.rounds).toBe(straight.result!.summary.rounds);
    expect(back!.game.attackers).toEqual(straight.game.attackers);
  });

  it("replays from seed and input log to the identical result", () => {
    const live = newWck({ seed: 21 });
    playWckPerfect(live);
    const again = replay(worldCupKnockout, live.config, live.inputs, STEP);
    expect(again.phase).toBe("resolved");
    expect(again.result!.summary).toEqual(live.result!.summary);
    expect(again.result!.verifiedActions).toEqual(live.result!.verifiedActions);
    expect(again.game.attackers).toEqual(live.game.attackers);
  });

  it("supports every rule variant, each returning the same contract", () => {
    for (const v of Object.keys(WCK_VARIANTS) as WckVariant[]) {
      const s = newWck({ ruleVariant: v, seed: 5 });
      expect(s.game.area).toEqual(WCK_VARIANTS[v].area);
      expect(s.game.defender !== null).toBe(WCK_VARIANTS[v].defender);
      playWckPerfect(s);
      expect(s.phase).toBe("resolved");
      expect(validateResult(s.result)).toBe(true);
      expect(s.result!.ruleVariant).toBe(v);
      expect(s.result!.summary.variant).toBe(v);
      if (v === "weak_foot") expect(s.result!.verifiedActions.filter((a) => a.kind === "shoot").every((a) => a.detail?.foot === "weak")).toBe(true);
    }
    // Weak-foot rule: a strong-foot finish is a strike, whatever else was right.
    const w = newWck({ ruleVariant: "weak_foot", seed: 5 });
    while (w.game.phase !== "possession") {
      if (w.game.phase === "serve_wait" && !w.game.round.called) input(w, worldCupKnockout, { type: "call" }, w.elapsedMs);
      if (w.game.phase === "incoming") input(w, worldCupKnockout, { type: "touch", dir: "forward" }, w.elapsedMs);
      tick(w, worldCupKnockout, STEP);
    }
    input(w, worldCupKnockout, { type: "shoot", dir: "left", foot: "strong" }, w.elapsedMs);
    expect(w.game.round.result).toBe("strike");
    expect(w.game.round.why).toBe("wrong_foot");
  });

  it("scales its clocks with the accessibility timer and widens the set window with assist", () => {
    const slow = newWck({ accessibility: { reducedMotion: true, highContrast: true, timerScale: 2, assist: true } });
    expect(worldCupKnockout.timeLimitMs(slow.config)).toBe(WCK_TIMING.timeLimitMs * 2);
    while (slow.game.phase !== "possession") {
      if (slow.game.phase === "serve_wait" && !slow.game.round.called) input(slow, worldCupKnockout, { type: "call" }, slow.elapsedMs);
      if (slow.game.phase === "incoming") input(slow, worldCupKnockout, { type: "touch", dir: "forward" }, slow.elapsedMs);
      tick(slow, worldCupKnockout, STEP);
    }
    expect(slow.game.clockMs).toBeGreaterThanOrEqual(WCK_VARIANTS.classic.clockMs * 2 - STEP);
    // 200 ms after the touch is "rushed" at ×1 (setFrom 350) but inside the assisted window.
    for (let i = 0; i < 4; i++) tick(slow, worldCupKnockout, STEP);
    input(slow, worldCupKnockout, { type: "shoot", dir: "left" }, slow.elapsedMs);
    expect(slow.game.round.shot!.timing).not.toBe("weak");
  });

  it("ignores input in the wrong game phase instead of throwing", () => {
    const s = newWck();
    expect(s.game.phase).toBe("serve_wait");
    input(s, worldCupKnockout, { type: "shoot", dir: "left" }, s.elapsedMs);
    input(s, worldCupKnockout, { type: "touch", dir: "left" }, s.elapsedMs);
    expect(s.game.round.shot).toBeNull();
    expect(s.game.round.touch).toBeNull();
    input(s, worldCupKnockout, { type: "call" }, s.elapsedMs);
    input(s, worldCupKnockout, { type: "call" }, s.elapsedMs);
    expect(s.game.actions.filter((a) => a.kind === "call")).toHaveLength(1);
    const before = { x: s.game.attackers[0]!.x, y: s.game.attackers[0]!.y };
    input(s, worldCupKnockout, { type: "move", dx: 1, dy: 0 }, s.elapsedMs);
    expect(s.game.attackers[0]!.x).toBeGreaterThan(before.x);
    input(s, worldCupKnockout, { type: "move_to", x: 0, y: 0 }, s.elapsedMs);
    expect(s.game.attackers[0]!.x).toBeLessThan(before.x + 1);
  });
});
