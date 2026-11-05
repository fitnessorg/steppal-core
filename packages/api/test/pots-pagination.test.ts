import { describe, it, expect } from "vitest";
import { z } from "zod";

describe("pot pagination query validation", () => {
  const querySchema = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
      cursor: z.string().optional(),
    })
    .optional();

  it("applies default limit of 50 when empty query is provided", () => {
    const parsed = querySchema.parse({});
    expect(parsed?.limit).toBe(50);
  });

  it("accepts valid numeric limits within bounds", () => {
    expect(querySchema.parse({ limit: "1" })?.limit).toBe(1);
    expect(querySchema.parse({ limit: "25" })?.limit).toBe(25);
    expect(querySchema.parse({ limit: "100" })?.limit).toBe(100);
  });

  it("rejects limits out of bounds", () => {
    expect(() => querySchema.parse({ limit: "0" })).toThrow();
    expect(() => querySchema.parse({ limit: "101" })).toThrow();
    expect(() => querySchema.parse({ limit: "-5" })).toThrow();
  });

  it("accepts and parses ISO timestamp cursor strings", () => {
    const cursor = "2026-11-05T12:00:00.000Z";
    const parsed = querySchema.parse({ cursor });
    expect(parsed?.cursor).toBe(cursor);

    const cursorDate = new Date(parsed!.cursor!);
    expect(isNaN(cursorDate.getTime())).toBe(false);
    expect(cursorDate.toISOString()).toBe(cursor);
  });
});
