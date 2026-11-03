import { randomInt } from "node:crypto";
import { lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { otpCodes } from "../db/schema.js";

/** Six digits, uniformly random — randomInt avoids the modulo bias of Math.random. */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
/** Codes requested per phone per hour before the endpoint starts refusing. */
export const OTP_MAX_PER_HOUR = 5;

/** Retention period before consumed or stale OTP rows are pruned (30 days). */
export const OTP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Prunes OTP rows older than the retention threshold.
 * Kept after use to detect brute-force bursts, but discarded past 30 days.
 */
export async function pruneStaleOtpCodes(
  dbInstance: { delete: typeof db.delete } = db,
  olderThanMs = OTP_RETENTION_MS,
  now = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - olderThanMs);
  const deleted = await dbInstance
    .delete(otpCodes)
    .where(lt(otpCodes.createdAt, cutoff))
    .returning({ id: otpCodes.id });

  return deleted.length;
}
