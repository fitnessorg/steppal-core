import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { queryClient } from "../src/db/client.js";
import { auth, reset, signIn, submitSteps } from "./helpers.js";
import { addDays, todayKey } from "../src/lib/dates.js";

const ADA = "08031234567";

describe("steps", () => {
  beforeEach(reset);
  afterAll(async () => {
    await queryClient.end();
  });

  it("accepts a batch and reads it back", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const days = [addDays(todayKey(), -2), addDays(todayKey(), -1), todayKey()];
    const res = await submitSteps(app, ada, days, 9000);

    expect(res.json()).toEqual({ accepted: 3, clamped: 0, rejected: [] });

    const read = await app.inject({ method: "GET", url: "/v1/steps", headers: auth(ada) });
    expect(read.json().days).toHaveLength(3);
    expect(read.json().days[0].steps).toBe(9000);

    await app.close();
  });

  it("is idempotent — resending a day overwrites rather than adds", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    await submitSteps(app, ada, [todayKey()], 5000);
    await submitSteps(app, ada, [todayKey()], 7000);
    await submitSteps(app, ada, [todayKey()], 7000);

    const read = await app.inject({ method: "GET", url: "/v1/steps", headers: auth(ada) });
    expect(read.json().days).toHaveLength(1);
    expect(read.json().days[0].steps).toBe(7000);

    await app.close();
  });

  it("clamps an implausible count and keeps what was claimed", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const res = await submitSteps(app, ada, [todayKey()], 900_000);
    expect(res.json().clamped).toBe(1);

    const read = await app.inject({ method: "GET", url: "/v1/steps", headers: auth(ada) });
    expect(read.json().days[0].steps).toBe(25000);

    const raw = await queryClient`select raw_steps from step_days limit 1`;
    expect(raw[0]!.raw_steps).toBe(900_000);

    await app.close();
  });

  it("refuses a day in the future", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const res = await submitSteps(app, ada, [addDays(todayKey(), 1)], 10000);

    expect(res.json().accepted).toBe(0);
    expect(res.json().rejected).toEqual([
      { day: addDays(todayKey(), 1), reason: "future_day" },
    ]);

    await app.close();
  });

  it("refuses a backfill older than the settlement window", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const res = await submitSteps(app, ada, [addDays(todayKey(), -30)], 10000);

    expect(res.json().accepted).toBe(0);
    expect(res.json().rejected[0].reason).toBe("too_old");

    await app.close();
  });

  it("keeps one walker's steps out of another's totals", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, "08039998888");

    await submitSteps(app, ada, [todayKey()], 12000);

    const theirs = await app.inject({
      method: "GET",
      url: "/v1/steps",
      headers: auth(tunde),
    });

    expect(theirs.json().days).toHaveLength(0);

    await app.close();
  });
});
