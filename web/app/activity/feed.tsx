'use client'

import { useEffect, useState } from 'react'
import { dec, money, short } from '@/lib/format'
import { useWallet } from '../wallet'

type Event = {
  ledger: number
  ledger_closed_at: string
  event_name: string
  params: Record<string, unknown>
}

export function Feed() {
  const { address } = useWallet()
  const [events, setEvents] = useState<Event[] | null>(null)
  const [mine, setMine] = useState(false)

  useEffect(() => {
    const q = mine && address ? `?owner=${address}` : ''
    fetch(`/api/activity${q}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setEvents(d.events))
      .catch(() => setEvents([]))
  }, [mine, address])

  return (
    <div>
      <div className="flex items-end justify-between">
        <h1 className="text-[32px] font-semibold tracking-[-0.02em]">Activity</h1>
        {address && (
          <button
            onClick={() => setMine((v) => !v)}
            className="h-9 rounded-full border border-[var(--line)] px-4 text-[13px] font-medium"
          >
            {mine ? 'Everyone' : 'Only mine'}
          </button>
        )}
      </div>

      {events === null && (
        <p className="mt-8 text-[14px] text-[var(--ink-faint)]">Reading the chain…</p>
      )}

      {events?.length === 0 && (
        <div className="mt-8 rounded-[14px] border border-[var(--line)] bg-[var(--card)] px-5 py-12 text-center">
          <p className="text-[15px] text-[var(--ink-soft)]">Nothing for the moment</p>
          <p className="mx-auto mt-2 max-w-[400px] text-[13px] leading-[1.6] text-[var(--ink-faint)]">
            This reads the core's events straight off the network, and testnet keeps only a few
            hours of them. An empty list means nothing happened recently, not that nothing ever
            did.
          </p>
        </div>
      )}

      {events && events.length > 0 && (
        <div className="mt-8 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)]">
          {events.map((e, i) => (
            <div
              key={`${e.ledger}-${i}`}
              className="flex items-baseline gap-4 border-b border-[var(--hair)] px-5 py-3.5 last:border-0"
            >
              <span className="w-[86px] shrink-0 text-[13px] font-medium">
                {label(e.event_name)}
              </span>
              <span className="flex-1 text-[14px] text-[var(--ink-soft)]">{describe(e)}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-[var(--ink-faint)]">
                {e.ledger_closed_at ? new Date(e.ledger_closed_at).toLocaleTimeString() : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function label(name: string): string {
  if (name === 'Opened') return 'Opened'
  if (name === 'Closed') return 'Closed'
  if (name === 'AgentRan') return 'Agent'
  return name
}

function describe(e: Event): string {
  const p = e.params
  if (e.event_name === 'Opened') {
    return `${dec(p.collateral as string, 4)} supplied, ${money(p.borrowed as string)} borrowed, target ${Number(p.target_bps) / 100}%`
  }
  if (e.event_name === 'Closed') {
    return `${dec(p.returned as string, 4)} handed back to ${short(String(p.owner))}`
  }
  if (e.event_name === 'AgentRan') {
    const action = String(p.action ?? '')
    const what =
      action === 'rebal' ? 'rebalanced' : action === 'compnd' ? 'compounded' : action === 'liq' ? 'liquidated' : action
    return `${what} ${short(String(p.position))} by ${short(String(p.agent))}`
  }
  return JSON.stringify(p)
}
