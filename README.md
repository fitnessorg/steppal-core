# StepPal — core

StepPal is an open-source app where a group of friends each stake money and
settle up at the end of the week based on step counts. This repo holds the
HTTP API, the Soroban smart contracts, and the TypeScript SDK the mobile and
web clients consume.

This project is being built deliberately to about 65% completion. The rest is
left open for contributors — see [CONTRIBUTING-TASKS.md](./CONTRIBUTING-TASKS.md)
once it exists, and look for `TODO(contributor)` comments in the code.

## Repo layout

```
steppal-core/
├── packages/
│   ├── api/        # Fastify server, Postgres/Drizzle, business logic
│   └── sdk/         # @steppal/sdk — typed client for mobile/web
├── contracts/
│   └── pot-escrow/  # Rust / Soroban escrow contract
├── docker-compose.yml
└── .env.example
```

## Run it locally

Requirements: Node 20+, pnpm, Docker.

```bash
git clone <this-repo>
cd steppal-core
cp .env.example .env
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

Then check:

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"0.1.0"}
```

## Tests

```bash
pnpm test        # all packages
pnpm lint
pnpm typecheck
```
