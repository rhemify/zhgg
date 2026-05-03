#!/usr/bin/env bash
# Verify all deployed contracts on 0G Galileo (Blockscout) and Base Sepolia (Basescan).
# Run from the repo root: bash scripts/verify-contracts.sh
#
# IMPORTANT: contracts were deployed from commit 1cbf6ee. If source has since changed,
# run from that commit via: git worktree add /tmp/vw 1cbf6ee && cd /tmp/vw && bash scripts/verify-contracts.sh
set -euo pipefail

# ── Load .env so BASESCAN_API_KEY is available ────────────────────────────────
if [ -f .env ]; then
  set -a; source .env; set +a
fi

: "${BASESCAN_API_KEY:?BASESCAN_API_KEY not set — add it to .env}"

CONTRACTS_DIR="$(cd "$(dirname "$0")/../contracts" && pwd)"
cd "$CONTRACTS_DIR"

ZG_RPC="https://evmrpc-testnet.0g.ai"
BASE_RPC="https://sepolia.base.org"
ZG_VERIFIER_URL="https://chainscan-galileo.0g.ai/open/api"

# Shared compiler flags — must match foundry.toml exactly
COMPILER_FLAGS=(
  --compiler-version 0.8.24
  --num-of-optimizations 200
  --via-ir
)

ok()     { echo "  ✓ $1"; }
fail()   { echo "  ✗ $1 — $2"; }
header() { echo; echo "══ $1 ══"; }

verify_zg() {
  local name=$1 addr=$2; shift 2
  printf "  verifying %-30s %s ... " "$name" "$addr"
  if forge verify-contract \
      --rpc-url "$ZG_RPC" \
      --verifier blockscout \
      --verifier-url "$ZG_VERIFIER_URL" \
      "${COMPILER_FLAGS[@]}" \
      "$@" \
      "$addr" "src/${name}.sol:${name}" 2>&1 | tail -1 | grep -qi 'success\|already\|verified'; then
    ok "$name"
  else
    # Run again verbose so the error is visible
    forge verify-contract \
      --rpc-url "$ZG_RPC" \
      --verifier blockscout \
      --verifier-url "$ZG_VERIFIER_URL" \
      "${COMPILER_FLAGS[@]}" \
      "$@" \
      "$addr" "src/${name}.sol:${name}" || true
  fi
}

verify_base() {
  local name=$1 addr=$2; shift 2
  printf "  verifying %-30s %s ... " "$name" "$addr"
  if forge verify-contract \
      --chain base-sepolia \
      --etherscan-api-key "$BASESCAN_API_KEY" \
      "${COMPILER_FLAGS[@]}" \
      "$@" \
      "$addr" "src/${name}.sol:${name}" 2>&1 | tail -1 | grep -qi 'success\|already\|verified\|guid'; then
    ok "$name"
  else
    forge verify-contract \
      --chain base-sepolia \
      --etherscan-api-key "$BASESCAN_API_KEY" \
      "${COMPILER_FLAGS[@]}" \
      "$@" \
      "$addr" "src/${name}.sol:${name}" || true
  fi
}

# ── 0G Galileo (chain 16602) ──────────────────────────────────────────────────
header "0G Galileo (chain 16602) — Blockscout"

verify_zg AgentNFT \
  0x5298f4d8d8043c14e5f2683ad642febc8b54638f

verify_zg AgentRegistry \
  0xe78f6c235fd1686547dbea41f742d649607316b1

verify_zg AxiomCommit \
  0xa471d2c45f03518e47c7fc71c897d244df01859d \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x5298F4D8d8043C14e5F2683Ad642fEbC8B54638f)"

verify_zg AgenticCommerce \
  0x6b90618b48d199e1d0df75179d26c2b97e80af44 \
  --constructor-args "$(cast abi-encode 'constructor(address,uint16)' 0x557E1E07652B75ABaA667223B11704165fC94d09 250)"

# ── Base Sepolia (chain 84532) ────────────────────────────────────────────────
header "Base Sepolia (chain 84532) — Basescan"

verify_base SpendCap \
  0x666a6466bddd1fb79bda32f00a045c1ec77c61a8

verify_base FeeSplitter \
  0xb3a9ea5a72caab795bcf16c7bc5fd2d4863b47dd \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address)' \
    0x557E1E07652B75ABaA667223B11704165fC94d09 \
    0x557E1E07652B75ABaA667223B11704165fC94d09 \
    0x557E1E07652B75ABaA667223B11704165fC94d09)"

verify_base OwnerMirror \
  0x49976ae86d28665232c164713c3379e6301a63c7 \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x557E1E07652B75ABaA667223B11704165fC94d09)"

verify_base AgentReceiverWalletFactory \
  0x6848f17d55b8df970df17c7a04b1c0e0b6565dd1 \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' \
    0x49976ae86d28665232c164713C3379e6301a63C7 \
    0xB3a9eA5a72cAab795bCF16c7BC5Fd2d4863b47Dd)"

verify_base DelegationManager \
  0xdee1f561d685cdced4c6caaa40f8c6f7112dffef \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x666a6466BDdD1FB79Bda32F00a045c1Ec77c61A8)"

verify_base AgentSimpleAccountFactory \
  0x1eea5c29d671af30a2436078caf523919fd44304 \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x0000000071727De22E5E9d8BAf0edAc6f37da032)"

echo
echo "Done. Explorer links:"
echo "  0G:   https://chainscan-galileo.0g.ai"
echo "  Base: https://sepolia.basescan.org"
