-- Team messages (owner <-> crew) and the Claude assistant's conversation store

alter table team_members add column if not exists owner_read_at timestamptz;   -- owner has read this member's thread up to here
alter table team_members add column if not exists msgs_read_at timestamptz;    -- member has read their messages up to here

create table if not exists team_messages (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references contractors(id),
  member_id uuid references team_members(id),          -- null = announcement to the whole crew
  sender text not null check (sender in ('owner','crew')),
  sender_member uuid references team_members(id),
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create index if not exists team_messages_thread on team_messages (contractor_id, member_id, created_at desc);
alter table team_messages enable row level security;
create policy team_messages_admin on team_messages for select using (is_admin());

create table if not exists ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('crew','owner')),
  contractor_id uuid not null references contractors(id),
  member_id uuid references team_members(id),
  started_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);
create table if not exists ai_messages (
  id bigserial primary key,
  conversation_id uuid not null references ai_conversations(id),
  role text not null check (role in ('user','assistant')),
  body text not null,
  actions jsonb,
  input_tokens int, output_tokens int,
  created_at timestamptz not null default now()
);
create index if not exists ai_conv_user on ai_conversations (user_id, last_at desc);
create index if not exists ai_msg_conv on ai_messages (conversation_id, id);
alter table ai_conversations enable row level security;
alter table ai_messages enable row level security;
create policy ai_conv_admin on ai_conversations for select using (is_admin());
create policy ai_msg_admin on ai_messages for select using (is_admin());

-- Vancouver local date + time -> timestamp (used by the assistant)
create or replace function van_ts(p_date date, p_time time) returns timestamptz
language sql immutable set search_path = public as $$ select (p_date + p_time) at time zone 'America/Vancouver' $$;

-- ---------- owner side ----------
create or replace function msg_inbox() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := current_contractor_id();
begin
  if cid is null then raise exception 'not an active contractor'; end if;
  return jsonb_build_object(
    'threads', coalesce((select jsonb_agg(x order by x->>'last_at' desc nulls last, x->>'name') from (
      select jsonb_build_object('member_id', m.id, 'name', m.full_name, 'joined', m.joined_at is not null, 'active', m.active,
        'last', (select left(t.body, 120) from team_messages t where t.member_id = m.id and t.removed_at is null order by t.created_at desc limit 1),
        'last_from', (select t.sender from team_messages t where t.member_id = m.id and t.removed_at is null order by t.created_at desc limit 1),
        'last_at', (select max(t.created_at) from team_messages t where t.member_id = m.id and t.removed_at is null),
        'unread', (select count(*) from team_messages t where t.member_id = m.id and t.sender = 'crew' and t.removed_at is null and t.created_at > coalesce(m.owner_read_at, '-infinity'))) x
      from team_members m where m.contractor_id = cid and (m.active or exists (select 1 from team_messages t where t.member_id = m.id))) s), '[]'),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'body', t.body, 'created_at', t.created_at) order by t.created_at desc)
      from (select * from team_messages where contractor_id = cid and member_id is null and removed_at is null order by created_at desc limit 20) t), '[]'),
    'unread', (select count(*) from team_messages t join team_members m on m.id = t.member_id
      where t.contractor_id = cid and t.sender = 'crew' and t.removed_at is null and t.created_at > coalesce(m.owner_read_at, '-infinity')));
end $$;

create or replace function msg_thread(p_member uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := current_contractor_id(); m team_members;
begin
  if cid is null then raise exception 'not an active contractor'; end if;
  if p_member is null then
    return jsonb_build_object('member', null, 'messages', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'from', 'owner', 'body', t.body, 'created_at', t.created_at) order by t.created_at)
      from (select * from team_messages where contractor_id = cid and member_id is null and removed_at is null order by created_at desc limit 100) t), '[]'));
  end if;
  select * into m from team_members where id = p_member and contractor_id = cid;
  if not found then raise exception 'pick someone from your crew'; end if;
  update team_members set owner_read_at = now() where id = m.id;
  return jsonb_build_object('member', jsonb_build_object('id', m.id, 'name', m.full_name, 'joined', m.joined_at is not null, 'active', m.active, 'read_at', m.msgs_read_at),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'from', t.sender, 'body', t.body, 'created_at', t.created_at) order by t.created_at)
      from (select * from team_messages where member_id = m.id and removed_at is null order by created_at desc limit 200) t), '[]'));
