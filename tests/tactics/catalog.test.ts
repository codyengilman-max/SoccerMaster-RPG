import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { ROLE_BY_NUMBER } from "../../src/sim/types";
import { conditionHolds, loadCatalog, triggerFires, validateCatalog, withDefaults, type CatalogFile } from "../../src/tactics/catalog";

const file = catalogJson as CatalogFile;

describe("conditions and triggers", () => {
  const read = withDefaults({ pressure: 0.6, hasBall: 1 });

  it("evaluates every operator", () => {
    expect(conditionHolds(read, { f: "pressure", op: ">", v: 0.5 })).toBe(true);
    expect(conditionHolds(read, { f: "pressure", op: ">=", v: 0.6 })).toBe(true);
    expect(conditionHolds(read, { f: "pressure", op: "<", v: 0.5 })).toBe(false);
    expect(conditionHolds(read, { f: "pressure", op: "<=", v: 0.6 })).toBe(true);
    expect(conditionHolds(read, { f: "hasBall", op: "==", v: 1 })).toBe(true);
    expect(conditionHolds(read, { f: "hasBall", op: "!=", v: 1 })).toBe(false);
  });

  it("combines all / any", () => {
    expect(triggerFires(read, { all: [{ f: "hasBall", op: "==", v: 1 }, { f: "pressure", op: ">", v: 0.5 }] })).toBe(true);
    expect(triggerFires(read, { all: [{ f: "hasBall", op: "==", v: 1 }], any: [{ f: "pressure", op: ">", v: 0.9 }, { f: "pressure", op: "<", v: 0.7 }] })).toBe(true);
    expect(triggerFires(read, { all: [{ f: "hasBall", op: "==", v: 1 }], any: [{ f: "pressure", op: ">", v: 0.9 }] })).toBe(false);
    expect(triggerFires(read, { all: [{ f: "hasBall", op: "==", v: 0 }] })).toBe(false);
  });
});

describe("provisional catalog content", () => {
  it("validates cleanly", () => {
    expect(validateCatalog(file)).toEqual([]);
  });

  it("is entirely provisional — nothing claims coaching review", () => {
    for (const e of file.entries) expect(e.review.status).toBe("provisional");
    expect(file.reviewStatus).toBe("provisional");
  });

  it("covers every 9v9 role with several situations across categories", () => {
    const catalog = loadCatalog(file);
    for (const role of Object.values(ROLE_BY_NUMBER)) {
      const entries = catalog.byRole.get(role) ?? [];
      expect(entries.length, role).toBeGreaterThanOrEqual(4);
      const cats = new Set(entries.map((e) => e.category));
      expect(cats.has("on_ball"), `${role} on-ball`).toBe(true);
      expect(cats.has("defending"), `${role} defending`).toBe(true);
    }
    // far short of the 360 the full game needs; this is the prototype set only
    expect(file.entries.length).toBeGreaterThanOrEqual(50);
    expect(file.entries.length).toBeLessThan(360);
  });

  it("every entry fires on its positive state and stays silent on its negative one", () => {
    for (const e of file.entries) {
      for (const t of e.tests.positive) expect(triggerFires(withDefaults(t.read), e.trigger), `${e.id} positive`).toBe(true);
      for (const t of e.tests.negative) expect(triggerFires(withDefaults(t.read), e.trigger), `${e.id} negative`).toBe(false);
    }
  });

  it("presents multiple plausible actions without a marked answer", () => {
    for (const e of file.entries) {
      expect(e.actions.length, e.id).toBeGreaterThanOrEqual(2);
      for (const a of e.actions) {
        expect(a).not.toHaveProperty("correct");
        expect(a).not.toHaveProperty("best");
      }
    }
  });

  it("mirrors left/right entries onto existing counterparts", () => {
    const ids = new Set(file.entries.map((e) => e.id));
    const mirrored = file.entries.filter((e) => e.mirrorOf);
    expect(mirrored.length).toBeGreaterThan(0);
    for (const e of mirrored) expect(ids.has(e.mirrorOf!), e.id).toBe(true);
  });
});

describe("validateCatalog", () => {
  it("reports duplicates, unknown features and thin option sets", () => {
    const e = file.entries[0]!;
    const bad: CatalogFile = {
      ...file,
      entries: [
        e,
        { ...e },
        { ...e, id: "X_BAD_1", trigger: { all: [{ f: "notAFeature" as never, op: ">", v: 0 }] } },
        { ...e, id: "X_BAD_2", actions: e.actions.slice(0, 1) },
        { ...e, id: "X_BAD_3", mirrorOf: "nope" },
      ],
    };
    const errors = validateCatalog(bad);
    expect(errors.some((m) => /duplicate/.test(m))).toBe(true);
    expect(errors.some((m) => /notAFeature/.test(m))).toBe(true);
    expect(errors.some((m) => /X_BAD_2/.test(m) && /action/.test(m))).toBe(true);
    expect(errors.some((m) => /X_BAD_3/.test(m) && /mirror/.test(m))).toBe(true);
    expect(() => loadCatalog(bad)).toThrow();
  });
});
