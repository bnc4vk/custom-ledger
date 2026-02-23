import { createClient } from '@supabase/supabase-js'
import type { Expense, ExpenseInsert, ExpenseRow } from '../types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey)

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: false,
      },
    })
  : null

function mapSupabaseErrorMessage(message: string) {
  if (
    message.includes("'is_shared' column") ||
    message.includes("'owed_percent' column") ||
    message.includes('schema cache')
  ) {
    return 'Database schema is outdated. Rerun supabase/schema.sql in Supabase to add the latest ledger columns and update policy.'
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

export async function fetchExpenses(): Promise<Expense[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('expenses')
    .select('*')
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

export async function updateExpense(id: string, input: ExpenseInsert): Promise<Expense> {
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

  const { data, error } = await client.from('expenses').update(payload).eq('id', id).select('*').single()

  if (error) {
    throw new Error(mapSupabaseErrorMessage(error.message))
  }

  return mapExpense(data as ExpenseRow)
}
