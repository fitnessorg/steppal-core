# goal-escrow

Soroban smart contract for StepPal. Holds money against a step goal and releases
it only when an attested result meets that goal.

One contract serves three product features, because all three are the same
shape:

| Feature | Shape |
|---|---|
| Sponsor a friend | One funder, one beneficiary |
| Tip a public pledge | Many funders, one beneficiary |
| A group pot | Every member funds their own goal |

## The honest part

The contract cannot see step counts. An off-chain oracle attests them, so this
is **trust-minimised, not trustless**. Three things bound the oracle's power:

1. **A 24-hour challenge window.** Anyone may dispute an attestation before it
   pays out. A dispute always sends the goal to refunding — money returns to
   whoever put it in. Disputing is permissionless and bond-free, because the
   worst a griefer achieves is that everyone gets their own money back.
2. **A deadline.** If the oracle never attests, funders withdraw after the
   deadline. A silent oracle can never trap funds.
3. **Exact refunds.** Each funder is repaid precisely what they contributed. No
   pro-rata maths, so no rounding dust and no way for the last claimant to be
   short-changed.

## Interface

```rust
create_goal(beneficiary, oracle, token, target_steps, deadline) -> u32
fund(id, funder, amount)          // sponsors and tippers use the same call
attest(id, steps)                 // oracle only; opens the challenge window
dispute(id, challenger)           // anyone, during the window
claim(id) -> i128                 // permissionless once the window closes
refund(id, funder) -> i128        // withdraw your own contribution
get_goal(id) -> Goal
funded_by(id, funder) -> i128
```

Anyone may create a goal for any beneficiary. Sponsoring a friend is the normal
case, so giving someone money needs no authorisation from them.

## Build and test

```bash
cargo test                    # 12 tests, no network needed
stellar contract build        # wasm
./scripts/deploy-testnet.sh   # deploy, records the id in deployments.json
```

## Notes for contributors

- **Storage TTL.** A goal runs for weeks and Soroban archives untouched
  storage, so every write extends the goal's TTL. Forgetting this is the classic
  way to lose a contract's state mid-flight.
- `i128` throughout. Stellar USDC has 7 decimals; there are no floats here.
- The `env.events().publish` calls raise a deprecation warning on
  soroban-sdk 23. Migrating to the `#[contractevent]` macro is a good first
  contribution.

Apache-2.0.
