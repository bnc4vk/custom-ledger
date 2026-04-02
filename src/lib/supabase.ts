import { createClient } from '@supabase/supabase-js'
import type { Expense, ExpenseInsert, ExpenseRow, Ledger, LedgerRow, ParticipantPair } from '../types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey)

export const LEGACY_LEDGER_SHARE_CODE = 'ryan-ben'
const LEGACY_LEDGER_PARTICIPANTS: ParticipantPair = ['Ryan', 'Ben']

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: false,
      },
    })
  : null

function mapSupabaseErrorMessage(message: string) {
  const normalized = message.toLowerCase()
  if (
    normalized.includes("'is_shared' column") ||
    normalized.includes("'owed_percent' column") ||
    normalized.includes("'default_owed_percent' column") ||
    normalized.includes("'ledger_id' column") ||
    normalized.includes("'share_code' column") ||
    normalized.includes('relation "ledgers" does not exist') ||
    normalized.includes('schema cache')
  ) {
    return 'Database schema is outdated. Rerun supabase/schema.sql in Supabase to add the latest ledger columns, tables, and policies.'
  }

  return message
}

function requireClient() {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to a .env file.',
    )
  }

  return supabase
}

function mapLedger(row: LedgerRow): Ledger {
  const rawDefaultOwedPercent =
    typeof row.default_owed_percent === 'number'
      ? row.default_owed_percent
      : typeof row.default_owed_percent === 'string'
        ? Number.parseFloat(row.default_owed_percent)
        : null

  return {
    id: row.id,
    shareCode: row.share_code,
    participants: [row.participant_a, row.participant_b],
    defaultOwedPercent:
      rawDefaultOwedPercent != null && Number.isFinite(rawDefaultOwedPercent) ? rawDefaultOwedPercent : 100,
    createdAt: row.created_at,
  }
}

function mapExpense(row: ExpenseRow): Expense {
  const rawOwedPercent =
    typeof row.owed_percent === 'number'
      ? row.owed_percent
      : typeof row.owed_percent === 'string'
        ? Number.parseFloat(row.owed_percent)
        : null
  const owedPercent =
    rawOwedPercent != null && Number.isFinite(rawOwedPercent) ? rawOwedPercent : row.is_shared ? 50 : 100

  return {
    id: row.id,
    ledgerId: row.ledger_id,
    participant: row.participant,
    description: row.description,
    amount: typeof row.amount === 'number' ? row.amount : Number.parseFloat(row.amount),
    currency: row.currency,
    incurredOn: row.incurred_on,
    owedPercent,
    merchant: row.merchant,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

function isDuplicateShareCodeError(message: string) {
  const normalized = message.toLowerCase()
  return normalized.includes('duplicate key value') && normalized.includes('ledgers_share_code_key')
}

function normalizeShareCode(shareCode: string) {
  return shareCode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

function generateShareCode() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

export async function fetchLedgerByShareCode(shareCode: string): Promise<Ledger | null> {
  const client = requireClient()
  const normalizedShareCode = normalizeShareCode(shareCode)

  if (!normalizedShareCode) {
    return null
  }

  const { data, error } = await client
    .from('ledgers')
    .select('*')
    .eq('share_code', normalizedShareCode)
    .maybeSingle()

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  if (!data) {
    return null
  }

  return mapLedger(data as LedgerRow)
}

export async function ensureLegacyLedger(): Promise<Ledger> {
  const existing = await fetchLedgerByShareCode(LEGACY_LEDGER_SHARE_CODE)
  if (existing) {
    return existing
  }

  const client = requireClient()
  const payload = {
    share_code: LEGACY_LEDGER_SHARE_CODE,
    participant_a: LEGACY_LEDGER_PARTICIPANTS[0],
    participant_b: LEGACY_LEDGER_PARTICIPANTS[1],
    default_owed_percent: 100,
  }

  const { data, error } = await client.from('ledgers').insert(payload).select('*').single()

  if (error) {
    if (isDuplicateShareCodeError(error.message)) {
      const retry = await fetchLedgerByShareCode(LEGACY_LEDGER_SHARE_CODE)
      if (retry) {
        return retry
      }
    }
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  return mapLedger(data as LedgerRow)
}

export async function createLedger(participants: ParticipantPair): Promise<Ledger> {
  const client = requireClient()
  const normalizedParticipants: ParticipantPair = [
    participants[0].trim() || 'Participant A',
    participants[1].trim() || 'Participant B',
  ]

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const payload = {
      share_code: generateShareCode(),
      participant_a: normalizedParticipants[0],
      participant_b: normalizedParticipants[1],
      default_owed_percent: 100,
    }

    const { data, error } = await client.from('ledgers').insert(payload).select('*').single()

    if (!error) {
      return mapLedger(data as LedgerRow)
    }

    if (isDuplicateShareCodeError(error.message)) {
      continue
    }

    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  throw new Error('Could not generate a unique ledger link. Try again.')
}

export async function updateLedgerParticipants(ledgerId: string, participants: ParticipantPair): Promise<Ledger> {
  const client = requireClient()
  const payload = {
    participant_a: participants[0].trim() || 'Participant A',
    participant_b: participants[1].trim() || 'Participant B',
  }

  const { data, error } = await client
    .from('ledgers')
    .update(payload)
    .eq('id', ledgerId)
    .select('*')
    .single()

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  return mapLedger(data as LedgerRow)
}

export async function updateLedgerDefaultOwedPercent(ledgerId: string, defaultOwedPercent: number): Promise<Ledger> {
  const client = requireClient()

  const { data, error } = await client
    .from('ledgers')
    .update({ default_owed_percent: defaultOwedPercent })
    .eq('id', ledgerId)
    .select('*')
    .single()

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  return mapLedger(data as LedgerRow)
}

export async function fetchExpenses(ledgerId: string): Promise<Expense[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('expenses')
    .select('*')
    .eq('ledger_id', ledgerId)
    .order('incurred_on', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  return (data as ExpenseRow[]).map(mapExpense)
}

export async function createExpense(input: ExpenseInsert): Promise<Expense> {
  const client = requireClient()

  const payload = {
    ledger_id: input.ledgerId,
    participant: input.participant,
    description: input.description.trim(),
    amount: input.amount,
    currency: input.currency.trim().toUpperCase(),
    incurred_on: input.incurredOn,
    owed_percent: input.owedPercent ?? null,
    is_shared: (input.owedPercent ?? 100) === 50,
    merchant: input.merchant?.trim() || null,
    notes: input.notes?.trim() || null,
  }

  const { data, error } = await client.from('expenses').insert(payload).select('*').single()

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  return mapExpense(data as ExpenseRow)
}

export async function updateExpense(ledgerId: string, id: string, input: ExpenseInsert): Promise<Expense> {
  const client = requireClient()

  const payload = {
    participant: input.participant,
    description: input.description.trim(),
    amount: input.amount,
    currency: input.currency.trim().toUpperCase(),
    incurred_on: input.incurredOn,
    owed_percent: input.owedPercent ?? null,
    is_shared: (input.owedPercent ?? 100) === 50,
    merchant: input.merchant?.trim() || null,
    notes: input.notes?.trim() || null,
  }

  const { data, error } = await client
    .from('expenses')
    .update(payload)
    .eq('id', id)
    .eq('ledger_id', ledgerId)
    .select('*')
    .single()

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  return mapExpense(data as ExpenseRow)
}

export async function deleteExpense(ledgerId: string, id: string): Promise<void> {
  const client = requireClient()
  const { error } = await client.from('expenses').delete().eq('id', id).eq('ledger_id', ledgerId)

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }
}
