#!/usr/bin/env bash
# Deploy Agama to Stellar testnet, one stage at a time.
#
# Every stage is re-runnable: it reads deployments/testnet.json, skips what is
# already in there, and writes back what it did. That matters more than it
# sounds. A deploy that has to run clean or not at all is a deploy nobody dares
# run twice, and the second half of this one depends on a lending pool reaching
# a state that takes several transactions and can fail halfway.
#
#   ./scripts/deploy.sh upload     the four wasms
#   ./scripts/deploy.sh stocks     the ten stand-in tokens
#   ./scripts/deploy.sh oracle     the price layer, with the RedStone signers
#   ./scripts/deploy.sh pool       our Blend pool, through the live factory
#   ./scripts/deploy.sh reserves   USDC to borrow, the ten stocks as collateral
#   ./scripts/deploy.sh core       the protocol, and its markets
#   ./scripts/deploy.sh seed       liquidity, the buffer, and a first price
#   ./scripts/deploy.sh all        in that order
set -euo pipefail

cd "$(dirname "$0")/.."

NET=testnet
SRC=${STELLAR_ACCOUNT:-agama}
OUT=deployments/testnet.json
WASM=target/wasm32v1-none/release

# Blend v2 on testnet, from blend-capital/blend-utils testnet.contracts.json.
BLEND_FACTORY=CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6
BLEND_BACKSTOP=CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA
BLEND_USDC=CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU
BLEND_BLND=CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF

# The Agama vault already running on this network.
VAULT=CCVNCXPJXCA5GKJKNUNZRMJEEWYL74ASYYTL2DULPO5TZDGSHUPZTTJF

mkdir -p deployments
[ -f "$OUT" ] || echo '{}' > "$OUT"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# Read a dotted path out of the deployment file, empty when absent.
get() { python3 -I -c "
import json,sys
d=json.load(open('$OUT'))
for k in '$1'.split('.'):
    d = d.get(k) if isinstance(d, dict) else None
    if d is None: print(''); sys.exit()
print(d)
"; }

# Write a dotted path back, creating what it needs on the way.
put() { python3 -I -c "
import json
p='$OUT'; d=json.load(open(p)); node=d
ks='$1'.split('.')
for k in ks[:-1]: node = node.setdefault(k, {})
node[ks[-1]] = '''$2'''
json.dump(d, open(p,'w'), indent=2); open(p,'a').write('\n')
"; }

invoke() { stellar contract invoke --quiet --id "$1" --source "$SRC" --network "$NET" -- "${@:2}"; }

# ---------------------------------------------------------------- upload ----

upload() {
  say "Uploading the wasms"
  for c in stock oracle position core; do
    existing=$(get "wasm.$c")
    if [ -n "$existing" ]; then note "$c already uploaded, $existing"; continue; fi
    h=$(stellar contract upload --quiet --wasm "$WASM/$c.wasm" --source "$SRC" --network "$NET")
    put "wasm.$c" "$h"
    note "$c $h"
  done
}

# ---------------------------------------------------------------- stocks ----

stocks() {
  say "The ten stand-in tokens"
  local admin; admin=$(stellar keys address "$SRC")
  python3 -I -c "
import json
m=json.load(open('deployments/markets.json'))['markets']
print('\n'.join(f\"{x['symbol']}|{x['name']}|{x['drip']}\" for x in m))
" | while IFS='|' read -r sym name drip; do
    existing=$(get "stocks.$sym")
    if [ -n "$existing" ]; then note "$sym already there, $existing"; continue; fi
    # drip arrives as a decimal string; the contract takes stroops.
    stroops=$(python3 -I -c "print(int(round(float('$drip') * 10_000_000)))")
    id=$(stellar contract deploy --quiet \
      --wasm-hash "$(get wasm.stock)" --source "$SRC" --network "$NET" \
      -- --admin "$admin" --decimals 7 --name "$name" --symbol "$sym" \
         --drip "$stroops" --cooldown 3600)
    put "stocks.$sym" "$id"
    note "$sym $id"
  done
}

# ---------------------------------------------------------------- oracle ----

# RedStone's primary production signers. A price is worth nothing without the
# list, so the list is in the repository and not in an environment variable.
oracle() {
  say "The price layer"
  local existing; existing=$(get contracts.oracle)
  if [ -n "$existing" ]; then note "already there, $existing"; return; fi
  local admin; admin=$(stellar keys address "$SRC")
  local signers; signers=$(python3 -I -c "
import json
print(json.dumps(json.load(open('deployments/redstone-signers.json'))['primaryProd']))
")
  id=$(stellar contract deploy --quiet \
    --wasm-hash "$(get wasm.oracle)" --source "$SRC" --network "$NET" \
    -- --admin "$admin" --signers "$signers" --min_signers 3 --decimals 7 \
       --max_age 3600 --max_move_bps 1500)
  put contracts.oracle "$id"
  note "oracle $id"
}

case "${1:-all}" in
  upload) upload ;;
  stocks) stocks ;;
  oracle) oracle ;;
  all) upload; stocks; oracle ;;
  *) echo "unknown stage: $1" >&2; exit 2 ;;
esac

say "deployments/testnet.json"
cat "$OUT"
