'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Contract, rpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

import { BPS, CORE, PASSPHRASE, RPC, UNIT, type Stock } from './config';
import { addr, i128, u32 } from './scval';
import type { MarketView, PositionView, Snapshot } from './snapshot';

export type { MarketView as Market, PositionView as Position, Snapshot };

const server = new rpc.Server(RPC);

/// How often to ask, and only while somebody is looking.
///
/// The visibility gate is not a nicety, it is the whole difference between a
/// page that costs a few hundred requests a month and one that costs a
/// million. A tab left open on a 20 second timer is 4,320 requests a DAY, for
/// nobody, forever: ten forgotten tabs over a month is past the entire plan.
/// Hidden, this asks for nothing at all.
///
/// Connected is a minute, because a position's numbers move when the price
/// does and the keeper pushes every few minutes. Not connected is two, because
/// the markets screen is the same for everyone and nothing on it moves faster
/// than that.
const POLL_CONNECTED = 60_000;
const POLL_ANONYMOUS = 120_000;

/// One snapshot, refreshed while the tab is visible and after every action.
///
/// The fan-out runs on the server, so this is a single request rather than the
/// seventy contract reads behind it. That is the opposite trade from the
/// Solana build this app is forked from, which reads the chain straight from
/// the browser: its polling costs its RPC provider and nothing else, ours
/// costs a request on our own plan. So ours has to be far more careful about
/// how often it asks.
///
/// When a request fails the last good snapshot is kept and the page says how
/// old it is, because a page that empties itself every time an RPC hiccups is
/// worse than one that admits to being a minute behind.
export function useSnapshot(owner: string | null) {
  const [snap, setSnap] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      // Under the app's own path prefix, not at the root. A rewrite on
      // app.agama.finance only forwards /stellar-rwa/*, so an API route at
      // /api/snapshot is served by the product app sitting in front of this
      // one: it answers its own 404 page, and the first thing the screen says
      // is that HTML is not valid JSON.
      const r = await fetch(`/stellar-rwa/api/snapshot${owner ? `?owner=${owner}` : ''}`, {
        cache: 'no-store',
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'the network is not answering');
      const next = (await r.json()) as Snapshot;
      if (!live.current) return;
      setSnap(next);
      setError(undefined);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'the network is not answering');
    }
  }, [owner]);

  useEffect(() => {
    live.current = true;
    let id: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const start = () => {
      stop();
      id = setInterval(load, owner ? POLL_CONNECTED : POLL_ANONYMOUS);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // One catch-up read on the way back, not a backlog of the ones that
        // were skipped. Somebody returning to the tab wants today's number,
        // not the four they missed.
        void load();
        start();
      } else {
        stop();
      }
    };

    void load();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      live.current = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, owner]);

  return { snap, error, refresh: load };
}

