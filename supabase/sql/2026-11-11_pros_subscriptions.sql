-- Sparrow Pros becomes a subscription app: businesses sign up themselves, add their own customers and jobs,
-- and get paid directly by their customers. Sparrow's own marketplace (Preet) keeps working for the in-house business.

-- ---------- contractors: subscriber fields ----------
alter table contractors add column if not exists kind text not null default 'network' check (kind in ('network','subscriber'));
alter table contractors add column if not exists trade text;
alter table contractors add column if not exists pay_instructions text;
alter table contractors add column if not exists plan text check (plan in ('trial','solo','crew'));
alter table contractors add column if not exists billing_status text not null default 'none'
  check (billing_status in ('none','trialing','active','past_due','canceled','comped'));
alter table contractors add column if not exists trial_ends_at timestamptz;
alter table contractors add column if not exists crew_addon boolean not null default false;
alter table contractors add column if not exists stripe_customer_id text unique;
alter table contractors add column if not exists stripe_subscription_id text unique;
alter table contractors add column if not exists current_period_end timestamptz;
alter table contractors add column if not exists grace_until timestamptz;

-- ---------- customers owned by a subscriber ----------
alter table customers add column if not exists contractor_id uuid references contractors(id);
alter table customers add column if not exists phone text;
create index if not exists customers_contractor on customers (contractor_id);

-- ---------- jobs created in Sparrow Pros ----------
alter table jobs drop constraint if exists jobs_source_check;
alter table jobs add constraint jobs_source_check check (source = any (array['whatsapp','admin','pros']));

insert into services (code, name, mode, active, sort_order) values ('general', 'Job', 'range', false, 999)
on conflict (code) do nothing;

-- A job's display name: the business's own title, or the Sparrow service name
create or replace function job_title(p_job uuid) returns text
language sql stable security definer set search_path = public, admin as $$
  select coalesce(nullif(j.details->>'title', ''), s.name) from jobs j join services s on s.code = j.service_code where j.id = p_job $$;

-- ---------- no Sparrow money on a business's own jobs ----------
create or replace function write_job_money(p_job uuid) returns void
language plpgsql security definer set search_path = public, admin as $$
declare j jobs;
begin
  select * into j from jobs where id = p_job;
  if j.customer_owner = 'contractor' then return; end if;
  if j.fulfilment <> 'network' or j.contractor_id is null or j.price_cents is null
     or j.status not in ('completed','closed') then return; end if;
  if j.pay_status = 'cash_recorded' then
    insert into ledger_entries (contractor_id, job_id, kind, amount_cents, memo)
    values (j.contractor_id, j.id, 'cash_commission', -round(j.price_cents * j.commission_rate)::int, 'Commission on cash job ' || j.ref)
    on conflict do nothing;
  elsif j.pay_status = 'paid' then
    insert into ledger_entries (contractor_id, job_id, kind, amount_cents, memo)
    values (j.contractor_id, j.id, 'job_payout', round(j.price_cents * (1 - j.commission_rate))::int, 'Payout for job ' || j.ref)
    on conflict do nothing;
  end if;
end $$;

-- Sparrow's admin inbox only gets things about Sparrow's own customers
create or replace function admin.handoffs_sparrow_only() returns trigger
language plpgsql security definer set search_path = public, admin as $$
begin
  if new.job_id is not null and exists (select 1 from jobs where id = new.job_id and customer_owner = 'contractor') then return null; end if;
  if new.customer_id is not null and exists (select 1 from customers where id = new.customer_id and contractor_id is not null) then return null; end if;
  return new;
end $$;
drop trigger if exists handoffs_sparrow_only on public.handoffs;
create trigger handoffs_sparrow_only before insert on public.handoffs for each row execute function admin.handoffs_sparrow_only();

-- ---------- create a business (shared by email sign-up and Google sign-up) ----------
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
  insert into contractors (user_id, kind, business_name, contact_name, phone_e164, email, trade, status, activated_at,
                           plan, billing_status, trial_ends_at, invoice_display_name, invoice_prefix)
  values (p_user, 'subscriber', nm, who, '+' || ph, em, nullif(left(trim(coalesce(p->>'trade', '')), 60), ''), 'active', now(),
          'trial', 'trialing', now() + interval '14 days', nm, pre)
  returning id into cid;
  perform audit('pros.signup', 'contractors', cid, jsonb_build_object('trade', p->>'trade'));
  return cid;
end $$;
revoke all on function pros_create_business(uuid, jsonb) from public, anon, authenticated;
grant execute on function pros_create_business(uuid, jsonb) to service_role;

-- Signed in (e.g. with Google) but no business yet
create or replace function pros_signup(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
begin
  perform pros_create_business(auth.uid(), p);
  return contractor_me();
end $$;
revoke all on function pros_signup(jsonb) from public, anon;
grant execute on function pros_signup(jsonb) to authenticated;

-- ---------- customers ----------
create or replace function pros_customers() returns jsonb
language sql stable security definer set search_path = public, admin as $$
  select coalesce(jsonb_agg(x order by x->>'name'), '[]') from (
    select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email, 'company', c.company, 'notes', c.notes,
      'addresses', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'address_line', p.address_line, 'unit', p.unit, 'city', p.city, 'postal_code', p.postal_code) order by p.created_at desc)
                             from properties p where p.customer_id = c.id), '[]'),
      'jobs', (select count(*) from jobs j where j.customer_id = c.id),
      'last_job_at', (select max(j.created_at) from jobs j where j.customer_id = c.id)) x
    from customers c where c.contractor_id = current_contractor_id()) s $$;

