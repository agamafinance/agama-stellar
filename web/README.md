# The app

```
pnpm install
pnpm dev        # http://localhost:3010
```

Three screens: the markets with their live prices, your positions, and what
the protocol has actually done.

## Everything is read from the chain

There is no database and no indexer. A server component simulates the contract
call and keeps the return value, so what a page shows is what the contract
would answer right now. That is slower than an indexer and worth it: a lending
position displayed from stale data is the one number a user cannot afford to be
wrong about. The fifteen second window on the API routes is there so a reload
does not hammer the RPC, not so the number can be old.

Activity is the core's own events, read straight off the RPC. Testnet keeps
only a few hours of them, which is why the empty state says so rather than
implying nothing ever happened.

## Addresses

`scripts/sync.mjs` copies `deployments/*.json` into `generated/` before dev
and before build. Next refuses an import that reaches outside the project
root, and hand-maintaining a second list of addresses is how an app ends up
pointed at a pool that was abandoned three commits ago.

## Four things that were wrong first

**`health.collateral` is the stock PRICED, in dollars, not a share count.**
The portfolio multiplied it by the price again and reported a position worth
1.4 million dollars that held ten shares. The share count comes from the
position contract itself.

**An event's name is not in its topics.** `#[contractevent(topics =
["agent"])]` puts `agent` there and nothing else, so looking for the struct
name in the topic list finds nothing and every row renders as "event".

**A `#[topic]` field is not in the event body either.** It is in the topic
list after the prefix, in declaration order. An AgentRan body carries only its
action and delta; the agent and the position have to be read back out of the
topics, or every agent row says "rebalanced undefined by undefined".

**A page cannot fetch its own API route.** It works in dev and fails the build,
when nothing is listening on the port. Both callers run in the same process,
so the page calls the loader directly and the route is there for anything
outside.

## Writes

Freighter, through the wallets kit, loaded inside an effect because the kit
touches `window` on import. Every write simulates first: a Soroban transaction
has to carry the exact ledger entries it will touch and the resources it will
use, and only the network can work those out. Then it polls for the result,
because a transaction accepted for inclusion has not necessarily succeeded,
and a failed deposit reported as done is worse than one that errors.
