import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AppFrame } from '@/components/AppFrame';
import { Providers } from './providers';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

/// What a crawler, a link preview and an AI pre-judge read first.
///
/// metadataBase is the apex rather than this deployment's own origin, because
/// the pages are served through a rewrite there: a relative og:image resolved
/// against the wrong host is a preview nobody sees.
export const metadata: Metadata = {
  metadataBase: new URL('https://app.agama.finance'),
  title: {
    default: 'Agama on Stellar: deposit the stock, get more stock',
    template: 'Agama | %s',
  },
  description:
    'Deposit a tokenized stock and keep it. Agama borrows USDC against it on Blend, puts it to work in a private-credit vault, and permissionless agents turn the yield back into more of the same stock. A fall is repaid out of the protocol buffer, never by selling your stock. Stellar testnet.',
  applicationName: 'Agama',
  keywords: [
    'Stellar',
    'Soroban',
    'tokenized stocks',
    'RWA',
    'Blend',
    'RedStone',
    'private credit',
    'passkey smart accounts',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: 'https://app.agama.finance/stellar-rwa',
    siteName: 'Agama',
    title: 'Agama on Stellar: deposit the stock, get more stock',
    description:
      'Borrow against a tokenized share, put the dollars to work, and let permissionless agents turn the yield back into more of the share. A fall is repaid out of the protocol buffer rather than by selling your stock.',
    images: [{ url: '/agama-logo-circle.svg', alt: 'Agama' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agama on Stellar: deposit the stock, get more stock',
    description:
      'Tokenized shares that grow. Soroban contracts, a Blend credit market, RedStone prices verified on chain.',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-fg antialiased" suppressHydrationWarning>
        <Providers>
          <AppFrame>{children}</AppFrame>
        </Providers>
      </body>
    </html>
  );
}
