import type { AgeGroup } from "../calendar/competitions";
import { PLAYER_ID, resolvePerson, storyContext, touch, type CampaignState } from "../campaign/campaign";
import { continueScene, sceneById, type EnterResult } from "./flow";
import { minigameContinuationKey, minigameDoneKey, type Scene } from "./scenes";
import { continuationOf, validateResult, type AccessibilitySettings, type AgeBand, type MinigameConfig, type MinigameResult, type Scalar } from "../minigame/contract";
import { createSession, restore, snapshot, type MinigameSession } from "../minigame/machine";
import { gameLogic } from "../minigame/registry";
import type { Person } from "../roster/roster";
import { hashSeed } from "../sim/rng";
import { applyEffect } from "./consequences";
import { appendEntry, minigameEventId } from "./ledger";
import type { EmotionalTag } from "./memory";

/**
 * Story ↔ minigame glue (Story Engine v2 §4, §7). A scene with a `minigame` block launches a
 * session as the campaign's pending activity; when the session resolves (or is abandoned) the
 * verified result is written to the ledger exactly once, turned into facts, relationship
 * movement and memories, and only then does the scene continue. Nothing in here touches the
 * soccer engine or the player's attributes.
 */

export function ageBandOf(age: AgeGroup): AgeBand {
  return age === "U11" || age === "U12" ? "U11-U12" : age === "U13" || age === "U14" ? "U13-U14" : "U15-U16";
}

/**
 * Recess/classroom skill 0..1 for a non-player participant. Read from who the person is on the
 * roster (a club player is better at knockout; the teacher is not playing), never from match
 * attributes, which are the soccer engine's alone.
 */
export function participantSkill(p: Person | undefined, id: string): number {
  if (!p) return 0.45;
  const jitter = (hashSeed(`skill:${id}`) % 1000) / 1000;
  if (p.role !== "player") return 0.5;
  if (id.endsWith("rival") || p.id === "rival") return 0.82;
  if (p.clubId) return 0.55 + jitter * 0.2;
  return 0.3 + jitter * 0.25;
}

export function minigameConfig(c: CampaignState, scene: Scene, accessibility: AccessibilitySettings): MinigameConfig {
  const launch = scene.minigame;
  if (!launch) throw new Error(`scene ${scene.id} has no minigame`);
  const ids = [PLAYER_ID, ...launch.participants.filter((p) => p !== PLAYER_ID).map((p) => resolvePerson(c.kind, p))];
  const skills: Record<string, number> = {};
  for (const id of ids.slice(1)) skills[id] = participantSkill(c.roster.people.find((p) => p.id === id), id);
  return {
    gameId: launch.gameId,
    episodeId: launch.episodeId,
    ageBand: ageBandOf(c.ageGroup),
    locationId: scene.location,
    participantIds: ids,
    ruleVariant: launch.ruleVariant,
    seed: (c.seed ^ hashSeed(`${launch.episodeId}:${launch.gameId}:${c.day}`)) >>> 0,
    day: c.day,
    accessibility,
    skills,
  };
}

/** Start the scene's minigame and park it as the campaign's pending activity (saved with the campaign). */
export function launchMinigame(c: CampaignState, scenes: readonly Scene[], accessibility: AccessibilitySettings, now = Date.now()): MinigameSession<unknown, unknown> {
  if (!c.scene) throw new Error("no scene to launch a minigame from");
  const scene = sceneById(scenes, c.scene);
  const cfg = minigameConfig(c, scene, accessibility);
  const logic = gameLogic(cfg.gameId);
  if (!logic) throw new Error(`minigame ${cfg.gameId} is not implemented`);
  const session = createSession(logic, cfg, now);
  c.pending = { kind: "minigame", sceneId: scene.id, session };
  touch(c);
  return session;
}

/**
 * The saved minigame, restored (a session saved while active comes back paused). The restored
 * session replaces the stored one so the live game and the campaign never hold diverging copies;
 * an unreadable session is dropped and the scene offers the game again.
 */
export function pendingMinigame(c: CampaignState): { sceneId: string; session: MinigameSession<unknown, unknown> } | null {
  if (!c.pending || c.pending.kind !== "minigame") return null;
  const session = restore<unknown, unknown>(c.pending.session);
  if (!session) {
    c.pending = null;
    touch(c);
    return null;
  }
  c.pending = { kind: "minigame", sceneId: c.pending.sceneId, session };
  return { sceneId: c.pending.sceneId, session };
}

/** Drop a minigame that never got going (or whose result could not be committed); the scene offers it again. */
export function cancelMinigame(c: CampaignState): boolean {
  if (!c.pending || c.pending.kind !== "minigame") return false;
  c.pending = null;
  touch(c);
  return true;
}

/** Persist the live session into the campaign (between rounds, on pause, before the tab closes). */
export function checkpointMinigame(c: CampaignState, session: MinigameSession<unknown, unknown>): boolean {
  if (!c.pending || c.pending.kind !== "minigame") return false;
  c.pending = { kind: "minigame", sceneId: c.pending.sceneId, session: snapshot(session) };
  touch(c);
  return true;
}

