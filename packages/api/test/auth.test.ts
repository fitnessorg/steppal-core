import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { queryClient } from "../src/db/client.js";
import { sentMessages } from "../src/lib/sms.js";
import { OTP_MAX_PER_HOUR } from "../src/lib/otp.js";
import { reset, signIn } from "./helpers.js";

const PHONE = "08031234567";
const E164 = "+2348031234567";

/** Pulls the six-digit code out of the message the console provider "sent". */
function lastCode(): string {
  const last = sentMessages.at(-1);
  if (!last) throw new Error("no SMS was sent");
  const match = last.message.match(/\d{6}/);
  if (!match) throw new Error(`no code in message: ${last.message}`);
  return match[0];
}

describe("auth", () => {
  beforeEach(reset);
  afterAll(async () => {
    await queryClient.end();
  });

  it("creates an account on first successful sign in", async () => {
    const app = buildApp();
    const session = await signIn(app, PHONE);

    expect(session.user.phone).toBe(E164);
    expect(session.accessToken).toEqual(expect.any(String));
    expect(session.refreshToken).toEqual(expect.any(String));

    await app.close();
  });

  it("treats the same number written differently as one account", async () => {
    const app = buildApp();

    const first = await signIn(app, "08031234567");
    const second = await signIn(app, "+234 803 123 4567");

    expect(second.user.id).toBe(first.user.id);

    await app.close();
  });

  it("rejects a wrong code and counts the attempt", async () => {
    const app = buildApp();
    await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: PHONE } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-code",
      payload: { phone: PHONE, code: "000000" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_code" });

    await app.close();
  });

  it("does not let a consumed code be reused", async () => {
    const app = buildApp();
    await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone: PHONE } });
    const code = lastCode();

    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-code",
      payload: { phone: PHONE, code },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-code",
      payload: { phone: PHONE, code },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);

    await app.close();
  });

  it("rate limits code requests for one number", async () => {
    const app = buildApp();

    for (let i = 0; i < OTP_MAX_PER_HOUR; i++) {
      const ok = await app.inject({
        method: "POST",
        url: "/v1/auth/request-code",
        payload: { phone: PHONE },
      });
      expect(ok.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/request-code",
      payload: { phone: PHONE },
    });

    expect(blocked.statusCode).toBe(429);

    await app.close();
  });

  it("rejects a phone number it cannot normalise", async () => {
    const app = buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/request-code",
      payload: { phone: "12345" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("rotates the refresh token and refuses the old one", async () => {
    const app = buildApp();
    const session = await signIn(app, PHONE);

    const refreshed = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: session.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).not.toBe(session.refreshToken);

    const replayed = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: session.refreshToken },
    });
    expect(replayed.statusCode).toBe(401);

    await app.close();
  });

  it("returns the signed-in user from /v1/me and refuses without a token", async () => {
    const app = buildApp();
    const session = await signIn(app, PHONE);

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(session.user.id);

    const anonymous = await app.inject({ method: "GET", url: "/v1/me" });
    expect(anonymous.statusCode).toBe(401);

    await app.close();
  });

  it("logout revokes only the device that logged out", async () => {
    const app = buildApp();
    const phoneSession = await signIn(app, PHONE);
    const tabletSession = await signIn(app, PHONE);

    await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refreshToken: phoneSession.refreshToken },
    });

    const revoked = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: phoneSession.refreshToken },
    });
    const stillGood = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: tabletSession.refreshToken },
    });

    expect(revoked.statusCode).toBe(401);
    expect(stillGood.statusCode).toBe(200);

    await app.close();
  });
});
