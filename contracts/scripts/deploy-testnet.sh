#!/usr/bin/env bash
# Builds and deploys goal-escrow to Stellar testnet.
#
# Prerequisites:
#   stellar CLI        https://developers.stellar.org/docs/build/smart-contracts/getting-started
#   rustup target add wasm32v1-none
#   stellar keys generate --global deployer --network testnet --fund
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-deployer}"

echo "Building..."
stellar contract build

WASM="target/wasm32v1-none/release/goal_escrow.wasm"
[ -f "$WASM" ] || { echo "Build output not found at $WASM"; exit 1; }

echo "Optimising..."
stellar contract optimize --wasm "$WASM"

echo "Deploying to $NETWORK..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "target/wasm32v1-none/release/goal_escrow.optimized.wasm" \
  --source "$SOURCE" \
  --network "$NETWORK")

echo "Deployed: $CONTRACT_ID"

python3 - "$CONTRACT_ID" "$NETWORK" <<'PY'
import json, os, sys
cid, network = sys.argv[1], sys.argv[2]
path = "deployments.json"
data = json.load(open(path)) if os.path.exists(path) else {}
data[network] = {"goal_escrow": cid}
json.dump(data, open(path, "w"), indent=2)
open(path, "a").write("\n")
print("Recorded in deployments.json")
PY
