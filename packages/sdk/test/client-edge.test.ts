import { describe, it, expect, vi } from "vitest";
import { StepPalClient, StepPalError } from "../src/index.js";

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const next = responses.shift() ?? { status: 500, body: { error: "no_response_queued" } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

const BASE = "https://api.steppal.test";
const tokens = () => ({ accessToken: "a", refreshToken: "r" });

describe("StepPalClient edge cases", () => {
  it("surfaces the status and machine-readable code on API errors", async () => {
    const { fn } = fakeFetch([{ status: 409, body: { error: "pot_full" } }]);
    const client = new StepPalClient({ baseUrl: BASE, fetch: fn, getTokens: tokens });

    await expect(client.joinPot("IKEJ-2290")).rejects.toMatchObject({
      status: 409,
      code: "pot_full",
    });
  });

  it("throws StepPalError instances", async () => {
    const { fn } = fakeFetch([{ status: 403, body: { error: "forbidden" } }]);
    const client = new StepPalClient({ baseUrl: BASE, fetch: fn, getTokens: tokens });

    await expect(client.getPot("pot_1")).rejects.toBeInstanceOf(StepPalError);
  });

  it("builds pagination query strings only for supplied parameters", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);
    const client = new StepPalClient({ baseUrl: BASE, fetch: fn, getTokens: tokens });

    await client.listPots();
    await client.listPots({ limit: 10 });

    expect(calls[0]!.url).toBe(`${BASE}/v1/pots`);
    expect(calls[1]!.url).toBe(`${BASE}/v1/pots?limit=10`);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [] }]);
    const client = new StepPalClient({ baseUrl: `${BASE}/`, fetch: fn, getTokens: tokens });

    await client.listPots();

    expect(calls[0]!.url.replace("https://", "")).not.toContain("//");
  });
});
