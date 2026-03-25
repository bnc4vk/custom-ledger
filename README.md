# Custom Ledger

A minimal shared-expense ledger web app (React + Vite) with:

- Link-based ledgers (`/custom-ledger/#/<share-code>`) generated on demand
- Dedicated legacy ledger link for existing `Ryan` + `Ben` data (`/custom-ledger/#/ryan-ben`)
- Two participant columns per ledger (editable in the UI)
- Supabase-backed expense storage
- Historical FX conversion by expense date (via Frankfurter)
- Settlement calculation (equal split)
- Mobile-friendly expense entry form
- Receipt image upload / camera capture with free client-side OCR (`tesseract.js`) to prefill fields

## Local setup

1. Install deps:

```bash
npm install
```

2. Create a `.env` file from `.env.example` and fill in your Supabase values:

```bash
cp .env.example .env
```

3. In Supabase SQL editor, run the schema in `supabase/schema.sql`.

If you already created the table before ledger links were added, rerun `supabase/schema.sql`. The migration is idempotent and will:

- create the new `ledgers` table
- add `expenses.ledger_id`
- backfill existing rows into the legacy `ryan-ben` ledger (no expense loss)

4. Start the app:

```bash
npm run dev
```

## Supabase table shape

The app now uses:

1. `ledgers`

- `id` (uuid)
- `share_code` (unique text)
- `participant_a` (text)
- `participant_b` (text)
- `created_at` (timestamp)

2. `expenses`

- `id` (uuid)
- `ledger_id` (uuid, foreign key to `ledgers.id`)
- `participant` (text)
- `description` (text)
- `amount` (numeric)
- `currency` (3-letter ISO code text)
- `incurred_on` (date)
- `is_shared` (boolean, defaults to `true`)
- `merchant` (text, optional)
- `notes` (text, optional)
- `created_at` (timestamp)

## Calculation behavior

- The app chooses a **common display currency** based on the currency bucket with the highest total estimated value (using historical USD conversions per expense date).
- Totals and settlement are then recalculated into that common currency using historical FX rates for each expense date.
- For rows where `is_shared = true`, settlement assumes an **equal split** between the two participants.
- For rows where `is_shared = false`, the payer is treated as having paid **100% on behalf of the other participant** (full reimbursement owed).
- The ledger total still includes all expenses (shared + non-shared).

## Notes / limitations

- Receipt extraction uses free OCR with heuristics (merchant/date/amount/currency parsing). It will not be perfect; review and edit before saving.
- Participant labels are stored per-ledger in Supabase (`ledgers.participant_a` / `participant_b`) and shared across anyone using the same link.
- For production use, tighten Supabase Row Level Security policies.

## One-time corrections for the sample data

If you added the sample entries already, run `supabase/fixes/2026-02-23-expense-corrections.sql` in the Supabase SQL editor to:

- mark only `hai di lao` as shared
- mark the rest as non-shared (full reimbursement / paid on behalf of the other participant)
- change `2cb 2x` from `£10` to `£20`
