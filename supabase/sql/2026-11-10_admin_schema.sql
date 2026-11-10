-- Admin lives in its own "admin" section (schema), walled off from the contractor / crew platform.
-- Admin-only tables and admin tools move out of "public". Everything else stays where it is.

create schema if not exists admin;
revoke all on schema admin from public, anon;
grant usage on schema admin to authenticated, service_role;

-- 1. Admin-only tables
alter table public.admins         set schema admin;   -- who is a Sparrow admin
alter table public.audit_log      set schema admin;   -- history of changes
alter table public.settings       set schema admin;   -- platform settings and keys
alter table public.ops_kv         set schema admin;   -- deploy / ops values
alter table public.mail_log       set schema admin;   -- emails sent
alter table public.tool_calls     set schema admin;   -- Preet tool log
alter table public.webhook_events set schema admin;
alter table public.interac_inbox  set schema admin;

do $$ declare t text; begin
  foreach t in array array['admins','audit_log','settings','ops_kv','mail_log','tool_calls','webhook_events','interac_inbox'] loop
    execute format('revoke all on admin.%I from anon', t);
  end loop;
end $$;

-- 2. Admin tools (each already checks is_admin())
alter function public.admin_assign_contractor        set schema admin;
alter function public.admin_contractor_link          set schema admin;
alter function public.admin_invite_contractor        set schema admin;
alter function public.admin_review_document          set schema admin;
alter function public.admin_save_settings            set schema admin;
alter function public.admin_set_contractor_in_house  set schema admin;
alter function public.admin_set_contractor_status    set schema admin;

-- 3. Every function can still find the moved tables
do $$ declare r record; begin
  for r in select p.oid::regprocedure f, substr(c, 13) sp
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(p.proconfig) c
           where n.nspname in ('public','admin') and c like 'search_path=%' and c not like '%admin%'
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('alter function %s set search_path = %s, admin', r.f, r.sp);
  end loop;
end $$;

-- 4. One login = one role. An admin login can't be a business owner or crew member, and the other way round.
create or replace function admin.guard_admin_login() returns trigger
language plpgsql security definer set search_path = public, admin as $$
begin
  if exists (select 1 from public.contractors where user_id = new.user_id)
     or exists (select 1 from public.team_members where user_id = new.user_id) then
    raise exception 'This login is used in Sparrow Pros. Admins need their own email.';
  end if;
  return new;
end $$;
create trigger admins_one_role before insert or update of user_id on admin.admins
  for each row execute function admin.guard_admin_login();

create or replace function public.guard_not_admin_login() returns trigger
language plpgsql security definer set search_path = public, admin as $$
begin
  if new.user_id is not null and exists (select 1 from admin.admins where user_id = new.user_id) then
    raise exception 'This login belongs to a Sparrow admin. Use a different email.';
  end if;
  return new;
end $$;
create trigger contractors_not_admin before insert or update of user_id on public.contractors
  for each row execute function public.guard_not_admin_login();
create trigger team_members_not_admin before insert or update of user_id on public.team_members
  for each row execute function public.guard_not_admin_login();
revoke all on function admin.guard_admin_login() from public, anon, authenticated;
revoke all on function public.guard_not_admin_login() from public, anon, authenticated;

-- 5. Small tidy-up: the balances view is never needed signed-out
revoke all on public.contractor_balances from anon;

-- 6. Let the website API see the admin section
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, admin';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
