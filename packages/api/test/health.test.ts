import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /health", () => {
  it("returns ok:true and a version string", async () => {
    const app = buildApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      version: expect.any(String),
    });

    await app.close();
  });
});
