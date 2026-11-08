import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { potResults, pots } from "../db/schema.js";
import { recoverOrphanedSettlements } from "../lib/settlement-coordinator.js";

/**
 * Run with `pnpm settle:recover`.
 * Scans for interrupted two-phase settlements (`intent_recorded` or `chain_attested`),
 * reconciles on-chain state with Soroban `goal-escrow`, and completes DB finalization.
 */
async function main() {
  const report = await recoverOrphanedSettlements({
    finalizePersistence: async (journalEntry) => {
      await db.transaction(async (tx) => {
        await tx
          .insert(potResults)
          .values(
            journalEntry.members.map((m) => ({
              potId: journalEntry.potId,
              userId: m.userId,
              daysHit: m.daysHit,
              daysPossible: journalEntry.daysPossible,
              totalSteps: m.totalSteps,
              metGoal: (m.daysHit === journalEntry.daysPossible ? "yes" : "no") as
                | "yes"
                | "no",
              payoutKobo:
                journalEntry.computed.payouts.find((p) => p.userId === m.userId)
                  ?.payoutKobo ?? 0,
            })),
          )
          .onConflictDoNothing();

        await tx
          .update(pots)
          .set({ status: "settled", settledAt: new Date() })
          .where(eq(pots.id, journalEntry.potId));
      });
    },
  });

  console.log(
    `[settle:recover] Inspected ${report.inspected} orphaned settlement(s), recovered ${report.recovered.length}, failed ${report.failed.length}.`,
  );

  await queryClient.end();
}

main().catch(async (err) => {
  console.error("Settlement recovery failed:", err);
  await queryClient.end();
  process.exit(1);
});
