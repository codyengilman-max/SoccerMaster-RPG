import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { createMatch, isFinished, tick } from "../../src/sim/engine";
import { playerById } from "../../src/sim/perception";
import { ROLE_BY_NUMBER, type MatchState, type RoleId, type RoleNumber } from "../../src/sim/types";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { rescoreAtCommit } from "../../src/tactics/grading";
import { instantiateIntent } from "../../src/tactics/intents";
import type { TacticalMoment } from "../../src/tactics/moments";
import { DIRECT_PACING, GK_DIRECT_PACING, fourAnswerPacingFor, pacingFor } from "../../src/tactics/recognition";
import { commit, createSession, observe } from "../../src/tactics/session";
import { testConfig } from "../helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);
const key = (v: unknown): string => JSON.stringify(v);

function controlled(seed: number, role: RoleId): MatchState {
  const cfg = testConfig(seed);
  const n = (Object.keys(ROLE_BY_NUMBER).map(Number) as RoleNumber[]).find((k) => ROLE_BY_NUMBER[k] === role)!;
  const me = cfg.home.squad.find((p) => p.role === n)!;
  return createMatch({ ...cfg, controlled: { side: "home", playerId: me.id } });
}

interface Shown {
  moment: TacticalMoment;
  /** Displayed options re-instantiated against the state they were shown in. */
  infeasible: string[];
  /** Options after commit-time rescoring on the same tick (must keep identity and remain complete). */
  rescoredIds: string[];
}

function play(seed: number, role: RoleId, maxTicks = 40_000): Shown[] {
  const state = controlled(seed, role);
  const session = createSession(catalog, fourAnswerPacingFor(role));
  const out: Shown[] = [];
  while (!isFinished(state) && state.clock.tick < maxTicks) {
    const m = observe(session, state);
    if (m) {
      const p = playerById(state, m.playerId)!;
      const infeasible = m.options.filter((o) => key(instantiateIntent(state, p, o.intent)?.command) !== key(o.command)).map((o) => o.id);
      const rescoredIds = rescoreAtCommit(state, catalog, m).map((o) => o.id);
      out.push({ moment: m, infeasible, rescoredIds });
      commit(session, state, m.options[out.length % 4]!.id);
    }
    tick(state);
  }
  return out;
}

describe("fixed four-answer window (native contract)", () => {
  const roles: RoleId[] = ["GK", "CB", "RB", "DM", "CM", "RW", "ST"];
  const shown = roles.map((role) => ({ role, shown: play(7, role) }));

  it("leaves the official web pacing untouched", () => {
    expect(DIRECT_PACING.direct?.fillFromRole).toBeUndefined();
    expect(GK_DIRECT_PACING.direct?.fillFromRole).toBeUndefined();
    expect(pacingFor("RW").direct?.minOptions).toBe(3);
    expect(pacingFor("RW").direct?.maxOptions).toBe(6);
  });

  it("every moment for every role shows exactly four answers", () => {
    for (const { role, shown: s } of shown) {
      expect(s.length, role).toBeGreaterThan(0);
      for (const { moment } of s) expect(moment.options.length, `${role} ${moment.entryId}`).toBe(4);
    }
  });

  it("filled answers come from the same role, are legitimate in the shown state and are never duplicate commands", () => {
    let fills = 0;
    for (const { role, shown: s } of shown) {
      for (const { moment, infeasible } of s) {
        expect(infeasible, `${role} ${moment.id}`).toEqual([]);
        const commands = new Set(moment.options.map((o) => key(o.command)));
        expect(commands.size).toBe(4);
        for (const o of moment.options) {
          if (!o.sourceEntryId) continue;
          fills++;
          expect(o.sourceEntryId).not.toBe(moment.entryId);
          const source = catalog.entries.find((e) => e.id === o.sourceEntryId);
          expect(source?.role).toBe(moment.role);
          expect(source?.actions.some((a) => a.id === o.actionId && a.intent === o.intent)).toBe(true);
          expect(o.id).toBe(`${moment.id}:${o.sourceEntryId}:${o.actionId}`);
        }
      }
    }
    expect(fills).toBeGreaterThan(0);
  });

  it("commit-time rescoring keeps the identity of every displayed answer, filled ones included", () => {
    for (const { shown: s } of shown) {
      for (const { moment, rescoredIds } of s) expect(rescoredIds).toEqual(moment.options.map((o) => o.id));
    }
  });
});
