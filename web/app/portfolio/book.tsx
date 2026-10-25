'use client'

import { useCallback, useEffect, useState } from 'react'
import { CORE } from '@/lib/addresses'
import { addr, i128, u32 } from '@/lib/scval'
import { dec, money, pct } from '@/lib/format'
import { send } from '@/lib/tx'
import { useWallet } from '../wallet'
import { Gate } from '../gate'

type Row = {
  symbol: string
  name: string
  token: string
  held: string
  price: string | null
  position: string | null
  shares: string
  collateralValue: string
  debt: string
  ltv: number
  maxLtv: number
  threshold: number
  inVault: string
  loose: string
}

type Book = { owner: string; usdc: string; rows: Row[] }

const CARD = 'rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-5'

export function Book() {
  const { address, sign } = useWallet()
  const [book, setBook] = useState<Book | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!address) return
    const r = await fetch(`/api/position?owner=${address}`, { cache: 'no-store' })
    if (r.ok) setBook(await r.json())
  }, [address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!address) {
    return (
      <Gate
        title="Connect to see your positions"
        body="Everything here is read from the contracts, so there is nothing to show until there is an address to read for."
      />
    )
  }

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label)
    setNote(null)
    try {
      await run()
      setNote(`${label} done`)
      await refresh()
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const drip = (row: Row) =>
    act(`faucet ${row.symbol}`, () =>
      send(address, row.token, 'faucet', [addr(address)], sign),
    )

  const open = (row: Row) =>
    act(`deposit ${row.symbol}`, () =>
      send(
        address,
        CORE,
        'earn_deposit',
        [addr(address), addr(row.token), i128(row.held), u32(7000)],
        sign,
      ),
    )

  const close = (row: Row) =>
    act(`close ${row.symbol}`, () =>
      send(address, CORE, 'earn_close', [addr(address), addr(row.token)], sign),
    )

  const live = book?.rows.filter((r) => BigInt(r.shares) > 0n) ?? []
  const idle = book?.rows.filter((r) => BigInt(r.shares) === 0n) ?? []

  return (
    <div>
      <div className="flex items-end justify-between">
        <h1 className="text-[32px] font-semibold tracking-[-0.02em]">Portfolio</h1>
        <div className="text-right text-[13px] text-[var(--ink-soft)]">
          <div>{money(book?.usdc ?? '0')} USDC</div>
          <div className="text-[var(--ink-faint)]">in your wallet</div>
        </div>
      </div>

      {note && (
        <div className="mt-4 rounded-[10px] border border-[var(--line)] bg-white px-4 py-2.5 text-[13px]">
          {note}
        </div>
      )}

      {live.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[13px] uppercase tracking-[0.04em] text-[var(--ink-faint)]">
            Open
          </h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {live.map((r) => (
              <div key={r.symbol} className={CARD}>
                <div className="flex items-baseline justify-between">
                  <div>
                    <div className="text-[17px] font-semibold">{r.symbol}</div>
                    <div className="text-[13px] text-[var(--ink-faint)]">{r.name}</div>
                  </div>
                  <Ltv row={r} />
                </div>

                <dl className="mt-4 space-y-1.5 text-[14px]">
                  <Line k="Collateral" v={`${dec(r.shares, 4)} ${r.symbol}`} />
                  <Line k="Worth" v={money(r.collateralValue)} />
                  <Line k="Borrowed" v={money(r.debt)} />
                  <Line k="Earning in the vault" v={money(r.inVault)} />
                  {BigInt(r.loose) > 0n && (
                    <Line k="Yield waiting to compound" v={money(r.loose)} />
                  )}
                </dl>

                <button
                  onClick={() => close(r)}
                  disabled={busy !== null}
                  className="mt-5 h-10 w-full rounded-full border border-[var(--line)] text-[14px] font-medium transition-colors hover:bg-[#f6f5f1] disabled:opacity-40"
                >
                  {busy === `close ${r.symbol}` ? 'Closing…' : 'Close and take the stock back'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-[13px] uppercase tracking-[0.04em] text-[var(--ink-faint)]">
          {live.length > 0 ? 'Open another' : 'Open a position'}
        </h2>
        <div className="mt-3 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)]">
          <table className="w-full text-[14px]">
            <tbody>
              {idle.map((r) => {
                const has = BigInt(r.held) > 0n
                return (
                  <tr key={r.symbol} className="border-b border-[var(--hair)] last:border-0">
                    <td className="px-5 py-3.5">
                      <div className="font-medium">{r.symbol}</div>
                      <div className="text-[13px] text-[var(--ink-faint)]">{r.name}</div>
                    </td>
                    <td className="px-5 py-3.5 text-right tabular-nums text-[var(--ink-soft)]">
                      {r.price ? money(r.price) : '—'}
                    </td>
                    <td className="px-5 py-3.5 text-right tabular-nums">
                      {dec(r.held, 4)}
                    </td>
                    <td className="w-[170px] px-5 py-3.5 text-right">
                      <button
                        onClick={() => (has ? open(r) : drip(r))}
                        disabled={busy !== null || !r.price}
                        className="h-9 w-full rounded-full bg-[var(--ink)] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#33332f] disabled:opacity-30"
                      >
                        {busy === `deposit ${r.symbol}` || busy === `faucet ${r.symbol}`
                          ? 'Working…'
                          : has
                            ? 'Deposit all'
                            : 'Get test shares'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[13px] text-[var(--ink-faint)]">
          The faucet hands out a fixed quantity once an hour per address. Depositing borrows
          seventy percent of the value and puts it in the vault in the same transaction.
        </p>
      </section>
    </div>
  )
}

function Ltv({ row }: { row: Row }) {
  const near = row.ltv >= row.threshold - 200
  return (
    <div className="text-right">
      <div className={`text-[17px] font-semibold tabular-nums ${near ? 'text-[#a4411f]' : ''}`}>
        {pct(row.ltv)}
      </div>
      <div className="text-[12px] text-[var(--ink-faint)]">
        target {pct(row.maxLtv, 0)} · out at {pct(row.threshold, 0)}
      </div>
    </div>
  )
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-[var(--ink-soft)]">{k}</dt>
      <dd className="tabular-nums font-medium">{v}</dd>
    </div>
  )
}

