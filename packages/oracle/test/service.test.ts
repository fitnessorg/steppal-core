import { describe, it, expect } from "vitest";
import { OracleService, isDeadlineExpired, canRefundUnattested } from "../src/service.js";
import { MockSorobanSigner } from "../src/signer.js";
import type { PotEvaluationContext, StepClaim } from "../src/types.js";

function makeClaim(
  userId: string,
  day: string,
  steps: number,
  overrides: Partial<StepClaim> = {},
): StepClaim {
  return {
    userId,
    day,
    steps,
    source: "health_connect",
    submittedAt: `2026-11-${day.slice(-2)}T19:00:00Z`,
    ...overrides,
  };
}

describe("OracleService integration", () => {
  it("evaluates valid pot claims and signs on-chain attestation", async () => {
    const signer = new MockSorobanSigner();
    const oracle = new OracleService({ signer });

    const context: PotEvaluationContext = {
      potId: "pot_green_001",
      dailyGoal: 10000,
      startsOn: "2026-11-01",
      endsOn: "2026-11-03",
      totalDays: 3,
      memberUserIds: ["usr_ada", "usr_tunde"],
      claims: [
        makeClaim("usr_ada", "2026-11-01", 10500),
        makeClaim("usr_ada", "2026-11-02", 11200),
        makeClaim("usr_ada", "2026-11-03", 12000),
        makeClaim("usr_tunde", "2026-11-01", 10100),
        makeClaim("usr_tunde", "2026-11-02", 10300),
        makeClaim("usr_tunde", "2026-11-03", 10800),
      ],
    };

    const result = await oracle.evaluateAndAttest(context, 77);

    expect(result.decision.action).toBe("attest");
    expect(result.decision.shouldStaySilent).toBe(false);
    expect(result.decision.attestedSteps).toBe(64900); // 33,700 + 31,200
    expect(result.attestationResult).toBeDefined();
    expect(result.attestationResult?.goalId).toBe(77);
    expect(result.attestationResult?.steps).toBe(64900);
    expect(signer.signedAttestations).toHaveLength(1);
  });

  it("stays silent and refuses attestation when fraudulent physical boundary is detected", async () => {
    const signer = new MockSorobanSigner();
    const oracle = new OracleService({ signer });

    const context: PotEvaluationContext = {
      potId: "pot_fraud_002",
      dailyGoal: 10000,
      startsOn: "2026-11-01",
      endsOn: "2026-11-02",
      totalDays: 2,
      memberUserIds: ["usr_cheater"],
      claims: [
        makeClaim("usr_cheater", "2026-11-01", 8000),
        makeClaim("usr_cheater", "2026-11-02", 85000), // Impossible human claim
      ],
    };

    const result = await oracle.evaluateAndAttest(context, 88);

    expect(result.decision.action).toBe("refuse");
    expect(result.decision.shouldStaySilent).toBe(true);
    expect(result.decision.attestedSteps).toBe(0);
    expect(result.attestationResult).toBeUndefined();
    // Signer must never have been called: oracle stays silent
    expect(signer.signedAttestations).toHaveLength(0);
  });

  describe("silent oracle timeout & refund guards", () => {
    it("checks deadline expiration correctly", () => {
      const deadline = 1000;
      expect(isDeadlineExpired(deadline, 999)).toBe(false);
      expect(isDeadlineExpired(deadline, 1000)).toBe(true);
      expect(isDeadlineExpired(deadline, 1001)).toBe(true);
    });

    it("evaluates unattested refund eligibility matching smart contract invariants", () => {
      const deadline = 5000;

      // Before deadline: refund not allowed
      expect(
        canRefundUnattested({ status: "open", deadline, attestedSteps: 0 }, 4999),
      ).toBe(false);

      // At exact deadline with no attestation: refund permitted
      expect(
        canRefundUnattested({ status: "open", deadline, attestedSteps: 0 }, 5000),
      ).toBe(true);

      // If already attested: cannot do unattested refund
      expect(
        canRefundUnattested({ status: "open", deadline, attestedSteps: 25000 }, 5000),
      ).toBe(false);
    });
  });
});
