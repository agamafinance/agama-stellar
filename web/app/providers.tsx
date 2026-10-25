'use client';

import { ReactNode } from 'react';

import { NetworkProvider } from '@/lib/network/NetworkContext';
import { StellarWalletProvider } from '@/lib/stellar/WalletProvider';

/// One network, one provider.
///
/// The Solana fork wraps a PrivateProvider here, for Token-2022 confidential
/// transfers. Stellar has no equivalent in this deployment, so there is no
/// shim pretending otherwise: balances here are public, and the screens say
/// so where it matters rather than showing a privacy control that does
/// nothing.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <NetworkProvider>
      <StellarWalletProvider>{children}</StellarWalletProvider>
    </NetworkProvider>
  );
}
