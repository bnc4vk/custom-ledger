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

alter table public.device_ledgers enable row level security;

drop policy if exists "Allow read device ledgers" on public.device_ledgers;
create policy "Allow read device ledgers" on public.device_ledgers
for select using (true);

drop policy if exists "Allow insert device ledgers" on public.device_ledgers;
create policy "Allow insert device ledgers" on public.device_ledgers
for insert with check (true);

drop policy if exists "Allow update device ledgers" on public.device_ledgers;
create policy "Allow update device ledgers" on public.device_ledgers
for update using (true) with check (true);
