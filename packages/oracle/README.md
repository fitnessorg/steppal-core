# `@steppal/oracle`

Off-chain attestation evaluation service and Soroban transaction signer for the StepPal `goal-escrow` smart contract.

## Responsibilities

1. **Multi-Day Anti-Cheat Heuristics (`src/anti-cheat.ts`)**:
   - `checkPhysicalBoundaries`: Rejects daily step claims exceeding human physiological limits (50,000 steps/day) and flags clamped days (`DAILY_CAP_EXCEEDED`).
   - `checkCrossDayVelocity`: Detects abrupt day-over-day spikes (more than 6x, to at least 10,000 steps) and superhuman submission cadences (`>4.5` steps/sec).
   - `checkDeviceConsistency`: Flags `mock` sources mixed with physical sensors and device hash proliferation (more than 3 hashes within 7 days).
   - `checkStepUniformity`: Detects synthetic submissions repeating one identical count across 4+ days.
2. **Soroban Attestation Signing (`src/signer.ts`)**:
   - `MockSorobanSigner`: Deterministic in-memory signer for local development and tests.
   - `SorobanRpcSigner`: Submits signed `attest(id, steps)` transactions to Soroban RPC (`sendTransaction`).
3. **Silent Oracle Timeout Fallback (`src/service.ts`)**:
   - When critical anti-cheat flags are triggered, `OracleService` refuses to sign and sets `shouldStaySilent: true`, ensuring depositors can permissionlessly call `refund(id, funder)` once the contract `deadline` expires.
