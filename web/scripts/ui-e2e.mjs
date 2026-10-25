// UI end to end on Solana devnet with a real signer.
//
//   node scripts/ui-e2e.mjs [base_url]      default http://127.0.0.1:3031
//
// A headless Chromium opens the app with an injected wallet (window.solana)
// whose signTransaction is a throwaway Keypair held by this script, funded
// with at most 0.1 SOL from ~/.config/solana/id.json and swept back at the
// end. Every click is a real devnet transaction. Flow, private by default:
// faucet into the private balance, Earn from private, the slider, close back
// to private, Amplify open and close, Portfolio. Every balance is checked from
// outside with the wallet's own confidential keys. Screenshots land in
// /tmp/agama-solana-*.png. Fails on any page error or any error the app
// writes under a button. Refuses to run on anything but devnet or a local
// validator.
//
// Needs `playwright` resolvable (PLAYWRIGHT_PATH) and a cached Chromium
// (CHROME_PATH), since this app does not depend on either.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const BASE = (process.argv[2] ?? 'http://127.0.0.1:3031').replace(/\/$/, '');
const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');
// The funder pays the throwaway wallet: FUNDER_KEY (a keypair as a JSON array,
// on CI) or the local Solana CLI key.
const funder = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.FUNDER_KEY ?? fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))),
);
const sweepTo = process.env.SWEEP_TO ? new PublicKey(process.env.SWEEP_TO) : funder.publicKey;
const user = Keypair.generate();

// ---------------------------------------------------------------------------
// Confidential helpers: derive the wallet's keys from outside the app, to
// check the balances it shows.
// ---------------------------------------------------------------------------
import {
  createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage, createTransactionPlanExecutor,
  createTransactionPlanner, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  address as kaddress,
} from '@solana/kit';
import { fetchToken, findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  decryptConfidentialTransferBalance, deriveConfidentialKeys, getCreateConfidentialTransferAccountInstructionPlan,
} from '@solana-program/token-2022/confidential';
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk';
import { PublicKey } from '@solana/web3.js';

const idl = JSON.parse(fs.readFileSync(new URL('../lib/solana/idl.json', import.meta.url), 'utf8'));
const PROGRAM = new PublicKey(idl.address);
const pdaOf = (...seeds) => PublicKey.findProgramAddressSync(seeds.map((x) => (typeof x === 'string' ? Buffer.from(x) : x)), PROGRAM)[0];
const sym8 = (s) => { const b = Buffer.alloc(8); b.write(s); return b; };
const USDC_MINT = pdaOf('usdc.v2');
const TSLA_MINT = pdaOf('stock.v2', sym8('TSLA'));
const kitRpc = createSolanaRpc(RPC);

async function kitSend(msg) {
  const { value: bh } = await kitRpc.getLatestBlockhash().send();
  const tx = await signTransactionMessageWithSigners(setTransactionMessageLifetimeUsingBlockhash(bh, msg));
  const sig = getSignatureFromTransaction(tx);
  await kitRpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await kitRpc.getSignatureStatuses([sig]).send();
    if (value[0]?.err) throw new Error(`${sig} failed`);
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout ' + sig);
}

async function recipientKeys(kp) {
  const signer = await createKeyPairSignerFromBytes(kp.secretKey);
  const k = await deriveConfidentialKeys({ signer });
  const secret = ElGamalSecretKey.fromBytes(k.elgamalKeypair.secretKey);
  return { signer, elgamal: ElGamalKeypair.fromSecretKey(secret), secret, ae: AeKey.fromBytes(k.aeKey) };
}

/// The recipient sets up private balances on their side, outside the app.
async function configureRecipient(keys, mints) {
  const planner = createTransactionPlanner({
    createTransactionMessage: () => pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(keys.signer, m)),
  });
  const executor = createTransactionPlanExecutor({ executeTransactionMessage: async (_c, m) => ({ signature: await kitSend(m) }) });
  for (const mint of mints) {
    const plan = await getCreateConfidentialTransferAccountInstructionPlan({
      payer: keys.signer, owner: keys.signer, mint: kaddress(mint.toBase58()), rpc: kitRpc, elgamalKeypair: keys.elgamal, aesKey: keys.ae,
    });
    await executor(await planner(plan));
  }
}

