import type {
  Expense,
  LedgerSummary,
  MonthlyLedgerSummary,
  ParticipantContributionSnapshot,
  SettlementSummary,
} from '../types'

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

function settlementFromNet(netByParticipant: Record<string, number>): SettlementSummary | null {
  const sortedParticipants = Object.entries(netByParticipant).sort((a, b) => a[1] - b[1])
  if (sortedParticipants.length < 2) {
    return null
  }

  const [debtor, creditor] = [sortedParticipants[0], sortedParticipants[sortedParticipants.length - 1]]
  const amount = roundCurrency(Math.max(0, creditor[1]))
  if (amount <= 0) {
    return null
  }

  return {
    debtor: debtor[0],
    creditor: creditor[0],
    amount,
  }
}

function makeParticipantSnapshots(
  participantTotals: Record<string, number>,
  effectiveContributionTotals: Record<string, number>,
  ledgerTotal: number,
): Record<string, ParticipantContributionSnapshot> {
  const snapshots: Record<string, ParticipantContributionSnapshot> = {}

  for (const participant of Object.keys(participantTotals)) {
    const effectiveContribution = roundCurrency(effectiveContributionTotals[participant] ?? 0)
    snapshots[participant] = {
      paid: roundCurrency(participantTotals[participant] ?? 0),
      effectiveContribution,
      effectiveRate: ledgerTotal > 0 ? roundCurrency((effectiveContribution / ledgerTotal) * 100) : 0,
    }
  }

  return snapshots
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
    const participantContributionSnapshots = Object.fromEntries(
      names.map((name) => [
        name,
        {
          paid: 0,
          effectiveContribution: 0,
          effectiveRate: 0,
        },
      ]),
    ) as Record<string, ParticipantContributionSnapshot>

    return {
      commonCurrency: 'USD',
      ledgerTotal: 0,
      sharedLedgerTotal: 0,
      fairShare: 0,
      participantTotals: { [names[0]]: 0, [names[1]]: 0 },
      participantContributionSnapshots,
      sharedParticipantTotals: { [names[0]]: 0, [names[1]]: 0 },
      settlement: null,
      monthlySummaries: [],
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
  const effectiveContributionTotals: Record<string, number> = {}
  const settlementNetByParticipant: Record<string, number> = {}
  const monthlyBucketMap = new Map<
    string,
    {
      totalSpend: number
      participantTotals: Record<string, number>
      effectiveContributionTotals: Record<string, number>
      settlementNetByParticipant: Record<string, number>
    }
  >()

  const settlementParticipants =
    participants ??
    (([...new Set(convertedExpenses.map((expense) => expense.participant))].slice(0, 2) as string[]) as [
      string,
      string,
    ])

  for (const name of settlementParticipants ?? []) {
    settlementNetByParticipant[name] = 0
    participantTotals[name] = 0
    sharedParticipantTotals[name] = 0
    effectiveContributionTotals[name] = 0
  }

  for (const expense of convertedExpenses) {
    const owedPercent = normalizeOwedPercent(expense.owedPercent)
    const payer = expense.participant
    participantTotals[payer] = roundCurrency((participantTotals[payer] ?? 0) + expense.convertedAmount)
    if (owedPercent === 50) {
      sharedParticipantTotals[payer] = roundCurrency((sharedParticipantTotals[payer] ?? 0) + expense.convertedAmount)
    }

    if (settlementParticipants && settlementParticipants.includes(payer)) {
      const otherParticipant = settlementParticipants.find((name) => name !== payer)
      if (otherParticipant) {
        const credit = expense.convertedAmount * (owedPercent / 100)
        const payerContribution = expense.convertedAmount - credit
        const otherContribution = credit

        effectiveContributionTotals[payer] = roundCurrency(
          (effectiveContributionTotals[payer] ?? 0) + payerContribution,
        )
        effectiveContributionTotals[otherParticipant] = roundCurrency(
          (effectiveContributionTotals[otherParticipant] ?? 0) + otherContribution,
        )
        settlementNetByParticipant[payer] = roundCurrency((settlementNetByParticipant[payer] ?? 0) + credit)
        settlementNetByParticipant[otherParticipant] = roundCurrency(
          (settlementNetByParticipant[otherParticipant] ?? 0) - credit,
        )

        const month = normalizeDate(expense.incurredOn).slice(0, 7)
        const bucket =
          monthlyBucketMap.get(month) ??
          {
            totalSpend: 0,
            participantTotals: Object.fromEntries(
              settlementParticipants.map((name) => [name, 0]),
            ) as Record<string, number>,
            effectiveContributionTotals: Object.fromEntries(
              settlementParticipants.map((name) => [name, 0]),
            ) as Record<string, number>,
            settlementNetByParticipant: Object.fromEntries(
              settlementParticipants.map((name) => [name, 0]),
            ) as Record<string, number>,
          }

        bucket.totalSpend = roundCurrency(bucket.totalSpend + expense.convertedAmount)
        bucket.participantTotals[payer] = roundCurrency(bucket.participantTotals[payer] + expense.convertedAmount)
        bucket.effectiveContributionTotals[payer] = roundCurrency(
          bucket.effectiveContributionTotals[payer] + payerContribution,
        )
        bucket.effectiveContributionTotals[otherParticipant] = roundCurrency(
          bucket.effectiveContributionTotals[otherParticipant] + otherContribution,
        )
        bucket.settlementNetByParticipant[payer] = roundCurrency(bucket.settlementNetByParticipant[payer] + credit)
        bucket.settlementNetByParticipant[otherParticipant] = roundCurrency(
          bucket.settlementNetByParticipant[otherParticipant] - credit,
        )
        monthlyBucketMap.set(month, bucket)
      }
    }
  }

  if (participants) {
    for (const name of participants) {
      participantTotals[name] = participantTotals[name] ?? 0
      effectiveContributionTotals[name] = effectiveContributionTotals[name] ?? 0
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
  const participantContributionSnapshots = makeParticipantSnapshots(
    participantTotals,
    effectiveContributionTotals,
    ledgerTotal,
  )
  const settlement = settlementFromNet(settlementNetByParticipant)
  const monthlySummaries: MonthlyLedgerSummary[] = [...monthlyBucketMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, bucket]) => ({
      month,
      totalSpend: roundCurrency(bucket.totalSpend),
      participantSnapshots: makeParticipantSnapshots(
        bucket.participantTotals,
        bucket.effectiveContributionTotals,
        bucket.totalSpend,
      ),
      settlement: settlementFromNet(bucket.settlementNetByParticipant),
    }))

  return {
    commonCurrency,
    ledgerTotal,
    sharedLedgerTotal,
    fairShare,
    participantTotals,
    participantContributionSnapshots,
    sharedParticipantTotals,
    settlement,
    monthlySummaries,
    convertedExpenses,
    currencyValueWeights,
  }
}
