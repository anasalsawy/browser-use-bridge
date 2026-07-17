-- Cover ownership foreign keys used by the secure shopping agent.

create index if not exists shopping_list_items_list_user_idx
  on public.shopping_list_items(list_id, user_id);
create index if not exists shopping_list_items_user_id_idx
  on public.shopping_list_items(user_id);

create index if not exists shopping_runs_list_user_idx
  on public.shopping_runs(list_id, user_id);

create index if not exists shopping_approvals_run_user_idx
  on public.shopping_approvals(run_id, user_id);
create index if not exists shopping_approvals_user_id_idx
  on public.shopping_approvals(user_id);

create index if not exists shopping_events_run_user_idx
  on public.shopping_events(run_id, user_id);
create index if not exists shopping_events_user_id_idx
  on public.shopping_events(user_id);
