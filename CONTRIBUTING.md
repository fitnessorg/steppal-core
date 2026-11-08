# Contributing to StepPal Core

Thank you for your interest in contributing to `steppal-core`. This repository contains the HTTP API (`@steppal/api`), the off-chain attestation oracle (`@steppal/oracle`), the TypeScript client SDK (`@steppal/sdk`), and the Soroban smart contract (`contracts/goal-escrow`).

---

## Where to Start

1. Read [docs/local-setup.md](./docs/local-setup.md) — you do **not** need a Stellar account, Termii account, or Paystack account to run the project or its test suites locally.
2. Browse [CONTRIBUTING-TASKS.md](./CONTRIBUTING-TASKS.md) for scoped tasks across the API, SDK, Contracts, and Documentation.
3. Read [docs/API.md](./docs/API.md) and [docs/anti-cheat.md](./docs/anti-cheat.md) to understand the domain invariants before changing route or settlement behavior.

---

## Core Invariants to Preserve

- **Zero-Account Default**: Every external integration (`SMS_PROVIDER`, `PAYMENT_PROVIDER`, `ESCROW_PROVIDER`) must default to a local mock/console implementation so a fresh clone passes tests without third-party credentials.
- **Money in Integer Kobo**: Never use floating-point math for money or payout splits. Remainders from uneven splits go to the winner with the highest step count.
- **Local Calendar Dates (`YYYY-MM-DD`)**: Steps and pot windows are calendar days in the walker's local timezone, never UTC timestamps.
- **Append-Only Audit Trail**: Do not hard-delete pots, memberships, or refresh tokens; mark state transitions with timestamps (`left_at`, `revoked_at`, `settled_at`).
- **Zero External Runtime Dependencies in `@steppal/sdk`**: The SDK must rely solely on standard `fetch` so it runs cleanly in React Native, browsers, and Node 20+.

---

## Development Workflow

1. Create a descriptive feature branch from `main`.
2. Write or update tests alongside your implementation:
   - API tests live in `packages/api/test/*.test.ts`
   - Oracle tests live in `packages/oracle/test/*.test.ts`
   - SDK tests live in `packages/sdk/test/*.test.ts`
   - Soroban contract tests live in `contracts/goal-escrow/src/test.rs`
3. Before opening a pull request, verify all checks pass:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   ```
   If you modified `contracts/goal-escrow`:
   ```bash
   cd contracts && cargo test
   ```
4. Use clear, conventional commit messages (`feat(api): ...`, `fix(sdk): ...`, `test(oracle): ...`, `docs: ...`).
