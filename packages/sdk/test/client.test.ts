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
          user: { id: "u1", phone: "+2348031234567", displayName: "Ada", avatarSeed: "s", dailyGoal: 10000 },
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
});
