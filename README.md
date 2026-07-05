// Combines two sources of "who's allowed in":
//   1. The static ALLOWED_EMAILS env var (your manually-set list).
//   2. A dynamic list, stored in a JSON file, that Shopify purchases can
//      grant access to automatically (see the /webhooks/shopify/orders
//      route in server.js). Kept separate from ALLOWED_EMAILS so a
//      redeploy that changes your .env doesn't wipe out purchase-granted
//      access, and so you can see at a glance which emails came from a
//      purchase vs. which you added by hand.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const STATIC_ALLOWED = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const BASE_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DYNAMIC_FILE = path.join(BASE_DATA_DIR, 'shopify-allowed-emails.json');
fs.mkdirSync(BASE_DATA_DIR, { recursive: true });

let dynamicCache = null;

function loadDynamic() {
  if (dynamicCache) return dynamicCache;
  try {
    dynamicCache = JSON.parse(fs.readFileSync(DYNAMIC_FILE, 'utf8'));
  } catch (e) {
    dynamicCache = {};
  }
  return dynamicCache;
}

function isAllowed(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  if (STATIC_ALLOWED.includes(e)) return true;
  return Object.prototype.hasOwnProperty.call(loadDynamic(), e);
}

// Records that a purchase grants this email access. `meta` is just for
// your own reference if you ever open the JSON file (order id, product
// ids, etc.) - it isn't used for anything else.
async function grantFromPurchase(email, meta) {
  const e = email.toLowerCase();
  const data = loadDynamic();
  data[e] = Object.assign({ grantedAt: new Date().toISOString() }, meta);
  await fsp.writeFile(DYNAMIC_FILE, JSON.stringify(data, null, 2), 'utf8');
  dynamicCache = data;
}

// Optional: revoke a purchase-granted email (e.g. on refund/cancellation).
// Does nothing to STATIC_ALLOWED - manually-added emails are never
// touched by this.
async function revokePurchaseGrant(email) {
  const e = email.toLowerCase();
  const data = loadDynamic();
  if (Object.prototype.hasOwnProperty.call(data, e)) {
    delete data[e];
    await fsp.writeFile(DYNAMIC_FILE, JSON.stringify(data, null, 2), 'utf8');
    dynamicCache = data;
  }
}

module.exports = { isAllowed, grantFromPurchase, revokePurchaseGrant, STATIC_ALLOWED };
