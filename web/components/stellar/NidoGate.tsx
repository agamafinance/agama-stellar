'use client';

/// The one thing a passkey account asks of its owner.
///
/// A Nido account is a contract whose passkey can only sign for the account
/// itself, so it cannot authorise a call into the protocol. What it can do is
/// adopt a rule: this app's key may call these functions on this contract,
/// until this time, up to this much. The owner approves that once, with their
/// passkey, and every call after it is signed in the page with no prompt.
///
/// This component is where that is explained and asked for, and it exists
/// because the asking cannot be hidden: it is a redirect to Nido and one
/// confirmation per rule. The screen says what each rule is for before it
/// goes, and says plainly that the uncapped one has to be accepted as
/// uncapped, because Nido's page offers a cap for every rule and a cap on
/// anything but a transfer is refused on use.

import { useCallback, useEffect, useState } from 'react';

import { card, primaryBtn, secondaryBtn } from './ui';
import type { Stock } from '@/lib/stellar/config';
import { useStellarWallet } from '@/lib/stellar/WalletProvider';

type Grant = import('@/lib/nido/agama').Grant;
type SessionStatus = import('@/lib/nido/agama').SessionStatus;

type Nido = typeof import('@/lib/nido/agama');
let nidoPromise: Promise<Nido> | null = null;
/// Loaded on demand: a visitor with a Freighter extension never downloads any
/// of this.
const nido = () => (nidoPromise ??= import('@/lib/nido/agama'));

export type Session = {
  /// Undefined until the browser has been asked, so the first render does not
  /// claim an approval is missing before it has looked.
  status?: SessionStatus;
  /// Whether this account needs the gate at all.
  smart: boolean;
  ready: boolean;
  approve: () => void;
  check: () => void;
  forget: () => void;
  /// What the last check or approval had to say.
  note?: string;
  busy: boolean;
  refresh: () => void;
};

/// Track what the connected account has approved for one market.
///
/// Both products ask for the same two rules, so the hook takes the market
/// rather than the call: a visitor approves once and then deposits, moves the
/// target, closes and loops without being sent anywhere again.
export function useNidoSession(stock?: Stock): Session {
  const { address, smart } = useStellarWallet();
  const [status, setStatus] = useState<SessionStatus>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!address || !smart || !stock) return setStatus(undefined);
    void nido().then((n) => setStatus(n.statusFor(address, n.allGrants(stock))));
  }, [address, smart, stock]);

  useEffect(() => {
    refresh();
    if (!smart) return;
    let stop = () => {};
    void nido().then((n) => {
      stop = n.onSessionChange(refresh);
    });
    return () => stop();
  }, [refresh, smart]);

  // Nido's answer to the last request, read out of the address bar on the way
  // back and then removed from it. This also walks on to the next rule when a
  // screen asked for two, so a pair of approvals is two passkey taps and one
  // return trip.
  useEffect(() => {
    if (!smart) return;
    void nido()
      .then((n) => n.resume())
      .then((r) => {
        if (!r) return;
        if (r.outcome === 'refused') setNote(r.message);
        if (r.outcome === 'cancelled') setNote('Nothing was approved, so nothing changed.');
        refresh();
      });
  }, [smart, refresh]);

  const approve = useCallback(() => {
    if (!address || !stock) return;
    setBusy(true);
    setNote('Preparing a key, then Nido will ask for your passkey...');
    void nido()
      .then((n) => n.askFor(address, n.allGrants(stock)))
      .catch((e) => {
        setNote(e instanceof Error ? e.message : 'Could not start the approval.');
        setBusy(false);
      });
  }, [address, stock]);

  const check = useCallback(() => {
    if (!address) return;
    setBusy(true);
    void nido()
      .then((n) => n.recheck(address))
      .then(({ approved, waiting }) => {
        setNote(
          waiting === 0
            ? `Your account has ${approved} rule${approved === 1 ? '' : 's'} for this app.`
            : 'Nothing landed yet. Ask Nido again, which cannot pay twice for a rule that is not there.',
        );
        refresh();
      })
      .catch((e) => setNote(e instanceof Error ? e.message : 'Could not read your account.'))
      .finally(() => setBusy(false));
  }, [address, refresh]);

  const forget = useCallback(() => {
    if (!address) return;
    void nido().then((n) => {
      n.forgetSession(address);
      setNote('This browser dropped its key. Approving again makes a new one.');
      refresh();
    });
  }, [address, refresh]);

  return {
    status,
    smart,
    ready: !smart || status?.state === 'ready',
    approve,
    check,
    forget,
    note,
    busy,
    refresh,
  };
}

