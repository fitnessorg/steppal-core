import { describe, it, expect } from "vitest";
import { addDays, daysBetween, toDayKey, parseDayKey, todayKey } from "../src/lib/dates.js";

process.env.DATABASE_URL ??= "postgres://steppal:steppal@localhost:5432/steppal";
process.env.JWT_SECRET ??= "edge-case-test-secret-at-least-32-characters";

describe("calendar day helpers", () => {
  it("round-trips a day key", () => {
    expect(toDayKey(parseDayKey("2026-03-09"))).toBe("2026-03-09");
  });

  it("rolls over month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("handles leap days", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("lists an inclusive range", () => {
    expect(daysBetween("2026-05-01", "2026-05-03")).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
  });

  it("returns a single day when from equals to", () => {
    expect(daysBetween("2026-05-01", "2026-05-01")).toEqual(["2026-05-01"]);
  });

  it("returns nothing for an inverted range rather than looping", () => {
    expect(daysBetween("2026-05-03", "2026-05-01")).toEqual([]);
  });

  it("caps runaway ranges", () => {
    expect(daysBetween("2020-01-01", "2030-01-01").length).toBe(400);
  });

  it("produces a zero-padded today key", () => {
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("step submission validation edges", () => {
  it("accepts today, rejects tomorrow", async () => {
    const { validateSubmission } = await import("../src/lib/steps.js");
    const today = todayKey();
    expect(validateSubmission({ day: today, steps: 100, source: "pedometer" }).ok).toBe(true);
    const tomorrow = validateSubmission({ day: addDays(today, 1), steps: 100, source: "pedometer" });
    expect(tomorrow).toEqual({ ok: false, reason: "future_day" });
  });

  it("accepts the oldest allowed backfill day and rejects one older", async () => {
    const { validateSubmission } = await import("../src/lib/steps.js");
    const today = todayKey();
    expect(validateSubmission({ day: addDays(today, -8), steps: 100, source: "pedometer" }).ok).toBe(true);
    expect(validateSubmission({ day: addDays(today, -9), steps: 100, source: "pedometer" })).toEqual({
      ok: false,
      reason: "too_old",
    });
  });

  it("rejects negative counts and accepts zero", async () => {
    const { validateSubmission } = await import("../src/lib/steps.js");
    const today = todayKey();
    expect(validateSubmission({ day: today, steps: -1, source: "pedometer" })).toEqual({
      ok: false,
      reason: "negative",
    });
    expect(validateSubmission({ day: today, steps: 0, source: "pedometer" }).ok).toBe(true);
  });

  it("clamps above the cap while preserving the raw value", async () => {
    const { validateSubmission } = await import("../src/lib/steps.js");
    const result = validateSubmission({ day: todayKey(), steps: 90000, source: "pedometer" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps).toBeLessThan(90000);
      expect(result.rawSteps).toBe(90000);
    }
  });
});
