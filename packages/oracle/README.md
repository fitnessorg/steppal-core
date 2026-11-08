# `@steppal/oracle`

Off-chain attestation evaluation service and Soroban transaction signer for the StepPal `goal-escrow` smart contract.

## Responsibilities

1. **Multi-Day Anti-Cheat Heuristics (`src/anti-cheat.ts`)**:
   - `checkPhysicalBoundaries`: Rejects daily step claims exceeding human physiological limits (50,000 steps/day) and flags clamped days (`DAILY_CAP_EXCEEDED`).
   - `checkCrossDayVelocity`: Detects abrupt multi-day spikes (`>4x` baseline and `>15,000` steps) and superhuman submission cadences (`>4.5` steps/sec).
   - `checkDeviceConsistency`: Flags sensor source downgrades (`mock` mixed with physical hardware sensors) and device hopping (`>2` device IDs in one window).
   - `checkStepUniformity`: Detects synthetic bot submissions repeating zero-variance step counts across 4+ days.
2. **Soroban Attestation Signing (`src/signer.ts`)**:
   - `MockSorobanSigner`: Deterministic in-memory signer for local development and tests.
   - `SorobanRpcSigner`: Submits signed `attest(id, steps)` transactions to Soroban RPC (`sendTransaction`).
3. **Silent Oracle Timeout Fallback (`src/service.ts`)**:
   - When critical anti-cheat flags are triggered, `OracleService` refuses to sign and sets `shouldStaySilent: true`, ensuring depositors can permissionlessly call `refund(id, funder)` once the contract `deadline` expires.
