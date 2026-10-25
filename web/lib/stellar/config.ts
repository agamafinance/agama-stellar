import dep from '@/generated/testnet.json';
import marketsFile from '@/generated/markets.json';

/// Addresses come from the deployment file, copied in by scripts/sync.mjs
/// before every dev and build. Nothing here is typed by hand: an app pointed
/// at a pool that was abandoned three commits ago looks exactly like one that
/// works, right up until a transaction fails for a reason nobody can read.

export const RPC = process.env.NEXT_PUBLIC_STELLAR_RPC || 'https://soroban-testnet.stellar.org';
export const PASSPHRASE = 'Test SDF Network ; September 2015';
export const asset = (path: string) => `${process.env.NEXT_PUBLIC_ASSET_PREFIX ?? ''}${path}`;
export const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const explorerAddr = (a: string) => `https://stellar.expert/explorer/testnet/account/${a}`;
export const explorerContract = (a: string) =>
  `https://stellar.expert/explorer/testnet/contract/${a}`;

export const CORE = dep.contracts.core;
export const ORACLE = dep.contracts.oracle;
export const VAULT = dep.contracts.vault;
export const POOL = dep.blend.pool;
export const USDC = dep.blend.usdc;
export const BACKSTOP = dep.blend.backstop;

export const BPS = 10_000n;
/// Everything on Stellar here is seven decimals: the stocks, the dollar and
/// the oracle's prices. One scale for all of it, and no conversions to get
/// wrong.
export const DECIMALS = 7;
export const UNIT = 10n ** BigInt(DECIMALS);

export type Stock = {
  symbol: string;
  /// What the token calls itself, which is also the icon key.
  ticker: string;
  name: string;
  token: string;
  reserve: number;
  ltv: number;
  threshold: number;
  offHoursBufferBps: number;
  /// What the faucet hands out, as a decimal string.
  drip: string;
  /// What RedStone calls this feed, when it is not the ticker.
  redstone: string;
  feed: string;
};

type MarketMeta = {
  symbol: string;
  name: string;
  feed: string;
  redstone?: string;
  kind: string;
  ltv: number;
  threshold: number;
  offHoursBuffer: number;
  drip: string;
};

const stocks = dep.stocks as Record<string, string>;
const reserves = dep.blend.reserves as Record<string, string>;

export const STOCKS: Stock[] = (marketsFile as { markets: MarketMeta[] }).markets
  .filter((m) => stocks[m.symbol])
  .map((m) => ({
    symbol: m.symbol,
    ticker: m.symbol,
    name: m.name,
    token: stocks[m.symbol],
    reserve: Number(reserves[m.symbol] ?? 0),
    ltv: m.ltv,
    threshold: m.threshold,
    offHoursBufferBps: m.offHoursBuffer,
    drip: m.drip,
    redstone: m.redstone ?? m.feed,
    feed: m.feed,
  }));

export type Kind = 'earn' | 'amplify';

/// The product enum, as the contract spells it.
export const PRODUCT: Record<Kind, string> = { earn: 'Earn', amplify: 'Amplify' };

/// What an agent last did to a position, as the contract records it. The
/// contract writes a short symbol because a Soroban symbol is nine characters;
/// this is the sentence it stands for.
export const AGENT_OPS: Record<string, string> = {
  rebal: 'held the level as the price moved',
  compnd: 'bought more stock with the yield',
  liq: 'repaid out of the buffer, no stock sold',
};
