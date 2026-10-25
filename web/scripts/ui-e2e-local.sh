#!/usr/bin/env bash
# The app end to end against a throwaway local validator running the current
# program: setup, a web build pointed at it, then the headless UI e2e.
#
#   VALIDATOR=/path/to/agave-4.3/bin/solana-test-validator \
#   PLAYWRIGHT_PATH=/path/to/node_modules/playwright CHROME_PATH=/path/to/chromium \
#   ./web/scripts/ui-e2e-local.sh
#
# agave 4.3+ because 3.1 rejects the zk-sdk proofs; Token-2022 is cloned from
# devnet because the genesis copy predates the confidential instruction layout.
set -eo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${VALIDATOR:?set VALIDATOR to an agave 4.3+ solana-test-validator}"
: "${PLAYWRIGHT_PATH:?set PLAYWRIGHT_PATH}"
: "${CHROME_PATH:?set CHROME_PATH}"
L=$(mktemp -d)
ADMIN=$L/admin.json
solana-keygen new --no-bip39-passphrase -s -o $ADMIN >/dev/null
cd $ROOT
"$VALIDATOR" --reset --quiet --ledger $L/ledger \
  --url https://rpc.magicblock.app/devnet --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --bpf-program 6YdZN72p68ynpGH1SwZ86EseFokch6zPAQPAq9NxPY7D target/deploy/agama_solana.so &
V=$!
cleanup() { kill $V 2>/dev/null; [ -n "$W" ] && kill $W 2>/dev/null; rm -rf $L; }
trap cleanup EXIT
export SOLANA_RPC=http://127.0.0.1:8899
until solana -u $SOLANA_RPC cluster-version >/dev/null 2>&1; do sleep 1; done
solana -u $SOLANA_RPC airdrop 100 $(solana-keygen pubkey $ADMIN) >/dev/null
solana -u $SOLANA_RPC airdrop 50 $(solana-keygen pubkey ~/.config/solana/id.json) >/dev/null
echo "== setup"
ANCHOR_WALLET=$ADMIN ./node_modules/.bin/tsx scripts/setup.ts 2>&1 | grep -v "punycode\|trace-deprecation\|bigint" | tail -4
cd web
echo "== build (local RPC)"
NEXT_PUBLIC_SOLANA_RPC=http://127.0.0.1:8899 pnpm build 2>&1 | tail -2
./node_modules/.bin/next start -p 3032 >/tmp/agama-web-3032.log 2>&1 &
W=$!
until curl -s -o /dev/null http://127.0.0.1:3032/solana; do sleep 1; done
echo "== ui e2e"
SOLANA_RPC=http://127.0.0.1:8899 FUND_SOL=0.1 node scripts/ui-e2e.mjs http://127.0.0.1:3032 2>&1 | grep -v "punycode\|trace-deprecation"
