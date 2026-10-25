'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const KEY = 'agama-stellar:wallet';

type KitModule = typeof import('@creit.tech/stellar-wallets-kit');
type Kit = import('@creit.tech/stellar-wallets-kit').StellarWalletsKit;
type WalletOption = { id: string; name: string; icon?: string; isAvailable: boolean };

type Ctx = {
  address: string | null;
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
let kit: Kit | null = null;
let mod: KitModule | null = null;

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [detected, setDetected] = useState<WalletOption[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      mod = await import('@creit.tech/stellar-wallets-kit');
      if (!alive) return;
      kit ??= new mod.StellarWalletsKit({
        network: mod.WalletNetwork.TESTNET,
        selectedWalletId: mod.FREIGHTER_ID,
        modules: mod.allowAllModules(),
      });
      const all = await kit.getSupportedWallets();
      if (!alive) return;
      setDetected(all.filter((w) => w.isAvailable));

      // Reconnect silently. The wallet still has to approve each signature,
      // so remembering which one was chosen costs the user nothing and saves
      // them a click on every reload.
      const saved = localStorage.getItem(KEY);
      if (saved) {
        try {
          kit.setWallet(saved);
          const { address } = await kit.getAddress();
          if (alive) setAddress(address);
        } catch {
          localStorage.removeItem(KEY);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const connectTo = useCallback(async (w: WalletOption) => {
    if (!kit) return;
    setConnecting(true);
    setError(undefined);
    try {
      kit.setWallet(w.id);
      const { address } = await kit.getAddress();
      localStorage.setItem(KEY, w.id);
      setAddress(address);
      setPickerOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setConnecting(false);
    }
  }, []);

  const connect = useCallback(() => {
    // One wallet installed is not a choice, so skip the menu.
    if (detected.length === 1) void connectTo(detected[0]);
    else setPickerOpen(true);
  }, [detected, connectTo]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(KEY);
    setAddress(null);
  }, []);

  const sign = useCallback(async (xdr: string) => {
    if (!kit || !mod) throw new Error('Wallet not ready.');
    const { signedTxXdr } = await kit.signTransaction(xdr, {
      networkPassphrase: mod.WalletNetwork.TESTNET,
    });
    return signedTxXdr;
  }, []);

  const value = useMemo(
    () => ({
      address,
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
