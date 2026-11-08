import { describe, it, expect } from "vitest";
import { computeSettlementPayouts } from "../src/lib/settlement.js";

describe("computeSettlementPayouts pure math", () => {
  it("splits forfeited stakes evenly among winners", () => {
    const result = computeSettlementPayouts({
      stakeKobo: 200_000,
      daysPossible: 3,
      members: [
        { userId: "ada", daysHit: 3, totalSteps: 32000 },
        { userId: "bisi", daysHit: 3, totalSteps: 30000 },
        { userId: "tunde", daysHit: 2, totalSteps: 21000 },
      ],
    });

    expect(result.winners).toEqual(["ada", "bisi"]);
    expect(result.losers).toEqual(["tunde"]);
    expect(result.refundAll).toBe(false);
    expect(result.payouts).toEqual([
      { userId: "ada", payoutKobo: 300_000 },
      { userId: "bisi", payoutKobo: 300_000 },
      { userId: "tunde", payoutKobo: 0 },
    ]);
  });

  it("assigns integer division remainder to the winner with the most steps", () => {
    const result = computeSettlementPayouts({
      stakeKobo: 100_000,
      daysPossible: 3,
      members: [
        { userId: "ada", daysHit: 3, totalSteps: 31000 },
        { userId: "bisi", daysHit: 3, totalSteps: 45000 }, // Top walker
        { userId: "chidi", daysHit: 3, totalSteps: 30500 },
        { userId: "tunde", daysHit: 1, totalSteps: 9000 }, // Forfeits 100,000 kobo -> 33,333 each + 1 remainder
      ],
    });

    const bisiPayout = result.payouts.find((p) => p.userId === "bisi")!.payoutKobo;
    const adaPayout = result.payouts.find((p) => p.userId === "ada")!.payoutKobo;
    const chidiPayout = result.payouts.find((p) => p.userId === "chidi")!.payoutKobo;

    expect(bisiPayout).toBe(133_334);
    expect(adaPayout).toBe(133_333);
    expect(chidiPayout).toBe(133_333);

    const total = result.payouts.reduce((acc, p) => acc + p.payoutKobo, 0);
    expect(total).toBe(400_000);
  });

  it("refunds everyone their exact stake when nobody meets the goal", () => {
    const result = computeSettlementPayouts({
      stakeKobo: 150_000,
      daysPossible: 5,
      members: [
        { userId: "ada", daysHit: 4, totalSteps: 42000 },
        { userId: "tunde", daysHit: 2, totalSteps: 19000 },
      ],
    });

    expect(result.winners).toEqual([]);
    expect(result.refundAll).toBe(true);
    expect(result.payouts).toEqual([
      { userId: "ada", payoutKobo: 150_000 },
      { userId: "tunde", payoutKobo: 150_000 },
    ]);
  });

  it("handles zero-stake pots cleanly", () => {
    const result = computeSettlementPayouts({
      stakeKobo: 0,
      daysPossible: 3,
      members: [
        { userId: "ada", daysHit: 3, totalSteps: 30000 },
        { userId: "tunde", daysHit: 1, totalSteps: 8000 },
      ],
    });

    expect(result.payouts).toEqual([
      { userId: "ada", payoutKobo: 0 },
      { userId: "tunde", payoutKobo: 0 },
    ]);
  });
});
