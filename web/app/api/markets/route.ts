import { NextResponse } from 'next/server'
import { contracts, loadMarkets } from '@/lib/markets'

// Fifteen seconds so a reload does not hammer the RPC, not so the number can
// be old. Anything longer and the page starts disagreeing with the contract
// the user is about to sign a transaction against.
export const revalidate = 15

export async function GET() {
  return NextResponse.json({ markets: await loadMarkets(), contracts })
}
