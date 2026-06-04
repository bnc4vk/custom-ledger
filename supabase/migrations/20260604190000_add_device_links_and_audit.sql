alter table public.ledgers
add column if not exists created_by_device_id text;

alter table public.ledgers
add column if not exists updated_at timestamptz;

update public.ledgers
set updated_at = created_at
where updated_at is null;

alter table public.ledgers
alter column updated_at set default now();

alter table public.ledgers
alter column updated_at set not null;

create index if not exists ledgers_created_by_device_id_idx on public.ledgers (created_by_device_id);

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

alter table public.ledger_audit_events enable row level security;

drop policy if exists "Allow read audit events" on public.ledger_audit_events;
create policy "Allow read audit events" on public.ledger_audit_events
for select using (true);

drop policy if exists "Allow insert audit events" on public.ledger_audit_events;
create policy "Allow insert audit events" on public.ledger_audit_events
for insert with check (true);
