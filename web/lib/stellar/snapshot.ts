import { Asset, StrKey } from '@stellar/stellar-sdk';

import { CORE, ORACLE, PASSPHRASE, POOL, PRODUCT, STOCKS, USDC, VAULT, type Kind, type Stock } from './config';
import { read } from './rpc';
import { addr, stellarAsset, unitEnum } from './scval';

/// Everything the three screens need, in one pass.
///
/// This runs on the server, not in the browser. A snapshot is about seventy
/// contract reads, and seventy round trips from a laptop over a public RPC is
/// several seconds of blank screen; from the server, fanned out, it is one.

export type MarketView = {
  stock: Stock;
  /// What the oracle answers now, at seven decimals, as a string so nothing
  /// is lost on the way through JSON.
  price: string;
  priceTime: number;
  /// The oracle refuses a price older than a day for a borrow.
  fresh: boolean;
  offHours: boolean;
  /// After the off-hours buffer, which is what the contract will actually use.
  ltv: number;
  threshold: number;
  enabled: boolean;
  /// What the connected wallet holds of this stock.
  balance: string;
};

export type PositionView = {
  address: string;
  kind: Kind;
  symbol: string;
  /// Shares pledged, and what they are worth at the oracle.
  collateral: string;
  value: string;
  debt: string;
  /// Dollars of this position's that are in the vault, and any that have come
  /// back and are waiting for an agent to turn them into stock.
  inVault: string;
  loose: string;
  ltvBps: number;
  targetLtvBps: number;
  threshold: number;
  lastAgentOp?: string;
  lastAgentAt?: number;
  lastAgentBy?: string;
};

export type Snapshot = {
  owner?: string;
  markets: MarketView[];
  earn: (PositionView | undefined)[];
  amplify: (PositionView | undefined)[];
  usdc: string;
  /// Native XLM, which pays the fees and is the one thing here nobody can
  /// mint for the visitor.
  xlm: string;
  /// Seconds before each market's own faucet gives again, in market order,
  /// with the dollar last. Zero means ready.
  faucetIn: number[];
  /// Seconds before the one click drip gives this address everything again.
  dripIn: number;
  /// Blend's borrow rate on USDC, in bps, computed from the reserve the way
  /// the pool computes it.
  borrowRateBps: number;
  utilizationBps: number;
  /// What a vault share is worth, at twelve decimals. Above one means the
  /// vault has earned since it opened.
  vaultRate: string;
  /// The protocol's own dollars, standing by to answer a fall without selling
  /// anyone's stock.
  buffer: string;
  at: number;
};

type ChainMarket = {
  token: string;
  reserve_index: number;
  ltv: number;
  threshold: number;
  off_hours_buffer: number;
  off_hours: boolean;
  enabled: boolean;
};

type Health = {
  collateral: bigint;
  debt: bigint;
  ltv: number;
  max_ltv: number;
  threshold: number;
};

type Touch = { agent: string; action: string; at: bigint };

export async function readSnapshot(owner?: string): Promise<Snapshot> {
  const chainMarkets = (await read<ChainMarket[]>(CORE, 'markets')) ?? [];
  const byToken = new Map(chainMarkets.map((m) => [m.token, m]));

  const markets = await Promise.all(
    STOCKS.map(async (stock): Promise<MarketView> => {
      const m = byToken.get(stock.token);
      const [price, balance] = await Promise.all([
        read<{ price: bigint; timestamp: bigint } | null>(ORACLE, 'lastprice', [
          stellarAsset(stock.token),
        ]),
        owner ? read<bigint>(stock.token, 'balance', [addr(owner)]) : Promise.resolve(0n),
      ]);
      const offHours = m?.off_hours ?? false;
      const buffer = m?.off_hours_buffer ?? stock.offHoursBufferBps;
      const at = price ? Number(price.timestamp) : 0;
      return {
        stock,
        price: price ? price.price.toString() : '0',
        priceTime: at,
        // A day is the contract's own limit, not a number chosen here.
        fresh: at > 0 && Date.now() / 1000 - at < 86_400,
        offHours,
        ltv: Math.max(0, (m?.ltv ?? stock.ltv) - (offHours ? buffer : 0)),
        threshold: Math.max(0, (m?.threshold ?? stock.threshold) - (offHours ? buffer : 0)),
        enabled: m?.enabled ?? false,
        balance: (balance ?? 0n).toString(),
      };
    }),
  );

  const [earn, amplify] = await Promise.all([
    positionsFor(owner, markets, 'earn'),
    positionsFor(owner, markets, 'amplify'),
  ]);

  const [usdc, reserve, vaultRate, buffer, faucetIn, dripIn, xlm] = await Promise.all([
    owner ? read<bigint>(USDC, 'balance', [addr(owner)]) : Promise.resolve(0n),
    read<ReserveData>(POOL, 'get_reserve', [addr(USDC)]),
    read<bigint>(VAULT, 'rate'),
    read<bigint>(CORE, 'buffer'),
    owner ? read<bigint[]>(CORE, 'faucet_in', [addr(owner)]) : Promise.resolve(null),
    owner ? read<bigint>(CORE, 'faucet_for_in', [addr(owner)]) : Promise.resolve(0n),
    owner ? nativeBalance(owner) : Promise.resolve(0),
  ]);

  const rates = blendRate(reserve);

  return {
    owner,
    markets,
    earn,
    amplify,
    usdc: (usdc ?? 0n).toString(),
    xlm: String(xlm ?? 0),
    faucetIn: (faucetIn ?? []).map((s) => Number(s)),
    dripIn: Number(dripIn ?? 0),
    borrowRateBps: rates.borrowBps,
    utilizationBps: rates.utilBps,
    vaultRate: (vaultRate ?? 10n ** 12n).toString(),
    buffer: (buffer ?? 0n).toString(),
    at: Math.floor(Date.now() / 1000),
  };
}

