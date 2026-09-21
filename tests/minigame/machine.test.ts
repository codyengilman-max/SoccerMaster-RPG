import { describe, expect, it } from "vitest";
import { continuationOf, validateResult, type GameLogic } from "../../src/minigame/contract";
import { atCheckpoint, createSession, exit, input, pause, replay, restore, resume, snapshot, start, tick } from "../../src/minigame/machine";
import { cfg } from "./helpers";

/** A tiny counting game: each `hit` adds one, done at 3 hits, checkpoint every hit, 2 s time limit. */
interface CountState {
  hits: number;
  ms: number;
}
type CountInput = { type: "hit" };
const counting: GameLogic<CountState, CountInput> = {
  id: "study_session",
  create: () => ({ hits: 0, ms: 0 }),
  tick: (s, _c, dt) => {
    s.ms += dt;
  },
  apply: (s, _c, i) => {
    if (i.type === "hit") s.hits++;
  },
  done: (s) => s.hits >= 3,
  checkpoint: (s) => `hits:${s.hits}`,
  timeLimitMs: () => 2000,
  resolve: (s, _c, exitReason) => ({
    outcomeTier: s.hits >= 3 ? "success" : s.hits >= 1 ? "partial" : "failure",
    verifiedActions: Array.from({ length: s.hits }, (_, i) => ({ atMs: i, kind: "hit", actorId: "player", detail: {} })),
    witnessedBehavior: [],
    relationshipEffects: [],
    summary: { hits: s.hits, exitReason },
  }),
};

const make = () => createSession(counting, cfg("study_session"), 500);

