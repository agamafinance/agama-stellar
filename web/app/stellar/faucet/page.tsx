'use client';

import { useState } from 'react';

import { TokenIcon } from '@/components/icons/TokenIcon';
import { USDC } from '@/lib/stellar/config';
import { useStellarWallet } from '@/lib/stellar/WalletProvider';
import { addr } from '@/lib/stellar/scval';
import { errorText, qty, send, usd, useSnapshot } from '@/lib/stellar/useStellar';
import { card, Panel, primaryBtn, secondaryBtn, Status, Step } from '@/components/stellar/ui';

export default function StellarFaucetPage() {
  const { address, connect, sign } = useStellarWallet();
  const { snap, refresh } = useSnapshot(address);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; hash?: string; which: string }>();

  const drip = async (which: string, token: string) => {
    if (!address) return connect();
    setBusy(which);
    setStatus({ text: 'Asking the faucet...', which });
    try {
      const hash = await send(address, token, 'faucet', [addr(address)], sign, (text) =>
        setStatus({ text, which }),
      );
      setStatus({ text: 'Done.', hash, which });
    } catch (e) {
      setStatus({ text: errorText(e), which });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <section className="px-6 md:px-24 pt-10 md:pt-14 pb-24">
      <div className="max-w-[1400px] mx-auto">
        <h1 className="mt-2 text-[34px] text-fg font-semibold">Faucet</h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-fg-muted">
          Testnet tokens, a fixed quantity once an hour per address. The rate limit is in the token contract, not in
          this page: a faucet anyone can drain is a testnet nobody else can use.
        </p>

        <Panel>
          <div className={card}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TokenIcon symbol="USDC" size={34} />
                <div>
                  <div className="text-[15px] font-medium text-fg">USDC</div>
                  <div className="text-[13px] text-fg-muted">
                    The dollar the protocol borrows and the vault takes
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[15px] tabular-nums text-fg">{usd(snap?.usdc)}</span>
                <button
                  onClick={() => drip('USDC', USDC)}
                  disabled={busy !== null}
                  className={`h-10 w-[160px] ${secondaryBtn} py-0`}
                >
                  {busy === 'USDC' ? <Step text={status?.text} /> : address ? 'Get USDC' : 'Connect Wallet'}
                </button>
              </div>
            </div>
            {status?.which === 'USDC' && busy === null && <Status text={status.text} hash={status.hash} />}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {snap?.markets.map((m) => (
              <div key={m.stock.symbol} className={`${card} py-5`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <TokenIcon symbol={m.stock.ticker} size={30} />
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium text-fg">{m.stock.ticker}</div>
                      <div className="truncate text-[13px] text-fg-muted">
                        {m.stock.name} · {m.stock.drip} a drip
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[14px] tabular-nums text-fg">{qty(m.balance, 2)}</div>
                  </div>
                </div>
                <button
                  onClick={() => drip(m.stock.symbol, m.stock.token)}
                  disabled={busy !== null}
                  className={`mt-4 ${primaryBtn} py-2.5 text-[14px]`}
                >
                  {busy === m.stock.symbol
                    ? <Step text={status?.text} />
                    : address
                      ? `Get ${m.stock.ticker}`
                      : 'Connect Wallet'}
                </button>
                {status?.which === m.stock.symbol && busy === null && (
                  <Status text={status.text} hash={status.hash} />
                )}
              </div>
            ))}
          </div>

          <p className="text-[12px] text-fg-muted">
            These tokens stand in for the real thing: on Stellar, tokenized shares are coming through DTCC and are
            not here yet. The prices are not stand-ins. Every one is a RedStone report signed by three independent
            signers and verified on chain by the oracle itself.
          </p>
        </Panel>
      </div>
    </section>
  );
}
