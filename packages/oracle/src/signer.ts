import crypto from "node:crypto";

export interface AttestationTransactionPayload {
  goalId: number;
  steps: number;
  contractAddress: string;
  oracleAddress: string;
}

export interface SignedAttestationResult {
  goalId: number;
  steps: number;
  transactionHash: string;
  envelopeXdr: string;
  contractAddress: string;
  oracleAddress: string;
  signedAt: Date;
  status: "submitted" | "confirmed" | "failed";
}

export interface SorobanAttestationSigner {
  readonly name: string;
  readonly oracleAddress: string;
  readonly contractAddress: string;
  signAndSubmitAttestation(goalId: number, steps: number): Promise<SignedAttestationResult>;
}

export interface MockSignerOptions {
  oracleAddress?: string;
  contractAddress?: string;
  shouldFail?: boolean;
}

/**
 * In-memory Mock Soroban signer for isolated local testing without a live Stellar RPC node.
 */
export class MockSorobanSigner implements SorobanAttestationSigner {
  readonly name = "mock";
  readonly oracleAddress: string;
  readonly contractAddress: string;
  private readonly shouldFail: boolean;

  readonly signedAttestations: SignedAttestationResult[] = [];

  constructor(options: MockSignerOptions = {}) {
    this.oracleAddress = options.oracleAddress ?? "GAORACLE_MOCK_TESTNET_ADDRESS_KEY";
    this.contractAddress = options.contractAddress ?? "CAESCROW_MOCK_CONTRACT_ADDRESS_KEY";
    this.shouldFail = options.shouldFail ?? false;
  }

  async signAndSubmitAttestation(goalId: number, steps: number): Promise<SignedAttestationResult> {
    if (this.shouldFail) {
      throw new Error(`Mock Soroban RPC rejected transaction for goal ${goalId}`);
    }

    const nonce = crypto.randomBytes(8).toString("hex");
    const transactionHash = `0x${crypto.createHash("sha256").update(`soroban:attest:${goalId}:${steps}:${nonce}`).digest("hex")}`;
    const envelopeXdr = Buffer.from(
      JSON.stringify({
        contract: this.contractAddress,
        function: "attest",
        args: [goalId, steps],
        oracle: this.oracleAddress,
        hash: transactionHash,
      }),
    ).toString("base64");

    const result: SignedAttestationResult = {
      goalId,
      steps,
      transactionHash,
      envelopeXdr,
      contractAddress: this.contractAddress,
      oracleAddress: this.oracleAddress,
      signedAt: new Date(),
      status: "confirmed",
    };

    this.signedAttestations.push(result);
    return result;
  }
}
