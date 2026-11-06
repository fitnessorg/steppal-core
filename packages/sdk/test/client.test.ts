import { describe, it, expect, vi } from "vitest";
import { StepPalClient, StepPalError } from "../src/index.js";

/** A fetch stand-in that replays queued responses and records what was asked. */
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];

  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift() ?? { status: 500, body: { error: "no_response_queued" } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });

  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const BASE = "https://api.steppal.test";

describe("StepPalClient", () => {
  it("sends the access token on authenticated calls", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
    const client = new StepPalClient({
      baseUrl: BASE,
      fetch: fn,
      getTokens: () => ({ accessToken: "access-1", refreshToken: "refresh-1" }),
    });

    await client.listPots();

    expect(calls[0]!.url).toBe(`${BASE}/v1/pots`);
    expect(calls[0]!.headers.authorization).toBe("Bearer access-1");
  });

  it("does not send a token on sign-in calls", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { ok: true, expiresInSeconds: 600 } }]);
    const client = new StepPalClient({
      baseUrl: BASE,
      fetch: fn,
      getTokens: () => ({ accessToken: "access-1", refreshToken: "refresh-1" }),
    });

    await client.requestCode("08031234567");

    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("stores the tokens a successful sign-in returns", async () => {
    const onTokens = vi.fn();
    const { fn } = fakeFetch([
      {
        status: 200,
        body: {
          accessToken: "a",
          refreshToken: "r",
          user: {
            id: "u1",
            phone: "+2348031234567",
            displayName: "Ada",
            avatarSeed: "s",
            dailyGoal: 10000,
          },
        },
      },
    ]);

    const client = new StepPalClient({ baseUrl: BASE, fetch: fn, onTokens });
    await client.verifyCode("08031234567", "123456");

    expect(onTokens).toHaveBeenCalledWith({ accessToken: "a", refreshToken: "r" });
  });

  it("refreshes once on a 401 and replays the original call", async () => {
    let tokens = { accessToken: "stale", refreshToken: "r1" };
    const { fn, calls } = fakeFetch([
      { status: 401, body: { error: "invalid_token" } },
      { status: 200, body: { accessToken: "fresh", refreshToken: "r2" } },
      { status: 200, body: [{ id: "p1" }] },
    ]);

    const client = new StepPalClient({
      baseUrl: BASE,
      fetch: fn,
      getTokens: () => tokens,
      onTokens: (next) => {
        tokens = next!;
      },
    });

    const pots = await client.listPots();

    expect(pots).toEqual([{ id: "p1" }]);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/pots`,
      `${BASE}/v1/auth/refresh`,
      `${BASE}/v1/pots`,
    ]);
    expect(calls[2]!.headers.authorization).toBe("Bearer fresh");
  });

  it("clears the tokens when the refresh token is dead", async () => {
    const onTokens = vi.fn();
    const { fn } = fakeFetch([
      { status: 401, body: { error: "invalid_token" } },
      { status: 401, body: { error: "invalid_refresh_token" } },
    ]);

    const client = new StepPalClient({
      baseUrl: BASE,
      fetch: fn,
      getTokens: () => ({ accessToken: "stale", refreshToken: "dead" }),
      onTokens,
    });

    await expect(client.listPots()).rejects.toBeInstanceOf(StepPalError);
    expect(onTokens).toHaveBeenCalledWith(null);
  });

  it("de-duplicates concurrent refreshes so rotation does not race itself", async () => {
    let tokens = { accessToken: "stale", refreshToken: "r1" };
    const { fn, calls } = fakeFetch([
      { status: 401, body: { error: "invalid_token" } },
      { status: 401, body: { error: "invalid_token" } },
      { status: 200, body: { accessToken: "fresh", refreshToken: "r2" } },
      { status: 200, body: [] },
      { status: 200, body: { days: [] } },
    ]);

    const client = new StepPalClient({
      baseUrl: BASE,
      fetch: fn,
      getTokens: () => tokens,
      onTokens: (next) => {
        tokens = next!;
      },
    });

    await Promise.all([client.listPots(), client.getSteps()]);

    const refreshes = calls.filter((c) => c.url.endsWith("/v1/auth/refresh"));
    expect(refreshes).toHaveLength(1);
  });

  it("turns an error body into a StepPalError carrying the server's code", async () => {
    const { fn } = fakeFetch([{ status: 409, body: { error: "pot_already_started" } }]);
    const client = new StepPalClient({ baseUrl: BASE, fetch: fn });

    await expect(client.joinPot("IKEJ-2290")).rejects.toMatchObject({
      status: 409,
      code: "pot_already_started",
    });
  });

  it("survives an error body that is not JSON", async () => {
    const fn = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const client = new StepPalClient({
      baseUrl: BASE,
      fetch: fn as unknown as typeof globalThis.fetch,
    });

    await expect(client.listPots()).rejects.toMatchObject({
      status: 502,
      code: "request_failed",
    });
  });

  it("builds a step range query only from the parts given", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { days: [] } },
      { status: 200, body: { days: [] } },
    ]);
    const client = new StepPalClient({ baseUrl: BASE, fetch: fn });

    await client.getSteps();
    await client.getSteps({ from: "2026-10-01" });

    expect(calls[0]!.url).toBe(`${BASE}/v1/steps`);
    expect(calls[1]!.url).toBe(`${BASE}/v1/steps?from=2026-10-01`);
  });

  it("drops local tokens on logout even when the server call fails", async () => {
    const onTokens = vi.fn();
    const fn = vi.fn(async () => {
      throw new Error("network down");
    });

    const client = new StepPalClient({
      baseUrl: BASE,
      fetch: fn as unknown as typeof globalThis.fetch,
      getTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      onTokens,
    });

    await client.logout();

    expect(onTokens).toHaveBeenCalledWith(null);
  });

  describe("pot pagination", () => {
    it("attaches limit and cursor query parameters when provided", async () => {
      const { fn, calls } = fakeFetch([
        { status: 200, body: [] },
        { status: 200, body: [] },
      ]);
      const client = new StepPalClient({ baseUrl: BASE, fetch: fn });

      await client.listPots({ limit: 20 });
      await client.listPots({ limit: 10, cursor: "2026-10-15T12:00:00.000Z" });

      expect(calls[0]!.url).toBe(`${BASE}/v1/pots?limit=20`);
      expect(calls[1]!.url).toBe(`${BASE}/v1/pots?limit=10&cursor=2026-10-15T12%3A00%3A00.000Z`);
    });

    it("leaves query string empty when no pagination parameters are supplied", async () => {
      const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
      const client = new StepPalClient({ baseUrl: BASE, fetch: fn });

      await client.listPots();

      expect(calls[0]!.url).toBe(`${BASE}/v1/pots`);
    });
  });

  describe("offline step submission queue", () => {
    it("automatically queues steps when submission fails due to a network error", async () => {
      const onQueueChange = vi.fn();
      let shouldFail = true;

      const fn = vi.fn(async (_url: string, _init: RequestInit = {}) => {
        if (shouldFail) {
          throw new TypeError("Failed to fetch");
        }
        return new Response(JSON.stringify({ accepted: 1, clamped: 0, rejected: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const client = new StepPalClient({
        baseUrl: BASE,
        fetch: fn as unknown as typeof globalThis.fetch,
        onStepQueueChange: onQueueChange,
      });

      const day1 = { day: "2026-11-01", steps: 8500, source: "pedometer" as const };

      // Submit offline
      await expect(client.submitSteps([day1])).rejects.toThrow("Failed to fetch");

      // Verify item was queued
      expect(client.getStepQueue()).toEqual([day1]);
      expect(onQueueChange).toHaveBeenCalledWith([day1]);

      // Network recovers
      shouldFail = false;
      const res = await client.flushStepQueue();

      expect(res).toEqual({ accepted: 1, clamped: 0, rejected: [] });
      expect(client.getStepQueue()).toEqual([]);
      expect(onQueueChange).toHaveBeenLastCalledWith([]);

      // Duplicate flush does not make a network call and returns null
      const duplicateRes = await client.flushStepQueue();
      expect(duplicateRes).toBeNull();
      expect(fn).toHaveBeenCalledTimes(2); // Initial failed call + 1 successful flush
    });

    it("deduplicates steps by day keeping the latest entry", async () => {
      const client = new StepPalClient({ baseUrl: BASE });

      await client.queueSteps([
        { day: "2026-11-01", steps: 5000 },
        { day: "2026-11-02", steps: 6000 },
      ]);
      await client.queueSteps([
        { day: "2026-11-01", steps: 9500 }, // Overwrite day 1 with newer count
      ]);

      expect(client.getStepQueue()).toEqual([
        { day: "2026-11-01", steps: 9500 },
        { day: "2026-11-02", steps: 6000 },
      ]);
    });

    it("allows restoring from initial queue and clearing queue", async () => {
      const initial = [{ day: "2026-11-03", steps: 12000 }];
      const client = new StepPalClient({
        baseUrl: BASE,
        initialStepQueue: initial,
      });

      expect(client.getQueuedSteps()).toEqual(initial);

      await client.clearStepQueue();
      expect(client.getStepQueue()).toEqual([]);
    });

    it("does not queue steps on client/server validation errors (4xx)", async () => {
      const fn = vi.fn(async () => {
        return new Response(JSON.stringify({ error: "invalid_day_format" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      });

      const client = new StepPalClient({
        baseUrl: BASE,
        fetch: fn as unknown as typeof globalThis.fetch,
      });

      await expect(client.submitSteps([{ day: "invalid-day", steps: 1000 }])).rejects.toMatchObject(
        {
          status: 400,
          code: "invalid_day_format",
        },
      );

      expect(client.getStepQueue()).toEqual([]);
    });

    it("preserves queued steps if flush attempt encounters network failure", async () => {
      const fn = vi.fn(async () => {
        throw new TypeError("network down during flush");
      });

      const queued = [{ day: "2026-11-04", steps: 7000 }];
      const client = new StepPalClient({
        baseUrl: BASE,
        fetch: fn as unknown as typeof globalThis.fetch,
        initialStepQueue: queued,
      });

      await expect(client.flushStepQueue()).rejects.toThrow("network down during flush");
      // Items must remain safely in the queue
      expect(client.getStepQueue()).toEqual(queued);
    });
  });

  describe("payments", () => {
    it("initializes payment with authorization url and access code", async () => {
      const { fn, calls } = fakeFetch([
        {
          status: 200,
          body: {
            reference: "ref_123",
            authorizationUrl: "https://checkout.paystack.com/auth-123",
            accessCode: "acc_123",
            status: "pending",
          },
        },
      ]);

      const client = new StepPalClient({
        baseUrl: BASE,
        fetch: fn,
        getTokens: () => ({ accessToken: "access-token", refreshToken: "refresh-token" }),
      });

      const res = await client.initializePayment({
        potId: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        amountKobo: 500000,
      });

      expect(calls[0]!.url).toBe(`${BASE}/v1/payments/initialize`);
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers.authorization).toBe("Bearer access-token");
      expect(res.reference).toBe("ref_123");
      expect(res.authorizationUrl).toBe("https://checkout.paystack.com/auth-123");
    });

    it("verifies payment by reference", async () => {
      const { fn, calls } = fakeFetch([
        {
          status: 200,
          body: {
            reference: "ref_123",
            status: "success",
            amountKobo: 500000,
            currency: "NGN",
          },
        },
      ]);

      const client = new StepPalClient({
        baseUrl: BASE,
        fetch: fn,
        getTokens: () => ({ accessToken: "access-token", refreshToken: "refresh-token" }),
      });

      const res = await client.verifyPayment("ref_123");

      expect(calls[0]!.url).toBe(`${BASE}/v1/payments/verify/ref_123`);
      expect(calls[0]!.method).toBe("GET");
      expect(res.status).toBe("success");
      expect(res.amountKobo).toBe(500000);
    });

    it("instructs payout disbursement to bank account", async () => {
      const { fn, calls } = fakeFetch([
        {
          status: 200,
          body: {
            ok: true,
            reference: "disb_ref_456",
            transferCode: "TRF_456",
            status: "success",
            amountKobo: 750000,
          },
        },
      ]);

      const client = new StepPalClient({
        baseUrl: BASE,
        fetch: fn,
        getTokens: () => ({ accessToken: "access-token", refreshToken: "refresh-token" }),
      });

      const res = await client.disbursePayout({
        recipientName: "Ada Lovelace",
        accountNumber: "0123456789",
        bankCode: "058",
        amountKobo: 750000,
      });

      expect(calls[0]!.url).toBe(`${BASE}/v1/payments/disburse`);
      expect(calls[0]!.method).toBe("POST");
      expect(res.transferCode).toBe("TRF_456");
      expect(res.status).toBe("success");
    });
  });
});
