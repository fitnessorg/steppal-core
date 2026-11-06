import { evaluateUserClaims } from "./anti-cheat.js";
import type { SorobanAttestationSigner, SignedAttestationResult } from "./signer.js";
import type {
  PotAttestationDecision,
  PotEvaluationContext,
  UserAttestationEvaluation,
} from "./types.js";

export interface OracleServiceOptions {
  signer: SorobanAttestationSigner;
  confidenceThreshold?: number;
}

export class OracleService {
  private readonly signer: SorobanAttestationSigner;
  private readonly confidenceThreshold: number;

  constructor(options: OracleServiceOptions) {
    this.signer = options.signer;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.7;
  }

  /**
   * Pure evaluation of pot claims against anti-cheat rules without sending on-chain transactions.
   */
  evaluatePot(context: PotEvaluationContext): PotAttestationDecision {
    const memberEvaluations: UserAttestationEvaluation[] = [];

    for (const userId of context.memberUserIds) {
      const userClaims = context.claims.filter((c) => c.userId === userId);
      const evalResult = evaluateUserClaims(userId, userClaims, {
        dailyGoal: context.dailyGoal,
        totalDays: context.totalDays,
        confidenceThreshold: this.confidenceThreshold,
      });
      memberEvaluations.push(evalResult);
    }

    const failedMembers = memberEvaluations.filter((m) => !m.passedAntiCheat);
    const criticalViolations = memberEvaluations.filter((m) =>
      m.flags.includes("IMPLAUSIBLE_STEP_BURST"),
    );

    // If critical physical boundaries or bot farms are detected, oracle stays silent
    if (criticalViolations.length > 0) {
      return {
        potId: context.potId,
        action: "refuse",
        shouldStaySilent: true,
        attestedSteps: 0,
        memberEvaluations,
        decisionTimestamp: new Date(),
        summary: `Oracle staying silent: critical anti-cheat violation detected for ${criticalViolations.length} user(s). Escrow will refund on deadline.`,
      };
    }

    // Calculate aggregate attested steps for winning legitimate participants
    let totalAttestedSteps = 0;
    for (const member of memberEvaluations) {
      if (member.passedAntiCheat) {
        totalAttestedSteps += member.verifiedSteps;
      }
    }

    const allPassed = failedMembers.length === 0;
    const summary = allPassed
      ? `All ${memberEvaluations.length} members passed anti-cheat; aggregate ${totalAttestedSteps} steps verified.`
      : `${failedMembers.length} member(s) failed anti-cheat verification.`;

    return {
      potId: context.potId,
      action: "attest",
      shouldStaySilent: false,
      attestedSteps: totalAttestedSteps,
      memberEvaluations,
      decisionTimestamp: new Date(),
      summary,
    };
  }

  /**
   * Evaluates pot claims and dispatches on-chain attestation if valid.
   * If anti-cheat determines severe fraud or zero confidence, the oracle stays silent,
   * deliberately permitting the escrow contract's deadline mechanism to protect funder deposits.
   */
  async evaluateAndAttest(
    context: PotEvaluationContext,
    goalId: number,
  ): Promise<{
    decision: PotAttestationDecision;
    attestationResult?: SignedAttestationResult;
  }> {
    const decision = this.evaluatePot(context);

    if (decision.shouldStaySilent || decision.action === "refuse") {
      return { decision };
    }

    const attestationResult = await this.signer.signAndSubmitAttestation(
      goalId,
      decision.attestedSteps,
    );

    return {
      decision,
      attestationResult,
    };
  }
}
