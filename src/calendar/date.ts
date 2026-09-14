/**
 * Campaign time is an integer day index. Day 0 is a Monday (the first Monday of August in the
 * U11 season) so weekday arithmetic is exact and saves never depend on a timezone.
 */

export type CampaignDay = number;

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export const WEEKDAYS: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** ISO date of day 0. A proposal (spec §7 leaves the calendar anchor open). */
export const EPOCH_ISO = "2026-08-03";

export const weekday = (day: CampaignDay): Weekday => WEEKDAYS[((day % 7) + 7) % 7]!;
export const isWeekend = (day: CampaignDay): boolean => {
  const w = weekday(day);
  return w === "Sat" || w === "Sun";
};
export const weekOf = (day: CampaignDay): number => Math.floor(day / 7);
export const mondayOf = (day: CampaignDay): CampaignDay => weekOf(day) * 7;
export const nextWeekday = (from: CampaignDay, w: Weekday): CampaignDay => {
  const want = WEEKDAYS.indexOf(w);
  const have = WEEKDAYS.indexOf(weekday(from));
  return from + ((want - have + 7) % 7);
};

const EPOCH_MS = Date.UTC(2026, 7, 3);
const DAY_MS = 86_400_000;

export function isoOf(day: CampaignDay): string {
  return new Date(EPOCH_MS + day * DAY_MS).toISOString().slice(0, 10);
}

export function dayOfIso(iso: string): CampaignDay {
  const [y, m, d] = iso.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y + m + d)) throw new Error(`bad date ${iso}`);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_MS) / DAY_MS);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 6 Aug" — used by the hub and calendar. */
export function formatDay(day: CampaignDay): string {
  const d = new Date(EPOCH_MS + day * DAY_MS);
  return `${weekday(day)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
