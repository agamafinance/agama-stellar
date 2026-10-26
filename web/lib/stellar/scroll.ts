'use client';

/// Where the page is, in an app that does not scroll the page.
///
/// This fork keeps the window fixed and scrolls the cream panel inside the
/// frame, which is what gives the border its rounded corners and its own
/// scrollbar. So `window.scrollY` is always zero here, and anything that
/// wants to put a visitor back where they were has to ask the panel.
///
/// It matters for exactly one thing: a Nido ceremony is a whole page
/// navigation, so the browser brings the owner back at the top while what
/// they were doing is halfway down and the result lands off screen.

const PANEL = '.frame-panel > div';

const scroller = (): Element | null =>
  typeof document === 'undefined' ? null : document.querySelector(PANEL);

/// How far down the app is right now.
export function scrollNow(): number {
  const el = scroller();
  return Math.round(el ? el.scrollTop : (globalThis.scrollY ?? 0));
}

/// Put it back, and keep asking until the page is tall enough to answer.
///
/// On the way back from a ceremony the snapshot has not arrived yet, so the
/// panel is too short to scroll and a single call lands at the top. This
/// retries until it takes or five seconds pass, and stops the moment a
/// visitor scrolls somewhere themselves.
export function restoreScroll(y?: number) {
  if (!y) return;
  const until = Date.now() + 5000;
  const tick = () => {
    const el = scroller();
    if (el) el.scrollTop = y;
    else globalThis.scrollTo(0, y);
    const at = el ? el.scrollTop : (globalThis.scrollY ?? 0);
    if (Math.abs(at - y) > 2 && Date.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
