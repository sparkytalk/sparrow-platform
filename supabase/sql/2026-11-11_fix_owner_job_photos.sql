-- Owners couldn't upload job photos ("new row violates row-level security policy"):
-- the storage rule looked up jobs directly, but jobs is only readable through functions.
create or replace function public.contractor_can_photo_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = public, admin as $$
declare f text := split_part(p_name, '/', 1); cid uuid := current_contractor_id();
begin
  if cid is null or f !~ '^[0-9a-f-]{36}$' then return false; end if;
  return exists (select 1 from jobs where id = f::uuid and contractor_id = cid);
end $$;
revoke all on function public.contractor_can_photo_path(text) from public, anon;
grant execute on function public.contractor_can_photo_path(text) to authenticated;

drop policy if exists contractor_job_photos on storage.objects;
create policy contractor_job_photos on storage.objects for all to authenticated
  using (bucket_id = 'job-photos' and public.contractor_can_photo_path(name))
  with check (bucket_id = 'job-photos' and public.contractor_can_photo_path(name));
