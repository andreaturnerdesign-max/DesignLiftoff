require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const store = require('./store');
const access = require('./access');
const { sendMagicLinkEmail } = require('./mailer');

// ---------------------------------------------------------------------------
// Config (from environment — see .env.example)
// ---------------------------------------------------------------------------
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'liftoff_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAGIC_LINK_TTL = '15m';
const MAGIC_LINK_COOLDOWN_MS = 60 * 1000; // 1 request per email per minute

// The public URL this app is served at, used to build the link inside the
// sign-in email (e.g. "https://design-liftoff.onrender.com"). No trailing
// slash.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // unset = feature off
const SHOPIFY_PRODUCT_IDS = (process.env.SHOPIFY_PRODUCT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!SESSION_SECRET || SESSION_SECRET.includes('replace-this')) {
  console.error('ERROR: Set a real SESSION_SECRET in your .env file. See .env.example.');
  process.exit(1);
}
if (!APP_BASE_URL) {
  console.error('ERROR: Set APP_BASE_URL in your .env file (your app\'s public URL, no trailing slash).');
  process.exit(1);
}
if (access.STATIC_ALLOWED.length === 0 && !SHOPIFY_WEBHOOK_SECRET) {
  console.warn(
    'WARNING: ALLOWED_EMAILS is empty and Shopify granting is not configured. ' +
    'Nobody will be able to sign in. Set at least one of ALLOWED_EMAILS or SHOPIFY_WEBHOOK_SECRET.'
  );
}

const app = express();

// ---------------------------------------------------------------------------
// Shopify webhook — grants access automatically on a matching purchase.
// Registered BEFORE the global JSON body parser below: Shopify's webhook
// signature must be verified against the exact raw request body, so this
// route parses the body itself (as a raw Buffer) instead of letting
// express.json() parse it first.
// ---------------------------------------------------------------------------
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return false;
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body) // raw Buffer, must match byte-for-byte what Shopify sent
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch (e) {
    return false; // length mismatch etc. - definitely not a valid match
  }
}

app.post(
  '/webhooks/shopify/orders',
  express.raw({ type: 'application/json', limit: '2mb' }),
  (req, res) => {
    if (!SHOPIFY_WEBHOOK_SECRET) {
      console.warn('Shopify webhook received, but SHOPIFY_WEBHOOK_SECRET is not set - ignoring.');
      return res.status(501).json({ error: 'shopify_not_configured' });
    }
    if (!verifyShopifyWebhook(req)) {
      console.warn('Shopify webhook signature did not match - check SHOPIFY_WEBHOOK_SECRET matches Shopify exactly.');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    let order;
    try {
      order = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      console.error('Shopify webhook body was not valid JSON:', e.message);
      return res.status(400).json({ error: 'invalid_json' });
    }

    // Acknowledge immediately - Shopify retries aggressively on slow/failed
    // responses, and the rest of this is just bookkeeping.
    res.status(200).json({ ok: true });

    console.log('Shopify webhook verified OK. Order:', order.name || order.id);

    const email = order.email || (order.customer && order.customer.email);
    if (!email) {
      console.warn('Shopify order had no email field - cannot grant access. Order:', order.id);
      return;
    }

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const orderProductIds = lineItems.map((li) => String(li.product_id));
    console.log('Order', order.name || order.id, 'email:', email, 'product IDs:', orderProductIds, 'configured to match:', SHOPIFY_PRODUCT_IDS.length ? SHOPIFY_PRODUCT_IDS : '(any product)');

    const purchasedConfiguredProduct =
      SHOPIFY_PRODUCT_IDS.length === 0 || // no product restriction set = any paid order qualifies
      orderProductIds.some((id) => SHOPIFY_PRODUCT_IDS.includes(id));

    if (purchasedConfiguredProduct) {
      access
        .grantFromPurchase(email, {
          orderId: order.id,
          orderName: order.name,
          productIds: lineItems.map((li) => li.product_id),
        })
        .then(() => console.log('Granted access to', email, 'from order', order.name || order.id))
        .catch((err) => console.error('Failed to record Shopify-granted access:', err));
    } else {
      console.log('Order', order.name || order.id, 'did not match any configured product ID - no access granted.');
    }
  }
);


app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function issueSession(res, email) {
  const token = jwt.sign({ email, purpose: 'session' }, SESSION_SECRET, { expiresIn: '12h' });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development', // requires HTTPS in production
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function getSessionEmail(req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    if (!payload || payload.purpose !== 'session' || !payload.email) return null;
    if (!access.isAllowed(payload.email)) return null; // re-checked every request
    return payload.email;
  } catch (e) {
    return null; // expired or tampered
  }
}

function requireAuth(req, res, next) {
  const email = getSessionEmail(req);
  if (!email) {
    return res.redirect('/login.html');
  }
  req.userEmail = email;
  next();
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

// Login page is now a plain static file (no server-side templating needed
// since there's no client-side secret like a Google Client ID to inject).
app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));

