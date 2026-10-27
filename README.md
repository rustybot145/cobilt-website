# Cobilt website

Waitlist site for **Cobilt**: start an online business from scratch, with a pod of founders who show up for you every day.

## Run it

```bash
npm start            # or: node server.js
```

Open http://localhost:4321. No dependencies, Node 22.9 or newer.

| Env var | Default     | What it does                                        |
|---------|-------------|-----------------------------------------------------|
| `PORT`  | `4321`      | Port to listen on                                   |
| `HOST`  | `127.0.0.1` | Set to `0.0.0.0` to accept outside connections      |
| `SUPABASE_URL` | none | Your Supabase project URL                    |
| `SUPABASE_SECRET_KEY` | none | Secret key (`sb_secret_…`). Server-only     |
| `TRUST_PROXY` | off | `1` behind a host/proxy so rate limits use the real visitor IP |
| `RESEND_API_KEY` | none | Sends confirm emails                         |
| `EMAIL_FROM` | `Cobilt <hello@getcobilt.app>` | Sender (domain must be verified in Resend) |

Put these in `.env` (copy `.env.example`). Without the Supabase pair, signups go to `data/waitlist.json`.

## What's inside

```
server.js          Static file server + POST /api/waitlist
public/
  index.html       The page
  joined.html      "You're in" page shown after the code is confirmed (/joined)
  joined.js        Fills in name, spot and email; Share button
  countries.json   Country list for the quiz (also used by the server to validate)
  styles.css       All styles (brand tokens at the top)
  main.js          Background film, scroll reveals, Bolt chat demo, waitlist quiz
  scenes/          Film artwork (alone.jpg, crew.jpg)
supabase/
  waitlist.sql     Table + join_waitlist() function. Run once in the SQL Editor
data/waitlist.json Local signups when Supabase isn't set (git-ignored)
```

## Waitlist flow

Signups are confirmed with a 6-digit email code, so nobody can join with someone else's address.

1. `POST /api/waitlist` with `{ "email", "name", "location" }` (location is a country from `public/countries.json`) emails a code. It always answers `{ status: "pending" }`, so it never reveals whether an email is already on the list.
2. `POST /api/waitlist/verify` with `{ "email", "code" }` confirms them and returns `{ name, email, position }`. The site then opens `/joined`: their spot, 2 free months of Bolt AI, mystery bonuses, and "coming soon".

- Nothing is revealed or changed without the right code. A confirmed person's name and country can't be overwritten.
- Codes expire after 10 minutes and allow 5 wrong tries. Only a SHA-256 hash (salted with the email) is stored.
- At most 1 code email per address per minute and 5 per day, plus 20 API calls per IP every 10 minutes.
- Only confirmed signups get a spot and the 2 free months of Bolt AI. Unconfirmed ones are deleted after 7 days.
- Emails are sent with [Resend](https://resend.com). Without `RESEND_API_KEY`, the code is printed in the server log so you can test locally.

## Security

- The Supabase functions can only be called with the **secret** key, which lives only on the server. The public key can't read the table or call them.
- Static files are only served from `public/`, only for known file types. Path traversal and malformed URLs are rejected.
- Every response has a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, HSTS, a permissions policy and a referrer policy. API responses aren't cached.
- Request bodies are capped at 10 KB, and slow connections are dropped.
- Signups are written atomically (temp file, then rename).
- The page only writes user input with `textContent`, never as HTML. Names in emails are HTML-escaped.

## Before going live

Run `supabase/waitlist.sql` in your Supabase project, verify your domain in Resend, set the env vars above, and deploy. When the app launches, it can check the `waitlist` table by email to turn on the free months.
