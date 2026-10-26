// Agama on Stellar, end to end, for a Nido passkey smart account.
//
// Everything a visitor with no extension and no keypair would do, driven
// against the real testnet and the real Nido: make an account with a passkey,
// connect it to the app, take the faucet, approve the app's session, deposit a
// stock, and then read the position off the chain rather than off the screen.
//
// The passkey is a Chrome virtual authenticator (scripts/nido/browser.mjs), so
// this runs without a fingerprint. Everything else is real: Nido's relayer
// deploys the account and applies the rules, and the app signs the deposit in
// the page with its own session key.
//
//   node scripts/nido/e2e.mjs                 headless, a new account
//   node scripts/nido/e2e.mjs --headed        watch it happen
//   APP=https://app.agama.finance/stellar-rwa node scripts/nido/e2e.mjs
//
// It needs the app running (pnpm dev in web/, port 3010) and the Stellar CLI
// with the `agama` identity, which it uses only to read.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { open } from './browser.mjs';
import { createAccount, rules } from './account.mjs';
import { walkGrants } from './grant.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const run = promisify(execFile);
const APP = process.env.APP ?? 'http://localhost:3010/stellar-rwa';
const HEADED = process.argv.includes('--headed');
const DIR = process.env.DIR ?? `/tmp/agama-nido-e2e-${Date.now()}`;
const SHOTS = process.env.SHOTS ?? '/tmp/agama-nido-e2e';

const deployment = JSON.parse(
  await (await import('node:fs/promises')).readFile(
    new URL('../../deployments/testnet.json', import.meta.url),
    'utf8',
  ),
);
const CORE = deployment.contracts.core;
const USDC = deployment.blend.usdc;
const TSLA = deployment.stocks.TSLAx;
/// What the deposit will be, in whole shares. The faucet hands out ten.
const DEPOSIT = '5';

const steps = [];
const step = (name) => {
  console.log(`\n=== ${name}`);
  steps.push(name);
};

/// Read a contract, through the CLI, the way the rest of this repository does.
async function read(id, fn, args = []) {
  const { stdout } = await run('stellar', [
    'contract',
    'invoke',
    '--quiet',
    '--id',
    id,
    '--source',
    process.env.STELLAR_ACCOUNT ?? 'agama',
    '--network',
    'testnet',
    '--',
    fn,
    ...args,
  ]);
  const last = stdout.trim().split('\n').at(-1);
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
}

/// What the button that was pressed has to say for itself, once it says
/// anything that settles the matter.
async function status(p, pattern, timeout) {
  return p.waitFor(
    `(() => {
      const t = document.querySelector('[data-testid=status]')?.innerText ?? '';
      return ${pattern}.test(t) ? t : null;
    })()`,
    { timeout },
  );
}

const balance = (token, who) => read(token, 'balance', ['--id', who]).then((v) => BigInt(v ?? 0));
const units = (v) => Number(v) / 1e7;

