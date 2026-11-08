import crypto from "node:crypto";
import { loadEnv } from "./env.js";

export type OnChainGoalStatus = "open" | "attested" | "refunding" | "claimed";

export interface OnChainGoalState {
  id: number;
  targetSteps: number;
  attestedSteps: number;
  status: OnChainGoalStatus;
  totalStaked: number;
  transactionHash?: string;
}

export interface EscrowAttestResult {
  goalId: number;
  steps: number;
  transactionHash: string;
  status: "attested" | "already_attested";
}

export interface EscrowContractAdapter {
  readonly name: string;
  getGoalState(goalId: number): Promise<OnChainGoalState | null>;
  attestGoal(goalId: number, steps: number): Promise<EscrowAttestResult>;
  claimGoal(goalId: number): Promise<{ transactionHash: string; payout: number }>;
  refundGoal(goalId: number, funder: string): Promise<{ transactionHash: string; refunded: number }>;
}

/**
 * Deterministically maps a pot UUID to a 31-bit positive integer u32 goal ID
 * for Soroban goal-escrow contract storage keys.
 */
export function deriveGoalIdFromPotId(potId: string): number {
  const hash = crypto.createHash("sha256").update(potId).digest();
  // Read unsigned 32-bit int and mask sign bit to ensure positive non-zero u32
  const raw = hash.readUInt32BE(0) & 0x7fffffff;
  return raw === 0 ? 1 : raw;
}

export const mockEscrowState = {
  goals: new Map<number, OnChainGoalState>(),
  attestations: [] as EscrowAttestResult[],
  simulateNextFailure: false,
};

export function resetMockEscrowState(): void {
  mockEscrowState.goals.clear();
  mockEscrowState.attestations.length = 0;
  mockEscrowState.simulateNextFailure = false;
}

export const MockEscrowAdapter: EscrowContractAdapter = {
  name: "mock",

  async getGoalState(goalId: number): Promise<OnChainGoalState | null> {
    return mockEscrowState.goals.get(goalId) ?? null;
  },

  async attestGoal(goalId: number, steps: number): Promise<EscrowAttestResult> {
    if (mockEscrowState.simulateNextFailure) {
      mockEscrowState.simulateNextFailure = false;
      throw new Error(`Simulated Soroban RPC network timeout for goal ${goalId}`);
    }

    const existing = mockEscrowState.goals.get(goalId);
    if (existing && existing.status !== "open") {
      // Idempotent reconciliation: goal was already attested in a prior attempt before process crash
      return {
        goalId,
        steps: existing.attestedSteps,
        transactionHash: existing.transactionHash ?? `0x_recovered_${goalId}`,
        status: "already_attested",
      };
    }

    const txHash = `0x${crypto
      .createHash("sha256")
      .update(`mock_escrow:attest:${goalId}:${steps}:${Date.now()}`)
      .digest("hex")}`;

    const nextState: OnChainGoalState = {
      id: goalId,
      targetSteps: existing?.targetSteps ?? 10000,
      attestedSteps: steps,
      status: "attested",
      totalStaked: existing?.totalStaked ?? 0,
      transactionHash: txHash,
    };

    mockEscrowState.goals.set(goalId, nextState);

    const result: EscrowAttestResult = {
      goalId,
      steps,
      transactionHash: txHash,
      status: "attested",
    };
    mockEscrowState.attestations.push(result);
    return result;
  },

  async claimGoal(goalId: number): Promise<{ transactionHash: string; payout: number }> {
    const existing = mockEscrowState.goals.get(goalId);
    if (!existing || existing.status !== "attested") {
      throw new Error(`Goal ${goalId} is not in attested state for claim`);
    }

    const txHash = `0x${crypto
      .createHash("sha256")
      .update(`mock_escrow:claim:${goalId}:${Date.now()}`)
      .digest("hex")}`;

    existing.status = "claimed";
    existing.transactionHash = txHash;

    return {
      transactionHash: txHash,
      payout: existing.totalStaked,
    };
  },

  async refundGoal(
    goalId: number,
    funder: string,
  ): Promise<{ transactionHash: string; refunded: number }> {
    const existing = mockEscrowState.goals.get(goalId);
    const txHash = `0x${crypto
      .createHash("sha256")
      .update(`mock_escrow:refund:${goalId}:${funder}:${Date.now()}`)
      .digest("hex")}`;

    if (existing) {
      existing.status = "refunding";
      existing.transactionHash = txHash;
    }

    return {
      transactionHash: txHash,
      refunded: existing?.totalStaked ?? 0,
    };
  },
};

let cachedAdapter: EscrowContractAdapter | undefined;

export function getEscrowAdapter(): EscrowContractAdapter {
  if (cachedAdapter) return cachedAdapter;
  const env = loadEnv();
  cachedAdapter = env.ESCROW_PROVIDER === "soroban" ? createSorobanEscrowAdapter() : MockEscrowAdapter;
  return cachedAdapter;
}

export function setEscrowAdapterForTest(adapter: EscrowContractAdapter | undefined): void {
  cachedAdapter = adapter;
}

export function createSorobanEscrowAdapter(): EscrowContractAdapter {
  return MockEscrowAdapter;
}
