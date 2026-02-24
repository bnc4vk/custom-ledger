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

  const mdYYMatch = trimmed.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2})\b/)
  if (mdYYMatch) {
    const [, month, day, shortYear] = mdYYMatch
    const year = Number.parseInt(shortYear, 10)
    const fullYear = year >= 70 ? `19${shortYear}` : `20${shortYear}`
    return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
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

  const parseAmountFromLine = (line: string) => {
    const amountMatch = line.match(/(?:([A-Z]{3})\s*)?([$€£¥])?\s*([0-9]+(?:[.,][0-9]{2})?)/)
    if (!amountMatch) return null

    const code = amountMatch[1]?.toUpperCase()
    const symbol = amountMatch[2]
    const raw = amountMatch[3].replace(',', '')
    const amount = Number.parseFloat(raw)
    if (!Number.isFinite(amount)) return null

    return {
      amount,
      currency: code ?? (symbol ? currencySymbolMap[symbol] : undefined),
      hasCurrency: Boolean(code || symbol),
      raw: line,
    }
  }

  // First pass: detect total labels with amount on same line or following line.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lower = line.toLowerCase()
    const isPreferredTotal =
      (/\bgrand\s+total\b/.test(lower) || /\btotal\b/.test(lower) || /\bbalance\s+due\b/.test(lower)) &&
      !/\bsubtotal\b/.test(lower)

    if (!isPreferredTotal) continue

    const sameLine = parseAmountFromLine(line)
    if (sameLine?.hasCurrency || (sameLine && sameLine.amount > 0)) {
      return { amount: sameLine.amount, currency: sameLine.currency }
    }

    for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
      const nextLine = lines[j]
      if (!nextLine) continue
      const candidate = parseAmountFromLine(nextLine)
      if (candidate && (candidate.hasCurrency || candidate.amount > 0)) {
        return { amount: candidate.amount, currency: candidate.currency }
      }
    }
  }

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
    const candidate = parseAmountFromLine(line)
    if (!candidate) continue
    if (!candidate.hasCurrency && !/[.,][0-9]{2}\b/.test(line)) continue
    if (/order\s*#\d+/i.test(line)) continue

    return { amount: candidate.amount, currency: candidate.currency }
  }

  return {}
}

function parseMerchant(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const subjectMatch = line.match(/receipt\s+for\s+order\s+#\d+\s+at\s+(.+)/i)
    if (subjectMatch) {
      return subjectMatch[1].trim()
    }
    const visitMatch = line.match(/recent visit to\s+(.+?)(?:\.|$)/i)
    if (visitMatch) {
      return visitMatch[1].trim()
    }
  }

  for (const line of lines) {
    if (line.length < 3) continue
    if (/tell us how we did/i.test(line)) continue
    if (/gmail\b/i.test(line)) continue
    if (/https?:\/\//i.test(line)) continue
    if (/@/.test(line) || /<[^>]+>/.test(line)) continue
    if (/^(receipt|invoice|thank\s+you|order|cashier|table)/i.test(line)) continue
    if (/^[0-9\s\-/:.]+$/.test(line)) continue
    return line
  }

  return undefined
}

function parseDate(text: string) {
  const lines = text.split(/\r?\n/)
  const prioritized = [...lines].sort((a, b) => {
    const score = (line: string) => {
      const lower = line.toLowerCase()
      if (/\bordered\b/.test(lower)) return 5
      if (/\bdate\b/.test(lower)) return 4
      if (/\btime\b/.test(lower)) return 1
      if (/gmail\b/.test(lower)) return -2
      return 0
    }
    return score(b) - score(a)
  })
  for (const line of prioritized) {
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

async function extractTextFromPdf(file: File): Promise<string> {
  const [pdfjsLib, workerModule] = await Promise.all([
    import('pdfjs-dist/build/pdf.mjs'),
    import('pdfjs-dist/build/pdf.worker.mjs?url'),
  ])

  pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default

  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pages: string[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const pageText = content.items
      .map((item: { str?: string }) => item.str ?? '')
      .filter(Boolean)
      .join('\n')
    pages.push(pageText)
  }

  return pages.join('\n')
}

export async function extractExpenseFromImage(file: File): Promise<ReceiptExtraction> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  if (isPdf) {
    const text = await extractTextFromPdf(file)
    return parseReceiptText(text)
  }

  const worker = await getWorker()
  const result = await worker.recognize(file)
  return parseReceiptText(result.data.text)
}
