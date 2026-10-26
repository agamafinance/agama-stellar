// Nido's grant ceremony, walked by a machine.
//
// One rule at a time, in two screens: the rule itself at
// /security/delegate-doc/, then "Confirm it's you" at /sign/, which is where
// the passkey is used and where Nido's relayer applies the document. On the
// way back the app records the answer and sends the owner straight on to the
// next rule it needs.
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Walk every grant the app is asking for, and come back with their labels.
 *
 * A state machine rather than a sequence: look at the page, do the one thing
 * that page needs, and stop when the app says the session is live.
 */
export async function walkGrants(p, { timeout = 420_000, start = 120_000 } = {}) {
  const seen = new Set();
  // Wait for the ceremony to begin before reading the page: the first action
  // of a session also makes this app's key and waits on Friendbot to fund it,
  // so several seconds pass on the app's own page before anything navigates.
  // Treating that as "already back" ends the walk before it starts.
  await p.waitFor(`location.host.includes('nido.fyi') ? 'nido' : null`, { timeout: start });
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const where = await p.here().catch(() => '');
    if (/delegate-doc/.test(where)) {
      await p.settle(2000);
      const label = await p.eval(`document.body.innerText.match(/agama-[A-Za-z0-9-]+/)?.[0]`);
      // A rule the app asked for without a cap has to be accepted as
      // uncapped, and Nido will not continue until the owner has said so.
      // That is on purpose: Perch meters a cap by what a transfer moves, so
      // an uncapped rule is the only shape that can carry a call which is not
      // one, and a capped rule on anything but a transfer is refused on use
      // with #3223. A rule that came with a cap already has its amount.
      const capped = await p.eval(
        `document.body.innerText.includes('did not ask for a cap') ? 'asked-none' : 'has-cap'`,
      );
      if (capped === 'asked-none')
        await p.eval(`(() => {
          const box = Array.from(document.querySelectorAll('input[type=checkbox]'))
            .find((e) => (e.closest('label')?.innerText ?? '').includes('without any cap'));
          if (box && !box.checked) box.click();
          return true;
        })()`);
      if (!seen.has(label)) {
        console.log(`  rule ${label}: ${capped === 'asked-none' ? 'no cap, accepted as uncapped' : 'under the cap the app asked for'}`);
        seen.add(label);
      }
      await p.clickId('approve');
      await sleep(2500);
    } else if (/\/sign\//.test(where)) {
      // The passkey screen. The virtual authenticator answers for it.
      await p.settle(1500);
      await p.clickId('approve').catch(() => {});
      await sleep(4000);
    } else {
      // Back on the app. Either it is on its way to another rule, or the
      // ceremony is over and the page is running what the owner signed for.
      await sleep(3000);
      const now = await p.here().catch(() => '');
      if (!/nido\.fyi/.test(now)) return seen;
    }
  }
  throw new Error('the grant ceremonies did not finish in time');
}
