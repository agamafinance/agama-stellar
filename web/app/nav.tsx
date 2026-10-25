'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Connect } from './connect'

const TABS = [
  { href: '/', label: 'Markets' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/activity', label: 'Activity' },
]

export function Nav() {
  const path = usePathname()
  return (
    <header className="border-b border-[var(--hair)] bg-[var(--paper)]/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1180px] items-center gap-8 px-6 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-full bg-[var(--agama)] text-[11px] font-semibold text-white">
            A
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Agama</span>
          <span className="text-[13px] text-[var(--ink-faint)]">Stellar</span>
        </Link>

        <nav className="flex items-center gap-1">
          {TABS.map((t) => {
            const on = path === t.href
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded-full px-3 py-1.5 text-[14px] transition-colors ${
                  on
                    ? 'bg-[var(--ink)] text-white'
                    : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'
                }`}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto">
          <Connect />
        </div>
      </div>
    </header>
  )
}
