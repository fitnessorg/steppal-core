import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { stepDays } from "../db/schema.js";
import { validateSubmission } from "../lib/steps.js";
import { DAY_KEY_PATTERN, addDays, todayKey } from "../lib/dates.js";

const SOURCES = ["health_connect", "pedometer", "mock"] as const;

export function registerStepRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Submit a batch of days.
   *
   * Idempotent by (user, day): a phone resending the same week overwrites its
   * own rows rather than inflating a total. Phones retry — on a flaky Lagos
   * connection they retry a lot — so a submission endpoint that is not
   * idempotent is a settlement bug waiting for a bad week of network.
   *
   * Rejected days come back named rather than silently dropped, so the app can
   * tell a user their clock is wrong instead of quietly losing their steps.
   */
  api.post(
    "/v1/steps",
    {
      onRequest: [app.authenticate],
      schema: {
        body: z.object({
          days: z
            .array(
              z.object({
                day: z.string().regex(DAY_KEY_PATTERN),
                steps: z.number().int(),
                source: z.enum(SOURCES).default("health_connect"),
              }),
            )
            .min(1)
            .max(31),
        }),
        response: {
          200: z.object({
            accepted: z.number(),
            clamped: z.number(),
            rejected: z.array(z.object({ day: z.string(), reason: z.string() })),
          }),
        },
      },
    },
    async (request) => {
      const rejected: { day: string; reason: string }[] = [];
      let accepted = 0;
      let clamped = 0;

      for (const submission of request.body.days) {
        const result = validateSubmission(submission);

        if (!result.ok) {
          rejected.push({ day: submission.day, reason: result.reason });
          continue;
        }

        await db
          .insert(stepDays)
          .values({
            userId: request.userId!,
            day: result.day,
            steps: result.steps,
            rawSteps: result.rawSteps,
            source: submission.source,
          })
          .onConflictDoUpdate({
            target: [stepDays.userId, stepDays.day],
            set: {
              steps: result.steps,
              rawSteps: result.rawSteps,
              source: submission.source,
              submittedAt: new Date(),
            },
          });

        accepted++;
        if (result.rawSteps !== null) clamped++;
      }

      return { accepted, clamped, rejected };
    },
  );

  /** Read back what the server believes, which is what pots are scored on. */
  api.get(
    "/v1/steps",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: z.object({
          from: z.string().regex(DAY_KEY_PATTERN).optional(),
          to: z.string().regex(DAY_KEY_PATTERN).optional(),
        }),
        response: {
          200: z.object({
            days: z.array(
              z.object({ day: z.string(), steps: z.number(), source: z.string() }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const to = request.query.to ?? todayKey();
      const from = request.query.from ?? addDays(to, -6);

      const rows = await db
        .select({ day: stepDays.day, steps: stepDays.steps, source: stepDays.source })
        .from(stepDays)
        .where(
          and(
            eq(stepDays.userId, request.userId!),
            gte(stepDays.day, from),
            lte(stepDays.day, to),
          ),
        )
        .orderBy(stepDays.day);

      return { days: rows };
    },
  );
}
