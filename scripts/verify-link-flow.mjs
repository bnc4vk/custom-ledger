import { chromium } from 'playwright'

const baseUrl = 'http://127.0.0.1:5173/custom-ledger/'

function uniqueDescription() {
  return `ZZ Link Scope ${Date.now()}`
}

async function collectVisibleErrors(page) {
  const values = await page.locator('.status-line.error').allTextContents()
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

async function ensureNoVisibleErrors(page, context) {
  const errors = await collectVisibleErrors(page)
  if (errors.length) {
    await page.screenshot({ path: `tmp-link-flow-${context}.png`, fullPage: true })
    throw new Error(`${context}: visible errors -> ${errors.join(' | ')}`)
  }
}

async function openAddForm(page) {
  const addButton = page.getByRole('button', { name: 'Add Expense' })
  if (await addButton.count()) {
    await addButton.click()
  }
  await page.locator('.expense-form').waitFor({ state: 'visible' })
}

async function addExpense(page, description) {
  await openAddForm(page)
  const form = page.locator('.expense-form')
  await form.locator('select').selectOption({ index: 0 })
  await form.getByLabel('Description', { exact: true }).fill(description)
  await form.getByLabel('Amount', { exact: true }).fill('19.99')
  await form.getByLabel('Currency', { exact: true }).fill('USD')
  await form.getByLabel('Owed share %', { exact: true }).fill('')
  await form.locator('textarea').fill('Ledger link isolation test')

  await page.getByRole('button', { name: 'Save Expense' }).click()
  await page.locator('.expense-item').filter({ hasText: description }).first().waitFor({ state: 'visible' })
}

async function setDefaultOwnershipSplit(page, value) {
  await page.getByLabel('Default ownership split %', { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Save Default' }).click()
  await page.waitForFunction((expected) => {
    const input = document.querySelector('input[aria-label="Default ownership split %"], .default-split-controls input')
    return input instanceof HTMLInputElement && input.value === expected
  }, value)
}

async function deleteExpense(page, description) {
  const row = page.locator('.expense-item').filter({ hasText: description }).first()
  await row.waitFor({ state: 'visible' })

  page.once('dialog', async (dialog) => {
    await dialog.accept()
  })

  await row.getByRole('button', { name: 'Delete' }).click()

  await page.waitForFunction((needle) => {
    const rows = Array.from(document.querySelectorAll('.expense-item'))
    return !rows.some((row) => (row.textContent || '').includes(needle))
  }, description)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1366, height: 920 } })

  const consoleErrors = []
  const pageErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Shared Ledger Links' }).waitFor()
  await ensureNoVisibleErrors(page, 'landing')

  await page.getByRole('button', { name: 'Generate Link' }).click()
  await page.waitForURL(/\/custom-ledger\/#\/[a-z0-9-]+$/)

  const generatedUrl = page.url()
  const generatedDescription = uniqueDescription()

  await page.getByRole('heading', { name: /Ledger$/ }).waitFor()
  await ensureNoVisibleErrors(page, 'generated-ledger')
  await setDefaultOwnershipSplit(page, '37.5')
  await addExpense(page, generatedDescription)
  await ensureNoVisibleErrors(page, 'generated-after-add')

  const generatedRow = page.locator('.expense-item').filter({ hasText: generatedDescription }).first()
  const generatedRowText = await generatedRow.innerText()
  if (!generatedRowText.includes('37.5%')) {
    throw new Error(`Expected generated expense to inherit 37.5% default split. Row text: ${generatedRowText}`)
  }

  await page.reload({ waitUntil: 'networkidle' })
  await page.getByLabel('Default ownership split %', { exact: true }).waitFor()
  const persistedDefault = await page.getByLabel('Default ownership split %', { exact: true }).inputValue()
  if (persistedDefault !== '37.5') {
    throw new Error(`Expected persisted default ownership split to be 37.5, received ${persistedDefault}`)
  }

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Shared Ledger Links' }).waitFor()

  await page.goto(`${baseUrl}#/ryan-ben`, { waitUntil: 'networkidle' })
  await ensureNoVisibleErrors(page, 'legacy-ledger')

  const leaked = await page.locator('.expense-item').filter({ hasText: generatedDescription }).count()
  if (leaked > 0) {
    throw new Error('Generated-ledger expense appeared inside the legacy ryan-ben ledger.')
  }

  await page.goto(generatedUrl, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: /Ledger$/ }).waitFor()
  await deleteExpense(page, generatedDescription)
  await ensureNoVisibleErrors(page, 'generated-after-delete')

  await page.screenshot({ path: 'tmp-link-flow-final.png', fullPage: true })

  if (consoleErrors.length) {
    console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
  }
  if (pageErrors.length) {
    console.log('PAGE_ERRORS', JSON.stringify(pageErrors))
  }

  console.log('RESULT', JSON.stringify({ generatedUrl, legacyUrl: `${baseUrl}#/ryan-ben` }))

  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
