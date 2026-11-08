import { describe, it, expect } from "vitest";
import {
  checkPhysicalBoundaries,
  checkCrossDayVelocity,
  MAX_PHYSICAL_DAILY_STEPS,
  MAX_VELOCITY_SPIKE_RATIO,
} from "../src/anti-cheat.js";
import type { StepClaim } from "../src/types.js";

function claim(day: string, steps: number, overrides: Partial<StepClaim> = {}): StepClaim {
  return {
    userId: "usr_edge",
    day,
    steps,
    source: "health_connect",
    submittedAt: `${day}T20:00:00Z`,
    ...overrides,
  };
}

describe("anti-cheat edge cases", () => {
  it("accepts a day exactly at the physical boundary", () => {
    const result = checkPhysicalBoundaries([claim("2026-11-01", MAX_PHYSICAL_DAILY_STEPS)]);
    expect(result.passed).toBe(true);
  });

  it("rejects a day one step over the physical boundary", () => {
    const result = checkPhysicalBoundaries([claim("2026-11-01", MAX_PHYSICAL_DAILY_STEPS + 1)]);
    expect(result.passed).toBe(false);
    expect(result.flags).toContain("IMPLAUSIBLE_STEP_BURST");
  });

  it("rejects an absurd raw step report even when the clamped value is plausible", () => {
    const result = checkPhysicalBoundaries([
      claim("2026-11-01", 25000, { rawSteps: MAX_PHYSICAL_DAILY_STEPS * 2 }),
    ]);
    expect(result.passed).toBe(false);
  });

  it("passes an empty claim list", () => {
    expect(checkPhysicalBoundaries([]).passed).toBe(true);
    expect(checkCrossDayVelocity([]).passed).toBe(true);
  });

  it("does not flag velocity for a single claim", () => {
    expect(checkCrossDayVelocity([claim("2026-11-01", 20000)]).passed).toBe(true);
  });

  it("allows a jump exactly at the velocity ratio limit", () => {
    const base = 2000;
    const result = checkCrossDayVelocity([
      claim("2026-11-01", base),
      claim("2026-11-02", base * MAX_VELOCITY_SPIKE_RATIO),
    ]);
    expect(result.passed).toBe(true);
  });

  it("flags a jump beyond the velocity ratio limit", () => {
    const result = checkCrossDayVelocity([
      claim("2026-11-01", 1000),
      claim("2026-11-02", 12000),
    ]);
    expect(result.passed).toBe(false);
    expect(result.flags).toContain("VELOCITY_SPIKE");
  });

  it("sorts claims chronologically regardless of input order", () => {
    const result = checkCrossDayVelocity([
      claim("2026-11-02", 12000),
      claim("2026-11-01", 1000),
    ]);
    expect(result.passed).toBe(false);
  });
});
