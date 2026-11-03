import { pruneStaleOtpCodes } from "../lib/otp.js";
import { queryClient } from "../db/client.js";

/**
 * Run with `pnpm prune:otp`. Deletes OTP rows older than 30 days to prevent
 * unbounded database growth while preserving short-term request rate auditability.
 */
async function main() {
  const count = await pruneStaleOtpCodes();
  console.log(`Pruned ${count} stale OTP row(s).`);
  await queryClient.end();
}

main().catch(async (err) => {
  console.error("OTP pruning failed:", err);
  await queryClient.end();
  process.exit(1);
});
