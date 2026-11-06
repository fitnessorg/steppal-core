import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockPaymentProvider,
  createPaystackPaymentProvider,
  getPaymentProvider,
  resetPaymentProviderForTest,
  resetMockPayments,
  mockPaymentState,
} from "../src/lib/payments.js";
import { resetEnvForTest } from "../src/lib/env.js";
import { buildApp } from "../src/app.js";

describe("payment providers", () => {
  beforeEach(() => {
    resetMockPayments();
    resetPaymentProviderForTest();
    resetEnvForTest();
  });

  describe("mock payment provider", () => {
    it("is returned as default provider", () => {
      const provider = getPaymentProvider();
      expect(provider.name).toBe("mock");
    });

    it("initializes deposit and returns checkout URL and access code", async () => {
      const result = await MockPaymentProvider.initializeDeposit({
        reference: "ref_test_001",
        amountKobo: 500000,
        email: "walker@steppal.io",
        metadata: { potId: "pot_123", userId: "user_456" },
      });

      expect(result.reference).toBe("ref_test_001");
      expect(result.authorizationUrl).toContain("mock.checkout.steppal.io");
      expect(result.accessCode).toBe("mock_code_ref_test_001");
      expect(mockPaymentState.deposits.has("ref_test_001")).toBe(true);
    });

    it("verifies initialized deposit with correct amount and success status", async () => {
      await MockPaymentProvider.initializeDeposit({
        reference: "ref_verify_test",
        amountKobo: 250000,
        email: "test@steppal.io",
        metadata: { potId: "pot_abc" },
      });

      const verification = await MockPaymentProvider.verifyDeposit("ref_verify_test");
      expect(verification.reference).toBe("ref_verify_test");
      expect(verification.status).toBe("success");
      expect(verification.amountKobo).toBe(250000);
      expect(verification.currency).toBe("NGN");
      expect(verification.metadata).toEqual({ potId: "pot_abc" });
    });

    it("creates recipient with deterministic code and idempotent caching", async () => {
      const recipient1 = await MockPaymentProvider.createTransferRecipient({
        name: "Ada Lovelace",
        accountNumber: "0123456789",
        bankCode: "058",
      });

      expect(recipient1.recipientCode).toBe("RCP_mock_058_0123456789");
      expect(recipient1.accountName).toBe("Ada Lovelace");

      const recipient2 = await MockPaymentProvider.createTransferRecipient({
        name: "Ada Lovelace",
        accountNumber: "0123456789",
        bankCode: "058",
      });

      expect(recipient2.recipientCode).toBe(recipient1.recipientCode);
      expect(mockPaymentState.recipients.size).toBe(1);
    });

    it("initiates payout disbursement and records transfer code", async () => {
      const result = await MockPaymentProvider.initiateDisbursement({
        reference: "disb_test_001",
        amountKobo: 750000,
        recipientCode: "RCP_mock_058_0123456789",
        reason: "Pot Winner Settlement",
      });

      expect(result.reference).toBe("disb_test_001");
      expect(result.transferCode).toBe("TRF_mock_disb_test_001");
      expect(result.status).toBe("success");
      expect(result.amountKobo).toBe(750000);
      expect(mockPaymentState.disbursements.has("disb_test_001")).toBe(true);
    });

    it("verifies mock webhook signatures and rejects bad ones", () => {
      expect(MockPaymentProvider.verifyWebhookSignature("{}", "mock-signature")).toBe(true);
      expect(MockPaymentProvider.verifyWebhookSignature("{}", "invalid-signature")).toBe(false);
      expect(MockPaymentProvider.verifyWebhookSignature("{}", "")).toBe(false);

      const payload = JSON.stringify({ event: "charge.success", data: { reference: "ref_1" } });
      const validHmac = crypto.createHmac("sha512", "mock-secret").update(payload).digest("hex");
      expect(MockPaymentProvider.verifyWebhookSignature(payload, validHmac)).toBe(true);
    });

    it("parses valid webhook event and records it in mock state", () => {
      const payload = JSON.stringify({
        event: "charge.success",
        data: { reference: "ref_100", amount: 100000 },
      });
      const event = MockPaymentProvider.parseWebhookEvent(payload, "mock-signature");
      expect(event.event).toBe("charge.success");
      expect(mockPaymentState.webhookEvents).toHaveLength(1);
    });
  });

  describe("paystack payment provider", () => {
    it("throws when PAYSTACK_SECRET_KEY is missing", async () => {
      const paystack = createPaystackPaymentProvider({ secretKey: "" });
      await expect(
        paystack.initializeDeposit({
          reference: "ref",
          amountKobo: 10000,
          email: "test@example.com",
        }),
      ).rejects.toThrow("PAYSTACK_SECRET_KEY is required");
    });

    it("initializes deposit against Paystack API", async () => {
      let interceptedUrl = "";
      let interceptedHeaders: HeadersInit | undefined;
      let interceptedBody: unknown;

      const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        interceptedUrl = url.toString();
        interceptedHeaders = init?.headers;
        interceptedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              message: "Authorization URL created",
              data: {
                authorization_url: "https://checkout.paystack.com/sandbox-auth-123",
                access_code: "acc_123",
                reference: "ref_paystack_001",
              },
            }),
        } as Response;
      }) as typeof fetch;

      const paystack = createPaystackPaymentProvider({
        secretKey: "sk_test_paystack_secret",
        baseUrl: "https://api.test.paystack.co",
        fetchFn: mockFetch,
      });

      const result = await paystack.initializeDeposit({
        reference: "ref_paystack_001",
        amountKobo: 300000,
        email: "nigerianwalker@steppal.io",
        callbackUrl: "https://steppal.io/callback",
        metadata: { potId: "pot_test_1" },
      });

      expect(interceptedUrl).toBe("https://api.test.paystack.co/transaction/initialize");
      expect((interceptedHeaders as Record<string, string>)["Authorization"]).toBe(
        "Bearer sk_test_paystack_secret",
      );
      expect(interceptedBody).toEqual({
        reference: "ref_paystack_001",
        amount: 300000,
        email: "nigerianwalker@steppal.io",
        callback_url: "https://steppal.io/callback",
        metadata: { potId: "pot_test_1" },
      });
      expect(result.authorizationUrl).toBe("https://checkout.paystack.com/sandbox-auth-123");
      expect(result.accessCode).toBe("acc_123");
    });

    it("verifies deposit and maps status correctly", async () => {
      let interceptedUrl = "";

      const mockFetch = (async (url: string | URL | Request) => {
        interceptedUrl = url.toString();
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              data: {
                reference: "ref_paystack_002",
                status: "success",
                amount: 300000,
                currency: "NGN",
                paid_at: "2026-11-06T12:00:00.000Z",
                metadata: { potId: "pot_2" },
              },
            }),
        } as Response;
      }) as typeof fetch;

      const paystack = createPaystackPaymentProvider({
        secretKey: "sk_test_secret",
        fetchFn: mockFetch,
      });

      const verification = await paystack.verifyDeposit("ref_paystack_002");
      expect(interceptedUrl).toBe("https://api.paystack.co/transaction/verify/ref_paystack_002");
      expect(verification.status).toBe("success");
      expect(verification.amountKobo).toBe(300000);
      expect(verification.paidAt).toEqual(new Date("2026-11-06T12:00:00.000Z"));
    });

    it("creates transfer recipient with NUBAN bank account details", async () => {
      let interceptedBody: unknown;

      const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        interceptedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              data: {
                recipient_code: "RCP_real_9876",
                name: "Tunde Ednut",
                details: {
                  account_number: "0987654321",
                  bank_code: "057",
                },
                currency: "NGN",
              },
            }),
        } as Response;
      }) as typeof fetch;

      const paystack = createPaystackPaymentProvider({
        secretKey: "sk_test_secret",
        fetchFn: mockFetch,
      });

      const recipient = await paystack.createTransferRecipient({
        name: "Tunde Ednut",
        accountNumber: "0987654321",
        bankCode: "057",
      });

      expect(recipient.recipientCode).toBe("RCP_real_9876");
      expect(recipient.accountNumber).toBe("0987654321");
      expect(interceptedBody).toEqual({
        type: "nuban",
        name: "Tunde Ednut",
        account_number: "0987654321",
        bank_code: "057",
        currency: "NGN",
      });
    });

    it("initiates disbursement payout via Paystack transfer API", async () => {
      let interceptedBody: unknown;

      const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        interceptedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: true,
              data: {
                reference: "disb_009",
                transfer_code: "TRF_xyz123",
                status: "success",
                amount: 850000,
                fee: 5000,
              },
            }),
        } as Response;
      }) as typeof fetch;

      const paystack = createPaystackPaymentProvider({
        secretKey: "sk_test_secret",
        fetchFn: mockFetch,
      });

      const disbursement = await paystack.initiateDisbursement({
        reference: "disb_009",
        amountKobo: 850000,
        recipientCode: "RCP_real_9876",
        reason: "StepPal Pot Settlement Payout",
      });

      expect(disbursement.reference).toBe("disb_009");
      expect(disbursement.transferCode).toBe("TRF_xyz123");
      expect(disbursement.status).toBe("success");
      expect(disbursement.feeKobo).toBe(5000);
      expect(interceptedBody).toEqual({
        source: "balance",
        amount: 850000,
        recipient: "RCP_real_9876",
        reason: "StepPal Pot Settlement Payout",
        reference: "disb_009",
      });
    });

    it("verifies webhook signature with HMAC SHA512 and timing safe equal", () => {
      const secret = "sk_live_very_secret_signing_key";
      const paystack = createPaystackPaymentProvider({ secretKey: secret });

      const rawPayload = JSON.stringify({
        event: "charge.success",
        data: { reference: "ref_live_01", amount: 400000 },
      });

      const validSignature = crypto
        .createHmac("sha512", secret)
        .update(rawPayload)
        .digest("hex");

      expect(paystack.verifyWebhookSignature(rawPayload, validSignature)).toBe(true);
      expect(paystack.verifyWebhookSignature(rawPayload, "invalid_signature")).toBe(false);
      expect(paystack.verifyWebhookSignature(rawPayload, "")).toBe(false);
      expect(paystack.verifyWebhookSignature(rawPayload + "tampered", validSignature)).toBe(false);
    });

    it("throws clear error when Paystack API returns failure status", async () => {
      const mockFetch = (async () => {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              status: false,
              message: "Cannot resolve account",
            }),
        } as Response;
      }) as typeof fetch;

      const paystack = createPaystackPaymentProvider({
        secretKey: "sk_test_secret",
        fetchFn: mockFetch,
      });

      await expect(
        paystack.createTransferRecipient({
          name: "Invalid",
          accountNumber: "0000000000",
          bankCode: "999",
        }),
      ).rejects.toThrow("Paystack API error [HTTP 400]: Cannot resolve account");
    });
  });

  describe("webhook route handling", () => {
    it("rejects webhook request with missing or invalid signature (401)", async () => {
      const app = buildApp();

      const resNoSig = await app.inject({
        method: "POST",
        url: "/v1/payments/webhook",
        payload: { event: "charge.success", data: {} },
      });

      expect(resNoSig.statusCode).toBe(401);
      const bodyNoSig = JSON.parse(resNoSig.body);
      expect(bodyNoSig.error).toBe("invalid_signature");

      const resBadSig = await app.inject({
        method: "POST",
        url: "/v1/payments/webhook",
        headers: { "x-paystack-signature": "bogus" },
        payload: { event: "charge.success", data: {} },
      });

      expect(resBadSig.statusCode).toBe(401);
      await app.close();
    });

    it("accepts webhook request with valid signature (200)", async () => {
      const app = buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/v1/payments/webhook",
        headers: { "x-paystack-signature": "mock-signature" },
        payload: { event: "charge.success", data: { reference: "stake_123" } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.received).toBe(true);
      expect(body.event).toBe("charge.success");
      await app.close();
    });
  });
});
