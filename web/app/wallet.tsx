'use client'

import { useCallback, useEffect, useState } from 'react'

type Kit = import('@creit.tech/stellar-wallets-kit').StellarWalletsKit

let kit: Kit | null = null
const KEY = 'agama-stellar:address'

/// The wallet, loaded only in the browser.
///
/// The kit touches `window` on import, so it cannot be pulled in at module
/// scope without breaking the server render. Loading it inside the effect is
/// not a workaround, it is the only shape that works.
export function useWallet() {
  const [address, setAddress] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const mod = await import('@creit.tech/stellar-wallets-kit')
      if (!alive) return
      kit ??= new mod.StellarWalletsKit({
        network: mod.WalletNetwork.TESTNET,
        selectedWalletId: mod.FREIGHTER_ID,
        modules: mod.allowAllModules(),
      })
      setReady(true)
      const saved = localStorage.getItem(KEY)
      if (saved) setAddress(saved)
    })()
    return () => {
      alive = false
    }
  }, [])

  const connect = useCallback(async () => {
    const mod = await import('@creit.tech/stellar-wallets-kit')
    if (!kit) return
    await kit.openModal({
      onWalletSelected: async (option) => {
        kit!.setWallet(option.id)
        const { address } = await kit!.getAddress()
        localStorage.setItem(KEY, address)
        setAddress(address)
      },
    })
    void mod
  }, [])

  const disconnect = useCallback(() => {
    localStorage.removeItem(KEY)
    setAddress(null)
  }, [])

  const sign = useCallback(async (xdr: string) => {
    if (!kit) throw new Error('wallet not ready')
    const mod = await import('@creit.tech/stellar-wallets-kit')
    const { signedTxXdr } = await kit.signTransaction(xdr, {
      networkPassphrase: mod.WalletNetwork.TESTNET,
    })
    return signedTxXdr
  }, [])

  return { address, connect, disconnect, sign, ready }
}