/// Build, simulate, sign, send, wait.
///
/// The simulate step is not an optimisation. A Soroban transaction has to
/// carry the exact ledger entries it will touch and the resources it will
/// burn, and only the network can work those out; skipping it produces a
/// transaction rejected for a reason unrelated to what it was trying to do.
export async function send(
  source: string,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  sign: (xdr: string) => Promise<string>,
  progress?: (text: string) => void,
): Promise<string> {
  progress?.('Preparing the transaction...');
  const account = await server.getAccount(source);
  const built = new TransactionBuilder(account, { fee: '10000000', networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(errorText(sim.error));
  const prepared = rpc.assembleTransaction(built, sim).build();

  progress?.('Waiting for your signature...');
  const signed = await sign(prepared.toXDR());

  progress?.('Sending...');
  const sent = await server.sendTransaction(TransactionBuilder.fromXDR(signed, PASSPHRASE));
  if (sent.status === 'ERROR') throw new Error('The network rejected the transaction.');

  // Poll rather than assume. A transaction accepted for inclusion has not
  // necessarily succeeded, and a failed deposit reported as done is worse
  // than one that errors.
  for (let i = 0; i < 60; i++) {
    const got = await server.getTransaction(sent.hash);
    if (got.status === 'SUCCESS') return sent.hash;
    if (got.status === 'FAILED') throw new Error('The transaction failed on chain.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Still pending after a minute.');
}

/// The calls the screens make.
export const ix = {
  /// Every market and the dollar, in one call and one signature. The per
  /// token faucets are still there and still permissionless; this is the one
  /// the screen uses, because eleven approvals is where people stop.
  faucet: (user: string) => ({ id: CORE, fn: 'faucet', args: [addr(user)] }),
  faucetOne: (user: string, s: Stock) => ({ id: s.token, fn: 'faucet', args: [addr(user)] }),
  earnDeposit: (user: string, s: Stock, amount: bigint, ltvBps: number) => ({
    id: CORE,
    fn: 'earn_deposit',
    args: [addr(user), addr(s.token), i128(amount), u32(ltvBps)],
  }),
  earnSetTarget: (user: string, s: Stock, ltvBps: number) => ({
    id: CORE,
    fn: 'earn_set_target',
    args: [addr(user), addr(s.token), u32(ltvBps)],
  }),
  earnClose: (user: string, s: Stock) => ({
    id: CORE,
    fn: 'earn_close',
    args: [addr(user), addr(s.token)],
  }),
  amplifyOpen: (user: string, s: Stock, amount: bigint, ltvBps: number) => ({
    id: CORE,
    fn: 'amplify_open',
    args: [addr(user), addr(s.token), i128(amount), u32(ltvBps)],
  }),
  amplifyClose: (user: string, s: Stock) => ({
    id: CORE,
    fn: 'amplify_close',
    args: [addr(user), addr(s.token)],
  }),
};

/// A contract error arrives inside a wall of diagnostics. This pulls out the
/// part a person can act on, because "contract error 7" sends the reader to
/// the source for something the screen already knew.
export function errorText(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw);
  const m = s.match(/Error\(Contract, #(\d+)\)/);
  if (m) return CORE_ERRORS[m[1]] ?? `The contract refused this (code ${m[1]}).`;
  if (/Error\(Auth/.test(s)) return 'The wallet did not authorise this.';
  if (/User (declined|rejected)|denied/i.test(s)) return 'You declined the signature.';
  const first = s.split('\n')[0];
  return first.length > 150 ? `${first.slice(0, 150)}...` : first;
}

const CORE_ERRORS: Record<string, string> = {
  '1': 'Only the admin can do that.',
  '2': 'That market is not open.',
  '3': 'The amount has to be above zero.',
  '4': 'That level is above what this market allows right now.',
  '5': 'There is no position there.',
  '6': 'The price is too old to borrow against. The keeper pushes a new one every few minutes.',
  '7': 'The protocol buffer is empty, so a repayment cannot be made right now.',
  '8': 'The protocol is paused.',
  '9': 'That position is healthy, so it cannot be liquidated.',
  '10': 'A position is already open there.',
};

// ---- numbers ----

export const stockValue = (shares: bigint, price: bigint) => (shares * price) / UNIT;

/// What a given number of dollars buys, at the oracle price.
export const stockFor = (usdc: bigint, price: bigint) => (price > 0n ? (usdc * UNIT) / price : 0n);

export function fmt(v: bigint, decimals: number, dp: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % scale).toString().padStart(decimals, '0').slice(0, dp);
  return `${neg ? '-' : ''}${whole}${dp ? `.${frac}` : ''}`;
}

export const usd = (v: bigint | string | undefined, dp = 2) =>
  v === undefined ? '-' : `$${fmt(BigInt(v), 7, dp)}`;
export const qty = (v: bigint | string | undefined, dp = 4) =>
  v === undefined ? '-' : fmt(BigInt(v), 7, dp);
export const px = (v: bigint | string | undefined) =>
  v === undefined || BigInt(v) === 0n ? '-' : `$${fmt(BigInt(v), 7, 2)}`;
export const pct = (bps: number | bigint | undefined, dp = 2) =>
  bps === undefined ? '-' : `${(Number(bps) / 100).toFixed(dp)}%`;

export function ago(at: number | undefined): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export { BPS };
