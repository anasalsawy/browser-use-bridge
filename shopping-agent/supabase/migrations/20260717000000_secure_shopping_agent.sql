-- Secure shopping agent schema.
-- Payment credentials, CVVs, passwords, and one-time codes must never be stored here.

create table if not exists public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  budget numeric(12, 2) not null check (budget > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'draft' check (status in ('draft', 'ready', 'running', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  query text not null check (char_length(query) between 2 and 300),
  quantity integer not null default 1 check (quantity between 1 and 25),
  max_unit_price numeric(12, 2) check (max_unit_price > 0),
  preferences jsonb not null default '{}'::jsonb,
  allow_substitutions boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'selected', 'unavailable', 'purchased', 'skipped')),
  selected_product jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopping_list_items_owned_list_fkey
    foreign key (list_id, user_id)
    references public.shopping_lists(id, user_id)
    on delete cascade
);

create table if not exists public.shopping_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  list_id uuid not null,
  merchant_url text not null check (merchant_url ~ '^https://'),
  status text not null default 'queued' check (status in (
    'queued', 'shopping', 'awaiting_approval', 'approved',
    'payment_handoff_required', 'completed', 'failed', 'cancelled'
  )),
  payment_mode text not null check (payment_mode in ('saved_merchant', 'secure_handoff')),
  browserbase_context_id text,
  browserbase_session_id text,
  live_view_url text,
  requested_budget numeric(12, 2) not null check (requested_budget > 0),
  cart_total numeric(12, 2) check (cart_total >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  approved_maximum numeric(12, 2) check (approved_maximum > 0),
  approved_at timestamptz,
  completed_at timestamptz,
  request_payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  constraint shopping_runs_owned_list_fkey
    foreign key (list_id, user_id)
    references public.shopping_lists(id, user_id)
    on delete cascade
);

create table if not exists public.shopping_approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  approved_maximum numeric(12, 2) not null check (approved_maximum > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint shopping_approvals_owned_run_fkey
    foreign key (run_id, user_id)
    references public.shopping_runs(id, user_id)
    on delete cascade
);

create table if not exists public.shopping_events (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 80),
  message text not null check (char_length(message) between 1 and 1000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint shopping_events_owned_run_fkey
    foreign key (run_id, user_id)
    references public.shopping_runs(id, user_id)
    on delete cascade
);

create index if not exists shopping_lists_user_id_idx on public.shopping_lists(user_id);
create index if not exists shopping_list_items_list_id_idx on public.shopping_list_items(list_id);
create index if not exists shopping_runs_user_created_idx on public.shopping_runs(user_id, created_at desc);
create index if not exists shopping_approvals_run_id_idx on public.shopping_approvals(run_id);
create index if not exists shopping_events_run_created_idx on public.shopping_events(run_id, created_at);

alter table public.shopping_lists enable row level security;
alter table public.shopping_list_items enable row level security;
alter table public.shopping_runs enable row level security;
alter table public.shopping_approvals enable row level security;
alter table public.shopping_events enable row level security;

revoke all on public.shopping_lists from anon, authenticated;
revoke all on public.shopping_list_items from anon, authenticated;
revoke all on public.shopping_runs from anon, authenticated;
revoke all on public.shopping_approvals from anon, authenticated;
revoke all on public.shopping_events from anon, authenticated;

grant select, insert, update, delete on public.shopping_lists to authenticated;
grant select, insert, update, delete on public.shopping_list_items to authenticated;
grant select, insert, update on public.shopping_runs to authenticated;
grant select, insert on public.shopping_approvals to authenticated;
grant select, insert on public.shopping_events to authenticated;
grant usage, select on sequence public.shopping_events_id_seq to authenticated;

create policy "shopping_lists_select_own"
  on public.shopping_lists for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "shopping_lists_insert_own"
  on public.shopping_lists for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "shopping_lists_update_own"
  on public.shopping_lists for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "shopping_lists_delete_own"
  on public.shopping_lists for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "shopping_list_items_select_own"
  on public.shopping_list_items for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "shopping_list_items_insert_own"
  on public.shopping_list_items for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "shopping_list_items_update_own"
  on public.shopping_list_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "shopping_list_items_delete_own"
  on public.shopping_list_items for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "shopping_runs_select_own"
  on public.shopping_runs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "shopping_runs_insert_own"
  on public.shopping_runs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "shopping_runs_update_own"
  on public.shopping_runs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "shopping_approvals_select_own"
  on public.shopping_approvals for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "shopping_approvals_insert_own"
  on public.shopping_approvals for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and expires_at > now()
    and expires_at <= now() + interval '15 minutes'
  );

create policy "shopping_events_select_own"
  on public.shopping_events for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "shopping_events_insert_own"
  on public.shopping_events for insert to authenticated
  with check ((select auth.uid()) = user_id);

comment on column public.shopping_runs.request_payload is
  'Non-secret shopping inputs only. Never store payment credentials, passwords, CVVs, or OTPs.';
comment on column public.shopping_runs.result is
  'Non-secret merchant result metadata only. Never store payment credentials, passwords, CVVs, or OTPs.';
