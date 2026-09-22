/**
 * Player-facing match duration (spec §12, owner decision 2026-09): routine play is skipped, so a
 * match costs lead-ins + answers + consequences + feedback + the half-time beat. The band is judged
 * on the runtime's own real-time accounting (`MatchRuntime.realMs`), pauses excluded.
 */

/** Preferred real duration of a complete match, ms. */
export const PREFERRED_BAND_MS: readonly [number, number] = [5 * 60_000, 7 * 60_000];
/** Acceptable real duration of a complete match, ms; the upper bound is the normal maximum. */
export const ACCEPTABLE_BAND_MS: readonly [number, number] = [4 * 60_000, 8 * 60_000];

export const withinPreferred = (realMs: number): boolean => realMs >= PREFERRED_BAND_MS[0] && realMs <= PREFERRED_BAND_MS[1];
export const withinAcceptable = (realMs: number): boolean => realMs >= ACCEPTABLE_BAND_MS[0] && realMs <= ACCEPTABLE_BAND_MS[1];

export function formatRealTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
