import type { AntiCheatRuleResult, StepClaim } from "./types.js";

/** Max physically credible steps for an active human in one calendar day */
export const MAX_PHYSICAL_DAILY_STEPS = 50000;

/** Max human running cadence in steps per second (sprint speed ~4.5 steps/sec) */
export const MAX_HUMAN_STEPS_PER_SECOND = 4.5;

/** Maximum allowable single-day velocity ratio spike between consecutive days */
export const MAX_VELOCITY_SPIKE_RATIO = 6.0;

/**
 * Validates that daily step counts do not exceed physiological human limits.
 */
export function checkPhysicalBoundaries(claims: StepClaim[]): AntiCheatRuleResult {
  const violations: string[] = [];

  for (const claim of claims) {
    if (claim.steps > MAX_PHYSICAL_DAILY_STEPS) {
      violations.push(
        `Day ${claim.day}: ${claim.steps} steps exceeds maximum physical boundary of ${MAX_PHYSICAL_DAILY_STEPS}`,
      );
    }
    if (claim.rawSteps !== undefined && claim.rawSteps > MAX_PHYSICAL_DAILY_STEPS * 1.5) {
      violations.push(
        `Day ${claim.day}: raw reported ${claim.rawSteps} exceeds human threshold`,
      );
    }
  }

  if (violations.length > 0) {
    return {
      ruleName: "physical_boundaries",
      passed: false,
      penaltyScore: 0.6,
      flags: ["IMPLAUSIBLE_STEP_BURST", "DAILY_CAP_EXCEEDED"],
      details: violations.join("; "),
    };
  }

  return {
    ruleName: "physical_boundaries",
    passed: true,
    penaltyScore: 0.0,
    flags: [],
  };
}

/**
 * Detects unnatural cross-day step acceleration and velocity spikes.
 * A user jumping from near-zero to peak goal immediately before settlement is flagged.
 */
export function checkCrossDayVelocity(claims: StepClaim[]): AntiCheatRuleResult {
  if (claims.length < 2) {
    return {
      ruleName: "cross_day_velocity",
      passed: true,
      penaltyScore: 0.0,
      flags: [],
    };
  }

  // Sort claims chronologically by day
  const sorted = [...claims].sort((a, b) => a.day.localeCompare(b.day));
  const violations: string[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;

    // Check velocity ratio if current was non-trivial
    if (current.steps >= 500 && next.steps >= 10000) {
      const ratio = next.steps / current.steps;
      if (ratio > MAX_VELOCITY_SPIKE_RATIO) {
        violations.push(
          `Velocity spike from ${current.day} (${current.steps}) to ${next.day} (${next.steps}): ${ratio.toFixed(1)}x increase`,
        );
      }
    }

    // Check submission timestamp velocity if both timestamps available
    const timeCurrent = new Date(current.submittedAt).getTime();
    const timeNext = new Date(next.submittedAt).getTime();
    const diffSeconds = Math.abs(timeNext - timeCurrent) / 1000;

    if (diffSeconds > 0 && diffSeconds < 3600) {
      const stepDelta = Math.abs(next.steps - current.steps);
      const cadence = stepDelta / diffSeconds;
      if (cadence > MAX_HUMAN_STEPS_PER_SECOND) {
        violations.push(
          `Impossible cadence of ${cadence.toFixed(1)} steps/sec between ${current.day} and ${next.day}`,
        );
      }
    }
  }

  if (violations.length > 0) {
    return {
      ruleName: "cross_day_velocity",
      passed: false,
      penaltyScore: 0.4,
      flags: ["VELOCITY_SPIKE"],
      details: violations.join("; "),
    };
  }

  return {
    ruleName: "cross_day_velocity",
    passed: true,
    penaltyScore: 0.0,
    flags: [],
  };
}

/**
 * Validates device identity consistency and sensor sources across a pot window.
 */
export function checkDeviceConsistency(claims: StepClaim[]): AntiCheatRuleResult {
  if (claims.length === 0) {
    return { ruleName: "device_consistency", passed: true, penaltyScore: 0, flags: [] };
  }

  const sources = new Set(claims.map((c) => c.source));
  const violations: string[] = [];

  // Switching between mock and hardware sources inside a staked evaluation
  if (sources.has("mock") && (sources.has("health_connect") || sources.has("pedometer"))) {
    violations.push("Contradictory sensor sources detected: mixed mock and physical sensor claims");
  }

  // Device hash proliferation: checking for device spoofing across multiple hardware identifiers
  const deviceHashes = new Set(claims.map((c) => c.deviceHash).filter(Boolean));
  if (deviceHashes.size > 3 && claims.length <= 7) {
    violations.push(
      `Suspicious device switching: ${deviceHashes.size} distinct devices reported for ${claims.length} days`,
    );
  }

  if (violations.length > 0) {
    return {
      ruleName: "device_consistency",
      passed: false,
      penaltyScore: 0.5,
      flags: ["DEVICE_INCONSISTENCY", "SOURCE_MISMATCH"],
      details: violations.join("; "),
    };
  }

  return {
    ruleName: "device_consistency",
    passed: true,
    penaltyScore: 0.0,
    flags: [],
  };
}

/**
 * Detects bot-like unnatural step count uniformity across consecutive days.
 * Authentic human walking exhibits variance; synthetic generators repeat identical figures.
 */
export function checkStepUniformity(claims: StepClaim[]): AntiCheatRuleResult {
  if (claims.length < 4) {
    return { ruleName: "step_uniformity", passed: true, penaltyScore: 0, flags: [] };
  }

  const stepCounts = claims.map((c) => c.steps);
  const uniqueSteps = new Set(stepCounts);

  // If 4+ days are identical down to the exact digit (e.g. exactly 10,000 every single day)
  if (uniqueSteps.size === 1 && claims.length >= 4 && stepCounts[0]! > 0) {
    return {
      ruleName: "step_uniformity",
      passed: false,
      penaltyScore: 0.45,
      flags: ["UNNATURAL_UNIFORMITY"],
      details: `Unnatural zero variance: all ${claims.length} days reported identical count of ${stepCounts[0]} steps`,
    };
  }

  return {
    ruleName: "step_uniformity",
    passed: true,
    penaltyScore: 0.0,
    flags: [],
  };
}
