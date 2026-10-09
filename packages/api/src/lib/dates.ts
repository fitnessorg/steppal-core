/**
 * Dates here are local calendar days written as YYYY-MM-DD, never instants.
 *
 * A step belongs to the day the walker lived, not to a UTC window. Storing a
 * timestamp would make a pot that ends "Sunday" end at 1am Monday in Lagos,
 * which is exactly the kind of detail that makes people distrust a settlement.
 */
export type DayKey = string;

export function toDayKey(d: Date): DayKey {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDayKey(key: DayKey): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function addDays(key: DayKey, n: number): DayKey {
  const d = parseDayKey(key);
  d.setDate(d.getDate() + n);
  return toDayKey(d);
}

/** Every day from `from` to `to` inclusive. */
export function daysBetween(from: DayKey, to: DayKey): DayKey[] {
  const out: DayKey[] = [];
  let cursor = from;
  // Guard against an inverted range rather than looping forever.
  for (let i = 0; i < 400 && cursor <= to; i++) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

export function todayKey(): DayKey {
  return toDayKey(new Date());
}

export const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
