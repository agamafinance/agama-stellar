/// Seven decimals in, a readable string out.
///
/// Stroops are integers and JavaScript numbers are not, so the division
/// happens on strings. A balance that silently loses its last digits is worse
/// than one that is hard to read.
export function dec(raw: bigint | string | number | null | undefined, places = 2): string {
  if (raw === null || raw === undefined) return '0.00'
  const v = BigInt(raw)
  const neg = v < 0n
  const abs = neg ? -v : v
  const whole = abs / 10_000_000n
  const frac = (abs % 10_000_000n).toString().padStart(7, '0').slice(0, places)
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${places ? '.' + frac : ''}`
}

export const money = (raw: bigint | string | null | undefined, places = 2) =>
  `$${dec(raw, places)}`

/// Basis points as a percentage.
export const pct = (bps: number | string | null | undefined, places = 2) =>
  bps === null || bps === undefined ? '0.00%' : `${(Number(bps) / 100).toFixed(places)}%`

export const short = (id: string) => `${id.slice(0, 4)}…${id.slice(-4)}`

export function ago(seconds: number | bigint): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(seconds))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
