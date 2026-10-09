import { loadEnv } from "./env.js";
import { toDayKey, todayKey, type DayKey } from "./dates.js";

export type StepSubmission = { day: DayKey; steps: number; source: string };

export type ValidationResult =
  | { ok: true; day: DayKey; steps: number; rawSteps: number | null }
  | { ok: false; reason: "future_day" | "too_old" | "negative" };

/** A week back. Older than this and the pot it would affect has already settled. */
const MAX_BACKFILL_DAYS = 8;

/**
 * The server's opinion of a submitted step count.
 *
 * The phone reports; the server decides. Three rules, each closing a specific
 * cheat or bug:
 *
 * - A day in the future is rejected outright. Nobody has walked tomorrow, and
 *   accepting it would let a member with a wrong clock bank a week ahead.
 * - A day more than a week old is rejected. Backfill exists for a phone that
 *   was offline, not for topping up a pot that is about to settle.
 * - A count above the daily cap is clamped, not rejected, and the original is
 *   kept in `raw_steps`. Clamping keeps an honest person with a pedometer glitch
 *   in the game while removing the benefit of shaking a phone for an hour, and
 *   keeping the raw number means a reviewer can see what was claimed.
 *
 * Deliberately not here: device attestation, velocity checks across days,
 * cross-referencing distance. Those belong in the oracle, which has the full
 * history. This is the cheap gate that runs on every write.
 */
export function validateSubmission(input: StepSubmission): ValidationResult {
  const cap = loadEnv().DAILY_STEP_CAP;

  if (input.steps < 0) return { ok: false, reason: "negative" };
  if (input.day > todayKey()) return { ok: false, reason: "future_day" };

  const oldest = new Date();
  oldest.setDate(oldest.getDate() - MAX_BACKFILL_DAYS);
  if (input.day < toDayKey(oldest)) return { ok: false, reason: "too_old" };

  if (input.steps > cap) {
    return { ok: true, day: input.day, steps: cap, rawSteps: input.steps };
  }

  return { ok: true, day: input.day, steps: input.steps, rawSteps: null };
}
