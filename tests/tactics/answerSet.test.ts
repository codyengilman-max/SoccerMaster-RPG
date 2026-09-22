import { describe, expect, it } from "vitest";
import catalogJson from "../../content/catalog/provisional-u11.json";
import { evaluateOnBall, secondNineRead, type OnBallOption } from "../../src/sim/ai";
import { createMatch, isFinished, tick } from "../../src/sim/engine";
import { playerById } from "../../src/sim/perception";
import { Rng } from "../../src/sim/rng";
import { ROLE_BY_NUMBER, ROLE_NUMBERS, type MatchState, type RoleId } from "../../src/sim/types";
import { loadCatalog, type CatalogFile } from "../../src/tactics/catalog";
import { DOCUMENTED_EXCLUSIONS, isDocumentedExclusion } from "../../src/tactics/exclusions";
import { instantiateIntent } from "../../src/tactics/intents";
import type { TacticalMoment } from "../../src/tactics/moments";
import { pacingFor } from "../../src/tactics/recognition";
import { commit, createSession, observe } from "../../src/tactics/session";
import { testConfig } from "../helpers";

const catalog = loadCatalog(catalogJson as CatalogFile);
const key = (v: unknown): string => JSON.stringify(v);

interface Observed {
  role: RoleId;
  seed: number;
  moment: TacticalMoment;
  /** Every displayed option, re-instantiated against the same state it was shown in. */
  infeasible: string[];
  /** Engine's highest-scoring on-ball option when the player had the ball, else null. */
  engineBest: { kind: OnBallOption["kind"]; command: string; shown: boolean } | null;
  switchShown: boolean;
  switchIsTop: boolean;
  switchBackedByEngine: boolean;
  narrowShown: boolean;
  narrowBackedByRead: boolean;
}

/** A full seeded match for one role with a scripted user who answers every moment; each moment is inspected at the tick it opens. */
function playRole(role: RoleId, seed: number): Observed[] {
  const cfg = testConfig(seed);
  const me = cfg.home.squad.find((p) => ROLE_BY_NUMBER[p.role] === role);
  if (!me) throw new Error(`no ${role}`);
  const state: MatchState = createMatch({ ...cfg, controlled: { side: "home", playerId: me.id } });
  const session = createSession(catalog, pacingFor(role));
  const user = new Rng(seed * 31 + role.length);
  const out: Observed[] = [];
  let pendingUntil = -1;
  while (!isFinished(state)) {
    const m = observe(session, state);
    if (m) {
      pendingUntil = state.clock.tick + user.int(2, 8);
      out.push(inspect(role, seed, state, m));
    }
    if (session.active && state.clock.tick >= pendingUntil) {
      const pick = user.pick(session.active.options);
      if (pick) commit(session, state, pick.id, user.range(0.6, 1));
    }
    tick(state);
  }
  return out;
}

function inspect(role: RoleId, seed: number, state: MatchState, m: TacticalMoment): Observed {
  const p = playerById(state, m.playerId);
  const infeasible: string[] = [];
  for (const o of m.options) {
    const inst = instantiateIntent(state, p, o.intent);
    if (!inst) infeasible.push(`${m.entryId}/${o.actionId}: not instantiable`);
    else if (key(inst.command) !== key(o.command)) infeasible.push(`${m.entryId}/${o.actionId}: command drifted`);
  }
  const hasBall = state.ball.status === "controlled" && state.ball.owner === p.id && m.read.hasBall === 1;
  let engineBest: Observed["engineBest"] = null;
  const engine = hasBall ? evaluateOnBall(state, p) : [];
  const best = engine[0];
  if (hasBall && best) {
    const shown = m.options.some((o) => key(o.command) === key(best.command));
    engineBest = { kind: best.kind, command: key(best.command), shown };
  }
  const top = m.options.reduce((a, b) => (b.score > a.score ? b : a));
  const sw = m.options.find((o) => o.intent === "switch_play");
  const narrow = m.options.find((o) => o.intent === "narrow_inside");
  return {
    role,
    seed,
    moment: m,
    infeasible,
    engineBest,
    switchShown: sw !== undefined,
    switchIsTop: sw !== undefined && top.intent === "switch_play",
    switchBackedByEngine: sw !== undefined && engine.some((o) => o.kind === "switch" && key(o.command) === key(sw.command)),
    narrowShown: narrow !== undefined,
    narrowBackedByRead: narrow !== undefined && secondNineRead(state, p).on,
  };
}

