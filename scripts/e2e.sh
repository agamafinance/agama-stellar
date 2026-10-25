#!/usr/bin/env bash
# One position, start to finish, on Stellar testnet. Real transactions.
#
# This is the test that cannot be faked by a mock: every number below is read
# back off the chain after the call that was supposed to change it. Where a
# number is asserted rather than printed, the script stops if it is wrong.
set -euo pipefail
cd "$(dirname "$0")/.."

NET=testnet
SRC=${STELLAR_ACCOUNT:-agama}
OUT=deployments/testnet.json
# A fresh user every run, and not for tidiness: the faucet is rate limited per
# address, so a reused one has nothing to deposit on the second pass, and the
# core owns the stocks now so nothing can top it up by hand. A new address is
# also the only way to prove the deposit path works from zero rather than from
# whatever the last run left behind.
USER_KEY=${E2E_USER:-agama-e2e-$(date +%s)}
SYM=${E2E_SYMBOL:-TSLAx}

get() { python3 -I -c "
import json,sys
d=json.load(open('$OUT'))
for k in '$1'.split('.'):
    d = d.get(k) if isinstance(d, dict) else None
    if d is None: print(''); sys.exit()
print(d)
"; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
d7() { python3 -I -c "print(f'{int(\"${1:-0}\")/1e7:,.4f}')"; }

CORE=$(get contracts.core)
ORACLE=$(get contracts.oracle)
VAULT=$(get contracts.vault)
USDC=$(get blend.usdc)
STOCK=$(get "stocks.$SYM")
ME=$(stellar keys address "$SRC")

as_user() { stellar contract invoke --quiet --id "$1" --source "$USER_KEY" --network "$NET" -- "${@:2}"; }
as_admin() { stellar contract invoke --quiet --id "$1" --source "$SRC" --network "$NET" -- "${@:2}"; }

want() { # want <label> <got> <expected>
  if [ "$2" = "$3" ]; then note "$1 $(d7 "$2")"; else
    printf '  \033[31mFAIL\033[0m %s: got %s, expected %s\n' "$1" "$2" "$3"; exit 1
  fi
}
near() { # near <label> <got> <expected> <tolerance>
  python3 -I -c "
import sys
got, exp, tol = int('$2'), int('$3'), int('$4')
if abs(got - exp) > tol:
    print(f'  \033[31mFAIL\033[0m $1: got {got}, expected {exp} +/- {tol}'); sys.exit(1)
print(f'  $1 {got/1e7:,.4f}')
"
}

say "Who is involved"
note "core    $CORE"
note "stock   $SYM $STOCK"
note "vault   $VAULT"

# ---- a user with nothing ----

stellar keys address "$USER_KEY" >/dev/null 2>&1 \
  || stellar keys generate "$USER_KEY" --network "$NET" --fund >/dev/null
# A deposit deploys a contract, and on testnet the rent for that runs well
# past the 10,000 XLM friendbot hands out. Topped up from merged accounts
# until it can afford its own position.
U=$(stellar keys address "$USER_KEY")
BAL=$(curl -s "https://horizon-testnet.stellar.org/accounts/$U" \
  | python3 -I -c "import json,sys;print(int(float(json.load(sys.stdin)['balances'][0]['balance'])))" 2>/dev/null || echo 0)
if [ "$BAL" -lt 100000 ]; then
  for i in $(seq 1 12); do
    k="e2e-top-$RANDOM"
    stellar keys generate "$k" --network "$NET" --fund >/dev/null 2>&1 \
      && stellar tx new account-merge --source "$k" --network "$NET" --account "$U" >/dev/null 2>&1
  done
fi
USER=$(stellar keys address "$USER_KEY")
say "The user"
note "$USER"

say "Faucet"
as_user "$STOCK" faucet --to "$USER" >/dev/null 2>&1 || note "already dripped this hour"
HELD=$(as_user "$STOCK" balance --id "$USER" | tr -d '"')
note "holds $(d7 "$HELD") $SYM"

# ---- the deposit ----

say "Deposit"
PRICE=$(as_admin "$ORACLE" lastprice --asset "{\"Stellar\":\"$STOCK\"}" \
  | python3 -I -c "import json,sys;print(json.load(sys.stdin)['price'])")
note "price $(d7 "$PRICE")"

POS=$(stellar contract invoke --quiet --id "$CORE" --source "$USER_KEY" --network "$NET" \
  -- earn_deposit --owner "$USER" --token "$STOCK" --amount "$HELD" --target_bps 7000 \
  | tr -d '"')
note "position $POS"

pos() { stellar contract invoke --quiet --id "$POS" --source "$SRC" --network "$NET" -- "$@"; }

COLL=$(pos collateral | tr -d '"')
DEBT=$(pos debt | tr -d '"')
EXPECTED_DEBT=$(python3 -I -c "print(int('$COLL') * int('$PRICE') // 10_000_000 * 7000 // 10_000)")
want "collateral" "$COLL" "$HELD"
near "debt at 70% of value" "$DEBT" "$EXPECTED_DEBT" 100

VAULT_SHARES=$(as_admin "$VAULT" shares --of "$POS" | tr -d '"')
near "in the vault" "$VAULT_SHARES" "$DEBT" 100
LOOSE=$(as_admin "$USDC" balance --id "$POS" | tr -d '"')
want "left loose in the position" "$LOOSE" "0"

say "The deposit is one call, and it ends with nothing idle"
note "borrowed and deposited in the same transaction"

# ---- a rise ----

say "A rise, answered by an agent"
# 10% up, inside the oracle's max_move_bps so one report can carry it.
UP=$(python3 -I -c "print(int('$PRICE') * 110 // 100)")
as_admin "$ORACLE" set_price --asset "{\"Stellar\":\"$STOCK\"}" --price "$UP" >/dev/null
note "price $(d7 "$UP")"

AGENT=${E2E_AGENT:-$SRC}
as_admin "$CORE" rebalance --agent "$ME" --position "$POS" >/dev/null
DEBT2=$(pos debt | tr -d '"')
COLL2=$(pos collateral | tr -d '"')
EXPECTED2=$(python3 -I -c "print(int('$COLL2') * int('$UP') // 10_000_000 * 7000 // 10_000)")
near "debt back at 70%" "$DEBT2" "$EXPECTED2" 200
want "collateral untouched" "$COLL2" "$COLL"
VS2=$(as_admin "$VAULT" shares --of "$POS" | tr -d '"')
python3 -I -c "
a, b = int('$VAULT_SHARES'), int('$VS2')
print(f'  the extra borrowing went to the vault: {a/1e7:,.2f} -> {b/1e7:,.2f}')
assert b > a, 'vault position did not grow'
"
TOUCH=$(pos last_touch | python3 -I -c "import json,sys;d=json.load(sys.stdin);print(d['action'],d['agent'][:8])" 2>/dev/null || echo "none")
note "signed by $TOUCH"

# ---- a fall ----

say "A fall, answered out of the buffer"
DOWN=$(python3 -I -c "print(int('$UP') * 90 // 100)")
as_admin "$ORACLE" set_price --asset "{\"Stellar\":\"$STOCK\"}" --price "$DOWN" >/dev/null
note "price $(d7 "$DOWN")"

BUF_BEFORE=$(as_admin "$CORE" buffer | tr -d '"')
QUEUE_BEFORE=$(as_admin "$VAULT" open_queue | python3 -I -c "import json,sys;print(len(json.load(sys.stdin)))")
as_admin "$CORE" rebalance --agent "$ME" --position "$POS" >/dev/null

DEBT3=$(pos debt | tr -d '"')
COLL3=$(pos collateral | tr -d '"')
EXPECTED3=$(python3 -I -c "print(int('$COLL3') * int('$DOWN') // 10_000_000 * 7000 // 10_000)")
near "debt back at 70%" "$DEBT3" "$EXPECTED3" 200
want "not one share sold" "$COLL3" "$COLL"

BUF_AFTER=$(as_admin "$CORE" buffer | tr -d '"')
QUEUE_AFTER=$(as_admin "$VAULT" open_queue | python3 -I -c "import json,sys;print(len(json.load(sys.stdin)))")
python3 -I -c "
b, a = int('$BUF_BEFORE'), int('$BUF_AFTER')
print(f'  buffer paid it: {b/1e7:,.2f} -> {a/1e7:,.2f}')
assert a < b, 'the buffer did not pay'
assert $QUEUE_AFTER > $QUEUE_BEFORE, 'no withdrawal was filed to refill it'
print(f'  withdrawal filed to refill it: {$QUEUE_BEFORE} -> {$QUEUE_AFTER} in the queue')
"

say "What this proves"
note "a fall is answered NOW, out of the buffer, and the queue refills it later"
note "the alternative is selling the stock the user came to keep"
