import {
  deriveGoalIdFromPotId,
  getEscrowAdapter,
  type EscrowContractAdapter,
} from "./escrow.js";
import {
  computeSettlementPayouts,
  type ComputedSettlement,
  type MemberSettlementStanding,
} from "./settlement.js";

export type SettlementPhase = "intent_recorded" | "chain_attested" | "finalized";

export interface SettlementJournalEntry {
  potId: string;
  goalId: number;
  stakeKobo: number;
  daysPossible: number;
  members: MemberSettlementStanding[];
  computed: ComputedSettlement;
  phase: SettlementPhase;
  transactionHash?: string;
  attempts: number;
  lastError?: string;
  updatedAt: Date;
}

export interface SettlementJournalStore {
  get(potId: string): Promise<SettlementJournalEntry | null>;
  save(entry: SettlementJournalEntry): Promise<void>;
  listOrphaned(): Promise<SettlementJournalEntry[]>;
  clear(): void;
}

const journalMemory = new Map<string, SettlementJournalEntry>();

export const DefaultSettlementJournal: SettlementJournalStore = {
  async get(potId: string) {
    return journalMemory.get(potId) ?? null;
  },
  async save(entry: SettlementJournalEntry) {
    journalMemory.set(entry.potId, { ...entry, updatedAt: new Date() });
  },
  async listOrphaned() {
    const orphaned: SettlementJournalEntry[] = [];
    for (const entry of journalMemory.values()) {
      if (entry.phase !== "finalized") {
        orphaned.push(entry);
      }
    }
    return orphaned;
  },
  clear() {
    journalMemory.clear();
  },
};

export interface TwoPhaseSettlementOptions {
  potId: string;
  stakeKobo: number;
  daysPossible: number;
  members: MemberSettlementStanding[];
  finalizePersistence: (entry: SettlementJournalEntry) => Promise<void>;
  journal?: SettlementJournalStore;
  escrow?: EscrowContractAdapter;
}

/**
 * Executes a crash-resilient two-phase settlement:
 *   Phase 1 (intent_recorded): freezes payout computation and writes intention journal.
 *   Phase 2 (chain_attested): invokes Soroban goal-escrow contract for non-zero stakes.
 *   Phase 3 (finalized): writes final DB rows and marks journal finalized.
 *
 * Any crash between phases leaves a recoverable journal state that the next run finishes
 * without double-attesting or losing consistency.
 */
export async function executeTwoPhaseSettlement(
  options: TwoPhaseSettlementOptions,
): Promise<SettlementJournalEntry> {
  const journal = options.journal ?? DefaultSettlementJournal;
  const escrow = options.escrow ?? getEscrowAdapter();

  let entry = await journal.get(options.potId);

  if (entry?.phase === "finalized") {
    return entry;
  }

  // Phase 1: Record settlement intention if not yet recorded
  if (!entry) {
    const computed = computeSettlementPayouts({
      stakeKobo: options.stakeKobo,
      daysPossible: options.daysPossible,
      members: options.members,
    });

    entry = {
      potId: options.potId,
      goalId: deriveGoalIdFromPotId(options.potId),
      stakeKobo: options.stakeKobo,
      daysPossible: options.daysPossible,
      members: options.members,
      computed,
      phase: "intent_recorded",
      attempts: 0,
      updatedAt: new Date(),
    };
    await journal.save(entry);
  }

  // Phase 2: Invoke Soroban goal-escrow contract if still in intent_recorded
  if (entry.phase === "intent_recorded") {
    entry.attempts += 1;
    try {
      if (entry.stakeKobo > 0) {
        const chainRes = await escrow.attestGoal(
          entry.goalId,
          entry.computed.totalVerifiedSteps,
        );
        entry.transactionHash = chainRes.transactionHash;
      } else {
        entry.transactionHash = "0x0_zero_stake";
      }
      entry.phase = "chain_attested";
      entry.lastError = undefined;
      await journal.save(entry);
    } catch (err) {
      entry.lastError = (err as Error).message;
      await journal.save(entry);
      throw err;
    }
  }

  // Phase 3: Finalize DB persistence if in chain_attested
  if (entry.phase === "chain_attested") {
    try {
      await options.finalizePersistence(entry);
      entry.phase = "finalized";
      entry.lastError = undefined;
      await journal.save(entry);
    } catch (err) {
      entry.lastError = (err as Error).message;
      await journal.save(entry);
      throw err;
    }
  }

  return entry;
}

export interface RecoveryReport {
  inspected: number;
  recovered: string[];
  failed: { potId: string; error: string }[];
}

/**
 * Scans the settlement journal for interrupted/orphaned settlements in
 * `intent_recorded` or `chain_attested` states, reconciles on-chain status,
 * and drives them to `finalized`.
 */
export async function recoverOrphanedSettlements(options: {
  finalizePersistence: (entry: SettlementJournalEntry) => Promise<void>;
  journal?: SettlementJournalStore;
  escrow?: EscrowContractAdapter;
}): Promise<RecoveryReport> {
  const journal = options.journal ?? DefaultSettlementJournal;
  const escrow = options.escrow ?? getEscrowAdapter();

  const orphaned = await journal.listOrphaned();
  const recovered: string[] = [];
  const failed: { potId: string; error: string }[] = [];

  for (const entry of orphaned) {
    try {
      // If interrupted during Phase 2, check if on-chain goal state already advanced
      if (entry.phase === "intent_recorded" && entry.stakeKobo > 0) {
        const onChain = await escrow.getGoalState(entry.goalId);
        if (onChain && onChain.status !== "open") {
          entry.phase = "chain_attested";
          entry.transactionHash =
            onChain.transactionHash ?? `0x_reconciled_${entry.goalId}`;
          await journal.save(entry);
        }
      }

      const completed = await executeTwoPhaseSettlement({
        potId: entry.potId,
        stakeKobo: entry.stakeKobo,
        daysPossible: entry.daysPossible,
        members: entry.members,
        finalizePersistence: options.finalizePersistence,
        journal,
        escrow,
      });

      if (completed.phase === "finalized") {
        recovered.push(entry.potId);
      }
    } catch (err) {
      failed.push({ potId: entry.potId, error: (err as Error).message });
    }
  }

  return {
    inspected: orphaned.length,
    recovered,
    failed,
  };
}
