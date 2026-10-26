'use client';

/// A passkey account, and what it signs.
///
/// A Nido account is a contract whose passkey can only sign for the account
/// itself, so it cannot authorise a call into the protocol. What it can sign
/// is a rule: this app's key may call these functions on this contract, until
/// this time, up to this much. That is the only shape of consent Perch has.
///
/// So every action here renews the rule it needs, with the passkey, and then
/// runs under it. One confirmation per action, which is what a signature per
/// action means for an account of this kind. The alternative, approving once
/// and then acting silently for a day, is the same rules with nobody watching
/// them being used.
///
/// The ceremony is a page navigation, so the action that started it is armed
/// in localStorage and run on the way back. `useNidoReturn` is that step.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Stock } from '@/lib/stellar/config';
import { useStellarWallet } from '@/lib/stellar/WalletProvider';

type Armed = import('@/lib/nido/agama').Armed;
type SessionStatus = import('@/lib/nido/agama').SessionStatus;

type Nido = typeof import('@/lib/nido/agama');
let nidoPromise: Promise<Nido> | null = null;
/// Loaded on demand: a visitor with a Freighter extension never downloads any
/// of this.
const nido = () => (nidoPromise ??= import('@/lib/nido/agama'));

export type Session = {
  /// Undefined until the browser has been asked.
  status?: SessionStatus;
  smart: boolean;
  /// What the last ceremony had to say, when it was not a plain yes.
  note?: string;
  busy: boolean;
  check: () => void;
  forget: () => void;
  refresh: () => void;
};

/// What this account has standing right now, for the market on screen.
export function useNidoSession(stock?: Stock): Session {
  const { address, smart } = useStellarWallet();
  const [status, setStatus] = useState<SessionStatus>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!address || !smart) return setStatus(undefined);
    void nido().then((n) =>
      setStatus(n.statusFor(address, stock ? n.allGrants(stock) : n.protocolGrant())),
    );
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

  const check = useCallback(() => {
    if (!address) return;
    setBusy(true);
    void nido()
      .then((n) => n.recheck(address))
      .then(({ approved, waiting }) => {
        setNote(
          waiting === 0
            ? `Your account has ${approved} rule${approved === 1 ? '' : 's'} for this app.`
            : 'Nothing landed yet. Press the button again: Nido cannot charge twice for a rule that is not there.',
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
      setNote('This browser dropped its key. The next action makes a new one.');
      refresh();
    });
  }, [address, refresh]);

  return { status, smart, note, busy, check, forget, refresh };
}

/// Run the action the owner just signed for.
///
/// Called once per page load. Nido's answer arrives in the address bar; when
/// it is a yes, the armed action is handed back and the screen makes the call
/// it was asked for before the ceremony took the page away.
export function useNidoReturn(run: (armed: Armed) => void) {
  const { address, smart } = useStellarWallet();
  const latest = useRef(run);
  latest.current = run;

  useEffect(() => {
    if (!address || !smart) return;
    let gone = false;
    void (async () => {
      const n = await nido();
      const answer = await n.resume();
      if (gone || !answer) return;
      // `next-grant` means Nido is being asked for another rule and the page
      // is already on its way there, so there is nothing to run yet.
      if (answer.outcome === 'next-grant') return;
      const armed = n.takeArmed();
      if (answer.outcome === 'approved' && armed && armed.account === address) {
        latest.current(armed);
      }
    })();
    return () => {
      gone = true;
    };
  }, [address, smart]);
}

const hours = (ms: number) => Math.max(0, Math.round((ms - Date.now()) / 3_600_000));

/// The line a smart account sees under the button it is about to press, and
/// the one place a refused ceremony is explained.
export function NidoGate({ session }: { session: Session; stock?: Stock }) {
  const { status, smart, note, busy, check, forget } = session;
  if (!smart) return null;

  const waiting = status?.state === 'waiting';
  const live = status?.state === 'ready' ? hours(status.expiresAt) : undefined;

  return (
    <div className="mt-2 space-y-1">
      <p className="text-[12px] text-fg-muted">
        Every action asks for your passkey. Your account is a contract and its passkey only signs for
        itself, so what you confirm is the rule that lets this page make the call, renewed each time
        and checked on chain by your account.
      </p>
      {waiting && (
        <p className="text-[12px] text-[#b4571f]">
          Nido has not confirmed the last rule. Your account&apos;s own rules are the truth, so read them
          rather than guess.{' '}
          <button type="button" onClick={check} disabled={busy} className="underline hover:text-fg">
            Check again
          </button>
        </p>
      )}
      {note && <p className="text-[12px] text-fg-muted">{note}</p>}
      {live !== undefined && live > 0 && (
        <p className="text-[11px] text-fg-muted">
          The rules you have signed run out in {live}h on their own.{' '}
          <button type="button" onClick={forget} className="underline hover:text-fg">
            Forget this browser&apos;s key
          </button>
        </p>
      )}
    </div>
  );
}

/// What Nido's own page will ask for, said before the owner gets there.
export function NidoCapNote({ stock }: { stock?: Stock }) {
  const { smart } = useStellarWallet();
  if (!smart) return null;
  return (
    <p className="mt-2 text-[11px] text-[#b4571f]">
      Nido offers a spending cap on every rule. The one that moves {stock?.ticker ?? 'your stock'} comes
      with its cap filled in. On the protocol&apos;s own rule, choose &ldquo;let this key spend without
      any cap&rdquo;: it moves nothing itself, and a cap on a call that is not a transfer is refused
      later with nothing to show for it.
    </p>
  );
}
