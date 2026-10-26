#!/usr/bin/env bash
# Everything, checked in one pass.
#
# Five layers, in the order they depend on each other: the contracts' own
# tests, both products' whole life on chain, the keeper that feeds and tends
# them, and the app that reads it all back. A green run means the thing works
# from a Rust assertion all the way to an HTTP response.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. The contracts"
TESTS=$(cargo test 2>&1 | grep -c "test result: ok")
TOTAL=$(cargo test 2>&1 | grep "test result: ok" | sed 's/.*ok. \([0-9]*\) passed.*/\1/' | paste -sd+ - | bc)
if [ "$TESTS" = "5" ]; then ok "5 crates, $TOTAL tests"; else bad "only $TESTS crates green"; fi
BUILT=$(stellar contract build 2>&1 | grep -c "Build Complete")
if [ "$BUILT" = "5" ]; then ok "5 wasms build"; else bad "only $BUILT wasms build"; fi

say "2. What is live"
# Each one is asked a real question. `-- --help` is not a contract call: the
# CLI prints the interface and exits non-zero without touching the network,
# so a check built on it fails for five contracts that are perfectly alive.
for pair in "contracts.core:core:version" "contracts.oracle:oracle:decimals" \
            "contracts.vault:vault:rate" "blend.pool:pool:get_config" \
            "blend.backstop:backstop:backstop_token"; do
  IFS=':' read -r path label fn <<<"$pair"
  id=$(python3 -I -c "
import json
d=json.load(open('deployments/testnet.json'))
for k in '$path'.split('.'): d=d[k]
print(d)")
  answer=$(stellar contract invoke --quiet --id "$id" --source agama --network testnet \
    -- "$fn" 2>/dev/null | tr -d '"' | cut -c1-40)
  if [ -n "$answer" ]; then
    ok "$label answers $fn: $answer"
  else
    bad "$label did not answer $fn, $id"
  fi
done

STATUS=$(stellar contract invoke --quiet --id "$(python3 -I -c "
import json;print(json.load(open('deployments/testnet.json'))['blend']['pool'])")" \
  --source agama --network testnet -- get_config \
  | python3 -I -c "import json,sys;print(json.load(sys.stdin)['status'])")
if [ "$STATUS" = "0" ]; then ok "pool status 0, borrowing open"; else bad "pool status $STATUS"; fi

MKTS=$(stellar contract invoke --quiet --id "$(python3 -I -c "
import json;print(json.load(open('deployments/testnet.json'))['contracts']['core'])")" \
  --source agama --network testnet -- markets | python3 -I -c "import json,sys;print(len(json.load(sys.stdin)))")
if [ "$MKTS" = "10" ]; then ok "10 markets registered"; else bad "$MKTS markets"; fi

say "3. An Earn, on chain"
if ./scripts/e2e.sh >/tmp/agama-e2e.log 2>&1; then
  ok "deposit, rise, fall, yield, compound, close"
  grep -E "^  (collateral|debt at|not one share|buffer paid|bought|returned)" /tmp/agama-e2e.log \
    | sed 's/^/    /'
else
  bad "the position run failed, see /tmp/agama-e2e.log"
  tail -5 /tmp/agama-e2e.log | sed 's/^/    /'
fi

say "4. An Amplify, on chain"
if ./scripts/amplify-e2e.sh >/tmp/agama-amp.log 2>&1; then
  ok "a multiple asked for, reached, held through a move, and unwound"
  grep -E "^  (stock held|borrowed to buy|LTV |exposure|and it held|kept |started with)" /tmp/agama-amp.log \
    | sed 's/^/    /'
else
  bad "the amplify run failed, see /tmp/agama-amp.log"
  tail -5 /tmp/agama-amp.log | sed 's/^/    /'
fi

say "5. The keeper"
if python3 keeper/run.py prices >/tmp/agama-prices.log 2>&1; then
  SIGNED=$(grep -c "signed" /tmp/agama-prices.log)
  ok "$SIGNED feeds pushed from signed RedStone reports"
  grep "feed(s) signed" /tmp/agama-prices.log | sed 's/^/  /'
else
  bad "pushing prices failed"
fi
if python3 keeper/run.py agents >/tmp/agama-agents.log 2>&1; then
  ok "agents ran over every open position"
  grep -E "ltv|empty" /tmp/agama-agents.log | sed 's/^/  /'
else
  bad "the agents failed"
fi

say "6. The app"
for path in "/stellar-rwa" "/stellar-rwa/amplify" "/stellar-rwa/portfolio" "/stellar-rwa/faucet" \
            "/stellar-rwa/api/snapshot"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3010$path")
  if [ "$code" = "200" ]; then ok "$path"; else bad "$path returned $code"; fi
done
N=$(curl -s http://localhost:3010/stellar-rwa/api/snapshot | python3 -I -c "
import json,sys
d=json.load(sys.stdin)
print(sum(1 for m in d['markets'] if int(m['price']) > 0 and m['fresh']))")
if [ "$N" = "10" ]; then ok "all 10 markets priced and fresh through the app"; else bad "only $N priced"; fi

# The passkey account's whole path is its own script, because it needs a
# browser and Nido's relayer: node scripts/nido/e2e.mjs.

say "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
