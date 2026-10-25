#!/usr/bin/env bash
# One Amplify, start to finish, on Stellar testnet. Real transactions.
#
# Earn and Amplify are the same machinery pointed at different ends of the
# same trade: Earn borrows against your stock and puts the dollars to work,
# Amplify borrows against your stock and buys more of it. What this run has to
# show is that the multiple asked for is the multiple held, which is the thing
# a single borrow against the deposit cannot do.
set -euo pipefail
cd "$(dirname "$0")/.."

NET=testnet
SRC=${STELLAR_ACCOUNT:-agama}
OUT=deployments/testnet.json
SYM=${E2E_SYMBOL:-NVDAx}
LEV=${E2E_LEVERAGE:-30000}
USER_KEY=${E2E_USER:-agama-amp-$(date +%s)}

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
near() {
  python3 -I -c "
import sys
got, exp, tol = int('$2'), int('$3'), int('$4')
if abs(got - exp) > tol:
    print(f'  \033[31mFAIL\033[0m $1: got {got}, expected {exp} +/- {tol}'); sys.exit(1)
print(f'  $1 {got/1e7:,.4f}')
"
}

CORE=$(get contracts.core)
ORACLE=$(get contracts.oracle)
STOCK=$(get "stocks.$SYM")
ME=$(stellar keys address "$SRC")

as_user() { stellar contract invoke --quiet --id "$1" --source "$USER_KEY" --network "$NET" -- "${@:2}"; }
as_admin() { stellar contract invoke --quiet --id "$1" --source "$SRC" --network "$NET" -- "${@:2}"; }

say "The user"
stellar keys address "$USER_KEY" >/dev/null 2>&1 \
  || stellar keys generate "$USER_KEY" --network "$NET" --fund >/dev/null
USER=$(stellar keys address "$USER_KEY")
BAL=$(curl -s "https://horizon-testnet.stellar.org/accounts/$USER" \
  | python3 -I -c "import json,sys;print(int(float(json.load(sys.stdin)['balances'][0]['balance'])))" 2>/dev/null || echo 0)
if [ "$BAL" -lt 100000 ]; then
  for i in $(seq 1 12); do
    k="amp-top-$RANDOM"
    stellar keys generate "$k" --network "$NET" --fund >/dev/null 2>&1 \
      && stellar tx new account-merge --source "$k" --network "$NET" --account "$USER" >/dev/null 2>&1
  done
fi
note "$USER"

as_user "$STOCK" faucet --to "$USER" >/dev/null 2>&1 || note "already dripped this hour"
HELD=$(as_user "$STOCK" balance --id "$USER" | tr -d '"')
PRICE=$(as_admin "$ORACLE" lastprice --asset "{\"Stellar\":\"$STOCK\"}" \
  | python3 -I -c "import json,sys;print(json.load(sys.stdin)['price'])")
note "holds $(d7 "$HELD") $SYM at $(d7 "$PRICE")"

# ---- the loop ----

say "Amplify $(python3 -I -c "print(f'{$LEV/10000:.2f}')")x"
POS=$(stellar contract invoke --quiet --id "$CORE" --source "$USER_KEY" --network "$NET" \
  -- amplify_open --owner "$USER" --token "$STOCK" --amount "$HELD" --leverage_bps "$LEV" \
  | tr -d '"')
note "position $POS"

pos() { stellar contract invoke --quiet --id "$POS" --source "$SRC" --network "$NET" -- "$@"; }

COLL=$(pos collateral | tr -d '"')
DEBT=$(pos debt | tr -d '"')
WANT_COLL=$(python3 -I -c "print(int('$HELD') * $LEV // 10000)")
WANT_DEBT=$(python3 -I -c "print((int('$WANT_COLL') - int('$HELD')) * int('$PRICE') // 10_000_000)")
near "stock held, deposit times the multiple" "$COLL" "$WANT_COLL" 10
near "borrowed to buy the rest" "$DEBT" "$WANT_DEBT" 200

H=$(as_admin "$CORE" health --position "$POS")
LTV=$(echo "$H" | python3 -I -c "import json,sys;print(json.load(sys.stdin)['ltv'])")
MAXLTV=$(echo "$H" | python3 -I -c "import json,sys;print(json.load(sys.stdin)['max_ltv'])")
python3 -I -c "
ltv, mx, lev = $LTV, $MAXLTV, $LEV
want = (lev - 10000) * 10000 // lev
print(f'  LTV {ltv/100:.2f}%, which is (L-1)/L for {lev/10000:.2f}x, under the {mx/100:.2f}% ceiling')
assert abs(ltv - want) <= 2, f'LTV {ltv} is not {want}'
assert ltv <= mx, 'over the market ceiling'
"
EXPOSURE=$(python3 -I -c "print(f'{int(\"$COLL\")/int(\"$HELD\"):.2f}')")
note "exposure $EXPOSURE x on a deposit of $(d7 "$HELD")"

# ---- a move, held by an agent ----

say "The price rises, the agent holds the multiple"
UP=$(python3 -I -c "print(int('$PRICE') * 108 // 100)")
as_admin "$ORACLE" set_price --asset "{\"Stellar\":\"$STOCK\"}" --price "$UP" >/dev/null
note "price $(d7 "$UP")"
as_admin "$CORE" rebalance --agent "$ME" --position "$POS" >/dev/null

COLL2=$(pos collateral | tr -d '"')
LTV2=$(as_admin "$CORE" health --position "$POS" | python3 -I -c "import json,sys;print(json.load(sys.stdin)['ltv'])")
python3 -I -c "
print(f'  LTV back to {$LTV2/100:.2f}%')
assert abs($LTV2 - $LTV) <= 20, 'the agent did not hold the level'
print(f'  and it held it by BUYING: {int(\"$COLL\")/1e7:,.4f} -> {int(\"$COLL2\")/1e7:,.4f} $SYM')
assert int('$COLL2') > int('$COLL'), 'a rise should have bought more stock'
"

# ---- unwinding ----

say "Closing"
BEFORE=$(as_user "$STOCK" balance --id "$USER" | tr -d '"')
KEPT=$(stellar contract invoke --quiet --id "$CORE" --source "$USER_KEY" --network "$NET" \
  -- amplify_close --owner "$USER" --token "$STOCK" | tr -d '"')
AFTER=$(as_user "$STOCK" balance --id "$USER" | tr -d '"')
note "kept $(d7 "$KEPT") $SYM"
python3 -I -c "
kept, before, after, held = int('$KEPT'), int('$BEFORE'), int('$AFTER'), int('$HELD')
assert after - before == kept, 'the stock did not reach the wallet'
print(f'  the wallet has it: {before/1e7:,.4f} -> {after/1e7:,.4f}')
print(f'  started with {held/1e7:,.4f}, kept {kept/1e7:,.4f} after the debt was repaid in stock')
"
want "" "" "" 2>/dev/null || true
DEBT3=$(pos debt | tr -d '"')
[ "$DEBT3" = "0" ] && note "the position owes nothing" || { echo "  FAIL still owes $DEBT3"; exit 1; }

say "Done"
note "a multiple asked for, reached, held through a move, and unwound"
