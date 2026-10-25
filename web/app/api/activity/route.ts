import { NextResponse } from 'next/server'
import { dep } from '@/lib/deployment'

export const revalidate = 10

type Event = {
  ledger: number
  ledger_closed_at: string
  event_name: string
  params: Record<string, unknown>
}

/// What the protocol has actually done, read off the chain.
///
/// The core emits an event for every position opened or closed and every
/// agent pass, so this needs no database: the chain is the log. Testnet RPC
/// only keeps a few hours of it, which is why this says so on the page rather
/// than pretending an empty list means nothing happened.
export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get('owner')
  const latest = await ledger()
  const start = Math.max(1, latest - 5000)

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getEvents',
    params: {
      startLedger: start,
      filters: [{ type: 'contract', contractIds: [dep.contracts.core] }],
      xdrFormat: 'json',
      pagination: { limit: 100 },
    },
  }

  const r = await fetch('https://soroban-testnet.stellar.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const json = await r.json()
  const raw = json?.result?.events ?? []

  const events: Event[] = raw
    .map(decode)
    .filter((e: Event | null): e is Event => e !== null)
    .filter((e: Event) => !owner || matches(e, owner))
    .reverse()

  return NextResponse.json({ events, window: { start, latest } })
}

/// The RPC hands back topics and a value as JSON-shaped XDR.
///
/// An event's name is NOT in its topics. `#[contractevent(topics = ["agent"])]`
/// puts "agent" there and nothing else, so reading the struct name off the
/// topic list finds nothing and every row comes back labelled "event". The
/// prefix topic is the name, under a different spelling.
const NAMED: Record<string, string> = {
  opened: 'Opened',
  closed: 'Closed',
  agent: 'AgentRan',
}

/// A `#[topic]` field is NOT in the event body, it is in the topic list after
/// the prefix, in declaration order. So the body of an AgentRan carries only
/// its action and delta, and the agent and the position have to be read back
/// out of the topics. Miss this and every agent row reads "rebalanced
/// undefined by undefined".
const INDEXED: Record<string, string[]> = {
  Opened: ['owner', 'market'],
  Closed: ['owner', 'market'],
  AgentRan: ['agent', 'position'],
}

function decode(e: Record<string, unknown>): Event | null {
  try {
    const topics = (e.topicJson ?? e.topic) as Array<Record<string, unknown>>
    const prefix = topics?.map((t) => t?.symbol as string).find((s) => s in NAMED)
    const value = (e.valueJson ?? e.value) as Record<string, unknown>
    const name = prefix ? NAMED[prefix] : 'event'
    const params = flatten(value)
    const after = topics.slice(topics.findIndex((x) => (x?.symbol as string) === prefix) + 1)
    for (const [i, field] of (INDEXED[name] ?? []).entries()) {
      if (after[i] !== undefined && params[field] === undefined) params[field] = leaf(after[i])
    }
    return {
      ledger: Number(e.ledger),
      ledger_closed_at: String(e.ledgerClosedAt ?? ''),
      event_name: name,
      params,
    }
  } catch {
    return null
  }
}

/// Pull the leaves out of the RPC's XDR-as-JSON so the page gets plain values.
function flatten(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const m = (v as { map?: Array<{ key: unknown; val: unknown }> })?.map
  if (!Array.isArray(m)) return out
  for (const entry of m) {
    const k = (entry.key as { symbol?: string })?.symbol
    if (!k) continue
    out[k] = leaf(entry.val)
  }
  return out
}

function leaf(v: unknown): unknown {
  const o = v as Record<string, unknown>
  if (!o || typeof o !== 'object') return v
  if ('address' in o) return o.address
  if ('i128' in o) return stringifyI128(o.i128)
  if ('u32' in o) return o.u32
  if ('u64' in o) return String(o.u64)
  if ('symbol' in o) return o.symbol
  if ('vec' in o && Array.isArray(o.vec)) return (o.vec as unknown[]).map(leaf)
  return v
}

/// An i128 arrives as a hi/lo pair, and reassembling it wrong is the kind of
/// bug that shows a reasonable number most of the time.
function stringifyI128(v: unknown): string {
  if (typeof v === 'string') return v
  const o = v as { hi?: string | number; lo?: string | number }
  if (o?.hi === undefined || o?.lo === undefined) return String(v)
  return ((BigInt(o.hi) << 64n) + BigInt(o.lo)).toString()
}

function matches(e: Event, owner: string): boolean {
  return Object.values(e.params).some((v) => v === owner)
}

async function ledger(): Promise<number> {
  const r = await fetch('https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1', {
    cache: 'no-store',
  })
  const j = await r.json()
  return j._embedded.records[0].sequence
}
