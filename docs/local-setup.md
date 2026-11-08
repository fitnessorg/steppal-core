# Local Setup Guide (No Stellar or Third-Party Accounts Required)

You do **not** need a Stellar account, the Rust/Soroban toolchain, a Termii SMS account, or a Paystack merchant account to run, develop, or test the StepPal API, Oracle, or TypeScript SDK locally.

Every external dependency in `steppal-core` defaults to an in-memory or console-backed local implementation so you can fix a route, write an SDK feature, or test settlement rules from a fresh clone in under two minutes.

---

## What Needs What?

Use this matrix to install only the tools required for the part of the codebase you are touching:

| Task / Area | Node 20+ & `pnpm` | PostgreSQL 16 (Docker or local) | Rust + `wasm32v1-none` | Stellar CLI / Testnet Account | External API Keys (Termii / Paystack) |
| --- | :---: | :---: | :---: | :---: | :---: |
| `@steppal/sdk` development & tests | **Yes** | No | No | No | No |
| `@steppal/oracle` development & tests | **Yes** | No | No | No | No |
| `@steppal/api` pure unit & route mock tests | **Yes** | No | No | No | No |
| `@steppal/api` local dev server & DB integration tests | **Yes** | **Yes** | No | No | No |
| `contracts/goal-escrow` Rust unit tests (`cargo test`) | No | No | **Yes** | No | No |
| Deploying `goal-escrow` to Stellar Testnet | No | No | **Yes** | **Yes** | No |

---

## Quick Start (API + SDK + Oracle)

### 1. Install Dependencies

Requires **Node.js >= 20** and **pnpm >= 9**:

```bash
git clone https://github.com/fitnessorg/steppal-core
cd steppal-core
pnpm install
```

### 2. Configure Environment

Copy the example environment file:

```bash
cp packages/api/.env.example packages/api/.env
```

The default `.env` values are pre-configured for zero-account local development:

```dotenv
DATABASE_URL=postgres://steppal:steppal@localhost:5432/steppal
JWT_SECRET=dev-secret-change-me-at-least-32-chars-long
PORT=3000
SMS_PROVIDER=console
PAYMENT_PROVIDER=mock
ESCROW_PROVIDER=mock
```

### 3. Start PostgreSQL and Migrate

If you have Docker installed, start the bundled Postgres 16 container from the repo root:

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

Start the API server in watch mode:

```bash
pnpm dev
```

Verify the server is live:

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"0.1.0"}
```

---

## Working with Local Mock Providers

All external side effects are abstracted behind provider interfaces that default to local implementations.

### 1. SMS Authentication (`SMS_PROVIDER=console`)

Instead of calling Termii, the console SMS provider prints the 6-digit OTP directly to your terminal stdout:

```bash
curl -X POST http://localhost:3000/v1/auth/request-code \
  -H 'content-type: application/json' \
  -d '{"phone":"08031234567"}'
```

Check your `pnpm dev` terminal output:

```text
[sms:console] -> +2348031234567: 418245 is your StepPal code.
```

Exchange that code for an access and refresh token pair:

```bash
curl -X POST http://localhost:3000/v1/auth/verify-code \
  -H 'content-type: application/json' \
  -d '{"phone":"08031234567","code":"418245","displayName":"Ada"}'
```

### 2. Payments & NUBAN Disbursements (`PAYMENT_PROVIDER=mock`)

`MockPaymentProvider` (`packages/api/src/lib/payments.ts`) simulates Paystack checkout initialization, transaction verification, NUBAN transfer recipient creation, and HMAC-SHA512 webhook verification in memory:

- `POST /v1/payments/initialize` returns a deterministic sandbox URL (`https://checkout.steppal.local/pay/<reference>`) and records a pending deposit in memory.
- `GET /v1/payments/verify/:reference` returns the simulated transaction status.
- `POST /v1/payments/disburse` validates the 10-digit Nigerian NUBAN check digit and returns a mock transfer receipt without touching any banking rails.

### 3. On-Chain Escrow & Settlement (`ESCROW_PROVIDER=mock`)

`MockEscrowAdapter` (`packages/api/src/lib/escrow.ts`) mirrors the state machine of the Soroban `goal-escrow` contract (`Funding -> Attested -> Completed / Refunding`) inside Node memory:

- Running `pnpm settle` or `pnpm settle:recover` executes the full two-phase settlement coordinator (`intent_recorded -> chain_attested -> finalized`) against `MockEscrowAdapter` by default.
- No Soroban RPC node, funded keypair, or Stellar network connection is required.

---

## Running Tests (With or Without PostgreSQL)

### 1. Zero-Database Unit & Mock Tests

If you do not have Docker or PostgreSQL running, you can still run all SDK tests, Oracle tests, and API unit/mock tests:

```bash
# Run SDK test suite (no database required)
pnpm --filter @steppal/sdk test

# Run Oracle anti-cheat & signer test suite (no database required)
pnpm --filter @steppal/oracle test

# Run API unit and injected route tests (no database required)
pnpm --filter @steppal/api test \
  test/phone.test.ts \
  test/sms.test.ts \
  test/otp.test.ts \
  test/pots-pagination.test.ts \
  test/payments.test.ts \
  test/settlement-pure.test.ts \
  test/escrow.test.ts \
  test/settlement-coordinator.test.ts
```

### 2. Full Database Integration Tests

The API database integration suites (`test/auth.test.ts`, `test/pots.test.ts`, `test/steps.test.ts`, `test/settlement.test.ts`) verify database constraints, unique indexes, and transactions against a live PostgreSQL instance:

```bash
docker compose up -d
pnpm db:migrate
pnpm test
```

---

## Optional: Soroban Smart Contract Setup

You only need the Rust toolchain if you are editing `contracts/goal-escrow/`.

### 1. Run Contract Unit Tests (No Stellar Account or Network Required)

`goal-escrow` uses `soroban-sdk` testutils to simulate the ledger, token contracts, timestamps, and storage TTL archival entirely in-process:

```bash
rustup target add wasm32v1-none
cd contracts && cargo test
```

### 2. Deploy to Stellar Testnet (Only for Contract Deployment)

If you want to deploy your own instance of `goal-escrow` to Stellar Testnet:

1. Install the [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started).
2. Generate and fund a testnet identity:
   ```bash
   stellar keys generate dev --network testnet --fund
   ```
3. Run the deployment script:
   ```bash
   bash scripts/deploy-testnet.sh dev
   ```
4. Set `ESCROW_PROVIDER=soroban` and paste the resulting contract ID into `GOAL_ESCROW_CONTRACT_ID` in `packages/api/.env`.
