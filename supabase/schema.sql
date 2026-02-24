create extension if not exists pgcrypto;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  participant text not null,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null check (char_length(currency) = 3),
  incurred_on date not null,
  owed_percent numeric(5,2) check (owed_percent >= 0 and owed_percent <= 100),
  is_shared boolean not null default true,
  merchant text,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.expenses
add column if not exists is_shared boolean not null default true;

alter table public.expenses
add column if not exists owed_percent numeric(5,2);

alter table public.expenses
drop constraint if exists expenses_owed_percent_check;

alter table public.expenses
add constraint expenses_owed_percent_check
check (owed_percent is null or (owed_percent >= 0 and owed_percent <= 100));

create index if not exists expenses_incurred_on_idx on public.expenses (incurred_on desc);
create index if not exists expenses_participant_idx on public.expenses (participant);

alter table public.expenses enable row level security;

drop policy if exists "Allow read expenses" on public.expenses;
create policy "Allow read expenses" on public.expenses
for select using (true);

drop policy if exists "Allow insert expenses" on public.expenses;
create policy "Allow insert expenses" on public.expenses
for insert with check (true);

drop policy if exists "Allow update expenses" on public.expenses;
create policy "Allow update expenses" on public.expenses
for update using (true) with check (true);

drop policy if exists "Allow delete expenses" on public.expenses;
create policy "Allow delete expenses" on public.expenses
for delete using (true);
