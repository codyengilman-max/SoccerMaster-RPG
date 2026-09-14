import { describe, expect, it } from "vitest";
import { dayOfIso, formatDay, isoOf, nextWeekday, weekday } from "../../src/calendar/date";
import {
  addCommitment,
  advanceTo,
  attendance,
  createSchedule,
  markAttended,
  phoneAvailable,
  resolveConflict,
  slotsFor,
  type Commitment,
} from "../../src/calendar/schedule";

const c = (over: Partial<Commitment> & Pick<Commitment, "id" | "day" | "slot" | "kind">): Commitment => ({
  title: over.id,
  mandatory: false,
  refId: null,
  minutes: 60,
  status: "scheduled",
  ...over,
});

describe("campaign dates", () => {
  it("day 0 is a Monday and ISO round-trips", () => {
    expect(weekday(0)).toBe("Mon");
    expect(weekday(3)).toBe("Thu");
    expect(isoOf(0)).toBe("2026-08-03");
    expect(dayOfIso("2026-09-05")).toBe(33);
    expect(weekday(33)).toBe("Sat");
    expect(formatDay(3)).toBe("Thu 6 Aug");
    expect(nextWeekday(0, "Thu")).toBe(3);
    expect(nextWeekday(3, "Thu")).toBe(3);
    expect(nextWeekday(4, "Thu")).toBe(10);
  });

  it("weekdays have four slots, weekends three, phone away during school", () => {
    expect(slotsFor(0)).toEqual(["morning", "school", "afternoon", "evening"]);
    expect(slotsFor(5)).toEqual(["morning", "afternoon", "evening"]);
    expect(phoneAvailable(0, "school")).toBe(false);
    expect(phoneAvailable(0, "evening")).toBe(true);
  });
});

describe("schedule", () => {
  it("double-booking a slot parks a conflict that must be resolved explicitly", () => {
    const s = createSchedule();
    expect(addCommitment(s, c({ id: "train", day: 1, slot: "afternoon", kind: "training", mandatory: true })).ok).toBe(true);
    const r = addCommitment(s, c({ id: "friend", day: 1, slot: "afternoon", kind: "friend" }));
    expect(r.ok).toBe(false);
    expect(s.conflicts).toHaveLength(1);
    expect(s.commitments.map((x) => x.id)).toEqual(["train"]);
    resolveConflict(s, s.conflicts[0]!, "existing");
    expect(s.conflicts).toHaveLength(0);
    const friend = s.commitments.find((x) => x.id === "friend")!;
    expect(friend.status).toBe("postponed");
  });

  it("keeping the incoming commitment cancels the existing one", () => {
    const s = createSchedule();
    addCommitment(s, c({ id: "rest", day: 5, slot: "morning", kind: "rest" }));
    const r = addCommitment(s, c({ id: "match", day: 5, slot: "morning", kind: "match", mandatory: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) resolveConflict(s, r.conflict, "incoming");
    expect(s.commitments.find((x) => x.id === "rest")!.status).toBe("cancelled");
    expect(s.commitments.find((x) => x.id === "match")!.status).toBe("scheduled");
  });

  it("rejects slots that do not exist on that day", () => {
    const s = createSchedule();
    expect(() => addCommitment(s, c({ id: "x", day: 5, slot: "school", kind: "school" }))).toThrow(/no school slot/);
  });

  it("advancing marks past scheduled commitments missed and keeps attendance", () => {
    const s = createSchedule();
    addCommitment(s, c({ id: "t1", day: 1, slot: "afternoon", kind: "training", mandatory: true }));
    addCommitment(s, c({ id: "t2", day: 3, slot: "afternoon", kind: "training", mandatory: true }));
    addCommitment(s, c({ id: "t3", day: 4, slot: "afternoon", kind: "training", mandatory: true }));
    markAttended(s, "t1");
    const missed = advanceTo(s, 4);
    expect(missed.map((m) => m.id)).toEqual(["t2"]);
    expect(advanceTo(s, 4)).toEqual([]);
    expect(attendance(s, "training", 4)).toEqual({ mandatoryScheduled: 3, attended: 1, missed: 1 });
    expect(() => markAttended(s, "t2")).toThrow(/missed/);
  });
});
