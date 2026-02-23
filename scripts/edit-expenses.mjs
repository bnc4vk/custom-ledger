import { chromium } from 'playwright'

const baseUrl = 'http://127.0.0.1:5173/'

const desired = [
  { description: 'EDC weekend', participant: 'Ben', isShared: false },
  { description: 'EDC splitwise', participant: 'Ben', isShared: false },
  { description: 'laptop', participant: 'Ben', isShared: false },
  { description: 'payment', participant: 'Ryan', isShared: false },
  { description: 'brighton', participant: 'Ryan', isShared: false },
  { description: 'hai di lao', participant: 'Ben', isShared: true },
  { description: 'heaf', participant: 'Ryan', isShared: false },
  { description: '2cb 2x', participant: 'Ben', isShared: false, amount: '20', currency: 'GBP' },
]

async function getRow(page, item) {
  const column = page.locator('.ledger-column').filter({
    has: page.getByRole('heading', { name: item.participant, level: 2 }),
  })
  return column.locator('.expense-item').filter({ hasText: item.description }).first()
}

async function visibleErrorTexts(page) {
  const loc = page.locator('.status-line.error')
  const count = await loc.count()
  const values = []
  for (let i = 0; i < count; i += 1) {
    const text = (await loc.nth(i).innerText()).trim()
    if (text) values.push(text)
  }
  return [...new Set(values)]
}

async function waitForSaveDone(page) {
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('button')]
    const updateBtn = buttons.find((el) => (el.textContent || '').trim() === 'Update Expense')
    const saveBtn = buttons.find((el) => (el.textContent || '').trim() === 'Save Expense')

    // Edit mode closed after a successful save.
    if (!updateBtn) {
      return saveBtn ? !saveBtn.hasAttribute('disabled') : true
    }

    return !updateBtn.hasAttribute('disabled')
  })
  await page.waitForTimeout(500)
}

async function editExpense(page, item) {
  const row = await getRow(page, item)
  await row.waitFor()
  const before = await row.innerText()
  console.log(`Editing ${item.description} (${item.participant})`)

  await row.getByRole('button', { name: 'Edit' }).click()

  const form = page.locator('.expense-form')
  await page.getByRole('heading', { name: 'Edit Expense' }).waitFor()

  const descriptionInput = form.getByLabel('Description')
  const amountInput = form.getByLabel('Amount')
  const currencyInput = form.getByLabel('Currency')
  const sharedCheckbox = form.locator('input[type="checkbox"]')

  const currentDescription = await descriptionInput.inputValue()
  if (currentDescription.toLowerCase() !== item.description.toLowerCase()) {
    throw new Error(`Edit form loaded wrong expense. Expected ${item.description}, got ${currentDescription}`)
  }

  if (item.amount) {
    await amountInput.fill('')
    await amountInput.type(item.amount, { delay: 20 })
  }

  if (item.currency) {
    await currencyInput.fill('')
    await currencyInput.type(item.currency, { delay: 15 })
  }

  const checked = await sharedCheckbox.isChecked()
  if (checked !== item.isShared) {
    await sharedCheckbox.click()
  }

  await page.getByRole('button', { name: 'Update Expense' }).click()
  await waitForSaveDone(page)

  const errors = await visibleErrorTexts(page)
  if (errors.length) {
    throw new Error(`Visible error after editing ${item.description}: ${errors.join(' | ')}`)
  }

  const updatedRow = await getRow(page, item)
  await updatedRow.waitFor()
  const after = await updatedRow.innerText()

  const expectedBadge = item.isShared ? 'Shared (50/50)' : 'On behalf (100%)'
  if (!after.includes(expectedBadge)) {
    throw new Error(`Badge mismatch for ${item.description}. Row text: ${after}`)
  }
  if (item.amount && !after.includes('£20.00') && item.description === '2cb 2x') {
    throw new Error(`Amount update missing for 2cb 2x. Row text: ${after}`)
  }

  if (before === after) {
    console.log(`No visible row text change for ${item.description} (already in desired state)`)
  } else {
    console.log(`Updated ${item.description}`)
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1360, height: 920 } })

  const consoleErrors = []
  const pageErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Ryan and Ben Ledger' }).waitFor()

  const initialErrors = await visibleErrorTexts(page)
  if (initialErrors.length) {
    throw new Error(`Initial visible errors: ${initialErrors.join(' | ')}`)
  }

  for (const item of desired) {
    await editExpense(page, item)
  }

  const summary = await page.locator('.summary-panel').innerText()
  const finalErrors = await visibleErrorTexts(page)
  await page.screenshot({ path: 'tmp-after-edits.png', fullPage: true })

  console.log('SUMMARY_START')
  console.log(summary)
  console.log('SUMMARY_END')
  console.log('VISIBLE_ERRORS', JSON.stringify(finalErrors))
  console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors))
  console.log('PAGE_ERRORS', JSON.stringify(pageErrors))

  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
