import { format, isValid, parseISO } from 'date-fns'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DayPicker } from 'react-day-picker'
import './App.css'
import { computeLedgerSummary } from './lib/fx'
import { extractExpenseFromImage } from './lib/receipt'
import {
  LEGACY_LEDGER_SHARE_CODE,
  createExpense,
  createLedger,
  deleteExpense,
  ensureLegacyLedger,
  fetchExpenses,
  fetchLedgerByShareCode,
  isSupabaseConfigured,
  updateExpense,
  updateLedgerDefaultOwedPercent,
  updateLedgerParticipants,
} from './lib/supabase'
import type {
  ConvertedExpense,
  Expense,
  ExpenseFormState,
  ExpenseInsert,
  Ledger,
  LedgerSummary,
  ParticipantPair,
} from './types'

const DEFAULT_PARTICIPANTS: ParticipantPair = ['Participant A', 'Participant B']

function normalizeBasePath(basePath: string) {
  if (!basePath) {
    return '/'
  }

  let normalized = basePath.startsWith('/') ? basePath : `/${basePath}`
  if (!normalized.endsWith('/')) {
    normalized = `${normalized}/`
  }
  return normalized
}

const APP_BASE_PATH = normalizeBasePath(import.meta.env.BASE_URL ?? '/')

function appHomePath() {
  return APP_BASE_PATH
}

function appLedgerPath(shareCode: string) {
  return `${APP_BASE_PATH}#/${encodeURIComponent(shareCode)}`
}

function appLedgerUrl(shareCode: string) {
  return new URL(appLedgerPath(shareCode), window.location.origin).toString()
}

function readLedgerShareCodeFromHash(hash: string) {
  const normalized = hash.replace(/^#\/?/, '')
  if (!normalized) {
    return null
  }

  const [segment] = normalized.split('/').filter(Boolean)
  return segment ? decodeURIComponent(segment) : null
}

function readLedgerShareCodeFromPath(pathname: string) {
  const baseWithoutTrailingSlash = APP_BASE_PATH === '/' ? '/' : APP_BASE_PATH.slice(0, -1)

  let relativePath = ''
  if (pathname === APP_BASE_PATH || pathname === baseWithoutTrailingSlash) {
    relativePath = ''
  } else if (pathname.startsWith(APP_BASE_PATH)) {
    relativePath = pathname.slice(APP_BASE_PATH.length)
  } else if (APP_BASE_PATH !== '/' && pathname.startsWith(`${baseWithoutTrailingSlash}/`)) {
    relativePath = pathname.slice(baseWithoutTrailingSlash.length + 1)
  } else {
    relativePath = pathname.replace(/^\/+/, '')
  }

  const [segment] = relativePath.split('/').filter(Boolean)
  return segment ? decodeURIComponent(segment) : null
}

function readCurrentShareCode() {
  const hashShareCode = readLedgerShareCodeFromHash(window.location.hash)
  if (hashShareCode) {
    return hashShareCode
  }

  return readLedgerShareCodeFromPath(window.location.pathname)
}

function todayIso() {
  return format(new Date(), 'yyyy-MM-dd')
}

function makeEmptyForm(participant: string, currency = 'USD'): ExpenseFormState {
  return {
    participant,
    description: '',
    merchant: '',
    amount: '',
    currency,
    incurredOn: todayIso(),
    owedPercent: '',
    notes: '',
  }
}

function formStateFromExpense(expense: Expense): ExpenseFormState {
  return {
    participant: expense.participant,
    description: expense.description,
    merchant: expense.merchant ?? '',
    amount: String(expense.amount),
    currency: expense.currency,
    incurredOn: expense.incurredOn,
    owedPercent: Number.isInteger(expense.owedPercent)
      ? String(expense.owedPercent)
      : String(Math.round(expense.owedPercent * 100) / 100),
    notes: expense.notes ?? '',
  }
}

function formatCurrency(value: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

function formatExpenseDate(date: string) {
  try {
    const parsed = parseISO(date)
    return isValid(parsed) ? format(parsed, 'MMM d, yyyy') : date
  } catch {
    return date
  }
}

function formatDateButtonLabel(date: string) {
  if (!date) return 'Select date'
  try {
    const parsed = parseISO(date)
    return isValid(parsed) ? format(parsed, 'MMM d, yyyy') : date
  } catch {
    return date
  }
}

function parseOwedPercentInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return Number.NaN
  }

  return Math.round((parsed + Number.EPSILON) * 100) / 100
}

