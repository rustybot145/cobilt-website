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
| `SUPABASE_KEY` | none | Publishable (or anon) key. Never the secret key |
| `RESEND_API_KEY` | none | Sends confirm emails                         |
| `EMAIL_FROM` | `Cobilt <hello@getcobilt.app>` | Sender (domain must be verified in Resend) |
| `BASE_URL` | `http://localhost:4321` | Site address used in the confirm link |

Put these in `.env` (copy `.env.example`). Without the Supabase pair, signups go to `data/waitlist.json`.

## What's inside

```
server.js          Static file server + POST /api/waitlist
public/
  index.html       The page
  styles.css       All styles (brand tokens at the top)
  main.js          Background film, scroll reveals, Bolt chat demo, waitlist quiz
  scenes/          Film artwork (alone.jpg, crew.jpg)
supabase/
  waitlist.sql     Table + join_waitlist() function. Run once in the SQL Editor
data/waitlist.json Local signups when Supabase isn't set (git-ignored)
```

## Waitlist flow

Signups are confirmed by email, so nobody can join with someone else's address.

1. `POST /api/waitlist` with `{ "email", "name", "location" }` saves the person as pending and emails a **Confirm my spot** link (`/?confirm=<token>`, valid 24 hours). Returns `{ status: "pending" }`, or `{ status: "confirmed", position }` if they already confirmed.
2. The link opens the site, which calls `POST /api/waitlist/confirm` with `{ token }` and shows **Joined** with their spot in line.

- Only confirmed signups get a spot and the 2 free months of Bolt AI. Unconfirmed ones are deleted after 7 days.
- At most one confirm email per address per minute, and 10 API calls per IP every 10 minutes.
- Only a SHA-256 hash of each token is stored.
- Emails are sent with [Resend](https://resend.com). Without `RESEND_API_KEY`, the confirm link is printed in the server log so you can test locally.

## Security

- Static files are only served from `public/`, only for known file types. Path traversal and malformed URLs are rejected.
- Every response has a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and a referrer policy.
- Signups are written atomically (temp file, then rename).
- The referrer policy is `no-referrer` so confirm links never leak to other sites.
- Names in emails are HTML-escaped.
- The page only ever writes user input with `textContent`, never as HTML.

## Before going live

Run `supabase/waitlist.sql` in your Supabase project, verify your domain in Resend, set the env vars above (with `BASE_URL` set to the live site), and deploy. When the app launches, it can check the `waitlist` table by email to turn on the free months.