async function privateOf(keys, mint) {
  const [token] = await findAssociatedTokenPda({ owner: keys.signer.address, mint: kaddress(mint.toBase58()), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const acc = await fetchToken(kitRpc, token);
  const b = decryptConfidentialTransferBalance({ tokenAccount: acc.data, elgamalSecretKey: keys.secret, aesKey: keys.ae });
  return { public: acc.data.amount, private: b.availableBalance + b.pendingBalance };
}

const errors = [];
const sigs = [];

/// Throwaway wallets give back what they did not spend, so a run costs fees and
/// rent, not the funding.
async function sweep(kp) {
  try {
    const bal = await conn.getBalance(kp.publicKey);
    const keep = 0.001 * LAMPORTS_PER_SOL;
    if (sweepTo && bal > keep + 5000) {
      await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: sweepTo, lamports: bal - keep - 5000 })), [kp]);
    }
  } catch (e) {
    console.error('sweep failed', e.message);
  }
}

async function main() {
  // Never on mainnet: devnet's genesis, or a local validator.
  const genesis = await conn.getGenesisHash();
  if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' && !/127\.0\.0\.1|localhost/.test(RPC)) {
    throw new Error(`not devnet (genesis ${genesis})`);
  }
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: user.publicKey, lamports: Math.min(Number(process.env.FUND_SOL ?? 0.08), 0.1) * LAMPORTS_PER_SOL }),
    ),
    [funder],
  );
  console.log('test wallet', user.publicKey.toBase58());

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  globalThis.__page = page;
  globalThis.__console = [];
  page.on('console', (m) => globalThis.__console.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on('pageerror', (e) => errors.push(String(e)));
  // Legacy transactions from the Anchor client, v0 ones from the confidential
  // flows (Kit), already carrying the proof accounts' own signatures.
  await page.exposeFunction('__agamaSign', (b64) => {
    const raw = Buffer.from(b64, 'base64');
    const v = VersionedTransaction.deserialize(raw);
    if (v.version === 'legacy') {
      const tx = Transaction.from(raw);
      tx.partialSign(user);
      return tx.serialize({ requireAllSignatures: false }).toString('base64');
    }
    v.sign([user]);
    return Buffer.from(v.serialize()).toString('base64');
  });
  await page.exposeFunction('__agamaSignMessage', (b64) =>
    Buffer.from(nacl.sign.detached(Buffer.from(b64, 'base64'), user.secretKey)).toString('base64'),
  );
  const pk = user.publicKey.toBase58();
  await page.addInitScript((pk) => {
    const key = { toString: () => pk, toBase58: () => pk };
    window.solana = {
      publicKey: key,
      connect: async () => ({ publicKey: key }),
      disconnect: async () => {},
      signTransaction: async (tx) => {
        const raw = 'version' in tx ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const signed = await window.__agamaSign(btoa(String.fromCharCode(...raw)));
        return { serialize: () => Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)) };
      },
      signAllTransactions: async (txs) => Promise.all(txs.map((t) => window.solana.signTransaction(t))),
      signMessage: async (msg) => {
        const sig = await window.__agamaSignMessage(btoa(String.fromCharCode(...msg)));
        return { signature: Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)) };
      },
    };
  }, pk);

  const shot = async (name) => {
    await page.waitForTimeout(1500);
    const f = `/tmp/agama-solana-${name}.png`;
    await page.screenshot({ path: f, fullPage: true });
    console.log('screenshot', f);
  };
  // Waits for the result line under the pressed button and fails on an error.
  // A status line counts only once: each action must produce a new signature.
  const settle = async (label) => {
    const seen = sigs.map(([, s]) => s);
    const handle = await page.waitForFunction(
      (seen) => {
        for (const el of document.querySelectorAll('[data-testid="status"]')) {
          const a = el.querySelector('a');
          const sig = a ? a.href.split('/tx/')[1]?.split('?')[0] : undefined;
          if (sig && seen.includes(sig)) continue;
          if (sig || !el.innerText.startsWith('Done.')) return { text: el.innerText, sig };
        }
        return false;
      },
      seen,
      { timeout: Number(process.env.SETTLE_MS ?? 90_000), polling: 500 },
    );
    const { text, sig } = await handle.jsonValue();
    if (!text.startsWith('Done.') || !sig) throw new Error(`${label}: ${text}`);
    sigs.push([label, sig]);
    console.log(`${label.padEnd(12)} ${sig}`);
  };
  const nav = (label) => page.locator('header nav').getByRole('link', { name: label, exact: true }).click();

  await page.goto(`${BASE}/solana`);
  await page.getByText('$', { exact: false }).first().waitFor();
  await page.waitForFunction(() => /\$\d/.test(document.body.innerText));
  await shot('earn-disconnected');

  await page.getByRole('button', { name: 'Connect Wallet' }).first().click();
  await page.getByRole('button', { name: 'Injected wallet' }).click();
  await page.getByText(pk.slice(0, 4)).first().waitFor();

  // The same keys the app derives, to check every balance from outside.
  const me = await recipientKeys(user);
  const SPY_MINT = pdaOf('stock.v2', sym8('SPY'));
  const expect = async (what, mint, pub, priv) => {
    const b = await privateOf(me, mint);
    const ok = (pub === undefined || b.public === pub) && (priv === undefined || b.private === priv);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: public ${b.public}, private ${b.private}`);
    if (!ok) throw new Error(`${what}: expected public ${pub} private ${priv}`);
    return b;
  };

  // 1. Faucet: minted straight into the private balance.
  await nav('Faucet');
  await page.getByRole('button', { name: 'Get the test tokens' }).click();
  await settle('faucet');
  await shot('faucet');
  await expect('faucet TSLAx', TSLA_MINT, 0n, 10n * 10n ** 8n);
  await expect('faucet USDC', USDC_MINT, 0n, 10_000n * 10n ** 6n);

  // 2. Earn from private.
  await nav('Earn');
  await page.waitForFunction(() => document.body.innerText.includes('private'), null, { timeout: 60_000 });
  await page.getByPlaceholder('0.00').fill('2');
  await page.getByRole('button', { name: 'Deposit and start earning' }).click();
  await settle('earn open');
  await page.getByText('Agents running').waitFor({ timeout: 60_000 });
  await shot('earn-position');
  await expect('after deposit TSLAx', TSLA_MINT, 0n, 8n * 10n ** 8n);

  // 3. The slider.
  await page.getByLabel('Target LTV').fill('1500');
  await page.getByRole('button', { name: /Move the target to/ }).click();
  await settle('slider');
  await page.waitForFunction(() => /Target level\s*15(\.0)?%/.test(document.body.innerText), null, { timeout: 60_000 });

  // 4. Close: the stock comes back private.
  await page.getByRole('button', { name: 'Close, get the stock back' }).click();
  await settle('earn close');
  await shot('earn-closed');
  await expect('after close TSLAx', TSLA_MINT, 0n, 10n * 10n ** 8n);
  await expect('after close USDC public', USDC_MINT, 0n, undefined);

  // 5. Amplify from private, and back.
  await nav('Amplify');
  await page.waitForFunction(() => /\d\.\d\dx max/.test(document.body.innerText), null, { timeout: 60_000 });
  await page.getByPlaceholder('0.00').fill('2');
  await page.getByRole('button', { name: /^Amplify \d/ }).click();
  await settle('amplify open');
  await page.getByText('Agents running').waitFor({ timeout: 60_000 });
  await shot('amplify-position');
  await expect('after loop SPYx', SPY_MINT, 0n, 8n * 10n ** 8n);
  await page.getByRole('button', { name: 'Close, sell what repays, keep the rest' }).click();
  await settle('amplify close');
  const spy = await expect('after unwind SPYx public', SPY_MINT, 0n, undefined);
  if (spy.private < 9n * 10n ** 8n || spy.private > 10n * 10n ** 8n) throw new Error(`SPYx private ${spy.private}`);

  // 6. Portfolio reads the private balances.
  await nav('Portfolio');
  await page.getByTestId('held-TSLA').waitFor({ timeout: 60_000 });
  const tsla = await page.getByTestId('held-TSLA').innerText();
  console.log('portfolio TSLAx', tsla);
  if (!tsla.startsWith('10')) throw new Error(`portfolio shows ${tsla} TSLAx`);
  await shot('portfolio');

  await browser.close();
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  console.log('PASS');
}

// Exit explicitly: an RPC websocket left open by the final transfer would keep
// the process alive (and a CI job running until its timeout).
main()
  .finally(() => sweep(user))
  .then(() => process.exit(0))
  .catch(async (e) => {
  console.error('FAIL', e.message ?? e);
  try {
    const text = await globalThis.__page?.evaluate(() => document.body.innerText);
    if (text) console.error('page at failure:\n' + text.slice(0, 1500));
    console.error('console (last 25):\n' + (globalThis.__console ?? []).slice(-25).join('\n'));
  } catch {}
  process.exit(1);
});
