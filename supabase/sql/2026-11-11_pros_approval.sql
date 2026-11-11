-- Sparrow Pros early access: sign up -> confirm email -> Sparrow approves -> use the app.
-- New businesses start as 'applied'. current_contractor_id() only returns active/paused businesses,
-- so every job/customer/quote function is closed until approval.

create or replace function pros_create_business(p_user uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, admin as $$
declare cid uuid; nm text := left(trim(coalesce(p->>'business_name', '')), 120); who text := left(trim(coalesce(p->>'contact_name', '')), 120);
  ph text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'); em text; pre text;
begin
  if p_user is null then raise exception 'please sign in again'; end if;
  if nm = '' then raise exception 'enter your business name'; end if;
  if who = '' then raise exception 'enter your name'; end if;
  if length(ph) = 10 then ph := '1' || ph; end if;
  if length(ph) <> 11 or left(ph, 1) <> '1' then raise exception 'enter a 10-digit phone number'; end if;
  if exists (select 1 from contractors where user_id = p_user) then raise exception 'this login already has a business'; end if;
  if exists (select 1 from team_members where user_id = p_user) then raise exception 'this login is used by a crew member. Use a different email for your business'; end if;
  if exists (select 1 from admin.admins where user_id = p_user) then raise exception 'this login belongs to a Sparrow admin. Use a different email'; end if;
  select email into em from auth.users where id = p_user;
  pre := upper(left(regexp_replace(nm, '[^A-Za-z]', '', 'g'), 3)); if pre = '' then pre := 'INV'; end if;
  insert into contractors (user_id, kind, business_name, contact_name, phone_e164, email, trade, status, submitted_at,
                           plan, billing_status, invoice_display_name, invoice_prefix)
  values (p_user, 'subscriber', nm, who, '+' || ph, em, nullif(left(trim(coalesce(p->>'trade', '')), 60), ''), 'applied', now(),
          'trial', 'none', nm, pre)
  returning id into cid;
  perform audit('pros.signup', 'contractors', cid, jsonb_build_object('trade', p->>'trade'));
  return cid;
end $$;
revoke all on function pros_create_business(uuid, jsonb) from public, anon, authenticated;
grant execute on function pros_create_business(uuid, jsonb) to service_role;

-- crew invites need an approved business too
create or replace function team_invite(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
declare cid uuid := my_contractor_id(); tok text; m team_members; em text := lower(trim(coalesce(p->>'email', ''))); nm text := trim(coalesce(p->>'full_name', ''));
begin
  if cid is null then raise exception 'only the business owner can invite crew'; end if;
  if current_contractor_id() is null then raise exception 'your account is waiting for approval'; end if;
  if nm = '' then raise exception 'add their name'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'add a valid email; they sign in with it'; end if;
  if exists (select 1 from contractors where email = em) then raise exception 'that email belongs to a business account; use a different one'; end if;
  if exists (select 1 from team_members where email = em and contractor_id <> cid and joined_at is not null) then raise exception 'that email is already on another team'; end if;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  select * into m from team_members where contractor_id = cid and email = em;
  if found then
    if m.joined_at is not null then raise exception '% has already joined', m.full_name; end if;
    update team_members set full_name = nm, phone = nullif(trim(coalesce(p->>'phone', '')), ''), invite_token_hash = encode(extensions.digest(tok, 'sha256'), 'hex'),
           invite_expires_at = now() + interval '14 days', invited_at = now(), active = true where id = m.id returning * into m;
  else
    insert into team_members (contractor_id, full_name, email, phone, invite_token_hash, invite_expires_at)
    values (cid, nm, em, nullif(trim(coalesce(p->>'phone', '')), ''), encode(extensions.digest(tok, 'sha256'), 'hex'), now() + interval '14 days') returning * into m;
  end if;
  perform audit('team.invited', 'team_members', m.id, jsonb_build_object('email', em));
  return jsonb_build_object('ok', true, 'id', m.id, 'full_name', m.full_name, 'phone', m.phone, 'link', 'https://pros.sparrowlabs.ca/#join-' || tok, 'team', team_list());
end $$;

-- admin: sign-up details (incl. whether the email is confirmed)
create or replace function admin.admin_signup_info(p_contractor uuid) returns jsonb
language plpgsql stable security definer set search_path = public, admin as $$
declare r jsonb;
begin
  if not is_admin() then raise exception 'admins only'; end if;
  select jsonb_build_object('email_confirmed_at', u.email_confirmed_at, 'last_sign_in_at', u.last_sign_in_at,
           'provider', u.raw_app_meta_data->>'provider', 'signed_up_at', u.created_at)
    into r from contractors c join auth.users u on u.id = c.user_id where c.id = p_contractor;
  return coalesce(r, '{}'::jsonb);
end $$;
revoke all on function admin.admin_signup_info(uuid) from public, anon;
grant execute on function admin.admin_signup_info(uuid) to authenticated;

-- admin: approve or decline a Sparrow Pros sign-up. Approved early-access businesses are free ('comped') until billing starts.
create or replace function admin.admin_review_signup(p_contractor uuid, p_approve boolean, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
declare c contractors; confirmed timestamptz;
begin
  if not is_admin() then raise exception 'admins only'; end if;
  select * into c from contractors where id = p_contractor for update;
  if not found or c.kind <> 'subscriber' then raise exception 'sign-up not found'; end if;
  if p_approve then
    select email_confirmed_at into confirmed from auth.users where id = c.user_id;
    if confirmed is null then raise exception 'they haven''t confirmed their email yet'; end if;
    update contractors set status = 'active', status_reason = null, activated_at = coalesce(activated_at, now()),
           billing_status = case when billing_status in ('none','canceled') then 'comped' else billing_status end
     where id = c.id;
  else
    update contractors set status = 'suspended', status_reason = nullif(trim(coalesce(p_reason, '')), '') where id = c.id;
  end if;
  perform audit(case when p_approve then 'admin.signup_approved' else 'admin.signup_declined' end, 'contractors', c.id, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function admin.admin_review_signup(uuid, boolean, text) from public, anon;
grant execute on function admin.admin_review_signup(uuid, boolean, text) to authenticated;