// Simple in-memory cooldown so one email address can't be used to spam
// itself (or someone else) with sign-in emails. Resets if the server
// restarts - fine for this app's scale; a real rate limiter would use the
// same per-user store if this ever needs to be more robust.
const lastMagicLinkSentAt = new Map();

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Step 1: visitor submits their email. We only ever send a generic
// response ("if that email is approved, a link is on its way") regardless
// of whether the email is actually on the allowlist - this stops someone
// from using this form to probe which emails are/aren't approved.
app.post('/auth/magic-link', async (req, res) => {
  const genericReply = () =>
    res.json({ ok: true, message: 'If that email is approved, a sign-in link is on its way.' });

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const lastSent = lastMagicLinkSentAt.get(email);
  if (lastSent && Date.now() - lastSent < MAGIC_LINK_COOLDOWN_MS) {
    return genericReply(); // still generic - don't confirm/deny anything via timing either
  }
  lastMagicLinkSentAt.set(email, Date.now());

  if (!access.isAllowed(email)) {
    console.log('Magic link requested for a non-allowed email:', email);
    return genericReply();
  }

  const token = jwt.sign({ email, purpose: 'magic-link' }, SESSION_SECRET, { expiresIn: MAGIC_LINK_TTL });
  const link = `${APP_BASE_URL}/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

  try {
    await sendMagicLinkEmail(email, link);
    console.log('Magic link sent to', email);
  } catch (e) {
    // Still reply generically to the visitor - the real problem (bad SMTP
    // config, etc.) belongs in the server logs, not exposed to visitors.
    console.error('Failed to send magic link email:', e.message);
  }
  return genericReply();
});

// Step 2: visitor clicks the link from their email. Verifies the token is
// genuine, unexpired, and still on the allowlist (in case access was
// revoked in the few minutes since the email was sent), then signs them in.
app.get('/auth/magic-link/verify', (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/login.html?error=1');

  let payload;
  try {
    payload = jwt.verify(token, SESSION_SECRET);
  } catch (e) {
    return res.redirect('/login.html?error=1'); // expired or tampered
  }
  if (!payload || payload.purpose !== 'magic-link' || !payload.email) {
    return res.redirect('/login.html?error=1');
  }
  if (!access.isAllowed(payload.email)) {
    return res.redirect('/login.html?denied=1');
  }

  issueSession(res, payload.email);
  res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/login.html');
});

app.get('/auth/session', (req, res) => {
  const email = getSessionEmail(req);
  res.json({ authenticated: !!email, email: email || null });
});

// ---------------------------------------------------------------------------
// Per-user data API (projects, checklist progress, theme, onboarding state)
// ---------------------------------------------------------------------------
// Keys are scoped to the signed-in user automatically (from the session,
// never from the request body/URL), so one user can never read or write
// another user's data. This is what lets progress follow a user across
// devices instead of living only in one browser's localStorage.
const KEY_PATTERN = /^[a-zA-Z0-9:_-]{1,200}$/;

app.get('/api/kv/:key', requireAuth, async (req, res) => {
  if (!KEY_PATTERN.test(req.params.key)) return res.status(400).json({ error: 'invalid_key' });
  try {
    const value = await store.get(req.userEmail, req.params.key);
    if (value === null) return res.status(404).json({ error: 'not_found' });
    res.json({ key: req.params.key, value });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/kv/:key', requireAuth, async (req, res) => {
  if (!KEY_PATTERN.test(req.params.key)) return res.status(400).json({ error: 'invalid_key' });
  const value = req.body && req.body.value;
  if (typeof value !== 'string') return res.status(400).json({ error: 'value_must_be_string' });
  if (value.length > 2_000_000) return res.status(413).json({ error: 'value_too_large' });
  try {
    await store.set(req.userEmail, req.params.key, value);
    res.json({ key: req.params.key, value });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/kv/:key', requireAuth, async (req, res) => {
  if (!KEY_PATTERN.test(req.params.key)) return res.status(400).json({ error: 'invalid_key' });
  try {
    await store.delete(req.userEmail, req.params.key);
    res.json({ key: req.params.key, deleted: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// Protected app + public static assets
// ---------------------------------------------------------------------------

// Manifest, service worker, and icons are needed before/without sign-in
// (e.g. for the browser's install prompt) and aren't sensitive, so they're
// public. The app itself (app.html, served at "/") requires a valid session.
app.use('/manifest.json', express.static(path.join(__dirname, 'public', 'manifest.json')));
app.use('/sw.js', express.static(path.join(__dirname, 'public', 'sw.js')));
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.listen(PORT, () => {
  console.log(`Design Liftoff backend running on http://localhost:${PORT}`);
});
