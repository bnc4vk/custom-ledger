import { createWorker } from 'tesseract.js'
import type { ReceiptExtraction } from '../types'

let workerPromise: ReturnType<typeof createWorker> | null = null

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng')
  }

  return workerPromise
}

const currencySymbolMap: Record<string, string> = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
}

function normalizeDateToIso(value: string): string | undefined {
  const trimmed = value.trim()

  const isoMatch = trimmed.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/)
  if (isoMatch) {
    const [, year, month, day] = isoMatch
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  const mdYMatch = trimmed.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/)
  if (mdYMatch) {
    const [, month, day, year] = mdYMatch
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  const monthNameMatch = trimmed.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2})\b/i,
  )
  if (monthNameMatch) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const monthIndex = months.indexOf(monthNameMatch[1].slice(0, 3).toLowerCase()) + 1
    if (monthIndex > 0) {
      return `${monthNameMatch[3]}-${String(monthIndex).padStart(2, '0')}-${monthNameMatch[2].padStart(2, '0')}`
    }
  }

  return undefined
}

function parseAmountAndCurrency(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const prioritized = [...lines].sort((a, b) => {
    const score = (line: string) => {
      const lower = line.toLowerCase()
      if (/\bgrand\s+total\b/.test(lower)) return 6
      if (/\btotal\b/.test(lower) && !/\bsubtotal\b/.test(lower)) return 5
      if (/\bbalance\s+due\b/.test(lower)) return 4
      if (/\bamount\b/.test(lower)) return 3
      return 0
    }
    return score(b) - score(a)
  })

  for (const line of prioritized) {
    const amountMatch = line.match(/(?:([A-Z]{3})\s*)?([$€£¥])?\s*([0-9]+(?:[.,][0-9]{2})?)/)
    if (!amountMatch) continue

    const code = amountMatch[1]?.toUpperCase()
    const symbol = amountMatch[2]
    const raw = amountMatch[3].replace(',', '')
    const amount = Number.parseFloat(raw)
    if (!Number.isFinite(amount)) continue

    return {
      amount,
      currency: code ?? (symbol ? currencySymbolMap[symbol] : undefined),
    }
  }

  return {}
}

function parseMerchant(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    if (line.length < 3) continue
    if (/^(receipt|invoice|thank\s+you|order|cashier|table)/i.test(line)) continue
    if (/^[0-9\s\-/:.]+$/.test(line)) continue
    return line
  }

  return undefined
}

function parseDate(text: string) {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const maybeDate = normalizeDateToIso(line)
    if (maybeDate) {
      return maybeDate
    }
  }

  return normalizeDateToIso(text)
}

export function parseReceiptText(text: string): ReceiptExtraction {
  const cleaned = text.replace(/[\t ]+/g, ' ').trim()
  const merchant = parseMerchant(cleaned)
  const { amount, currency } = parseAmountAndCurrency(cleaned)
  const incurredOn = parseDate(cleaned)

  return {
    rawText: cleaned,
    merchant,
    description: merchant ? `Expense at ${merchant}` : 'Receipt expense',
    amount,
    currency,
    incurredOn,
    confidence: amount ? 0.6 : 0.25,
  }
}

export async function extractExpenseFromImage(file: File): Promise<ReceiptExtraction> {
  const worker = await getWorker()
  const result = await worker.recognize(file)
  return parseReceiptText(result.data.text)
}