const hours = (ms: number) => Math.max(0, Math.round((ms - Date.now()) / 3_600_000));

/// What each rule is for, in the words of this protocol rather than Perch's.
function describeGrant(g: Grant, stock?: Stock): string {
  if (!g.limit) return 'Call the protocol for you: deposit, set the level, close, loop, unwind.';
  return `Move up to ${g.limit.amount} ${stock?.ticker ?? 'of the stock'} a day out of your account, and nothing else.`;
}

/// The gate itself. Renders nothing for a wallet that holds a key.
export function NidoGate({ session, stock }: { session: Session; stock?: Stock }) {
  const { status, smart, note, busy, approve, check, forget } = session;
  if (!smart || !stock) return null;

  if (status?.state === 'ready') {
    const left = hours(status.expiresAt);
    return (
      <p className="text-[12px] text-fg-muted">
        Signing with your passkey approval, no prompt per action
        {left < 8760 ? `, ${left}h left` : ''}.{' '}
        <button type="button" onClick={forget} className="underline hover:text-fg">
          Forget this browser&apos;s key
        </button>
        {note && <span className="ml-1">{note}</span>}
      </p>
    );
  }

  const waiting = status?.state === 'waiting';
  const ask = status?.state === 'ask' ? status.ask : [];

  return (
    <div className={`${card} border border-[#254839]/15`}>
      <h3 className="text-[15px] font-semibold text-fg">
        {waiting ? 'Nido has not confirmed your approval' : 'Approve this app once, with your passkey'}
      </h3>
      {waiting ? (
        <p className="mt-2 text-[13px] text-fg-muted">
          Nido&apos;s relayer may have applied the rule anyway. Your account&apos;s own rules are the
          truth, so read them rather than guess.
        </p>
      ) : (
        <>
          <p className="mt-2 text-[13px] text-fg-muted">
            Your account is a contract and its passkey only signs for itself, so it cannot sign a call
            into the protocol. Instead it adopts rules: a key this page holds may make these calls for a
            day, and your account checks every one of them on chain.
          </p>
          <ul className="mt-3 space-y-2 text-[13px] text-fg-muted">
            {(ask.length ? ask : []).map((g) => (
              <li key={g.label} className="flex gap-2">
                <span aria-hidden className="text-fg">
                  &middot;
                </span>
                <span>{describeGrant(g, stock)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-[#b4571f]">
            Nido asks for a spending cap on each rule. The one that moves {stock.ticker}{' '}
            has its cap already. On the other, choose &ldquo;let this key spend without any cap&rdquo;: the protocol
            rule moves nothing itself, and a cap on a call that is not a transfer is refused later with
            nothing to show for it.
          </p>
        </>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={approve} disabled={busy} className={`${primaryBtn} sm:w-auto sm:px-6`}>
          {busy ? 'Opening Nido...' : waiting ? 'Ask Nido again' : `Approve ${ask.length || 2} rules`}
        </button>
        <button onClick={check} disabled={busy} className={`${secondaryBtn} sm:w-auto sm:px-6`}>
          Check again
        </button>
      </div>
      {note && <p className="mt-2 text-[12px] text-fg-muted">{note}</p>}
      <p className="mt-2 text-[11px] text-fg-muted">
        The key lives in this browser and pays its own fees. It never holds your money: everything it
        spends comes out of your account, under the rules above, and they expire on their own.
      </p>
    </div>
  );
}
