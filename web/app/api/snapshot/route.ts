import { NextResponse } from 'next/server';
import { readSnapshot } from '@/lib/stellar/snapshot';

// Dynamic because the interesting half of a snapshot is one wallet's.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get('owner') ?? undefined;
  try {
    const snap = await readSnapshot(owner);
    return NextResponse.json(snap, {
      headers: {
        // Without an owner this is the markets screen, identical for every
        // visitor, so the edge can hand the same body to all of them for half
        // a minute and serve a stale one for two more while it refreshes. That
        // does not reduce the request count, which is counted at the edge
        // either way; it reduces the function invocations and the seventy
        // contract reads behind each one, which are metered separately and
        // are the slow part.
        //
        // With an owner it is one wallet's position and is never shared.
        'Cache-Control': owner
          ? 'private, no-store'
          : 'public, s-maxage=30, stale-while-revalidate=120',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'the network is not answering' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
