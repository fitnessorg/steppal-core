import { describe, it, expect } from "vitest";
import {
  checkPhysicalBoundaries,
  checkCrossDayVelocity,
  checkDeviceConsistency,
  checkStepUniformity,
  evaluateUserClaims,
} from "../src/anti-cheat.js";
import type { StepClaim } from "../src/types.js";

function makeClaim(
  day: string,
  steps: number,
  overrides: Partial<StepClaim> = {},
): StepClaim {
  return {
    userId: "usr_001",
    day,
    steps,
    source: "health_connect",
    submittedAt: `2026-11-${day.slice(-2)}T18:00:00Z`,
    ...overrides,
  };
}

describe("anti-cheat heuristics", () => {
  describe("checkPhysicalBoundaries", () => {
    it("passes realistic human step claims", () => {
      const claims = [
        makeClaim("2026-11-01", 8500),
        makeClaim("2026-11-02", 14200),
        makeClaim("2026-11-03", 22000),
      ];
      const result = checkPhysicalBoundaries(claims);
      expect(result.passed).toBe(true);
      expect(result.penaltyScore).toBe(0);
      expect(result.flags).toEqual([]);
    });

    it("flags claims that exceed absolute physical limits", () => {
      const claims = [
        makeClaim("2026-11-01", 10000),
        makeClaim("2026-11-02", 75000), // Impossible for 24 hours
      ];
      const result = checkPhysicalBoundaries(claims);
      expect(result.passed).toBe(false);
      expect(result.flags).toContain("IMPLAUSIBLE_STEP_BURST");
      expect(result.flags).toContain("DAILY_CAP_EXCEEDED");
      expect(result.penaltyScore).toBeGreaterThan(0.5);
    });
  });

  describe("checkCrossDayVelocity", () => {
    it("passes steady or gradual walking volume increases", () => {
      const claims = [
        makeClaim("2026-11-01", 6000),
        makeClaim("2026-11-02", 9000),
        makeClaim("2026-11-03", 11000),
      ];
      const result = checkCrossDayVelocity(claims);
      expect(result.passed).toBe(true);
      expect(result.flags).toEqual([]);
    });

    it("flags extreme velocity jumps between consecutive days", () => {
      const claims = [
        makeClaim("2026-11-01", 600),
        makeClaim("2026-11-02", 18000), // 30x spike
      ];
      const result = checkCrossDayVelocity(claims);
      expect(result.passed).toBe(false);
      expect(result.flags).toContain("VELOCITY_SPIKE");
      expect(result.details).toContain("Velocity spike");
    });

    it("flags cadence exceeding physical sprint speed between timestamps", () => {
      const claims = [
        makeClaim("2026-11-01", 1000, { submittedAt: "2026-11-01T12:00:00Z" }),
        makeClaim("2026-11-02", 15000, { submittedAt: "2026-11-01T12:05:00Z" }), // 14,000 steps in 300 seconds = 46 steps/sec!
      ];
      const result = checkCrossDayVelocity(claims);
      expect(result.passed).toBe(false);
      expect(result.flags).toContain("VELOCITY_SPIKE");
      expect(result.details).toContain("Impossible cadence");
    });
  });

  describe("checkDeviceConsistency", () => {
    it("passes consistent single device sensor records", () => {
      const claims = [
        makeClaim("2026-11-01", 10000, { source: "health_connect", deviceHash: "dev_pixel8" }),
        makeClaim("2026-11-02", 10500, { source: "health_connect", deviceHash: "dev_pixel8" }),
      ];
      const result = checkDeviceConsistency(claims);
      expect(result.passed).toBe(true);
    });

    it("flags conflicting mix of mock and physical sensor sources", () => {
      const claims = [
        makeClaim("2026-11-01", 10000, { source: "health_connect" }),
        makeClaim("2026-11-02", 11000, { source: "mock" }),
      ];
      const result = checkDeviceConsistency(claims);
      expect(result.passed).toBe(false);
      expect(result.flags).toContain("SOURCE_MISMATCH");
    });

    it("flags excessive device hash rotation across days", () => {
      const claims = [
        makeClaim("2026-11-01", 10000, { deviceHash: "dev_1" }),
        makeClaim("2026-11-02", 10000, { deviceHash: "dev_2" }),
        makeClaim("2026-11-03", 10000, { deviceHash: "dev_3" }),
        makeClaim("2026-11-04", 10000, { deviceHash: "dev_4" }),
      ];
      const result = checkDeviceConsistency(claims);
      expect(result.passed).toBe(false);
      expect(result.flags).toContain("DEVICE_INCONSISTENCY");
    });
  });

  describe("checkStepUniformity", () => {
    it("passes natural varying human steps", () => {
      const claims = [
        makeClaim("2026-11-01", 10214),
        makeClaim("2026-11-02", 11540),
        makeClaim("2026-11-03", 9840),
        makeClaim("2026-11-04", 12300),
      ];
      const result = checkStepUniformity(claims);
      expect(result.passed).toBe(true);
    });

    it("flags synthetic bot step claims repeating identical figures", () => {
      const claims = [
        makeClaim("2026-11-01", 10000),
        makeClaim("2026-11-02", 10000),
        makeClaim("2026-11-03", 10000),
        makeClaim("2026-11-04", 10000),
      ];
      const result = checkStepUniformity(claims);
      expect(result.passed).toBe(false);
      expect(result.flags).toContain("UNNATURAL_UNIFORMITY");
    });
  });

  describe("evaluateUserClaims composite evaluator", () => {
    it("evaluates clean legitimate walking patterns as verified winners", () => {
      const claims = [
        makeClaim("2026-11-01", 10250),
        makeClaim("2026-11-02", 11400),
        makeClaim("2026-11-03", 12100),
      ];
      const evaluation = evaluateUserClaims("usr_honest", claims, {
        dailyGoal: 10000,
        totalDays: 3,
      });

      expect(evaluation.passedAntiCheat).toBe(true);
      expect(evaluation.confidenceScore).toBe(1.0);
      expect(evaluation.metGoal).toBe(true);
      expect(evaluation.daysHit).toBe(3);
      expect(evaluation.verifiedSteps).toBe(33750);
      expect(evaluation.refusalReason).toBeUndefined();
    });

    it("zeros verified steps and sets refusal reason when anti-cheat fails", () => {
      const claims = [
        makeClaim("2026-11-01", 600),
        makeClaim("2026-11-02", 75000), // Physical boundary violation + spike
      ];
      const evaluation = evaluateUserClaims("usr_cheater", claims, {
        dailyGoal: 10000,
        totalDays: 2,
      });

      expect(evaluation.passedAntiCheat).toBe(false);
      expect(evaluation.verifiedSteps).toBe(0);
      expect(evaluation.metGoal).toBe(false);
      expect(evaluation.confidenceScore).toBeLessThan(0.7);
      expect(evaluation.refusalReason).toContain("Anti-cheat failed");
    });
  });
});
