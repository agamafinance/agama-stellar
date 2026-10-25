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
