import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { potMembers, potResults, pots } from "../db/schema.js";
import { inviteCodeCandidate, normaliseInviteCode } from "../lib/invite.js";
import { addDays, DAY_KEY_PATTERN, todayKey } from "../lib/dates.js";
import { progressFor } from "../lib/pots.js";

const MAX_MEMBERS = 20;

const potSummary = z.object({
  id: z.string(),
  name: z.string(),
  inviteCode: z.string(),
  dailyGoal: z.number(),
  stakeKobo: z.number(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: z.enum(["open", "running", "settled"]),
  memberCount: z.number(),
});

const memberProgress = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatarSeed: z.string(),
  daysHit: z.number(),
  totalSteps: z.number(),
  byDay: z.array(z.object({ day: z.string(), steps: z.number(), hit: z.boolean() })),
});

/**
 * A pot's status is derived from dates, not stored drift.
 *
 * Nothing runs a cron to flip "open" to "running" — the row says when it starts
 * and ends, and the answer is computed. Only settlement writes status, because
 * only settlement is a real event.
 */
function liveStatus(pot: typeof pots.$inferSelect) {
  if (pot.status === "settled") return "settled" as const;
  return todayKey() >= pot.startsOn ? ("running" as const) : ("open" as const);
}

export function registerPotRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Create a pot and join it in one transaction.
   *
   * A pot with no members is a bug nobody can clean up from the app, so the
   * creator's membership is inserted alongside the pot or not at all.
   */
  api.post(
    "/v1/pots",
    {
      onRequest: [app.authenticate],
      schema: {
        body: z.object({
          name: z.string().min(1).max(40),
          dailyGoal: z.number().int().min(1000).max(50000).default(10000),
          stakeKobo: z.number().int().min(0).max(100_000_00).default(0),
          startsOn: z.string().regex(DAY_KEY_PATTERN).optional(),
          days: z.number().int().min(1).max(30).default(7),
        }),
        response: { 201: potSummary, 409: z.object({ error: z.string() }) },
      },
    },
    async (request, reply) => {
      const { name, dailyGoal, stakeKobo, days } = request.body;
      const startsOn = request.body.startsOn ?? todayKey();
      const endsOn = addDays(startsOn, days - 1);

      // Retry on invite-code collision rather than pretending it cannot happen.
      for (let attempt = 0; attempt < 5; attempt++) {
        const inviteCode = inviteCodeCandidate(name);
        try {
          const pot = await db.transaction(async (tx) => {
            const [created] = await tx
              .insert(pots)
              .values({
                name,
                inviteCode,
                creatorId: request.userId!,
                dailyGoal,
                stakeKobo,
                startsOn,
                endsOn,
              })
              .returning();

            if (!created) throw new Error("pot insert returned nothing");

            await tx.insert(potMembers).values({ potId: created.id, userId: request.userId! });
            return created;
          });

          return reply.code(201).send({
            id: pot.id,
            name: pot.name,
            inviteCode: pot.inviteCode,
            dailyGoal: pot.dailyGoal,
            stakeKobo: pot.stakeKobo,
            startsOn: pot.startsOn,
            endsOn: pot.endsOn,
            status: liveStatus(pot),
            memberCount: 1,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "";
          if (!message.includes("pots_invite_code_idx")) throw err;
        }
      }

      return reply.code(409).send({ error: "could_not_allocate_invite_code" });
    },
  );

  /** Pots this user is in, newest first. */
  api.get(
    "/v1/pots",
    {
      onRequest: [app.authenticate],
      schema: { response: { 200: z.array(potSummary) } },
    },
    async (request) => {
      const mine = await db
        .select({ pot: pots })
        .from(potMembers)
        .innerJoin(pots, eq(pots.id, potMembers.potId))
        .where(and(eq(potMembers.userId, request.userId!), isNull(potMembers.leftAt)))
        .orderBy(desc(pots.createdAt));

      if (mine.length === 0) return [];

      const counts = await db
        .select({ potId: potMembers.potId, userId: potMembers.userId })
        .from(potMembers)
        .where(
          and(
            inArray(
              potMembers.potId,
              mine.map((m) => m.pot.id),
            ),
            isNull(potMembers.leftAt),
          ),
        );

      const countFor = new Map<string, number>();
      for (const c of counts) countFor.set(c.potId, (countFor.get(c.potId) ?? 0) + 1);

      return mine.map(({ pot }) => ({
        id: pot.id,
        name: pot.name,
        inviteCode: pot.inviteCode,
        dailyGoal: pot.dailyGoal,
        stakeKobo: pot.stakeKobo,
        startsOn: pot.startsOn,
        endsOn: pot.endsOn,
        status: liveStatus(pot),
        memberCount: countFor.get(pot.id) ?? 0,
      }));
    },
  );

  /**
   * Look a pot up by code without joining it.
   *
   * The app shows "Ikeja Early Birds, 4 people, ₦0" before asking you to
   * commit. Joining something you have not seen is how people end up in pots
   * they did not mean to be in.
   */
  api.get(
    "/v1/pots/by-code/:code",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ code: z.string().min(1).max(20) }),
        response: { 200: potSummary, 404: z.object({ error: z.string() }) },
      },
    },
    async (request, reply) => {
      const code = normaliseInviteCode(request.params.code);
      const rows = await db.select().from(pots).where(eq(pots.inviteCode, code)).limit(1);
      const pot = rows[0];
      if (!pot) return reply.code(404).send({ error: "not_found" });

      const members = await db
        .select({ id: potMembers.id })
        .from(potMembers)
        .where(and(eq(potMembers.potId, pot.id), isNull(potMembers.leftAt)));

      return {
        id: pot.id,
        name: pot.name,
        inviteCode: pot.inviteCode,
        dailyGoal: pot.dailyGoal,
        stakeKobo: pot.stakeKobo,
        startsOn: pot.startsOn,
        endsOn: pot.endsOn,
        status: liveStatus(pot),
        memberCount: members.length,
      };
    },
  );

  /**
   * Join by code.
   *
   * Three refusals, each for a reason someone would otherwise complain about:
   * a settled pot cannot be joined, a started pot cannot be joined (you would
   * be competing on fewer days), and a pot at capacity cannot be joined.
   * Re-joining a pot you are already in is a no-op, not an error, because a
   * double tap is not a mistake worth punishing.
   */
  api.post(
    "/v1/pots/join",
    {
      onRequest: [app.authenticate],
      schema: {
        body: z.object({ code: z.string().min(1).max(20) }),
        response: {
          200: potSummary,
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const code = normaliseInviteCode(request.body.code);
      const rows = await db.select().from(pots).where(eq(pots.inviteCode, code)).limit(1);
      const pot = rows[0];
      if (!pot) return reply.code(404).send({ error: "not_found" });

      if (pot.status === "settled") return reply.code(409).send({ error: "pot_settled" });
      if (todayKey() > pot.startsOn) return reply.code(409).send({ error: "pot_already_started" });

      const existing = await db
        .select()
        .from(potMembers)
        .where(and(eq(potMembers.potId, pot.id), eq(potMembers.userId, request.userId!)))
        .limit(1);

      const active = await db
        .select({ id: potMembers.id })
        .from(potMembers)
        .where(and(eq(potMembers.potId, pot.id), isNull(potMembers.leftAt)));

      if (!existing[0]) {
        if (active.length >= MAX_MEMBERS) return reply.code(409).send({ error: "pot_full" });
        await db.insert(potMembers).values({ potId: pot.id, userId: request.userId! });
      } else if (existing[0].leftAt) {
        if (active.length >= MAX_MEMBERS) return reply.code(409).send({ error: "pot_full" });
        await db
          .update(potMembers)
          .set({ leftAt: null, joinedAt: new Date() })
          .where(eq(potMembers.id, existing[0].id));
      }

      const after = await db
        .select({ id: potMembers.id })
        .from(potMembers)
        .where(and(eq(potMembers.potId, pot.id), isNull(potMembers.leftAt)));

      return {
        id: pot.id,
        name: pot.name,
        inviteCode: pot.inviteCode,
        dailyGoal: pot.dailyGoal,
        stakeKobo: pot.stakeKobo,
        startsOn: pot.startsOn,
        endsOn: pot.endsOn,
        status: liveStatus(pot),
        memberCount: after.length,
      };
    },
  );

  /** A pot with live standings, and results once it has settled. */
  api.get(
    "/v1/pots/:id",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: potSummary.extend({
            members: z.array(memberProgress),
            results: z
              .array(
                z.object({
                  userId: z.string(),
                  daysHit: z.number(),
                  daysPossible: z.number(),
                  totalSteps: z.number(),
                  metGoal: z.boolean(),
                  payoutKobo: z.number(),
                }),
              )
              .optional(),
          }),
          403: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const rows = await db.select().from(pots).where(eq(pots.id, request.params.id)).limit(1);
      const pot = rows[0];
      if (!pot) return reply.code(404).send({ error: "not_found" });

      // Membership is the authorisation. A pot is a private group, and its
      // standings name people — so holding the id is not enough.
      const mine = await db
        .select({ id: potMembers.id })
        .from(potMembers)
        .where(
          and(
            eq(potMembers.potId, pot.id),
            eq(potMembers.userId, request.userId!),
            isNull(potMembers.leftAt),
          ),
        )
        .limit(1);

      if (!mine[0]) return reply.code(403).send({ error: "not_a_member" });

      const { members } = await progressFor(pot);

      const results =
        pot.status === "settled"
          ? (await db.select().from(potResults).where(eq(potResults.potId, pot.id))).map((r) => ({
              userId: r.userId,
              daysHit: r.daysHit,
              daysPossible: r.daysPossible,
              totalSteps: r.totalSteps,
              metGoal: r.metGoal === "yes",
              payoutKobo: r.payoutKobo,
            }))
          : undefined;

      return {
        id: pot.id,
        name: pot.name,
        inviteCode: pot.inviteCode,
        dailyGoal: pot.dailyGoal,
        stakeKobo: pot.stakeKobo,
        startsOn: pot.startsOn,
        endsOn: pot.endsOn,
        status: liveStatus(pot),
        memberCount: members.length,
        members,
        ...(results ? { results } : {}),
      };
    },
  );

  /**
   * Leave a pot.
   *
   * Only before it starts. Once money or a week of walking is on the line,
   * leaving would let someone exit a pot they are losing, which is the whole
   * commitment gone. Membership is timestamped rather than deleted so the
   * record of who was in the pot survives.
   */
  api.post(
    "/v1/pots/:id/leave",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const rows = await db.select().from(pots).where(eq(pots.id, request.params.id)).limit(1);
      const pot = rows[0];
      if (!pot) return reply.code(404).send({ error: "not_found" });

      if (todayKey() >= pot.startsOn) {
        return reply.code(409).send({ error: "pot_already_started" });
      }

      await db
        .update(potMembers)
        .set({ leftAt: new Date() })
        .where(and(eq(potMembers.potId, pot.id), eq(potMembers.userId, request.userId!)));

      return { ok: true as const };
    },
  );
}
