-- Cobilt waitlist: run in Supabase → SQL Editor. Safe to run again.
--
-- Signups are confirmed with a 6-digit email code:
--   1. join_waitlist() saves the person as pending with a hashed code (valid 10 minutes).
--   2. The site emails them the code.
--   3. verify_waitlist() checks the code (5 tries max) and confirms them.
-- Only confirmed signups get a spot and the free months. Unconfirmed ones are
-- deleted after 7 days.
--
-- The table is locked: the public (publishable/anon) key cannot read, change or
-- delete rows. It can only call the two functions below.

create table if not exists public.waitlist (
  id          bigint generated always as identity primary key,
  email       text not null unique
              check (email = lower(email) and length(email) <= 254 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  name        text not null check (length(name) between 2 and 80),
  location    text not null check (length(location) between 2 and 100),
  perk_months int  not null default 2,          -- free months of Bolt AI promised to confirmed members
  joined_at   timestamptz not null default now(),
  updated_at  timestamptz
);

alter table public.waitlist
  add column if not exists confirmed_at    timestamptz,
  add column if not exists code_hash       text,          -- sha256 of email + code, never the code itself
  add column if not exists code_expires_at timestamptz,
  add column if not exists code_attempts   int not null default 0,
  add column if not exists email_sent_at   timestamptz;

-- Earlier draft used emailed links instead of codes.
alter table public.waitlist
  drop column if exists token_hash,
  drop column if exists token_expires_at;
drop function if exists public.join_waitlist(text, text, text);
drop function if exists public.confirm_waitlist(text);

-- RLS on with no policies = no direct access through the API.
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- Start a signup. Returns:
--   status 'confirmed' + spot          when the email is already confirmed (no email sent)
--   status 'pending' + send_email true  when a new code should be emailed
--   status 'pending' + send_email false when a code was sent less than a minute ago
create or replace function public.join_waitlist(p_email text, p_name text, p_location text, p_code_hash text)
returns table (status text, spot bigint, send_email boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  r waitlist%rowtype;
begin
  delete from waitlist where confirmed_at is null and joined_at < now() - interval '7 days';

  select * into r from waitlist where waitlist.email = lower(trim(p_email));

  if found and r.confirmed_at is not null then
    update waitlist set name = trim(p_name), location = trim(p_location), updated_at = now() where id = r.id;
    return query select 'confirmed'::text,
      (select count(*) from waitlist w where w.confirmed_at is not null and (w.confirmed_at, w.id) <= (r.confirmed_at, r.id)),
      false;
    return;
  end if;

  if found and r.email_sent_at > now() - interval '60 seconds' then
    return query select 'pending'::text, null::bigint, false;
    return;
  end if;

  insert into waitlist (email, name, location, code_hash, code_expires_at, code_attempts, email_sent_at)
  values (lower(trim(p_email)), trim(p_name), trim(p_location), p_code_hash, now() + interval '10 minutes', 0, now())
  on conflict (email) do update
    set name = excluded.name, location = excluded.location,
        code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at,
        code_attempts = 0, email_sent_at = excluded.email_sent_at, updated_at = now();

  return query select 'pending'::text, null::bigint, true;
end;
$$;

-- Check a code. result is one of:
--   'ok'       confirmed (or already was); joined_name and spot are set
--   'wrong'    wrong code; tries_left says how many are left
--   'expired'  no code, code expired, or out of tries: request a new one
create or replace function public.verify_waitlist(p_email text, p_code_hash text)
returns table (result text, joined_name text, spot bigint, tries_left int)
language plpgsql
security definer
set search_path = public
as $$
declare
  r waitlist%rowtype;
begin
  select * into r from waitlist where waitlist.email = lower(trim(p_email));
  if not found then
    return query select 'expired'::text, null::text, null::bigint, 0; return;
  end if;

  if r.confirmed_at is null then
    if r.code_hash is null or r.code_expires_at <= now() or r.code_attempts >= 5 then
      return query select 'expired'::text, null::text, null::bigint, 0; return;
    end if;
    if r.code_hash <> p_code_hash then
      update waitlist set code_attempts = code_attempts + 1 where id = r.id;
      return query select 'wrong'::text, null::text, null::bigint, 4 - r.code_attempts; return;
    end if;
    update waitlist set confirmed_at = now(), code_hash = null, code_expires_at = null where id = r.id
    returning * into r;
  end if;

  return query select 'ok'::text, r.name,
    (select count(*) from waitlist w where w.confirmed_at is not null and (w.confirmed_at, w.id) <= (r.confirmed_at, r.id)),
    5;
end;
$$;

revoke all on function public.join_waitlist(text, text, text, text) from public;
revoke all on function public.verify_waitlist(text, text) from public;
grant execute on function public.join_waitlist(text, text, text, text) to anon;
grant execute on function public.verify_waitlist(text, text) to anon;
