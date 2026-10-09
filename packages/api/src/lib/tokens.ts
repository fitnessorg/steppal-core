import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { loadEnv } from "./env.js";

/**
 * Access tokens are short-lived JWTs the API verifies without a database read.
 * Refresh tokens are opaque random strings stored as hashes — a leaked database
 * yields nothing replayable, and revocation is a single UPDATE.
 *
 * The asymmetry is deliberate: the fast path stays stateless, and the rare path
 * (refresh) can afford a round trip in exchange for being revocable.
 */

export type AccessClaims = { sub: string };

function secretKey(): Uint8Array {
  return new TextEncoder().encode(loadEnv().JWT_SECRET);
}

export async function signAccessToken(userId: string): Promise<string> {
  const env = loadEnv();
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer("steppal")
    .setAudience("steppal-app")
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: "steppal",
    audience: "steppal-app",
  });
  if (typeof payload.sub !== "string") throw new Error("token has no subject");
  return { sub: payload.sub };
}

/** 256 bits of entropy, URL-safe. Never stored in this form. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256 rather than a password hash on purpose: these are 256-bit random
 * values, not user-chosen secrets, so there is nothing to brute force and the
 * cost of bcrypt would buy no security. The same reasoning covers OTP codes,
 * which are additionally short-lived and attempt-capped.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
