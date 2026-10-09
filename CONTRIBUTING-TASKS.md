# Contributor tasks

Every `TODO(contributor)` comment in this repo, collected as issue-ready
entries. Each one names the file it lives in and what "done" looks like.

Grep for them any time: `grep -rn "TODO(contributor)" packages contracts`.

If you start one, comment on the matching issue (or open one using the entry as
the body) so work does not collide.

---

## Good first issues

### Implement the Termii SMS provider
**File:** `packages/api/src/lib/sms.ts` · **Difficulty:** medium

The console provider logs codes instead of sending them, which is what keeps
the repo runnable with no accounts. Add the real one: POST to Termii's
`/api/sms/send`, map a non-2xx to a thrown error, and add `TERMII_API_KEY` and
`TERMII_SENDER_ID` to `lib/env.ts`.

Keep the interface, and keep console as the default — a contributor must never
need an SMS account to run the tests.

**Done when:** `SMS_PROVIDER=termii` delivers a real code, and the suite still
passes with no Termii credentials present.

### Expire consumed and stale OTP rows
**File:** `packages/api/src/routes/auth.ts` · **Difficulty:** easy

`otp_codes` grows forever. Rows are kept after use on purpose — a burst of
requests to one number should be visible — but not indefinitely. Add a job (or
extend `src/jobs/`) that deletes rows older than 30 days.

**Done when:** a scheduled task prunes them, and a test proves a recent row
survives while an old one does not.

### Paginate the pot list
**File:** `packages/api/src/routes/pots.ts` · **Difficulty:** easy

`GET /v1/pots` returns everything. Fine at ten pots, not at two hundred. Add
cursor pagination on `created_at`, and the matching parameter to the SDK.

**Done when:** the endpoint accepts `limit` and `cursor`, and the SDK exposes
them without breaking existing callers.

---

## API

### Wire deposits and withdrawals to a payment provider
**File:** `packages/api/src/lib/` (new) · **Difficulty:** hard

`PAYMENT_PROVIDER` and the mock exist; the real one does not. The hard half is
not collection — every Nigerian provider does that — it is **disbursement**:
paying a winner who is not the merchant. Check that the provider you pick has a
transfer/recipient API before writing a line.

StepPal must never hold user funds on its own balance sheet. Money moves from
the payer to the escrow and from the escrow to the winner; the service
instructs, it does not custody.

**Done when:** a pot with a non-zero stake can be funded and settled end to
end against the provider's sandbox, with the mock provider still the default.

### Build the oracle service
**File:** new package · **Difficulty:** hard

The contract's `attest(id, steps)` is oracle-only. Nothing currently signs
those attestations. The service reads settled `step_days`, applies the
anti-cheat rules that need full history (velocity across days, device
consistency, distance cross-checks — none of which belong in the per-write
ingest path), and submits a signed attestation.

It must be able to stay silent. The contract's deadline exists precisely so
that a silent oracle cannot trap anyone's money.

**Done when:** a finished pot on testnet pays out from an attestation this
service signed, and a goal it refuses to attest refunds on deadline.

### Connect settlement to the contract
**File:** `packages/api/src/lib/settlement.ts` · **Difficulty:** hard

Settlement computes payouts and writes `pot_results`. It does not touch the
chain. Once stakes are non-zero, `settlePot` should instruct `goal-escrow`
rather than only recording an intention.

The ordering is the whole problem: write the result first and the chain call
may fail; call the chain first and the process may die before recording it.
Make it recoverable either way.

**Done when:** a staked pot settles on testnet, and killing the process
mid-settlement leaves a state the next run can finish.

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

### Offline queue for step submissions
**File:** `packages/sdk/src/index.ts` · **Difficulty:** medium

`submitSteps` throws when the network is down, and the steps are lost. Queue
them and flush on reconnect. The endpoint is already idempotent on
`(user, day)`, so replaying a queue is safe by construction.

**Done when:** steps submitted offline arrive after reconnection, and a
duplicate flush changes nothing.

---

## Contracts

### Integration tests against the deployed contract
**File:** `contracts/goal-escrow/` · **Difficulty:** medium

The 12 tests run in Soroban's test environment. None exercise the deployed
contract from TypeScript, which is the path the API will actually use.

**Done when:** a test suite funds, attests and claims against testnet.

### Extend coverage for storage archival
**File:** `contracts/goal-escrow/src/test.rs` · **Difficulty:** hard

`bump()` extends storage TTL on every write because Soroban archives untouched
storage. No test proves a goal left alone for a long window is still claimable.

**Done when:** a test advances the ledger past the TTL and shows the goal
survives.

---

## Documentation

### A setup guide that needs no Stellar account
**File:** `docs/` · **Difficulty:** easy

The API runs with no chain access at all. Say so explicitly and show which
parts need what, so a contributor does not install the Stellar toolchain to fix
a route.

### Document the anti-cheat model
**File:** `docs/` · **Difficulty:** medium

Rules are spread across `lib/steps.ts`, the contract's challenge window and the
unwritten oracle. Collect them, and be honest about what is not defended yet.
A threat model that only lists wins is not a threat model.
