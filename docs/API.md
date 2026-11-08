# StepPal API

Base URL in development: `http://localhost:3000`

All endpoints return JSON. Authenticated endpoints expect
`Authorization: Bearer <accessToken>`; a missing or invalid token is `401`,
never `500`.

Money is in **kobo** throughout, as integers. Days are **local calendar dates**
written `YYYY-MM-DD`, never timestamps — a step belongs to the day the walker
lived, not to a UTC window.

## Auth

Phone numbers are normalised to E.164 before anything is stored, so
`08031234567`, `+234 803 123 4567` and `234-803-123-4567` are one account.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/request-code` | — | Send a six-digit code by SMS |
| POST | `/v1/auth/verify-code` | — | Exchange the code for a session, creating the account on first use |
| POST | `/v1/auth/refresh` | — | Rotate the refresh token for a new pair |
| POST | `/v1/auth/logout` | — | Revoke one device's refresh token |
| GET | `/v1/me` | yes | The signed-in user |
| PATCH | `/v1/me` | yes | Change display name or personal daily goal |

**`POST /v1/auth/request-code`** — `{ phone }` → `{ ok: true, expiresInSeconds }`

Always `200` for a well-formed number, whether or not an account exists.
Answering differently would turn this endpoint into a way to discover who is
registered. `400` only for a number that cannot be parsed, `429` after five
requests to one number in an hour.

**`POST /v1/auth/verify-code`** — `{ phone, code, displayName? }` → `{ accessToken, refreshToken, user }`

Every failure is `401 invalid_code`. Expired, wrong, already-used and
never-issued are deliberately indistinguishable. Five wrong attempts burn the
code.

**`POST /v1/auth/refresh`** — `{ refreshToken }` → `{ accessToken, refreshToken }`

The presented token is revoked as it is accepted. A token used twice finds
nothing the second time, which is what makes theft detectable.

## Pots

A pot is a week-long commitment between 2 and 20 friends. `stakeKobo` is `0`
for the money-free launch; the column exists so enabling money is a value
change rather than a migration.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/pots` | yes | Create a pot and join it |
| GET | `/v1/pots` | yes | Pots you are in, newest first |
| GET | `/v1/pots/by-code/:code` | yes | Look a pot up without joining |
| POST | `/v1/pots/join` | yes | Join by invite code |
| GET | `/v1/pots/:id` | yes | Standings, and results once settled |
| POST | `/v1/pots/:id/leave` | yes | Leave, before it starts |

**`POST /v1/pots`** — `{ name, dailyGoal?, stakeKobo?, startsOn?, days? }` → `201 PotSummary`

Pot and creator membership are inserted in one transaction, so a pot with no
members cannot exist. The invite code is derived from the name — "Ikeja Early
Birds" becomes `IKEJ-2290` — so it is recognisable in a group chat with three
pots in it. Collisions retry against a unique index rather than being assumed
away.

**`GET /v1/pots`** — `?limit=50&cursor=2026-11-05T...` → `200 PotSummary[]`

