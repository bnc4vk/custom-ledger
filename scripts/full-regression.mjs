import { chromium } from 'playwright'

const baseUrl = 'http://127.0.0.1:5173/custom-ledger/'

const addDeleteCases = [
  {
    label: 'A-defaults',
    participant: 'Ryan',
    description: 'ZZ Dummy A defaults',
    merchant: '',
    amount: '12.34',
    currency: 'USD',
    date: '2026-02-24',
    owedPercent: '',
    notes: 'temp',
  },
  {
    label: 'B-50-gbp',
    participant: 'Ben',
    description: 'ZZ Dummy B 50 GBP',
    merchant: 'Test Merchant',
    amount: '45.67',
    currency: 'GBP',
    date: '2025-12-31',
    owedPercent: '50',
    notes: 'temp',
  },
  {
    label: 'C-zero-eur',
    participant: 'Ryan',
    description: 'ZZ Dummy C zero EUR',
    merchant: '',
    amount: '8.9',
    currency: 'EUR',
    date: '2024-06-15',
    owedPercent: '0',
    notes: '',
  },
  {
    label: 'D-decimal-jpy',
    participant: 'Ben',
    description: 'ZZ Dummy D 33.33 JPY',
    merchant: 'Combo',
    amount: '3000',
    currency: 'JPY',
    date: '2023-01-05',
    owedPercent: '33.33',
    notes: 'temp',
  },
]

const editChain = {
  initial: {
    participant: 'Ryan',
    description: 'ZZ Edit Target',
    merchant: 'Start',
    amount: '21',
    currency: 'USD',
    date: '2026-01-01',
    owedPercent: '',
    notes: 'edit me',
  },
  edits: [
    {
      participant: 'Ben',
      description: 'ZZ Edit Target v2',
      merchant: 'Updated Merchant',
      amount: '99.95',
      currency: 'GBP',
      date: '2025-11-20',
      owedPercent: '50',
      notes: 'updated',
    },
    {
      participant: 'Ryan',
      description: 'ZZ Edit Target v3',
      merchant: '',
      amount: '77.77',
      currency: 'EUR',
      date: '2022-09-09',
      owedPercent: '12.5',
      notes: '',
    },
  ],
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function collectVisibleErrors(page) {
  const loc = page.locator('.status-line.error')
  const count = await loc.count()
  const vals = []
  for (let i = 0; i < count; i += 1) {
    const txt = (await loc.nth(i).innerText()).trim()
    if (txt) vals.push(txt)
  }
  return [...new Set(vals)]
}

async function ensureNoVisibleErrors(page, context) {
  const errors = await collectVisibleErrors(page)
  if (errors.length) {
    await page.screenshot({ path: `tmp-regression-${context.replace(/[^a-z0-9_-]/gi, '_')}.png`, fullPage: true })
    throw new Error(`${context}: visible errors -> ${errors.join(' | ')}`)
  }
}

async function openAddForm(page) {
  const addBtn = page.getByRole('button', { name: 'Add Expense' })
  if (await addBtn.count()) {
    await addBtn.click()
  }
  await page.locator('.expense-form').waitFor({ state: 'visible' })
}

async function fillExpenseForm(page, data) {
  const form = page.locator('.expense-form')
  await form.locator('select').selectOption(data.participant)
  await form.getByLabel('Description', { exact: true }).fill(data.description)
  await form.getByLabel('Merchant (optional)', { exact: true }).fill(data.merchant)
  await form.getByLabel('Amount', { exact: true }).fill(data.amount)
  await form.getByLabel('Currency', { exact: true }).fill(data.currency)
  await form.getByLabel('Date', { exact: true }).fill(data.date)
  await form.getByLabel('On behalf %', { exact: true }).fill(data.owedPercent)
  await form.locator('textarea').fill(data.notes)
}

async function submitExpenseForm(page, isEdit = false) {
  const button = page.getByRole('button', { name: isEdit ? 'Update Expense' : 'Save Expense' })
  await button.click()
  await page.waitForFunction((target) => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === target)
    return btn ? !btn.hasAttribute('disabled') : true
  }, isEdit ? 'Update Expense' : 'Save Expense')
  await delay(700)
}

