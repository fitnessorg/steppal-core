# StepPal — core

**StepPal is a commitment app.** You put money behind a step goal, and a
contract holds it until you have either earned it back or lost it.

Friends form a pot, everyone stakes the same amount, and everyone gets the same
daily step target for the week. Hit it every day and you get your stake back
plus a share of what the people who missed forfeited. There is no treasurer, no
argument on Sunday night, and nobody chasing anyone for ₦3,000.

This repo is the part that decides who gets paid: the HTTP API, the Soroban
escrow contract, and the TypeScript SDK that the mobile app consumes. The app
itself lives in [steppal-mobile](https://github.com/fitnessorg/steppal-mobile).

## What works today

| | Status |
| --- | --- |
| Phone OTP auth, rotating refresh tokens | Built, 13 tests |
| Pots — create, join by code, standings, leave | Built, 7 tests |
| Step ingestion with server-side validation | Built, 6 tests |
| Settlement engine | Built, 7 tests |
| `@steppal/sdk` typed client | Built, 10 tests |
| `goal-escrow` Soroban contract | Built, 12 tests, [deployed to testnet](https://stellar.expert/explorer/testnet/contract/CCEMDKD4POJ4H2EF3JSY73W33OVB34X7KWV7UM6VRESTPNTHJ4OG37TT) |
| Payments (deposit / withdrawal) | Interface only — mock provider |
| Oracle service (signed attestations) | Not started |
| API ↔ contract wiring | Not started |

Stakes are **zero** in the current build. The money-free version ships first:
it proves whether people actually walk more when their friends are watching,
which is the thing that has to be true before money makes any sense. Every
money path exists in the schema and the contract, so enabling it is a value
change, not a migration.

## Repo layout

```
steppal-core/
├── packages/
│   ├── api/            Fastify, Postgres via Drizzle, Zod-validated routes
│   │   ├── src/lib/    Pure rules — dates, phone, steps, settlement, invites
│   │   ├── src/routes/ HTTP surface
│   │   └── src/jobs/   settle.ts, for a daily scheduler
│   └── sdk/            @steppal/sdk — typed client, auto-refresh, no deps
├── contracts/
│   └── goal-escrow/    Rust / Soroban. Sponsored goals, tips and pots are one
│                       contract, because on chain they are the same shape.
└── docs/API.md         Endpoint reference and the reasoning behind each rule
```

The seam that matters is `@steppal/sdk`. It is why the mobile app can live in
its own repo and why a Rust contributor and a React Native contributor never
touch the same file.

## Run it locally

Node 20+ and pnpm. Postgres from Docker, or any hosted one.

```bash
git clone https://github.com/fitnessorg/steppal-core
cd steppal-core
pnpm install

cp packages/api/.env.example packages/api/.env
docker compose up -d                 # or point DATABASE_URL at a hosted Postgres

pnpm db:migrate
pnpm db:seed                         # three walkers, one pot, a believable week
pnpm dev
```

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"0.1.0"}
```

**No SMS account needed.** `SMS_PROVIDER=console` prints the login code to the
terminal, which is how the entire auth flow is testable from a fresh clone.

```bash
curl -X POST localhost:3000/v1/auth/request-code \
  -H 'content-type: application/json' -d '{"phone":"08031234567"}'
# the server log prints: [sms:console] -> +2348031234567: 418245 is your StepPal code.
```

### The contract

Needs Rust and the [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started).

```bash
rustup target add wasm32v1-none
cd contracts && cargo test              # 12 tests, no network
bash scripts/deploy-testnet.sh          # needs a funded testnet identity
```

## Tests

```bash
pnpm test        # 43 tests across api and sdk
pnpm lint
pnpm typecheck
```

The API tests run against a real Postgres rather than mocks, because the things
most likely to break — the unique index that makes step submission idempotent,
the transaction that stops a memberless pot existing — only exist in the
database.

## Design decisions worth knowing

**A step count is a claim, not a fact.** `step_days` records what a phone
reported and where it came from. Validation lives in the ingest path; the
column type believes nothing.

**Settlement is not "most steps wins."** That rewards free time, which in any
group of friends is the same person every week. Everyone is judged against the
same goal instead, so everyone can win.

**When nobody wins, stakes are returned.** StepPal never profits from a member
failing — ethically, and because a product that keeps forfeited money looks a
lot like a house taking a rake.

**Nothing is deleted.** Pots end, memberships are left, tokens are revoked —
all by timestamp. A settlement nobody can reconstruct is a settlement nobody
will trust.

**Dates are local calendar days, never instants.** A pot that ends "Sunday"
should not end at 1am Monday in Lagos.

More of this reasoning, per endpoint, is in [docs/API.md](./docs/API.md).

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md), then
[CONTRIBUTING-TASKS.md](./CONTRIBUTING-TASKS.md) — every open task, graded, with
the file it lives in. They are transcribed from `TODO(contributor)` comments in
the code, so nothing on that list is invented for the sake of having a list.

Licensed under MIT. See [LICENSE](./LICENSE).