async function positionsFor(
  owner: string | undefined,
  markets: MarketView[],
  kind: Kind,
): Promise<(PositionView | undefined)[]> {
  if (!owner) return markets.map(() => undefined);
  return Promise.all(
    markets.map(async (mv) => {
      const pos = await read<string>(CORE, 'position_of', [
        addr(owner),
        addr(mv.stock.token),
        unitEnum(PRODUCT[kind]),
      ]);
      if (!pos) return undefined;

      const [health, shares, inVault, loose, target, touch] = await Promise.all([
        read<Health>(CORE, 'health', [addr(pos)]),
        read<bigint>(pos, 'collateral'),
        read<bigint>(VAULT, 'assets_of', [addr(pos)]),
        read<bigint>(USDC, 'balance', [addr(pos)]),
        read<number>(pos, 'target'),
        read<Touch | null>(pos, 'last_touch'),
      ]);
      if (!health || (shares ?? 0n) === 0n) return undefined;

      return {
        address: pos,
        kind,
        symbol: mv.stock.symbol,
        collateral: (shares ?? 0n).toString(),
        value: health.collateral.toString(),
        debt: health.debt.toString(),
        inVault: (inVault ?? 0n).toString(),
        loose: (loose ?? 0n).toString(),
        ltvBps: health.ltv,
        targetLtvBps: target ?? health.max_ltv,
        threshold: health.threshold,
        lastAgentOp: touch?.action,
        lastAgentAt: touch ? Number(touch.at) : undefined,
        lastAgentBy: touch?.agent,
      };
    }),
  );
}

/// The native Stellar Asset Contract, which is where a contract's XLM lives.
/// Derived rather than pasted in: it is a function of the network.
const NATIVE_SAC = Asset.native().contractId(PASSPHRASE);

/// XLM is a classic balance, not a contract one, so it comes from Horizon
/// rather than from a simulation.
///
/// Except for a smart account, which has no classic account at all: Horizon
/// answers 400 for a contract address, and its XLM is a balance inside the
/// native asset's own contract. Same number, read the only way it can be.
async function nativeBalance(owner: string): Promise<number> {
  if (StrKey.isValidContract(owner)) {
    const held = await read<bigint>(NATIVE_SAC, 'balance', [addr(owner)]);
    return Number(held ?? 0n) / 1e7;
  }
  try {
    const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${owner}`, {
      cache: 'no-store',
    });
    if (!r.ok) return 0;
    const j = await r.json();
    const native = j.balances?.find((b: { asset_type: string }) => b.asset_type === 'native');
    return native ? Number(native.balance) : 0;
  } catch {
    return 0;
  }
}

type ReserveData = {
  config: {
    r_base: number;
    r_one: number;
    r_two: number;
    r_three: number;
    util: number;
    max_util: number;
  };
  data: { b_rate: bigint; b_supply: bigint; d_rate: bigint; d_supply: bigint; ir_mod: bigint };
};

/// Blend's three-slope rate, computed the way the pool computes it.
///
/// Taking the rate from the reserve rather than naming a number here means it
/// moves when the pool moves. The slopes are seven decimal fixed point in the
/// reserve config; this gives back basis points, which is what the screen
/// shows.
function blendRate(r: ReserveData | null): { borrowBps: number; utilBps: number } {
  if (!r) return { borrowBps: 0, utilBps: 0 };
  const S7 = 10_000_000;
  const S12 = 1_000_000_000_000n;

  const supplied = Number((r.data.b_supply * r.data.b_rate) / S12);
  const borrowed = Number((r.data.d_supply * r.data.d_rate) / S12);
  if (supplied <= 0) return { borrowBps: bps(r.config.r_base), utilBps: 0 };

  const util = borrowed / supplied;
  const { r_base, r_one, r_two, r_three, util: target, max_util } = r.config;
  const t = target / S7;
  const cap = max_util / S7;

  let rate: number;
  if (util <= t) {
    rate = (util / t) * (r_one / S7) + r_base / S7;
  } else if (util <= cap) {
    rate = ((util - t) / (cap - t)) * (r_two / S7) + r_one / S7 + r_base / S7;
  } else {
    // Past the cap Blend's third slope is deliberately punitive: it is what
    // makes a lender's withdrawal possible rather than theoretical.
    const over = (util - cap) / (1 - cap);
    rate = over * (r_three / S7) + r_two / S7 + r_one / S7 + r_base / S7;
  }
  // ir_mod is the pool's own correction, a multiplier at SEVEN decimals, not
  // twelve like the b_rate and d_rate two lines above it. Mixing the two
  // scales reports every rate as zero, which looks like a pool nobody has
  // borrowed from rather than a unit error.
  const modded = (rate * Number(r.data.ir_mod)) / 1e7;
  return { borrowBps: Math.round(modded * 10_000), utilBps: Math.round(util * 10_000) };
}

const bps = (sevenDp: number) => Math.round((sevenDp / 10_000_000) * 10_000);
