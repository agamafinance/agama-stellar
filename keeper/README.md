# The keeper

Two jobs, in this order, because the second is worthless without the first.

```
python3 keeper/run.py prices     push signed reports, nothing else
python3 keeper/run.py agents     act on what is already on chain
python3 keeper/run.py once       both, once
python3 keeper/run.py watch      both, every five minutes
```

## Prices

Nothing here signs anything. The payload is the gateway's own bytes,
reassembled into the layout the contract parses, and then checked locally by
recovering each signer and comparing to the address the gateway named. If a
single byte of the layout were wrong the recovery would land somewhere else,
which makes that check worth more than a unit test: it is the same arithmetic
the contract does, and the contract does it again rather than taking the
keeper's word.

The layout, read from the end:

```
payload = [pkg_1..pkg_N][package count 2B][metadata][metadata size 3B]
          [marker 9B = 0x000002ed57011e0000]
pkg     = [point_1..point_M][timestamp 6B ms][value size 4B]
          [point count 3B][signature 65B]
point   = [feed id 32B right-padded ASCII][value 32B big endian]
```

Values are integers at eight decimals. That is not a convention we chose, it
is what the signature covers; the oracle rescales to seven on the way in.

Three signers per feed, not five. The oracle wants three to agree and every
signature is a secp256k1 recovery inside one transaction, so the other two
would burn CPU budget to no effect.

### The two markets that stay admin-priced

The on-chain feed id has to be the name inside the signed payload. RedStone
carries SPY only as `SPY---PRE_AFTER` and BENJI as
`BENJI_ETHEREUM_FUNDAMENTAL`, and the live oracle was bound to `SPY` and
`BENJI` before that was known. `retarget_feed` exists in the source now, but
the deployed instance predates it, and the chain of redeploys needed to fix
two prices runs oracle, core, tokens, reserves, pool, backstop. The other
eight markets and the dollar run on signed reports.

## Agents

Rebalance where the price has moved the LTV off target by more than 50 bps,
compound where yield is sitting loose, liquidate where a position is past its
threshold. All three are permissionless on chain. The keeper has no special
rights; it is just the first to notice.

Position discovery is by event: the core emits `opened` and `closed`, so the
chain is the index and nothing needs a registry. Two things that took a pass
each to get right:

- Testnet RPC keeps only a few hours of events, so what is found is written to
  `deployments/positions.json` and unioned next run. Losing track of a
  position means a position nobody rebalances.
- Each recorded decision carries the ledger it came from, and an older event
  never overrides a newer one. Without that, an `opened` still inside the
  window keeps resurrecting a closed position. A position address is
  deterministic per owner, market and product, so the same address genuinely
  can reopen later, which is why this compares ledgers rather than simply
  refusing to reopen.
- A position reading zero collateral and zero debt is a closed one whose
  `closed` event has aged out. Left alone the keeper reads its LTV as zero,
  decides it is 70% off target, and sends a rebalance that can do nothing,
  every pass, forever.
