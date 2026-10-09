import { randomInt } from "node:crypto";

/** Six digits, uniformly random — randomInt avoids the modulo bias of Math.random. */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
/** Codes requested per phone per hour before the endpoint starts refusing. */
export const OTP_MAX_PER_HOUR = 5;
