// Cradlelog: feed/nappy log. Single-file server: static PWA + JSON API over SQLite.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8080);
const ENV_PASSCODE = process.env.CRADLELOG_PASSCODE || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';        // read the client address from X-Forwarded-For (one reverse proxy)
const TZ = process.env.CRADLELOG_TZ || 'Europe/London'; // times written into alerts
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`;
const SECURE = PUBLIC_URL.startsWith('https://');
const MIN_PASSCODE = 8;
const SESSION_DAYS = 180;
if (ENV_PASSCODE && ENV_PASSCODE.length < MIN_PASSCODE) {
  console.error(`CRADLELOG_PASSCODE must be at least ${MIN_PASSCODE} characters.`);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'cradlelog.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    ml INTEGER,
    side TEXT,
    poo INTEGER NOT NULL DEFAULT 0,
    wee INTEGER NOT NULL DEFAULT 0,
    sick INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS entries_ts ON entries(ts);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL); -- token = sha256 of the cookie value
`);
// Columns added after launch. Each runs once on an existing database.
const cols = new Set(db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name));
if (!cols.has('open')) db.exec('ALTER TABLE entries ADD COLUMN open INTEGER NOT NULL DEFAULT 0'); // started, amount to come
if (!cols.has('end_ts')) db.exec('ALTER TABLE entries ADD COLUMN end_ts TEXT');                   // when a finished feed ended; null = length not recorded
if (!cols.has('progress_ts')) db.exec('ALTER TABLE entries ADD COLUMN progress_ts TEXT');           // open feeds: when the amount last went up
if (!cols.has('made_ml')) db.exec('ALTER TABLE entries ADD COLUMN made_ml INTEGER');                 // bottles: total size made up
if (!cols.has('weight_g')) db.exec('ALTER TABLE entries ADD COLUMN weight_g INTEGER');           // weigh-ins
// "Who logged it" was tried and dropped (2026-11-06): remove the names entirely, not just hide them.
const hadNames = cols.has('by_name')
  || db.prepare('PRAGMA table_info(push_subs)').all().some((c) => c.name === 'name');
