import crypto from "node:crypto";
import { loadEnv } from "./env.js";

export interface InitializeDepositInput {
  reference: string;
  amountKobo: number;
  email: string;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
}

export interface InitializeDepositResult {
  reference: string;
  authorizationUrl: string;
  accessCode?: string;
  status: "pending" | "success";
}

export interface VerifyDepositResult {
  reference: string;
  status: "success" | "failed" | "abandoned" | "pending";
  amountKobo: number;
  currency: string;
  paidAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface CreateTransferRecipientInput {
  name: string;
  accountNumber: string;
  bankCode: string;
  currency?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface TransferRecipientResult {
  recipientCode: string;
  accountName: string;
  accountNumber: string;
  bankCode: string;
  currency: string;
}

export interface InitiateDisbursementInput {
  reference: string;
  amountKobo: number;
  recipientCode: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface DisbursementResult {
  reference: string;
  transferCode: string;
  status: "pending" | "success" | "failed";
  amountKobo: number;
  feeKobo?: number;
}

export interface WebhookEvent<T = Record<string, unknown>> {
  event: string;
  data: T;
}

export interface PaymentProvider {
  readonly name: string;
  initializeDeposit(input: InitializeDepositInput): Promise<InitializeDepositResult>;
  verifyDeposit(reference: string): Promise<VerifyDepositResult>;
  createTransferRecipient(input: CreateTransferRecipientInput): Promise<TransferRecipientResult>;
  initiateDisbursement(input: InitiateDisbursementInput): Promise<DisbursementResult>;
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean;
  parseWebhookEvent<T = Record<string, unknown>>(
    rawBody: string | Buffer,
    signature: string,
  ): WebhookEvent<T>;
}

/**
 * In-memory state tracking for MockPaymentProvider.
 * This permits end-to-end testing and verification without network calls or external bank credentials.
 */
export const mockPaymentState = {
  deposits: new Map<
    string,
    {
      input: InitializeDepositInput;
      status: "pending" | "success" | "failed" | "abandoned";
      paidAt?: Date;
    }
  >(),
  disbursements: new Map<
    string,
    {
      input: InitiateDisbursementInput;
      transferCode: string;
      status: "pending" | "success" | "failed";
    }
  >(),
  recipients: new Map<string, TransferRecipientResult>(),
  webhookEvents: [] as WebhookEvent[],
};

export function resetMockPayments(): void {
  mockPaymentState.deposits.clear();
  mockPaymentState.disbursements.clear();
  mockPaymentState.recipients.clear();
  mockPaymentState.webhookEvents.length = 0;
}

export const MockPaymentProvider: PaymentProvider = {
  name: "mock",

  async initializeDeposit(input: InitializeDepositInput): Promise<InitializeDepositResult> {
    mockPaymentState.deposits.set(input.reference, {
      input,
      status: "success",
      paidAt: new Date(),
    });

    return {
      reference: input.reference,
      authorizationUrl: `https://mock.checkout.steppal.io/pay/${encodeURIComponent(input.reference)}`,
      accessCode: `mock_code_${input.reference}`,
      status: "pending",
    };
  },

  async verifyDeposit(reference: string): Promise<VerifyDepositResult> {
    const recorded = mockPaymentState.deposits.get(reference);
    if (recorded) {
      return {
        reference,
        status: recorded.status,
        amountKobo: recorded.input.amountKobo,
        currency: "NGN",
        paidAt: recorded.paidAt,
        metadata: recorded.input.metadata,
      };
    }

    // If never initialized in mock, return a mock success for test flows
    return {
      reference,
      status: "success",
      amountKobo: 100000,
      currency: "NGN",
      paidAt: new Date(),
      metadata: {},
    };
  },

  async createTransferRecipient(
    input: CreateTransferRecipientInput,
  ): Promise<TransferRecipientResult> {
    const key = `${input.bankCode}:${input.accountNumber}`;
    const existing = mockPaymentState.recipients.get(key);
    if (existing) return existing;

    const result: TransferRecipientResult = {
      recipientCode: `RCP_mock_${input.bankCode}_${input.accountNumber}`,
      accountName: input.name,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      currency: input.currency ?? "NGN",
    };
    mockPaymentState.recipients.set(key, result);
    return result;
  },

  async initiateDisbursement(input: InitiateDisbursementInput): Promise<DisbursementResult> {
    const transferCode = `TRF_mock_${input.reference}`;
    const result: DisbursementResult = {
      reference: input.reference,
      transferCode,
      status: "success",
      amountKobo: input.amountKobo,
      feeKobo: 0,
    };
    mockPaymentState.disbursements.set(input.reference, {
      input,
      transferCode,
      status: "success",
    });
    return result;
  },

  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    if (!signature) return false;
    if (signature === "mock-signature") return true;

    // Also support verifying against a test mock HMAC secret "mock-secret"
    const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const hmac = crypto.createHmac("sha512", "mock-secret").update(bodyStr).digest("hex");
    return hmac === signature;
  },

  parseWebhookEvent<T = Record<string, unknown>>(
    rawBody: string | Buffer,
    signature: string,
  ): WebhookEvent<T> {
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      throw new Error("Invalid mock webhook signature");
    }
    const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const parsed = JSON.parse(bodyStr) as WebhookEvent<T>;
    mockPaymentState.webhookEvents.push(parsed as unknown as WebhookEvent);
    return parsed;
  },
};

export type PaystackProviderOptions = {
  secretKey?: string;
  publicKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
};

export function createPaystackPaymentProvider(
  options: PaystackProviderOptions = {},
): PaymentProvider {
  function getSecretKey(): string {
    const env = loadEnv();
    const key = options.secretKey ?? env.PAYSTACK_SECRET_KEY;
    if (!key) {
      throw new Error("PAYSTACK_SECRET_KEY is required for paystack payment provider");
    }
    return key;
  }

  function getBaseUrl(): string {
    const env = loadEnv();
    return (options.baseUrl ?? env.PAYSTACK_BASE_URL ?? "https://api.paystack.co").replace(
      /\/$/,
      "",
    );
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;

  async function requestPaystack<T>(
    endpoint: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    const secretKey = getSecretKey();
    const url = `${getBaseUrl()}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    };

    const res = await fetchFn(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const responseText = await res.text().catch(() => "");
    let json: { status: boolean; message?: string; data?: unknown };
    try {
      json = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Paystack API error [HTTP ${res.status}]: ${responseText.slice(0, 200)}`,
      );
    }

    if (!res.ok || json.status === false) {
      throw new Error(
        `Paystack API error [HTTP ${res.status}]: ${json.message ?? "Unknown error"}`,
      );
    }

    return json.data as T;
  }