async function findRow(page, description) {
  return page.locator('.expense-item').filter({ hasText: description }).first()
}

async function addExpense(page, data) {
  console.log(`ADD ${data.label}`)
  await openAddForm(page)
  await fillExpenseForm(page, data)
  await submitExpenseForm(page, false)
  await ensureNoVisibleErrors(page, `add-${data.label}`)
  const row = await findRow(page, data.description)
  await row.waitFor()
  return row
}

async function deleteExpense(page, description) {
  console.log(`DELETE ${description}`)
  const row = await findRow(page, description)
  await row.waitFor()
  page.once('dialog', async (dialog) => {
    await dialog.accept()
  })
  await row.getByRole('button', { name: 'Delete' }).click()
  await delay(1000)
  await ensureNoVisibleErrors(page, `delete-${description}`)
  if (await page.locator('.expense-item').filter({ hasText: description }).count()) {
    throw new Error(`delete-${description}: row still present`)
  }
}

async function editExpense(page, fromDescription, nextData) {
  console.log(`EDIT ${fromDescription} -> ${nextData.description}`)
  const row = await findRow(page, fromDescription)
  await row.waitFor()
  await row.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('heading', { name: 'Edit Expense' }).waitFor()
  await fillExpenseForm(page, nextData)
  await submitExpenseForm(page, true)
  await ensureNoVisibleErrors(page, `edit-${fromDescription}`)
  const nextRow = await findRow(page, nextData.description)
  await nextRow.waitFor()
  return nextRow
}

async function testPdfUpload(page) {
  console.log('UPLOAD PDF Test_Expense.pdf')
  await openAddForm(page)
  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles('Test_Expense.pdf')
  await delay(5000)
  const errors = await collectVisibleErrors(page)
  const form = page.locator('.expense-form')
  const description = await form.getByLabel('Description', { exact: true }).inputValue()
  const amount = await form.getByLabel('Amount', { exact: true }).inputValue()
  const currency = await form.getByLabel('Currency', { exact: true }).inputValue()
  const date = await form.getByLabel('Date', { exact: true }).inputValue()
  const ocrPreviewVisible = await page.locator('.ocr-preview').count()
  console.log('PDF_UPLOAD_RESULT', JSON.stringify({ description, amount, currency, date, ocrPreviewVisible, errors }))

  const hasPrefill = Boolean(description || amount)
  if (!hasPrefill) {
    throw new Error(`pdf-upload: no prefill. errors=${errors.join(' | ')}`)
  }

  // Cleanup: if upload prefills something, clear form and collapse.
  await form.getByLabel('Description', { exact: true }).fill('')
  await form.getByLabel('Amount', { exact: true }).fill('')
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1380, height: 960 } })

  const consoleErrors = []
  const pageErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Ryan and Ben Ledger' }).waitFor()
  await ensureNoVisibleErrors(page, 'initial')

  for (const c of addDeleteCases) {
    await addExpense(page, c)
    await deleteExpense(page, c.description)
  }

  await addExpense(page, { label: 'edit-seed', ...editChain.initial })
  let currentDesc = editChain.initial.description
  for (const edit of editChain.edits) {
    await editExpense(page, currentDesc, edit)
    currentDesc = edit.description
  }
  await deleteExpense(page, currentDesc)

  await testPdfUpload(page)

  await page.screenshot({ path: 'tmp-regression-final.png', fullPage: true })
  console.log('VISIBLE_ERRORS', JSON.stringify(await collectVisibleErrors(page)))
  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
  console.log('PAGE_ERRORS', JSON.stringify(pageErrors))
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
