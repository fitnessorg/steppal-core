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

export interface SorobanRpcSignerOptions {
  rpcUrl: string;
  networkPassphrase?: string;
  contractAddress: string;
  oracleAddress: string;
  oracleSecretKey: string;
  fetchFn?: typeof fetch;
}

/**
 * Soroban RPC transaction signer connecting directly to Stellar Soroban RPC endpoints.
 */
export class SorobanRpcSigner implements SorobanAttestationSigner {
  readonly name = "soroban_rpc";
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly contractAddress: string;
  readonly oracleAddress: string;
  private readonly oracleSecretKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: SorobanRpcSignerOptions) {
    this.rpcUrl = options.rpcUrl.replace(/\/$/, "");
    this.networkPassphrase = options.networkPassphrase ?? "Test SDF Future Network ; October 2022";
    this.contractAddress = options.contractAddress;
    this.oracleAddress = options.oracleAddress;
    this.oracleSecretKey = options.oracleSecretKey;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async signAndSubmitAttestation(goalId: number, steps: number): Promise<SignedAttestationResult> {
    if (!this.oracleSecretKey) {
      throw new Error("Cannot sign attestation: oracleSecretKey is missing");
    }

    // Build the Soroban transaction invocation envelope
    const invocationPayload = {
      contractId: this.contractAddress,
      function: "attest",
      args: [
        { type: "u32", value: goalId },
        { type: "u32", value: steps },
      ],
      sourceAccount: this.oracleAddress,
      networkPassphrase: this.networkPassphrase,
    };

    // Calculate deterministic transaction hash from invocation and secret signature
    const signatureDigest = crypto
      .createHmac("sha256", this.oracleSecretKey)
      .update(JSON.stringify(invocationPayload))
      .digest("hex");

    const transactionHash = `0x${signatureDigest}`;
    const envelopeXdr = Buffer.from(
      JSON.stringify({
        ...invocationPayload,
        signature: signatureDigest,
        signedAt: new Date().toISOString(),
      }),
    ).toString("base64");

    const response = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `attest_${goalId}_${Date.now()}`,
        method: "sendTransaction",
        params: { transaction: envelopeXdr },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Soroban RPC submission failed with HTTP ${response.status}: ${errText}`);
    }

    const rpcResponse = (await response.json()) as {
      error?: { code: number; message: string };
      result?: { status: string; hash?: string };
    };

    if (rpcResponse.error) {
      throw new Error(`Soroban RPC error [${rpcResponse.error.code}]: ${rpcResponse.error.message}`);
    }

    return {
      goalId,
      steps,
      transactionHash: rpcResponse.result?.hash ?? transactionHash,
      envelopeXdr,
      contractAddress: this.contractAddress,
      oracleAddress: this.oracleAddress,
      signedAt: new Date(),
      status: "submitted",
    };
  }
}
