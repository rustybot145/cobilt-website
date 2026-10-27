# Cobilt website

Waitlist site for **Cobilt**: start an online business from scratch, with a pod of founders who show up for you every day.

## Run it

```bash
npm start            # or: node server.js
```

Open http://localhost:4321. No dependencies, Node 18 or newer.

| Env var | Default     | What it does                                        |
|---------|-------------|-----------------------------------------------------|
| `PORT`  | `4321`      | Port to listen on                                   |
| `HOST`  | `127.0.0.1` | Set to `0.0.0.0` to accept outside connections      |

## What's inside

```
server.js          Static file server + POST /api/waitlist
public/
  index.html       The page
  styles.css       All styles (brand tokens at the top)
  main.js          Background film, scroll reveals, Bolt chat demo, waitlist quiz
  scenes/          Film artwork (alone.jpg, crew.jpg)
data/waitlist.json Signups (created on first signup, git-ignored)
```

## Waitlist API

`POST /api/waitlist` with JSON `{ "email", "name", "location" }`.

- Returns `{ position }` (201), or `{ position, existing: true }` (200) when the email is already on the list. Their details are updated.
- Each entry is saved with `perkMonths: 2`, the free months of Bolt AI promised to waitlist members.
- Limited to 10 signups per IP every 10 minutes. Bodies over 10 KB are rejected.

## Security

- Static files are only served from `public/`, only for known file types. Path traversal and malformed URLs are rejected.
- Every response has a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff` and a referrer policy.
- Signups are written atomically (temp file, then rename).
- The page only ever writes user input with `textContent`, never as HTML.

## Before going live

The JSON file is for local use. For production, move signups into the app's database (planned: a Supabase `waitlist` table with insert-only access from the site) so the free months apply when someone signs up with the same email.
