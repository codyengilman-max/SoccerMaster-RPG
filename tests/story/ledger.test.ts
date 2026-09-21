import { describe, expect, it } from "vitest";
import type { MinigameResult } from "../../src/minigame/contract";
import { appendEntry, lastMinigame, minigameEntries, minigameEventId, validateEntry, validateLedger, type LedgerEntry } from "../../src/story/ledger";
import {
  adjustRelation,
  createMemoryState,
  describeRelation,
  FADE_DAYS,
  memoryActive,
  RELATION_MAX,
  RELATION_MIN,
  relationOf,
  remember,
  remembers,
  resolveMemory,
  type RememberedEvent,
} from "../../src/story/memory";

const result = (over: Partial<MinigameResult> = {}): MinigameResult => ({
  gameId: "world_cup_knockout",
  episodeId: "ep1",
  ageBand: "U11-U12",
  locationId: "school",
  participantIds: ["player", "friend"],
  ruleVariant: "classic",
  verifiedActions: [],
  outcomeTier: "success",
  witnessedBehavior: [],
  relationshipEffects: [],
  startedAt: 1,
  resolvedAt: 2,
  exitReason: "completed",
  seed: 7,
  day: 3,
  summary: {},
  ...over,
});

const entry = (r: MinigameResult, day = r.day): LedgerEntry => ({ id: minigameEventId(r), day, kind: "minigame", source: "minigame_engine", payload: r });

