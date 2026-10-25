'use client';

import { useEffect, useState } from 'react';

import { AGENT_OPS, asset, BPS, DECIMALS } from '@/lib/stellar/config';
import { useStellarWallet } from '@/lib/stellar/WalletProvider';
import {
  ago, errorText, ix, pct, px, qty, send, stockValue, usd, useSnapshot,
} from '@/lib/stellar/useStellar';
import {
  AgentsCard, AmountBox, card, Hero, MarketCards, Panel, parseAmount, PriceBadge, primaryBtn,
  Row, secondaryBtn, SessionBadge, Stat, Status, Step, toDecimal,
} from '@/components/stellar/ui';

export default function StellarEarnPage() {
  const { address, connect, sign } = useStellarWallet();
  const { snap, error, refresh } = useSnapshot(address);
  const [sel, setSel] = useState(0);

  // Open on the stock asked for (?s=NVDAx, from Portfolio), else on the first
  // market this wallet already has a position in.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || !snap) return;
    const want = new URLSearchParams(window.location.search).get('s');
    const byParam = want ? snap.markets.findIndex((mk) => mk.stock.symbol === want) : -1;
    const held = snap.earn.findIndex((x) => !!x);
    if (byParam >= 0) setSel(byParam);
    else if (held >= 0) setSel(held);
    setOpened(true);
  }, [snap, opened]);

  const m = snap?.markets[sel];
  const position = snap?.earn[sel];

  const [amount, setAmount] = useState('');
  // The slider is in bps of LTV. Undefined until the market says what it
  // allows, then a level that leaves the position well clear of liquidation.
  const [picked, setPicked] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; hash?: string; where: 'deposit' | 'close' | 'slider' }>();
  useEffect(() => setPicked(undefined), [sel]);

  const maxLtv = m ? m.ltv : 0;
  const defaultLtv = Math.floor((maxLtv * 0.8) / 50) * 50;
  const ltv = Math.min(picked ?? (position ? position.targetLtvBps : defaultLtv), maxLtv);

  const amt = parseAmount(amount, DECIMALS);
  const held = m ? BigInt(m.balance) : 0n;
  const enough = amt <= held;
  const borrowed = m ? (stockValue(amt, BigInt(m.price)) * BigInt(ltv)) / BPS : 0n;
  const healthAtOpen = m && ltv > 0 ? (m.threshold / ltv).toFixed(2) : '-';

  async function run(
    where: 'deposit' | 'close' | 'slider',
    call: { id: string; fn: string; args: Parameters<typeof send>[3] },
    msg: string,
  ) {
    if (!address) return setStatus({ text: 'Connect a wallet first.', where });
    if (!m) return setStatus({ text: 'Markets are still loading.', where });
    setBusy(true);
    setStatus({ text: msg, where });
    try {
      const hash = await send(address, call.id, call.fn, call.args, sign, (text) =>
        setStatus({ text, where }),
      );
      setStatus({ text: 'Done.', hash, where });
      if (where === 'deposit') setAmount('');
    } catch (e) {
      setStatus({ text: errorText(e), where });
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  const deposit = () =>
    run('deposit', ix.earnDeposit(address!, m!.stock, amt, ltv), 'Depositing and borrowing...');
  const close = () => run('close', ix.earnClose(address!, m!.stock), 'Closing...');
  const moveSlider = () =>
    run('slider', ix.earnSetTarget(address!, m!.stock, ltv), 'Moving the position...');

  const has = !!position;
  const health =
    position && BigInt(position.debt) > 0n
      ? (Number(BigInt(position.value) * BigInt(position.threshold)) / Number(BigInt(position.debt) * BPS)).toFixed(2)
      : undefined;
  const sliderMoved = has && ltv !== position!.targetLtvBps;
  const vaultGrowth = snap ? Number(BigInt(snap.vaultRate)) / 1e12 : 1;

  return (
    <>
      <Hero
        art={asset('/logos/coin-pair-earn.svg')}
        title={
          <>
            Deposit your stock,
            <br />
            get more stock
          </>
        }
      >
        <p className="mt-4 max-w-[640px] text-[15px] text-fg-muted">
          Deposit a tokenized stock. Agama borrows USDC against it at the level you pick, puts it to work in the
          private-credit vault, and permissionless agents hold that level and turn the yield back into more of your
          stock. Live on Stellar testnet, with stand-in tokens priced off real RedStone reports.
        </p>
        <div className="mt-7 flex flex-wrap gap-8">
          <Stat
            label="Vault"
            value={`${((vaultGrowth - 1) * 100).toFixed(2)}%`}
            sub="What a share has earned since it opened"
          />
          <Stat label="Borrow APR" value={pct(snap?.borrowRateBps)} sub="USDC on Blend, variable" />
          <Stat label="Pool used" value={pct(snap?.utilizationBps)} sub="Of the USDC supplied" />
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
              <h2 className="text-[17px] font-semibold text-fg">Deposit {m?.stock.ticker ?? ''}</h2>
              <SessionBadge m={m} />
            </div>

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
                <span className="text-fg-muted">Level the agents hold</span>
                <span className="font-medium text-fg tabular-nums" data-testid="ltv">
                  {pct(ltv)} of the stock
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={maxLtv}
                step={50}
                value={ltv}
                onChange={(e) => setPicked(Number(e.target.value))}
                className="mt-2 w-full accent-[#254839]"
                aria-label="Target LTV"
              />
              <div className="flex justify-between text-[11px] text-fg-muted">
                <span>0%</span>
                <span>
                  {pct(maxLtv)} max
                  {m?.offHours ? `, ${pct(m.stock.offHoursBufferBps)} off while NYSE is closed` : ''}
                </span>
              </div>
            </div>

            <dl className="mt-4 space-y-2 text-[13px]">
              <Row label="Borrowed into the vault" value={borrowed > 0n ? usd(borrowed) : '-'} />
              <Row label="Health factor at open" value={healthAtOpen} />
              <Row label="Liquidates at" value={m ? pct(m.threshold) : '-'} />
            </dl>
            {m && !m.fresh && (
              <p className="mt-3 text-[12px] text-[#b4571f]">
                No fresh price for {m.stock.ticker}: borrowing waits for the next one.
              </p>
            )}

            <button
              onClick={address ? deposit : () => connect()}
              disabled={busy || (!!address && (!m || amt === 0n || !enough || ltv === 0))}
              className={`mt-4 ${primaryBtn}`}
            >
              {!address
                ? 'Connect Wallet'
                : busy && status?.where === 'deposit'
                  ? <Step text={status.text} />
                  : !m
                    ? 'Loading markets...'
                    : !enough
                      ? `Not enough ${m.stock.ticker}, see the Faucet`
                      : amt === 0n
                        ? 'Enter an amount'
                        : has
                          ? 'Add to the position'
                          : 'Deposit and start earning'}
            </button>
            {!busy && status?.where === 'deposit' && <Status text={status.text} hash={status.hash} />}
          </div>

          <div className={card}>
            <h2 className="text-[17px] font-semibold text-fg">Your position</h2>
            {!has ? (
              <p className="mt-4 text-[14px] text-fg-muted">
                Nothing here yet. Deposit a stock and the protocol does the rest: it borrows against it, puts the
                USDC to work, and keeps the position where you set it.
              </p>
            ) : (
              <>
                <div className="mt-4 flex flex-wrap gap-8">
                  <Stat
                    label={`Your ${m?.stock.ticker}`}
                    value={qty(position!.collateral)}
                    sub={usd(position!.value)}
                  />
                  <Stat label="Health factor" value={health ?? 'No debt'} sub="Liquidation below 1.00" />
                </div>
                <dl className="mt-5 space-y-2 text-[13px]">
                  <Row label="Debt" value={usd(position!.debt)} />
                  <Row label="Earning in the vault" value={usd(position!.inVault)} />
                  {BigInt(position!.loose) > 0n && (
                    <Row label="Yield waiting to compound" value={usd(position!.loose)} />
                  )}
                  <Row label="Level now" value={pct(position!.ltvBps)} />
                  <Row label="Target level" value={pct(position!.targetLtvBps)} />
                </dl>
                {sliderMoved && (
                  <button onClick={moveSlider} disabled={busy} className={`mt-4 ${secondaryBtn}`}>
                    {busy && status?.where === 'slider' ? <Step text={status.text} /> : `Move the target to ${pct(ltv)}`}
                  </button>
                )}
                {!busy && status?.where === 'slider' && <Status text={status.text} hash={status.hash} />}
                <AgentsCard
                  last={
                    position!.lastAgentOp
                      ? `Last action: ${AGENT_OPS[position!.lastAgentOp] ?? position!.lastAgentOp}, ${ago(position!.lastAgentAt)}.`
                      : 'No agent action yet. The position is on target.'
                  }
                >
                  The stock moves, the debt follows it back to {pct(position!.targetLtvBps)}. A fall is repaid out of
                  the protocol&apos;s own buffer rather than by selling your stock. The vault yield above that debt is
                  bought back as more stock. A keeper makes the calls, and the calls are open to anyone: nothing here
                  is yours to do, and nothing here is ours to control.
                </AgentsCard>
                <button onClick={close} disabled={busy} className={`mt-4 ${secondaryBtn}`}>
                  {busy && status?.where === 'close' ? <Step text={status.text} /> : 'Close, get the stock back'}
                </button>
              </>
            )}
            {/* Outside the branch on purpose: closing empties this card, and a
                confirmation that unmounts with it confirms nothing. */}
            {!busy && status?.where === 'close' && <Status text={status.text} hash={status.hash} />}
          </div>
        </div>

        <p className="text-[12px] text-fg-muted">
          Testnet: the shares, gold and USDC are stand-ins, handed out by the Faucet tab. Prices are real RedStone
          reports, signed by three independent signers and verified on chain by the oracle itself. Lending is Blend,
          in an instance of it deployed here.
        </p>
      </Panel>
    </>
  );
}
