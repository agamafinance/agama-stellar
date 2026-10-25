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
      --expiration_ledger 4000000 >/dev/null
  inv "$usdc" approve --from "$ME" --spender "$factory" --amount 2500000000000 \
      --expiration_ledger 4000000 >/dev/null

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

case "${1:-all}" in
  tokens) tokens ;;
  comet) comet ;;
  stack) stack ;;
  all) tokens; comet; stack ;;
  *) echo "unknown stage: $1" >&2; exit 2 ;;
esac