create or replace function pros_customer_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
declare cid uuid := current_contractor_id(); cu customers; nm text := left(trim(coalesce(p->>'name', '')), 120);
  ph text := nullif(regexp_replace(coalesce(p->>'phone', ''), '[^\d+]', '', 'g'), ''); em text := nullif(lower(trim(coalesce(p->>'email', ''))), '');
begin
  if cid is null then raise exception 'not an active contractor'; end if;
  if nm = '' then raise exception 'enter the customer''s name'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that email doesn''t look right'; end if;
  if nullif(p->>'id', '') is not null then
    update customers set name = nm, phone = ph, email = em, company = nullif(trim(coalesce(p->>'company', '')), ''), notes = nullif(trim(coalesce(p->>'notes', '')), '')
     where id = (p->>'id')::uuid and contractor_id = cid returning * into cu;
    if not found then raise exception 'customer not found'; end if;
  else
    insert into customers (contractor_id, name, phone, email, company, notes, status)
    values (cid, nm, ph, em, nullif(trim(coalesce(p->>'company', '')), ''), nullif(trim(coalesce(p->>'notes', '')), ''), 'active') returning * into cu;
  end if;
  return jsonb_build_object('id', cu.id, 'customers', pros_customers());
end $$;

-- ---------- a business's own jobs ----------
create or replace function pros_job_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
declare cid uuid := current_contractor_id(); jr jobs; cust uuid; prop uuid; d date := nullif(p->>'date', '')::date;
  t1 time := nullif(p->>'start_time', '')::time; t2 time := nullif(p->>'end_time', '')::time;
  title text := left(trim(coalesce(p->>'title', '')), 120); addr text := left(trim(coalesce(p->>'address_line', '')), 200);
  v_city text := left(trim(coalesce(p->>'city', '')), 80); price int := nullif(p->>'price_cents', '')::int; s1 timestamptz; s2 timestamptz;
begin
  if cid is null then raise exception 'not an active contractor'; end if;
  if title = '' then raise exception 'say what the job is (for example "Fence repair")'; end if;
  if price is not null and price < 0 then raise exception 'the price can''t be negative'; end if;
  -- customer
  if nullif(p->>'customer_id', '') is not null then
    select id into cust from customers where id = (p->>'customer_id')::uuid and contractor_id = cid;
    if cust is null then raise exception 'customer not found'; end if;
  elsif p ? 'customer' then
    cust := (pros_customer_save(p->'customer')->>'id')::uuid;
  else raise exception 'pick a customer or add a new one';
  end if;
  -- address
  if addr = '' then raise exception 'add the job address'; end if;
  if v_city = '' then raise exception 'add the city'; end if;
  select id into prop from properties where customer_id = cust and lower(address_line) = lower(addr) and lower(city) = lower(v_city) and coalesce(unit, '') = coalesce(nullif(trim(p->>'unit'), ''), '') limit 1;
  if prop is null then
    insert into properties (customer_id, address_line, unit, city, postal_code)
    values (cust, addr, nullif(trim(coalesce(p->>'unit', '')), ''), v_city, nullif(upper(trim(coalesce(p->>'postal_code', ''))), '')) returning id into prop;
  end if;
  -- times (Vancouver)
  if d is not null then
    s1 := (d + coalesce(t1, time '08:00')) at time zone 'America/Vancouver';
    s2 := (d + coalesce(t2, case when t1 is null then time '17:00' else t1 + interval '2 hours' end)) at time zone 'America/Vancouver';
    if s2 <= s1 then raise exception 'the end time must be after the start time'; end if;
  end if;

  if nullif(p->>'id', '') is null then
    insert into jobs (customer_id, property_id, service_code, contractor_id, status, price_cents, commission_rate, source, customer_owner,
                      window_start, window_end, scheduled_start, scheduled_end, notes, details)
    values (cust, prop, 'general', cid, (case when d is null then 'requested' else 'booked' end)::job_status, price, 0, 'pros', 'contractor',
            s1, s2, case when t1 is not null then s1 end, case when t1 is not null then s2 end,
            nullif(trim(coalesce(p->>'notes', '')), ''), jsonb_build_object('title', title))
    returning * into jr;
    perform audit('pros.job_created', 'jobs', jr.id, jsonb_build_object('title', title));
  else
    select * into jr from jobs where id = (p->>'id')::uuid and contractor_id = cid and customer_owner = 'contractor' for update;
    if not found then raise exception 'job not found'; end if;
    if jr.status in ('completed','closed','cancelled') then raise exception 'this job is finished and can''t be changed'; end if;
    update jobs set customer_id = cust, property_id = prop, price_cents = coalesce(price, price_cents),
           window_start = s1, window_end = s2, scheduled_start = case when t1 is not null then s1 end, scheduled_end = case when t1 is not null then s2 end,
           notes = nullif(trim(coalesce(p->>'notes', '')), ''), details = details || jsonb_build_object('title', title)
     where id = jr.id returning * into jr;
    if d is not null and jr.status in ('requested','quoted') then
      perform set_job_status(jr.id, 'booked', 'Date set');
    end if;
  end if;
  return jsonb_build_object('id', jr.id, 'ref', jr.ref);
