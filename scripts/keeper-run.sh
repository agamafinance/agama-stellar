#!/usr/bin/env bash
# One keeper pass: the prices, then the agents.
#
# RedStone's public gateways are closing, so the price half can fail for a
# reason that is nobody's bug. When it does, the markets are priced from a
# public quote API by the oracle's admin instead, which keeps the demo alive
# and is not the same thing as a signed report: see keeper/fallback_prices.py.
# Set REDSTONE_GATEWAY and REDSTONE_API_KEY and none of this runs.
set -uo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if python3 keeper/run.py prices; then
  :
else
  say "RedStone did not answer, pricing from the public quotes instead"
  python3 keeper/fallback_prices.py
fi

python3 keeper/run.py agents
