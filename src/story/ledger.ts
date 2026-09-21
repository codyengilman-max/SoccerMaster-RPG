import type { CampaignDay } from "../calendar/date";
import { validateResult, type MinigameResult } from "../minigame/contract";

/**
 * The story event ledger (§7, §9): the only record the narrative layer may react to. Minigame
 * results are written by the minigame machine, match records by the soccer engine's report —
 * never by dialogue. Each entry has a unique id, so a result applied twice is caught, and the
 * whole ledger can be validated on load.
 */

export interface MatchRecord {
  eventId: string;
  fixtureId: string;
  home: string;
  away: string;
  score: { home: number; away: number };
  role: string;
  /** Catalog entry ids of the moments the player actually faced, in order. */
  moments: string[];
}

export type LedgerEntry =
  | { id: string; day: CampaignDay; kind: "minigame"; source: "minigame_engine"; payload: MinigameResult }
  | { id: string; day: CampaignDay; kind: "match"; source: "soccer_engine"; payload: MatchRecord };

export const minigameEventId = (r: { gameId: string; episodeId: string; day: CampaignDay; seed: number }): string => `mg:${r.episodeId}:${r.gameId}:${r.day}:${r.seed >>> 0}`;

export type AppendResult = { ok: true } | { ok: false; reason: "duplicate" | "invalid" };

export function appendEntry(ledger: LedgerEntry[], e: LedgerEntry): AppendResult {
  if (!validateEntry(e)) return { ok: false, reason: "invalid" };
  if (ledger.some((x) => x.id === e.id)) return { ok: false, reason: "duplicate" };
  ledger.push(e);
  return { ok: true };
}

export function validateEntry(x: unknown): x is LedgerEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id.length === 0 || typeof e.day !== "number") return false;
  if (e.kind === "minigame") return e.source === "minigame_engine" && validateResult(e.payload);
  if (e.kind === "match") {
    if (e.source !== "soccer_engine" || typeof e.payload !== "object" || e.payload === null) return false;
    const p = e.payload as Record<string, unknown>;
    return typeof p.eventId === "string" && typeof p.fixtureId === "string" && typeof p.score === "object" && p.score !== null && Array.isArray(p.moments);
  }
  return false;
}

export interface LedgerProblem {
  index: number;
  problem: "invalid" | "duplicate_id" | "out_of_order" | "unfinished_result";
}

/** Structural and ordering validation for a whole ledger (saves, tests). */
export function validateLedger(ledger: readonly unknown[]): LedgerProblem[] {
  const out: LedgerProblem[] = [];
  const ids = new Set<string>();
  let lastDay = -Infinity;
  ledger.forEach((raw, index) => {
    if (!validateEntry(raw)) {
      out.push({ index, problem: "invalid" });
      return;
    }
    if (ids.has(raw.id)) out.push({ index, problem: "duplicate_id" });
    ids.add(raw.id);
    if (raw.day < lastDay) out.push({ index, problem: "out_of_order" });
    lastDay = Math.max(lastDay, raw.day);
    if (raw.kind === "minigame" && raw.payload.resolvedAt === null) out.push({ index, problem: "unfinished_result" });
  });
  return out;
}

export const minigameEntries = (ledger: readonly LedgerEntry[]): MinigameResult[] => ledger.flatMap((e) => (e.kind === "minigame" ? [e.payload] : []));
export const lastMinigame = (ledger: readonly LedgerEntry[], gameId?: string): MinigameResult | null =>
  minigameEntries(ledger).filter((r) => gameId === undefined || r.gameId === gameId).at(-1) ?? null;
