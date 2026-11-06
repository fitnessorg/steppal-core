export type StepSource = "health_connect" | "pedometer" | "mock";

export interface StepClaim {
  userId: string;
  day: string; // YYYY-MM-DD
  steps: number;
  source: StepSource;
  rawSteps?: number;
  submittedAt: Date | string;
  deviceHash?: string;
}

export type AntiCheatFlag =
  | "VELOCITY_SPIKE"
  | "DEVICE_INCONSISTENCY"
  | "IMPLAUSIBLE_STEP_BURST"
  | "SOURCE_MISMATCH"
  | "DAILY_CAP_EXCEEDED"
  | "TIMESTAMP_ANOMALY"
  | "UNNATURAL_UNIFORMITY";

export interface AntiCheatRuleResult {
  ruleName: string;
  passed: boolean;
  penaltyScore: number; // 0.0 (clean) to 1.0 (severe violation)
  flags: AntiCheatFlag[];
  details?: string;
}

export interface UserAttestationEvaluation {
  userId: string;
  totalStepsClaimed: number;
  verifiedSteps: number;
  daysHit: number;
  daysPossible: number;
  metGoal: boolean;
  confidenceScore: number; // 0.0 to 1.0
  passedAntiCheat: boolean;
  ruleResults: AntiCheatRuleResult[];
  flags: AntiCheatFlag[];
  refusalReason?: string;
}

export interface PotEvaluationContext {
  potId: string;
  dailyGoal: number;
  startsOn: string;
  endsOn: string;
  totalDays: number;
  memberUserIds: string[];
  claims: StepClaim[];
}

export type AttestationAction = "attest" | "refuse" | "dispute";

export interface PotAttestationDecision {
  potId: string;
  action: AttestationAction;
  shouldStaySilent: boolean;
  attestedSteps: number; // passed into Soroban goal-escrow attest(id, steps)
  memberEvaluations: UserAttestationEvaluation[];
  decisionTimestamp: Date;
  summary: string;
}