function effectiveOwedPercent(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 100
  }
  return Math.min(100, Math.max(0, value))
}

function formatPercentChip(value: number) {
  const rounded = Math.round(value * 100) / 100
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)
  return `${text}%`
}

function formatPercentInputValue(value: number) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function percentChipStyle(value: number) {
  const ratio = effectiveOwedPercent(value) / 100
  const bgAlpha = 0.05 + ratio * 0.18
  const borderAlpha = 0.12 + ratio * 0.24
  const textAlpha = 0.55 + ratio * 0.35

  return {
    background: `linear-gradient(135deg, rgba(29,111,85,${bgAlpha}), rgba(29,111,85,${bgAlpha * 0.45}))`,
    borderColor: `rgba(29,111,85,${borderAlpha})`,
    color: `rgba(17,83,61,${textAlpha})`,
  }
}

function DatePickerField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current) return
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  const selectedDate = useMemo(() => {
    if (!value) return undefined
    const parsed = parseISO(value)
    return isValid(parsed) ? parsed : undefined
  }, [value])

  return (
    <label>
      <span>Date</span>
      <div className="date-picker-shell" ref={rootRef}>
        <button
          type="button"
          className="date-trigger"
          aria-label="Date"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {formatDateButtonLabel(value)}
        </button>
        {open && (
          <div className="date-popover" role="dialog" aria-label="Calendar">
            <DayPicker
              mode="single"
              selected={selectedDate}
              onSelect={(date) => {
                if (!date) return
                onChange(format(date, 'yyyy-MM-dd'))
                setOpen(false)
              }}
            />
          </div>
        )}
      </div>
    </label>
  )
}

