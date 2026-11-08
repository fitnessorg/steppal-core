# Contributor tasks

Every `TODO(contributor)` comment in this repo, collected as issue-ready
entries. Each one names the file it lives in and what "done" looks like.

Grep for them any time: `grep -rn "TODO(contributor)" packages contracts`.

If you start one, comment on the matching issue (or open one using the entry as
the body) so work does not collide.

---

## Good first issues

### Implement the Termii SMS provider [COMPLETED - Day 1]
**File:** `packages/api/src/lib/sms.ts` · **Difficulty:** medium

Implemented `createSmsProvider()` supporting both `SMS_PROVIDER=console` (default)
and `SMS_PROVIDER=termii` (POSTing to Termii's `/api/sms/send` with
`TERMII_API_KEY` and `TERMII_SENDER_ID`). Covered by unit tests in
`packages/api/test/sms.test.ts`.

### Expire consumed and stale OTP rows [COMPLETED - Day 1]
**File:** `packages/api/src/lib/otp.ts`, `packages/api/src/jobs/prune-otp.ts` · **Difficulty:** easy

Implemented `pruneStaleOtpCodes` and standalone scheduled job `pnpm prune:otp`
deleting `otp_codes` rows older than 30 days while retaining recent rows for
audit visibility. Covered by `packages/api/test/otp.test.ts`.

### Paginate the pot list [COMPLETED - Day 2]
**File:** `packages/api/src/routes/pots.ts`, `packages/sdk/src/index.ts` · **Difficulty:** easy

Added cursor pagination (`limit` 1..100, `cursor` ISO timestamp on `created_at`)
to `GET /v1/pots` and `listPots(params?)` in `@steppal/sdk` without breaking
existing callers. Covered by `packages/api/test/pots-pagination.test.ts` and
`packages/sdk/test/client.test.ts`.

---

## API

### Wire deposits and withdrawals to a payment provider [COMPLETED - Day 4]
**File:** `packages/api/src/lib/payments.ts` · **Difficulty:** hard

Payment provider interface implemented with `MockPaymentProvider` (default) and
`PaystackPaymentProvider` (sandbox/production) supporting collection (`initializeDeposit`,
`verifyDeposit`), webhook signature verification (HMAC-SHA512), and non-custodial
disbursements (`createTransferRecipient`, `initiateDisbursement`). Endpoints exposed
at `/v1/payments/*` with full unit test coverage.

### Build the oracle service [COMPLETED - Day 5]
**File:** `packages/oracle/` · **Difficulty:** hard

Implemented standalone `@steppal/oracle` service evaluating settled multi-day claims
against physical boundaries, cross-day velocity spikes, device consistency, and
synthetic uniformity. Includes Soroban RPC transaction signer and mock signer for
`attest(id, steps)`, with guaranteed silent oracle timeout fallback. Documented in
`docs/anti-cheat.md`.

### Connect settlement to the contract [COMPLETED - Day 6]
**File:** `packages/api/src/lib/settlement.ts`, `packages/api/src/lib/settlement-coordinator.ts`, `packages/api/src/lib/escrow.ts` · **Difficulty:** hard

Implemented two-phase crash-resilient settlement protocol (`intent_recorded` →
`chain_attested` → `finalized`) connecting `settlePot` to the Soroban
`goal-escrow` contract via `EscrowContractAdapter` (`MockEscrowAdapter` and
`SorobanEscrowAdapter`). Includes idempotent on-chain state reconciliation and
`pnpm settle:recover` job for interrupted settlements.

### Expose standings over websockets
**File:** `packages/api/src/routes/pots.ts` · **Difficulty:** medium

The app polls `GET /v1/pots/:id`. A pot is a group watching each other, and
polling makes it feel dead. Add a subscription that pushes a member's updated
standing when their steps land.

**Done when:** two clients in one pot see each other's progress without
refreshing.

---

## SDK

### Generate types from an OpenAPI schema
**File:** `packages/sdk/src/types.ts` · **Difficulty:** medium

Wire types are hand-written and kept in step with the routes by hand. Emit an
OpenAPI document from the Zod schemas the routes already carry, generate the
types from it, and the two can no longer drift.

Keep the client itself hand-written — React Native does not want a generated
runtime.

**Done when:** `pnpm --filter @steppal/sdk build` regenerates types from the
API's schema and a deliberate route change fails typecheck.

### Offline queue for step submissions [COMPLETED - Day 2]
**File:** `packages/sdk/src/index.ts` · **Difficulty:** medium

Implemented client-side offline step queue (`getStepQueue`, `queueSteps`,
`clearStepQueue`, `flushStepQueue`, `flushSteps`) with automatic queuing on
network connectivity failure, day-based deduplication, and idempotent replay on
reconnection. Covered by `packages/sdk/test/client.test.ts`.

---

## Contracts

### Integration tests against the deployed contract
**File:** `contracts/goal-escrow/` · **Difficulty:** medium

The 16 tests run in Soroban's test environment, and `SorobanEscrowAdapter` /
`SorobanRpcSigner` are tested against mocked Soroban JSON-RPC responses. An
optional live-testnet script or CI job can be added to fund, attest, and claim
against a live Stellar Testnet deployment.

**Done when:** a test suite funds, attests and claims against testnet.

### Extend coverage for storage archival [COMPLETED - Day 3]
**File:** `contracts/goal-escrow/src/test.rs` · **Difficulty:** hard

Added `storage_ttl_extended_on_write` advancing the ledger sequence across a
65-day window and proving `Persistent` and `Instance` storage TTLs survive and
re-extend to 90 days on contract write, alongside exact boundary tests for
funding deadlines, unattested refunds, and challenge windows.

---

## Documentation

### A setup guide that needs no Stellar account [COMPLETED - Day 7]
**File:** `docs/local-setup.md` · **Difficulty:** easy

Authored `docs/local-setup.md` detailing the component dependency matrix, zero-account
mock providers (`SMS_PROVIDER=console`, `PAYMENT_PROVIDER=mock`, `ESCROW_PROVIDER=mock`),
and how to run unit tests without PostgreSQL or Stellar CLI.

### Document the anti-cheat model [COMPLETED - Day 5 & Day 7]
**File:** `docs/anti-cheat.md` · **Difficulty:** medium

Authored `docs/anti-cheat.md` covering Layer 1 ingest sanitization, Layer 2
`@steppal/oracle` heuristics, Soroban challenge/refund fallback invariants, an
attack vector mitigation matrix, and an honest breakdown of residual risks and
hardware attestation roadmap items.
