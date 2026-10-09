import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { queryClient } from "../src/db/client.js";
import { auth, reset, signIn } from "./helpers.js";
import { addDays, todayKey } from "../src/lib/dates.js";

const ADA = "08031234567";
const TUNDE = "08039998888";

describe("pots", () => {
  beforeEach(reset);
  afterAll(async () => {
    await queryClient.end();
  });

  it("creates a pot, joins the creator, and issues a readable code", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const res = await app.inject({
      method: "POST",
      url: "/v1/pots",
      headers: auth(ada),
      payload: { name: "Ikeja Early Birds", dailyGoal: 8000 },
    });

    expect(res.statusCode).toBe(201);
    const pot = res.json();
    expect(pot.memberCount).toBe(1);
    expect(pot.inviteCode).toMatch(/^[A-Z]{4}-\d{4}$/);
    expect(pot.inviteCode.startsWith("IKEJ")).toBe(true);

    await app.close();
  });

  it("lets a friend look a pot up by code before committing to it", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, TUNDE);

    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/pots",
        headers: auth(ada),
        payload: { name: "Lekki Walkers" },
      })
    ).json();

    const peek = await app.inject({
      method: "GET",
      url: `/v1/pots/by-code/${created.inviteCode.toLowerCase().replace("-", "")}`,
      headers: auth(tunde),
    });

    expect(peek.statusCode).toBe(200);
    expect(peek.json().name).toBe("Lekki Walkers");
    expect(peek.json().memberCount).toBe(1);

    await app.close();
  });

  it("joins by code, and joining twice is not an error", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, TUNDE);

    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/pots",
        headers: auth(ada),
        payload: { name: "Yaba Steps" },
      })
    ).json();

    const first = await app.inject({
      method: "POST",
      url: "/v1/pots/join",
      headers: auth(tunde),
      payload: { code: created.inviteCode },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/pots/join",
      headers: auth(tunde),
      payload: { code: created.inviteCode },
    });

    expect(first.json().memberCount).toBe(2);
    expect(second.statusCode).toBe(200);
    expect(second.json().memberCount).toBe(2);

    await app.close();
  });

  it("refuses to let someone join a pot that already started", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, TUNDE);

    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/pots",
        headers: auth(ada),
        payload: { name: "Late Comers", startsOn: addDays(todayKey(), -2) },
      })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: "/v1/pots/join",
      headers: auth(tunde),
      payload: { code: created.inviteCode },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "pot_already_started" });

    await app.close();
  });

  it("hides a pot's standings from people who are not in it", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, TUNDE);

    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/pots",
        headers: auth(ada),
        payload: { name: "Private Pot" },
      })
    ).json();

    const res = await app.inject({
      method: "GET",
      url: `/v1/pots/${created.id}`,
      headers: auth(tunde),
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("lets a member leave before the pot starts but not after", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const future = (
      await app.inject({
        method: "POST",
        url: "/v1/pots",
        headers: auth(ada),
        payload: { name: "Next Week", startsOn: addDays(todayKey(), 2) },
      })
    ).json();

    const started = (
      await app.inject({
        method: "POST",
        url: "/v1/pots",
        headers: auth(ada),
        payload: { name: "Running Now" },
      })
    ).json();

    const leftEarly = await app.inject({
      method: "POST",
      url: `/v1/pots/${future.id}/leave`,
      headers: auth(ada),
    });
    const leftLate = await app.inject({
      method: "POST",
      url: `/v1/pots/${started.id}/leave`,
      headers: auth(ada),
    });

    expect(leftEarly.statusCode).toBe(200);
    expect(leftLate.statusCode).toBe(409);

    await app.close();
  });

  it("lists only the pots you are a member of", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, TUNDE);

    await app.inject({
      method: "POST",
      url: "/v1/pots",
      headers: auth(ada),
      payload: { name: "Ada Only" },
    });

    const mine = await app.inject({ method: "GET", url: "/v1/pots", headers: auth(ada) });
    const theirs = await app.inject({ method: "GET", url: "/v1/pots", headers: auth(tunde) });

    expect(mine.json()).toHaveLength(1);
    expect(theirs.json()).toHaveLength(0);

    await app.close();
  });
});
