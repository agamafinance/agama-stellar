'use client'

import { Connect } from './connect'

/// What the app shows before there is an address to read for.
export function Gate({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto mt-24 max-w-[480px] text-center">
      <h1 className="text-[24px] font-semibold tracking-[-0.01em]">{title}</h1>
      <p className="mt-3 text-[15px] leading-[1.55] text-[var(--ink-soft)]">{body}</p>
      <div className="mt-7 flex justify-center">
        <Connect />
      </div>
    </div>
  )
}