export type CompleteMinigame =
  | { ok: true; result: MinigameResult; eventId: string; next: EnterResult | null }
  | { ok: false; reason: "not_pending" | "unfinished" | "invalid" | "duplicate" };

/**
 * Commit a finished session: ledger first (the idempotency point), then facts, relationship
 * movement and memories, then the scene continues. A second call with the same session is a
 * `duplicate` and changes nothing.
 */
export function completeMinigame(c: CampaignState, scenes: readonly Scene[], session: MinigameSession<unknown, unknown>): CompleteMinigame {
  if (!c.pending || c.pending.kind !== "minigame") return { ok: false, reason: "not_pending" };
  if ((session.phase !== "resolved" && session.phase !== "abandoned") || !session.result) return { ok: false, reason: "unfinished" };
  const result = session.result;
  if (!validateResult(result)) return { ok: false, reason: "invalid" };
  const eventId = minigameEventId(result);
  const appended = appendEntry(c.story.ledger, { id: eventId, day: c.day, kind: "minigame", source: "minigame_engine", payload: result });
  if (!appended.ok) return { ok: false, reason: appended.reason };
  const ctx = storyContext(c);
  for (const [id, value] of Object.entries(minigameFacts(result))) applyEffect(ctx, { type: "set_fact", id, value });
  const plays = c.story.facts[`mg:${result.gameId}:plays`];
  applyEffect(ctx, { type: "set_fact", id: `mg:${result.gameId}:plays`, value: (typeof plays === "number" ? plays : 0) + 1 });
  for (const eff of result.relationshipEffects) applyEffect(ctx, { type: "relation", personId: eff.personId, dimension: eff.dimension, delta: eff.delta });
  for (const w of result.witnessedBehavior) {
    const belief = BELIEFS[w.tag];
    if (!belief) continue;
    for (const observer of w.witnessIds) {
      applyEffect(ctx, {
        type: "remember",
        observerId: observer,
        eventId: `${eventId}:${w.tag}`,
        belief: belief.text.replace("{player}", c.player.name),
        source: "witnessed",
        confidence: 1,
        tag: belief.tag,
        visibility: "public",
        decay: belief.decay,
      });
    }
  }
  const sceneId = c.pending.sceneId;
  applyEffect(ctx, { type: "set_fact", id: minigameDoneKey(sceneId), value: c.day });
  applyEffect(ctx, { type: "set_fact", id: minigameContinuationKey(sceneId), value: continuationOf(result) });
  c.pending = null;
  touch(c);
  const next = c.scene === sceneId ? continueScene(c, scenes) : null;
  return { ok: true, result, eventId, next };
}

/** Facts the authored continuation may branch on; namespaced so no soccer fact can collide. */
export function minigameFacts(r: MinigameResult): Record<string, Scalar> {
  const p = `mg:${r.gameId}`;
  const out: Record<string, Scalar> = {
    [`${p}:outcome`]: r.outcomeTier,
    [`${p}:exit`]: r.exitReason,
    [`${p}:continuation`]: continuationOf(r),
    [`${p}:episode`]: r.episodeId,
    [`${p}:variant`]: r.ruleVariant,
    "mg:last": r.gameId,
    "mg:last_continuation": continuationOf(r),
  };
  for (const [k, v] of Object.entries(r.summary)) out[`${p}:${k}`] = v;
  return out;
}

/** What a witness believes after seeing the tagged behaviour (§5: memories are beliefs, not scores). */
export const BELIEFS: Record<string, { text: string; tag: EmotionalTag; decay: "permanent" | "fades" | "until_repaired" }> = {
  won_knockout: { text: "{player} won World Cup Knockout at recess", tag: "impressed", decay: "fades" },
  eliminated: { text: "{player} got knocked out", tag: "neutral", decay: "fades" },
  out_first: { text: "{player} was the first one out", tag: "neutral", decay: "fades" },
  composed_first_touch: { text: "{player}'s first touch takes the ball away from you", tag: "impressed", decay: "fades" },
  asked_for_ball: { text: "{player} keeps asking for the ball", tag: "neutral", decay: "fades" },
  stayed_to_the_end: { text: "{player} stayed until the game was done", tag: "warm", decay: "fades" },
  left_mid_game: { text: "{player} walked off in the middle of the game", tag: "annoyed", decay: "until_repaired" },
  left_group_project: { text: "{player} left us to do the project", tag: "hurt", decay: "until_repaired" },
  dominated_presentation: { text: "{player} took over the presentation", tag: "resentful", decay: "until_repaired" },
  rescued_partner: { text: "{player} helped when I froze in front of the class", tag: "grateful", decay: "permanent" },
  took_over_from_partner: { text: "{player} took over when I froze", tag: "embarrassed", decay: "until_repaired" },
  let_partner_flounder: { text: "{player} watched me freeze and said nothing", tag: "hurt", decay: "until_repaired" },
  strong_group_result: { text: "our group got a strong result with {player}", tag: "proud", decay: "permanent" },
};
