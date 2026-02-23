import { chromium } from 'playwright'

const baseUrl = 'http://127.0.0.1:5173/'

const expenses = [
  {
    original: '$1122 EDC weekend',
    participant: 'Ben',
    description: 'EDC weekend',
    amount: '1122',
    currency: 'USD',
    incurredOn: '2026-02-23',
  },
  {
    original: '$89 for EDC splitwise',
    participant: 'Ben',
    description: 'EDC splitwise',
    amount: '89',
    currency: 'USD',
    incurredOn: '2026-02-23',
  },
  {
    original: '$2218.86 laptop',
    participant: 'Ben',
    description: 'laptop',
    amount: '2218.86',
    currency: 'USD',
    incurredOn: '2026-02-23',
  },
  {
    original: '($600) payment',
    participant: 'Ryan',
    description: 'payment',
    amount: '600',
    currency: 'USD',
    incurredOn: '2026-02-23',
  },
  {
    original: '($238.29) brighton',
    participant: 'Ryan',
    description: 'brighton',
    amount: '238.29',
    currency: 'USD',
    incurredOn: '2026-02-23',
  },
  {
    original: '$235.22 hai di lao July 30th',
    participant: 'Ben',
    description: 'hai di lao',
    amount: '235.22',
    currency: 'USD',
    incurredOn: '2025-07-30',
  },
  {
    original: '(245.49 pounds) heaf Dec 19th',
    participant: 'Ryan',
    description: 'heaf',
    amount: '245.49',
    currency: 'GBP',
    incurredOn: '2025-12-19',
  },
  {
    original: '£10 2cb 2x Feb 21st',
    participant: 'Ben',
    description: '2cb 2x',
    amount: '10',
    currency: 'GBP',
    incurredOn: '2026-02-21',
  },
]

function esc(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}

async function detectVisibleErrors(page) {
  const lines = page.locator('.status-line.error')
  const count = await lines.count()
  const messages = []
  for (let i = 0; i < count; i += 1) {
    const text = (await lines.nth(i).innerText()).trim()
    if (text) messages.push(text)
  }
  return [...new Set(messages)]
}

async function ensureNoBlockingErrors(page, context) {
  const errors = await detectVisibleErrors(page)
  if (errors.length) {
    await page.screenshot({ path: `tmp-${context.replace(/[^a-z0-9_-]/gi, '_')}.png`, fullPage: true })
    throw new Error(`Visible error(s) during ${context}: ${errors.join(' | ')}`)
  }
}

async function rowExists(column, expense) {
  const pattern = new RegExp(`${esc(expense.description)}[\\s\\S]*${esc(expense.incurredOn)}`)
  const text = await column.innerText()
  return pattern.test(text) && text.includes(expense.amount)
}

async function addExpense(page, expense) {
  const form = page.locator('.expense-form')
  const participantSelect = form.locator('select')
  const descriptionInput = form.getByLabel('Description')
  const merchantInput = form.getByLabel('Merchant (optional)')
  const amountInput = form.getByLabel('Amount')
  const currencyInput = form.getByLabel('Currency')
  const dateInput = form.getByLabel('Date')
  const notesInput = form.getByLabel('Notes (optional)')
  const saveButton = page.getByRole('button', { name: 'Save Expense' })

  const column = page.locator('.ledger-column').filter({
    has: page.getByRole('heading', { name: expense.participant, level: 2 }),
  })

  if (await rowExists(column, expense)) {
    console.log(`SKIP already present: ${expense.original}`)
    return { skipped: true }
  }

  await participantSelect.selectOption(expense.participant)
  await descriptionInput.click()
  await descriptionInput.fill('')
  await descriptionInput.type(expense.description, { delay: 20 })
  await merchantInput.fill('')
  await amountInput.fill('')
  await amountInput.type(expense.amount, { delay: 15 })
  await currencyInput.fill('')
  await currencyInput.type(expense.currency, { delay: 15 })
  await dateInput.fill(expense.incurredOn)
  await notesInput.fill(`Imported from list: ${expense.original}`)

  await saveButton.click()

  await page.waitForTimeout(400)
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Save Expense'))
    return button ? !button.hasAttribute('disabled') : true
  })

  await page.waitForTimeout(700)
  await ensureNoBlockingErrors(page, `saving ${expense.original}`)

  const columnText = await column.innerText()
  if (!columnText.toLowerCase().includes(expense.description.toLowerCase())) {
    throw new Error(`Saved ${expense.original} but could not find it in ${expense.participant} column`) 
  }

  console.log(`ADDED ${expense.original}`)
  return { skipped: false }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  const consoleErrors = []
  const pageErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (error) => {
    pageErrors.push(String(error))
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Ryan and Ben Ledger' }).waitFor()

  await ensureNoBlockingErrors(page, 'initial load')

  for (const expense of expenses) {
    await addExpense(page, expense)
  }

  const finalErrors = await detectVisibleErrors(page)
  const summaryText = (await page.locator('.summary-panel').innerText()).trim()
  const ryanCol = await page.locator('.ledger-column').filter({ has: page.getByRole('heading', { name: 'Ryan', level: 2 }) }).innerText()
  const benCol = await page.locator('.ledger-column').filter({ has: page.getByRole('heading', { name: 'Ben', level: 2 }) }).innerText()

  console.log('FINAL_SUMMARY_START')
  console.log(summaryText)
  console.log('FINAL_SUMMARY_END')
  console.log('RYAN_COLUMN_START')
  console.log(ryanCol)
  console.log('RYAN_COLUMN_END')
  console.log('BEN_COLUMN_START')
  console.log(benCol)
  console.log('BEN_COLUMN_END')

  if (finalErrors.length || consoleErrors.length || pageErrors.length) {
    console.log('VISIBLE_ERRORS', JSON.stringify(finalErrors))
    console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
    console.log('PAGE_ERRORS', JSON.stringify(pageErrors))
  }

  await page.screenshot({ path: 'tmp-final-ledger.png', fullPage: true })
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
