// A throwaway Chrome whose every tab and popup has a passkey, and a small
// driver for it. Testnet only.
//
// A Nido account is created and its rules are approved with a WebAuthn
// ceremony, so neither can be tested from a shell: there is no fingerprint in
// a terminal. Chrome has virtual authenticators over the DevTools protocol,
// and that is enough to drive the real pages against the real network.
//
// The passkey half is taken from nidohq/scaffold-template,
// scripts/webauthn-sidecar.mjs (Apache 2.0): attach to a Chrome started with a
// debugging port, give every page a virtual authenticator before it runs any
// script, and copy each new credential to the other pages, because Nido
// creates the passkey on one origin and asks for it on another. Credentials
// are saved so a restarted browser still signs for the same account. The
// driver below is this repository's.
//
// Never point this at a profile a person uses.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROMES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const AUTHENTICATOR = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

/**
 * Start Chrome, arm it, and return a driver.
 *
 * `dir` holds the profile and the saved passkeys. `headed: true` opens a
 * window, which is the only way to watch what a run is doing.
 */
export async function open({ dir, headed = false } = {}) {
  const root = dir ?? join(process.cwd(), 'target', 'nido-browser');
  const profile = join(root, 'profile');
  const store = join(root, 'passkeys.json');
  const chrome = CHROMES.find((p) => p && existsSync(p));
  if (!chrome) throw new Error('No Chrome found. Set CHROME_PATH.');

  mkdirSync(profile, { recursive: true });
  // Chrome hands a second launch on one profile to the first and exits, so a
  // leftover browser from an interrupted run looks exactly like a browser that
  // will not start. Say which it is.
  const held = holder(profile);
  if (held) throw new Error(`a Chrome (pid ${held}) still holds ${profile}; stop it first`);
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const proc = spawn(
    chrome,
    [
      ...(headed ? [] : ['--headless=new']),
      // Big enough that a screenshot shows a card rather than a slice of one.
      '--window-size=1400,1700',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const port = await debuggingPort(profile);
  const browserUrl = `http://127.0.0.1:${port}`;
  const { webSocketDebuggerUrl } = await (await fetch(`${browserUrl}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);

  const credentials = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
  const saveCredentials = () => {
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, JSON.stringify(credentials, null, 2));
  };

  let nextId = 0;
  const pending = new Map();
  /// Every call is given a deadline. A session that went away mid-question
  /// never answers, and a driver that waits for it forever looks exactly like
  /// a page that is taking its time.
  const send = (method, params = {}, sessionId, timeout = 20_000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not answer in ${timeout}ms`));
      }, timeout);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  /** sessionId -> { authenticatorId, url, opened } for every page attached. */
  const pages = new Map();

  async function arm(sessionId, info) {
    try {
      await send('WebAuthn.enable', { enableUI: false }, sessionId);
      const { authenticatorId } = await send(
        'WebAuthn.addVirtualAuthenticator',
        { options: AUTHENTICATOR },
        sessionId,
      );
      for (const credential of credentials)
        await send('WebAuthn.addCredential', { authenticatorId, credential }, sessionId);
      pages.set(sessionId, {
        authenticatorId,
        url: info.url,
        targetId: info.targetId,
        opened: Date.now(),
        log: [],
      });
      // What the page says and what the network answers it. A ceremony that
      // quietly does nothing is the normal failure here, and these two are
      // the only way to see why from outside.
      for (const domain of ['Page', 'Runtime', 'Log', 'Network'])
        await send(`${domain}.enable`, {}, sessionId).catch(() => {});
      log('armed', info.url || '(new page)', `${credentials.length} passkeys`);
    } catch (error) {
      log('could not arm', info.url, error.message);
    } finally {
      // The page is paused until this, which is the point: the authenticator
      // has to exist before anything on the page asks for a passkey.
      await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  }

  ws.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    const { method, params, sessionId } = message;
    if (method === 'Target.attachedToTarget') {
      if (params.targetInfo.type === 'page') await arm(params.sessionId, params.targetInfo);
      else await send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
    } else if (method === 'Target.detachedFromTarget') {
      pages.delete(params.sessionId);
    } else if (method === 'WebAuthn.credentialAdded') {
      credentials.push(params.credential);
      saveCredentials();
      log('passkey created for', params.credential.rpId);
      for (const [other, page] of pages)
        if (other !== sessionId)
          await send(
            'WebAuthn.addCredential',
            { authenticatorId: page.authenticatorId, credential: params.credential },
            other,
          ).catch((error) => log('could not share the passkey', error.message));
    } else if (method === 'WebAuthn.credentialAsserted') {
      log('passkey used for', params.credential.rpId);
    } else if (sessionId && pages.has(sessionId)) {
      const entry = note(method, params);
      if (entry) pages.get(sessionId).log.push(entry);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  log('chrome up on', browserUrl, headed ? '(headed)' : '(headless)');

  /// One line for a page event worth keeping, or nothing.
function note(method, params) {
  if (method === 'Runtime.consoleAPICalled')
    return `console.${params.type}: ${params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`;
  if (method === 'Runtime.exceptionThrown')
    return `threw: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`;
  if (method === 'Log.entryAdded') return `${params.entry.level}: ${params.entry.text}`;
  if (method === 'Network.responseReceived' && (process.env.NIDO_TRACE || params.response.status >= 400))
    return `http ${params.response.status} ${params.response.url.slice(0, 140)}`;
  if (method === 'Network.loadingFailed') return `failed: ${params.errorText}`;
  return undefined;
}

/// One page, by its session.
  const page = (sessionId) => ({
    sessionId,
    get url() {
      return pages.get(sessionId)?.url;
    },
    async goto(url) {
      await send('Page.navigate', { url }, sessionId);
      await this.settle();
      return this;
    },
    /// Run an expression in the page and give back its value.
    async eval(expression) {
      const { result, exceptionDetails } = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'page threw');
      return result.value;
    },
    /// Where the page is now, asked rather than remembered.
    async here() {
      return this.eval('location.href');
    },
    async title() {
      return this.eval('document.title');
    },
    /// What this page has said and what failed on it, in order.
    logs() {
      return pages.get(sessionId)?.log ?? [];
    },
    /// Everything a person could read, which is what selectors here match on.
    async text() {
      return this.eval('document.body?.innerText ?? ""');
    },
    /// Every button and link, for working out what a page offers.
    async controls() {
      return this.eval(`
        Array.from(document.querySelectorAll('button, a, input, [role=button]')).map((e) => ({
          tag: e.tagName.toLowerCase(),
          text: (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 80),
          id: e.id || undefined,
          disabled: e.disabled || undefined,
          href: e.getAttribute?.('href') || undefined,
        }))`);
    },
    /// Click the first control whose text contains `needle`.
    async click(needle) {
      const hit = await this.eval(`(() => {
        const want = ${JSON.stringify(needle.toLowerCase())};
        const all = Array.from(document.querySelectorAll('button, a, [role=button], input[type=submit]'));
        const match = all.find((e) => ((e.innerText || e.value || e.getAttribute('aria-label') || '').toLowerCase().includes(want)) && !e.disabled);
        if (!match) return null;
        match.scrollIntoView({ block: 'center' });
        match.click();
        return (match.innerText || match.value || '').trim().slice(0, 60);
      })()`);
      if (hit === null) throw new Error(`nothing to click for "${needle}"`);
      log('clicked', JSON.stringify(hit), 'on', await this.here());
      return hit;
    },
    /// Click one element by id, for a page that has two buttons reading
    /// "Continue" and means different things by them.
    async clickId(id) {
      const hit = await this.eval(`(() => {
        const e = document.getElementById(${JSON.stringify(id)});
        if (!e || e.disabled) return null;
        e.scrollIntoView({ block: 'center' });
        e.click();
        return (e.innerText || e.value || '#' + e.id).trim().slice(0, 60);
      })()`);
      if (hit === null) throw new Error(`#${id} is not there, or is disabled`);
      log('clicked', `#${id}`, JSON.stringify(hit));
      return hit;
    },
    /// Wait until an expression is truthy, and give back what it was.
    async waitFor(expression, { timeout = 60_000, every = 500 } = {}) {
      const until = Date.now() + timeout;
      let last;
      while (Date.now() < until) {
        last = await this.eval(expression).catch(() => undefined);
        if (last) return last;
        await sleep(every);
      }
      throw new Error(`waited ${timeout}ms for ${expression}, last ${JSON.stringify(last)}`);
    },
    async fill(selector, value) {
      return this.eval(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null;
        const set = Object.getOwnPropertyDescriptor(e.constructor.prototype, 'value').set;
        set.call(e, ${JSON.stringify(value)});
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return e.value;
      })()`);
    },
    /// Wait until the page's text contains one of `needles`, and say which.
    async waitForText(needles, { timeout = 60_000, every = 500 } = {}) {
      const want = [needles].flat();
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const text = (await this.text().catch(() => '')) ?? '';
        const hit = want.find((n) => text.toLowerCase().includes(n.toLowerCase()));
        if (hit) return hit;
        await sleep(every);
      }
      throw new Error(`waited ${timeout}ms for ${want.join(' / ')}, saw: ${(await this.text()).slice(0, 400)}`);
    },
    /// Wait for the network and the renderer to go quiet enough to read.
    async settle(ms = 1500) {
      await sleep(ms);
      for (let i = 0; i < 40; i++) {
        const state = await this.eval('document.readyState').catch(() => 'loading');
        if (state === 'complete') return this;
        await sleep(250);
      }
      return this;
    },
    async shot(file) {
      const { data } = await send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true },
        sessionId,
      );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
      log('shot', file);
      return file;
    },
    async close() {
      const { targetId } = pages.get(sessionId) ?? {};
      await send('Target.closeTarget', { targetId }).catch(() => {});
    },
  });

  return {
    send,
    pages,
    /// A new tab, armed before it runs anything.
    async tab(url = 'about:blank') {
      // Matched on the target id rather than on "a session that was not there
      // a moment ago": the browser's own first tab attaches at about the same
      // time, and picking that one instead leaves the driver reading
      // about:blank while the page it asked for loads somewhere else.
      const { targetId } = await send('Target.createTarget', { url });
      const sessionId = await waitFor(() =>
        [...pages.entries()].find(([, p]) => p.targetId === targetId)?.[0],
      );
      const p = page(sessionId);
      if (url !== 'about:blank') await p.settle();
      return p;
    },
    /// The page this app's popup opened, found by where it went.
    async popup(hostPart, { timeout = 30_000 } = {}) {
      const sessionId = await waitFor(
        async () => {
          for (const [id] of pages) {
            // Two seconds, not twenty: a page that closed while this was
            // asking is the common case here, not an error worth waiting on.
            const where = await send(
              'Runtime.evaluate',
              { expression: 'location.href', returnByValue: true },
              id,
              2000,
            )
              .then((r) => String(r.result?.value ?? ''))
              .catch(() => '');
            if (where.includes(hostPart)) return id;
          }
          return undefined;
        },
        { timeout },
      );
      return page(sessionId);
    },
    page,
    async close() {
      ws.close();
      proc.kill();
    },
  };
}

async function waitFor(get, { timeout = 30_000, every = 200 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const got = await get();
    if (got) return got;
    await sleep(every);
  }
  throw new Error('timed out waiting for a page');
}

/** The pid of a live Chrome holding this profile, if there is one. */
function holder(profile) {
  try {
    const pid = Number(readlinkSync(join(profile, 'SingletonLock')).split('-').at(-1));
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function debuggingPort(profile) {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300; i++) {
    if (existsSync(file)) {
      const [line] = readFileSync(file, 'utf8').split('\n');
      if (line) return Number(line);
    }
    await sleep(100);
  }
  throw new Error('Chrome did not open a debugging port within 30s');
}
