import { describe, it, expect } from "vitest";
import {
  generateOtp,
  pruneStaleOtpCodes,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_PER_HOUR,
  OTP_TTL_SECONDS,
  OTP_RETENTION_MS,
} from "../src/lib/otp.js";
import { otpCodes } from "../src/db/schema.js";

describe("otp helpers", () => {
  it("generates a 6-digit numeric string with leading zeros if necessary", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateOtp();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("exposes expected default constraints", () => {
    expect(OTP_TTL_SECONDS).toBe(600);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_MAX_PER_HOUR).toBe(5);
    expect(OTP_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("prunes rows older than cutoff and returns deleted count", async () => {
    const fixedNow = new Date("2026-11-01T12:00:00Z").getTime();
    let capturedTable: unknown;
    let capturedClause: unknown;

    const mockDb = {
      delete(table: unknown) {
        capturedTable = table;
        return {
          where(clause: unknown) {
            capturedClause = clause;
            return {
              returning(_fields: unknown) {
                // Simulate deleting two rows matching the clause
                return Promise.resolve([{ id: "row-1" }, { id: "row-2" }]);
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof pruneStaleOtpCodes>[0];

    const deletedCount = await pruneStaleOtpCodes(mockDb, OTP_RETENTION_MS, fixedNow);

    expect(deletedCount).toBe(2);
    expect(capturedTable).toBe(otpCodes);
    expect(capturedClause).toBeDefined();
  });
});
