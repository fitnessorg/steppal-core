import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { potMembers, pots, stepDays, users } from "../db/schema.js";
import { daysBetween, todayKey, type DayKey } from "./dates.js";

export type PotRow = typeof pots.$inferSelect;

export type MemberProgress = {
  userId: string;
  displayName: string;
  avatarSeed: string;
  daysHit: number;
  totalSteps: number;
  byDay: { day: DayKey; steps: number; hit: boolean }[];
};

/**
 * The one place that turns step rows into pot standings.
 *
 * Routes, settlement and the seed all read standings through this, so a change
 * to what "hitting your goal" means changes everywhere at once. Duplicating
 * this rule was the single most likely way to ship a settlement that disagreed
 * with what the app had been showing people all week.
 */
export async function progressFor(pot: PotRow, upTo: DayKey = todayKey()) {
  const window = daysBetween(pot.startsOn, pot.endsOn < upTo ? pot.endsOn : upTo);

  const members = await db
    .select({
      userId: potMembers.userId,
      displayName: users.displayName,
      avatarSeed: users.avatarSeed,
    })
    .from(potMembers)
    .innerJoin(users, eq(users.id, potMembers.userId))
    .where(and(eq(potMembers.potId, pot.id), isNull(potMembers.leftAt)));

  if (members.length === 0) return { window, members: [] as MemberProgress[] };

  const ids = members.map((m) => m.userId);
  const rows = await db
    .select({ userId: stepDays.userId, day: stepDays.day, steps: stepDays.steps })
    .from(stepDays)
    .where(inArray(stepDays.userId, ids));

  const byUser = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    byUser.get(r.userId)!.set(r.day, r.steps);
  }

  const progress: MemberProgress[] = members.map((m) => {
    const steps = byUser.get(m.userId) ?? new Map<string, number>();
    const byDay = window.map((day) => {
      const n = steps.get(day) ?? 0;
      return { day, steps: n, hit: n >= pot.dailyGoal };
    });

    return {
      ...m,
      byDay,
      daysHit: byDay.filter((d) => d.hit).length,
      totalSteps: byDay.reduce((sum, d) => sum + d.steps, 0),
    };
  });

  // Most days hit first, then most steps. Stable enough to render as a table.
  progress.sort((a, b) => b.daysHit - a.daysHit || b.totalSteps - a.totalSteps);

  return { window, members: progress };
}
