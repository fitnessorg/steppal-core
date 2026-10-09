import { loadEnv } from "./env.js";

export interface SmsProvider {
  readonly name: string;
  send(to: string, message: string): Promise<void>;
}

/**
 * Every message the console provider has "sent", newest last, capped so a long
 * dev session cannot grow it without bound.
 *
 * This is how the auth flow is tested end to end without reading a real SMS.
 * It exists only on the console provider, so there is no path by which a
 * production build keeps codes in memory.
 */
export const sentMessages: { to: string; message: string }[] = [];
const SENT_LOG_LIMIT = 50;

/**
 * Logs instead of sending. This is the development and CI provider, and it is
 * what makes the whole auth flow testable with no account anywhere.
 */
const ConsoleSmsProvider: SmsProvider = {
  name: "console",
  async send(to, message) {
    console.log(`[sms:console] -> ${to}: ${message}`);
    sentMessages.push({ to, message });
    if (sentMessages.length > SENT_LOG_LIMIT) sentMessages.shift();
  },
};

/**
 * TODO(contributor): implement the Termii provider
 * Termii is the usual choice for Nigerian numbers. POST to their /api/sms/send
 * endpoint with the API key from env, map non-2xx to a thrown error, and add a
 * TERMII_API_KEY and TERMII_SENDER_ID to lib/env.ts. Keep the interface — the
 * console provider must stay the default so contributors need no account.
 * difficulty: medium
 */
const TermiiSmsProvider: SmsProvider = {
  name: "termii",
  async send() {
    throw new Error("Termii provider not implemented yet");
  },
};

let cached: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  if (cached) return cached;
  cached = loadEnv().SMS_PROVIDER === "termii" ? TermiiSmsProvider : ConsoleSmsProvider;
  return cached;
}
