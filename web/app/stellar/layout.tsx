import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Stellar',
  description: 'Deposit a tokenized stock, get more of it back. Agama on Stellar testnet.',
};

export default function StellarLayout({ children }: { children: React.ReactNode }) {
  return children;
}
