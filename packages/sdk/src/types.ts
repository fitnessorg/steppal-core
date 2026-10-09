/**
 * The wire shapes of the StepPal API.
 *
 * Hand-written rather than generated from OpenAPI, for one reason: this package
 * is consumed by a React Native app, and a generated client drags in a runtime
 * the Hermes engine would rather not carry. These are types only — they vanish
 * at build time — and the client below is a thin fetch wrapper.
 *
 * Keep them in step with packages/api/src/routes. The contract tests in
 * test/client.test.ts pin the paths and methods, not the field names, so a
 * rename here that the API did not make will surface in the app, not in CI.
 */

export type User = {
  id: string;
  phone: string;
  displayName: string;
  avatarSeed: string;
  dailyGoal: number;
};

export type Session = {
  accessToken: string;
  refreshToken: string;
  user: User;
};

export type PotStatus = "open" | "running" | "settled";

export type PotSummary = {
  id: string;
  name: string;
  inviteCode: string;
  dailyGoal: number;
  stakeKobo: number;
  startsOn: string;
  endsOn: string;
  status: PotStatus;
  memberCount: number;
};

export type MemberProgress = {
  userId: string;
  displayName: string;
  avatarSeed: string;
  daysHit: number;
  totalSteps: number;
  byDay: { day: string; steps: number; hit: boolean }[];
};

export type PotResult = {
  userId: string;
  daysHit: number;
  daysPossible: number;
  totalSteps: number;
  metGoal: boolean;
  payoutKobo: number;
};

export type PotDetail = PotSummary & {
  members: MemberProgress[];
  results?: PotResult[];
};

export type StepSource = "health_connect" | "pedometer" | "mock";

export type StepDay = { day: string; steps: number; source: string };

export type StepSubmissionResult = {
  accepted: number;
  clamped: number;
  rejected: { day: string; reason: string }[];
};

/** What the server said, with the status attached so callers can branch on it. */
export class StepPalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `${code} (${status})`);
    this.name = "StepPalError";
  }

  /** True when retrying with a fresh token could plausibly succeed. */
  get isAuthError() {
    return this.status === 401;
  }
}
