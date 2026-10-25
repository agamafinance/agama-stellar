import { NextResponse } from 'next/server'
import { addr, read, stellarAsset, unitEnum } from '@/lib/chain'
import { dep, meta } from '@/lib/deployment'

export const revalidate = 0

type Health = {
  collateral: bigint
  debt: bigint
  ltv: number
  max_ltv: number
  threshold: number
}

/// One owner's whole book: what they hold, and every position they have open.
///
/// The position address is derived by the core, so this asks it rather than
/// guessing: `position_of` returns the address for an owner, market and
/// product whether or not it has been deployed yet.
export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get('owner')
  if (!owner) return NextResponse.json({ error: 'owner required' }, { status: 400 })

  const usdc = await read<bigint>(dep.blend.usdc, 'balance', [addr(owner)])

  const rows = await Promise.all(
    meta.map(async (m) => {
      const token = dep.stocks[m.symbol]
      if (!token) return null
      const held = await read<bigint>(token, 'balance', [addr(owner)])
      const price = await read<{ price: bigint } | null>(
        dep.contracts.oracle,
        'lastprice',
        [stellarAsset(token)],
      )

      const pos = await read<string>(dep.contracts.core, 'position_of', [
        addr(owner),
        addr(token),
        unitEnum('Earn'),
      ])

      let health: Health | null = null
      let vault: bigint | null = null
      let loose: bigint | null = null
      let shares: bigint | null = null
      if (pos) {
        health = await read<Health>(dep.contracts.core, 'health', [addr(pos)])
        // `health.collateral` is the stock PRICED, in dollars, not a share
        // count. The page multiplied it by the price again and showed a
        // position worth 1,385,000 dollars that held ten shares.
        shares = await read<bigint>(pos, 'collateral', [])
        vault = await read<bigint>(dep.contracts.vault, 'assets_of', [addr(pos)])
        loose = await read<bigint>(dep.blend.usdc, 'balance', [addr(pos)])
      }

      return {
        symbol: m.symbol,
        name: m.name,
        token,
        held: (held ?? 0n).toString(),
        price: price ? price.price.toString() : null,
        position: pos ?? null,
        shares: (shares ?? 0n).toString(),
        collateralValue: health ? health.collateral.toString() : '0',
        debt: health ? health.debt.toString() : '0',
        ltv: health ? health.ltv : 0,
        maxLtv: health ? health.max_ltv : m.ltv,
        threshold: health ? health.threshold : m.threshold,
        inVault: (vault ?? 0n).toString(),
        loose: (loose ?? 0n).toString(),
      }
    }),
  )

  return NextResponse.json({
    owner,
    usdc: (usdc ?? 0n).toString(),
    rows: rows.filter(Boolean),
  })
}