if (cols.has('by_name')) db.exec('ALTER TABLE entries DROP COLUMN by_name');
// Phones that turned on feed alerts.
db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, created_at TEXT NOT NULL
)`);
if (db.prepare('PRAGMA table_info(push_subs)').all().some((c) => c.name === 'name')) db.exec('ALTER TABLE push_subs DROP COLUMN name');
// Dropped columns linger in free pages until the file is rebuilt; rebuild once so the names are really gone.
if (hadNames) db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

// Push keys are generated once and kept, so phones that subscribed stay subscribed across deploys.
if (!getSetting('vapid')) setSetting('vapid', JSON.stringify(webpush.generateVAPIDKeys()));
const VAPID = JSON.parse(getSetting('vapid'));
webpush.setVapidDetails(process.env.VAPID_SUBJECT || (SECURE ? PUBLIC_URL : 'mailto:admin@localhost.invalid'), VAPID.publicKey, VAPID.privateKey);

// ---------- auth: one shared family passcode ----------
function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pass, salt, 32).toString('hex')}`;
}
// A passcode from the environment is hashed once at start so every check costs the same as a stored one.
const ENV_HASH = ENV_PASSCODE ? hashPass(ENV_PASSCODE) : '';
const passHash = () => ENV_HASH || getSetting('passcode');
function checkPass(pass) {
  const stored = passHash();
  if (!stored || typeof pass !== 'string' || pass.length > 256) return false;
  const [salt] = stored.split(':');
  return safeEq(hashPass(pass, salt), stored);
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const needsSetup = () => !passHash();
// Bottle sizes (ml) offered as "bottle made" when logging a bottle; 90 and 120 until changed.
function feedSizes() {
  try {
    const v = JSON.parse(getSetting('feedSizes'));
    if (Array.isArray(v) && v.length) return v;
  } catch {}
  return [90, 120];
}
// Family-wide settings, shared by every phone.
const settingsOut = () => ({
  babyName: getSetting('babyName') || '',
  birth: getSetting('birth'),
  hideBreast: getSetting('hideBreast') === '1',
  feedMin: Number(getSetting('feedMin') ?? 3), // hours between feeds, used for the "next feed" countdown
  feedMax: Number(getSetting('feedMax') ?? 4),
  feedSizes: feedSizes(),
});

// Sessions: the cookie holds a random token; only its hash is stored, so a copy of the database can't be used to sign in.
const COOKIE = SECURE ? '__Host-cradlelog' : 'cradlelog';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
// First run with no passcode: whoever opens the app first is asked to choose it.
if (needsSetup()) console.log('\nNo passcode is set yet. Open the app now: the first person to visit is asked to choose it.\n');

function newSession() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(sha(token), new Date().toISOString());
  return token;
}
const cookieToken = (req) => new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '')?.[1] || null;
function authed(req) {
  const t = cookieToken(req);
  if (!t) return false;
  const row = db.prepare('SELECT created_at FROM sessions WHERE token = ?').get(sha(t));
  return !!row && Date.now() - new Date(row.created_at).getTime() < SESSION_DAYS * 86400000;
}
const sessionCookie = (token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${SECURE ? '; Secure' : ''}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE ? '; Secure' : ''}`;
function purgeSessions() {
  db.prepare('DELETE FROM sessions WHERE created_at < ?').run(new Date(Date.now() - SESSION_DAYS * 86400000).toISOString());
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}

// ---------- rate limits ----------
const buckets = new Map(); // key -> { n, reset }
function bump(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b;
}
function peek(key) {
  const b = buckets.get(key);
  return b && Date.now() <= b.reset ? b : null;
}
const retryAfter = (b) => Math.max(1, Math.ceil((b.reset - Date.now()) / 1000));
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // the address our own proxy saw, not one the client chose
  }
  return req.socket.remoteAddress || 'unknown';
}
const LOGIN_TRIES = 5, LOGIN_WINDOW = 15 * 60000;

// ---------- helpers ----------
class Bad extends Error {} // an error whose message is safe to show the client
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}
async function readJson(req) {
  if (Number(req.headers['content-length'] || 0) > 64 * 1024) throw new Bad('too large');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Bad('too large');
  }
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v;
  } catch { throw new Bad('bad request'); }
}
async function readText(req, max) {
  if (Number(req.headers['content-length'] || 0) > max) throw new Bad('That file is too large');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Bad('That file is too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
const version = () => {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return 'dev'; }
};

const MAX_FEED_MS = 60 * 60000;
// A bottle is unusable after an hour. A feed left open that long ends at the last time the amount went up
// (capped at the hour); if no amount was ever saved there's nothing to base a length on, so none is recorded.
function autoEndTs(startIso, progressIso) {
  if (!progressIso) return null;
  const cap = new Date(startIso).getTime() + MAX_FEED_MS;
  return new Date(Math.min(new Date(progressIso).getTime(), cap)).toISOString();
}
const KINDS = new Set(['bottle', 'breast', 'nappy', 'note', 'weight']);
const SIDES = new Set(['left', 'right', 'both']);
function cleanEntry(b) {
  const ts = new Date(b.ts);
  if (Number.isNaN(ts.getTime())) throw new Bad('bad time');
  if (!KINDS.has(b.kind)) throw new Bad('bad kind');
  const ml = b.ml === null || b.ml === undefined || b.ml === '' ? null : Math.round(Number(b.ml));
  if (ml !== null && (!Number.isFinite(ml) || ml < 0 || ml > 1000)) throw new Bad('bad ml');
  const made = b.kind !== 'bottle' || b.made_ml === null || b.made_ml === undefined || b.made_ml === '' ? null : Math.round(Number(b.made_ml));
  if (made !== null && (!Number.isFinite(made) || made < 1 || made > 1000)) throw new Bad('bad bottle size');
  const weight = b.kind === 'weight' ? Math.round(Number(b.weight_g)) : null;
  if (b.kind === 'weight' && !(weight >= 500 && weight <= 30000)) throw new Bad('Weight must be between 0.5 kg and 30 kg');
  const open = (b.kind === 'bottle' || b.kind === 'breast') && b.open ? 1 : 0;
  let end = null;
  if (!open && (b.kind === 'bottle' || b.kind === 'breast') && b.end_ts) {
    const d = new Date(b.end_ts);
    if (Number.isNaN(d.getTime())) throw new Bad('bad end time');
    end = d < ts ? null : d.toISOString(); // moved the start past the end: drop the length, keep the feed
  }
  return {
    end_ts: end,
    made_ml: made,
    weight_g: weight,
    ts: ts.toISOString(),
    kind: b.kind,
    ml: b.kind === 'bottle' || b.kind === 'breast' ? ml : null,
    side: b.kind === 'breast' && SIDES.has(b.side) ? b.side : null,
    poo: b.poo ? 1 : 0,
    wee: b.wee ? 1 : 0,
    sick: b.sick ? 1 : 0,
    note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null,
    open,
  };
}
// ---------- CSV import (the same columns the export writes; older exports without end_time work too) ----------
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(f); f = ''; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}
const MAX_IMPORT_ROWS = 20000;
function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Bad('That file has no entries in it');
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw new Bad(`Too many rows (the limit is ${MAX_IMPORT_ROWS})`);
  const head = rows[0].map((h) => h.trim().toLowerCase());
  if (!head.includes('time') || !head.includes('kind')) throw new Bad('That does not look like a Cradlelog export (it needs time and kind columns)');
  const col = (r, name) => { const i = head.indexOf(name); return i < 0 ? '' : (r[i] ?? '').trim(); };
  const yes = (v) => /^(yes|true|1)$/i.test(v);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO entries (id, ts, kind, ml, side, poo, wee, sick, note, open, weight_g, end_ts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
  const seen = new Map();
  let imported = 0, skipped = 0; const errors = [];
  db.exec('BEGIN');
  try {
    rows.slice(1).forEach((r, i) => {
      try {
        const note = col(r, 'note').replace(/^'(?=[=+\-@\t\r])/, '');
        const e = cleanEntry({
          ts: col(r, 'time'), kind: col(r, 'kind').toLowerCase(), ml: col(r, 'ml') === '' ? null : Number(col(r, 'ml')), side: col(r, 'side'),
          poo: yes(col(r, 'poo')), wee: yes(col(r, 'wee')), sick: yes(col(r, 'sick')), note, open: yes(col(r, 'in_progress')),
          end_ts: col(r, 'end_time') || null, weight_g: col(r, 'weight_g') === '' ? null : Number(col(r, 'weight_g')),
        });
        // The same rows always get the same id, so importing a file twice adds nothing the second time.
        const base = sha(`${e.ts}|${e.kind}|${e.ml}|${e.side}|${e.note}|${e.weight_g}|${e.poo}${e.wee}${e.sick}`).slice(0, 24);
        const n = (seen.get(base) || 0) + 1; seen.set(base, n);
        const r2 = ins.run(`imp-${base}-${n}`, e.ts, e.kind, e.ml, e.side, e.poo, e.wee, e.sick, e.note, e.open, e.weight_g, e.end_ts, now, now);
        if (r2.changes) imported++; else skipped++;
      } catch (err) {
        if (errors.length < 10) errors.push(`Row ${i + 2}: ${err instanceof Bad ? err.message : 'could not be read'}`);
        else if (errors.length === 10) errors.push('More rows could not be read');
        skipped++;
      }
    });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return { imported, skipped, errors };
}

const rowOut = (r) => ({ ...r, poo: !!r.poo, wee: !!r.wee, sick: !!r.sick, open: !!r.open, deleted: !!r.deleted });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Alerts only go to the browsers' own push services, so a signed-in user can't aim the server at another host.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
function pushEndpointOk(endpoint) {
  try {
    const u = new URL(endpoint);
    return endpoint.length <= 600 && u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443')
      && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname;
  res.setHeader('Cache-Control', 'no-store');
  const ip = clientIp(req);

  // Cross-site requests can't change anything: browsers say where a request came from.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'forbidden' });
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch {}
      if (host !== req.headers.host) return send(res, 403, { error: 'forbidden' });
    }
  }

  const flood = bump(`api:${ip}`, 60000);
  if (flood.n > 300) return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retryAfter(flood)) });

  if (p === '/api/version') return send(res, 200, { version: version() });

  // Signed-out visitors learn nothing about the family: no settings, no dates.
  if (p === '/api/session') {
    const ok = authed(req);
    return send(res, 200, ok ? { authed: true, setup: false, ...settingsOut() } : { authed: false, setup: needsSetup() });
  }

  if (p === '/api/setup' && req.method === 'POST') {
    const { passcode } = await readJson(req);
    // Only works while no passcode exists; the check and the write happen with no await between them.
    if (!needsSetup()) return send(res, 403, { error: 'This app has already been set up. Sign in instead.' });
    if (typeof passcode !== 'string' || passcode.length < MIN_PASSCODE || passcode.length > 256) {
      return send(res, 400, { error: `The passcode needs at least ${MIN_PASSCODE} characters` });
    }
    setSetting('passcode', hashPass(passcode));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(newSession()) });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const key = `login:${ip}`;
    const lock = peek(key);
    if (lock && lock.n >= LOGIN_TRIES) {
      return send(res, 429, { error: `Too many wrong passcodes. Try again in ${Math.ceil(retryAfter(lock) / 60)} minutes.` }, { 'Retry-After': String(retryAfter(lock)) });
    }
    const { passcode } = await readJson(req);
    if (!checkPass(passcode)) {
      bump(key, LOGIN_WINDOW);
      console.warn(`failed sign-in from ${ip}`);
      await new Promise((r) => setTimeout(r, 800));
      return send(res, 401, { error: 'Wrong passcode' });
    }
    buckets.delete(key);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(newSession()) });
  }

  if (!authed(req)) return send(res, 401, { error: 'Not signed in' });

  if (p === '/api/logout' && req.method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(cookieToken(req)));
    return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }

  if (p === '/api/settings' && req.method === 'PUT') {
    const b = await readJson(req);
    if (b.babyName !== undefined) {
      const name = typeof b.babyName === 'string' ? b.babyName.replace(/[\u0000-\u001f\u007f]/g, '').trim() : null;
      if (name === null || name.length > 40) return send(res, 400, { error: 'The name can be up to 40 characters' });
      setSetting('babyName', name);
    }
    if (b.birth !== undefined) {
      if (b.birth && !/^\d{4}-\d{2}-\d{2}$/.test(b.birth)) return send(res, 400, { error: 'bad date' });
      setSetting('birth', b.birth || '');
    }
    if (b.hideBreast !== undefined) setSetting('hideBreast', b.hideBreast ? '1' : '0');
    if (b.feedSizes !== undefined) {
      const v = b.feedSizes;
      if (!Array.isArray(v) || v.length > 12 || !v.every((n) => Number.isInteger(n) && n >= 1 && n <= 1000)) {
        return send(res, 400, { error: 'Feed sizes must be whole numbers of ml, up to 12 of them' });
      }
      setSetting('feedSizes', JSON.stringify([...new Set(v)].sort((a, c) => a - c)));
    }
    if (b.feedMin !== undefined || b.feedMax !== undefined) {
      const min = Number(b.feedMin), max = Number(b.feedMax);
      const ok = (h) => Number.isFinite(h) && h >= 0.5 && h <= 12;
      if (!ok(min) || !ok(max) || min > max) return send(res, 400, { error: 'Feed times must be between 30 minutes and 12 hours, shortest first' });
      setSetting('feedMin', String(min));
      setSetting('feedMax', String(max));
    }
    return send(res, 200, { ok: true });
  }

  if (p === '/api/entries' && req.method === 'GET') {
    const since = url.searchParams.get('since');
    autoEnd();
    const rows = since
      ? db.prepare('SELECT * FROM entries WHERE updated_at > ? ORDER BY ts').all(since)
      : db.prepare('SELECT * FROM entries WHERE deleted = 0 ORDER BY ts').all();
    return send(res, 200, { entries: rows.map(rowOut), settings: settingsOut(), now: new Date().toISOString() });
  }

  if (p === '/api/entries' && req.method === 'POST') {
    const b = await readJson(req);
    const e = cleanEntry(b);
    const id = typeof b.id === 'string' && /^[\w-]{8,64}$/.test(b.id) ? b.id : crypto.randomUUID();
    const now = new Date().toISOString();
    // When the amount last went up on an open feed (the end time if it's left open past an hour).
    const prev = db.prepare('SELECT ml, open, progress_ts FROM entries WHERE id = ?').get(id);
    const raised = e.ml != null && (prev?.ml == null || e.ml > prev.ml);
    let progress = e.open ? (raised ? now : prev?.progress_ts ?? null) : null;
    if (e.open && Date.now() - new Date(e.ts).getTime() >= MAX_FEED_MS) {
      e.open = 0; e.end_ts = autoEndTs(e.ts, progress); progress = null;
    }
    // Upsert keeps offline retries idempotent.
    db.prepare(`INSERT INTO entries (id, ts, kind, ml, made_ml, side, poo, wee, sick, note, open, weight_g, end_ts, progress_ts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, kind=excluded.kind, ml=excluded.ml, made_ml=excluded.made_ml, side=excluded.side,
        poo=excluded.poo, wee=excluded.wee, sick=excluded.sick, note=excluded.note, open=excluded.open,
        weight_g=excluded.weight_g, end_ts=excluded.end_ts, progress_ts=excluded.progress_ts, updated_at=excluded.updated_at, deleted=0`)
      .run(id, e.ts, e.kind, e.ml, e.made_ml, e.side, e.poo, e.wee, e.sick, e.note, e.open, e.weight_g, e.end_ts, progress, now, now);
    checkAlerts();
    return send(res, 200, rowOut(db.prepare('SELECT * FROM entries WHERE id = ?').get(id)));
  }

  const m = /^\/api\/entries\/([\w-]{8,64})$/.exec(p);
  if (m && req.method === 'DELETE') {
    db.prepare('UPDATE entries SET deleted = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), m[1]);
    return send(res, 200, { ok: true });
  }

  // ---- feed alerts (per phone) ----
  if (p === '/api/push/key') return send(res, 200, { publicKey: VAPID.publicKey });

  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const { subscription } = await readJson(req);
    const k = subscription?.keys;
    if (!pushEndpointOk(subscription?.endpoint) || typeof k?.p256dh !== 'string' || typeof k?.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) {
      return send(res, 400, { error: 'Bad subscription' });
    }
    const known = db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').get(subscription.endpoint);
    if (!known && db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n >= 50) return send(res, 400, { error: 'Too many phones are signed up for alerts' });
    db.prepare(`INSERT INTO push_subs (endpoint, sub, created_at) VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub`)
      .run(subscription.endpoint, JSON.stringify({ endpoint: subscription.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } }), new Date().toISOString());
    return send(res, 200, { ok: true });
  }

  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const { endpoint } = await readJson(req);
    db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint || ''));
    return send(res, 200, { ok: true });
  }

  if (p === '/api/push/test' && req.method === 'POST') {
    const { endpoint } = await readJson(req);
    const row = db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').get(String(endpoint || ''));
    if (!row) return send(res, 404, { error: 'This phone is not signed up for alerts' });
    const ok = await pushTo(row, { title: 'Cradlelog', body: 'Feed alerts are working on this phone.', tag: 'test' });
    return ok ? send(res, 200, { ok: true }) : send(res, 502, { error: "The phone's push service didn't accept the alert" });
  }

  if (p === '/api/import' && req.method === 'POST') {
    const text = await readText(req, 5 * 1024 * 1024);
    return send(res, 200, importCsv(text));
  }

  if (p === '/api/export.csv') {
    const rows = db.prepare('SELECT * FROM entries WHERE deleted = 0 ORDER BY ts').all();
    const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = ['time,kind,ml,side,poo,wee,sick,note,in_progress,end_time,weight_g', ...rows.map((r) =>
      [r.ts, r.kind, r.ml, r.side, r.poo ? 'yes' : '', r.wee ? 'yes' : '', r.sick ? 'yes' : '', /^[=+\-@\t\r]/.test(r.note || '') ? `'${r.note}` : r.note, r.open ? 'yes' : '',
        r.end_ts, r.weight_g].map(esc).join(','))];
    return send(res, 200, lines.join('\n') + '\n', {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="cradlelog-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  return send(res, 404, { error: 'not found' });
}

// The icon, home-screen name and tab title follow the baby's name, but only for signed-in devices:
// a signed-out visitor always gets the plain Cradlelog icon and name, so the name never leaks.
function iconLetter(req) {
  if (!authed(req)) return null;
  const first = (getSetting('babyName') || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[A-Za-z]/)?.[0];
  return first ? first.toUpperCase() : null;
}
const ICON_FILE = /^\/icons\/(icon-180|icon-192|icon-512|icon-512-maskable)\.png$/;
function personalised(req, res, rel) {
  const letter = iconLetter(req);
  const headers = { 'Cache-Control': 'no-cache', Vary: 'Cookie' };
  const m = ICON_FILE.exec(rel);
  if (m && letter) {
    fs.readFile(path.join(PUBLIC, 'icons', 'letters', `${m[1]}-${letter}.png`), (err, buf) => {
      if (err) return fs.readFile(path.join(PUBLIC, rel), (e2, b2) => (e2 ? send(res, 404, 'not found') : (res.writeHead(200, { ...headers, 'Content-Type': MIME['.png'] }), res.end(b2))));
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.png'] }); res.end(buf);
    });
    return true;
  }
  if (rel === '/icons/icon.svg' && letter) {
    fs.readFile(path.join(PUBLIC, rel), 'utf8', (err, svg) => {
      if (err) return send(res, 404, 'not found');
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.svg'] }); res.end(svg.replace('>C</text>', `>${letter}</text>`));
    });
    return true;
  }
  if (rel === '/manifest.webmanifest') {
    fs.readFile(path.join(PUBLIC, rel), 'utf8', (err, txt) => {
      if (err) return send(res, 404, 'not found');
      const name = authed(req) ? getSetting('babyName') : '';
      let out = txt;
      if (name) { const m2 = JSON.parse(txt); m2.name = name; m2.short_name = name.slice(0, 12); out = JSON.stringify(m2); }
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.webmanifest'] }); res.end(out);
    });
    return true;
  }
  return false;
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (personalised(req, res, rel)) return;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) =>
        e2 ? send(res, 404, 'not found') : send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }));
    }
    const ext = path.extname(file);
    let body = buf;
    // Stamp the service worker with the build version so each deploy refreshes the cache.
    if (rel === '/sw.js') body = buf.toString().replace('__VERSION__', version());
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(body);
  });
}

