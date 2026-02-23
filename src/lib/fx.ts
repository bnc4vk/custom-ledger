import type { Expense, LedgerSummary } from '../types'

const FX_API_BASE = 'https://api.frankfurter.dev/v1'
const fxRateCache = new Map<string, Promise<number>>()

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function normalizeDate(date: string) {
  return date.slice(0, 10)
}

function normalizeOwedPercent(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 100
  }

  return Math.min(100, Math.max(0, value))
}

export async function fetchFxRate(date: string, from: string, to: string): Promise<number> {
  const normalizedFrom = from.trim().toUpperCase()
  const normalizedTo = to.trim().toUpperCase()

  if (normalizedFrom === normalizedTo) {
    return 1
  }

  const key = `${normalizeDate(date)}|${normalizedFrom}|${normalizedTo}`
  const cached = fxRateCache.get(key)
  if (cached) {
    return cached
  }

  const request = (async () => {
    const params = new URLSearchParams({
      amount: '1',
      from: normalizedFrom,
      to: normalizedTo,
    })

    const response = await fetch(`${FX_API_BASE}/${normalizeDate(date)}?${params.toString()}`)
    if (!response.ok) {
      throw new Error(`FX request failed (${response.status}) for ${normalizedFrom}->${normalizedTo}`)
    }

    const json = (await response.json()) as { rates?: Record<string, number> }
    const rate = json.rates?.[normalizedTo]
    if (typeof rate !== 'number' || Number.isNaN(rate)) {
      throw new Error(`Missing FX rate for ${normalizedFrom}->${normalizedTo}`)
    }

    return rate
  })()

  fxRateCache.set(key, request)

  try {
    return await request
  } catch (error) {
    fxRateCache.delete(key)
    throw error
  }
}

export async function convertAmount(amount: number, date: string, from: string, to: string) {
  const rate = await fetchFxRate(date, from, to)
  return {
    rate,
    convertedAmount: amount * rate,
  }
}

function chooseFallbackCurrency(expenses: Expense[]) {
  const byFrequency = new Map<string, number>()

  for (const expense of expenses) {
    const code = expense.currency.toUpperCase()
    byFrequency.set(code, (byFrequency.get(code) ?? 0) + 1)
  }

  const winner = [...byFrequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return winner ?? 'USD'
}

export async function computeLedgerSummary(
  expenses: Expense[],
  participants?: [string, string],
): Promise<LedgerSummary> {
  if (expenses.length === 0) {
    const names = participants ?? ['Participant A', 'Participant B']
    return {
      commonCurrency: 'USD',
      ledgerTotal: 0,
      sharedLedgerTotal: 0,
      fairShare: 0,
      participantTotals: { [names[0]]: 0, [names[1]]: 0 },
      sharedParticipantTotals: { [names[0]]: 0, [names[1]]: 0 },
      settlement: null,
      convertedExpenses: [],
      currencyValueWeights: {},
    }
  }

  const normalized = expenses.map((expense) => ({
    ...expense,
    currency: expense.currency.toUpperCase(),
  }))

  const estimatedValues = await Promise.all(
    normalized.map(async (expense) => {
      try {
        const { convertedAmount } = await convertAmount(expense.amount, expense.incurredOn, expense.currency, 'USD')
        return { expense, usdAmount: convertedAmount }
      } catch {
        // Skip failed estimates from weighting, but keep overall summary conversion attempts later.
        return { expense, usdAmount: 0 }
      }
    }),
  )

  const currencyValueWeights: Record<string, number> = {}
  for (const item of estimatedValues) {
    currencyValueWeights[item.expense.currency] =
      (currencyValueWeights[item.expense.currency] ?? 0) + item.usdAmount
  }

  const weightedWinner = Object.entries(currencyValueWeights).sort((a, b) => b[1] - a[1])[0]?.[0]
  const commonCurrency = weightedWinner ?? chooseFallbackCurrency(normalized)

  const convertedExpenses = await Promise.all(
    normalized.map(async (expense) => {
      const { rate, convertedAmount } = await convertAmount(
        expense.amount,
        expense.incurredOn,
        expense.currency,
        commonCurrency,
      )

      return {
        ...expense,
        convertedAmount: roundCurrency(convertedAmount),
        convertedCurrency: commonCurrency,
        fxRate: rate,
      }
    }),
  )

  const participantTotals: Record<string, number> = {}
  const sharedParticipantTotals: Record<string, number> = {}
  const settlementNetByParticipant: Record<string, number> = {}

  const settlementParticipants =
    participants ??
    (([...new Set(convertedExpenses.map((expense) => expense.participant))].slice(0, 2) as string[]) as [
      string,
      string,
    ])

  for (const name of settlementParticipants ?? []) {
    settlementNetByParticipant[name] = 0
  }

  for (const expense of convertedExpenses) {
    const owedPercent = normalizeOwedPercent(expense.owedPercent)
    participantTotals[expense.participant] = roundCurrency(
      (participantTotals[expense.participant] ?? 0) + expense.convertedAmount,
    )
    if (owedPercent === 50) {
      sharedParticipantTotals[expense.participant] = roundCurrency(
        (sharedParticipantTotals[expense.participant] ?? 0) + expense.convertedAmount,
      )
    }

    const payer = expense.participant
    if (settlementParticipants && settlementParticipants.includes(payer)) {
      const otherParticipant = settlementParticipants.find((name) => name !== payer)
      if (otherParticipant) {
        const credit = expense.convertedAmount * (owedPercent / 100)
        settlementNetByParticipant[payer] = roundCurrency(
          (settlementNetByParticipant[payer] ?? 0) + credit,
        )
        settlementNetByParticipant[otherParticipant] = roundCurrency(
          (settlementNetByParticipant[otherParticipant] ?? 0) - credit,
        )
      }
    }
  }

  if (participants) {
    for (const name of participants) {
      participantTotals[name] = participantTotals[name] ?? 0
      sharedParticipantTotals[name] = sharedParticipantTotals[name] ?? 0
      settlementNetByParticipant[name] = settlementNetByParticipant[name] ?? 0
    }
  }

  const ledgerTotal = roundCurrency(
    convertedExpenses.reduce((sum, expense) => sum + expense.convertedAmount, 0),
  )
  const sharedLedgerTotal = roundCurrency(
    convertedExpenses
      .filter((expense) => normalizeOwedPercent(expense.owedPercent) === 50)
      .reduce((sum, expense) => sum + expense.convertedAmount, 0),
  )
  const fairShare = roundCurrency(sharedLedgerTotal / 2)

  const sortedParticipants = Object.entries(settlementNetByParticipant).sort((a, b) => a[1] - b[1])
  let settlement: LedgerSummary['settlement'] = null

  if (sortedParticipants.length >= 2) {
    const [debtor, creditor] = [sortedParticipants[0], sortedParticipants[sortedParticipants.length - 1]]
    const amount = roundCurrency(Math.max(0, creditor[1]))
    if (amount > 0) {
      settlement = {
        debtor: debtor[0],
        creditor: creditor[0],
        amount,
      }
    }
  }

  return {
    commonCurrency,
    ledgerTotal,
    sharedLedgerTotal,
    fairShare,
    participantTotals,
    sharedParticipantTotals,
    settlement,
    convertedExpenses,
    currencyValueWeights,
  }
}
