'use client';

import { createContext, useContext, ReactNode } from 'react';

/// The app this is forked from switches between platforms, and the navbar
/// reads the current one from here. This deployment carries Stellar alone, so
/// the context is a constant rather than a choice: the shape is kept so the
/// shared components below it are the fork's, untouched.
export type Platform = 'stellar';

type Ctx = {
  platform: Platform;
  setPlatform: (p: Platform) => void;
};

const NetworkContext = createContext<Ctx>({ platform: 'stellar', setPlatform: () => {} });

export function NetworkProvider({ children }: { children: ReactNode }) {
  return (
    <NetworkContext.Provider value={{ platform: 'stellar', setPlatform: () => {} }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() {
  return useContext(NetworkContext);
}
