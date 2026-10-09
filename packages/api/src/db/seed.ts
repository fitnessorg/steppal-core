import { db, queryClient } from "./client.js";
import { potMembers, pots, stepDays, users } from "./schema.js";
import { inviteCodeCandidate } from "../lib/invite.js";
import { addDays, daysBetween, todayKey } from "../lib/dates.js";

/**
 * Puts a believable week into an empty database.
 *
 * A fresh clone should show something within a minute of `pnpm db:seed`, and
 * the numbers should look like people rather than test fixtures: one member
 * who is cruising, one who is close, one who blew a day. A seed where everyone
 * hits 10,000 exactly teaches a contributor nothing about the UI they are
 * about to change.
 */

const PEOPLE = [
  { phone: "+2348031234567", displayName: "Ada", avatarSeed: "ada" },
  { phone: "+2348039998888", displayName: "Tunde", avatarSeed: "tunde" },
  { phone: "+2348037776666", displayName: "Bisi", avatarSeed: "bisi" },
];

/** Index into PEOPLE, then into the week. Hand-picked, not random, so the
 *  seeded screenshots are the same for everyone. */
const WEEK = [
  [11200, 9800, 12400, 10100, 9300, 14000, 10500], // Ada: never misses
  [10300, 8200, 11000, 9900, 10200, 7600, 10800], // Tunde: two near misses
  [4300, 12100, 9600, 1200, 10400, 9950, 11300], // Bisi: lost Thursday
];

async function main() {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing[0]) {
    console.log("Database is not empty — leaving it alone.");
    await queryClient.end();
    return;
  }

  const inserted = await db.insert(users).values(PEOPLE).returning();

  const startsOn = addDays(todayKey(), -6);
  const endsOn = todayKey();

  const [pot] = await db
    .insert(pots)
    .values({
      name: "Ikeja Early Birds",
      inviteCode: inviteCodeCandidate("Ikeja Early Birds"),
      creatorId: inserted[0]!.id,
      dailyGoal: 10000,
      stakeKobo: 0,
      startsOn,
      endsOn,
      status: "running",
    })
    .returning();

  await db
    .insert(potMembers)
    .values(inserted.map((u) => ({ potId: pot!.id, userId: u.id })));

  const window = daysBetween(startsOn, endsOn);

  await db.insert(stepDays).values(
    inserted.flatMap((user, personIndex) =>
      window.map((day, dayIndex) => ({
        userId: user.id,
        day,
        steps: WEEK[personIndex]![dayIndex] ?? 0,
        source: "mock" as const,
      })),
    ),
  );

  console.log(`Seeded ${inserted.length} walkers into "${pot!.name}" (${pot!.inviteCode}).`);
  console.log("Sign in as any of them with the console SMS provider.");

  await queryClient.end();
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await queryClient.end();
  process.exit(1);
});
