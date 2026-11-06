import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { pots, users } from "../db/schema.js";
import {
  getPaymentProvider,
  generatePaymentReference,
  isKnownPaymentWebhookEvent,
} from "../lib/payments.js";

const initializePaymentSchema = z.object({
  potId: z.string().uuid(),
  amountKobo: z.number().int().positive().optional(),
  callbackUrl: z.string().url().optional(),
});

const disbursePaymentSchema = z.object({
  recipientName: z.string().min(1),
  accountNumber: z.string().regex(/^\d{10}$/, "accountNumber must be a 10-digit NUBAN"),
  bankCode: z.string().min(3).max(6),
  amountKobo: z.number().int().positive(),
  potId: z.string().uuid().optional(),
  reason: z.string().optional(),
});

export function registerPaymentRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Initializes a stake deposit for joining or funding a pot.
   */
  api.post(
    "/v1/payments/initialize",
    {
      onRequest: [app.authenticate],
      schema: {
        body: initializePaymentSchema,
        response: {
          200: z.object({
            reference: z.string(),
            authorizationUrl: z.string(),
            accessCode: z.string().optional(),
            status: z.enum(["pending", "success"]),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { potId, amountKobo, callbackUrl } = req.body;

      const [pot] = await db.select().from(pots).where(eq(pots.id, potId)).limit(1);
      if (!pot) {
        return reply.code(404).send({ error: "not_found", message: "Pot not found" });
      }

      const [user] = await db.select().from(users).where(eq(users.id, req.userId!)).limit(1);
      const email = user ? `${user.phone.replace(/\D/g, "")}@steppal.io` : `${req.userId!}@steppal.io`;

      const stakeAmount = amountKobo ?? pot.stakeKobo;
      const reference = generatePaymentReference("stake", pot.id, req.userId!);

      const provider = getPaymentProvider();
      const result = await provider.initializeDeposit({
        reference,
        amountKobo: stakeAmount,
        email,
        callbackUrl,
        metadata: {
          potId: pot.id,
          userId: req.userId!,
          purpose: "pot_stake",
        },
      });

      return reply.code(200).send({
        reference: result.reference,
        authorizationUrl: result.authorizationUrl,
        accessCode: result.accessCode,
        status: result.status,
      });
    },
  );

  /**
   * Verifies a deposit transaction by reference.
   */
  api.get(
    "/v1/payments/verify/:reference",
    {
      onRequest: [app.authenticate],
      schema: {
        params: z.object({ reference: z.string() }),
        response: {
          200: z.object({
            reference: z.string(),
            status: z.enum(["success", "failed", "abandoned", "pending"]),
            amountKobo: z.number(),
            currency: z.string(),
            paidAt: z.string().optional(),
          }),
        },
      },
    },
    async (req, reply) => {
      const provider = getPaymentProvider();
      const result = await provider.verifyDeposit(req.params.reference);

      return reply.code(200).send({
        reference: result.reference,
        status: result.status,
        amountKobo: result.amountKobo,
        currency: result.currency,
        paidAt: result.paidAt ? result.paidAt.toISOString() : undefined,
      });
    },
  );

  /**
   * Instructs payout disbursement to a winner's NUBAN account.
   */
  api.post(
    "/v1/payments/disburse",
    {
      onRequest: [app.authenticate],
      schema: {
        body: disbursePaymentSchema,
        response: {
          200: z.object({
            ok: z.literal(true),
            reference: z.string(),
            transferCode: z.string(),
            status: z.enum(["pending", "success", "failed"]),
            amountKobo: z.number(),
          }),
        },
      },
    },
    async (req, reply) => {
      const { recipientName, accountNumber, bankCode, amountKobo, potId, reason } = req.body;
      const provider = getPaymentProvider();

      const recipient = await provider.createTransferRecipient({
        name: recipientName,
        accountNumber,
        bankCode,
        currency: "NGN",
        description: `StepPal payout for user ${req.userId!}`,
      });

      const reference = generatePaymentReference("disb", potId, req.userId!);
      const result = await provider.initiateDisbursement({
        reference,
        amountKobo,
        recipientCode: recipient.recipientCode,
        reason: reason ?? "StepPal Pot Payout",
        metadata: {
          potId,
          userId: req.userId!,
          purpose: "payout_disbursement",
        },
      });

      return reply.code(200).send({
        ok: true,
        reference: result.reference,
        transferCode: result.transferCode,
        status: result.status,
        amountKobo: result.amountKobo,
      });
    },
  );

  /**
   * Receives payment webhooks from Paystack / payment provider.
   * Signature is verified with provider secret; invalid signatures are rejected with 401.
   */
  api.post(
    "/v1/payments/webhook",
    {
      schema: {
        response: {
          200: z.object({
            received: z.literal(true),
            event: z.string(),
          }),
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (req, reply) => {
      const signature =
        (req.headers["x-paystack-signature"] as string | undefined) ??
        (req.headers["x-payment-signature"] as string | undefined) ??
        "";

      const rawBody =
        (req as unknown as { rawBody?: string }).rawBody ??
        (typeof req.body === "string" ? req.body : JSON.stringify(req.body));

      const provider = getPaymentProvider();
      const isValid = provider.verifyWebhookSignature(rawBody, signature);

      if (!isValid) {
        return reply.code(401).send({
          error: "invalid_signature",
          message: "Payment provider webhook signature verification failed",
        });
      }

      let event: { event: string; data: Record<string, unknown> };
      try {
        event = provider.parseWebhookEvent(rawBody, signature);
      } catch (err) {
        return reply.code(401).send({
          error: "invalid_signature",
          message: (err as Error).message,
        });
      }

      // Handle specific webhook event types
      if (isKnownPaymentWebhookEvent(event.event)) {
        if (event.event === "charge.success") {
          req.log.info({ reference: event.data.reference }, "Payment charge.success received");
        } else if (event.event === "transfer.success") {
          req.log.info({ reference: event.data.reference }, "Payment transfer.success received");
        } else if (event.event === "transfer.failed" || event.event === "transfer.reversed") {
          req.log.warn({ reference: event.data.reference }, "Payment transfer failure received");
        }
      } else {
        req.log.info({ event: event.event }, "Unhandled payment webhook event ignored");
      }

      return reply.code(200).send({
        received: true,
        event: event.event,
      });
    },
  );
}
