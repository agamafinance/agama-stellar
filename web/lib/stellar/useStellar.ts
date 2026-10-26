'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Contract, rpc, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

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

/// One call the screens make: which contract, which function, which arguments,
/// and the market it is about when there is one.
///
/// The market is here because a smart account has to approve one rule per
/// contract a call authorises, and only the call site knows which stock's
/// token that is.
export type Call = {
  id: string;
  fn: string;
  args: xdr.ScVal[];
  stock?: Stock;
  /// What a smart account's screen rebuilds this call from when the owner
  /// comes back from signing it with their passkey.
  arm?: { fn: string; symbol?: string; amount?: string; ltv?: number };
};

/// Build, simulate, sign, send, wait.
///
/// The simulate step is not an optimisation. A Soroban transaction has to
/// carry the exact ledger entries it will touch and the resources it will
/// burn, and only the network can work those out; skipping it produces a
/// transaction rejected for a reason unrelated to what it was trying to do.
///
/// A smart account takes a different road entirely. It cannot be a
/// transaction's source and its passkey cannot authorise a call into another
/// contract, so the call is signed in the page by the session key its owner
/// granted this app. That code is loaded only when a smart account is
/// connected, which keeps it out of everyone else's bundle.
export async function send(
  source: string,
  call: Call,
  sign: (xdr: string) => Promise<string>,
  progress?: (text: string) => void,
  /// True when the owner has just signed for this call and it should run
  /// rather than ask again. Only a smart account reads it.
  armed = false,
): Promise<string> {
  if (StrKey.isValidContract(source)) {
    const nido = await import('@/lib/nido/agama');
    if (!armed) {
      // Ask for the passkey first, every time. A Perch account cannot sign a
      // call into another contract, so what the owner confirms is the rule
      // that allows this one, and renewing it is that confirmation. This
      // navigates to Nido and comes back to a page that runs the call.
      progress?.('Asking Nido for your passkey...');
      return nido.signFor(source, call.fn, call.stock, { account: source, ...call.arm, fn: call.fn });
    }
    // Back from the ceremony with the rule just renewed, so the call goes
    // straight through, signed in the page by this app's key.
    return nido.invokeViaSession(source, call.id, call.fn, call.args, [], progress);
  }

  progress?.('Preparing the transaction...');
  const account = await server.getAccount(source);
  const built = new TransactionBuilder(account, { fee: '10000000', networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(call.id).call(call.fn, ...call.args))
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
export const ix: Record<string, (...a: never[]) => Call> & {
  faucet: (user: string) => Call;
  faucetOne: (user: string, s: Stock) => Call;
  earnDeposit: (user: string, s: Stock, amount: bigint, ltvBps: number) => Call;
  earnSetTarget: (user: string, s: Stock, ltvBps: number) => Call;
  earnClose: (user: string, s: Stock) => Call;
  amplifyOpen: (user: string, s: Stock, amount: bigint, ltvBps: number) => Call;
  amplifyClose: (user: string, s: Stock) => Call;
} = {
  /// Every market and the dollar, in one call, and nobody has to sign for the
  /// drip itself. The core is the stocks' admin so it mints them, and the
  /// dollar comes out of what it holds above its buffer.
  ///
  /// The signed faucet is still there, and so are the per token ones. This is
  /// the one the screen uses because it is the only one a smart account can
  /// face: the signed version asks the holder to authorise twelve contracts,
  /// which for a passkey account is twelve confirmations.
  faucet: (user: string) => ({
    id: CORE,
    fn: 'faucet_for',
    args: [addr(user)],
    arm: { fn: 'faucet_for' },
  }),
  faucetOne: (user: string, s: Stock) => ({ id: s.token, fn: 'faucet', args: [addr(user)], stock: s }),
  earnDeposit: (user: string, s: Stock, amount: bigint, ltvBps: number) => ({
    id: CORE,
    fn: 'earn_deposit',
    args: [addr(user), addr(s.token), i128(amount), u32(ltvBps)],
    stock: s,
    arm: { fn: 'earn_deposit', symbol: s.symbol, amount: String(amount), ltv: ltvBps },
  }),
  earnSetTarget: (user: string, s: Stock, ltvBps: number) => ({
    id: CORE,
    fn: 'earn_set_target',
    args: [addr(user), addr(s.token), u32(ltvBps)],
    stock: s,
    arm: { fn: 'earn_set_target', symbol: s.symbol, ltv: ltvBps },
  }),
  earnClose: (user: string, s: Stock) => ({
    id: CORE,
    fn: 'earn_close',
    args: [addr(user), addr(s.token)],
    stock: s,
    arm: { fn: 'earn_close', symbol: s.symbol },
  }),
  amplifyOpen: (user: string, s: Stock, amount: bigint, ltvBps: number) => ({
    id: CORE,
    fn: 'amplify_open',
    args: [addr(user), addr(s.token), i128(amount), u32(ltvBps)],
    stock: s,
    arm: { fn: 'amplify_open', symbol: s.symbol, amount: String(amount), ltv: ltvBps },
  }),
  amplifyClose: (user: string, s: Stock) => ({
    id: CORE,
    fn: 'amplify_close',
    args: [addr(user), addr(s.token)],
    stock: s,
    arm: { fn: 'amplify_close', symbol: s.symbol },
  }),
};

/// A contract error arrives inside a wall of diagnostics. This pulls out the
/// part a person can act on, because "contract error 7" sends the reader to
/// the source for something the screen already knew.
export function errorText(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw);
  // A smart account's refusals come back as contract errors too, in the
  // thirty two hundreds, so they are read first: looked up in the table below
  // they would be reported as the core refusing something.
  for (const [pattern, text] of ACCOUNT_ERRORS) if (pattern.test(s)) return text;
  const m = s.match(/Error\(Contract, #(\d+)\)/);
  if (m) return CORE_ERRORS[m[1]] ?? `The contract refused this (code ${m[1]}).`;
  if (/Error\(Auth/.test(s)) return 'The wallet did not authorise this.';
  if (/User (declined|rejected)|denied/i.test(s)) return 'You declined the signature.';
  const first = s.split('\n')[0];
  return first.length > 150 ? `${first.slice(0, 150)}...` : first;
}

/// What a Perch smart account says when it refuses, and what Nido's relayer
/// says when it will not carry something. The account checks its rules during
/// simulation, so a refusal here cost nothing and sent nothing.
const ACCOUNT_ERRORS: [RegExp, string][] = [
  [/#3221/, 'Your account refused this: it would go past the cap you gave this app. Nothing was sent.'],
  [
    /#3002|#3016/,
    'Your account has no live rule for this call, or it expired. Approve the session again.',
  ],
  [/#3014/, 'Your account has no rule for one of the contracts this call touches.'],
  [
    /#3223/,
    'One of your rules carries a cap on something that is not a transfer, which the account cannot meter. Approve that rule again and leave it uncapped.',
  ],
  [
    /FEE_LIMIT_EXCEEDED/,
    'Nido\u2019s free transaction budget is spent for now, so nothing was sent. Try again later.',
  ],
  [/POOL_CAPACITY/, 'Nido\u2019s relayer is busy, so nothing was sent. Try again in a minute.'],
];

const CORE_ERRORS: Record<string, string> = {
  '1': 'Only the admin can do that.',
  '2': 'There is no market for that token.',
  '3': 'That market already exists.',
  '4': 'That market is not open.',
  '5': 'The amount has to be above zero.',
  '6': 'That level is above what this market allows right now.',
  '7': 'There is no position there.',
  '8': 'A position is already open there.',
  '9': 'The price is too old to borrow against. The keeper pushes a new one every few minutes.',
  '10': 'The protocol buffer is empty, so a repayment cannot be made right now.',
  '11': 'That position is healthy, so it cannot be liquidated.',
  '12': 'The protocol is paused.',
  '13': 'The faucet already served this address. It gives again an hour after the last one.',
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
