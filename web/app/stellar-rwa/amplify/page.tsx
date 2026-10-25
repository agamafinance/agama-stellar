'use client';

import { useEffect, useState } from 'react';

import { AGENT_OPS, asset, BPS, DECIMALS } from '@/lib/stellar/config';
import { useStellarWallet } from '@/lib/stellar/WalletProvider';
import {
  ago, errorText, ix, pct, px, qty, send, stockValue, usd, useSnapshot, type Call,
} from '@/lib/stellar/useStellar';
import {
  AgentsCard, AmountBox, card, Hero, MarketCards, Panel, parseAmount, PriceBadge, primaryBtn,
  Row, secondaryBtn, SessionBadge, Stat, Status, Step, toDecimal,
} from '@/components/stellar/ui';
import { NidoGate, useNidoSession } from '@/components/stellar/NidoGate';

export default function StellarAmplifyPage() {
  const { address, connect, sign } = useStellarWallet();
  const { snap, error, refresh } = useSnapshot(address);
  const [sel, setSel] = useState(1);

  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || !snap) return;
    const want = new URLSearchParams(window.location.search).get('s');
    const byParam = want ? snap.markets.findIndex((mk) => mk.stock.symbol === want) : -1;
    const held = snap.amplify.findIndex((x) => !!x);
    if (byParam >= 0) setSel(byParam);
    else if (held >= 0) setSel(held);
    setOpened(true);
  }, [snap, opened]);

  const m = snap?.markets[sel];
  const position = snap?.amplify[sel];
  const session = useNidoSession(m?.stock);

  const [amount, setAmount] = useState('');
  const [picked, setPicked] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; hash?: string; where: 'open' | 'close' }>();
  useEffect(() => setPicked(undefined), [sel]);

  // A multiple of L carries an LTV of (L - 1) / L, so the market's LTV caps L
  // at 1 / (1 - ltv). The slider stops a hair short of that edge rather than
  // ending in a refusal.
  const ltv = m ? m.ltv / 10_000 : 0;
  const maxLev = m && ltv > 0 ? Math.floor((1 / (1 - ltv)) * 100) / 100 - 0.01 : 1;
  const canLoop = maxLev > 1.05;
  const lev = Math.min(picked ?? Math.max(1.1, Math.floor(maxLev * 90) / 100), maxLev);
  const levBps = Math.round(lev * 10_000);

  const amt = parseAmount(amount, DECIMALS);
  const held = m ? BigInt(m.balance) : 0n;
  const enough = amt <= held;
  // What the loop ends up holding, and what it owes for it.
  const exposureShares = (amt * BigInt(levBps)) / BPS;
  const bought = exposureShares - amt;
  const borrow = m ? stockValue(bought, BigInt(m.price)) : 0n;
  const ltvAfter = levBps > 10_000 ? Math.floor(((levBps - 10_000) * 10_000) / levBps) : 0;

  async function run(where: 'open' | 'close', call: Call, msg: string) {
    if (!address) return setStatus({ text: 'Connect a wallet first.', where });
    if (!m) return setStatus({ text: 'Markets are still loading.', where });
    setBusy(true);
    setStatus({ text: msg, where });
    try {
      const hash = await send(address, call, sign, (text) => setStatus({ text, where }));
      setStatus({ text: 'Done.', hash, where });
      if (where === 'open') setAmount('');
    } catch (e) {
      if (e instanceof Error && e.name === 'NeedsSession') {
        session.refresh();
        setStatus({ text: 'This needs your approval once. It is just below.', where });
      } else setStatus({ text: errorText(e), where });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  const health =
    position && BigInt(position.debt) > 0n
      ? (Number(BigInt(position.value) * BigInt(position.threshold)) / Number(BigInt(position.debt) * BPS)).toFixed(2)
      : undefined;
  const exposure =
    position && BigInt(position.value) > BigInt(position.debt)
      ? (Number(BigInt(position.value)) / Number(BigInt(position.value) - BigInt(position.debt))).toFixed(2)
      : undefined;

  return (
    <>
      <Hero art={asset('/logos/coin-pair-amplify.svg')} title={<>Amplify your stock</>}>
        <p className="mt-4 max-w-[640px] text-[15px] text-fg-muted">
          One slider. Agama borrows USDC against your stock on Blend, buys more of the same stock with it and
          pledges that too, until the position holds the multiple you asked for, in one transaction. The agents hold
          it as the price moves: they buy a little more when it rises and sell just enough to repay when it falls.
        </p>
        <div className="mt-7 flex flex-wrap gap-8">
          <Stat label="Borrow APR" value={pct(snap?.borrowRateBps)} sub="USDC on Blend, variable" />
          <Stat
            label="Max multiple"
            value={m ? `${maxLev.toFixed(2)}x` : '-'}
            sub={`${m?.stock.ticker ?? ''} at ${pct(m?.ltv)} LTV`}
          />
        </div>
      </Hero>

      <Panel>
        {error && !snap && <p className="text-[13px] text-[#b4571f]">{error}</p>}
        {error && snap && (
          <p className="text-[12px] text-[#b4571f]">
            Showing data from {ago(snap.at)}: the RPC is not answering, retrying.
          </p>
        )}
        {snap && <MarketCards markets={snap.markets} sel={sel} onSelect={setSel} connected={!!address} />}
        {snap && <PriceBadge markets={snap.markets} />}

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr] items-start">
          <div className={card}>
            <div className="flex items-center justify-between">
              <h2 className="text-[17px] font-semibold text-fg">Loop {m?.stock.ticker ?? ''}</h2>
              <SessionBadge m={m} />
            </div>
            {session.smart && !session.ready && (
              <div className="mt-4">
                <NidoGate session={session} stock={m?.stock} />
              </div>
            )}
            {position ? (
              <p className="mt-4 text-[14px] text-fg-muted">
                You already have a loop on {m?.stock.ticker}. Close it to open a new one at a different multiple.
              </p>
            ) : (
              <>
                <AmountBox
                  label="Deposit"
                  balanceLabel={qty(held)}
                  onMax={() => m && setAmount(toDecimal(held, DECIMALS))}
                  value={amount}
                  onChange={setAmount}
                  unit={m?.stock.ticker ?? ''}
                  hint={`${px(m?.price)} per share`}
                />
                <div className="mt-5">
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-fg-muted">Multiple</span>
                    <span className="font-medium text-fg tabular-nums" data-testid="leverage">
                      {lev.toFixed(2)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1.05}
                    max={maxLev}
                    step={0.01}
                    value={lev}
                    onChange={(e) => setPicked(Number(e.target.value))}
                    className="mt-2 w-full accent-[#254839]"
                    aria-label="Leverage"
                  />
                  <div className="flex justify-between text-[11px] text-fg-muted">
                    <span>1.05x</span>
                    <span>{maxLev.toFixed(2)}x max</span>
                  </div>
                </div>
                <dl className="mt-4 space-y-2 text-[13px]">
                  <Row label="Borrowed on Blend" value={borrow > 0n ? usd(borrow) : '-'} />
                  <Row
                    label="Stock bought with it"
                    value={bought > 0n ? `${qty(bought)} ${m?.stock.ticker}` : '-'}
                  />
                  <Row
                    label="You end up holding"
                    value={amt > 0n ? `${qty(exposureShares)} ${m?.stock.ticker}` : '-'}
                  />
                  <Row
                    label="LTV after"
                    value={amt > 0n ? `${pct(ltvAfter)} of ${pct(m?.ltv)} max` : '-'}
                  />
                </dl>
                <button
                  onClick={
                    address
                      ? () =>
                          run('open', ix.amplifyOpen(address, m!.stock, amt, levBps), 'Looping...')
                      : () => connect()
                  }
                  disabled={busy || (!!address && (!m || amt === 0n || !enough || !canLoop))}
                  className={`mt-4 ${primaryBtn}`}
                >
                  {!address
                    ? 'Connect Wallet'
                    : busy && status?.where === 'open'
                      ? <Step text={status.text} />
                      : !m
                        ? 'Loading markets...'
                        : !canLoop
                          ? 'No loop possible on this market right now'
                          : !enough
                            ? `Not enough ${m.stock.ticker}, see the Faucet`
                            : amt === 0n
                              ? 'Enter an amount'
                              : `Amplify ${lev.toFixed(2)}x`}
                </button>
                <p className="mt-2 text-[12px] text-fg-muted">
                  The stock is pledged before the loan it secures exists, and the whole thing either reaches that
                  state or reverts to none of it. Nothing is borrowed uncollateralised at any point.
                </p>
              </>
            )}
            {!busy && status?.where === 'open' && <Status text={status.text} hash={status.hash} />}
            {session.smart && session.ready && (
              <div className="mt-2">
                <NidoGate session={session} stock={m?.stock} />
              </div>
            )}
          </div>

          <div className={card}>
            <h2 className="text-[17px] font-semibold text-fg">Your loop</h2>
            {!position ? (
              <p className="mt-4 text-[14px] text-fg-muted">No loop on {m?.stock.ticker ?? 'this stock'}.</p>
            ) : (
              <>
                <div className="mt-4 flex flex-wrap gap-8">
                  <Stat label={`Your ${m?.stock.ticker}`} value={qty(position.collateral)} sub={usd(position.value)} />
                  <Stat
                    label="Multiple"
                    value={exposure ? `${exposure}x` : '-'}
                    sub={`Target ${(10_000 / (10_000 - position.targetLtvBps)).toFixed(2)}x`}
                  />
                  <Stat label="Health factor" value={health ?? 'No debt'} sub="Liquidation below 1.00" />
                </div>
                <dl className="mt-5 space-y-2 text-[13px]">
                  <Row label="Value" value={usd(position.value)} />
                  <Row label="Debt" value={usd(position.debt)} />
                  <Row
                    label="Level now / target"
                    value={`${pct(position.ltvBps)} / ${pct(position.targetLtvBps)}`}
                  />
                </dl>
                <AgentsCard
                  last={
                    position.lastAgentOp
                      ? `Last action: ${AGENT_OPS[position.lastAgentOp] ?? position.lastAgentOp}, ${ago(position.lastAgentAt)}.`
                      : 'No agent action yet. The loop is on target.'
                  }
                >
                  The price rises, the agents borrow and buy more stock; it falls, they sell just enough to repay,
                  and the sale is sized to the debt rather than to the position, so what goes back is the stock the
                  loan bought and never your deposit. A keeper makes the calls, and anyone else can too.
                </AgentsCard>
                <button
                  onClick={() => run('close', ix.amplifyClose(address!, m!.stock), 'Unwinding...')}
                  disabled={busy}
                  className={`mt-4 ${secondaryBtn}`}
                >
                  {busy && status?.where === 'close' ? <Step text={status.text} /> : 'Close, sell what repays, keep the rest'}
                </button>
              </>
            )}
            {!busy && status?.where === 'close' && <Status text={status.text} hash={status.hash} />}
          </div>
        </div>

        <p className="text-[12px] text-fg-muted">
          Testnet. Lending is Blend, in an instance of it deployed here, and the swap is a stand-in that settles at
          the oracle price.
        </p>
      </Panel>
    </>
  );
}
