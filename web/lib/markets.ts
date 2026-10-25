import { read, stellarAsset } from './chain'
import { dep, meta } from './deployment'

export type Market = {
  symbol: string
  name: string
  kind: string
  token: string
  reserve: string | null
  ltv: number
  threshold: number
  offHoursBuffer: number
  drip: string
  price: string | null
  at: number | null
  feed: string | null
  redstone: string
  signed: boolean
}

type Price = { price: bigint; timestamp: bigint } | null

/// Every market, with the price the oracle would answer right now.
///
/// A server component calls this directly rather than fetching its own API
/// route. Fetching yourself works in dev and fails during a build, when
/// nothing is listening on the port, and the round trip buys nothing: both
/// callers run in the same process.
export async function loadMarkets(): Promise<Market[]> {
  const rows = await Promise.all(
    meta.map(async (m): Promise<Market | null> => {
      const token = dep.stocks[m.symbol]
      if (!token) return null
      const [p, feed] = await Promise.all([
        read<Price>(dep.contracts.oracle, 'lastprice', [stellarAsset(token)]),
        read<Buffer>(dep.contracts.oracle, 'feed', [stellarAsset(token)]),
      ])
      const onChainFeed = feed ? Buffer.from(feed).toString('utf8').replace(/\0+$/, '') : null
      return {
        symbol: m.symbol,
        name: m.name,
        kind: m.kind,
        token,
        reserve: dep.blend.reserves[m.symbol] ?? null,
        ltv: m.ltv,
        threshold: m.threshold,
        offHoursBuffer: m.offHoursBuffer,
        drip: m.drip,
        price: p ? p.price.toString() : null,
        at: p ? Number(p.timestamp) : null,
        feed: onChainFeed,
        // What RedStone calls it, when that differs from what the oracle is
        // bound to. The gap is the whole reason two markets are admin-priced.
        redstone: m.redstone ?? m.feed,
        signed: (m.redstone ?? m.feed) === onChainFeed,
      }
    }),
  )
  return rows.filter((r): r is Market => r !== null)
}

export const contracts = {
  core: dep.contracts.core,
  oracle: dep.contracts.oracle,
  vault: dep.contracts.vault,
  pool: dep.blend.pool,
  usdc: dep.blend.usdc,
}
