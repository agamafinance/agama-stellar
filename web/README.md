# web: the Agama app, on Solana

The production front of [app.agama.finance](https://app.agama.finance), in the same fork as the X Layer
build (same shell, same navbar, same cream panels on the green frame), with Solana devnet as its one
platform. Every page lives under `/solana`, so it can sit behind a path rewrite on app.agama.finance.

| Route | What it does |
|---|---|
| `/solana` | Earn: deposit a stock, pick the level on one slider, the agents hold it |
| `/solana/amplify` | One leverage slider, capped at 1 / (1 - LTV), open and close |
| `/solana/portfolio` | Every position of the wallet, what the agents last did, the private balances |
| `/solana/faucet` | 10,000 USDC and 10 of each of the ten markets' tokens, minted straight into the private balance |

```
lib/solana/
  config.ts          RPC, program id, PDAs, the ten markets
  useSolana.ts       one getMultipleAccounts snapshot, client-side accrual, instructions
  batch.ts           every send: build, one approval, re-send, retries, honest partial failures
  confidential.ts    keys, balances, shield and unshield steps (zk-sdk, loaded on first use)
  PrivateContext.tsx private by default: the lock, unshield before, shield after
  wallet.ts          Phantom, Solflare, Backpack, or any injected window.solana
  WalletProvider.tsx the wallet context, following account switches inside the wallet
  idl.json           copied from ../idl/agama_solana.json
components/solana/   cards, rows, market picker, agents card, privacy bar
```

Reads are one `getMultipleAccounts` per refresh (protocol, ten markets, LP mint, and the
wallet's twenty possible positions and eleven token accounts), decoded with the IDL and accrued forward to
now with the program's own rate model. While the RPC fails, the last snapshot stays on screen with its age
and the reads back off up to two minutes. Writes are signed by the wallet and sent by the app, never by the
wallet, which would otherwise submit to whatever cluster it is set to.

## Private by default

Every Agama mint is Token-2022 with confidential transfers, and a holder's tokens live in the confidential
balance: amounts are ElGamal ciphertexts on chain that only the owner's keys read.

- **Keys.** One signature over `solana-conf-bal/v1`, the message every Token-2022 client signs, asked once
  per session and kept in memory only, cleared on Lock, on disconnect and when the wallet switches account.
  Whoever holds that signature can read (never spend) the private amounts, which the app says where it asks.
- **Faucet.** Mints, then shields what it minted, setting up each private balance the first time: one
  approval, about 15 transactions the first time.
- **Earn and Amplify.** A deposit spends any public remainder first and unshields exactly what is missing
  (one approval, about 5 transactions: the proofs do not fit in one). A close shields exactly what came back
  (a second approval). The program sees the amount entering or leaving, as it must to price the loan, and
  positions are public program state.
- **When something stops half way.** If the unshield landed but the deposit failed, or the close landed but
  the shield did not, the page says which amount is public now and offers to shield it back in one click.
- **One action at a time.** A confidential balance carries a client-written copy of the readable balance; two
  actions built from the same read would write it twice. Every action takes an app-wide lock and re-reads
  the accounts before building.

## Sending

`batch.ts` builds every transaction of an action, asks for one approval, sends them in order and follows
each one: the same signed bytes are re-sent until they land, RPC errors are retried with backoff, a
transaction is only called expired after one more status read, and if the batch outlives its blockhash the
remaining transactions are signed again with a fresh one (one more approval) rather than abandoned. A
transaction that fails on chain stops the batch with the step that failed and the signatures that landed.

## Honest about devnet

The stocks, XAUt0 and USDC are stand-ins minted by the program. Prices are real: signed Chainlink Data Streams
reports (the share in its live session, regular, extended or overnight, and XAU/USD for gold), verified on
chain by Chainlink's Verifier before the program applies them. Swaps
settle at the oracle price minus 5 bps.

## Run it

```bash
pnpm install
pnpm typecheck        # strict, over everything served (tsconfig.solana.json)
pnpm build && pnpm start          # http://127.0.0.1:3031/solana
NEXT_PUBLIC_SOLANA_RPC=...        # default https://api.devnet.solana.com
NEXT_PUBLIC_ASSET_PREFIX=...      # when served behind a rewrite

# A headless browser with an injected throwaway wallet, on devnet: faucet into the private balance,
# Earn from private, the slider, close back to private, Amplify open and close, Portfolio.
PLAYWRIGHT_PATH=/path/to/node_modules/playwright CHROME_PATH=/path/to/chromium FUND_SOL=0.1 \
  node scripts/ui-e2e.mjs http://127.0.0.1:3033
```