describe("minigame state machine", () => {
  it("only moves start → active → paused ⇄ active, and rejects everything else", () => {
    const s = make();
    expect(s.phase).toBe("start");
    expect(pause(s)).toEqual({ ok: false, reason: "wrong_phase" });
    expect(resume(s)).toEqual({ ok: false, reason: "wrong_phase" });
    expect(input(s, counting, { type: "hit" })).toEqual({ ok: false, reason: "wrong_phase" });
    expect(tick(s, counting, 50)).toEqual({ ok: false, reason: "wrong_phase" });
    expect(exit(s, counting)).toEqual({ ok: false, reason: "wrong_phase" });
    expect(s.game.hits).toBe(0);
    expect(s.elapsedMs).toBe(0);

    expect(start(s)).toEqual({ ok: true });
    expect(start(s)).toEqual({ ok: false, reason: "wrong_phase" });
    expect(s.phase).toBe("active");
    expect(resume(s).ok).toBe(false);

    expect(pause(s).ok).toBe(true);
    expect(s.phase).toBe("paused");
    expect(pause(s).ok).toBe(false);
    expect(input(s, counting, { type: "hit" }).ok).toBe(false);
    expect(tick(s, counting, 50).ok).toBe(false);
    expect(s.elapsedMs).toBe(0);

    expect(resume(s).ok).toBe(true);
    expect(s.phase).toBe("active");
    expect(s.events.map((e) => e.type)).toEqual(["started", "paused", "resumed"]);
  });

  it("resolves as completed when the game reports done, with a valid result and continuation", () => {
    const s = make();
    start(s);
    tick(s, counting, 300, 600);
    input(s, counting, { type: "hit" }, 601);
    input(s, counting, { type: "hit" }, 602);
    expect(s.phase).toBe("active");
    input(s, counting, { type: "hit" }, 603);
    expect(s.phase).toBe("resolved");
    expect(s.result).not.toBeNull();
    const r = s.result!;
    expect(validateResult(r)).toBe(true);
    expect(r.exitReason).toBe("completed");
    expect(r.outcomeTier).toBe("success");
    expect(r.startedAt).toBe(500);
    expect(r.resolvedAt).toBe(603);
    expect(r.verifiedActions).toHaveLength(3);
    expect(r.participantIds[0]).toBe("player");
    expect(continuationOf(r)).toBe("success");
    // Nothing moves after resolution.
    expect(tick(s, counting, 50).ok).toBe(false);
    expect(input(s, counting, { type: "hit" }).ok).toBe(false);
    expect(exit(s, counting).ok).toBe(false);
    expect(s.game.hits).toBe(3);
  });

  it("times out at the game's limit and the continuation is `timeout`", () => {
    const s = make();
    start(s);
    input(s, counting, { type: "hit" });
    for (let i = 0; i < 50 && s.phase === "active"; i++) tick(s, counting, 50);
    expect(s.phase).toBe("resolved");
    expect(s.elapsedMs).toBe(2000);
    expect(s.result!.exitReason).toBe("timeout");
    expect(s.result!.outcomeTier).toBe("partial");
    expect(continuationOf(s.result!)).toBe("timeout");
  });

  it("abandons on voluntary exit from active or paused, and the result says so", () => {
    const a = make();
    start(a);
    input(a, counting, { type: "hit" });
    expect(exit(a, counting, 900)).toEqual({ ok: true });
    expect(a.phase).toBe("abandoned");
    expect(a.result!.exitReason).toBe("voluntary_exit");
    expect(a.result!.resolvedAt).toBe(900);
    expect(continuationOf(a.result!)).toBe("voluntary_exit");
    expect(a.events.at(-1)!.type).toBe("abandoned");

    const p = make();
    start(p);
    pause(p);
    expect(exit(p, counting).ok).toBe(true);
    expect(p.phase).toBe("abandoned");
    expect(resume(p).ok).toBe(false);
  });

  it("logs checkpoints once per label and reports when a save is safe", () => {
    const s = make();
    start(s);
    expect(atCheckpoint(s, counting)).toBe(true);
    tick(s, counting, 50);
    tick(s, counting, 50);
    input(s, counting, { type: "hit" });
    const cps = s.events.filter((e) => e.type === "checkpoint").map((e) => e.detail);
    expect(cps).toEqual(["hits:0", "hits:1"]);
  });

  it("snapshots and restores through JSON; an active session comes back paused", () => {
    const s = make();
    start(s);
    tick(s, counting, 250);
    input(s, counting, { type: "hit" });
    const raw = JSON.parse(JSON.stringify(snapshot(s))) as unknown;
    const back = restore<CountState, CountInput>(raw);
    expect(back).not.toBeNull();
    expect(back!.phase).toBe("paused");
    expect(back!.events.at(-1)).toMatchObject({ type: "paused", detail: "restored" });
    expect(back!.game).toEqual({ hits: 1, ms: 250 });
    expect(back!.elapsedMs).toBe(250);
    expect(back!.inputs).toEqual([{ atMs: 250, input: { type: "hit" } }]);
    // Resume and finish from the restored copy.
    expect(resume(back!).ok).toBe(true);
    input(back!, counting, { type: "hit" });
    input(back!, counting, { type: "hit" });
    expect(back!.phase).toBe("resolved");
    expect(back!.result!.outcomeTier).toBe("success");
    // The original was not touched by the snapshot.
    expect(s.phase).toBe("active");
    expect(s.game.hits).toBe(1);
  });

  it("restores paused, start and resolved sessions as they were, and rejects junk", () => {
    const p = make();
    start(p);
    pause(p);
    expect(restore(JSON.parse(JSON.stringify(p)))!.phase).toBe("paused");
    expect(restore(JSON.parse(JSON.stringify(make())))!.phase).toBe("start");
    const done = make();
    start(done);
    for (let i = 0; i < 3; i++) input(done, counting, { type: "hit" });
    expect(restore(JSON.parse(JSON.stringify(done)))!.phase).toBe("resolved");
    expect(restore(null)).toBeNull();
    expect(restore({ phase: "active" })).toBeNull();
    expect(restore({ ...JSON.parse(JSON.stringify(p)), phase: "nonsense" })).toBeNull();
  });

  it("replays the input log deterministically to the same state and result", () => {
    const live = make();
    start(live);
    tick(live, counting, 100);
    input(live, counting, { type: "hit" });
    tick(live, counting, 400);
    input(live, counting, { type: "hit" });
    tick(live, counting, 300);
    input(live, counting, { type: "hit" });
    const again = replay(counting, live.config, live.inputs);
    expect(again.phase).toBe("resolved");
    expect(again.game).toEqual(live.game);
    expect(again.elapsedMs).toBe(live.elapsedMs);
    expect(again.result!.outcomeTier).toBe(live.result!.outcomeTier);
    expect(again.result!.summary).toEqual(live.result!.summary);
    // Replaying part-way reproduces the intermediate state.
    const half = replay(counting, live.config, live.inputs, 50, 600);
    expect(half.phase).toBe("active");
    expect(half.game.hits).toBe(2);
  });
});
