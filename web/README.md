# web: the Agama app, on Stellar

The production front of [app.agama.finance/stellar-rwa](https://app.agama.finance/stellar-rwa), forked from
the Solana build (same shell, same navbar, same cream panels on the green frame) with Stellar testnet as its
one platform. Every page lives under `/stellar-rwa`, so it sits behind a path rewrite on app.agama.finance.

| Route | What it does |
|---|---|
| `/stellar-rwa` | Earn: deposit a stock, pick the level on one slider, the agents hold it |
| `/stellar-rwa/amplify` | One leverage slider, capped at 1 / (1 - LTV), open and close |
| `/stellar-rwa/portfolio` | Every position of the wallet, and what the agents last did to each |
| `/stellar-rwa/faucet` | 10,000 USDC and 10 of each of the ten markets' tokens, in one call |
| `/stellar-rwa/api/snapshot` | The read above, server side |

```
lib/stellar/
  config.ts          RPC, the addresses from deployments/testnet.json, the ten markets
  rpc.ts             a read is a simulation, with one cached source account behind all of them
  scval.ts           JavaScript values into the XDR a contract expects
  snapshot.ts        the whole screen in one server-side pass, about seventy reads
  useStellar.ts      the snapshot hook, the send path, the calls, the formatters
  WalletProvider.tsx the kit, the Nido module, and which address is connected
lib/nido/
  session.ts         scoped session keys for a Perch smart account (vendored)
  agama.ts           the grants this protocol needs, and the call that uses them
components/stellar/  cards, rows, market picker, agents card
components/stellar/NidoGate.tsx  the one thing a passkey account asks of its owner
```

## Reading

One snapshot per refresh: the markets, their prices and freshness, the wallet's balances, both products'
positions with health, the Blend reserve, the vault's share price and the protocol buffer. It runs on the
server, so a page load is one request rather than the seventy contract reads behind it.

That is the opposite trade from the Solana build this is forked from, which reads the chain straight from the
browser: its polling costs its RPC provider, ours costs a request on our own plan, and the two look identical
on screen. So this one asks far less often: a minute while connected, two while not, **nothing at all while
the tab is hidden**, and one catch-up read on the way back rather than the backlog of the ones it skipped. A
tab left open on a 20 second timer is 4,320 requests a day for nobody.

While the RPC fails the last snapshot stays on screen with its age, because a page that empties itself every
time an RPC hiccups is worse than one that admits to being a minute behind.

## Writing

Build, simulate, sign, send, poll. The simulation is not an optimisation: a Soroban transaction carries the
ledger entries it will touch and the resources it will burn, and only the network can work those out.

A **smart account** takes a different road entirely, and `lib/nido/` is that road.

## Nido: a passkey account, and why it needs a session key

A Nido account is a contract (a `C…` address), an OpenZeppelin Perch smart account whose passkey signs under
one rule: `admin`, scoped to the account itself. So its sign popup **cannot** authorise a call into the core,
or into a token the core moves: the account answers `#3002` or `#3014`. That is the design, not a bug.

What works instead is a session key. The owner approves, once with their passkey, a Perch rule naming a key
this page holds as a delegated signer on one contract, for one list of functions, for a day, optionally under
a rolling cap. After that every call is signed in the page with no prompt, and the account still enforces the
rule on chain for each one. The key is a classic ed25519 key in this origin's localStorage; it pays its own
fees (Friendbot funds it), because Nido's relayer cannot submit CAP-0071 delegate entries yet. It never holds
the user's money: everything it spends comes out of the account, under the rules, until they expire.

**The grants are the interesting part: one per contract in the call's authorisation tree.**

| Call | Rules it needs |
|---|---|
| `faucet_for` | none at all |
| `earn_deposit`, `amplify_open` | the core, and the stock's token for the transfer out of the account |
| `earn_set_target`, `earn_close`, `amplify_close` | the core alone |

Closing needs no token rule because what comes back is sent by the position, not taken from the owner. The
drip needs nothing because `core.faucet_for` asks nobody to authorise anything: the core is the stocks' admin
so it mints them, and the dollar comes out of what it holds above its buffer. The signed faucet is still
there, and still asks the holder to authorise twelve contracts, which for a passkey account is twelve
confirmations before anything arrives.

**The cap goes on the token rule and nowhere else.** Perch meters a cap by what a `transfer` moves, so a
capped rule on any other function is refused on use with `#3223`, and an uncapped rule allows no token
function at all. Nido's page offers a cap either way and will not continue until the owner has chosen, so the
gate says in words which rule has to be accepted as uncapped before it sends anyone anywhere.

Versions are not a preference here: CAP-0071 signing needs `@stellar/stellar-sdk` 16.4 (`buildWithDelegatesEntry`),
and the static kit API of `@creit.tech/stellar-wallets-kit` 2.x is what carries the Nido module.

`lib/nido/session.ts` is vendored from [nidohq/scaffold-template](https://github.com/nidohq/scaffold-template)
`app-lib/session.ts`, the reference implementation of this flow. Three changes: it takes a built transaction
and a parser rather than a generated client's `AssembledTransaction`; the return URL keeps this app's own
query parameters; and `ensureSessionKey` makes the key without asking for a grant, for the calls that need no
rule.

## Honest about testnet

The stocks, gold, BENJI and USDC are stand-ins, deployed by this repository and handed out by the faucet.
The prices are real: RedStone reports signed by three independent signers, verified on chain by the oracle
itself. The lending is Blend, in an instance of it we deployed because its shared testnet pool can never let
us borrow. The vault is a stand-in with the two properties the protocol is built around: a deposit lands, a
withdrawal queues.

## Run it

```bash
pnpm install
pnpm typecheck                     # strict, over everything served
pnpm dev                           # http://localhost:3010/stellar-rwa
pnpm build && pnpm start
NEXT_PUBLIC_STELLAR_RPC=...        # default https://soroban-testnet.stellar.org
NEXT_PUBLIC_ASSET_PREFIX=...       # when served behind a rewrite

# The whole thing for a passkey account, against the real testnet and the real
# Nido: an account made with a virtual authenticator, connected, funded,
# granted, deposited and closed, then read back off the chain.
node ../scripts/nido/e2e.mjs       # --headed to watch it
```