const ROLES: RoleId[] = ROLE_NUMBERS.map((n) => ROLE_BY_NUMBER[n]);
const SEEDS = [31, 32];
const observed: Observed[] = ROLES.flatMap((role) => SEEDS.flatMap((seed) => playRole(role, seed)));

describe("answer sets are drawn from the live state (spec §16)", () => {
  it("covers every role with real moments, most of them on the ball", () => {
    for (const role of ROLES) {
      const n = observed.filter((o) => o.role === role).length;
      expect(n, `${role} produced ${n} moments across ${SEEDS.length} matches`).toBeGreaterThanOrEqual(12 * SEEDS.length);
    }
    expect(observed.filter((o) => o.engineBest !== null).length).toBeGreaterThan(60);
  });

  it("every displayed answer is instantiable in the state it was shown in and maps to the same command", () => {
    const bad = observed.flatMap((o) => o.infeasible.map((i) => `${o.role} s${o.seed} ${o.moment.id} ${i}`));
    expect(bad).toEqual([]);
    for (const o of observed) expect(o.moment.options.length).toBeGreaterThanOrEqual(2);
  });

  it("the engine's highest-scoring on-ball option is never omitted without a documented exclusion", () => {
    const omitted = observed
      .filter((o) => o.engineBest !== null && !o.engineBest.shown && !isDocumentedExclusion(o.role, o.engineBest.kind))
      .map((o) => `${o.role} s${o.seed} ${o.moment.entryId} engine best=${o.engineBest?.kind} ${o.engineBest?.command} shown=[${o.moment.options.map((x) => x.intent).join(",")}]`);
    expect(omitted).toEqual([]);
  });

  it("documented exclusions are explicit, role-scoped and carry a reason", () => {
    expect(DOCUMENTED_EXCLUSIONS.length).toBeGreaterThan(0);
    for (const x of DOCUMENTED_EXCLUSIONS) {
      expect(x.reason.length).toBeGreaterThan(20);
      expect(ROLES).toContain(x.role);
    }
    // the keeper is never shown a carry command, so the documented exclusion matches what the catalog does
    const gkCarry = observed.filter((o) => o.role === "GK" && o.moment.options.some((x) => x.command.type === "carry"));
    expect(gkCarry).toEqual([]);
    // every omission of an engine best that did occur is one of the documented ones
    const excluded = observed.flatMap((o) => (o.engineBest && !o.engineBest.shown ? [{ role: o.role, kind: o.engineBest.kind }] : []));
    for (const x of excluded) expect(isDocumentedExclusion(x.role, x.kind)).toBe(true);
  });

  it("switch_play appears only when the engine has that exact switch route, and is not automatically the top answer", () => {
    const shown = observed.filter((o) => o.switchShown);
    expect(shown.length).toBeGreaterThan(5);
    const unbacked = shown.filter((o) => !o.switchBackedByEngine).map((o) => `${o.role} s${o.seed} ${o.moment.entryId}`);
    expect(unbacked).toEqual([]);
    // state-scored: the switch is shown in wide situations where another answer scores higher
    expect(shown.some((o) => !o.switchIsTop)).toBe(true);
    expect(shown.filter((o) => o.switchIsTop).length).toBeLessThan(shown.length);
  });

  it("narrow_inside is shown only when the contextual second-9 read is on", () => {
    const unbacked = observed.filter((o) => o.narrowShown && !o.narrowBackedByRead).map((o) => `${o.role} s${o.seed} ${o.moment.entryId}`);
    expect(unbacked).toEqual([]);
  });
});
