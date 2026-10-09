import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { otpCodes, refreshTokens, users } from "../db/schema.js";
import { normalisePhone } from "../lib/phone.js";
import { generateOtp, OTP_MAX_ATTEMPTS, OTP_MAX_PER_HOUR, OTP_TTL_SECONDS } from "../lib/otp.js";
import { getSmsProvider } from "../lib/sms.js";
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from "../lib/tokens.js";
import { loadEnv } from "../lib/env.js";

const phoneBody = z.object({ phone: z.string().min(7).max(20) });

const sessionResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({
    id: z.string(),
    phone: z.string(),
    displayName: z.string(),
    avatarSeed: z.string(),
    dailyGoal: z.number(),
  }),
});

/** A new account needs a name before it needs anything else. */
function defaultName(phone: string): string {
  return `Walker ${phone.slice(-4)}`;
}

type UserRow = typeof users.$inferSelect;

/** The only shape of a user that ever leaves this service. */
function toPublicUser(user: UserRow) {
  return {
    id: user.id,
    phone: user.phone,
    displayName: user.displayName,
    avatarSeed: user.avatarSeed,
    dailyGoal: user.dailyGoal,
  };
}

async function issueSession(userId: string) {
  const env = loadEnv();
  const refresh = generateRefreshToken();

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refresh),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000),
  });

  return { accessToken: await signAccessToken(userId), refreshToken: refresh };
}

export function registerAuthRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Request a code.
   *
   * Always answers 200 with the same shape, whether or not the number has an
   * account. Telling a caller "no such user" turns this endpoint into a way to
   * discover who is registered.
   */
  api.post(
    "/v1/auth/request-code",
    {
      schema: {
        body: phoneBody,
        response: {
          200: z.object({ ok: z.literal(true), expiresInSeconds: z.number() }),
          400: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const phone = normalisePhone(request.body.phone);
      if (!phone) return reply.code(400).send({ error: "invalid_phone" });

      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recent = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(otpCodes)
        .where(and(eq(otpCodes.phone, phone), gt(otpCodes.createdAt, anHourAgo)));

      if ((recent[0]?.count ?? 0) >= OTP_MAX_PER_HOUR) {
        return reply.code(429).send({ error: "too_many_requests" });
      }

      const code = generateOtp();
      await db.insert(otpCodes).values({
        phone,
        codeHash: hashToken(code),
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
      });

      await getSmsProvider().send(phone, `${code} is your StepPal code.`);

      return { ok: true as const, expiresInSeconds: OTP_TTL_SECONDS };
    },
  );

  /**
   * Verify a code and start a session, creating the account on first use.
   *
   * Every failure returns the same `invalid_code` so a caller cannot tell an
   * expired code from a wrong one from a number that was never sent a code.
   */
  api.post(
    "/v1/auth/verify-code",
    {
      schema: {
        body: phoneBody.extend({
          code: z.string().length(6),
          displayName: z.string().min(1).max(40).optional(),
        }),
        response: {
          200: sessionResponse,
          400: z.object({ error: z.string() }),
          401: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const phone = normalisePhone(request.body.phone);
      if (!phone) return reply.code(400).send({ error: "invalid_phone" });

      const [candidate] = await db
        .select()
        .from(otpCodes)
        .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt)))
        .orderBy(desc(otpCodes.createdAt))
        .limit(1);

      if (!candidate) return reply.code(401).send({ error: "invalid_code" });

      if (candidate.attempts >= OTP_MAX_ATTEMPTS || candidate.expiresAt < new Date()) {
        return reply.code(401).send({ error: "invalid_code" });
      }

      if (candidate.codeHash !== hashToken(request.body.code)) {
        // Count the miss before answering, so guessing costs attempts.
        await db
          .update(otpCodes)
          .set({ attempts: candidate.attempts + 1 })
          .where(eq(otpCodes.id, candidate.id));
        return reply.code(401).send({ error: "invalid_code" });
      }

      await db
        .update(otpCodes)
        .set({ consumedAt: new Date() })
        .where(eq(otpCodes.id, candidate.id));

      const existingUsers = await db
        .select()
        .from(users)
        .where(eq(users.phone, phone))
        .limit(1);

      const created = existingUsers[0]
        ? undefined
        : (
            await db
              .insert(users)
              .values({
                phone,
                displayName: request.body.displayName?.trim() || defaultName(phone),
                avatarSeed: randomUUID(),
              })
              .returning()
          )[0];

      const user = existingUsers[0] ?? created;
      if (!user) return reply.code(500).send({ error: "user_not_created" });

      const session = await issueSession(user.id);

      return { ...session, user: toPublicUser(user) };
    },
  );

  /**
   * Exchange a refresh token for a new pair.
   *
   * The old token is revoked in the same breath it is accepted. A token that is
   * presented twice is either a bug or a theft, and either way the second use
   * finds nothing.
   */
  api.post(
    "/v1/auth/refresh",
    {
      schema: {
        body: z.object({ refreshToken: z.string().min(1) }),
        response: {
          200: z.object({ accessToken: z.string(), refreshToken: z.string() }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const hash = hashToken(request.body.refreshToken);

      const [existing] = await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)))
        .limit(1);

      if (!existing || existing.expiresAt < new Date()) {
        return reply.code(401).send({ error: "invalid_refresh_token" });
      }

      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, existing.id));

      return issueSession(existing.userId);
    },
  );

  /** Sign out this device. Other devices keep their sessions. */
  api.post(
    "/v1/auth/logout",
    {
      schema: {
        body: z.object({ refreshToken: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (request) => {
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, hashToken(request.body.refreshToken)));
      return { ok: true as const };
    },
  );

  api.get(
    "/v1/me",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: sessionResponse.shape.user,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, request.userId!))
        .limit(1);

      const user = rows[0];
      if (!user) return reply.code(404).send({ error: "not_found" });

      return toPublicUser(user);
    },
  );

  api.patch(
    "/v1/me",
    {
      onRequest: [app.authenticate],
      schema: {
        body: z.object({
          displayName: z.string().min(1).max(40).optional(),
          dailyGoal: z.number().int().min(1000).max(50000).optional(),
        }),
        response: {
          200: sessionResponse.shape.user,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const rows = await db
        .update(users)
        .set({ ...request.body, updatedAt: new Date() })
        .where(eq(users.id, request.userId!))
        .returning();

      const user = rows[0];
      if (!user) return reply.code(404).send({ error: "not_found" });

      return toPublicUser(user);
    },
  );
}
