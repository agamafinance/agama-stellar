#!/usr/bin/env python3
"""The keeper: relay prices, then let the agents act on them.

Two jobs, in this order, because the second is worthless without the first.

  1. Fetch RedStone's signed reports and push them on chain. Nothing here
     signs anything: the payload is the gateway's bytes, verified before
     sending by recovering each signer locally. The contract does the same
     recovery again and will not take our word for it.

  2. Walk the live positions and act. Rebalance where the price has moved the
     LTV off target, compound where yield is sitting loose, liquidate where a
     position is past its threshold. All three are permissionless on chain;
     the keeper has no special rights, it is just the first to notice.

Position discovery is by event. The core emits `opened` and `closed`, so the
chain is the index and nothing needs a registry. Testnet RPC only keeps a few
hours of events, so what is found gets written to disk and unioned with it
next run: losing track of a position would mean a position nobody rebalances.

    python3 keeper/run.py prices      push reports, nothing else
    python3 keeper/run.py agents      act on what is already on chain
    python3 keeper/run.py once        both, once
    python3 keeper/run.py watch       both, every few minutes
"""

import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import redstone
from chain import Chain, ChainError

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "deployments" / "testnet.json"
SEEN = ROOT / "deployments" / "positions.json"
MARKETS = ROOT / "deployments" / "markets.json"

# How many signers to carry per feed. The oracle wants three to agree, and
# every signature is a secp256k1 recovery inside one transaction, so sending
# all five would burn CPU budget to no effect.
SIGNERS = 3

# Drift worth a transaction. Rebalancing on every tick would spend more on
# fees than the position gains, so an agent waits for real movement.
DRIFT_BPS = 50


def load(path, default=None):
    if not path.exists():
        return default if default is not None else {}
    return json.loads(path.read_text())


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


def feed_names():
    """What RedStone calls each of our markets.

    Not always the ticker. RedStone carries SPY only as SPY---PRE_AFTER and
    BENJI as BENJI_ETHEREUM_FUNDAMENTAL, and the on-chain feed id has to be
    the name inside the signed payload, not the one we would have chosen.
    """
    return {m["symbol"]: m.get("redstone", m["feed"]) for m in load(MARKETS)["markets"]}


def say(s):
    print(f"\n\033[1m{s}\033[0m")


def note(s):
    print(f"  {s}")


# ------------------------------------------------------------------ prices ----


def push_prices(ch, dep):
    say("Prices")
    oracle = dep["contracts"]["oracle"]
    names = feed_names()

    data = redstone.fetch()
    note(f"gateway carries {len(data)} feeds")

    # Only push what this oracle is actually bound to. A payload full of
    # feeds it does not know is rejected wholesale as NoKnownFeed.
    bound = {}
    for sym, addr in dep["stocks"].items():
        on_chain = ch.call(oracle, "feed", asset={"Stellar": addr})
        if on_chain:
            bound[sym] = (addr, bytes.fromhex(on_chain).rstrip(b"\0").decode())
    usdc = dep["blend"]["usdc"]
    usdc_feed = ch.call(oracle, "feed", asset={"Stellar": usdc})
    if usdc_feed:
        bound["USDC"] = (usdc, bytes.fromhex(usdc_feed).rstrip(b"\0").decode())

    pushed, skipped = 0, []
    for sym, (addr, on_chain_feed) in sorted(bound.items()):
        pkgs = data.get(on_chain_feed)
        if not pkgs:
            wanted = names.get(sym)
            skipped.append(f"{sym} (oracle wants {on_chain_feed}"
                           + (f", gateway has {wanted}" if wanted and wanted != on_chain_feed else "")
                           + ")")
            continue
        payload = redstone.build(pkgs[:SIGNERS])
        try:
            applied = ch.call(oracle, "push", payload=payload)
            price = ch.call(oracle, "lastprice", asset={"Stellar": addr})
            note(f"{sym:7} {int(price['price'])/1e7:>12,.4f}  from {applied} feed(s) signed")
            pushed += 1
        except ChainError as e:
            code = e.contract_error()
            note(f"{sym:7} refused, contract error {code}")

    for s in skipped:
        note(f"skipped {s}")
    return pushed


# ------------------------------------------------------------------ agents ----