function App() {
  const [routeShareCode, setRouteShareCode] = useState<string | null>(() => readCurrentShareCode())
  const isLandingRoute = routeShareCode == null

  const [landingError, setLandingError] = useState<string | null>(null)
  const [creatingLedger, setCreatingLedger] = useState(false)

  const [activeLedger, setActiveLedger] = useState<Ledger | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(!isLandingRoute)
  const [ledgerError, setLedgerError] = useState<string | null>(null)

  const [participantNames, setParticipantNames] = useState<ParticipantPair>(DEFAULT_PARTICIPANTS)
  const [defaultOwedPercent, setDefaultOwedPercent] = useState(100)
  const [defaultOwedPercentInput, setDefaultOwedPercentInput] = useState('100')
  const [defaultOwedPercentSaving, setDefaultOwedPercentSaving] = useState(false)
  const [defaultOwedPercentError, setDefaultOwedPercentError] = useState<string | null>(null)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loadingExpenses, setLoadingExpenses] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [summary, setSummary] = useState<LedgerSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const [form, setForm] = useState<ExpenseFormState>(() => makeEmptyForm(DEFAULT_PARTICIPANTS[0]))
  const [formOpen, setFormOpen] = useState(false)
  const [renamingParticipantIndex, setRenamingParticipantIndex] = useState<number | null>(null)
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [submitBusy, setSubmitBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [deletingExpenseId, setDeletingExpenseId] = useState<string | null>(null)

  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [ocrTextPreview, setOcrTextPreview] = useState<string>('')
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)

  const participantOptions = participantNames

  useEffect(() => {
    function syncRoute() {
      setRouteShareCode(readCurrentShareCode())
    }

    window.addEventListener('hashchange', syncRoute)
    window.addEventListener('popstate', syncRoute)

    return () => {
      window.removeEventListener('hashchange', syncRoute)
      window.removeEventListener('popstate', syncRoute)
    }
  }, [])

  useEffect(() => {
    const shareCode = routeShareCode
    if (isLandingRoute || !shareCode) {
      return
    }
    const resolvedShareCode: string = shareCode

    let cancelled = false

    async function loadLedger() {
      if (!isSupabaseConfigured) {
        setLedgerLoading(false)
        setLedgerError(
          'Missing Supabase environment variables. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to connect data storage.',
        )
        return
      }

      setLedgerLoading(true)
      setLedgerError(null)
      setLoadError(null)
      setSummaryError(null)

      try {
        let ledger = await fetchLedgerByShareCode(resolvedShareCode)

        if (!ledger && resolvedShareCode.toLowerCase() === LEGACY_LEDGER_SHARE_CODE) {
          ledger = await ensureLegacyLedger()
        }

        if (!ledger) {
          if (!cancelled) {
            setActiveLedger(null)
            setExpenses([])
            setLedgerError('Ledger link not found.')
          }
          return
        }

        const rows = await fetchExpenses(ledger.id)

        if (!cancelled) {
          setActiveLedger(ledger)
          setParticipantNames(ledger.participants)
          setDefaultOwedPercent(ledger.defaultOwedPercent)
          setDefaultOwedPercentInput(formatPercentInputValue(ledger.defaultOwedPercent))
          setDefaultOwedPercentError(null)
          setForm(makeEmptyForm(ledger.participants[0]))
          setExpenses(rows)
        }
      } catch (error) {
        if (!cancelled) {
          setActiveLedger(null)
          setExpenses([])
          setLedgerError(error instanceof Error ? error.message : 'Failed to load ledger')
        }
      } finally {
        if (!cancelled) {
          setLedgerLoading(false)
        }
      }
    }

    void loadLedger()

    return () => {
      cancelled = true
    }
  }, [isLandingRoute, routeShareCode])

  useEffect(() => {
    setForm((current) => {
      if (participantOptions.includes(current.participant)) {
        return current
      }
      return { ...current, participant: participantOptions[0] }
    })
  }, [participantOptions])

  useEffect(() => {
    if (isLandingRoute) {
      return
    }

    let cancelled = false

    async function buildSummary() {
      setSummaryLoading(true)
      setSummaryError(null)
      try {
        const nextSummary = await computeLedgerSummary(expenses, participantNames)
        if (!cancelled) {
          setSummary(nextSummary)
        }
      } catch (error) {
        if (!cancelled) {
          setSummary(null)
          setSummaryError(
            error instanceof Error
              ? `${error.message}. Check that the currencies in your expenses are supported by the FX service.`
              : 'Failed to calculate totals',
          )
        }
      } finally {
        if (!cancelled) {
          setSummaryLoading(false)
        }
      }
    }

    void buildSummary()

    return () => {
      cancelled = true
    }
  }, [expenses, participantNames, isLandingRoute])

  async function refreshExpenses() {
    if (!isSupabaseConfigured) {
      setLoadError(
        'Missing Supabase environment variables. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to connect data storage.',
      )
      return
    }

    if (!activeLedger) {
      setLoadError('Ledger not loaded yet.')
      return
    }

    setLoadingExpenses(true)
    setLoadError(null)
    try {
      const rows = await fetchExpenses(activeLedger.id)
      setExpenses(rows)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load expenses')
    } finally {
      setLoadingExpenses(false)
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitError(null)

    if (!isSupabaseConfigured) {
      setSubmitError('Configure Supabase before submitting expenses.')
      return
    }

    if (!activeLedger) {
      setSubmitError('Ledger not loaded yet.')
      return
    }

    const amount = Number.parseFloat(form.amount)
    if (!form.description.trim()) {
      setSubmitError('Description is required.')
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setSubmitError('Amount must be a positive number.')
      return
    }
    if (!form.currency.trim()) {
      setSubmitError('Currency is required.')
      return
    }
    if (!form.incurredOn) {
      setSubmitError('Date is required.')
      return
    }

    const owedPercent = parseOwedPercentInput(form.owedPercent)
    if (Number.isNaN(owedPercent)) {
      setSubmitError('Owed share % must be a number between 0 and 100.')
      return
    }

    const payload: ExpenseInsert = {
      ledgerId: activeLedger.id,
      participant: form.participant,
      description: form.description.trim(),
      merchant: form.merchant.trim(),
      amount,
      currency: form.currency.trim().toUpperCase(),
      incurredOn: form.incurredOn,
      owedPercent: owedPercent ?? defaultOwedPercent,
      notes: form.notes.trim(),
    }

    setSubmitBusy(true)
    try {
      if (editingExpenseId) {
        await updateExpense(activeLedger.id, editingExpenseId, payload)
      } else {
        await createExpense(payload)
      }
      setEditingExpenseId(null)
      setForm(makeEmptyForm(form.participant, payload.currency))
      setOcrTextPreview('')
      if (!editingExpenseId) {
        setFormOpen(false)
      }
      await refreshExpenses()
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : editingExpenseId
            ? 'Failed to update expense'
            : 'Failed to save expense',
      )
    } finally {
      setSubmitBusy(false)
    }
  }

  function updateForm<K extends keyof ExpenseFormState>(key: K, value: ExpenseFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleReceiptFile(file: File) {
    setOcrBusy(true)
    setOcrError(null)
    setFormOpen(true)

    try {
      const extracted = await extractExpenseFromImage(file)
      setOcrTextPreview(extracted.rawText)
      setForm((current) => ({
        ...current,
        description: extracted.description ?? current.description,
        merchant: extracted.merchant ?? current.merchant,
        amount: extracted.amount ? String(extracted.amount) : current.amount,
        currency: extracted.currency ?? current.currency,
        incurredOn: extracted.incurredOn ?? current.incurredOn,
        notes:
          extracted.notes ??
          (extracted.rawText
            ? current.notes || `OCR raw text captured from ${file.name}`
            : current.notes),
      }))
    } catch (error) {
      setOcrError(
        error instanceof Error
          ? `${error.message}. You can still enter the expense manually.`
          : 'Receipt extraction failed. You can still enter the expense manually.',
      )
    } finally {
      setOcrBusy(false)
    }
  }

  function openUploadPicker() {
    uploadInputRef.current?.click()
  }

  function openCameraPicker() {
    cameraInputRef.current?.click()
  }

  function beginEditExpense(expense: Expense) {
    setSubmitError(null)
    setOcrError(null)
    setFormOpen(true)
    setEditingExpenseId(expense.id)
    setForm(formStateFromExpense(expense))
    document.querySelector('.form-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function cancelEdit() {
    setEditingExpenseId(null)
    setSubmitError(null)
    setForm(makeEmptyForm(participantOptions[0] ?? DEFAULT_PARTICIPANTS[0], form.currency || 'USD'))
    setFormOpen(false)
  }

  async function handleDeleteExpense(expense: Expense) {
    if (!isSupabaseConfigured) {
      setLoadError('Configure Supabase before deleting expenses.')
      return
    }

    if (!activeLedger) {
      setLoadError('Ledger not loaded yet.')
      return
    }

    const confirmed = window.confirm(`Delete "${expense.description}"?`)
    if (!confirmed) {
      return
    }

    setSubmitError(null)
    setLoadError(null)
    setDeletingExpenseId(expense.id)

    try {
      await deleteExpense(activeLedger.id, expense.id)

      if (editingExpenseId === expense.id) {
        setEditingExpenseId(null)
        setForm(makeEmptyForm(participantOptions[0] ?? DEFAULT_PARTICIPANTS[0], form.currency || 'USD'))
        setFormOpen(false)
      }

      await refreshExpenses()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to delete expense')
    } finally {
      setDeletingExpenseId(null)
    }
  }

  async function finalizeParticipantName(index: number) {
    const next = [...participantNames] as ParticipantPair
    next[index] = next[index].trim() || DEFAULT_PARTICIPANTS[index]
    setParticipantNames(next)
    setRenamingParticipantIndex(null)

    if (!activeLedger) {
      return
    }

    try {
      const updated = await updateLedgerParticipants(activeLedger.id, next)
      setActiveLedger(updated)
      setParticipantNames(updated.participants)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to update participant names')
    }
  }

  async function handleSaveDefaultOwedPercent() {
    setDefaultOwedPercentError(null)

    if (!isSupabaseConfigured) {
      setDefaultOwedPercentError('Configure Supabase before updating the default ownership split.')
      return
    }

    if (!activeLedger) {
      setDefaultOwedPercentError('Ledger not loaded yet.')
      return
    }

    const parsed = parseOwedPercentInput(defaultOwedPercentInput)
    if (parsed == null || Number.isNaN(parsed)) {
      setDefaultOwedPercentError('Default ownership split must be a number between 0 and 100.')
      return
    }

    const previousDefaultOwedPercent = defaultOwedPercent
    setDefaultOwedPercent(parsed)
    setDefaultOwedPercentSaving(true)
    try {
      const updated = await updateLedgerDefaultOwedPercent(activeLedger.id, parsed)
      setActiveLedger(updated)
      setDefaultOwedPercent(updated.defaultOwedPercent)
      setDefaultOwedPercentInput(formatPercentInputValue(updated.defaultOwedPercent))
    } catch (error) {
      setDefaultOwedPercent(previousDefaultOwedPercent)
      setDefaultOwedPercentError(
        error instanceof Error ? error.message : 'Failed to update the default ownership split',
      )
    } finally {
      setDefaultOwedPercentSaving(false)
    }
  }

  async function handleGenerateLink() {
    setLandingError(null)

    if (!isSupabaseConfigured) {
      setLandingError('Configure Supabase before generating links.')
      return
    }

    setCreatingLedger(true)
    try {
      const ledger = await createLedger(DEFAULT_PARTICIPANTS)
      window.location.assign(appLedgerPath(ledger.shareCode))
    } catch (error) {
      setLandingError(error instanceof Error ? error.message : 'Failed to generate link')
    } finally {
      setCreatingLedger(false)
    }
  }

  const groupedExpenses = useMemo(() => {
    const groups: Record<string, Expense[]> = Object.fromEntries(participantOptions.map((name) => [name, []]))
    const unmapped: Expense[] = []

    for (const expense of expenses) {
      if (groups[expense.participant]) {
        groups[expense.participant].push(expense)
      } else {
        unmapped.push(expense)
      }
    }

    return { groups, unmapped }
  }, [expenses, participantOptions])

  const convertedById = useMemo(() => {
    const entries: Array<[string, ConvertedExpense]> =
      summary?.convertedExpenses.map((expense) => [expense.id, expense]) ?? []
    return new Map<string, ConvertedExpense>(entries)
  }, [summary])

  const editingExpense = useMemo(
    () => (editingExpenseId ? expenses.find((expense) => expense.id === editingExpenseId) ?? null : null),
    [editingExpenseId, expenses],
  )

  if (isLandingRoute) {
    return (
      <div className="app-shell">
        <main className="ledger-app">
          <header className="hero-card panel">
            <div>
              <p className="eyebrow">Ledger</p>
              <h1>Shared Ledger Links</h1>
              <p className="muted">Generate a dedicated ledger URL for any two-party expense tracking.</p>
            </div>
          </header>

          <section className="panel landing-panel">
            <div className="section-head">
              <h2>Create New Shared Ledger</h2>
              <p className="muted tiny">Each generated link gets its own isolated expenses and participant names.</p>
            </div>
            <div className="landing-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleGenerateLink()}
                disabled={creatingLedger || !isSupabaseConfigured}
              >
                {creatingLedger ? 'Generating…' : 'Generate Link'}
              </button>
            </div>
            {landingError && <p className="status-line error">{landingError}</p>}
          </section>

          {!isSupabaseConfigured && (
            <section className="panel setup-panel">
              <h2>Supabase setup required</h2>
              <p className="muted">
                Add your Supabase project URL and publishable key to <code>.env</code>, then create the{' '}
                <code>expenses</code> and <code>ledgers</code> tables using the SQL in <code>supabase/schema.sql</code>.
              </p>
            </section>
          )}
        </main>
      </div>
    )
  }

  if (ledgerLoading && !activeLedger) {
    return (
      <div className="app-shell">
        <main className="ledger-app">
          <section className="panel landing-panel">
            <h2>Loading ledger…</h2>
            <p className="status-line">Fetching ledger link and expenses.</p>
          </section>
        </main>
      </div>
    )
  }

  if (!activeLedger) {
    return (
      <div className="app-shell">
        <main className="ledger-app">
          <section className="panel landing-panel">
            <h2>Ledger unavailable</h2>
            <p className="status-line error">{ledgerError ?? 'Could not load this ledger link.'}</p>
            <a className="secondary-button inline-link-button" href={appHomePath()}>
              Back to links
            </a>
          </section>
        </main>
      </div>
    )
  }

  const ledgerTitle = `${participantOptions[0]} and ${participantOptions[1]} Ledger`
  const activeLedgerUrl = appLedgerUrl(activeLedger.shareCode)

  return (
    <div className="app-shell">
      <main className="ledger-app">
        <header className="hero-card panel">
          <div>
            <p className="eyebrow">Ledger</p>
            <h1>{ledgerTitle}</h1>
            <p className="muted tiny">Share link: {activeLedgerUrl}</p>
          </div>
          <div className="hero-actions">
            <a className="secondary-button inline-link-button" href={appHomePath()}>
              Links
            </a>
            <button type="button" className="secondary-button" onClick={() => void refreshExpenses()}>
              Refresh
            </button>
          </div>
        </header>

        <section className="panel summary-panel">
          <div className="default-split-bar">
            <div className="section-head">
              <h2>Default Ownership Split</h2>
              <p className="muted tiny">Used for new expenses when “Owed share %” is left blank.</p>
            </div>
            <div className="default-split-controls">
              <label>
                <span>Default ownership split %</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={defaultOwedPercentInput}
                  onChange={(event) => setDefaultOwedPercentInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void handleSaveDefaultOwedPercent()
                    }
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleSaveDefaultOwedPercent()}
                disabled={defaultOwedPercentSaving}
              >
                {defaultOwedPercentSaving ? 'Saving…' : 'Save Default'}
              </button>
            </div>
            {defaultOwedPercentError && <p className="status-line error">{defaultOwedPercentError}</p>}
          </div>

          <div className="settlement-spotlight">
            <span className="stat-label">Settlement</span>
            <strong className="spotlight-amount">
              {summary?.settlement
                ? formatCurrency(summary.settlement.amount, summary.commonCurrency)
                : summary
                  ? formatCurrency(0, summary.commonCurrency)
                  : formatCurrency(0, 'USD')}
            </strong>
            <span className="spotlight-direction">
              {summary?.settlement ? `${summary.settlement.debtor} -> ${summary.settlement.creditor}` : 'Settled'}
            </span>
          </div>

          {(loadingExpenses || summaryLoading) && <p className="status-line">Calculating totals…</p>}
          {ledgerError && <p className="status-line error">{ledgerError}</p>}
          {loadError && <p className="status-line error">{loadError}</p>}
          {summaryError && <p className="status-line error">{summaryError}</p>}
        </section>

        <section className={`panel form-panel ${formOpen || editingExpense ? 'open' : 'collapsed'}`}>
          <div className="section-head">
            <h2>{editingExpense ? 'Edit Expense' : 'Add Expense'}</h2>
            <p className="muted tiny">{editingExpense ? editingExpense.description : 'Manual entry or receipt photo.'}</p>
          </div>
          {!editingExpense && (
            <button type="button" className="secondary-button" onClick={() => setFormOpen((current) => !current)}>
              {formOpen ? 'Hide' : 'Add Expense'}
            </button>
          )}

          {(formOpen || editingExpense) && (
            <>
              <div className="receipt-actions">
                <button type="button" className="secondary-button" onClick={openUploadPicker} disabled={ocrBusy}>
                  {ocrBusy ? 'Reading…' : 'Upload'}
                </button>
                <button type="button" className="secondary-button" onClick={openCameraPicker} disabled={ocrBusy}>
                  Take Photo
                </button>
                <input
                  ref={uploadInputRef}
                  className="hidden-file-input"
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) {
                      void handleReceiptFile(file)
                    }
                    event.currentTarget.value = ''
                  }}
                />
                <input
                  ref={cameraInputRef}
                  className="hidden-file-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) {
                      void handleReceiptFile(file)
                    }
                    event.currentTarget.value = ''
                  }}
                />
                {ocrError && <p className="status-line error inline">{ocrError}</p>}
              </div>

              <form className="expense-form" onSubmit={handleSubmit}>
                <label>
                  <span>Participant</span>
                  <select value={form.participant} onChange={(e) => updateForm('participant', e.target.value)}>
                    {participantOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Description</span>
                  <input
                    type="text"
                    value={form.description}
                    onChange={(e) => updateForm('description', e.target.value)}
                    placeholder="Dinner, hotel, rideshare..."
                    required
                  />
                </label>

                <label>
                  <span>Merchant (optional)</span>
                  <input
                    type="text"
                    value={form.merchant}
                    onChange={(e) => updateForm('merchant', e.target.value)}
                    placeholder="Merchant name"
                  />
                </label>

                <div className="form-row">
                  <label>
                    <span>Amount</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={form.amount}
                      onChange={(e) => updateForm('amount', e.target.value)}
                      placeholder="0.00"
                      required
                    />
                  </label>
                  <label>
                    <span>Currency</span>
                    <input
                      type="text"
                      value={form.currency}
                      onChange={(e) => updateForm('currency', e.target.value.toUpperCase())}
                      placeholder="USD"
                      maxLength={3}
                      required
                    />
                  </label>
                  <DatePickerField value={form.incurredOn} onChange={(value) => updateForm('incurredOn', value)} />
                  <label>
                    <span>Owed share %</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={form.owedPercent}
                      onChange={(e) => updateForm('owedPercent', e.target.value)}
                      placeholder={formatPercentInputValue(defaultOwedPercent)}
                    />
                  </label>
                </div>
                <p className="muted tiny percent-help">
                  Custom split (Splitwise-style). Blank uses the ledger default: {formatPercentChip(defaultOwedPercent)}.
                </p>

                <label>
                  <span>Notes (optional)</span>
                  <textarea
                    value={form.notes}
                    onChange={(e) => updateForm('notes', e.target.value)}
                    rows={3}
                    placeholder="Context, split assumptions, trip info..."
                  />
                </label>

                <div className="form-actions">
                  <button type="submit" className="primary-button" disabled={submitBusy}>
                    {submitBusy ? 'Saving…' : editingExpense ? 'Update Expense' : 'Save Expense'}
                  </button>
                  {editingExpense && (
                    <button type="button" className="secondary-button" onClick={cancelEdit} disabled={submitBusy}>
                      Cancel Edit
                    </button>
                  )}
                  {submitError && <p className="status-line error inline">{submitError}</p>}
                </div>
              </form>

              {ocrTextPreview && (
                <details className="ocr-preview">
                  <summary>OCR text</summary>
                  <pre>{ocrTextPreview}</pre>
                </details>
              )}
            </>
          )}
        </section>

        {!isSupabaseConfigured && (
          <section className="panel setup-panel">
            <h2>Supabase setup required</h2>
            <p className="muted">
              Add your Supabase project URL and publishable key to <code>.env</code>, then create the{' '}
              <code>expenses</code> and <code>ledgers</code> tables using the SQL in <code>supabase/schema.sql</code>.
            </p>
          </section>
        )}

        <section className="ledger-columns">
          {participantOptions.map((participant, participantIndex) => {
            const participantExpenses = groupedExpenses.groups[participant] ?? []
            const participantTotal = summary?.participantTotals[participant] ?? 0
            const commonCurrency = summary?.commonCurrency ?? 'USD'

            return (
              <section key={participant} className="panel ledger-column">
                <div className="column-head">
                  <div className="column-title-group">
                    {renamingParticipantIndex === participantIndex ? (
                      <input
                        className="inline-name-input header"
                        type="text"
                        autoFocus
                        value={participantNames[participantIndex]}
                        onChange={(event) => {
                          const next = [...participantNames] as ParticipantPair
                          next[participantIndex] = event.target.value
                          setParticipantNames(next)
                        }}
                        onBlur={() => void finalizeParticipantName(participantIndex)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void finalizeParticipantName(participantIndex)
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setRenamingParticipantIndex(null)
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="participant-name-tile"
                        onClick={() => setRenamingParticipantIndex(participantIndex)}
                        aria-label={`Rename ${participant}`}
                      >
                        {participant}
                      </button>
                    )}
                    <p className="muted tiny">{participantExpenses.length} items</p>
                  </div>
                  <strong>{formatCurrency(participantTotal, commonCurrency)}</strong>
                </div>

                {participantExpenses.length === 0 ? (
                  <p className="empty-state">No expenses yet.</p>
                ) : (
                  <ul className="expense-list">
                    {participantExpenses.map((expense) => {
                      const converted = convertedById.get(expense.id)
                      const owedPercent = effectiveOwedPercent(expense.owedPercent)
                      return (
                        <li key={expense.id} className="expense-item">
                          <div className="expense-main">
                            <div>
                              <p className="expense-title">
                                {expense.description}
                                <span className="expense-kind" style={percentChipStyle(owedPercent)}>
                                  {formatPercentChip(owedPercent)}
                                </span>
                              </p>
                              <p className="expense-meta">
                                {formatExpenseDate(expense.incurredOn)}
                                {expense.merchant ? ` · ${expense.merchant}` : ''}
                              </p>
                            </div>
                            <div className="expense-amounts">
                              <strong>{formatCurrency(expense.amount, expense.currency)}</strong>
                              {converted && expense.currency !== converted.convertedCurrency && (
                                <span>{formatCurrency(converted.convertedAmount, converted.convertedCurrency)}</span>
                              )}
                              <div className="row-actions">
                                <button type="button" className="mini-button" onClick={() => beginEditExpense(expense)}>
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="mini-button danger"
                                  disabled={deletingExpenseId === expense.id}
                                  onClick={() => void handleDeleteExpense(expense)}
                                >
                                  {deletingExpenseId === expense.id ? 'Deleting…' : 'Delete'}
                                </button>
                              </div>
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })}
        </section>

        {groupedExpenses.unmapped.length > 0 && (
          <section className="panel unmapped-panel">
            <h2>Unmapped Expenses</h2>
            <p className="muted tiny">
              These rows use participant names that do not match the current labels. Rename participants above or update
              the data in Supabase.
            </p>
            <ul className="expense-list compact">
              {groupedExpenses.unmapped.map((expense) => (
                <li key={expense.id} className="expense-item">
                  <div className="expense-main">
                    <div>
                      <p className="expense-title">{expense.description}</p>
                      <p className="expense-meta">
                        {expense.participant} · {formatExpenseDate(expense.incurredOn)}
                      </p>
                    </div>
                    <div className="expense-amounts">
                      <strong>{formatCurrency(expense.amount, expense.currency)}</strong>
                      <div className="row-actions">
                        <button type="button" className="mini-button" onClick={() => beginEditExpense(expense)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="mini-button danger"
                          disabled={deletingExpenseId === expense.id}
                          onClick={() => void handleDeleteExpense(expense)}
                        >
                          {deletingExpenseId === expense.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
