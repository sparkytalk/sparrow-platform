-- Crew assistant on the Sparrow Platform
create table if not exists assistant_sessions (
  token uuid primary key default gen_random_uuid(),
  member_id uuid not null references team_members(id),
  contractor_id uuid not null references contractors(id),
  lat double precision, lng double precision,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 hours'
);
create table if not exists assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references team_members(id),
  contractor_id uuid not null references contractors(id),
  el_conversation_id text not null unique,
  started_at timestamptz not null default now(),
  summary text, summarized_at timestamptz
);
create table if not exists assistant_messages (
  id bigserial primary key,
  conversation_id uuid not null references assistant_conversations(id),
  member_id uuid not null references team_members(id),
  role text not null check (role in ('user','agent')),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists assistant_conv_member on assistant_conversations (member_id, started_at desc);
create index if not exists assistant_msg_conv on assistant_messages (conversation_id, created_at);
alter table assistant_sessions enable row level security;
alter table assistant_conversations enable row level security;
alter table assistant_messages enable row level security;
create policy admin_all on assistant_conversations for select using (is_admin());
create policy admin_all on assistant_messages for select using (is_admin());

create or replace function van_time(ts timestamptz) returns text language sql immutable as $$
  select ltrim(to_char(ts at time zone 'America/Vancouver', 'HH12:MI AM'), '0') $$;
create or replace function van_day(ts timestamptz) returns text language sql immutable as $$
  select to_char(ts at time zone 'America/Vancouver', 'Dy Mon FMDD') $$;

create or replace function assistant_job_label(p_job uuid) returns text language sql stable security definer set search_path = public as $$
  select s.name || coalesce(' at ' || nullif(p.address_line, ''), '') from jobs j join services s on s.code = j.service_code
    left join properties p on p.id = j.property_id where j.id = p_job $$;

-- Find one of this crew member's jobs from a spoken hint (service, address, street, city, customer, ref)
create or replace function assistant_find_job(p_member uuid, p_hint text) returns uuid language sql stable security definer set search_path = public as $$
  with mine as (
    select j.* from jobs j where j.status in ('booked','offered','assigned','in_progress')
      and (exists (select 1 from job_crew jc where jc.job_id = j.id and jc.member_id = p_member and jc.removed_at is null)
        or exists (select 1 from shifts sh where sh.job_id = j.id and sh.member_id = p_member and sh.removed_at is null))
  ), h as (select '%' || replace(replace(lower(trim(coalesce(p_hint, ''))), '%', ''), '_', '') || '%' as q)
  select m.id from mine m join services s on s.code = m.service_code left join properties p on p.id = m.property_id
    left join customers cu on cu.id = m.customer_id, h
  where trim(coalesce(p_hint, '')) <> '' and (lower(s.name) like h.q or lower(coalesce(p.address_line, '')) like h.q or lower(coalesce(p.city, '')) like h.q
     or lower(coalesce(cu.name, '')) like h.q or lower(m.ref) like h.q)
  order by (m.status = 'in_progress') desc, abs(coalesce(job_day(m), bc_day(now())) - bc_day(now())) limit 1 $$;

-- Called by the crew app (through the crew-assistant edge function) when the chat opens
create or replace function assistant_start(p_lat double precision default null, p_lng double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mid uuid := current_member_id(); m team_members; k contractors; tok uuid; today date := bc_day(now()); oe record; jobs_txt text; alerts_txt text;
begin
  if mid is null then raise exception 'not on an active crew'; end if;
  select * into m from team_members where id = mid;
  select * into k from contractors where id = m.contractor_id;
  insert into assistant_sessions (member_id, contractor_id, lat, lng) values (mid, m.contractor_id, p_lat, p_lng) returning token into tok;
  select t.clock_in_at, t.job_id into oe from time_entries t where t.member_id = mid and t.clock_out_at is null and t.removed_at is null limit 1;
  select string_agg(x.t, '; ' order by x.o) into jobs_txt from (
    select coalesce(assistant_job_label(sh.job_id), 'Shift') || ' (' || van_time(sh.starts_at) || '-' || van_time(sh.ends_at) || ')' t, sh.starts_at o
      from shifts sh where sh.member_id = mid and sh.removed_at is null and bc_day(sh.starts_at) = today
    union all
    select assistant_job_label(j.id) || coalesce(' (' || nullif(j.details->>'preferred_time', '') || ')', ''), coalesce(j.scheduled_start, now())
      from jobs j join job_crew jc on jc.job_id = j.id and jc.member_id = mid and jc.removed_at is null
     where j.status in ('booked','offered','assigned','in_progress') and (job_day(j) = today or j.status = 'in_progress')
       and not exists (select 1 from shifts sh where sh.job_id = j.id and sh.member_id = mid and sh.removed_at is null and bc_day(sh.starts_at) = today)) x;
  select string_agg('- ' || a.type || ' problem' || coalesce(' on ' || assistant_job_label(a.job_id), '') || ' sent ' || van_day(a.created_at) || ' ' || van_time(a.created_at)
      || ': "' || left(regexp_replace(a.body, '\s+', ' ', 'g'), 70) || '" -> '
      || case a.status when 'resolved' then 'RESOLVED by the owner' when 'seen' then 'SEEN by the owner, not resolved yet' else 'NOT SEEN by the owner yet' end, E'\n' order by a.created_at desc)
    into alerts_txt from (select * from crew_alerts where member_id = mid and created_at > now() - interval '14 days'
      and (status <> 'resolved' or created_at > now() - interval '3 days') order by created_at desc limit 5) a;
  return jsonb_build_object(
    'session_token', tok,
    'vars', jsonb_build_object(
      'crew_name', split_part(m.full_name, ' ', 1),
      'company_name', coalesce(k.invoice_display_name, k.business_name, ''),
      'local_time', to_char(now() at time zone 'America/Vancouver', 'FMDay, FMMonth FMDD YYYY (YYYY-MM-DD), ') || van_time(now()),
      'todays_jobs', coalesce(jobs_txt, 'No shifts scheduled today'),
      'clocked_in', case when oe.clock_in_at is null then 'No' else 'Yes, since ' || van_time(oe.clock_in_at) || coalesce(' on ' || assistant_job_label(oe.job_id), '') end,
      'quoting_available', 'no',
      'alert_updates', coalesce(alerts_txt, 'None.')),
    'conversations', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'el_conversation_id', c.el_conversation_id, 'summary', c.summary, 'started_at', c.started_at,
        'when', van_day(c.started_at) || ', ' || van_time(c.started_at),
        'messages', coalesce((select jsonb_agg(jsonb_build_object('role', mm.role, 'body', mm.body) order by mm.created_at) from assistant_messages mm where mm.conversation_id = c.id), '[]')) order by c.started_at)
      from (select * from assistant_conversations where member_id = mid order by started_at desc limit 5) c), '[]'));