  return {
    name: "paystack",

    async initializeDeposit(input: InitializeDepositInput): Promise<InitializeDepositResult> {
      const data = await requestPaystack<{
        authorization_url: string;
        access_code: string;
        reference: string;
      }>("/transaction/initialize", "POST", {
        reference: input.reference,
        amount: input.amountKobo,
        email: input.email,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      });

      return {
        reference: data.reference,
        authorizationUrl: data.authorization_url,
        accessCode: data.access_code,
        status: "pending",
      };
    },

    async verifyDeposit(reference: string): Promise<VerifyDepositResult> {
      const data = await requestPaystack<{
        reference: string;
        status: string;
        amount: number;
        currency: string;
        paid_at?: string;
        metadata?: Record<string, unknown>;
      }>(`/transaction/verify/${encodeURIComponent(reference)}`, "GET");

      let mappedStatus: "success" | "failed" | "abandoned" | "pending" = "pending";
      if (data.status === "success") mappedStatus = "success";
      else if (data.status === "failed") mappedStatus = "failed";
      else if (data.status === "abandoned") mappedStatus = "abandoned";

      return {
        reference: data.reference,
        status: mappedStatus,
        amountKobo: data.amount,
        currency: data.currency,
        paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
        metadata: data.metadata,
      };
    },

    async createTransferRecipient(
      input: CreateTransferRecipientInput,
    ): Promise<TransferRecipientResult> {
      const data = await requestPaystack<{
        recipient_code: string;
        name: string;
        details?: {
          account_number?: string;
          bank_code?: string;
        };
        currency: string;
      }>("/transferrecipient", "POST", {
        type: "nuban",
        name: input.name,
        account_number: input.accountNumber,
        bank_code: input.bankCode,
        currency: input.currency ?? "NGN",
        description: input.description,
        metadata: input.metadata,
      });

      return {
        recipientCode: data.recipient_code,
        accountName: data.name ?? input.name,
        accountNumber: data.details?.account_number ?? input.accountNumber,
        bankCode: data.details?.bank_code ?? input.bankCode,
        currency: data.currency ?? "NGN",
      };
    },

    async initiateDisbursement(input: InitiateDisbursementInput): Promise<DisbursementResult> {
      const data = await requestPaystack<{
        reference: string;
        transfer_code: string;
        status: string;
        amount: number;
        fee?: number;
      }>("/transfer", "POST", {
        source: "balance",
        amount: input.amountKobo,
        recipient: input.recipientCode,
        reason: input.reason ?? "StepPal Pot Payout",
        reference: input.reference,
      });

      let status: "pending" | "success" | "failed" = "pending";
      if (data.status === "success") status = "success";
      else if (data.status === "failed") status = "failed";

      return {
        reference: data.reference,
        transferCode: data.transfer_code,
        status,
        amountKobo: data.amount,
        feeKobo: data.fee,
      };
    },

    verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
      if (!signature) return false;
      const secretKey = getSecretKey();
      const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
      const computedHash = crypto
        .createHmac("sha512", secretKey)
        .update(bodyStr)
        .digest("hex");

      const hashBuf = Buffer.from(computedHash, "utf8");
      const sigBuf = Buffer.from(signature, "utf8");

      if (hashBuf.length !== sigBuf.length) return false;
      return crypto.timingSafeEqual(hashBuf, sigBuf);
    },

    parseWebhookEvent<T = Record<string, unknown>>(
      rawBody: string | Buffer,
      signature: string,
    ): WebhookEvent<T> {
      if (!this.verifyWebhookSignature(rawBody, signature)) {
        throw new Error("Invalid Paystack webhook signature");
      }
      const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
      return JSON.parse(bodyStr) as WebhookEvent<T>;
    },
  };
}

export const PaystackPaymentProvider = createPaystackPaymentProvider();

let cachedProvider: PaymentProvider | undefined;

export function getPaymentProvider(): PaymentProvider {
  if (cachedProvider) return cachedProvider;
  const env = loadEnv();
  cachedProvider =
    env.PAYMENT_PROVIDER === "paystack" ? PaystackPaymentProvider : MockPaymentProvider;
  return cachedProvider;
}

export function resetPaymentProviderForTest(): void {
  cachedProvider = undefined;
}