end $$;

create or replace function msg_send(p_member uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := current_contractor_id(); b text := left(trim(coalesce(p_body, '')), 2000);
begin
  if cid is null then raise exception 'not an active contractor'; end if;
  if b = '' then raise exception 'type a message first'; end if;
  if p_member is not null and not exists (select 1 from team_members where id = p_member and contractor_id = cid) then raise exception 'pick someone from your crew'; end if;
  insert into team_messages (contractor_id, member_id, sender, body) values (cid, p_member, 'owner', b);
  if p_member is not null then update team_members set owner_read_at = now() where id = p_member; end if;
  return msg_thread(p_member);
end $$;

-- ---------- crew side ----------
create or replace function crew_messages() returns jsonb
language plpgsql security definer set search_path = public as $$
declare mid uuid := current_member_id(); m team_members; prev timestamptz;
begin
  if mid is null then raise exception 'not on an active crew'; end if;
  select * into m from team_members where id = mid; prev := m.msgs_read_at;
  update team_members set msgs_read_at = now() where id = mid;
  return jsonb_build_object('boss', (select coalesce(k.contact_name, k.business_name) from contractors k where k.id = m.contractor_id),
    'business', (select coalesce(k.invoice_display_name, k.business_name) from contractors k where k.id = m.contractor_id),
    'read_before', prev, 'owner_read_at', m.owner_read_at,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'from', t.sender, 'to_all', t.member_id is null, 'body', t.body, 'created_at', t.created_at) order by t.created_at)
      from (select * from team_messages where contractor_id = m.contractor_id and removed_at is null and (member_id = mid or (member_id is null and created_at >= m.created_at - interval '30 days'))
            order by created_at desc limit 200) t), '[]'));
end $$;

create or replace function crew_msg_send(p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mid uuid := current_member_id(); b text := left(trim(coalesce(p_body, '')), 2000);
begin
  if mid is null then raise exception 'not on an active crew'; end if;
  if b = '' then raise exception 'type a message first'; end if;
  insert into team_messages (contractor_id, member_id, sender, sender_member, body) values (member_contractor(mid), mid, 'crew', mid, b);
  return crew_messages();
end $$;

create or replace function crew_unread() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from team_messages t join team_members m on m.id = current_member_id()
   where t.contractor_id = m.contractor_id and t.sender = 'owner' and t.removed_at is null
     and (t.member_id = m.id or t.member_id is null) and t.created_at > coalesce(m.msgs_read_at, m.joined_at, '-infinity') $$;

-- ---------- assistant history (for the chat screen) ----------
create or replace function ai_history() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('conversation_id', c.id, 'messages', coalesce((select jsonb_agg(jsonb_build_object('role', x.role, 'body', x.body) order by x.id)
      from (select * from ai_messages where conversation_id = c.id order by id desc limit 40) x), '[]'))
    from ai_conversations c where c.user_id = auth.uid() and c.last_at > now() - interval '12 hours' order by c.last_at desc limit 1), '{}'::jsonb) $$;

revoke all on function msg_inbox() from public, anon;
revoke all on function msg_thread(uuid) from public, anon;
revoke all on function msg_send(uuid, text) from public, anon;
revoke all on function crew_messages() from public, anon;
revoke all on function crew_msg_send(text) from public, anon;
revoke all on function crew_unread() from public, anon;
revoke all on function ai_history() from public, anon;
grant execute on function msg_inbox(), msg_thread(uuid), msg_send(uuid, text), crew_messages(), crew_msg_send(text), crew_unread(), ai_history(), van_ts(date, time) to authenticated;
