// Generated: scripts/sync.mjs copies these from deployments/ before dev and
// before build. Next refuses an import that reaches outside the project root,
// and hand-maintaining a second list of addresses is how an app ends up
// pointed at a pool that was abandoned three commits ago.
import raw from '../generated/testnet.json'
import markets from '../generated/markets.json'

type Deployment = {
  contracts: { core: string; oracle: string; vault: string }
  blend: { pool: string; usdc: string; backstop: string; reserves: Record<string, string> }
  stocks: Record<string, string>
}

export const dep = raw as unknown as Deployment

export type MarketMeta = {
  symbol: string
  name: string
  feed: string
  redstone?: string
  kind: string
  ltv: number
  threshold: number
  offHoursBuffer: number
  drip: string
}

export const meta: MarketMeta[] = (markets as { markets: MarketMeta[] }).markets

export const metaBySymbol = Object.fromEntries(meta.map((m) => [m.symbol, m]))

/// Which markets carry a signed RedStone price and which do not, because a
/// screen that shows both the same way is lying about one of them.
export const SIGNED = new Set(
  meta.filter((m) => !m.redstone || m.redstone === m.feed).map((m) => m.symbol),
)

export const NETWORK = 'testnet'
export const RPC = 'https://soroban-testnet.stellar.org'
export const PASSPHRASE = 'Test SDF Network ; September 2015'
