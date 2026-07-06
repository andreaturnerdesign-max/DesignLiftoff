# Design Liftoff — backend

This replaces the earlier client-side-only sign-in check with a real one:
a small Node.js server that verifies each visitor by emailing them a
one-time sign-in link ("magic link"), checks the email against your
allowlist, and only then hands over the checklist app. The email list and
the check both live on the server — nobody can read them from "view
source," and there's no client-side check to bypass with dev tools.

No third-party account (Google, Microsoft, etc.) is required — anyone with
an email address you've approved can sign in.

**Note:** because this needs to run a server, it can no longer be hosted as
plain static files (like on a basic web host / GitHub Pages). It needs
somewhere that runs Node.js — see "Deploying" below for free/cheap options.

## How it works

- `GET /login.html` — sign-in screen with an email field.
- `POST /auth/magic-link` — checks the submitted email against
  `ALLOWED_EMAILS` (and any Shopify-granted emails — see below). If it's
  approved, emails a one-time link that's valid for 15 minutes. Always
  replies with the same generic "check your email" message either way, so
  the form can't be used to test which emails are/aren't on the list.
- `GET /auth/magic-link/verify` — when the visitor clicks that link, this
  verifies it's genuine and unexpired, re-checks the allowlist (in case
  access was revoked in the meantime), and — only if it all checks out —
  sets a signed, `httpOnly` session cookie the browser can't read or forge.
- `GET /` — serves the actual checklist app (`app.html`), but only if the
  session cookie is present and valid. Otherwise it redirects to
  `/login.html`.
- `GET /auth/logout` — clears the session.
- The allowlist is re-checked on *every* request (not just at login), so
  removing someone from `ALLOWED_EMAILS` and restarting the server takes
  effect immediately, even for people already signed in.

## Local setup

