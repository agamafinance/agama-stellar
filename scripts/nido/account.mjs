// Create a Nido smart account in an automated browser, on testnet.
//
// The pages are Nido's own, so this is a record of how its setup actually
// works rather than a guess at it:
//
//   test.nido.fyi                    "Get started", then "Set up with your face"
//   /new-account/?setup=1#salt=...   reserves the address, no passkey yet
//   <c-address>.test.nido.fyi/new-account/?autopass=1
//                                    the passkey ceremony, on the account's own
//                                    subdomain because that is the WebAuthn rpId
//   then "Continue to my wallet"     the relayer deploys and funds the account
//
// The address is a function of the setup key, so it exists as a name before it
// exists as a contract. Nothing is on chain until the passkey is made and the
// relayer carries the deploy, which is why this waits for the contract to
// answer rather than for the page to say it is done.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { open } from './browser.mjs';

const run = promisify(execFile);
const NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';
const SOURCE = process.env.STELLAR_ACCOUNT ?? 'agama';

/**
 * The rules a smart account has installed, or null when the network has never
 * heard of it.
 *
 * Read through the Stellar CLI, the way everything else in this repository
 * reads a contract, so this script needs no dependency of its own. An address
 * exists as a name before it exists as a contract, so this is the only honest
 * test of whether Nido's relayer carried the deploy.
 */
export async function rules(id) {
  try {
    const { stdout } = await run('stellar', [
      'contract',
      'invoke',
      '--quiet',
      '--id',
      id,
      '--source',
      SOURCE,
      '--network',
      NETWORK,
      '--',
      'installed_rules',
    ]);
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } catch {
    return null;
  }
}

export const deployed = async (id) => (await rules(id)) !== null;

/**
 * Make an account and come back with its address, the browser still open so
 * the passkey can be used again.
 */
export async function createAccount({ dir, headed = false, browser } = {}) {
  const b = browser ?? (await open({ dir, headed }));
  const p = await b.tab('https://test.nido.fyi');
  await p.settle(2000);
  await p.clickId('get-started-hero');
  await p.settle(600);
  await p.click('Set up with your face');

  // ?setup=1 prepares by itself and then offers one button.
  await p.waitFor(
    `(() => {
      const b = document.getElementById('preparing-continue');
      return b && !b.disabled && !b.classList.contains('hidden') ? 'ready' : null;
    })()`,
    { timeout: 120_000 },
  );
  await p.clickId('preparing-continue');

  // The passkey is made on the account's own subdomain, which names it.
  const host = await p.waitFor(
    `(() => { const m = location.host.match(/^(c[a-z0-9]{55})\\./); return m ? m[1] : null })()`,
    { timeout: 120_000 },
  );
  const account = host.toUpperCase();

  // "Continue to my wallet" is what sends the deploy to Nido's relayer, and it
  // has to wait for the passkey: this page keeps every step in the DOM and
  // only shows one at a time, so its text says "Continue to my wallet" long
  // before that button means anything. Clicking it early leaves an account
  // that exists as an address and nowhere else.
  await p.waitFor(
    `(() => {
      const b = document.getElementById('enroll-continue');
      const s = document.getElementById('recovery-enroll-section');
      return b && !b.disabled && s && !s.classList.contains('hidden') ? 'ready' : null;
    })()`,
    { timeout: 120_000 },
  );
  await p.clickId('enroll-continue');

  let live = false;
  for (let i = 0; i < 60 && !live; i++) {
    live = await deployed(account);
    if (!live) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!live) throw new Error(`${account} was never deployed. Nido's relayer may be out of budget.`);

  // An account is on the device once Nido's apex lists it, and that list is
  // not written by the page that made the account: the wallet at the
  // account's own subdomain pushes it to the apex through the storage they
  // share. Until it lands, Nido's connect picker says there is nothing on
  // this device, so waiting for it is what makes connecting afterwards
  // deterministic rather than a race. Leave the wallet page be while it
  // happens, and ask the apex in a tab of its own.
  await p.waitFor(`location.pathname.startsWith('/account') ? 'wallet' : null`, { timeout: 120_000 });
  await p.settle(4000);
  const apex = await b.tab('https://test.nido.fyi/');
  const listed = `(JSON.parse(localStorage.getItem('nido:testnet:accounts') ?? '[]')).includes(${JSON.stringify(account)}) ? 'listed' : null`;
  const sync = await apex.waitFor(listed, { timeout: 30_000 }).catch(() => null);
  if (!sync) {
    // The push is Nido's to make and it does not always arrive. Writing the
    // account into the apex's own list is exactly what that push does, and
    // the race it loses is not the thing under test here.
    await apex.eval(`(() => {
      const key = 'nido:testnet:accounts';
      const all = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (!all.includes(${JSON.stringify(account)})) all.push(${JSON.stringify(account)});
      localStorage.setItem(key, JSON.stringify(all));
      return all.length;
    })()`);
    console.log('  registered it on the device by hand: Nido had not pushed it to the apex');
  }
  await apex.close();
  return { browser: b, page: p, account };
}

if (import.meta.filename === process.argv[1]) {
  const { account, browser } = await createAccount({
    dir: process.env.DIR,
    headed: process.argv.includes('--headed'),
  });
  console.log(`\naccount: ${account}`);
  console.log(`explorer: https://stellar.expert/explorer/testnet/contract/${account}`);
  await browser.close();
}
