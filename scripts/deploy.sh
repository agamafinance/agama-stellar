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
#   ./scripts/deploy.sh vault      the testnet stand-in for the Agama vault
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

# Blend's shared testnet instance. Kept for reference only: its backstop
# cannot be funded by us, so a pool of ours inside it can never leave
# supply-only. scripts/blend.sh stands up our own instance instead.
#
# The live Agama vault is not used here either, for the same shape of reason:
# it takes Circle's USDC and nobody but Circle can mint that. contracts/vault
# is the stand-in, holding the two properties the protocol is built around.

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
  for c in stock oracle position vault core; do
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

# ----------------------------------------------------------------- vault ----

vault() {
  say "The vault"
  if [ -n "$(get contracts.vault)" ]; then note "already there, $(get contracts.vault)"; return; fi
  local admin; admin=$(stellar keys address "$SRC")
  local id; id=$(stellar contract deploy --quiet \
    --wasm-hash "$(get wasm.vault)" --source "$SRC" --network "$NET" \
    -- --admin "$admin" --usdc "$(get blend.usdc)")
  put contracts.vault "$id"
  note "vault $id"
}

# ------------------------------------------------------------------ core ----

# The protocol, and the ten markets it knows about.
#
# The USDC it borrows is the one the Agama vault accepts, not Blend's testnet
# USDC. They are different tokens and the mismatch would only have shown up at
# the first deposit, as a vault refusing a token it has never heard of.
core() {
  say "The core, and its markets"
  local admin; admin=$(stellar keys address "$SRC")
  local id; id=$(get contracts.core)
  if [ -z "$id" ]; then
    id=$(stellar contract deploy --quiet \
      --wasm-hash "$(get wasm.core)" --source "$SRC" --network "$NET" \
      -- --admin "$admin" --usdc "$(get blend.usdc)" \
         --usdc_reserve_index "$(get blend.reserves.USDC)" \
         --pool "$(get blend.pool)" --oracle "$(get contracts.oracle)" \
         --vault "$(get contracts.vault)" --position_wasm "$(get wasm.position)" \
         --max_price_age 86400)
    put contracts.core "$id"
    note "core $id"
  else
    note "core already there, $id"
  fi

  python3 -I -c "
import json
m={x['symbol']: x for x in json.load(open('deployments/markets.json'))['markets']}
d=json.load(open('$OUT'))
for sym, addr in d['stocks'].items():
    x=m[sym]; ix=d['reserves'][sym]
    print(f\"{sym}|{addr}|{ix}|{x['ltv']}|{x['threshold']}|{x['offHoursBuffer']}\")
" | while IFS='|' read -r sym addr ix ltv thr buf; do
    if [ -n "$(get "markets.$sym")" ]; then note "$sym already a market"; continue; fi
    stellar contract invoke --quiet --id "$id" --source "$SRC" --network "$NET" \
      -- add_market --token "$addr" --reserve_index "$ix" \
         --ltv "$ltv" --threshold "$thr" --off_hours_buffer "$buf" >/dev/null
    # The core mints the stand-in on an Amplify or a compound, so it owns them.
    stellar contract invoke --quiet --id "$addr" --source "$SRC" --network "$NET" \
      -- set_admin --new_admin "$id" >/dev/null
    put "markets.$sym" "$ix"
    note "$sym market, reserve $ix, stock admin handed over"
  done
}

case "${1:-all}" in
  upload) upload ;;
  stocks) stocks ;;
  oracle) oracle ;;
  vault) vault ;;
  core) core ;;
  all) upload; stocks; oracle; vault; core ;;
  *) echo "unknown stage: $1" >&2; exit 2 ;;
esac

say "deployments/testnet.json"
cat "$OUT"
