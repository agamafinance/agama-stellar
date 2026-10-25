import type { Metadata } from 'next'
import './globals.css'
import { Nav } from './nav'

export const metadata: Metadata = {
  title: 'Agama on Stellar',
  description: 'Deposit the stock, keep the stock, earn on its value.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto max-w-[1180px] px-6 pb-24 pt-10 md:px-10">{children}</main>
      </body>
    </html>
  )
}
