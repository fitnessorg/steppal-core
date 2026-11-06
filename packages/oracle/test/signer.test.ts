import { describe, it, expect } from "vitest";
import { MockSorobanSigner, SorobanRpcSigner } from "../src/signer.js";

describe("Soroban attestation signers", () => {
  describe("MockSorobanSigner", () => {
    it("signs and records attestations with confirmed status", async () => {
      const signer = new MockSorobanSigner({
        oracleAddress: "G_TEST_ORACLE",
        contractAddress: "C_TEST_ESCROW",
      });

      const result = await signer.signAndSubmitAttestation(42, 65000);

      expect(result.goalId).toBe(42);
      expect(result.steps).toBe(65000);
      expect(result.oracleAddress).toBe("G_TEST_ORACLE");
      expect(result.contractAddress).toBe("C_TEST_ESCROW");
      expect(result.status).toBe("confirmed");
      expect(result.transactionHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(signer.signedAttestations).toHaveLength(1);
    });

    it("throws error when configured to simulate network failure", async () => {
      const signer = new MockSorobanSigner({ shouldFail: true });
      await expect(signer.signAndSubmitAttestation(1, 10000)).rejects.toThrow(
        "Mock Soroban RPC rejected transaction for goal 1",
      );
    });
  });

  describe("SorobanRpcSigner", () => {
    it("throws when oracleSecretKey is missing", async () => {
      const signer = new SorobanRpcSigner({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractAddress: "C_CONTRACT",
        oracleAddress: "G_ORACLE",
        oracleSecretKey: "",
      });

      await expect(signer.signAndSubmitAttestation(1, 5000)).rejects.toThrow(
        "oracleSecretKey is missing",
      );
    });

    it("submits signed transaction envelope to Soroban RPC endpoint", async () => {
      let interceptedUrl = "";
      let interceptedBody: unknown;

      const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        interceptedUrl = url.toString();
        interceptedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: {
              status: "PENDING",
              hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            },
          }),
        } as Response;
      }) as typeof fetch;

      const signer = new SorobanRpcSigner({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractAddress: "CA_GOAL_ESCROW_123",
        oracleAddress: "GA_ORACLE_SIGNER_456",
        oracleSecretKey: "S_TEST_SECRET_KEY_789",
        fetchFn: mockFetch,
      });

      const result = await signer.signAndSubmitAttestation(10, 72000);

      expect(interceptedUrl).toBe("https://soroban-testnet.stellar.org");
      expect((interceptedBody as { method: string }).method).toBe("sendTransaction");
      expect(result.goalId).toBe(10);
      expect(result.steps).toBe(72000);
      expect(result.transactionHash).toBe(
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      );
      expect(result.status).toBe("submitted");
    });

    it("throws descriptive error when Soroban RPC returns error object", async () => {
      const mockFetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Transaction simulation failed" },
          }),
        } as Response;
      }) as typeof fetch;

      const signer = new SorobanRpcSigner({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractAddress: "CA_ESCROW",
        oracleAddress: "GA_ORACLE",
        oracleSecretKey: "S_SECRET",
        fetchFn: mockFetch,
      });

      await expect(signer.signAndSubmitAttestation(5, 50000)).rejects.toThrow(
        "Soroban RPC error [-32600]: Transaction simulation failed",
      );
    });
  });
});
