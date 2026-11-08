import { describe, it, expect, beforeEach } from "vitest";
import {
  DefaultSettlementJournal,
  executeTwoPhaseSettlement,
  recoverOrphanedSettlements,
  type SettlementJournalEntry,
} from "../src/lib/settlement-coordinator.js";
import {
  MockEscrowAdapter,
  deriveGoalIdFromPotId,
  mockEscrowState,
  resetMockEscrowState,
} from "../src/lib/escrow.js";

describe("two-phase settlement coordinator & crash recovery", () => {
  beforeEach(() => {
    DefaultSettlementJournal.clear();
    resetMockEscrowState();
  });

  const sampleMembers = [
    { userId: "usr_ada", daysHit: 3, totalSteps: 34000 },
    { userId: "usr_tunde", daysHit: 2, totalSteps: 19000 },
  ];

  it("executes all phases end-to-end and attests staked pot on chain", async () => {
    const finalizedEntries: SettlementJournalEntry[] = [];

    const entry = await executeTwoPhaseSettlement({
      potId: "11111111-2222-3333-4444-555555555555",
      stakeKobo: 250_000,
      daysPossible: 3,
      members: sampleMembers,
      escrow: MockEscrowAdapter,
      finalizePersistence: async (e) => {
        finalizedEntries.push(e);
      },
    });

    expect(entry.phase).toBe("finalized");
    expect(entry.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(entry.computed.winners).toEqual(["usr_ada"]);
    expect(entry.computed.payouts).toEqual([
      { userId: "usr_ada", payoutKobo: 500_000 },
      { userId: "usr_tunde", payoutKobo: 0 },
    ]);
    expect(finalizedEntries).toHaveLength(1);
    expect(mockEscrowState.attestations).toHaveLength(1);
    expect(mockEscrowState.attestations[0]!.steps).toBe(34000);
  });

  it("recovers cleanly when process fails during Phase 2 (chain RPC failure)", async () => {
    const potId = "22222222-3333-4444-5555-666666666666";
    mockEscrowState.simulateNextFailure = true;

    let dbFinalized = false;

    await expect(
      executeTwoPhaseSettlement({
        potId,
        stakeKobo: 100_000,
        daysPossible: 3,
        members: sampleMembers,
        escrow: MockEscrowAdapter,
        finalizePersistence: async () => {
          dbFinalized = true;
        },
      }),
    ).rejects.toThrow("Simulated Soroban RPC network timeout");

    // Verify journal preserved intention at Phase 1
    const interrupted = await DefaultSettlementJournal.get(potId);
    expect(interrupted?.phase).toBe("intent_recorded");
    expect(dbFinalized).toBe(false);

    // Run recovery job
    const report = await recoverOrphanedSettlements({
      escrow: MockEscrowAdapter,
      finalizePersistence: async () => {
        dbFinalized = true;
      },
    });

    expect(report.inspected).toBe(1);
    expect(report.recovered).toEqual([potId]);
    expect(dbFinalized).toBe(true);

    const recovered = await DefaultSettlementJournal.get(potId);
    expect(recovered?.phase).toBe("finalized");
    expect(recovered?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("recovers cleanly without double-attesting when process crashes after Phase 2 before DB commit", async () => {
    const potId = "33333333-4444-5555-6666-777777777777";
    let shouldFailDb = true;
    let dbWriteCount = 0;

    await expect(
      executeTwoPhaseSettlement({
        potId,
        stakeKobo: 150_000,
        daysPossible: 3,
        members: sampleMembers,
        escrow: MockEscrowAdapter,
        finalizePersistence: async () => {
          if (shouldFailDb) {
            throw new Error("Simulated Postgres connection drop mid-settlement");
          }
          dbWriteCount++;
        },
      }),
    ).rejects.toThrow("Simulated Postgres connection drop mid-settlement");

    // Verify journal is at chain_attested and chain was called exactly once
    const midState = await DefaultSettlementJournal.get(potId);
    expect(midState?.phase).toBe("chain_attested");
    expect(midState?.transactionHash).toBeDefined();
    expect(mockEscrowState.attestations).toHaveLength(1);

    // Now DB recovers and recovery job runs
    shouldFailDb = false;
    const report = await recoverOrphanedSettlements({
      escrow: MockEscrowAdapter,
      finalizePersistence: async () => {
        dbWriteCount++;
      },
    });

    expect(report.recovered).toEqual([potId]);
    expect(dbWriteCount).toBe(1);
    // Crucial: chain must NOT have been called a second time
    expect(mockEscrowState.attestations).toHaveLength(1);
  });

  it("reconciles on-chain state when process died right after chain accepted tx before journal update", async () => {
    const potId = "44444444-5555-6666-7777-888888888888";
    const goalId = deriveGoalIdFromPotId(potId);

    // Pre-populate on-chain state as already attested (simulating crash right after RPC send)
    await MockEscrowAdapter.attestGoal(goalId, 34000);
    expect(mockEscrowState.attestations).toHaveLength(1);

    // Manually save journal at intent_recorded
    await DefaultSettlementJournal.save({
      potId,
      goalId,
      stakeKobo: 100_000,
      daysPossible: 3,
      members: sampleMembers,
      computed: {
        winners: ["usr_ada"],
        losers: ["usr_tunde"],
        payouts: [
          { userId: "usr_ada", payoutKobo: 200_000 },
          { userId: "usr_tunde", payoutKobo: 0 },
        ],
        refundAll: false,
        totalVerifiedSteps: 34000,
      },
      phase: "intent_recorded",
      attempts: 1,
      updatedAt: new Date(),
    });

    let finalized = false;
    const report = await recoverOrphanedSettlements({
      escrow: MockEscrowAdapter,
      finalizePersistence: async () => {
        finalized = true;
      },
    });

    expect(report.recovered).toEqual([potId]);
    expect(finalized).toBe(true);
    // Still only 1 attestation on chain
    expect(mockEscrowState.attestations).toHaveLength(1);
  });

  it("is strictly idempotent when called repeatedly on a finalized pot", async () => {
    const potId = "55555555-6666-7777-8888-999999999999";
    let dbCalls = 0;

    const first = await executeTwoPhaseSettlement({
      potId,
      stakeKobo: 100_000,
      daysPossible: 3,
      members: sampleMembers,
      escrow: MockEscrowAdapter,
      finalizePersistence: async () => {
        dbCalls++;
      },
    });

    const second = await executeTwoPhaseSettlement({
      potId,
      stakeKobo: 100_000,
      daysPossible: 3,
      members: sampleMembers,
      escrow: MockEscrowAdapter,
      finalizePersistence: async () => {
        dbCalls++;
      },
    });

    expect(second.transactionHash).toBe(first.transactionHash);
    expect(dbCalls).toBe(1);
    expect(mockEscrowState.attestations).toHaveLength(1);
  });
});
