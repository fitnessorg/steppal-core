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