Pots you are in, ordered newest first by `createdAt`. Supports cursor-based
pagination via `limit` (integer 1..100, default 50) and `cursor` (ISO timestamp
of the last seen pot's `createdAt`). When `cursor` is provided, returns pots
created strictly before that timestamp. Omitting parameters returns the first page.

**`GET /v1/pots/by-code/:code`** — accepts what a human types: lowercase, no
dash, stray spaces. Lets the app show "Ikeja Early Birds, 4 people" before
asking anyone to commit.

**`POST /v1/pots/join`** — `{ code }` → `PotSummary`

- `404 not_found` — no pot with that code
- `409 pot_settled` — it is over
- `409 pot_already_started` — joining late would mean competing on fewer days
- `409 pot_full` — 20 members

Joining a pot you are already in is a `200`, not an error. A double tap is not
a mistake worth punishing.

**`GET /v1/pots/:id`** — membership is the authorisation. Standings name
people, so holding the id is not enough; a non-member gets `403`.

**`POST /v1/pots/:id/leave`** — only before the pot starts (`409` after).
Otherwise anyone losing could walk away, and the commitment is gone.
Membership is timestamped rather than deleted, so the record survives.

## Steps

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/steps` | yes | Submit up to 31 days |
| GET | `/v1/steps` | yes | Read back what the server believes |

**`POST /v1/steps`** — `{ days: [{ day, steps, source }] }` → `{ accepted, clamped, rejected }`

The phone reports; the server decides. Three rules:

- **A future day is rejected.** Nobody has walked tomorrow, and accepting it
  would let a wrong clock bank a week ahead.
- **A day older than eight is rejected.** Backfill is for a phone that was
  offline, not for topping up a pot about to settle.
- **A count above `DAILY_STEP_CAP` (25,000) is clamped, not rejected**, and the
  original is kept in `raw_steps`. Clamping keeps an honest person with a
  pedometer glitch in the game while removing the benefit of shaking a phone
  for an hour, and the raw number means a reviewer can see what was claimed.

Writes are idempotent on `(user, day)`. Phones retry — on a flaky connection
they retry a lot — so a submission endpoint that is not idempotent is a
settlement bug waiting for a bad week of network.

Rejected days come back named, so the app can tell a user their clock is wrong
instead of quietly losing their steps.

## Payments

StepPal operates under a non-custodial abstraction: money moves from the payer
to the escrow and from escrow to the winner; StepPal instructs, it never
custodies funds on its own balance sheet.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/payments/initialize` | yes | Initiate a stake deposit checkout flow |
| GET | `/v1/payments/verify/:reference` | yes | Check status of a deposit transaction |
| POST | `/v1/payments/disburse` | yes | Instruct winner payout transfer to NUBAN account |
| POST | `/v1/payments/webhook` | — | Receive provider payment/transfer webhooks |

**`POST /v1/payments/initialize`** — `{ potId, amountKobo?, callbackUrl? }` → `{ reference, authorizationUrl, accessCode?, status }`

Initiates collection with the active provider. When using `PAYMENT_PROVIDER=mock`,
instantly generates a sandbox authorization URL and logs to in-memory state.
When using `PAYMENT_PROVIDER=paystack`, creates a transaction via Paystack's
`/transaction/initialize` API.

**`GET /v1/payments/verify/:reference`** — `200 { reference, status, amountKobo, currency, paidAt? }`

Queries transaction status directly from the provider. Statuses are normalized
to `pending`, `success`, `abandoned`, or `failed`.

**`POST /v1/payments/disburse`** — `{ recipientName, accountNumber, bankCode, amountKobo, potId?, reason? }` → `{ ok: true, reference, transferCode, status, amountKobo }`

Creates or resolves a transfer recipient (e.g. Paystack `/transferrecipient`)
and instructs an automated disbursement transfer to the winner's Nigerian bank
account. Account numbers must conform to 10-digit NUBAN standards validated via
the Central Bank of Nigeria (CBN) modulus-10 check digit algorithm.

**`POST /v1/payments/webhook`** — unauthenticated provider webhook receiver.
Verifies `x-paystack-signature` (HMAC-SHA512) against provider secret using
constant-time byte comparison (`crypto.timingSafeEqual`); rejected with
`401 invalid_signature` on tampered or missing signatures. Processes typed
events including `charge.success`, `transfer.success`, and `transfer.failed`.
Payment references follow the namespaced format `{prefix}_{potId}_{userId}_{nonce}`
with cryptographically random nonces guaranteeing replay protection.

## Settlement

Not an endpoint. `pnpm settle` runs `src/jobs/settle.ts`, intended for a daily
scheduler, and is safe to run as often as you like.

**The rule is not "most steps wins."** Most steps rewards whoever has the most
free time, which in a group of friends is the same person every week, and the
rest stop playing. Instead every member is judged against the same daily goal:
hit it *every day* of the window and you win. Everyone can win; everyone can
lose.

The forfeited stakes are split evenly among the winners. Integer kobo only —
the remainder from an uneven split goes to whoever walked the most, because it
has to go somewhere and money that silently vanishes is how a settlement loses
trust. **When nobody wins, stakes are returned**, never kept: StepPal does not
profit from a member failing, which matters ethically and keeps the product
clear of looking like a house taking a rake.

A pot settles the day *after* it ends, so the final day's steps have a full
night to sync from a phone that was asleep. Settling an already-settled pot
writes nothing and returns the stored result — the job will be retried, and
double-paying is unforgivable.

### Two-Phase On-Chain Settlement (`stakeKobo > 0`)

When a pot has a non-zero stake (`stakeKobo > 0`), `settlePot` uses the
`TwoPhaseSettlementCoordinator` (`src/lib/settlement-coordinator.ts`) to bridge
PostgreSQL persistence and the Soroban `goal-escrow` smart contract without
risking orphaned payouts or double-attestation on process crash:

1. **Phase 1 (`intent_recorded`)** — Computes the deterministic payout table
   (`computeSettlementPayouts`) and persists the settlement intent before making
   any external RPC call.
2. **Phase 2 (`chain_attested`)** — Invokes the `EscrowContractAdapter`
   (`MockEscrowAdapter` in local dev, `SorobanEscrowAdapter` on testnet/mainnet)
   to submit `attest(id, steps)` and records the on-chain transaction hash. If
   the process crashes after the chain transaction lands but before Phase 2
   finishes recording, the next run inspects `getGoal(goalId)` on-chain to
   reconcile state idempotently without re-attesting.
3. **Phase 3 (`finalized`)** — Writes the final `pot_results` and marks the pot
   `settled_at` in PostgreSQL.

Any interrupted settlement left in `intent_recorded` or `chain_attested` can be
resumed via `pnpm settle:recover` (`src/jobs/recover-settlements.ts`).

### Background Jobs

| Command | Script | Purpose |
| --- | --- | --- |
| `pnpm settle` | `src/jobs/settle.ts` | Settle all pots whose window ended before today |
| `pnpm settle:recover` | `src/jobs/recover-settlements.ts` | Reconcile and finalize any interrupted two-phase settlements |
| `pnpm prune:otp` | `src/jobs/prune-otp.ts` | Prune consumed and expired `otp_codes` rows older than 30 days |

## Errors

```json
{ "error": "pot_already_started" }
```

Stable machine-readable codes, not prose. The SDK surfaces them as
`StepPalError { status, code }`.

## Environment

See `.env.example` and [docs/local-setup.md](./local-setup.md). Every external
integration is controlled by a provider flag that defaults to a local mock:

- **`SMS_PROVIDER=console`** (default) or **`termii`** — `console` logs OTP
  codes to stdout so auth works with no SMS account; `termii` dispatches via
  Termii's `/api/sms/send` endpoint using `TERMII_API_KEY` and `TERMII_SENDER_ID`.
- **`PAYMENT_PROVIDER=mock`** (default) or **`paystack`** — `mock` runs an
  in-memory checkout and disbursement simulator; `paystack` connects to Paystack
  for collection, HMAC-SHA512 webhooks, and NUBAN bank transfers.
- **`ESCROW_PROVIDER=mock`** (default) or **`soroban`** — `mock` runs an
  in-memory `goal-escrow` contract state machine; `soroban` submits signed
  transactions to `SOROBAN_RPC_URL` targeting `GOAL_ESCROW_CONTRACT_ID`.
