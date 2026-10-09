import { settleDuePots } from "../lib/settlement.js";
import { queryClient } from "../db/client.js";

/**
 * Run with `pnpm settle`. Intended for a daily scheduler — it is safe to run
 * as often as you like, because settling an already-settled pot does nothing.
 */
async function main() {
  const settled = await settleDuePots();

  if (settled.length === 0) {
    console.log("No pots were due.");
  } else {
    for (const s of settled) {
      console.log(
        `Settled ${s.potId}: ${s.winners.length} met the goal, ${s.losers.length} did not.`,
      );
    }
  }

  await queryClient.end();
}

main().catch(async (err) => {
  console.error("Settlement failed:", err);
  await queryClient.end();
  process.exit(1);
});
