create extension if not exists pgcrypto;

create table if not exists public.ledgers (
  id uuid primary key default gen_random_uuid(),
  share_code text not null unique check (share_code ~ '^[a-z0-9-]{3,40}$'),
  participant_a text not null default 'Participant A',
  participant_b text not null default 'Participant B',
  default_owed_percent numeric(5,2) not null default 100 check (default_owed_percent >= 0 and default_owed_percent <= 100),
  created_by_device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.ledgers (share_code, participant_a, participant_b)
values ('ryan-ben', 'Ryan', 'Ben')
on conflict (share_code) do nothing;

alter table public.ledgers
add column if not exists default_owed_percent numeric(5,2);

alter table public.ledgers
add column if not exists created_by_device_id text;

alter table public.ledgers
add column if not exists updated_at timestamptz;

update public.ledgers
set default_owed_percent = 100
where default_owed_percent is null;

update public.ledgers
set updated_at = created_at
where updated_at is null;

alter table public.ledgers
alter column default_owed_percent set default 100;

alter table public.ledgers
alter column default_owed_percent set not null;

alter table public.ledgers
alter column updated_at set default now();

alter table public.ledgers
alter column updated_at set not null;

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
create index if not exists ledgers_created_by_device_id_idx on public.ledgers (created_by_device_id);
create index if not exists expenses_incurred_on_idx on public.expenses (incurred_on desc);
create index if not exists expenses_participant_idx on public.expenses (participant);
create index if not exists expenses_ledger_id_idx on public.expenses (ledger_id);

create table if not exists public.ledger_audit_events (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  actor_device_id text,
  event_type text not null check (event_type ~ '^[a-z0-9_]{3,80}$'),
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ledger_audit_events_ledger_id_created_at_idx
on public.ledger_audit_events (ledger_id, created_at desc);

create table if not exists public.device_ledgers (
  device_id text not null,
  ledger_id uuid not null references public.ledgers(id) on delete cascade,
  relationship text not null default 'visited' check (relationship in ('created', 'visited')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (device_id, ledger_id)
);

insert into public.device_ledgers (device_id, ledger_id, relationship, created_at, last_seen_at)
select created_by_device_id, id, 'created', created_at, updated_at
from public.ledgers
where created_by_device_id is not null
on conflict (device_id, ledger_id) do nothing;

create index if not exists device_ledgers_device_id_last_seen_at_idx
on public.device_ledgers (device_id, last_seen_at desc);

alter table public.ledgers enable row level security;
alter table public.expenses enable row level security;
alter table public.ledger_audit_events enable row level security;
alter table public.device_ledgers enable row level security;

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

drop policy if exists "Allow read audit events" on public.ledger_audit_events;
create policy "Allow read audit events" on public.ledger_audit_events
for select using (true);

drop policy if exists "Allow insert audit events" on public.ledger_audit_events;
create policy "Allow insert audit events" on public.ledger_audit_events
for insert with check (true);

drop policy if exists "Allow read device ledgers" on public.device_ledgers;
create policy "Allow read device ledgers" on public.device_ledgers
for select using (true);

drop policy if exists "Allow insert device ledgers" on public.device_ledgers;
create policy "Allow insert device ledgers" on public.device_ledgers
for insert with check (true);

drop policy if exists "Allow update device ledgers" on public.device_ledgers;
create policy "Allow update device ledgers" on public.device_ledgers
for update using (true) with check (true);
