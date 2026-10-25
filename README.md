# Agama: make tokenized stocks productive on Stellar

Deposit a tokenized stock, get more of it back. Stellar **testnet**.

A holder of a tokenized share can only hold it. Agama turns it into a position
that grows: deposit the stock, the protocol borrows USDC against it in a Blend
pool, puts the USDC to work in the Agama credit vault, and permissionless
agents turn the yield back into **more of the stock**. What grows is the share
count, not a stablecoin balance.

## What this repository builds, and what it reuses

Two pieces of this are not written here, because Stellar already has them.

**The credit market is Blend.** Stellar has a lending protocol with pools, a
backstop, liquidations and lenders, and anyone can deploy a pool into it. So
Agama deploys a Blend v2 pool whose reserves are the stock tokens as
collateral and USDC to borrow, and the positions borrow from it. We are not the
bank; we are the reason to use it.

**The yield leg is the Agama vault already running on this network.** It is a
deployed protocol with a NAV, a withdrawal queue and an allocation engine
across six curated credit vaults, live on testnet since September:
[agamafinance/agama-soroban](https://github.com/agamafinance/agama-soroban). The
borrowed USDC goes there.

What is written here is the part that does not exist yet: the stock markets,
the price layer, the position accounts and the agents.

## The stocks do not exist yet

There are no tokenized equities on Stellar today. DTCC's is coming. So the
nine shares and the gold are **stand-in tokens this repository mints**, with a
public faucet, and **the prices are real**.

When DTCC's tokens land, a market points at them instead. Nothing else in the
design moves: a market is an address, an oracle feed and two risk numbers.

## The price layer

Stellar has no equity feed either. RedStone deployed on Stellar in March 2026
and adopted SEP-40 in June, which is the interface Blend reads, but their
Stellar feeds are BTC, ETH, USDC, PYUSD and BENJI. No TSLA.

So the oracle is ours. RedStone signs its price packages off chain with
secp256k1 over a keccak256 digest; the contract recovers the signers and
requires several known ones to agree before a price applies. Soroban has both
host functions (`secp256k1_recover`, `keccak256`), so the verification happens
on chain and the keeper holds no price key: it fetches reports and relays them,
and anyone else can do the same.

The same contract answers SEP-40, which is what lets the Blend pool read it
directly.

## Why the LTV is the same on every market

Every market carries 70%, Tesla included, and that is the design rather than a
shortcut.

On a normal lending market the LTV is a bet on how far the collateral can fall
before anyone reacts, so a volatile share gets 30% and a money fund gets 70%.
Here the debt is not left alone to be overtaken by the price. The borrowed USDC
sits in the Agama vault as shares, and the agents hold the target both ways:
the stock rises and they borrow the difference, it falls and they repay out of
the vault shares, never by selling the stock. Liquidation repays out of those
shares first and only calls a liquidator if that was not enough.

So what backs the loan is the position's own counterweight, and a counterweight
is as good on Tesla as on a money fund. What is left of a share's volatility is
the part the agents cannot outrun, the gap while the session is shut, and that
is what the off-hours buffer is for. It is the one risk number that still
differs by asset.

## Measured, before anything was written

Everything below was read off the network or the toolchain, not assumed.

| | |
|---|---|
| Blend testnet addresses | [`blend-utils/testnet.contracts.json`](https://github.com/blend-capital/blend-utils/blob/main/testnet.contracts.json) |
| Blend pool factory v2 | `CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6` |
| Blend backstop v2 | `CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA` |
| Blend testnet USDC | `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU` |
| Agama vault, live testnet | `CCVNCXPJXCA5GKJKNUNZRMJEEWYL74ASYYTL2DULPO5TZDGSHUPZTTJF` |
| Agama staking, live testnet | `CBOHG5YGAE7ORFDE5GIUN6MYYSXMHYWGLZTH3Y563HZCBBWFVQ4CACV3` |
| soroban-sdk | 23.0.2 |
| stellar CLI | 28.1.0 |

## The markets

Eight shares, Franklin Templeton's BENJI and gold. All at 70% LTV and an 80%
liquidation threshold; the off-hours buffer is what differs.

| | | off-hours buffer |
|---|---|---|
| TSLAx, NVDAx, METAx, AAPLx, MSFTx, AMZNx, GOOGLx, SPYx | share | 500 bps |
| BENJI | money market fund, priced at NAV | 200 bps |
| GOLDx | commodity | 500 bps |

## Status

Contracts land one at a time, each with its tests, and the git history is the
record of what was true when. Nothing is deployed yet.

## Running it

```
./scripts/verify.sh          everything, in one pass
```

Five layers, in the order they depend on each other.

```
1. The contracts
  ✓ 5 crates, 67 tests
  ✓ 5 wasms build

2. What is live
  ✓ core, oracle, vault, pool and backstop each asked a real question
  ✓ pool status 0, borrowing open
  ✓ 10 markets registered

3. An Earn, on chain
  ✓ deposit, rise, fall, yield, compound, close
      10.0000 TSLAx -> 2,579.45 borrowed, all of it into the vault
      a fall repaid out of the buffer, not one share sold
      yield compounded: 10.0000 -> 10.7778 TSLAx
      closed: 10.7778 TSLAx back, debt zero

4. An Amplify, on chain
  ✓ a multiple asked for, reached, held through a move, and unwound
      10.0000 NVDAx at 3x -> 30.0000 held, 5,316.46 borrowed, LTV 66.66%
      price +8% -> the agent BOUGHT: 30.0000 -> 34.4479 NVDAx
      closed: 11.4815 NVDAx kept on a deposit of 10

5. The keeper
  ✓ 11 feeds pushed from signed RedStone reports
  ✓ agents ran over every open position

6. The app
  ✓ /stellar /stellar/amplify /stellar/portfolio /stellar/faucet /api/snapshot
  ✓ all 10 markets priced and fresh through the app

  19 passed, 0 failed
```

Individually:

```
cargo test                      the contracts
./scripts/deploy.sh all         ours, on testnet
./scripts/blend.sh all          our own instance of Blend
./scripts/e2e.sh                an Earn, start to finish, on chain
./scripts/amplify-e2e.sh        an Amplify, the same
python3 keeper/run.py once      relay prices, then let the agents act
cd web && pnpm dev              the app, on localhost:3010
```

## The two products

**Earn.** Deposit a stock, keep the stock. Seventy percent of its value is
borrowed against it on Blend and put to work in the vault, and agents hold
that level as the price moves. A rise borrows more into the vault. A fall is
repaid out of the protocol's own buffer, in the same transaction that notices
it, so no stock is ever sold: that collateral is what the user came here to
keep. The vault yield above the debt is bought back as more of the stock, so
the share count grows.

**Amplify.** Deposit a stock, hold a multiple of it. The protocol borrows
against the deposit, buys more of the same stock, pledges that too. A multiple
of L carries an LTV of (L - 1) / L, so the market's own ceiling caps it at
1 / (1 - ltv): 3.33x at a 70% market. Agents hold the multiple, buying when it
rises and selling just enough to repay when it falls, with the sale sized to
the debt rather than to the position, so what goes back is the stock the loan
bought and never the deposit.

The loop is settled rather than walked. Run pass by pass it converges from
below and never arrives, and sixteen calls into the pool exceeds Soroban's CPU
budget. The core advances the whole multiple of stock, pledges it, and borrows
against the full position, keeping the dollars as payment. Identical to the
loop's limit, exactly rather than approximately, in two calls.

Pledge before borrowing, repay before withdrawing. Blend checks health at the
moment of each request rather than at the end of the transaction, so the other
order is a loan standing briefly against collateral that has not arrived yet.


## What testnet made us build that mainnet would not

Three things here exist because of a wall, not a preference, and each one says
so in its own file.

**Our own instance of Blend.** A pool lets nobody borrow until its backstop is
funded, a backstop is funded in BLND:USDC comet LP, and on testnet neither
BLND nor Blend's USDC can be minted by anyone but their admins. Their shared
instance is permanently supply-only for us. So Blend's own contracts are
deployed by us, unmodified, with tokens we can mint. Same wasm, same request
codes, same interest model.

**A stand-in vault.** The live vault takes Circle's USDC and nobody but Circle
mints that, so without dollars nothing can be supplied, borrowed or buffered.
`contracts/vault` is not a simplified vault, it is the two properties the
protocol is built around: a deposit lands immediately, and a withdrawal does
NOT pay out, it queues.

**Two admin-priced markets.** RedStone carries SPY only as `SPY---PRE_AFTER`
and BENJI as `BENJI_ETHEREUM_FUNDAMENTAL`, and the deployed oracle was bound
to `SPY` and `BENJI` before that was known. `retarget_feed` exists in the
source now; the live instance predates it.
