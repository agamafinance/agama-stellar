import { NextResponse } from 'next/server';
import { readSnapshot } from '@/lib/stellar/snapshot';

// No caching. Every number here is one a user is about to sign a transaction
// against, and a lending position shown from stale data is the one number
// they cannot afford to be wrong about.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get('owner') ?? undefined;
  try {
    return NextResponse.json(await readSnapshot(owner));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'the network is not answering' },
      { status: 503 },
    );
  }
}
