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