// ---------- feed alerts ----------
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const hm = (ms) => clock.format(new Date(ms));
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

// "Alba's next feed" when a name is set, otherwise "The next feed".
const who = () => { const n = getSetting('babyName'); return n ? `${n}'s next feed` : 'The next feed'; };

async function pushTo(row, payload) {
  try {
    await webpush.sendNotification(JSON.parse(row.sub), JSON.stringify({ url: '/', ...payload }), { TTL: 1800, urgency: 'high' });
    return true;
  } catch (err) {
    // Gone or expired: the phone unsubscribed or reinstalled, so stop sending to it.
    if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(row.endpoint);
    else console.error('push failed', err.statusCode || '', err.body || err.message);
    return false;
  }
}
async function pushAll(payload) {
  for (const row of db.prepare('SELECT * FROM push_subs').all()) await pushTo(row, payload);
}

// Each alert fires once per feed. Alerts older than GRACE are skipped, so a restart
// or a late-logged feed doesn't fire a burst of stale ones.
const GRACE = 30 * 60000;
const sentKey = (id, what) => `alert:${id}:${what}`;
function once(id, what) {
  if (getSetting(sentKey(id, what))) return false;
  setSetting(sentKey(id, what), new Date().toISOString());
  return true;
}
// Open feeds past an hour end themselves at the last amount increase, keeping the amount saved so far.
async function autoEnd() {
  try {
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const ended = [];
    for (const r of db.prepare('SELECT * FROM entries WHERE deleted = 0 AND open = 1').all()) {
      const t = new Date(r.ts).getTime();
      if (now - t < MAX_FEED_MS) continue;
      db.prepare('UPDATE entries SET open = 0, end_ts = ?, progress_ts = NULL, updated_at = ? WHERE id = ?').run(autoEndTs(r.ts, r.progress_ts), stamp, r.id);
      ended.push(r);
    }
    // One nudge only when no amount was ever saved: that's the one thing left to fill in.
    if (db.prepare('SELECT 1 FROM push_subs LIMIT 1').get()) {
      for (const r of ended) {
        const t = new Date(r.ts).getTime();
        if (r.ml == null && now - t < MAX_FEED_MS + GRACE) await pushAll({ title: 'Feed ended', body: `The ${r.kind} feed from ${hm(t)} ended after an hour. Open Cradlelog to add the amount.`, tag: 'open' });
      }
    }
  } catch (err) {
    console.error('auto-end failed', err.message);
  }
}
let checking = false;
async function checkAlerts() {
  if (checking) return;
  checking = true;
  try {
    if (!db.prepare('SELECT 1 FROM push_subs LIMIT 1').get()) return;
    const now = Date.now();
    const s = settingsOut();
    const last = db.prepare(`SELECT * FROM entries WHERE deleted = 0 AND kind IN ('bottle','breast') ORDER BY ts DESC LIMIT 1`).get();
    if (last) {
      const t = new Date(last.ts).getTime();
      const from = t + s.feedMin * 3600000, by = t + s.feedMax * 3600000;
      if (now >= by && now - by < GRACE && once(last.id, 'over')) {
        await pushAll({ title: 'Feed overdue', body: `Last feed was ${ago(now - t)} ago, at ${hm(t)}. It was due by ${hm(by)}.`, tag: 'feed' });
      } else if (now >= from && now < by && now - from < GRACE && once(last.id, 'due')) {
        await pushAll({ title: 'Feed due', body: from === by ? `${who()} is due now (${hm(by)}).` : `${who()} is due now, by ${hm(by)} at the latest.`, tag: 'feed' });
      }
    }
  } catch (err) {
    console.error('alert check failed', err.message);
  } finally {
    checking = false;
  }
}
setInterval(() => { autoEnd(); checkAlerts(); }, 60000);
setInterval(purgeSessions, 3600000);
purgeSessions();
autoEnd();

const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'bad request'); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof Bad) return send(res, 400, { error: err.message });
    console.error('request failed', err);
    if (!res.headersSent) send(res, err instanceof URIError ? 400 : 500, { error: err instanceof URIError ? 'bad request' : 'Something went wrong' });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.maxHeadersCount = 50;
server.listen(PORT, () => console.log(`cradlelog ${version()} listening on :${PORT}`));