def live_positions(ch, dep):
    """Every position the chain has told us about and not told us to forget."""
    seen = load(SEEN, {"positions": {}})
    core = dep["contracts"]["core"]

    # The CLI decodes an event against the contract's own spec, so this reads
    # field names rather than positions in a topic array. Worth knowing: the
    # shape is {event_name, prefix_topics, params}, and the indexed fields are
    # in params too, not only in the topics.
    # Each decision carries the ledger it came from, and an older event never
    # overrides a newer one. Without that, an `opened` still inside the RPC
    # window keeps resurrecting a position that has since been closed, and the
    # keeper rediscovers the same dead position on every pass. A position
    # address is deterministic per owner, market and product, so the same
    # address genuinely can reopen later, which is why this compares ledgers
    # instead of just refusing to reopen.
    for ev in ch.events(core):
        name = ev.get("event_name")
        params = ev.get("params") or {}
        pos = params.get("position")
        if not pos or name not in ("Opened", "Closed"):
            continue
        at = int(ev.get("ledger") or 0)
        known = seen["positions"].get(pos, {})
        if at < int(known.get("at") or 0):
            continue
        if name == "Opened":
            seen["positions"][pos] = {
                "owner": params.get("owner"),
                "market": params.get("market"),
                "product": params.get("product"),
                "target_bps": params.get("target_bps"),
                "open": True,
                "at": at,
            }
        else:
            known.update({"open": False, "at": at})
            seen["positions"][pos] = known

    save(SEEN, seen)
    return [p for p, v in seen["positions"].items() if v.get("open")]


def run_agents(ch, dep):
    say("Agents")
    core = dep["contracts"]["core"]
    usdc = dep["blend"]["usdc"]
    me = ch.call(usdc, "balance", id=ch.source) and ch.source

    positions = live_positions(ch, dep)
    if not positions:
        note("no open positions")
        return 0

    acted = 0
    for pos in positions:
        try:
            h = ch.call(core, "health", position=pos)
        except ChainError as e:
            note(f"{pos[:8]} health unreadable, contract error {e.contract_error()}")
            continue
        # The position's OWN target, not the market's ceiling. They coincide
        # for an Earn opened at the maximum and they do not for an Amplify: a
        # 3x loop carries 66.66% against a 70% market, so comparing against
        # the ceiling makes the keeper see 3.34% of drift that is not there
        # and send a rebalance every pass that correctly does nothing. The
        # contract was always right; only the decision to call it was wrong.
        target = int(ch.call(pos, "target") or h["max_ltv"])
        ltv, threshold = int(h["ltv"]), int(h["threshold"])
        loose = int(ch.call(usdc, "balance", id=pos) or 0)
        label = f"{pos[:8]} ltv {ltv/100:.2f}% target {target/100:.2f}%"

        # A position with no collateral is a closed one whose `closed` event
        # has aged out of the RPC window. Without this the keeper reads its
        # LTV as zero, decides it is 70% off target, and sends a rebalance
        # that can do nothing, every pass, forever. Mark it and stop looking.
        if int(h["collateral"]) == 0 and int(h["debt"]) == 0:
            note(f"{pos[:8]} empty, closing the book on it")
            seen = load(SEEN, {"positions": {}})
            if pos in seen["positions"]:
                seen["positions"][pos]["open"] = False
                seen["positions"][pos]["at"] = ch.ledger()
                save(SEEN, seen)
            continue

        if ltv >= threshold:
            acted += do(ch, core, "liquidate", pos, f"{label}: past {threshold/100:.2f}%, liquidating")
        elif abs(ltv - target) >= DRIFT_BPS:
            acted += do(ch, core, "rebalance", pos, f"{label}: off by {abs(ltv-target)/100:.2f}%, rebalancing")
        elif loose > 0:
            acted += do(ch, core, "compound", pos, f"{label}: {loose/1e7:,.2f} loose, compounding")
        else:
            note(f"{label}: nothing to do")
    return acted


def do(ch, core, fn, pos, why):
    note(why)
    try:
        ch.call(core, fn, agent=ch.source, position=pos)
        return 1
    except ChainError as e:
        note(f"  refused, contract error {e.contract_error()}")
        return 0


# -------------------------------------------------------------------- main ----


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "once"
    dep = load(OUT)
    ch = Chain(source=sys.argv[2] if len(sys.argv) > 2 else "agama")

    if mode == "prices":
        push_prices(ch, dep)
    elif mode == "agents":
        run_agents(ch, dep)
    elif mode == "once":
        push_prices(ch, dep)
        run_agents(ch, dep)
    elif mode == "watch":
        while True:
            try:
                push_prices(ch, dep)
                run_agents(ch, dep)
            except Exception as e:  # noqa: BLE001 - a keeper that dies is worse
                print(f"  pass failed: {e}")
            time.sleep(300)
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
