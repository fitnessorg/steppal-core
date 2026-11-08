import { describe, it, expect, beforeEach } from "vitest";
import {
  MockEscrowAdapter,
  createSorobanEscrowAdapter,
  deriveGoalIdFromPotId,
  getEscrowAdapter,
  mockEscrowState,
  resetMockEscrowState,
  setEscrowAdapterForTest,
} from "../src/lib/escrow.js";
import { resetEnvForTest } from "../src/lib/env.js";

describe("escrow contract adapters", () => {
  beforeEach(() => {
    resetMockEscrowState();
    setEscrowAdapterForTest(undefined);
    resetEnvForTest();
  });

  describe("deriveGoalIdFromPotId", () => {
    it("maps pot UUIDs deterministically to positive 31-bit u32 integers", () => {
      const id1 = deriveGoalIdFromPotId("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      const id2 = deriveGoalIdFromPotId("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
      const id3 = deriveGoalIdFromPotId("ffffffff-ffff-ffff-ffff-ffffffffffff");

      expect(id1).toBe(id2);
      expect(id1).toBeGreaterThan(0);
      expect(id1).toBeLessThanOrEqual(0x7fffffff);
      expect(id3).toBeGreaterThan(0);
      expect(id1).not.toBe(id3);
    });
  });

  describe("MockEscrowAdapter", () => {
    it("is returned as the default escrow adapter", () => {
      expect(getEscrowAdapter().name).toBe("mock");
    });

    it("attests an open goal and transitions state to attested", async () => {
      const res = await MockEscrowAdapter.attestGoal(101, 45000);
      expect(res.goalId).toBe(101);
      expect(res.steps).toBe(45000);
      expect(res.status).toBe("attested");
      expect(res.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);

      const state = await MockEscrowAdapter.getGoalState(101);
      expect(state?.status).toBe("attested");
      expect(state?.attestedSteps).toBe(45000);
    });

    it("is idempotent when attesting an already-attested goal", async () => {
      const first = await MockEscrowAdapter.attestGoal(202, 50000);
      const second = await MockEscrowAdapter.attestGoal(202, 50000);

      expect(second.status).toBe("already_attested");
      expect(second.transactionHash).toBe(first.transactionHash);
      expect(mockEscrowState.attestations).toHaveLength(1);
    });

    it("supports claiming an attested goal and refunding", async () => {
      await MockEscrowAdapter.attestGoal(303, 60000);
      const claimed = await MockEscrowAdapter.claimGoal(303);
      expect(claimed.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);

      const state = await MockEscrowAdapter.getGoalState(303);
      expect(state?.status).toBe("claimed");

      const refunded = await MockEscrowAdapter.refundGoal(404, "G_FUNDER_1");
      expect(refunded.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("SorobanEscrowAdapter", () => {
    it("throws when ORACLE_SECRET_KEY is not configured", async () => {
      const adapter = createSorobanEscrowAdapter({ oracleSecretKey: "" });
      await expect(adapter.attestGoal(1, 10000)).rejects.toThrow(
        "ORACLE_SECRET_KEY is required",
      );
    });

    it("invokes Soroban RPC sendTransaction for attestGoal", async () => {
      let calledRpc = false;
      const mockFetch = (async () => {
        calledRpc = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: { hash: "0x_soroban_tx_999", status: "SUCCESS" },
          }),
        } as Response;
      }) as typeof fetch;

      const adapter = createSorobanEscrowAdapter({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractId: "C_ESCROW_TEST",
        oracleSecretKey: "S_TEST_ORACLE_KEY",
        fetchFn: mockFetch,
      });

      const res = await adapter.attestGoal(55, 70000);
      expect(calledRpc).toBe(true);
      expect(res.status).toBe("attested");
      expect(res.transactionHash).toBe("0x_soroban_tx_999");
    });

    it("reconciles NotOpen contract error as already_attested during crash recovery", async () => {
      let callCount = 0;
      const mockFetch = (async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              jsonrpc: "2.0",
              error: { code: -32000, message: "HostError: Error(Contract, #3) NotOpen" },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: {
              id: 55,
              targetSteps: 50000,
              attestedSteps: 70000,
              status: "attested",
              totalStaked: 200000,
              transactionHash: "0x_prior_tx_hash",
            },
          }),
        } as Response;
      }) as typeof fetch;

      const adapter = createSorobanEscrowAdapter({
        oracleSecretKey: "S_TEST_ORACLE_KEY",
        fetchFn: mockFetch,
      });

      const res = await adapter.attestGoal(55, 70000);
      expect(res.status).toBe("already_attested");
      expect(res.transactionHash).toBe("0x_prior_tx_hash");
    });
  });
});
