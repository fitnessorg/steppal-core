import { describe, it, expect, beforeEach } from "vitest";
import {
  ConsoleSmsProvider,
  createTermiiSmsProvider,
  getSmsProvider,
  resetSmsProviderForTest,
  sentMessages,
} from "../src/lib/sms.js";
import { resetEnvForTest } from "../src/lib/env.js";

describe("sms providers", () => {
  beforeEach(() => {
    sentMessages.length = 0;
    resetSmsProviderForTest();
    resetEnvForTest();
  });

  describe("console provider", () => {
    it("records sent messages in memory for test assertions", async () => {
      await ConsoleSmsProvider.send("+2348012345678", "123456 is your StepPal code");
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        to: "+2348012345678",
        message: "123456 is your StepPal code",
      });
    });

    it("is returned as default provider", () => {
      const provider = getSmsProvider();
      expect(provider.name).toBe("console");
    });
  });

  describe("termii provider", () => {
    it("throws when API key is missing", async () => {
      const termii = createTermiiSmsProvider({ apiKey: "" });
      await expect(termii.send("+2348012345678", "Code 123456")).rejects.toThrow(
        "TERMII_API_KEY is required",
      );
    });

    it("sends payload to Termii API endpoint and normalises destination format", async () => {
      let interceptedUrl = "";
      let interceptedBody: unknown;

      const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        interceptedUrl = url.toString();
        interceptedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ message: "Successfully Sent" }),
        } as Response;
      }) as typeof fetch;

      const termii = createTermiiSmsProvider({
        apiKey: "test-api-key",
        senderId: "StepPalTest",
        baseUrl: "https://api.test.termii.com",
        fetchFn: mockFetch,
      });

      await termii.send("+2348012345678", "Your code is 654321");

      expect(interceptedUrl).toBe("https://api.test.termii.com/api/sms/send");
      expect(interceptedBody).toEqual({
        to: "2348012345678",
        from: "StepPalTest",
        sms: "Your code is 654321",
        type: "plain",
        channel: "generic",
        api_key: "test-api-key",
      });
    });

    it("throws descriptive error when Termii endpoint returns non-2xx status", async () => {
      const mockFetch = (async () => {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ message: "Invalid API key" }),
        } as Response;
      }) as typeof fetch;

      const termii = createTermiiSmsProvider({
        apiKey: "bad-key",
        fetchFn: mockFetch,
      });

      await expect(termii.send("+2348012345678", "Code")).rejects.toThrow(
        "Termii SMS delivery failed with status 401: {\"message\":\"Invalid API key\"}",
      );
    });
  });
});
