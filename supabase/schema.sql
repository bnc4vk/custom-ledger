create extension if not exists pgcrypto;

create table if not exists public.ledgers (
  id uuid primary key default gen_random_uuid(),
  share_code text not null unique check (share_code ~ '^[a-z0-9-]{3,40}$'),
  participant_a text not null default 'Participant A',
  participant_b text not null default 'Participant B',
  default_owed_percent numeric(5,2) not null default 100 check (default_owed_percent >= 0 and default_owed_percent <= 100),
  created_at timestamptz not null default now()
);

insert into public.ledgers (share_code, participant_a, participant_b)
values ('ryan-ben', 'Ryan', 'Ben')
on conflict (share_code) do nothing;

alter table public.ledgers
add column if not exists default_owed_percent numeric(5,2);

update public.ledgers
set default_owed_percent = 100
where default_owed_percent is null;

alter table public.ledgers
alter column default_owed_percent set default 100;

alter table public.ledgers
alter column default_owed_percent set not null;

alter table public.ledgers
drop constraint if exists ledgers_default_owed_percent_check;

alter table public.ledgers
add constraint ledgers_default_owed_percent_check
check (default_owed_percent >= 0 and default_owed_percent <= 100);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid,
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
add column if not exists ledger_id uuid;

update public.expenses
set ledger_id = (
  select id
  from public.ledgers
  where share_code = 'ryan-ben'
)
where ledger_id is null;

alter table public.expenses
alter column ledger_id set not null;

alter table public.expenses
drop constraint if exists expenses_ledger_id_fkey;

alter table public.expenses
add constraint expenses_ledger_id_fkey
foreign key (ledger_id) references public.ledgers(id) on delete cascade;

alter table public.expenses
drop constraint if exists expenses_owed_percent_check;

alter table public.expenses
add constraint expenses_owed_percent_check
check (owed_percent is null or (owed_percent >= 0 and owed_percent <= 100));

create index if not exists ledgers_share_code_idx on public.ledgers (share_code);
create index if not exists expenses_incurred_on_idx on public.expenses (incurred_on desc);
create index if not exists expenses_participant_idx on public.expenses (participant);
create index if not exists expenses_ledger_id_idx on public.expenses (ledger_id);

alter table public.ledgers enable row level security;
alter table public.expenses enable row level security;

drop policy if exists "Allow read ledgers" on public.ledgers;
create policy "Allow read ledgers" on public.ledgers
for select using (true);

drop policy if exists "Allow insert ledgers" on public.ledgers;
create policy "Allow insert ledgers" on public.ledgers
for insert with check (true);

drop policy if exists "Allow update ledgers" on public.ledgers;
create policy "Allow update ledgers" on public.ledgers
for update using (true) with check (true);

drop policy if exists "Allow delete ledgers" on public.ledgers;
create policy "Allow delete ledgers" on public.ledgers
for delete using (true);

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
