# StepPal Anti-Cheat Threat Model & Oracle Architecture

## Principles

StepPal's commitment protocol is rooted in two core invariants:

1. **A step count is a claim, not a fact.** Mobile hardware sensors report counts; the protocol verifies and decides what to believe.
2. **Funds are never trapped by an oracle.** A silent oracle cannot withhold user funds; after the contract's `deadline`, participants withdraw exact refunds permissionlessly.

---

## Multi-Layer Verification Architecture

```mermaid
flowchart TD
    A["Mobile Device Sensor (Health Connect / Pedometer)"] -->|POST /v1/steps| B["Ingest Path (@steppal/api)"]
    B -->|Immediate Sanitization| C["Postgres Storage (step_days)"]
    C -->|Window History Read| D["Oracle Attestation Service (@steppal/oracle)"]
    D -->|Evaluation: Pass| E["Soroban Contract: attest(id, steps)"]
    D -->|Evaluation: Fraud / Refuse| F["Oracle Silence (Wait for Deadline)"]
    F -->|Deadline Elapsed| G["Permissionless Refund: refund(id, funder)"]
    E -->|24h Challenge Window| H["Permissionless Claim: claim(id)"]
    E -->|Disputed Inside Window| G
```

### Layer 1: Ingest Path Sanitization (`@steppal/api`)
Applied per write request on `POST /v1/steps`:
- **Future Date Rejection**: Rejects any calendar day ahead of server date.
- **Backfill Window Limitation**: Rejects claims older than 8 days to eliminate late top-ups before settlement.
- **Daily Ingest Clamping**: Steps above `DAILY_STEP_CAP` (25,000) are clamped for pot competition while preserving `raw_steps` for forensic auditing.
- **Idempotency**: Unique constraint on `(user_id, day)` ensures network retries overwrite rather than inflate totals.

### Layer 2: Off-Chain Oracle Evaluation (`@steppal/oracle`)
Operates on the complete multi-day history before settlement:
- **Physical Boundary Verification**: Enforces an absolute physiological maximum of 50,000 steps per calendar day. Flags `IMPLAUSIBLE_STEP_BURST` and `DAILY_CAP_EXCEEDED`.
- **Cross-Day Velocity Spike Analysis**: Flags suspicious step spikes (e.g. jumping from near-zero to peak target right before pot end) and flags submission cadences exceeding human sprint speed (> 4.5 steps/sec).
- **Device Consistency & Sensor Integrity**: Detects suspicious switching between contradictory sensor sources (`mock` mixed with physical sensors) and hardware identifier proliferation.
- **Synthetic Uniformity Detection**: Detects algorithmic bot generators repeating identical numbers with zero natural standard deviation variance.

---

## Threat Vector Taxonomy & Mitigation Matrix

| Threat Vector | Attack Mechanism | Defense Layer | Detection / Mitigation Rule |
| --- | --- | --- | --- |
| **Clock Roll-Forward** | User sets phone date forward to pre-fill future days in a pot | Layer 1 (`src/lib/steps.ts`) | `future_day` rule rejects any date strictly greater than server-side `today`. |
| **Late Backfill Injection** | User waits until final hour of pot to submit fabricated steps for day 1 | Layer 1 (`src/lib/steps.ts`) | `too_old` rule rejects any date more than 8 calendar days prior to `today`. |
| **Mechanical Phone Shaking / Glitch** | User puts phone in a mechanical cradle or encounters pedometer bounce | Layer 1 & Layer 2 | Ingest clamps `steps` at `DAILY_STEP_CAP` (25,000) while recording original `raw_steps`. Oracle rejects raw bursts > 50,000 (`IMPLAUSIBLE_STEP_BURST`). |
| **Packet Replay / Retry Inflation** | Client replays `POST /v1/steps` payload to multiply daily count | Layer 1 (`step_days` schema) | Composite primary key `(user_id, day)` makes writes idempotent updates (`ON CONFLICT DO UPDATE`), never additive increments. |
| **Last-Minute Scripted Top-Up** | Participant walks 500 steps/day for 5 days, then scripts 15,000 steps on final days | Layer 2 (`anti-cheat.ts`) | `checkCrossDayVelocity` flags `VELOCITY_SPIKE` when a single day exceeds >4x multi-day baseline and >15,000 steps. |
| **High-Frequency Cadence Injection** | Automated script submits rapid step increments faster than human locomotion | Layer 2 (`anti-cheat.ts`) | `checkCrossDayVelocity` computes delta steps over elapsed seconds between syncs, flagging > 4.5 steps/sec (`VELOCITY_SPIKE`). |
| **Emulator / Sensor Source Switching** | Attacker uses a simulator (`mock` source) on days they fail to walk | Layer 2 (`anti-cheat.ts`) | `checkDeviceConsistency` flags `SOURCE_DOWNGRADE` when `mock` appears alongside hardware sources (`healthkit`, `health_connect`, `pedometer`) and `DEVICE_HOPPING` when >2 device IDs appear in one window. |
| **Deterministic Cron Bot** | Script posts `10,000` steps every day at midnight | Layer 2 (`anti-cheat.ts`) | `checkStepUniformity` computes variance across >=4 non-zero days, flagging `SYNTHETIC_UNIFORMITY` on zero variance. |

---

## Smart Contract Interaction & Fallback Invariants

- **`attest(id, steps)`**: Signed by the oracle using `MockSorobanSigner` or `SorobanRpcSigner`, opening the 24-hour challenge window.
- **`dispute(id, challenger)`**: Anyone may dispute during the challenge window, moving the escrow to `Refunding`.
- **Silent Oracle Fallback**: If the oracle refuses to attest due to critical anti-cheat violations, it remains silent. Once `env.ledger().timestamp() >= goal.deadline`, any funder can call `refund(id, funder)` to retrieve their funds.