const browser = await open({ dir: DIR, headed: HEADED });
let failed;
try {
  step('A Nido account, with a passkey nobody typed');
  const { account, page: wallet } = await createAccount({ browser });
  console.log('account', account);
  console.log('rules  ', (await rules(account)).map((r) => r.name).join(', '));
  // Nido's own tab is done with. Left open it is another page showing this
  // address, and the connect popup is found by what is on it.
  await wallet.close();

  step('The app, connected through the wallet picker');
  const p = await browser.tab(APP);
  await p.settle(3000);
  await p.click('Connect Wallet');
  await p.settle(1000);
  await p.click('Nido');
  const short = `${account.slice(0, 4)}...${account.slice(-4)}`;
  // Nido's connect runs in a popup at its own origin, and a device with one
  // account can answer without showing anything, so the popup may already be
  // gone. Watch for either: the app holding the address is the only thing that
  // actually matters.
  let connected = false;
  for (let i = 0; i < 40 && !connected; i++) {
    connected = await p
      .eval(`document.body.innerText.includes(${JSON.stringify(short)})`)
      .catch(() => false);
    if (connected) break;
    const picker = await browser.popup('nido.fyi/connect', { timeout: 1000 }).catch(() => null);
    if (picker) await picker.click(account.slice(0, 6)).catch(() => {});
    await sleep(2000);
  }
  if (!connected) throw new Error('the app never got the address from Nido');
  console.log('connected as', short);
  await p.shot(`${SHOTS}/1-connected.png`);

  step('The faucet, which asks the account for nothing at all');
  await p.goto(`${APP}/faucet`);
  await p.settle(2500);
  await p.click('Get the test tokens');
  // The status line, not the page's prose: "In your wallet" is a label on
  // this screen, so watching the whole body says the claim landed before it
  // was made.
  console.log('faucet:', await status(p, /wallet|already served|refus|cannot|failed/i, 240_000));
  const [stock, dollars] = await Promise.all([balance(TSLA, account), balance(USDC, account)]);
  console.log(`TSLAx ${units(stock)}  USDC ${units(dollars)}`);
  if (stock === 0n) throw new Error('the faucet gave no stock');
  await p.shot(`${SHOTS}/2-funded.png`);

  step('A deposit, which needs the session the account has not granted yet');
  await p.goto(APP);
  await p.settle(3000);
  await p.click('TSLAx');
  await p.fill('input[placeholder="0.00"]', DEPOSIT);
  await p.settle(500);
  await p.click('Deposit and start earning');
  await p.waitForText(['Approve this app once', 'has not confirmed'], { timeout: 60_000 });
  console.log('the gate asked, as it should');
  await p.shot(`${SHOTS}/3-gate.png`);

  step('Two rules, approved with the passkey');
  await p.click('Approve').catch(() => p.click('Ask Nido again'));
  await walkGrants(p);
  const live = (await rules(account)).filter((r) => r.name.startsWith('agama'));
  console.log('rules now:', live.map((r) => `${r.name} (${r.policies.length} policies)`).join(', '));
  if (live.length !== 2) throw new Error(`expected two rules, found ${live.length}`);

  step('The same deposit, signed in the page with no prompt');
  await p.settle(2000);
  await p.click('TSLAx');
  await p.fill('input[placeholder="0.00"]', DEPOSIT);
  await p.settle(500);
  await p.click('Deposit and start earning');
  console.log('screen says:', await status(p, /Done|refus|no live rule|cap|failed/i, 300_000));
  await p.shot(`${SHOTS}/5-deposited.png`);

  step('The chain, which is the only answer that counts');
  const position = await read(CORE, 'position_of', [
    '--owner',
    account,
    '--token',
    TSLA,
    '--product',
    'Earn',
  ]);
  if (!position || typeof position !== 'string') throw new Error('no position on chain');
  const health = await read(CORE, 'health', ['--position', position]);
  console.log('position ', position);
  console.log('collateral', `$${units(BigInt(health.collateral)).toFixed(2)}`);
  console.log('debt      ', `$${units(BigInt(health.debt)).toFixed(2)}`);
  console.log('ltv       ', `${health.ltv / 100}% of ${health.max_ltv / 100}% allowed`);
  const left = await balance(TSLA, account);
  console.log('TSLAx left', units(left));

  step('Closing, which the same approval already covers');
  // Nothing new is asked for: handing the stock back is the position's own
  // call, so the core rule is the whole of it.
  // The position card appears on the snapshot that follows the deposit, so
  // the button to close it is not there the instant the deposit lands.
  await p.waitForText(['Close, get the stock back'], { timeout: 150_000 });
  await p.click('Close, get the stock back');
  console.log('screen says:', await status(p, /Done|refus|no live rule|failed/i, 300_000));
  const back = await balance(TSLA, account);
  console.log('TSLAx back', units(back));
  const gone = await read(CORE, 'position_of', ['--owner', account, '--token', TSLA, '--product', 'Earn']);
  console.log('position  ', gone === null ? 'closed' : gone);
  await p.shot(`${SHOTS}/6-closed.png`);

  console.log(`\nAll of it, for an account whose owner holds a passkey and nothing else.`);
  console.log(`account  https://stellar.expert/explorer/testnet/contract/${account}`);
  console.log(`position https://stellar.expert/explorer/testnet/contract/${position}`);
} catch (error) {
  failed = error;
  console.error(`\nfailed after ${steps.length} steps: ${error.message}`);
  for (const [, pg] of browser.pages) if (pg.log?.length) console.error(pg.log.slice(-6).join('\n'));
} finally {
  if (!HEADED || failed) await browser.close();
  else console.log('\nbrowser left open; ctrl-c to stop');
}
process.exit(failed ? 1 : 0);
