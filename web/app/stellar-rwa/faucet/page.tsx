'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Copy, ExternalLink } from 'lucide-react';

import { TokenIcon } from '@/components/icons/TokenIcon';
import { asset, CORE, STOCKS } from '@/lib/stellar/config';
import { useStellarWallet } from '@/lib/stellar/WalletProvider';
import { errorText, ix, send, usd, useSnapshot } from '@/lib/stellar/useStellar';
import { Status, Step } from '@/components/stellar/ui';
import { NidoGate, useNidoReturn, useNidoSession } from '@/components/stellar/NidoGate';

// The one thing here nobody can mint for the visitor.
const XLM_FAUCET = 'https://lab.stellar.org/account/fund';

export default function StellarFaucetPage() {
  const { address, connect, sign, smart } = useStellarWallet();
  const { snap, refresh } = useSnapshot(address);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; hash?: string }>();
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /// Eleven tokens, one call, and nobody signs for the drip.
  ///
  /// The core is the stocks' admin so it mints them, and the dollar comes out
  /// of what it holds above its buffer. That matters most for a passkey smart
  /// account: the signed faucet asks the holder to authorise twelve separate
  /// contracts, which for such an account is twelve confirmations before
  /// anything arrives. This asks for none.
  async function claim(signed = false) {
    if (!address) return connect();
    setBusy(true);
    setStatus({ text: 'Building the transaction...' });
    try {
      const hash = await send(address, ix.faucet(address), sign, (text) => setStatus({ text }), signed);
      setStatus({ text: '10,000 USDC and 10 of each stock are in your wallet.', hash });
    } catch (e) {
      setStatus({ text: errorText(e) });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  // A smart account signs for the drip like it signs for everything else, and
  // comes back here to take it.
  const session = useNidoSession();
  useNidoReturn((armed) => {
    if (armed.fn === 'faucet_for') void claim(true);
  });

  const xlm = snap && address ? snap.xlm : undefined;
  // A smart account does not pay its own fees here, so an empty one is not a
  // problem to warn about.
  const lowOnXlm = !smart && xlm !== undefined && Number(xlm) < 100;
  // The drip is one cooldown for the whole claim now, not one per token.
  const nextIn = snap?.dripIn ?? 0;
  const waiting = nextIn > 0 ? 11 : 0;

  return (
    <>
      <section className="px-6 md:px-24 pt-10 md:pt-14 pb-8">
        <div className="max-w-[1400px] mx-auto relative">
          <div aria-hidden className="pointer-events-none absolute right-4 top-2 z-20 hidden lg:block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={asset('/stellar.svg')}
              alt=""
              className="h-[170px] w-[170px] drop-shadow-[0_18px_30px_rgba(20,50,35,0.25)]"
            />
          </div>

          <h1 className="mt-3 text-[34px] md:text-[44px] leading-[1.05] text-fg font-semibold">
            Get testnet funds
          </h1>
          <p className="mt-4 max-w-[640px] text-[15px] text-fg-muted">
            Grab testnet XLM for fees, then take the stand-in USDC, the nine shares and gold in one approval.
            Stellar carries none of them yet, so these are ours: SEP-41 tokens priced by RedStone reports signed by
            three independent signers and verified on chain.
          </p>

          <div className="mt-7 flex flex-wrap gap-8">
            <Stat
              label="Network"
              value="Stellar Testnet"
              sub={`Core ${CORE.slice(0, 4)}...${CORE.slice(-4)}`}
            />
            <Stat label="Asset" value="Shares" sub={`${STOCKS.length - 1} stocks and gold`} />
            <Stat
              label="USDC"
              value={snap && address ? usd(snap.usdc).replace('$', '') : '-'}
              sub={address ? 'In your wallet' : 'Stand-in USDC'}
            />
            <Stat
              label="XLM"
              value={xlm !== undefined ? Number(xlm).toFixed(3) : '-'}
              sub={smart ? 'This app pays your fees' : 'For fees'}
            />
          </div>
        </div>
      </section>

      <section className="vault-panel relative z-10 rounded-t-[20px] px-6 md:px-24 pt-10 md:pt-14 pb-24">
        <div className="max-w-[1400px] mx-auto space-y-3">
          <h2 className="mb-2 text-[13px] uppercase tracking-wider text-fg-muted">Get funded</h2>

          {/* A passkey smart account pays no fees of its own: the key this
              page holds pays them, and Friendbot funds that key. Offering a
              faucet for an address Friendbot cannot create would be a dead
              end, so this step is only here for a wallet with a keypair. */}
          {!smart && (
            <StepRow
              icon={
                // eslint-disable-next-line @next/next/no-img-element
                <img src={asset('/stellar.svg')} alt="" className="h-10 w-10 shrink-0 rounded-full" />
              }
              title="XLM for fees"
              blurb="Stellar testnet transactions are paid in XLM, and opening a position deploys a contract, so it wants rather more than a transfer would. Friendbot hands out 10,000 at a time; it is the one thing here nobody can mint for you."
            >
              <FaucetLink href={XLM_FAUCET} label="Open XLM faucet" />
            </StepRow>
          )}

          <StepRow
            icon={
              <div className="flex shrink-0 -space-x-2">
                <TokenIcon symbol="USDC" size={40} />
                <TokenIcon symbol="TSLAx" size={40} />
                <TokenIcon symbol="NVDAx" size={40} />
              </div>
            }
            title="USDC, the nine shares and gold"
            blurb="10,000 USDC, and 10 each of TSLAx, NVDAx, AAPLx, MSFTx, AMZNx, GOOGLx, METAx, SPYx, BENJI and GOLDx. Eleven tokens, one call, one signature."
          >
            <MintButton
              onClick={address ? () => claim() : () => connect()}
              busy={busy}
              label={address ? 'Get the test tokens' : 'Connect a wallet'}
              busyLabel={status?.text}
              disabled={busy}
            />
          </StepRow>

          <p className="pt-2 text-[12px] text-fg-muted">
            {!address ? (
              <button type="button" onClick={() => connect()} className="underline hover:text-fg">
                Connect a wallet
              </button>
            ) : lowOnXlm ? (
              `${Number(xlm).toFixed(2)} XLM here: paste your address into the XLM faucet above first.`
            ) : waiting > 0 ? (
              `Claimed already: this address can take the next lot in ${Math.ceil(nextIn / 60)} min.`
            ) : (
              'Everything is ready to claim.'
            )}
            <button
              type="button"
              onClick={copyAddress}
              disabled={!address}
              className="ml-3 inline-flex items-center gap-1.5 rounded-full bg-[#254839]/[0.08] px-3 py-1 text-[12px] text-[#254839] hover:bg-[#254839]/[0.16] disabled:opacity-40"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied!' : 'Copy address'}
            </button>
          </p>
          {!busy && <Status text={status?.text} hash={status?.hash} />}
          <NidoGate session={session} />

          <Link href="/" className="group mt-6 flex items-center gap-4 rounded-2xl bg-[#254839] px-5 py-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={asset('/agama-logo-circle.svg')} alt="" className="h-10 w-10" />
            <div>
              <div className="text-[15px] font-medium text-[#fdf8ed]">Funded? Deposit your stock</div>
              <div className="text-[13px] text-[#fdf8ed]/70">Borrow against it and let the agents grow it</div>
            </div>
            <ArrowRight className="ml-auto h-5 w-5 text-[#fdf8ed]/80 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>
    </>
  );
}

function FaucetLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-11 items-center gap-1.5 whitespace-nowrap rounded-full bg-[#254839] px-6 text-[14px] font-medium text-[#fdf8ed] hover:bg-[#1F3D31]"
    >
      {label} <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function MintButton({
  onClick, busy, label, busyLabel, disabled,
}: { onClick: () => void; busy: boolean; label: string; busyLabel?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-11 w-[184px] items-center justify-center whitespace-nowrap rounded-full bg-[#254839] px-4 text-[14px] font-medium text-[#fdf8ed] hover:bg-[#1F3D31] disabled:opacity-45"
    >
      {busy ? <Step text={busyLabel} /> : label}
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[12px] uppercase tracking-wider text-fg-muted">{label}</div>
      <div className="text-[26px] font-semibold tabular-nums text-fg">{value}</div>
      {sub && <div className="text-[12px] text-fg-muted">{sub}</div>}
    </div>
  );
}

function StepRow({
  title, blurb, children, icon,
}: { title: string; blurb: string; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl bg-[#fdfaf1] px-5 py-4 shadow-[0_1px_3px_rgba(20,50,35,0.06),0_10px_30px_rgba(20,50,35,0.09)] md:flex-row md:items-center">
      {icon}
      <div className="min-w-0">
        <div className="text-[15px] font-medium text-fg">{title}</div>
        <div className="text-[13px] text-fg-muted">{blurb}</div>
      </div>
      <div className="shrink-0 md:ml-auto">{children}</div>
    </div>
  );
}
