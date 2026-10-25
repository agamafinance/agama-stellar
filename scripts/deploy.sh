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
#   ./scripts/deploy.sh prices     refresh the admin-set prices
#   ./scripts/deploy.sh upgrade core   put the wasm just built behind a live id
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

# The ledger an allowance may not be set beyond, read from the network each
# run. A hardcoded horizon stops being valid the week after it is written.
current_ledger() {
  curl -s "https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1" \
    | python3 -I -c "import json,sys;print(json.load(sys.stdin)['_embedded']['records'][0]['sequence'])"
}

ME=$(stellar keys address "$SRC")

inv() { stellar contract invoke --quiet --id "$1" --source "$SRC" --network "$NET" -- "${@:2}"; }

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
    x=m[sym]; ix=d['blend']['reserves'][sym]
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

# ------------------------------------------------------------------ seed ----

# Dollars in three places, because they are three different things:
#
#   - supplied to the pool, so there is something for a position to borrow,
#   - in the core's buffer, so a fall can be answered in the same call that
#     notices it rather than after a withdrawal queue has cleared,
#   - held by the deployer, so the faucet and the vault's accrue have cash.
#
# A price for every market too. Without one the oracle has nothing to say and
# the core refuses to open a position, which is the correct refusal and a
# confusing first impression.
seed() {
  say "Seeding"
  local pool usdc core_id
  pool=$(get blend.pool); usdc=$(get blend.usdc); core_id=$(get contracts.core)

  local horizon; horizon=$(( $(current_ledger) + 500000 ))
  inv "$usdc" mint --to "$ME" --amount 20000000000000 >/dev/null
  note "minted 2,000,000 USDC"

  if [ "$(get seed.supplied)" != "yes" ]; then
    inv "$usdc" approve --from "$ME" --spender "$pool" --amount 10000000000000 \
        --expiration_ledger "$horizon" >/dev/null
    stellar contract invoke --quiet --id "$pool" --source "$SRC" --network "$NET" \
      -- submit --from "$ME" --spender "$ME" --to "$ME" \
         --requests "[{\"address\":\"$usdc\",\"amount\":\"10000000000000\",\"request_type\":0}]" \
         >/dev/null
    put seed.supplied yes
    note "supplied 1,000,000 USDC to the pool"
  else
    note "pool liquidity already supplied"
  fi

  if [ "$(get seed.buffer)" != "yes" ]; then
    inv "$usdc" approve --from "$ME" --spender "$core_id" --amount 5000000000000 \
        --expiration_ledger "$horizon" >/dev/null
    inv "$core_id" fund_buffer --from "$ME" --amount 5000000000000 >/dev/null
    put seed.buffer yes
    note "buffer funded with 500,000 USDC"
  else
    note "buffer already funded"
  fi

  feeds
  prices
}

# Every market's RedStone feed id, then a first price.
#
# The feed id is a 32-byte right-padded ASCII string, which is how RedStone
# names a feed inside a payload: "TSLA" is 0x5453_4c41 followed by 28 zero
# bytes. Without the mapping the oracle has no idea which number in a report
# belongs to which token, and says UnknownAsset, which is the right refusal
# and a confusing first impression.
feeds() {
  say "Feeds"
  # USDC needs one too, and that is not an afterthought. Blend asks its oracle
  # for a price for EVERY asset in a position, the borrowed one included, and
  # unwraps the answer. No feed for the dollar means lastprice returns None,
  # the pool traps, and the failure arrives as Error(WasmVm, InvalidAction) at
  # the borrow, which names neither the oracle nor the asset it was missing.
  inv "$(get contracts.oracle)" add_feed \
    --asset "{\"Stellar\":\"$(get blend.usdc)\"}" \
    --feed "5553444300000000000000000000000000000000000000000000000000000000" >/dev/null 2>&1 \
    || note "USDC feed already registered"
  inv "$(get contracts.oracle)" set_price \
    --asset "{\"Stellar\":\"$(get blend.usdc)\"}" --price 10000000 >/dev/null
  note "USDC feed and a dollar"
  python3 -I -c "
import json
m = {x['symbol']: x['feed'] for x in json.load(open('deployments/markets.json'))['markets']}
d = json.load(open('$OUT'))
for sym, addr in d['stocks'].items():
    print(f\"{sym}|{addr}|{m[sym].encode().hex().ljust(64, '0')}\")
" | while IFS='|' read -r sym addr feed; do
    inv "$(get contracts.oracle)" add_feed \
      --asset "{\"Stellar\":\"$addr\"}" --feed "$feed" >/dev/null 2>&1 \
      || note "$sym feed already registered"
    note "$sym feed $feed"
  done
}

# A first price for every market, signed by nobody: the admin path, bounded by
# the same max_move_bps as a relayed report. The keeper replaces these with
# RedStone reports; until one arrives there has to be something, or the first
# visitor meets a refusal rather than a product.
prices() {
  say "Prices"
  python3 -I -c "
import json
d = json.load(open('$OUT'))
seed = json.load(open('deployments/seed-prices.json'))
for sym, addr in d['stocks'].items():
    print(f\"{sym}|{addr}|{int(round(seed[sym] * 10_000_000))}\")
" | while IFS='|' read -r sym addr px; do
    inv "$(get contracts.oracle)" set_price \
      --asset "{\"Stellar\":\"$addr\"}" --price "$px" >/dev/null
    note "$sym $px"
  done
}

# ---------------------------------------------------------------- upgrade ----

# Put the wasm just built behind an address that is already live.
#
# The contract keeps its id and its storage, so nothing that points at it has
# to move: the markets, the Blend reserves, the positions and the front end
# all go on working. Only `core` and `oracle` carry an `upgrade` entry point;
# the stocks and the positions do not, which is why the stocks are the one
# thing in here that has ever had to be replaced.
upgrade() {
  local which=${1:?which contract}
  local id
  id=$(get "contracts.$which")
  [ -n "$id" ] || { echo "no deployed $which in $OUT" >&2; exit 2; }
  say "Upgrading $which, $id"
  local h
  h=$(stellar contract upload --quiet --wasm "$WASM/$which.wasm" --source "$SRC" --network "$NET")
  note "wasm $h"
  inv "$id" upgrade --new_wasm_hash "$h" >/dev/null
  put "wasm.$which" "$h"
  note "$(inv "$id" version)"
}

case "${1:-all}" in
  upload) upload ;;
  upgrade) upgrade "${2:?which contract}" ;;
  stocks) stocks ;;
  oracle) oracle ;;
  vault) vault ;;
  core) core ;;
  seed) seed ;;
  feeds) feeds ;;
  prices) prices ;;
  all) upload; stocks; oracle; vault; core; seed ;;
  *) echo "unknown stage: $1" >&2; exit 2 ;;
esac

say "deployments/testnet.json"
cat "$OUT"
