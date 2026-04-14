export type ParticipantPair = [string, string]

export interface LedgerRow {
  id: string
  share_code: string
  participant_a: string
  participant_b: string
  default_owed_percent?: number | string | null
  created_at: string
}

export interface Ledger {
  id: string
  shareCode: string
  participants: ParticipantPair
  defaultOwedPercent: number
  createdAt: string
}

export interface ExpenseRow {
  id: string
  ledger_id: string
  participant: string
  description: string
  amount: number | string
  currency: string
  incurred_on: string
  owed_percent?: number | string | null
  is_shared?: boolean | null
  merchant: string | null
  notes: string | null
  created_at: string
}

export interface Expense {
  id: string
  ledgerId: string
  participant: string
  description: string
  amount: number
  currency: string
  incurredOn: string
  owedPercent: number
  merchant?: string | null
  notes?: string | null
  createdAt: string
}

export interface ExpenseInsert {
  ledgerId: string
  participant: string
  description: string
  amount: number
  currency: string
  incurredOn: string
  owedPercent?: number | null
  merchant?: string
  notes?: string
}

export interface ExpenseFormState {
  participant: string
  description: string
  merchant: string
  amount: string
  currency: string
  incurredOn: string
  owedPercent: string
  notes: string
}

export interface ReceiptExtraction {
  rawText: string
  description?: string
  merchant?: string
  amount?: number
  currency?: string
  incurredOn?: string
  notes?: string
  confidence?: number
}

export interface ConvertedExpense extends Expense {
  convertedAmount: number
  convertedCurrency: string
  fxRate: number
}

export interface ParticipantContributionSnapshot {
  paid: number
  effectiveContribution: number
  effectiveRate: number
}

export interface SettlementSummary {
  debtor: string
  creditor: string
  amount: number
}

export interface MonthlyLedgerSummary {
  month: string
  totalSpend: number
  participantSnapshots: Record<string, ParticipantContributionSnapshot>
  settlement: SettlementSummary | null
}

export interface LedgerSummary {
  commonCurrency: string
  ledgerTotal: number
  sharedLedgerTotal: number
  fairShare: number
  participantTotals: Record<string, number>
  participantContributionSnapshots: Record<string, ParticipantContributionSnapshot>
  sharedParticipantTotals: Record<string, number>
  settlement: SettlementSummary | null
  monthlySummaries: MonthlyLedgerSummary[]
  convertedExpenses: ConvertedExpense[]
  currencyValueWeights: Record<string, number>
}
