interface ModelTokens {
  model: string
  inputTokens: number
  cachedTokens: number
  outputTokens: number
}

/** Combine accounts/providers of the same exact model without merging aliases. */
export function usageModelTotals(rows: readonly ModelTokens[]): ModelTokens[] {
  const totals = new Map<string, ModelTokens>()
  for (const row of rows) {
    const total = totals.get(row.model)
    if (total) {
      total.inputTokens += row.inputTokens
      total.cachedTokens += row.cachedTokens
      total.outputTokens += row.outputTokens
    } else totals.set(row.model, { model: row.model, inputTokens: row.inputTokens, cachedTokens: row.cachedTokens, outputTokens: row.outputTokens })
  }
  return [...totals.values()]
}
