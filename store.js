// A deliberately simple per-user key-value store, backed by one JSON file
// per signed-in user under data/users/. No external database service and
// no native dependencies to compile — easy to deploy anywhere Node runs.
//
// This is sized for a small team's checklist data, not high-concurrency
// multi-tenant traffic. If this app ever needs to scale well beyond that,
// swap this module for a real database (Postgres, etc.) behind the same
// get/set/delete interface — nothing else in server.js would need to change.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'users')
  : path.join(__dirname, 'data', 'users');
fs.mkdirSync(DATA_DIR, { recursive: true });

function fileFor(email) {
  const safe = email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

// Serializes reads/writes per user so two quick saves in a row can't
// clobber each other (simple read-modify-write race).
const queues = new Map();
function withLock(email, fn) {
  const key = email.toLowerCase();
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

async function readAll(email) {
  try {
    const raw = await fsp.readFile(fileFor(email), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function writeAll(email, data) {
  const file = fileFor(email);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, file); // atomic on the same filesystem
}

async function get(email, key) {
  const data = await readAll(email);
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
}

function set(email, key, value) {
  return withLock(email, async () => {
    const data = await readAll(email);
    data[key] = value;
    await writeAll(email, data);
    return value;
  });
}

function del(email, key) {
  return withLock(email, async () => {
    const data = await readAll(email);
    delete data[key];
    await writeAll(email, data);
  });
}

module.exports = { get, set, delete: del };