end $$;

-- The crew app logs each chat line so the assistant remembers past chats
create or replace function assistant_log(p_token uuid, p_conversation text, p_role text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare s assistant_sessions; cid uuid;
begin
  select * into s from assistant_sessions where token = p_token and expires_at > now();
  if not found or s.member_id is distinct from current_member_id() then raise exception 'session expired'; end if;
  if coalesce(p_conversation, '') !~ '^[A-Za-z0-9_-]{6,80}$' or p_role not in ('user','agent') or coalesce(trim(p_body), '') = '' then return; end if;
  insert into assistant_conversations (member_id, contractor_id, el_conversation_id) values (s.member_id, s.contractor_id, p_conversation)
    on conflict (el_conversation_id) do update set el_conversation_id = excluded.el_conversation_id returning id into cid;
  if (select member_id from assistant_conversations where id = cid) <> s.member_id then return; end if;
  insert into assistant_messages (conversation_id, member_id, role, body) values (cid, s.member_id, p_role, left(p_body, 4000));
end $$;

create or replace function assistant_set_summary(p_conv uuid, p_summary text) returns void language sql security definer set search_path = public as $$
  update assistant_conversations set summary = left(p_summary, 2000), summarized_at = now() where id = p_conv $$;

-- Tool calls from the ElevenLabs agent (through the crew-assistant-tools edge function). The session token decides who is acting.
create or replace function assistant_tool(p_token uuid, p_tool text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s assistant_sessions; m team_members; a jsonb := coalesce(p_args, '{}'); hint text := trim(coalesce(p_args->>'job_hint', ''));
  jid uuid; r jsonb; txt text; n int; d1 date; d2 date; days int; locs text;
begin
  select * into s from assistant_sessions where token = p_token and expires_at > now();
  if not found then return jsonb_build_object('ok', false, 'message', 'Session expired. Ask them to close and reopen the Assistant tab.'); end if;
  select * into m from team_members where id = s.member_id;
  if not m.active or m.user_id is null then return jsonb_build_object('ok', false, 'message', 'This crew account is switched off.'); end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', m.user_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', m.user_id::text, true);
  if current_member_id() is null then return jsonb_build_object('ok', false, 'message', 'This crew account is not active.'); end if;
  if hint <> '' then jid := assistant_find_job(m.id, hint); end if;

  begin
    if p_tool = 'clock_in' then
      if hint <> '' and jid is null then return jsonb_build_object('ok', false, 'message', 'Could not find a job of theirs matching "' || hint || '". Ask which job, or clock in without a job.'); end if;
      r := crew_clock_in(jid, s.lat, s.lng);
      return jsonb_build_object('ok', true, 'message', 'Clocked in at ' || van_time(now()) || coalesce(' on ' || assistant_job_label((r->'open_entry'->>'job_id')::uuid), ' (no job matched; the owner can set it later)') || '.');

    elsif p_tool = 'clock_out' then
      r := crew_clock_out(s.lat, s.lng);
      jid := (r->'last_entry'->>'job_id')::uuid;
      return jsonb_build_object('ok', true, 'message', 'Clocked out at ' || van_time(now()) || '. ' || (r->'last_entry'->>'hours') || ' hours' || coalesce(' on ' || assistant_job_label(jid), '') || '.',
        'daily_report_already_sent_for_this_job', jid is null or (r->'reported_today') ? jid::text);

    elsif p_tool = 'get_my_schedule' then
      days := least(greatest(coalesce((a->>'days_ahead')::int, 7), 1), 31);
      select string_agg(x.t, E'\n' order by x.o) into txt from (
        select van_day(sh.starts_at) || ' ' || van_time(sh.starts_at) || '-' || van_time(sh.ends_at) || ': ' || coalesce(assistant_job_label(sh.job_id), 'Shift')
               || coalesce(' (note: ' || nullif(sh.notes, '') || ')', '') t, sh.starts_at o
          from shifts sh where sh.member_id = m.id and sh.removed_at is null and sh.ends_at > now() - interval '12 hours' and sh.starts_at < now() + make_interval(days => days)
        union all
        select to_char(job_day(j), 'Dy Mon FMDD') || ': ' || assistant_job_label(j.id) || coalesce(' (' || nullif(j.details->>'preferred_time', '') || ')', ''), job_day(j)::timestamptz
          from jobs j join job_crew jc on jc.job_id = j.id and jc.member_id = m.id and jc.removed_at is null
         where j.status in ('booked','offered','assigned','in_progress') and job_day(j) between bc_day(now()) and bc_day(now()) + days
           and not exists (select 1 from shifts sh where sh.job_id = j.id and sh.member_id = m.id and sh.removed_at is null)) x;
      return jsonb_build_object('ok', true, 'message', coalesce(txt, 'No shifts or jobs in the next ' || days || ' days.'));

    elsif p_tool = 'submit_daily_report' then
      if trim(coalesce(a->>'report_text', '')) = '' then return jsonb_build_object('ok', false, 'message', 'The report text is empty. Ask what work was done.'); end if;
      if hint <> '' and jid is null then return jsonb_build_object('ok', false, 'message', 'Could not find a job of theirs matching "' || hint || '". Ask which job.'); end if;
      if jid is null then jid := crew_pick_job(m.id, null); end if;
      if jid is null then
        select t.job_id into jid from time_entries t where t.member_id = m.id and t.removed_at is null and t.job_id is not null and bc_day(t.clock_in_at) = bc_day(now()) order by t.clock_in_at desc limit 1;
      end if;
      if jid is null then return jsonb_build_object('ok', false, 'message', 'Could not tell which job this report is for. Ask which job.'); end if;
      perform crew_daily_report(jid, a->>'report_text');
      return jsonb_build_object('ok', true, 'message', 'Daily report saved for ' || assistant_job_label(jid) || '. The owner can see it.');

    elsif p_tool = 'raise_alert' then
      if trim(coalesce(a->>'description', '')) = '' then return jsonb_build_object('ok', false, 'message', 'Ask what the problem is.'); end if;
      perform crew_raise_alert(jid, a->>'alert_type', a->>'urgency', a->>'description');
      select job_id into jid from crew_alerts where member_id = m.id order by created_at desc limit 1;
      return jsonb_build_object('ok', true, 'message', case when a->>'urgency' = 'high' then 'Urgent ' else '' end || coalesce(nullif(a->>'alert_type', ''), 'other')
        || ' problem sent to the owner' || coalesce(' for ' || assistant_job_label(jid), '') || '. They can ask you later whether the owner has seen it.');

    elsif p_tool = 'check_my_alerts' then
      days := least(greatest(coalesce((a->>'days_back')::int, 7), 1), 30);
      select string_agg(case when x.urgency = 'high' then 'Urgent ' else '' end || x.type || ' problem' || coalesce(' on ' || assistant_job_label(x.job_id), '')
          || ', sent ' || van_day(x.created_at) || ' ' || van_time(x.created_at) || ': "' || left(regexp_replace(x.body, '\s+', ' ', 'g'), 90) || '" -> '
          || case x.status when 'resolved' then 'RESOLVED by the owner' || coalesce(' ' || van_day(x.resolved_at) || ' ' || van_time(x.resolved_at), '')
                           when 'seen' then 'SEEN by the owner' || coalesce(' ' || van_day(x.seen_at) || ' ' || van_time(x.seen_at), '') || ', not marked resolved yet'
                           else 'NOT SEEN by the owner yet' end, E'\n' order by x.created_at desc)
        into txt from (select * from crew_alerts where member_id = m.id and created_at > now() - make_interval(days => days) order by created_at desc limit 10) x;
      return jsonb_build_object('ok', true, 'message', coalesce(txt, 'They haven''t reported any problems in the last ' || days || ' days.'));

    elsif p_tool = 'flag_low_stock' then
      if trim(coalesce(a->>'item_name', '')) = '' then return jsonb_build_object('ok', false, 'message', 'Ask which item is running low.'); end if;
      if trim(coalesce(a->>'location_name', '')) = '' then
        select string_agg(name, ', ' order by name), count(*) into locs, n from inventory_locations where contractor_id = s.contractor_id and removed_at is null;
        if n > 1 then return jsonb_build_object('ok', false, 'message', 'Ask where it is running low: ' || locs || '.'); end if;
        if n = 1 then a := a || jsonb_build_object('location_name', locs); end if;
      end if;
      perform crew_flag_stock(null, nullif(trim(coalesce(a->>'location_name', '')), ''), a->>'item_name', coalesce(a->>'status', 'low'));
      return jsonb_build_object('ok', true, 'message', 'Flagged ' || (a->>'item_name') || ' as ' || case when a->>'status' = 'out' then 'out' else 'running low' end
        || coalesce(' at ' || nullif(trim(a->>'location_name'), ''), '') || '. The owner can see it.');

    elsif p_tool = 'request_time_off' then
      d1 := (a->>'start_date')::date; d2 := coalesce(nullif(a->>'end_date', '')::date, d1);
      r := crew_request_time_off(d1, d2, a->>'reason');
      txt := case when d1 = d2 then d1::text else d1 || ' to ' || d2 end;
      if (r->>'auto_approved')::boolean then
        return jsonb_build_object('ok', true, 'message', 'Time off for ' || txt || ' is approved automatically. The owner has been told.');
      end if;
      return jsonb_build_object('ok', true, 'message', 'Time off request for ' || txt || ' sent to the owner for approval because '
        || case when (r->>'clashes')::int > 0 then 'they already have ' || (r->>'clashes') || ' shift(s) booked then' else 'it is less than ' || (r->>'notice_days') || ' days away' end
        || '. They will see the answer in the app.');

    elsif p_tool = 'search_notice_board' then
      return jsonb_build_object('ok', true, 'message', 'There is no notice board in the app yet. Suggest asking the owner directly.');
    end if;
    return jsonb_build_object('ok', false, 'message', 'Unknown action');
  exception when others then
    return jsonb_build_object('ok', false, 'message', 'Could not do that: ' || sqlerrm);
  end;
end $$;

revoke all on function assistant_tool(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function assistant_set_summary(uuid, text) from public, anon, authenticated;
revoke all on function assistant_find_job(uuid, text) from public, anon, authenticated;
revoke all on function assistant_job_label(uuid) from public, anon;
grant execute on function assistant_tool(uuid, text, jsonb) to service_role;
grant execute on function assistant_set_summary(uuid, text) to service_role;
revoke all on function assistant_start(double precision, double precision) from public, anon;
revoke all on function assistant_log(uuid, text, text, text) from public, anon;
grant execute on function assistant_start(double precision, double precision) to authenticated;
grant execute on function assistant_log(uuid, text, text, text) to authenticated;
