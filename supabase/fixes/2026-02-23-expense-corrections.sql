-- One-time data corrections for the expenses entered on Feb 23, 2026.
-- Assumes you used the descriptions as entered through the current UI.

-- Ensure only the Hai Di Lao expense is shared (50/50 split).
-- All others are non-shared (treated as 100% paid on behalf of the other participant).
update public.expenses
set is_shared = false
where lower(description) in (
  'edc weekend',
  'edc splitwise',
  'laptop',
  'payment',
  'brighton',
  'heaf',
  '2cb 2x'
);

update public.expenses
set is_shared = true
where lower(description) = 'hai di lao';

-- Correct 2cb amount from £10 to £20.
update public.expenses
set amount = 20.00,
    currency = 'GBP'
where lower(description) = '2cb 2x'
  and participant = 'Ben';
