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
export const ConsoleSmsProvider: SmsProvider = {
  name: "console",
  async send(to, message) {
    console.log(`[sms:console] -> ${to}: ${message}`);
    sentMessages.push({ to, message });
    if (sentMessages.length > SENT_LOG_LIMIT) sentMessages.shift();
  },
};

export type TermiiProviderOptions = {
  apiKey?: string;
  senderId?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
};

export function createTermiiSmsProvider(options: TermiiProviderOptions = {}): SmsProvider {
  return {
    name: "termii",
    async send(to: string, message: string) {
      const env = loadEnv();
      const apiKey = options.apiKey ?? env.TERMII_API_KEY;
      const senderId = options.senderId ?? env.TERMII_SENDER_ID;
      const baseUrl = options.baseUrl ?? env.TERMII_BASE_URL;
      const fetchFn = options.fetchFn ?? globalThis.fetch;

      if (!apiKey) {
        throw new Error("TERMII_API_KEY is required for termii sms provider");
      }

      // Termii expects international destination numbers without the leading plus
      const normalizedTo = to.replace(/^\+/, "");
      const url = `${baseUrl.replace(/\/$/, "")}/api/sms/send`;

      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: normalizedTo,
          from: senderId,
          sms: message,
          type: "plain",
          channel: "generic",
          api_key: apiKey,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`Termii SMS delivery failed with status ${response.status}: ${errorBody}`);
      }
    },
  };
}

export const TermiiSmsProvider: SmsProvider = createTermiiSmsProvider();

let cached: SmsProvider | undefined;

export function getSmsProvider(): SmsProvider {
  if (cached) return cached;
  cached = loadEnv().SMS_PROVIDER === "termii" ? TermiiSmsProvider : ConsoleSmsProvider;
  return cached;
}

export function resetSmsProviderForTest(): void {
  cached = undefined;
}
