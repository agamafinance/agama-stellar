# Agama: tokenized stocks that grow, on Stellar

**[app.agama.finance](https://app.agama.finance)** · Stellar testnet · [llms.txt](https://app.agama.finance/llms.txt)

A holder of a tokenized share can only hold it. Agama turns it into a position
that grows: deposit the stock, the protocol borrows USDC against it in a Blend
pool, puts those dollars to work in a credit vault, and permissionless agents
turn the yield back into **more of the same stock**. What grows is the share
count, not a stablecoin balance.

And the part that does not exist anywhere else on Stellar: **deposit a stock
and hold a multiple of it**, with the loop settled in one transaction rather
than walked.

## What makes it worth reading

**Amplify reaches the exact multiple in two calls into the pool.** The product
is a loop: borrow against the stock, buy more of the same stock, pledge that
too, go round again. Run literally it converges from below and never arrives,
because each pass only borrows against what is already pledged: at a 70%
market, eight passes reach 3.14x of the 3.33x on offer and cost sixteen calls
into Blend, which on Soroban is not a slow transaction, it is one that exceeds
the CPU budget and reverts. So the core settles the limit instead of walking
to it. It advances the whole multiple of stock, pledges it, borrows against
the full position and keeps the dollars as payment for what it advanced. The
end state is identical to the loop's limit, **exactly rather than
approximately**, in two pool calls. Nothing is uncollateralised at any point:
the stock is pledged before the loan it secures exists, and the transaction
either reaches that state or reverts to none of it.

**A fall is repaid out of the protocol's own buffer, never by selling your
stock.** That is the whole product. A lending market sells the collateral the
moment the price moves against it, and the share is what the holder came for.
Here the agents repay from a USDC buffer the protocol keeps, in the same
transaction that notices the fall, and file a withdrawal request against the
position's vault balance to refill it behind the user rather than in front of
them. `buffer()` is public so anyone can see how much is left.

**Four protocols compose, and none of them are mocked.** Blend v2 for the
credit market, with the positions as its borrowers of record. RedStone price
packages, with secp256k1 recovery and a three-signer quorum **verified on
chain** by our own SEP-40 oracle, which is also what lets the Blend pool read
it directly. A credit vault where a deposit lands and a withdrawal queues,
because that is what a credit book does. And Nido passkey smart accounts, so
somebody with no extension, no seed phrase and no XLM can deposit a share and
leverage it.

**It is checked, not asserted.** 75 contract tests, 19 end-to-end checks
against the live network in one script, and a browser harness that makes a
real passkey account and takes it through the entire product in five minutes
without a fingerprint.

## Try it in a minute

1. Open **[app.agama.finance](https://app.agama.finance)**, press Connect and
   choose **Nido**. No extension. If you have no account, make one at
   [test.nido.fyi](https://test.nido.fyi): one passkey, thirty seconds.
2. **Faucet**: 10,000 USDC and 10 of each of the ten markets, one call, and
   the account needs no XLM for it. The app's own key pays the fees.
3. **Earn**: deposit 5 TSLAx, pick the level, confirm with the passkey.
4. **Amplify**: deposit 5 TSLAx at 3x and watch the position hold ~14.9 TSLAx.
5. **Portfolio**: what the agents last did to each position, and when.

A classic wallet works too: Freighter, xBull, Albedo. Everything below is
reproducible from a shell with `./scripts/verify.sh`.

## How it works

```
        your stock                                    more of your stock
             │                                                ▲
             ▼                                                │
     ┌───────────────┐    pledge     ┌─────────────┐           │
     │   core        │──────────────▶│  Blend v2   │           │
     │  earn_deposit │               │   pool      │           │
     │  amplify_open │◀──────────────│ (ours, on   │           │
     └───────┬───────┘   borrow USDC │  chain)     │           │
             │                       └─────────────┘           │
             │ deploys one per (owner, market, product)        │
             ▼                                                 │
     ┌───────────────┐   deposit     ┌─────────────┐    yield   │
     │  position     │──────────────▶│   vault     │───────────┘
     │ Blend's       │   request     │ lands /     │  compound
     │ borrower of   │◀──────────────│ queues      │  buys stock
     │ record        │               └─────────────┘
     └───────┬───────┘
             │ priced by
             ▼
     ┌───────────────┐   push(payload)    ┌──────────────────┐
     │   oracle      │◀───────────────────│  keeper + agents │
     │ SEP-40 +      │  3 signers checked │  anyone can run  │
     │ RedStone      │  on chain          │  them            │
     └───────────────┘                    └──────────────────┘
```

| Contract | What it is | The calls that matter |
|---|---|---|
| **core** | The protocol. The only contract that knows what healthy means: markets, both products, the buffer, the three agents. | `earn_deposit`, `earn_set_target`, `earn_close`, `amplify_open`, `amplify_close`, `rebalance`, `compound`, `liquidate`, `health`, `buffer`, `fund_buffer`, `faucet_for` |
| **position** | One contract per (owner, market, product). It is Blend's borrower of record, which is what keeps one user's trouble off another user's position. Only the core may move it. | `supply`, `borrow`, `repay`, `unsupply`, `collateral`, `debt`, `target`, `vault_deposit`, `vault_request`, `touch`, `last_touch` |
| **oracle** | SEP-40, and a RedStone verifier. `push` parses a payload, recovers every signer with `secp256k1_recover` over `keccak256`, and applies a price only when at least three known signers agree, it is younger than `max_age`, and it has not moved further than `max_move_bps`. | `push`, `lastprice`, `prices`, `add_feed`, `retarget_feed`, `set_price`, `signers`, `min_signers`, `max_age` |
| **vault** | The credit leg. A deposit lands immediately and mints shares at today's rate; a withdrawal **does not pay out**, it burns shares and queues, which is the honest behaviour of a book whose money is lent out. | `deposit`, `request_withdrawal`, `settle`, `assets_of`, `shares`, `rate`, `queued`, `open_queue` |
| **stock** | A SEP-41 stand-in share with a public faucet that mints a fixed quantity on a cooldown, because a faucet that takes an amount is a mint function with a friendly name. | `faucet`, `faucet_in`, `drip`, `mint`, `transfer`, `burn`, `approve` |

**The invariants.** A position's health is `collateral × price × threshold`
against `debt`, read at every call through `health()`. Pledge before
borrowing, repay before withdrawing: Blend checks health at each request in a
`submit`, not at the end of the transaction. An Earn position holds its target
LTV; an Amplify position holds its multiple, and `(L-1)/L` is the LTV that
implies, so the market's own ceiling caps the multiple at `1/(1-ltv)`.

## The two products

**Earn.** Deposit a stock, keep the stock. The level you pick, up to 70%, is
borrowed against it and put to work in the vault. A rise borrows the
difference and sends it to the vault. A fall is repaid out of the buffer. The
vault yield above the debt is bought back as more of the stock, so the share
count grows: 10.0000 TSLAx became 10.7778 in the end-to-end run, with the debt
repaid and not one share sold.

**Amplify.** Deposit a stock, hold a multiple of it. 5 TSLAx at 3x holds
14.9 TSLAx at a 66.44% LTV, inside the 70% ceiling, in one transaction. The
agents hold the multiple as the price moves, buying when it rises and selling
only what repays when it falls, with the sale sized to the debt rather than to
the position, so what goes back is the stock the loan bought and never the
deposit.

**The agents are permissionless.** `rebalance`, `compound` and `liquidate`
take the position address and anyone may call them. Every pass leaves its
caller and its action on the position, which is what `last_touch` reports and
what the Portfolio screen shows. Nothing here is yours to do, and nothing here
is ours to control.

## Why every market carries the same LTV

Every market is 70% LTV and an 80% liquidation threshold, Tesla included, and
that is the design rather than a shortcut.

On a normal lending market the LTV is a bet on how far the collateral can fall
before anyone reacts, so a volatile share gets 30% and a money fund gets 70%.
Here the debt is not left alone to be overtaken by the price: the borrowed
USDC sits in the vault, and the agents hold the target both ways. Liquidation
repays out of those vault shares first and only calls a liquidator if that was
not enough.

So what backs the loan is not the share's calm, it is the position's own
counterweight, and a counterweight is as good on Tesla as on a money fund.
What is left of a share's volatility is the part the agents cannot outrun, the
gap while the session is shut, and that is what the off-hours buffer is for.
It is the one risk number that still differs by asset: 500 bps on the shares
and gold, 200 on BENJI.

## What is real here, and what is a stand-in

Judges should be able to tell these apart at a glance, so:

| Real | Stand-in |
|---|---|
| The prices: RedStone reports signed by three independent signers, verified on chain by the oracle itself | The ten market tokens. No tokenized equity exists on Stellar yet, DTCC's is coming, so this repository deploys them and hands them out |
| The lending: Blend v2's own contracts, unmodified wasm, same request codes, same interest model | The dollar. Circle's testnet USDC is not mintable by us, so the pool's USDC is a token we deploy |
| The verification: `secp256k1_recover` and `keccak256` on chain, a three signer quorum, a maximum age and a maximum move | The credit vault. The live Agama vault takes Circle's USDC, so `contracts/vault` stands in for it with the two properties the protocol is built around: a deposit lands, a withdrawal queues |
| The passkey accounts: Nido smart accounts on testnet, with Perch rules enforced on chain | The venue. There is nowhere to buy a stand-in share, so the core mints it at the oracle price and keeps the dollars. This is the one place a number comes from us rather than from a signature |

**One thing changed under us on 26 October 2026**, and the honest answer is
here rather than in a footnote. RedStone is switching its public gateways off:
they answer `403 public_gateway_rejected` inside windows that grow every day
and stop serving for good on 29 October. An authenticated gateway, a host and
a key they issue, replaces them. The keeper reads `REDSTONE_GATEWAY` and
`REDSTONE_API_KEY` and goes back to signed reports the moment both exist;
until then `keeper/fallback_prices.py` has the oracle's admin set the same
numbers from a public quote feed, with the oracle's own move cap still
enforced and no signature behind them. The file says so in its first
paragraph and the run says so in its first line.

## The walls, and what each one taught

Every one of these cost hours, and each is a code you can look up.

**Blend's shared testnet pool can never let us borrow.** A pool lets nobody
borrow until its backstop is funded, a backstop is funded in BLND:USDC Comet
LP, and neither token is mintable by anyone but its admin. So Blend's own
contracts are deployed by us, unmodified. Learning their arithmetic cost the
most: the pool threshold is `balance_blnd^4 × balance_usdc >= 1e25` and our
first attempt landed at 1.99e24; Comet refuses a one-sided deposit above 30%
of the balance it holds (`ErrMaxInRatio`, 17); and a reserve queued against a
pool that is already live is timelocked for a week (`InitNotUnlocked`, 1203),
which froze one pool's asset list around tokens we had already abandoned and
cost us the pool. **Every reserve first, the switch last.**

**Soroban's authorization is exactly one frame deep.** A contract authorizes
the call it makes itself and nothing below it, so a pool pulling tokens two
frames down fails with `Error(Auth, InvalidAction)` and no hint as to which
frame. The positions build `InvokerContractAuthEntry` trees with
`authorize_as_current_contract` for every pull they are responsible for. The
other half of the same rule: a call a contract must authorize has to be **made
by** that contract, which is why the positions, not the core, talk to the
vault.

**The leveraged product did not fit in a transaction.** Eight passes, 3.14x of
3.33x, sixteen pool calls, and the CPU budget gone. Settled in one step
instead, which is the mechanic described at the top of this file.

**Health is checked per request, not per transaction.** Tests green, chain
answering `InvalidHf` (1205): Blend evaluates each request in a `submit` as it
applies it. Pledge before borrowing, repay before withdrawing. The mock that
let it pass checked nothing, which is the real lesson: **a mock that cannot
refuse proves nothing about a chain that can.**

**A passkey account cannot sign a call into your contract.** A Perch smart
account's passkey signs only under its own admin rule, scoped to the account
itself, so a call into the protocol comes back `#3014` or `#3002`, by design.
Acting for one means session keys: the owner approves a Perch rule naming a
key the app holds as a delegated signer on one contract, for one list of
functions, under a cap **only a transfer can carry** (`#3223` otherwise, and
an uncapped rule allows no token function at all). One rule per contract in
the call's authorization tree.

**A wallet forced a protocol change.** The one-click faucet made a single
signature cover eleven token faucets, each checking it on the way down. For a
passkey account that is twelve confirmations before anything arrives, which is
not a faucet. `faucet_for` asks nobody to authorize anything: the core is the
stocks' admin so it mints them, and the dollar comes out of what it holds
above the buffer, refilled from the dollar's own faucet.

**And a bug only a passkey found.** Closing a position the minute it was
opened was impossible. The close repays from the buffer and files the refund
against the position's vault balance, but a debt grows in Blend's `d_rate` by
the second while a vault share price does not follow it, so the vault refused
to burn shares that were not there (`#3`), 213 stroops short on the position
that found it. Every existing test passed through this, because each one
closes after a price move or a compound, by which point the vault has grown
past the debt. The request is now for what the position holds, and the buffer
carries the difference, which is what a buffer is for.

**Two mocks were lying, and the second only appeared once the first was
fixed.** The mock vault queued whatever it was asked for; the real one burns
shares, so it refuses. The mock pool repaid with the smaller of the request
and the debt; Blend pulls exactly what the request named and refunds the
excess (`apply_repay`), and that order is load bearing, because the position
authorizes one amount for the pull.

**The stock admin cannot be taken back,** which cost two full redeployments of
the ten tokens, and the first core deploy cost about 79,000 XLM of testnet rent,
which took thirty Friendbot accounts merged together.

## Deployed, on Stellar testnet

| | |
|---|---|
| core | [`CBT6PZFSMT7D6K7L25QRFXACF7U5EHZA7II7KIOR7FREF3XB2SAZYAFD`](https://stellar.expert/explorer/testnet/contract/CBT6PZFSMT7D6K7L25QRFXACF7U5EHZA7II7KIOR7FREF3XB2SAZYAFD) |
| oracle | [`CBTNXB4KM4UKW25Z6UF22FOABSYS6AFJP34Y4DXBCLIQNYVPK255PJ6M`](https://stellar.expert/explorer/testnet/contract/CBTNXB4KM4UKW25Z6UF22FOABSYS6AFJP34Y4DXBCLIQNYVPK255PJ6M) |
| vault | [`CCVVFPL5ZUTBEKJYS4AGRPFHLOO42TPTUMACHXBQPUW3YTZ23AIAE5GF`](https://stellar.expert/explorer/testnet/contract/CCVVFPL5ZUTBEKJYS4AGRPFHLOO42TPTUMACHXBQPUW3YTZ23AIAE5GF) |
| Blend pool (ours) | [`CCNJ6D3ITLT22QCVNTD3AVEY4ANE3FYXSKIQTLFXTLPOSPWLWWTPHCCG`](https://stellar.expert/explorer/testnet/contract/CCNJ6D3ITLT22QCVNTD3AVEY4ANE3FYXSKIQTLFXTLPOSPWLWWTPHCCG) |
| Blend backstop | [`CASS56APDOL6RPC46QBK72SMAVZ3CMV3U4RQL74LXO5K3KHXXHQG23K6`](https://stellar.expert/explorer/testnet/contract/CASS56APDOL6RPC46QBK72SMAVZ3CMV3U4RQL74LXO5K3KHXXHQG23K6) |
| USDC (stand-in) | [`CD5IKHINGOCVAOZPWD4R5R7FVAAZBCZOVQJVGIGI7XMYESK3CVGUVDSL`](https://stellar.expert/explorer/testnet/contract/CD5IKHINGOCVAOZPWD4R5R7FVAAZBCZOVQJVGIGI7XMYESK3CVGUVDSL) |

The ten markets, all at 7000 bps LTV and an 8000 bps threshold:

| | | |
|---|---|---|
| TSLAx | Tesla | [`CAH4TV2YO3SQ4KEVEQEUKFDDHHDCVDWBGLBGXFF6C5ZPYF7HH5GXVE4Y`](https://stellar.expert/explorer/testnet/contract/CAH4TV2YO3SQ4KEVEQEUKFDDHHDCVDWBGLBGXFF6C5ZPYF7HH5GXVE4Y) |
| NVDAx | NVIDIA | [`CAJWQP6AK2LDCYVOVSBEJO4S3DWB65YFMMGAZHMNKB2FSHTYQFLUXJRJ`](https://stellar.expert/explorer/testnet/contract/CAJWQP6AK2LDCYVOVSBEJO4S3DWB65YFMMGAZHMNKB2FSHTYQFLUXJRJ) |
| AAPLx | Apple | [`CCCKJXVYH7WWICFN4LGTWBEGTHCM7DPNSD4APEEF23DGWTI5M3BKA4HP`](https://stellar.expert/explorer/testnet/contract/CCCKJXVYH7WWICFN4LGTWBEGTHCM7DPNSD4APEEF23DGWTI5M3BKA4HP) |
| MSFTx | Microsoft | [`CBLTILNRY6UYM6SHOXLJ26IR7BA3FMLL3ASF5IQV24NZAM4NASNEUULK`](https://stellar.expert/explorer/testnet/contract/CBLTILNRY6UYM6SHOXLJ26IR7BA3FMLL3ASF5IQV24NZAM4NASNEUULK) |
| AMZNx | Amazon | [`CBVYYQLKB2AZHH26LV4YPH4IWMHR64C7SKA2LP4N32JT23OSXFOA4IU7`](https://stellar.expert/explorer/testnet/contract/CBVYYQLKB2AZHH26LV4YPH4IWMHR64C7SKA2LP4N32JT23OSXFOA4IU7) |
| GOOGLx | Alphabet | [`CAODLZQTURUJXONHROU3Y4YOUMWPZQDSO4ZXNFPNYJKCW2YGQK7JUKIS`](https://stellar.expert/explorer/testnet/contract/CAODLZQTURUJXONHROU3Y4YOUMWPZQDSO4ZXNFPNYJKCW2YGQK7JUKIS) |
| METAx | Meta | [`CAM5ATFUBP3M5DEWZM5XXZ4N7MZCEWYDEAGZ3OUCFRHHPWAGR3CL2TOA`](https://stellar.expert/explorer/testnet/contract/CAM5ATFUBP3M5DEWZM5XXZ4N7MZCEWYDEAGZ3OUCFRHHPWAGR3CL2TOA) |
| SPYx | S&P 500 | [`CBJJL3Q6PJXOCS2DMX2MNT2FFLS27NVFNVWT3O4KKJLPAH7QA6NNKVY2`](https://stellar.expert/explorer/testnet/contract/CBJJL3Q6PJXOCS2DMX2MNT2FFLS27NVFNVWT3O4KKJLPAH7QA6NNKVY2) |
| BENJI | Franklin OnChain U.S. Government Money Fund, at NAV | [`CCZKFKOXZINGQG7W7R6USJS3SPUSDCJHIX74NWCWC7KIO7DWLF4NSTTN`](https://stellar.expert/explorer/testnet/contract/CCZKFKOXZINGQG7W7R6USJS3SPUSDCJHIX74NWCWC7KIO7DWLF4NSTTN) |
| GOLDx | Gold, XAU/USD | [`CAVD2C3UY2VA34DHIBURFNWURRNH6TJAVWXE7DMJ25W6OBLTTGTQBVXP`](https://stellar.expert/explorer/testnet/contract/CAVD2C3UY2VA34DHIBURFNWURRNH6TJAVWXE7DMJ25W6OBLTTGTQBVXP) |

Thirty-six position contracts have been deployed by the core so far, which is
what `positions()` returns.

## Check it yourself

```sh
./scripts/verify.sh              everything, in one pass: 19 checks
cargo test                       the contracts: 75 tests, 5 crates
./scripts/e2e.sh                 an Earn, start to finish, on chain
./scripts/amplify-e2e.sh         an Amplify, the same
node scripts/nido/e2e.mjs        the same, for a passkey smart account
python3 keeper/run.py once       relay prices, then let the agents act
cd web && pnpm dev               the app, on localhost:3010
```

The last green run: **18 of 19**. The one red is the RedStone gateway above,
and the script names it rather than reporting a bug in the keeper. Three
single answers, if you only want to pull the thread:

```sh
stellar contract invoke --id CBTNXB4KM4UKW25Z6UF22FOABSYS6AFJP34Y4DXBCLIQNYVPK255PJ6M \
  --source <you> --network testnet -- lastprice \
  --asset '{"Stellar":"CAH4TV2YO3SQ4KEVEQEUKFDDHHDCVDWBGLBGXFF6C5ZPYF7HH5GXVE4Y"}'

stellar contract invoke --id CBT6PZFSMT7D6K7L25QRFXACF7U5EHZA7II7KIOR7FREF3XB2SAZYAFD \
  --source <you> --network testnet -- positions

stellar contract invoke --id CBT6PZFSMT7D6K7L25QRFXACF7U5EHZA7II7KIOR7FREF3XB2SAZYAFD \
  --source <you> --network testnet -- health --position <one of them>
```

Or read it through the app, which is the same data in one request:
[app.agama.finance/stellar-rwa/api/snapshot](https://app.agama.finance/stellar-rwa/api/snapshot).

## What is next, on Stellar

**Mainnet, behind the tokens.** Everything here is a market pointing at an
address, an oracle feed and two risk numbers. When DTCC's tokenized equities
land on Stellar, a market points at one of those and nothing else in the
design moves. The stand-in token contract is the only piece that disappears.

**A real venue instead of a mint.** `buy_stock_from_core` is the one place a
number comes from us: it mints the stand-in at the oracle price. On mainnet it
becomes a route, through Soroswap or an SDEX path payment, and the same
function is where that goes.

**The vault, as deployed.** The borrowed dollars go to the Agama credit vault
already running on Stellar
([agamafinance/agama-soroban](https://github.com/agamafinance/agama-soroban)):
a NAV, a withdrawal queue and an allocation engine across six curated credit
vaults. `contracts/vault` stands in for it only because Circle's USDC cannot
be minted on testnet.

**Deeper into Blend.** The pool here is ours because the shared one cannot let
us borrow. On mainnet the right move is the other way round: supply into
Blend's own pools, make the stock tokens reserves there, and let the backstop
and the auction machinery do what they already do well. Agama is then a reason
to use Blend rather than a parallel market.

**More markets, and the session that matters.** The off-hours buffer is the
only risk number that differs by asset today. Equity markets close; a feed
that keeps printing through the gap is the thing that liquidates somebody at
four in the morning for no reason. Per-market sessions, and an agent that
knows which venue is open, is the next risk work.

**Passkeys as the default.** A visitor with no wallet, no seed phrase and no
XLM can already deposit a share and leverage it here. That is the part worth
keeping: the fee is paid by a key the app holds, the rules are enforced by the
account on chain, and the owner confirms every action with a fingerprint.

## Layout

```
contracts/      core, position, oracle, vault, stock (Rust, soroban-sdk 23)
keeper/         RedStone payloads rebuilt and verified, prices pushed, agents run
scripts/        deploy, our own Blend instance, e2e per product, verify, nido/
web/            the app, Next.js, served at app.agama.finance
deployments/    what is live, and the two passes this repository abandoned
vendor/         Blend wasm, read for its interface and never deployed
```

MIT. Testnet only: nothing here holds anything a person would miss.
