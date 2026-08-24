-- Run once in the Supabase SQL editor before using collection-aware SMGo.
-- It is safe on a fresh project and on the original single-collection schema.
-- Untagged historical commands are deliberately quarantined as legacy-facharzt:
-- never relabel numeric element IDs to a different collection.

begin;

create table if not exists public.smgo_daily (
  collection_id text,
  review_date text,
  date text,
  data jsonb
);

create table if not exists public.smgo_queue (
  id text primary key,
  type text,
  payload jsonb,
  applied boolean not null default false,
  collection_id text
);

alter table public.smgo_daily
  add column if not exists collection_id text,
  add column if not exists review_date text,
  add column if not exists date text,
  add column if not exists data jsonb;

update public.smgo_daily
set collection_id = coalesce(collection_id, 'legacy-facharzt'),
    review_date = coalesce(review_date, date)
where collection_id is null or review_date is null;

alter table public.smgo_daily
  alter column collection_id set not null,
  alter column review_date set not null;

do $$
declare existing_pk text;
begin
  select conname into existing_pk
  from pg_constraint
  where conrelid = 'public.smgo_daily'::regclass and contype = 'p';
  if existing_pk is not null then
    execute format('alter table public.smgo_daily drop constraint %I', existing_pk);
  end if;
end $$;

alter table public.smgo_daily
  add constraint smgo_daily_pkey primary key (collection_id, review_date);

alter table public.smgo_queue
  add column if not exists collection_id text,
  add column if not exists applied boolean not null default false,
  add column if not exists payload jsonb,
  add column if not exists type text;

update public.smgo_queue
set collection_id = 'legacy-facharzt'
where collection_id is null;

alter table public.smgo_queue alter column collection_id set not null;

create index if not exists smgo_queue_collection_pending_idx
  on public.smgo_queue (collection_id, applied, id);

-- Future startup calls from export-cloud.js must also create the collection
-- aware shape on an empty project. Existing projects remain untouched.
create or replace function public.smgo_setup()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  create table if not exists public.smgo_daily (
    collection_id text not null,
    review_date text not null,
    date text,
    data jsonb,
    primary key (collection_id, review_date)
  );
  create table if not exists public.smgo_queue (
    id text primary key,
    type text,
    payload jsonb,
    applied boolean not null default false,
    collection_id text not null
  );
  create index if not exists smgo_queue_collection_pending_idx
    on public.smgo_queue (collection_id, applied, id);
end;
$$;

revoke all on function public.smgo_setup() from public;
grant execute on function public.smgo_setup() to anon, authenticated;

commit;
