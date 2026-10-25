import { dec, money, pct } from '@/lib/format'
import { contracts, loadMarkets } from '@/lib/markets'

// Read on every request, with a short window on the API route for
// anything polling. A lending position shown from stale data is the one
// number a user cannot afford to be wrong about.
export const revalidate = 15

export default async function Markets() {
  const markets = await loadMarkets()
  const signed = markets.filter((m) => m.signed).length

  return (
    <div>
      <h1 className="text-[32px] font-semibold tracking-[-0.02em]">Markets</h1>
      <p className="mt-2 max-w-[560px] text-[15px] leading-[1.55] text-[var(--ink-soft)]">
        Deposit the stock, keep the stock. Seventy percent of its value is borrowed against it
        and put to work, and an agent holds that ratio as the price moves.
      </p>

      <div className="mt-8 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)]">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-b border-[var(--hair)] text-left text-[12px] uppercase tracking-[0.04em] text-[var(--ink-faint)]">
              <th className="px-5 py-3 font-medium">Market</th>
              <th className="px-5 py-3 text-right font-medium">Price</th>
              <th className="px-5 py-3 text-right font-medium">Target LTV</th>
              <th className="px-5 py-3 text-right font-medium">Liquidates at</th>
              <th className="px-5 py-3 text-right font-medium">Off hours</th>
              <th className="px-5 py-3 text-right font-medium">Price source</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.symbol} className="border-b border-[var(--hair)] last:border-0">
                <td className="px-5 py-3.5">
                  <div className="font-medium">{m.symbol}</div>
                  <div className="text-[13px] text-[var(--ink-faint)]">{m.name}</div>
                </td>
                <td className="px-5 py-3.5 text-right font-medium tabular-nums">
                  {m.price ? money(m.price, m.symbol === 'BENJI' ? 4 : 2) : '—'}
                </td>
                <td className="px-5 py-3.5 text-right tabular-nums text-[var(--ink-soft)]">
                  {pct(m.ltv, 0)}
                </td>
                <td className="px-5 py-3.5 text-right tabular-nums text-[var(--ink-soft)]">
                  {pct(m.threshold, 0)}
                </td>
                <td className="px-5 py-3.5 text-right tabular-nums text-[var(--ink-soft)]">
                  −{pct(m.offHoursBuffer, 0)}
                </td>
                <td className="px-5 py-3.5 text-right">
                  {m.signed ? (
                    <span className="text-[13px] text-[var(--ink-soft)]">
                      RedStone ×3
                    </span>
                  ) : (
                    <span
                      className="text-[13px] text-[var(--ink-faint)]"
                      title={`The oracle is bound to ${m.feed}; RedStone carries it as ${m.redstone}`}
                    >
                      admin set
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-[13px] leading-[1.6] text-[var(--ink-faint)]">
        {signed} of {markets.length} markets carry a price signed by three independent RedStone
        signers, verified on chain. The other {markets.length - signed} are admin set: the
        oracle is bound to a ticker RedStone publishes under a different name, and the deployed
        instance has no way to repoint a feed.
      </p>

      <div className="mt-10 grid gap-3 text-[13px] text-[var(--ink-soft)] md:grid-cols-2">
        {Object.entries(contracts).map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-3">
            <span className="w-16 shrink-0 text-[var(--ink-faint)]">{k}</span>
            <a
              className="truncate font-mono text-[12px] hover:text-[var(--ink)]"
              href={`https://stellar.expert/explorer/testnet/contract/${v}`}
              target="_blank"
              rel="noreferrer"
            >
              {v}
            </a>
          </div>
        ))}
      </div>
      <p className="mt-6 text-[13px] text-[var(--ink-faint)]">
        Lending is Blend, in our own instance of it. Dollars earn in the vault. Testnet.
      </p>
      <span className="hidden">{dec(0)}</span>
    </div>
  )
}
