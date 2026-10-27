-- Cobilt waitlist: run in Supabase → SQL Editor. Safe to run again.
--
-- Signups are confirmed by email (double opt-in):
--   1. join_waitlist() saves the person as pending with a one-time token (hashed).
--   2. The site emails them a link with the token.
--   3. confirm_waitlist() marks them confirmed and returns their spot in line.
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
  add column if not exists confirmed_at     timestamptz,
  add column if not exists token_hash       text unique,   -- sha256 of the emailed token, never the token itself
  add column if not exists token_expires_at timestamptz,
  add column if not exists email_sent_at    timestamptz;

-- RLS on with no policies = no direct access through the API.
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- Older version of this file had a 3-argument join_waitlist.
drop function if exists public.join_waitlist(text, text, text);

-- Start a signup. Returns:
--   status 'confirmed' + spot  when the email is already confirmed (no email sent)
--   status 'pending' + send_email true   when a new confirmation email should go out
--   status 'pending' + send_email false  when one was sent less than a minute ago
create or replace function public.join_waitlist(p_email text, p_name text, p_location text, p_token_hash text)
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

  insert into waitlist (email, name, location, token_hash, token_expires_at, email_sent_at)
  values (lower(trim(p_email)), trim(p_name), trim(p_location), p_token_hash, now() + interval '24 hours', now())
  on conflict (email) do update
    set name = excluded.name, location = excluded.location,
        token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at,
        email_sent_at = excluded.email_sent_at, updated_at = now();

  return query select 'pending'::text, null::bigint, true;
end;
$$;

-- Confirm from the emailed link. Returns nothing when the token is wrong or expired.
-- Clicking the link again (before it expires) returns the same result.
create or replace function public.confirm_waitlist(p_token_hash text)
returns table (joined_name text, joined_email text, spot bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  r waitlist%rowtype;
begin
  select * into r from waitlist where token_hash = p_token_hash and token_expires_at > now();
  if not found then return; end if;

  if r.confirmed_at is null then
    update waitlist set confirmed_at = now() where id = r.id returning * into r;
  end if;

  return query select r.name, r.email,
    (select count(*) from waitlist w where w.confirmed_at is not null and (w.confirmed_at, w.id) <= (r.confirmed_at, r.id));
end;
$$;

revoke all on function public.join_waitlist(text, text, text, text) from public;
revoke all on function public.confirm_waitlist(text) from public;
grant execute on function public.join_waitlist(text, text, text, text) to anon;
grant execute on function public.confirm_waitlist(text) to anon;
