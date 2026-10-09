import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { potResults, pots } from "../db/schema.js";
import { progressFor } from "./pots.js";
import { todayKey } from "./dates.js";

export type Settlement = {
  potId: string;
  winners: string[];
  losers: string[];
  payouts: { userId: string; payoutKobo: number }[];
};

/**
 * Settle one pot.
 *
 * The rule is deliberately not "most steps wins". Most steps rewards whoever
 * has the most free time, which in a group of friends is usually the same
 * person every week, and the rest stop playing. Instead each member is judged
 * against the same daily goal: hit it every day of the window and you are a
 * winner. Everyone can win. Everyone can lose.
 *
 * The forfeit pot is split evenly among the winners. When nobody wins, stakes
 * are returned rather than kept — StepPal never profits from a member failing,
 * which matters both ethically and for staying the right side of a regulator
 * who would otherwise see a house taking a rake.
 *
 * Idempotent: a settled pot returns its stored result and writes nothing. The
 * job that calls this will be retried, and double-paying is unforgivable.
 */
export async function settlePot(potId: string): Promise<Settlement | null> {
  const rows = await db.select().from(pots).where(eq(pots.id, potId)).limit(1);
  const pot = rows[0];
  if (!pot) return null;

  if (pot.status === "settled") {
    const stored = await db.select().from(potResults).where(eq(potResults.potId, pot.id));
    return {
      potId: pot.id,
      winners: stored.filter((r) => r.metGoal === "yes").map((r) => r.userId),
      losers: stored.filter((r) => r.metGoal === "no").map((r) => r.userId),
      payouts: stored.map((r) => ({ userId: r.userId, payoutKobo: r.payoutKobo })),
    };
  }

  // A pot settles the day after it ends, so the final day's steps have a full
  // night to sync from a phone that was asleep.
  if (todayKey() <= pot.endsOn) return null;

  const { window, members } = await progressFor(pot, pot.endsOn);
  if (members.length === 0) return null;

  const daysPossible = window.length;
  const winners = members.filter((m) => m.daysHit === daysPossible);
  const losers = members.filter((m) => m.daysHit < daysPossible);

  const forfeited = losers.length * pot.stakeKobo;

  // Integer kobo only. The remainder from an uneven split goes to the member
  // who walked the most, because it has to go somewhere and silently vanishing
  // money is how a settlement loses trust.
  const share = winners.length > 0 ? Math.floor(forfeited / winners.length) : 0;
  const remainder = winners.length > 0 ? forfeited - share * winners.length : 0;

  const payouts = members.map((m) => {
    const won = m.daysHit === daysPossible;
    if (!won) return { userId: m.userId, payoutKobo: 0 };
    const isTop = winners[0]?.userId === m.userId;
    return { userId: m.userId, payoutKobo: pot.stakeKobo + share + (isTop ? remainder : 0) };
  });

  // Nobody met the goal: everyone gets their own stake back.
  const refundAll = winners.length === 0;

  await db.transaction(async (tx) => {
    await tx.insert(potResults).values(
      members.map((m) => ({
        potId: pot.id,
        userId: m.userId,
        daysHit: m.daysHit,
        daysPossible,
        totalSteps: m.totalSteps,
        metGoal: (m.daysHit === daysPossible ? "yes" : "no") as "yes" | "no",
        payoutKobo: refundAll
          ? pot.stakeKobo
          : (payouts.find((p) => p.userId === m.userId)?.payoutKobo ?? 0),
      })),
    );

    await tx
      .update(pots)
      .set({ status: "settled", settledAt: new Date() })
      .where(eq(pots.id, pot.id));
  });

  return {
    potId: pot.id,
    winners: winners.map((w) => w.userId),
    losers: losers.map((l) => l.userId),
    payouts: refundAll
      ? members.map((m) => ({ userId: m.userId, payoutKobo: pot.stakeKobo }))
      : payouts,
  };
}

/** Every pot whose window has closed and which has not been settled yet. */
export async function settleDuePots(): Promise<Settlement[]> {
  const due = await db.select().from(pots).where(eq(pots.status, "running"));
  const open = await db.select().from(pots).where(eq(pots.status, "open"));

  const settled: Settlement[] = [];
  for (const pot of [...due, ...open]) {
    if (todayKey() <= pot.endsOn) continue;
    const result = await settlePot(pot.id);
    if (result) settled.push(result);
  }
  return settled;
}