Requires [Node.js](https://nodejs.org) 18 or newer.

```
npm install
cp .env.example .env
```

Then edit `.env`:

- `ALLOWED_EMAILS` — comma-separated emails to let in.
- `SESSION_SECRET` — a long random string. Generate one with:
  ```
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `APP_BASE_URL` — your app's public URL (no trailing slash), used to
  build the link inside the sign-in email. For local testing this is
  `http://localhost:3000`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — how
  outgoing sign-in emails get sent. Any SMTP provider works:
  - **Quickest to test with:** a personal Gmail account + an
    [App Password](https://myaccount.google.com/apppasswords) (`SMTP_HOST=smtp.gmail.com`,
    `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER` = your Gmail address,
    `SMTP_PASS` = the generated app password, not your regular password).
  - **Recommended for real use:** a transactional email service like
    [Resend](https://resend.com), [Postmark](https://postmarkapp.com), or
    [SendGrid](https://sendgrid.com) — all have free tiers and give you
    an SMTP host/username/password to plug in directly. These deliver
    more reliably than a personal email account, especially at any volume.

Run it:

```
npm start
```

Visit `http://localhost:3000` — you should land on the sign-in screen.

## Deploying

Any host that runs Node.js works. A few simple, low/no-cost options:

- **Render** (render.com) — connect this folder as a Web Service, build
  command `npm install`, start command `npm start`, add the three
  environment variables in its dashboard. Free tier available.
- **Railway** (railway.app) — similar: point it at this folder, set the
  environment variables, it detects Node automatically.
- **Fly.io** — `fly launch` in this folder, then `fly secrets set
  ALLOWED_EMAILS=... SESSION_SECRET=... APP_BASE_URL=... SMTP_HOST=...
  SMTP_USER=... SMTP_PASS=...`.
- **A VPS you already have** — copy this folder over, `npm install --production`,
  run it with a process manager like `pm2` or a `systemd` service, and put
  it behind Nginx/Caddy for HTTPS.

Whichever you pick:
1. Set all the environment variables from `.env.example` on the host
   (never commit `.env`), especially `APP_BASE_URL` matching the real
   deployed URL — sign-in links will be broken if this is wrong.
2. The app **must be served over HTTPS** in production — secure cookies
   require it, and you don't want sign-in links or session cookies
   traveling over plain HTTP anyway. Render/Railway/Fly give you this
   automatically; a VPS needs a reverse proxy with a TLS certificate
   (Caddy does this with zero config, Let's Encrypt via certbot also
   works).

## What this does and doesn't cover

- Sign-in verification and the allowlist check happen entirely on the
  server now — this is real access control, not just a UI hint.
- Checklist progress now syncs across devices. Projects, checked items,
  theme preference, and whether you've seen the welcome tour are all
  saved to the server per signed-in email address (in `data/users/`, one
  JSON file per person) and load automatically wherever that account signs
  in. The browser still keeps an instant local copy too, so the app feels
  fast and still works through brief network hiccups — but the server copy
  is now the source of truth across devices.
- **Back up `data/` if you care about this checklist data.** It's a plain
  folder on whatever host you deploy to — if you redeploy in a way that
  wipes the filesystem (common on some free tiers if there's no attached
  persistent volume), that data goes with it. Render/Railway/Fly all offer
  a persistent disk/volume option — attach one and point `DATA_DIR` (see
  below) at it if you want the data to survive redeploys.
- This uses simple JSON files rather than a full database server, which
  keeps deployment easy (no database to provision, no native modules to
  compile) and is plenty for a small team's checklist data. If this ever
  needs to handle many more people or heavier concurrent use, that storage
  layer (`store.js`) can be swapped for a real database like Postgres
  without changing anything else in `server.js` — ask if you'd like that
  upgrade later.
- Session cookies last 12 hours, then the visitor signs in again.
- Signing out clears the local browser cache of checklist data too (not
  just the session), so a shared computer can't show the next person who
  signs in a leftover copy of someone else's checklist.
- Sign-in links expire after **15 minutes** and can only be used once. A
  given email can only request a new link once per minute, to prevent the
  form from being used to spam someone's inbox.
- Because there's no password, **whoever controls an approved email inbox
  can sign in as that person** — same as most "magic link" or "forgot
  password" flows elsewhere. This is a reasonable trade-off for a small
  team checklist tool; just be mindful of that if an approved email
  address is a shared/generic inbox rather than one specific person's.

## Optional: choosing where data is stored

By default, data is saved under `data/users/` next to the server code. To
store it somewhere else (e.g. a mounted persistent volume on your host),
set `DATA_DIR` in `.env` to an absolute path — see `.env.example`.

## Optional: grant access automatically via Shopify purchases

Instead of (or in addition to) manually listing emails in `ALLOWED_EMAILS`,
you can have the app grant access automatically whenever someone buys a
specific product on your Shopify store — no manual list-editing needed.

**How it works:** Shopify sends your server a notification ("webhook")
every time an order is paid. Your server checks that the notification is
genuinely from Shopify (a cryptographic signature check — this can't be
faked by a random visitor), looks at what was purchased, and if it matches
the product you configured, adds that customer's email to a separate
allowlist file (`data/shopify-allowed-emails.json`) automatically. It
takes effect on their very next sign-in attempt.

### Setup — Shopify side

1. In your Shopify admin, go to **Settings → Notifications**, scroll to
   **Webhooks**, and click **Create webhook**.
   - Event: **Order payment** (topic `orders/paid`)
   - Format: JSON
   - URL: `https://your-deployed-url.com/webhooks/shopify/orders`
2. After creating it, Shopify shows a **webhook signing secret** — copy it.
   (If your Shopify plan/setup only exposes this through a custom app
   instead of the Notifications page, create a custom app under
   **Settings → Apps and sales channels → Develop apps**, and set up the
   same `orders/paid` webhook there; the signing secret is under that
   app's API credentials.)
3. Find the numeric **product ID** for whichever product should grant
   access (Shopify admin → Products → open the product → the ID is in the
   page URL, e.g. `.../products/1234567890`).

### Setup — this app's side

In `.env`:
```
SHOPIFY_WEBHOOK_SECRET=<the signing secret from step 2>
SHOPIFY_PRODUCT_IDS=<the product ID from step 3>
```
Leaving `SHOPIFY_PRODUCT_IDS` blank grants access on **any** paid order
from your store, regardless of what was purchased — only do this if
that's actually what you want.

Redeploy with those two variables set, place a test order (or use
Shopify's "Send test notification" button on the webhook), and check that
the buyer's email shows up in `data/shopify-allowed-emails.json` on the
server.

### Notes

- This only **grants** access on purchase — it doesn't automatically
  revoke it on refunds or cancellations. If you need that too (e.g. for a
  subscription-style product), a similar webhook can be added for
  `refunds/create` or `orders/cancelled` — ask if you'd like that wired up.
- Emails added this way don't affect `ALLOWED_EMAILS` — that list still
  works exactly as before for people you want to add by hand (yourself,
  teammates, etc.).
- If `SHOPIFY_WEBHOOK_SECRET` isn't set, this route is inactive (returns
  an error if anything hits it) and the app behaves exactly as it did
  before — this feature is entirely optional.
