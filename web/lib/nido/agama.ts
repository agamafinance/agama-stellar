'use client';

/// Agama's calls, made for a Nido smart account.
///
/// A Nido account is a contract, not a keypair, and its passkey signs under one
/// rule: "admin", scoped to the account itself. So the sign popup cannot
/// authorise a call into the core, or into a token the core moves. It refuses
/// with #3002 or #3014, and that is by design rather than a bug.
///
/// What works instead is a session key. The owner approves, once with their
/// passkey, a Perch rule naming a key this app holds as a delegated signer on
/// one contract, for one list of functions, until an expiry, optionally under a
/// rolling cap. After that this app signs those calls itself, in the page, with
/// no prompt at all. The account still enforces the rule on chain for every
/// one of them, and the key never holds the user's money.
///
/// So the grants are the interesting part of this file: one per contract in a
/// call's authorisation tree, which here means the core for the call itself and
/// the stock's token for the transfer inside it.

import { Account, Contract, StrKey, TransactionBuilder, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';

import { CORE, PASSPHRASE, RPC, type Stock } from '@/lib/stellar/config';
import {
  ensureSessionKey,
  loadSession,
  requestSession,
  sessionStatus,
  submitWithSession,
  type Grant,
  type SessionStatus,
} from './session';

/// Nido's hosted wallet, which is testnet only, like this deployment.
export const NIDO_BASE = 'test.nido.fyi';
export const NIDO_HOME = 'https://test.nido.fyi';

/// A smart account is a contract address. Everything in this app branches on
/// that rather than on which wallet said it was connected.
export const isSmartAccount = (address: string) => StrKey.isValidContract(address);

const server = new rpc.Server(RPC);

/// A transaction needs a source account and a contract cannot be one. The real
/// source is the session key, chosen inside `submitWithSession`; this is only
/// what the call is built against before it is rebuilt there.
const SIM_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/// The session key is a classic account and pays its own fees, because Nido's
/// relayer cannot submit CAP-0071 delegate entries yet.
const friendbotUrl = (address: string) => `https://friendbot.stellar.org/?addr=${address}`;

/// How long a grant lasts before it has to be approved again. A day is Nido's
/// shortest, and the shortest is right for a testnet key held in a browser.
const DURATION = '24h' as const;

/// The core's functions a user calls for themselves. One rule covers all of
/// them, so a visitor approves the protocol once rather than once per action,
/// and the rule still names exactly what the key may do with it: nothing
/// administrative, nothing on anyone else's position.
const CORE_FUNCTIONS = [
  'earn_deposit',
  'earn_set_target',
  'earn_close',
  'amplify_open',
  'amplify_close',
];

/// The rule for the protocol itself. No cap, because the core moves no money
/// of the account's on its own: what leaves is the stock, and that is the
/// token's own rule below. Nido's page asks the owner to accept "no cap"
/// explicitly for a rule like this, which is why the screen says so first.
const coreGrant = (): Grant => ({
  target: CORE,
  functions: CORE_FUNCTIONS,
  duration: DURATION,
  label: 'agama-core',
});

/// The rule for one stock, which is the only thing a deposit takes out of the
/// account. A cap belongs here and nowhere else: Perch meters a cap by the
/// amount a `transfer` moves, so a capped rule on any other function is
/// refused on use with #3223.
///
/// The cap is a hundred times what the faucet hands out in an hour, which is
/// far above anything a tester holds and still a bound the owner can read.
const stockGrant = (s: Stock): Grant => ({
  target: s.token,
  functions: ['transfer'],
  duration: DURATION,
  limit: { amount: String(Math.max(1, Math.round(Number(s.drip) * 100))), period: 'day' },
  label: `agama-${s.symbol}`.slice(0, 20),
});

/// What each call needs approved before this app can make it.
///
/// One grant per contract in the call's authorisation tree. A deposit is the
/// core (the call) and the stock's token (the transfer the core makes out of
/// the account, which the account has to authorise too). Everything else is
/// the core alone: closing hands stock back, which the position authorises,
/// and the drip asks nobody for anything.
export function grantsFor(fn: string, s?: Stock): Grant[] {
  if (fn === 'faucet_for') return [];
  const needsStock = fn === 'earn_deposit' || fn === 'amplify_open';
  return needsStock && s ? [coreGrant(), stockGrant(s)] : [coreGrant()];
}

/// What the owner signs before this call runs, every single time.
///
/// A Perch account cannot sign a call into another contract, so there is
/// nothing for a passkey to confirm at the moment of a deposit. What it can
/// sign is the rule that allows the call, and asking again for a label
/// replaces that rule. So an action that renews its own rule is a passkey
/// confirmation per action, with the account enforcing the same rule on chain
/// a moment later.
///
/// Which rule, and why it is this one: the rule a deposit renews is the
/// stock's, because that one carries a cap and Nido fills the amount in. The
/// core's rule carries none, and an uncapped rule makes Nido ask the owner to
/// accept that explicitly, so it is renewed only when a call has nothing else
/// to renew or when it is not there at all.
export function grantsToSign(account: string, fn: string, s?: Stock): Grant[] {
  const core = coreGrant();
  const held = sessionStatus(account, [core]).state === 'ready';
  if ((fn === 'earn_deposit' || fn === 'amplify_open') && s) {
    const token = stockGrant(s);
    return held ? [token] : [token, core];
  }
  return [core];
}

/// An action waiting on the other side of a passkey ceremony.
///
/// The ceremony is a page navigation, so the click that started it is gone by
/// the time the owner comes back. This is what the screen rebuilds it from.
export type Armed = {
  account: string;
  fn: string;
  symbol?: string;
  /// Base units, as a string, because this goes through JSON.
  amount?: string;
  ltv?: number;
};

const ARMED = 'agama-stellar:nido-armed';

export function arm(a: Armed) {
  localStorage.setItem(ARMED, JSON.stringify(a));
}

/// The armed action, once. Reading it clears it: coming back to this page
/// later, or reloading it, must not make a deposit nobody asked for twice.
export function takeArmed(): Armed | null {
  const raw = localStorage.getItem(ARMED);
  localStorage.removeItem(ARMED);
  try {
    return raw ? (JSON.parse(raw) as Armed) : null;
  } catch {
    return null;
  }
}

export const dropArmed = () => localStorage.removeItem(ARMED);

/// Send the owner to Nido to sign this action, and remember what it was.
/// Navigates away: nothing after this runs.
export function signFor(account: string, fn: string, stock: Stock | undefined, armed: Armed) {
  arm(armed);
  return requestSession({
    account,
    grants: grantsToSign(account, fn, stock),
    base: NIDO_BASE,
    friendbotUrl,
  });
}

/// Every rule a market can ever need, for showing what is standing.
export const allGrants = (s: Stock): Grant[] => [coreGrant(), stockGrant(s)];

/// The protocol's own rule, which every screen needs and the faucet page is
/// the only one with no market to go with it.
export const protocolGrant = (): Grant[] => [coreGrant()];

/// Thrown when a call is not covered yet. The screen catches it and shows the
/// gate rather than a failure: nothing was sent and nothing was paid.
export class NeedsSession extends Error {
  constructor(
    readonly grants: Grant[],
    readonly status: SessionStatus,
  ) {
    super('This needs your approval once, with your passkey.');
    this.name = 'NeedsSession';
  }
}

/// Where a call stands for this account right now.
export const statusFor = (account: string, grants: Grant[]) => sessionStatus(account, grants);

/// Send the owner to Nido to approve what is missing. Navigates away; the
/// answer is picked up by `resume` on the way back.
export function askFor(account: string, grants: Grant[]): Promise<never> {
  const status = sessionStatus(account, grants);
  const ask = status.state === 'ask' ? status.ask : grants;
  return requestSession({ account, grants: ask, base: NIDO_BASE, friendbotUrl });
}

/// Make one call for a smart account, signed in the page by the session key.
export async function invokeViaSession(
  account: string,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  grants: Grant[],
  progress?: (text: string) => void,
): Promise<string> {
  if (grants.length) {
    const status = sessionStatus(account, grants);
    if (status.state !== 'ready') throw new NeedsSession(grants, status);
  }

  // A call that needs no rule still needs somebody to pay for it, and a
  // contract cannot pay. The first one waits on Friendbot for the key; after
  // that this is instant.
  let session = loadSession(account);
  if (!session) {
    progress?.('Preparing this app’s key...');
    session = await ensureSessionKey({ account, friendbotUrl });
  }

  progress?.('Signing with your approval...');
  const built = new TransactionBuilder(new Account(SIM_SOURCE, '0'), {
    fee: '1000000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(180)
    .build();

  const { hash } = await submitWithSession<unknown>(
    built,
    (v: xdr.ScVal) => scValToNative(v),
    session,
    server,
    PASSPHRASE,
  );
  return hash;
}

/// Record Nido's answer to a grant request, once per page load.
///
/// This both reads the answer out of the address bar and moves on to the next
/// grant when a screen asked for more than one, so a two rule approval is two
/// passkey taps and one trip back here.
export async function resume() {
  const { resumeSession } = await import('./session');
  try {
    return await resumeSession({ base: NIDO_BASE, server, networkPassphrase: PASSPHRASE });
  } catch {
    // A resume that fails must never be what stops the page from loading.
    return null;
  }
}

/// Read the account's own rules and record what actually landed.
///
/// Nido's page can report a failure for a grant that went through, or lose the
/// way back here. The account's installed rules are the truth, so this is what
/// the "Check again" button asks.
export async function recheck(account: string) {
  const { checkSession } = await import('./session');
  return checkSession(account, server, PASSPHRASE);
}

export { forgetSession, onSessionChange, loadSession, type Grant, type SessionStatus } from './session';