end $$;

create or replace function pros_job_cancel(p_job uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
declare cid uuid := current_contractor_id(); jr jobs;
begin
  if cid is null then raise exception 'not an active contractor'; end if;
  select * into jr from jobs where id = p_job and contractor_id = cid and customer_owner = 'contractor' for update;
  if not found then raise exception 'job not found'; end if;
  if jr.status in ('completed','closed','cancelled') then raise exception 'this job is already finished'; end if;
  update jobs set cancel_reason = nullif(trim(coalesce(p_reason, '')), '') where id = jr.id;
  perform set_job_status(jr.id, 'cancelled', coalesce(nullif(trim(p_reason), ''), 'Cancelled'));
  return jsonb_build_object('ok', true);
end $$;

-- The business marks its own invoice paid
create or replace function pros_invoice_paid(p_job uuid, p_method text) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
declare cid uuid := current_contractor_id(); jr jobs; inv invoices;
begin
  if cid is null then raise exception 'not an active contractor'; end if;
  select * into jr from jobs where id = p_job and contractor_id = cid and customer_owner = 'contractor' for update;
  if not found then raise exception 'job not found'; end if;
  select * into inv from invoices where job_id = jr.id and status in ('sent','paid') limit 1;
  if not found then raise exception 'this job has no invoice yet'; end if;
  update invoices set status = 'paid', paid_cents = total_cents where id = inv.id;
  update jobs set pay_status = 'paid', pay_method = case p_method when 'cash' then 'cash'::pay_method when 'card' then 'card'::pay_method else 'interac'::pay_method end,
         details = details || jsonb_build_object('paid_how', p_method, 'paid_marked_at', now()) where id = jr.id;
  perform audit('pros.invoice_paid', 'invoices', inv.id, jsonb_build_object('method', p_method));
  return jsonb_build_object('ok', true);
end $$;

-- Profile and "how customers pay you"
create or replace function pros_profile_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, admin as $$
declare cid uuid := my_contractor_id(); ph text;
begin
  if cid is null then raise exception 'please sign in again'; end if;
  if p ? 'phone' then
    ph := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'); if length(ph) = 10 then ph := '1' || ph; end if;
    if length(ph) <> 11 then raise exception 'enter a 10-digit phone number'; end if;
  end if;
  update contractors set
    business_name = case when p ? 'business_name' then coalesce(nullif(trim(p->>'business_name'), ''), business_name) else business_name end,
    contact_name = case when p ? 'contact_name' then nullif(trim(p->>'contact_name'), '') else contact_name end,
    phone_e164 = case when p ? 'phone' then '+' || ph else phone_e164 end,
    trade = case when p ? 'trade' then nullif(trim(p->>'trade'), '') else trade end,
    invoice_display_name = case when p ? 'invoice_display_name' then nullif(trim(p->>'invoice_display_name'), '') else invoice_display_name end,
    invoice_prefix = case when p ? 'invoice_prefix' then coalesce(nullif(upper(regexp_replace(p->>'invoice_prefix', '[^A-Za-z0-9]', '', 'g')), ''), 'INV') else invoice_prefix end,
    gst_number = case when p ? 'gst_number' then nullif(trim(p->>'gst_number'), '') else gst_number end,
    address_line = case when p ? 'address_line' then nullif(trim(p->>'address_line'), '') else address_line end,
    city = case when p ? 'city' then nullif(trim(p->>'city'), '') else city end,
    postal_code = case when p ? 'postal_code' then nullif(upper(trim(p->>'postal_code')), '') else postal_code end,
    invoice_website = case when p ? 'invoice_website' then nullif(trim(p->>'invoice_website'), '') else invoice_website end,
    brand_color = case when p ? 'brand_color' then nullif(trim(p->>'brand_color'), '') else brand_color end,
    payout_interac_email = case when p ? 'payout_interac_email' then nullif(lower(trim(p->>'payout_interac_email')), '') else payout_interac_email end,
    pay_instructions = case when p ? 'pay_instructions' then nullif(left(trim(p->>'pay_instructions'), 500), '') else pay_instructions end,
    invoice_terms = case when p ? 'invoice_terms' then nullif(left(trim(p->>'invoice_terms'), 1000), '') else invoice_terms end
  where id = cid;
  return contractor_me();
end $$;

do $$ declare f text; begin
  foreach f in array array['pros_customers()','pros_customer_save(jsonb)','pros_job_save(jsonb)','pros_job_cancel(uuid, text)','pros_invoice_paid(uuid, text)','pros_profile_save(jsonb)','job_title(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
