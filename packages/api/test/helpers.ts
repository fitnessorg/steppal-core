import { buildApp } from "../src/app.js";
import { queryClient } from "../src/db/client.js";
import { sentMessages } from "../src/lib/sms.js";

export async function reset() {
  await queryClient`truncate table pot_results, refresh_tokens, otp_codes, step_days, pot_members, pots, users restart identity cascade`;
  sentMessages.length = 0;
}

export type Session = { accessToken: string; refreshToken: string; user: { id: string } };

/** Signs a phone number in, creating the account if it is new. */
export async function signIn(
  app: ReturnType<typeof buildApp>,
  phone: string,
): Promise<Session> {
  await app.inject({ method: "POST", url: "/v1/auth/request-code", payload: { phone } });
  const code = sentMessages.at(-1)!.message.match(/\d{6}/)![0];
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/verify-code",
    payload: { phone, code },
  });
  return res.json() as Session;
}

export function auth(session: Session) {
  return { authorization: `Bearer ${session.accessToken}` };
}

/** Reports the same count for every day in the list. */
export async function submitSteps(
  app: ReturnType<typeof buildApp>,
  session: Session,
  days: string[],
  steps: number,
) {
  return app.inject({
    method: "POST",
    url: "/v1/steps",
    headers: auth(session),
    payload: { days: days.map((day) => ({ day, steps, source: "mock" as const })) },
  });
}
