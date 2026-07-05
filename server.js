require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const store = require('./store');
const access = require('./access');

// ---------------------------------------------------------------------------
// Config (from environment — see .env.example)
// ---------------------------------------------------------------------------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE = 'liftoff_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // unset = feature off
const SHOPIFY_PRODUCT_IDS = (process.env.SHOPIFY_PRODUCT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes('YOUR_GOOGLE_CLIENT_ID')) {
  console.error('ERROR: Set GOOGLE_CLIENT_ID in your .env file. See .env.example.');
  process.exit(1);
}
if (!SESSION_SECRET || SESSION_SECRET.includes('replace-this')) {
  console.error('ERROR: Set a real SESSION_SECRET in your .env file. See .env.example.');
  process.exit(1);
}
if (access.STATIC_ALLOWED.length === 0 && !SHOPIFY_WEBHOOK_SECRET) {
  console.warn(
    'WARNING: ALLOWED_EMAILS is empty and Shopify granting is not configured. ' +
    'Nobody will be able to sign in. Set at least one of ALLOWED_EMAILS or SHOPIFY_WEBHOOK_SECRET.'
  );
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
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
    if (!SHOPIFY_WEBHOOK_SECRET) return res.status(501).json({ error: 'shopify_not_configured' });
    if (!verifyShopifyWebhook(req)) return res.status(401).json({ error: 'invalid_signature' });

    let order;
    try {
      order = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ error: 'invalid_json' });
    }

    // Acknowledge immediately - Shopify retries aggressively on slow/failed
    // responses, and the rest of this is just bookkeeping.
    res.status(200).json({ ok: true });

    const email = order.email || (order.customer && order.customer.email);
    if (!email) return;

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const purchasedConfiguredProduct =
      SHOPIFY_PRODUCT_IDS.length === 0 || // no product restriction set = any paid order qualifies
      lineItems.some((li) => SHOPIFY_PRODUCT_IDS.includes(String(li.product_id)));

    if (purchasedConfiguredProduct) {
      access
        .grantFromPurchase(email, {
          orderId: order.id,
          orderName: order.name,
          productIds: lineItems.map((li) => li.product_id),
        })
        .catch((err) => console.error('Failed to record Shopify-granted access:', err));
    }
  }
);

app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function issueSession(res, email) {
  const token = jwt.sign({ email }, SESSION_SECRET, { expiresIn: '12h' });
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
    if (!payload || !payload.email) return null;
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

// Serve login.html with the real Google Client ID injected (keeps the ID out
// of the static file / any client-side source control diff).
app.get('/login.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'login.html');
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load login page.');
    res.type('html').send(html.replace('__GOOGLE_CLIENT_ID__', GOOGLE_CLIENT_ID));
  });
});

// Verifies the Google ID token SERVER-SIDE (this is the part a purely
// client-side check can't do safely) and issues a signed, httpOnly session
// cookie only if the verified email is on the allowlist.
app.post('/auth/google', async (req, res) => {
  const credential = req.body && req.body.credential;
  if (!credential) return res.status(400).json({ ok: false, error: 'missing_credential' });

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }

  const payload = ticket.getPayload();
  const email = payload && payload.email ? payload.email.toLowerCase() : null;
  const emailVerified = payload && payload.email_verified;

  if (!email || !emailVerified) {
    return res.status(401).json({ ok: false, error: 'unverified_email' });
  }
  if (!access.isAllowed(email)) {
    return res.status(403).json({ ok: false, error: 'not_allowed' });
  }

  issueSession(res, email);
  res.json({ ok: true, email });
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
