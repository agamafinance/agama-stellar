"""Admin-set prices, for the days RedStone's gateway will not open.

RedStone is switching its public gateways off: 403 inside windows that grow
every day, nothing at all from 2026-10-29, and an authenticated gateway (a
host and a key they issue) in their place. Until this deployment has one, the
oracle has no signed report to verify and the markets go stale in a day, which
takes borrowing down with them.

So this is the stopgap, and it is a stopgap: the same numbers, from a public
quote API, set by the oracle's admin rather than proved by three signatures.
The oracle still refuses a move beyond its cap, and every price it writes
still carries the ledger's timestamp, but nothing here is verified on chain.
Run `python3 keeper/run.py prices` instead the moment a gateway key exists.

    python3 keeper/fallback_prices.py            # every market
    python3 keeper/fallback_prices.py TSLAx SPYx # some of them
"""

import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NETWORK = os.environ.get("STELLAR_NETWORK", "testnet")
SOURCE = os.environ.get("STELLAR_ACCOUNT", "agama")
UNIT = 10_000_000

# What each market is, where the public quote lives. BENJI is a money fund:
# its NAV is a dollar by construction, not a quote.
QUOTES = {
    "TSLAx": "TSLA",
    "NVDAx": "NVDA",
    "AAPLx": "AAPL",
    "MSFTx": "MSFT",
    "AMZNx": "AMZN",
    "GOOGLx": "GOOGL",
    "METAx": "META",
    "SPYx": "SPY",
    "GOLDx": "GC=F",
    "BENJI": None,
}
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d"


def quote(symbol):
    """The last price a public chart carries, in dollars."""
    request = urllib.request.Request(
        CHART.format(urllib.parse.quote(symbol)),
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(request, timeout=20) as r:
        meta = json.load(r)["chart"]["result"][0]["meta"]
    price = meta.get("regularMarketPrice")
    if not price:
        raise RuntimeError(f"no price for {symbol}")
    return float(price)


def set_price(oracle, token, price):
    out = subprocess.run(
        [
            "stellar", "contract", "invoke", "--quiet",
            "--id", oracle, "--source", SOURCE, "--network", NETWORK, "--send=yes",
            "--", "set_price",
            "--asset", json.dumps({"Stellar": token}),
            "--price", str(price),
        ],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip().split("\n")[-1][:160])


def main():
    deployment = json.loads((ROOT / "deployments" / "testnet.json").read_text())
    oracle = deployment["contracts"]["oracle"]
    wanted = sys.argv[1:] or list(QUOTES)
    print("Admin prices, because RedStone's gateway is shut. Not signed, not verified.")
    for symbol in wanted:
        token = deployment["stocks"].get(symbol)
        if not token:
            print(f"  {symbol}: not a market here")
            continue
        try:
            dollars = 1.0 if QUOTES.get(symbol) is None else quote(QUOTES[symbol])
            set_price(oracle, token, int(round(dollars * UNIT)))
            print(f"  {symbol}: ${dollars:,.2f}")
        except Exception as e:  # noqa: BLE001 - one bad feed must not stop the rest
            print(f"  {symbol}: {e}")


if __name__ == "__main__":
    main()
