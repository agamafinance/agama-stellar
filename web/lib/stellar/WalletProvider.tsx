'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { PASSPHRASE } from './config';

const KEY = 'agama-stellar:wallet';

type WalletOption = { id: string; name: string; icon?: string; isAvailable: boolean };

type Ctx = {
  address: string | null;
  /// True when the connected address is a smart account (a contract, so a
  /// Nido passkey account) rather than a keypair. Every screen that signs
  /// branches on this.
  smart: boolean;
  connecting: boolean;
  error?: string;
  detected: WalletOption[];
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  connect: () => void;
  connectTo: (w: WalletOption) => Promise<void>;
  disconnect: () => void;
  sign: (xdr: string) => Promise<string>;
};

const WalletContext = createContext<Ctx>({
  address: null,
  smart: false,
  connecting: false,
  detected: [],
  pickerOpen: false,
  setPickerOpen: () => {},
  connect: () => {},
  connectTo: async () => {},
  disconnect: () => {},
  sign: async () => {
    throw new Error('no wallet');
  },
});

/// The kit, loaded in the browser and nowhere else.
///
/// It reads `window` at import time, so pulling it in at module scope breaks
/// the server render. Importing it inside an effect is not a workaround for
/// that, it is the only shape that works.
///
/// Version 2 of the kit is a static class rather than an instance, so there is
/// nothing to hold here but the promise that it was configured once.
type Kit = typeof import('@creit.tech/stellar-wallets-kit').StellarWalletsKit;
let kitPromise: Promise<Kit> | null = null;

function loadKit(): Promise<Kit> {
  kitPromise ??= (async () => {
    const [{ StellarWalletsKit, Networks }, { defaultModules }, { NidoModule }] = await Promise.all([
      import('@creit.tech/stellar-wallets-kit'),
      import('@creit.tech/stellar-wallets-kit/modules/utils'),
      import('@nidohq/stellar-wallets-kit-module'),
    ]);
    // Nido is a hosted passkey wallet, so there is nothing to install and it
    // offers itself to everyone. Its module needs the deployment's domain
    // because it runs at our origin and cannot infer it; test.nido.fyi is the
    // only one there is, and it is testnet, which is where this app lives.
    StellarWalletsKit.init({
      modules: [...defaultModules(), new NidoModule({ base: 'test.nido.fyi', networkPassphrase: PASSPHRASE })],
      network: Networks.TESTNET,
    });
    return StellarWalletsKit;
  })();
  return kitPromise;
}

/// GhostSig reports itself available in every browser, because all it needs is
/// window.open, so it would be offered to people who have never heard of it.
const HIDDEN = new Set(['ghostsig']);

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [detected, setDetected] = useState<WalletOption[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const kit = await loadKit();
      const all = await kit.refreshSupportedWallets();
      if (!alive) return;
      setDetected(all.filter((w) => w.isAvailable && !HIDDEN.has(w.id.toLowerCase())));

      // Come back connected. A kit wallet still approves every signature, and
      // a Nido account signs with the session key it already granted, so
      // remembering the choice costs the user nothing and saves them a click
      // on every reload. The address is remembered with it rather than asked
      // for again: Nido's picker is a popup, and a popup on page load is
      // either blocked or unwelcome.
      const saved = localStorage.getItem(KEY);
      if (!saved) return;
      try {
        const { id, address } = JSON.parse(saved) as { id: string; address?: string };
        kit.setWallet(id);
        const a = address ?? (await kit.getAddress()).address;
        if (alive) setAddress(a);
      } catch {
        localStorage.removeItem(KEY);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const connectTo = useCallback(async (w: WalletOption) => {
    setConnecting(true);
    setError(undefined);
    try {
      const kit = await loadKit();
      kit.setWallet(w.id);
      const { address } = await kit.fetchAddress();
      localStorage.setItem(KEY, JSON.stringify({ id: w.id, address }));
      setAddress(address);
      setPickerOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setConnecting(false);
    }
  }, []);

  const connect = useCallback(() => {
    // One wallet installed is not a choice, so skip the menu. Nido is always
    // one of them, so in practice there is always a menu now, which is the
    // point: a passkey account is an option for somebody with no extension.
    if (detected.length === 1) void connectTo(detected[0]);
    else setPickerOpen(true);
  }, [detected, connectTo]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(KEY);
    setAddress(null);
    void loadKit()
      .then((kit) => kit.disconnect())
      .catch(() => {
        // A wallet that will not let go is still disconnected here.
      });
  }, []);

  /// Signing, for a wallet that holds a key.
  ///
  /// A smart account never comes through here: its calls are signed in the
  /// page by the session key it granted this app, because its passkey cannot
  /// authorise a call into another contract at all. See lib/nido/agama.ts.
  const sign = useCallback(
    async (xdr: string) => {
      const kit = await loadKit();
      const { signedTxXdr } = await kit.signTransaction(xdr, {
        networkPassphrase: PASSPHRASE,
        ...(address ? { address } : {}),
      });
      return signedTxXdr;
    },
    [address],
  );

  const value = useMemo(
    () => ({
      address,
      smart: !!address && address.startsWith('C'),
      connecting,
      error,
      detected,
      pickerOpen,
      setPickerOpen,
      connect,
      connectTo,
      disconnect,
      sign,
    }),
    [address, connecting, error, detected, pickerOpen, connect, connectTo, disconnect, sign],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useStellarWallet() {
  return useContext(WalletContext);
}
