'use client'

import { useEffect, useState } from 'react'
import { short } from '@/lib/format'
import { useWallet } from './wallet'

export function Connect() {
  const { address, connect, disconnect, ready } = useWallet()
  const [hover, setHover] = useState(false)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (!mounted) return <div className="h-9 w-[132px]" />

  if (address) {
    return (
      <button
        onClick={disconnect}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="h-9 rounded-full border border-[var(--line)] px-4 text-[13px] font-medium"
      >
        {hover ? 'Disconnect' : short(address)}
      </button>
    )
  }

  return (
    <button
      onClick={connect}
      disabled={!ready}
      className="h-9 rounded-full bg-[var(--ink)] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#33332f] disabled:opacity-40"
    >
      Connect wallet
    </button>
  )
}
