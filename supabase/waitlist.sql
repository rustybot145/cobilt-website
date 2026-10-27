-- Cobilt waitlist: run in Supabase → SQL Editor. Safe to run again.
--
-- Signups are confirmed with a 6-digit email code:
--   1. join_waitlist() stores a hashed code (valid 10 minutes) and says whether to email it.
--   2. The site emails the code.
--   3. verify_waitlist() checks it (5 tries per code) and confirms the person.
-- Every answer needs the code: someone typing another person's email learns nothing
-- and changes nothing. Max 5 code emails per address per day, 1 per minute.
-- Only confirmed signups get a spot and the free months; unconfirmed ones are deleted
-- after 7 days.
--
-- Access: only the website server can call these functions, using the Supabase
-- SECRET key. The public (publishable/anon) key can't read the table or call them.

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
  add column if not exists confirmed_at        timestamptz,
  add column if not exists code_hash           text,          -- sha256 of email + code, never the code itself
  add column if not exists code_expires_at     timestamptz,
  add column if not exists code_attempts       int not null default 0,
  add column if not exists email_sent_at       timestamptz,
  add column if not exists emails_sent_count   int not null default 0,
  add column if not exists emails_window_start timestamptz;

-- Earlier drafts.
alter table public.waitlist
  drop column if exists token_hash,
  drop column if exists token_expires_at;
drop function if exists public.join_waitlist(text, text, text);
drop function if exists public.confirm_waitlist(text);
drop function if exists public.join_waitlist(text, text, text, text);
drop function if exists public.verify_waitlist(text, text);

-- RLS on with no policies = no direct access through the API.
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- Start (or restart) a signup. status:
--   'send'     email the code now
--   'wait'     a code went out less than a minute ago; don't send another
--   'limited'  5 codes already sent to this address in the last 24 hours
-- Name and country are only saved while unconfirmed; a confirmed person's details
-- can't be changed through this.
create or replace function public.join_waitlist(p_email text, p_name text, p_location text, p_code_hash text)
returns table (status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  r waitlist%rowtype;
  v_email text := lower(trim(p_email));
  v_new_window boolean;
begin
  delete from waitlist where confirmed_at is null and joined_at < now() - interval '7 days';

  select * into r from waitlist where waitlist.email = v_email for update;

  if not found then
    insert into waitlist (email, name, location, code_hash, code_expires_at, code_attempts,
                          email_sent_at, emails_sent_count, emails_window_start)
    values (v_email, trim(p_name), trim(p_location), p_code_hash, now() + interval '10 minutes', 0,
            now(), 1, now());
    return query select 'send'::text;
    return;
  end if;

  if r.email_sent_at > now() - interval '60 seconds' then
    return query select 'wait'::text; return;
  end if;

  v_new_window := r.emails_window_start is null or r.emails_window_start <= now() - interval '24 hours';
  if not v_new_window and r.emails_sent_count >= 5 then
    return query select 'limited'::text; return;
  end if;

  update waitlist set
    name                = case when r.confirmed_at is null then trim(p_name) else name end,
    location            = case when r.confirmed_at is null then trim(p_location) else location end,
    code_hash           = p_code_hash,
    code_expires_at     = now() + interval '10 minutes',
    code_attempts       = 0,
    email_sent_at       = now(),
    emails_sent_count   = case when v_new_window then 1 else emails_sent_count + 1 end,
    emails_window_start = case when v_new_window then now() else emails_window_start end,
    updated_at          = now()
  where id = r.id;

  return query select 'send'::text;
end;
$$;

-- Check a code. result:
--   'ok'       right code: confirmed (or already was); joined_name and spot are set
--   'wrong'    wrong code; tries_left says how many remain
--   'expired'  no code, expired, or out of tries: request a new one
create or replace function public.verify_waitlist(p_email text, p_code_hash text)
returns table (result text, joined_name text, spot bigint, tries_left int)
language plpgsql
security definer
set search_path = public
as $$
declare
  r waitlist%rowtype;
begin
  select * into r from waitlist where waitlist.email = lower(trim(p_email)) for update;

  if not found or r.code_hash is null or r.code_expires_at <= now() or r.code_attempts >= 5 then
    return query select 'expired'::text, null::text, null::bigint, 0; return;
  end if;

  if r.code_hash <> p_code_hash then
    update waitlist set code_attempts = code_attempts + 1 where id = r.id;
    return query select 'wrong'::text, null::text, null::bigint, 4 - r.code_attempts; return;
  end if;

  update waitlist
    set confirmed_at = coalesce(confirmed_at, now()), code_hash = null, code_expires_at = null, code_attempts = 0
    where id = r.id
    returning * into r;

  return query select 'ok'::text, r.name,
    (select count(*) from waitlist w where w.confirmed_at is not null and (w.confirmed_at, w.id) <= (r.confirmed_at, r.id)),
    5;
end;
$$;

-- Server only (secret key = service_role). Not callable with the public key.
revoke all on function public.join_waitlist(text, text, text, text) from public, anon, authenticated;
revoke all on function public.verify_waitlist(text, text) from public, anon, authenticated;
grant execute on function public.join_waitlist(text, text, text, text) to service_role;
grant execute on function public.verify_waitlist(text, text) to service_role;