describe("story event ledger", () => {
  it("derives one id per episode/game/day/seed and appends valid entries once", () => {
    const ledger: LedgerEntry[] = [];
    const r = result();
    expect(minigameEventId(r)).toBe("mg:ep1:world_cup_knockout:3:7");
    expect(appendEntry(ledger, entry(r))).toEqual({ ok: true });
    expect(appendEntry(ledger, entry(r))).toEqual({ ok: false, reason: "duplicate" });
    expect(ledger).toHaveLength(1);
    // Another day, same seed: a different event.
    expect(appendEntry(ledger, entry(result({ day: 4 })))).toEqual({ ok: true });
    expect(minigameEntries(ledger)).toHaveLength(2);
    expect(lastMinigame(ledger)!.day).toBe(4);
    expect(lastMinigame(ledger, "group_presentation")).toBeNull();
  });

  it("rejects malformed results before they reach the ledger", () => {
    const ledger: LedgerEntry[] = [];
    const bad = [
      { ...result(), outcomeTier: "epic" },
      { ...result(), exitReason: "crashed" },
      { ...result(), participantIds: [] },
      { ...result(), gameId: "pinball" },
      { ...result(), verifiedActions: "none" },
      { ...result(), summary: null },
      { ...result(), startedAt: "yesterday" },
    ];
    for (const payload of bad) {
      expect(appendEntry(ledger, { ...entry(result()), payload: payload as unknown as MinigameResult } as LedgerEntry)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(validateEntry({ id: "", day: 1, kind: "minigame", source: "minigame_engine", payload: result() })).toBe(false);
    expect(validateEntry({ id: "x", day: 1, kind: "minigame", source: "dialogue", payload: result() })).toBe(false);
    expect(validateEntry({ id: "x", day: 1, kind: "rumour", source: "minigame_engine", payload: result() })).toBe(false);
    expect(validateEntry({ id: "m", day: 1, kind: "match", source: "soccer_engine", payload: { eventId: "e", fixtureId: "f", score: { home: 1, away: 0 }, moments: [] } })).toBe(true);
    expect(validateEntry({ id: "m", day: 1, kind: "match", source: "minigame_engine", payload: { eventId: "e", fixtureId: "f", score: { home: 1, away: 0 }, moments: [] } })).toBe(false);
    expect(ledger).toHaveLength(0);
  });

  it("validates a whole ledger: malformed, duplicate, out of order and unfinished entries are all named", () => {
    const a = entry(result({ day: 3 }));
    const problems = validateLedger([
      a,
      { nonsense: true },
      { ...a },
      entry(result({ day: 2, seed: 9 })),
      entry(result({ day: 5, seed: 11, resolvedAt: null })),
    ]);
    expect(problems).toEqual([
      { index: 1, problem: "invalid" },
      { index: 2, problem: "duplicate_id" },
      { index: 3, problem: "out_of_order" },
      { index: 4, problem: "unfinished_result" },
    ]);
    expect(validateLedger([a, entry(result({ day: 3, seed: 8 })), entry(result({ day: 4, seed: 8 }))])).toEqual([]);
  });
});

describe("relationship memory", () => {
  const ev = (over: Partial<RememberedEvent> = {}): RememberedEvent => ({
    eventId: "mg:ep1:world_cup_knockout:3:7:won_knockout",
    observerId: "rival",
    knowledgeSource: "witnessed",
    belief: "Sam won World Cup Knockout at recess",
    confidence: 1,
    emotionalTag: "impressed",
    visibility: "public",
    decayRule: "fades",
    day: 3,
    ...over,
  });

  it("moves dimensions independently and clamps them", () => {
    const m = createMemoryState();
    expect(relationOf(m, "friend")).toEqual({ trust: 0, respect: 0, loyalty: 0, jealousy: 0, dependence: 0, competitive_tension: 0 });
    adjustRelation(m, "friend", "trust", 3);
    adjustRelation(m, "friend", "jealousy", -2);
    expect(relationOf(m, "friend")).toMatchObject({ trust: 3, jealousy: -2, respect: 0 });
    expect(adjustRelation(m, "friend", "trust", 100)).toBe(RELATION_MAX);
    expect(adjustRelation(m, "friend", "jealousy", -100)).toBe(RELATION_MIN);
  });

  it("stores each observer's belief once, fades what should fade and keeps grudges until repaired", () => {
    const m = createMemoryState();
    expect(remember(m, ev())).toBe(true);
    expect(remember(m, ev({ belief: "a different retelling" }))).toBe(false);
    expect(remember(m, ev({ observerId: "friend", confidence: 4 }))).toBe(true);
    expect(m.memories).toHaveLength(2);
    expect(m.memories[1]!.confidence).toBe(1);
    expect(remembers(m, "rival", "mg:ep1:world_cup_knockout", 3, "impressed")).toBe(true);
    expect(remembers(m, "rival", "mg:ep1:world_cup_knockout", 3, "annoyed")).toBe(false);
    expect(remembers(m, "rival", "mg:ep1:world_cup_knockout", 3 + FADE_DAYS)).toBe(false);
    expect(memoryActive(ev({ decayRule: "permanent" }), 3 + 400)).toBe(true);

    const grudge = ev({ eventId: "mg:ep1:world_cup_knockout:9:7:left_mid_game", emotionalTag: "annoyed", decayRule: "until_repaired", day: 9 });
    remember(m, grudge);
    expect(remembers(m, "rival", "mg:ep1:world_cup_knockout:9", 9 + 365)).toBe(true);
    expect(resolveMemory(m, "rival", "mg:ep1:world_cup_knockout:9", 12)).toBe(1);
    expect(resolveMemory(m, "rival", "mg:ep1:world_cup_knockout:9", 12)).toBe(0);
    expect(remembers(m, "rival", "mg:ep1:world_cup_knockout:9", 13)).toBe(false);
    // A faded memory is not "repaired" by resolveMemory: only unresolved grudges are.
    expect(resolveMemory(m, "rival", "mg:ep1:world_cup_knockout:3", 12)).toBe(0);
  });

  it("describes behaviour from dimensions and the strongest active memory, never as a score", () => {
    const m = createMemoryState();
    expect(describeRelation(m, "rival", 3)).toEqual({ behaviour: "is easy enough with you", remembered: null });
    adjustRelation(m, "rival", "competitive_tension", 5);
    adjustRelation(m, "rival", "respect", 2);
    expect(describeRelation(m, "rival", 3).behaviour).toBe("wants to beat you, and says so to your face");
    adjustRelation(m, "rival", "trust", -4);
    expect(describeRelation(m, "rival", 3).behaviour).toBe("keeps things short with you");
    remember(m, ev());
    remember(m, ev({ eventId: "mg:ep1:group_presentation:5:7:left_group_project", emotionalTag: "hurt", decayRule: "until_repaired", day: 5 }));
    const v = describeRelation(m, "rival", 6);
    expect(v.remembered!.emotionalTag).toBe("hurt");
    expect(v.behaviour).not.toMatch(/\d/);
    // Once the grudge is repaired the impressed memory comes back to the front, until it fades.
    resolveMemory(m, "rival", "mg:ep1:group_presentation", 7);
    expect(describeRelation(m, "rival", 8).remembered!.emotionalTag).toBe("impressed");
    expect(describeRelation(m, "rival", 8 + FADE_DAYS).remembered).toBeNull();
  });
});
