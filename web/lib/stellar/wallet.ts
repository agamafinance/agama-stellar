/// The wallets this app offers, in the order it offers them.
///
/// Freighter first because it is what most Stellar testnet users already
/// have. The kit finds whatever else is installed; this list is only for the
/// case where nothing is, when a download link is more use than an empty menu.
export type KnownWallet = {
  key: string;
  label: string;
  icon?: string;
  install: string;
};

export const KNOWN_WALLETS: KnownWallet[] = [
  {
    key: 'freighter',
    label: 'Freighter',
    icon: '/wallets/freighter.svg',
    install: 'https://www.freighter.app/',
  },
  {
    key: 'lobstr',
    label: 'LOBSTR',
    icon: '/wallets/lobstr.svg',
    install: 'https://lobstr.co/',
  },
  {
    key: 'xbull',
    label: 'xBull',
    icon: '/wallets/xbull.svg',
    install: 'https://xbull.app/',
  },
];
