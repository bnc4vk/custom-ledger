import { format, isValid, parseISO } from 'date-fns'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DayPicker } from 'react-day-picker'
import './App.css'
import { computeLedgerSummary } from './lib/fx'
import { extractExpenseFromImage } from './lib/receipt'
import { createExpense, deleteExpense, fetchExpenses, isSupabaseConfigured, updateExpense } from './lib/supabase'
import type {
  ConvertedExpense,
  Expense,
  ExpenseFormState,
  ExpenseInsert,
  LedgerSummary,
  ParticipantPair,
} from './types'

const DEFAULT_PARTICIPANTS: ParticipantPair = ['Ryan', 'Ben']
const PARTICIPANT_STORAGE_KEY = 'custom-ledger:participants'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
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

function readParticipantNames(): ParticipantPair {
  const raw = localStorage.getItem(PARTICIPANT_STORAGE_KEY)
  if (!raw) return DEFAULT_PARTICIPANTS

  try {
    const parsed = JSON.parse(raw) as string[]
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((item) => typeof item === 'string')) {
      const first = parsed[0].trim() || DEFAULT_PARTICIPANTS[0]
      const second = parsed[1].trim() || DEFAULT_PARTICIPANTS[1]
      return [first, second]
    }
  } catch {
    // Fall back to defaults.
  }

  return DEFAULT_PARTICIPANTS
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
                onChange(date.toISOString().slice(0, 10))
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
  const [participantNames, setParticipantNames] = useState<ParticipantPair>(() => readParticipantNames())
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loadingExpenses, setLoadingExpenses] = useState(true)
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
    localStorage.setItem(PARTICIPANT_STORAGE_KEY, JSON.stringify(participantNames))
  }, [participantNames])

  useEffect(() => {
    setForm((current) => {
      if (participantOptions.includes(current.participant)) {
        return current
      }
      return { ...current, participant: participantOptions[0] }
    })
  }, [participantOptions])

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!isSupabaseConfigured) {
        setLoadingExpenses(false)
        setLoadError(
          'Missing Supabase environment variables. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to connect data storage.',
        )
        return
      }

      setLoadingExpenses(true)
      setLoadError(null)

      try {
        const rows = await fetchExpenses()
        if (!cancelled) {
          setExpenses(rows)
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load expenses')
        }
      } finally {
        if (!cancelled) {
          setLoadingExpenses(false)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
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
  }, [expenses, participantNames])

  async function refreshExpenses() {
    if (!isSupabaseConfigured) {
      setLoadError(
        'Missing Supabase environment variables. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to connect data storage.',
      )
      return
    }

    setLoadingExpenses(true)
    setLoadError(null)
    try {
      const rows = await fetchExpenses()
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
      setSubmitError('On behalf % must be a number between 0 and 100.')
      return
    }

    const payload: ExpenseInsert = {
      participant: form.participant,
      description: form.description.trim(),
      merchant: form.merchant.trim(),
      amount,
      currency: form.currency.trim().toUpperCase(),
      incurredOn: form.incurredOn,
      owedPercent,
      notes: form.notes.trim(),
    }

    setSubmitBusy(true)
    try {
      if (editingExpenseId) {
        await updateExpense(editingExpenseId, payload)
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

    const confirmed = window.confirm(`Delete "${expense.description}"?`)
    if (!confirmed) {
      return
    }

    setSubmitError(null)
    setLoadError(null)
    setDeletingExpenseId(expense.id)

    try {
      await deleteExpense(expense.id)

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

  function finalizeParticipantName(index: number) {
    setParticipantNames((current) => {
      const next = [...current] as ParticipantPair
      next[index] = next[index].trim() || DEFAULT_PARTICIPANTS[index]
      return next
    })
    setRenamingParticipantIndex(null)
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

  return (
    <div className="app-shell">
      <main className="ledger-app">
        <header className="hero-card panel">
          <div>
            <p className="eyebrow">Ledger</p>
            <h1>Ryan and Ben Ledger</h1>
          </div>
          <div className="hero-actions">
            <button type="button" className="secondary-button" onClick={() => void refreshExpenses()}>
              Refresh
            </button>
          </div>
        </header>

        <section className="panel summary-panel">
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
          {loadError && <p className="status-line error">{loadError}</p>}
          {summaryError && <p className="status-line error">{summaryError}</p>}
        </section>

        <section className={`panel form-panel ${formOpen || editingExpense ? 'open' : 'collapsed'}`}>
          <div className="section-head">
            <h2>{editingExpense ? 'Edit Expense' : 'Add Expense'}</h2>
            <p className="muted tiny">
              {editingExpense
                ? editingExpense.description
                : 'Manual entry or receipt photo.'}
            </p>
          </div>
          {!editingExpense && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setFormOpen((current) => !current)}
            >
              {formOpen ? 'Hide' : 'Add Expense'}
            </button>
          )}

          {(formOpen || editingExpense) && (
            <>
              <div className="receipt-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={openUploadPicker}
                  disabled={ocrBusy}
                >
                  {ocrBusy ? 'Reading…' : 'Upload'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={openCameraPicker}
                  disabled={ocrBusy}
                >
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
                  placeholder="100"
                />
              </label>
            </div>
            <p className="muted tiny percent-help">Custom split (Splitwise-style). Blank = 100%.</p>

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
              <code>expenses</code>{' '}
              table using the SQL in <code>supabase/schema.sql</code>.
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
                        onBlur={() => finalizeParticipantName(participantIndex)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            finalizeParticipantName(participantIndex)
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
                                <span>
                                  {formatCurrency(converted.convertedAmount, converted.convertedCurrency)}
                                </span>
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
