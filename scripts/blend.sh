#!/usr/bin/env bash
# Stand up our own instance of Blend on testnet.
#
# Why our own, when Blend is already deployed there: a pool cannot let anyone
# borrow until its backstop is funded, a backstop is funded in BLND:USDC comet
# LP, and on testnet neither BLND nor Blend's USDC can be minted by anyone but
# their admins. Their instance is therefore permanently stuck in supply-only
# for us. So we deploy Blend's own contracts, unmodified, with tokens we can
# mint, and fund the backstop ourselves.
#
# This is still Blend. Same wasm, same request codes, same interest model. The
# only thing that is ours is the instance.
#
#   ./scripts/blend.sh tokens     our USDC and BLND, both with a faucet
#   ./scripts/blend.sh comet      the BLND:USDC pool that the backstop counts
#   ./scripts/blend.sh stack      emitter, backstop, pool factory
#   ./scripts/blend.sh pool       our lending pool, from our factory
#   ./scripts/blend.sh reserves   USDC to borrow, the ten stocks as collateral
#   ./scripts/blend.sh fund       LP into the backstop, and the pool goes live
#   ./scripts/blend.sh all        in that order
set -euo pipefail
cd "$(dirname "$0")/.."

NET=testnet
SRC=${STELLAR_ACCOUNT:-agama}
OUT=deployments/testnet.json
WASM=target/wasm32v1-none/release
ME=$(stellar keys address "$SRC")

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
get() { python3 -I -c "
import json,sys
d=json.load(open('$OUT'))
for k in '$1'.split('.'):
    d = d.get(k) if isinstance(d, dict) else None
    if d is None: print(''); sys.exit()
print(d)
"; }
put() { python3 -I -c "
import json
p='$OUT'; d=json.load(open(p)); node=d
ks='$1'.split('.')
for k in ks[:-1]: node = node.setdefault(k, {})
node[ks[-1]] = '''$2'''
json.dump(d, open(p,'w'), indent=2); open(p,'a').write('\n')
"; }
# The ledger an allowance may not be set beyond, read from the network each
# run. A hardcoded horizon stops being valid the week after it is written.
current_ledger() {
  curl -s "https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1" \
    | python3 -I -c "import json,sys;print(json.load(sys.stdin)['_embedded']['records'][0]['sequence'])"
}

salt_of() { python3 -I -c "import hashlib;print(hashlib.sha256(b'agama-stellar/$1').hexdigest())"; }

up() { # up <name> <path>
  local h; h=$(get "wasm.$1")
  if [ -z "$h" ]; then
    h=$(stellar contract upload --quiet --wasm "$2" --source "$SRC" --network "$NET")
    put "wasm.$1" "$h"
  fi
  echo "$h"
}
inv() { stellar contract invoke --quiet --id "$1" --source "$SRC" --network "$NET" -- "${@:2}"; }

# ---------------------------------------------------------------- tokens ----

# Our USDC and our BLND, both the same SEP-41 as the stocks, which means both
# come with the rate-limited faucet. That is not a shortcut: a testnet where a
# visitor cannot get dollars is a testnet nobody can try.
tokens() {
  say "Our USDC and BLND"
  local h; h=$(get wasm.stock)
  for spec in "USDC|Agama Test USDC|100000000000|usdc" "BLND|Blend Token|100000000000|blnd"; do
    IFS='|' read -r sym name drip key <<<"$spec"
    if [ -n "$(get "blend.$key")" ]; then note "$sym already there, $(get "blend.$key")"; continue; fi
    id=$(stellar contract deploy --quiet --wasm-hash "$h" --source "$SRC" --network "$NET" \
      -- --admin "$ME" --decimals 7 --name "$name" --symbol "$sym" --drip "$drip" --cooldown 3600)
    put "blend.$key" "$id"
    note "$sym $id"
  done
}

# ----------------------------------------------------------------- comet ----

# The 80/20 BLND:USDC pool whose LP token is what a backstop holds. Blend's
# threshold reads the BLND and USDC sitting behind the LP, so the deposit has
# to be large in underlying terms, not in share count.
comet() {
  say "The BLND:USDC pool"
  if [ -n "$(get blend.comet)" ]; then note "already there, $(get blend.comet)"; return; fi
  local comet_hash factory
  comet_hash=$(up comet vendor/comet.wasm)
  factory=$(get blend.cometFactory)
  if [ -z "$factory" ]; then
    local fh; fh=$(up cometFactory vendor/comet_factory.wasm)
    factory=$(stellar contract deploy --quiet --wasm-hash "$fh" --source "$SRC" --network "$NET")
    inv "$factory" init --pool_wasm_hash "$comet_hash" >/dev/null
    put blend.cometFactory "$factory"
    note "comet factory $factory"
  fi

  local blnd usdc
  blnd=$(get blend.blnd); usdc=$(get blend.usdc)
  inv "$blnd" mint --to "$ME" --amount 10000000000000 >/dev/null
  inv "$usdc" mint --to "$ME" --amount 2500000000000 >/dev/null
  inv "$blnd" approve --from "$ME" --spender "$factory" --amount 10000000000000 \
      --expiration_ledger "$(( $(current_ledger) + 500000 ))" >/dev/null
  inv "$usdc" approve --from "$ME" --spender "$factory" --amount 2500000000000 \
      --expiration_ledger "$(( $(current_ledger) + 500000 ))" >/dev/null

  local id
  id=$(stellar contract invoke --quiet --id "$factory" --source "$SRC" --network "$NET" \
    -- new_c_pool --salt "$(salt_of comet/v1)" --controller "$ME" \
       --tokens "[\"$blnd\",\"$usdc\"]" --weights '["8000000","2000000"]' \
       --balances '["10000000000000","2500000000000"]' --swap_fee 30000 | tr -d '"')
  put blend.comet "$id"
  note "comet $id"
}

# ----------------------------------------------------------------- stack ----

# Emitter, backstop, pool factory. The backstop needs the pool factory's
# address and the pool factory needs the backstop's, which is a cycle. It is
# broken by deriving the factory's address before deploying it: a contract
# deployed from an account lands at a hash of that account and the salt, so the
# address is knowable in advance.
stack() {
  say "Emitter, backstop, pool factory"
  local blnd usdc comet_id pool_hash
  blnd=$(get blend.blnd); usdc=$(get blend.usdc); comet_id=$(get blend.comet)
  pool_hash=$(up blendPool vendor/blend_pool.wasm)

  local pf_salt pf_addr
  pf_salt=$(salt_of pool-factory/v1)
  pf_addr=$(stellar contract id wasm --salt "$pf_salt" --source-account "$ME" --network "$NET")
  note "pool factory will land at $pf_addr"

  local emitter; emitter=$(get blend.emitter)
  if [ -z "$emitter" ]; then
    local eh; eh=$(up emitter vendor/emitter.wasm)
    emitter=$(stellar contract deploy --quiet --wasm-hash "$eh" --source "$SRC" --network "$NET")
    put blend.emitter "$emitter"
    note "emitter $emitter"
  fi

  local backstop; backstop=$(get blend.backstop)
  if [ -z "$backstop" ]; then
    local bh; bh=$(up backstop vendor/backstop.wasm)
    backstop=$(stellar contract deploy --quiet --wasm-hash "$bh" --source "$SRC" --network "$NET" \
      -- --backstop_token "$comet_id" --emitter "$emitter" --blnd_token "$blnd" \
         --usdc_token "$usdc" --pool_factory "$pf_addr" --drop_list '[]')
    put blend.backstop "$backstop"
    note "backstop $backstop"
  fi

  if [ -z "$(get blend.poolFactory)" ]; then
    local meta
    meta=$(python3 -I -c "
import json
print(json.dumps({'backstop': '$backstop', 'blnd_id': '$blnd', 'pool_hash': '$pool_hash'}))")
    local got
    got=$(stellar contract deploy --quiet --wasm-hash "$(get wasm.blendPoolFactory)" \
      --salt "$pf_salt" --source "$SRC" --network "$NET" -- --pool_init_meta "$meta" 2>/dev/null \
      || stellar contract deploy --quiet --wasm-hash "$(up blendPoolFactory vendor/blend_pool_factory.wasm)" \
      --salt "$pf_salt" --source "$SRC" --network "$NET" -- --pool_init_meta "$meta")
    [ "$got" = "$pf_addr" ] || { echo "factory landed at $got, expected $pf_addr" >&2; exit 1; }
    put blend.poolFactory "$got"
    note "pool factory $got, as derived"
  fi

  # The emitter is what mints BLND from here on, so it owns the token.
  inv "$emitter" initialize --blnd_token "$blnd" --backstop "$backstop" \
      --backstop_token "$comet_id" >/dev/null 2>&1 || note "emitter already initialised"
  inv "$blnd" set_admin --new_admin "$emitter" >/dev/null 2>&1 || note "BLND admin already moved"
  note "emitter owns BLND"
}


# ------------------------------------------------------------------ pool ----

# Our lending pool, from our factory, so our backstop counts for it.
pool2() {
  say "Our lending pool"
  if [ -n "$(get blend.pool)" ]; then note "already there, $(get blend.pool)"; return; fi
  local id
  id=$(stellar contract invoke --quiet --id "$(get blend.poolFactory)" --source "$SRC" \
    --network "$NET" -- deploy --admin "$ME" --name '"Agama Stocks"' \
      --salt "$(salt_of lending-pool/v1)" --oracle "$(get contracts.oracle)" \
      --backstop_take_rate 0 --max_positions 4 --min_collateral 0 | tr -d '"')
  put blend.pool "$id"
  note "pool $id"
}

# -------------------------------------------------------------- reserves ----

# Blend's factors are seven decimal fixed point: 7_500_000 is 75%.
#
# The stock reserves carry a c_factor of 75% where the core targets 70%. The
# gap is deliberate: Blend's own ceiling has to sit ABOVE the one the agents
# hold, or a position at its target is a position Blend already considers maxed
# out, and the next rebalance up has nowhere to go.
reserve_json() {
  python3 -I -c "
import json
print(json.dumps({
  'c_factor': $1, 'decimals': 7, 'enabled': True, 'index': 0,
  'l_factor': $2, 'max_util': 9_500_000,
  'r_base': 100_000, 'r_one': 500_000, 'r_two': 5_000_000, 'r_three': 15_000_000,
  # A string, not a number: as a bare integer the CLI parses this as the wrong
  # XDR type and rejects the whole struct without naming the field.
  'reactivity': 1_000, 'supply_cap': '1000000000000000000',
  'util': 7_500_000,
}))
"
}

reserves2() {
  say "Reserves"
  local pool; pool=$(get blend.pool)
  local specs; specs="USDC|$(get blend.usdc)|0|10000000"
  specs="$specs
$(python3 -I -c "
import json
d=json.load(open('$OUT'))['stocks']
print('\n'.join(f'{k}|{v}|7500000|10000000' for k,v in d.items()))
")"
  echo "$specs" | while IFS='|' read -r label asset cf lf; do
    if [ -n "$(get "blend.reserves.$label")" ]; then note "$label already a reserve"; continue; fi
    stellar contract invoke --quiet --id "$pool" --source "$SRC" --network "$NET" \
      -- queue_set_reserve --asset "$asset" --metadata "$(reserve_json "$cf" "$lf")" >/dev/null
    local ix
    ix=$(stellar contract invoke --quiet --id "$pool" --source "$SRC" --network "$NET" \
      -- set_reserve --asset "$asset" | tr -d '"')
    put "blend.reserves.$label" "$ix"
    note "$label index $ix"
  done
}

# ------------------------------------------------------------------ fund ----

# LP into the backstop, then the pool can be switched on.
#
# Blend's threshold reads the BLND and USDC sitting BEHIND the LP, not the
# share count, so what matters is that the comet is deep rather than that we
# hold many shares of it.
fund() {
  say "Funding the backstop"
  local bs comet_id pool
  bs=$(get blend.backstop); comet_id=$(get blend.comet); pool=$(get blend.pool)
  local lp
  lp=$(stellar contract invoke --quiet --id "$comet_id" --source "$SRC" --network "$NET" \
    -- balance --id "$ME" | tr -d '"')
  note "we hold $lp LP"
  if [ "$(get blend.backstopFunded)" != "yes" ]; then
    local horizon; horizon=$(( $(current_ledger) + 500000 ))
    inv "$comet_id" approve --from "$ME" --spender "$bs" --amount "$lp" \
        --expiration_ledger "$horizon" >/dev/null
    inv "$bs" deposit --from "$ME" --pool_address "$pool" --amount "$lp" >/dev/null
    put blend.backstopFunded yes
    note "deposited"
  fi
  stellar contract invoke --quiet --id "$bs" --source "$SRC" --network "$NET" \
    -- pool_data --pool "$pool" | tail -1
  inv "$pool" set_status --pool_status 0 >/dev/null
  note "pool status $(inv "$pool" get_config | python3 -I -c "import json,sys;print(json.load(sys.stdin)['status'])")"
}

case "${1:-all}" in
  tokens) tokens ;;
  comet) comet ;;
  stack) stack ;;
  pool) pool2 ;;
  reserves) reserves2 ;;
  fund) fund ;;
  all) tokens; comet; stack; pool2; reserves2; fund ;;
  *) echo "unknown stage: $1" >&2; exit 2 ;;
esac
