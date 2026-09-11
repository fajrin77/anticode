/** Dollars as a reader wants them: cents for most, more digits for fractions of a cent. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 100) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString('en-US')}`
}
