import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'correct horse battery';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cradlelog-test-'));
const root = path.resolve(import.meta.dirname, '..');
let proc;

const call = (p, opts = {}) => fetch(BASE + p, opts);
const post = (p, body, headers = {}) =>
  call(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function login() {
  const r = await post('/api/login', { passcode: PASS });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  proc = spawn('node', ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, CRADLELOG_PASSCODE: PASS, PUBLIC_URL: `http://127.0.0.1:${PORT}`, TRUST_PROXY: '0', NODE_NO_WARNINGS: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await call('/api/version'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('refuses a short passcode from the environment', () => {
  const r = spawnSync('node', ['server.js'], { cwd: root, env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cradlelog-sp-')), CRADLELOG_PASSCODE: 'short', PORT: '0' }, timeout: 5000 });
  assert.equal(r.status, 1);
});

test('signed-out visitors see no family data', async () => {
  const s = await (await call('/api/session')).json();
  assert.deepEqual(s, { authed: false, setup: false });
  for (const p of ['/api/entries', '/api/export.csv', '/api/push/key']) assert.equal((await call(p)).status, 401, p);
});

test('security headers and cookie flags', async () => {
  const r = await call('/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const l = await post('/api/login', { passcode: PASS });
  const c = l.headers.get('set-cookie');
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.equal(l.headers.get('cache-control'), 'no-store');
});

test('signed-in session returns settings; logout ends it', async () => {
  const cookie = await login();
  const s = await (await call('/api/session', { headers: { cookie } })).json();
  assert.equal(s.authed, true);
  assert.ok('feedMin' in s);
  assert.equal((await post('/api/logout', {}, { cookie })).status, 200);
  assert.equal((await call('/api/entries', { headers: { cookie } })).status, 401);
});

test('cross-site writes are refused', async () => {
  const cookie = await login();
  const body = { kind: 'note', ts: new Date().toISOString(), note: 'x', id: 'xsite-0001' };
  assert.equal((await post('/api/entries', body, { cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/entries', body, { cookie, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/entries', body, { cookie, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('push subscriptions only go to real push services', async () => {
  const cookie = await login();
  const keys = { p256dh: 'abc', auth: 'def' };
  for (const endpoint of ['https://internal.example/hook', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x']) {
    assert.equal((await post('/api/push/subscribe', { subscription: { endpoint, keys } }, { cookie })).status, 400, endpoint);
  }
  assert.equal((await post('/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys } }, { cookie })).status, 200);
});

test('a feed left open past an hour ends at the last amount increase', async () => {
  const cookie = await login();
  const start = new Date(Date.now() - 90 * 60000).toISOString();
  const r = await (await post('/api/entries', { id: 'stale-0001', kind: 'bottle', ts: start, open: true }, { cookie })).json();
  assert.equal(r.open, false);
  assert.equal(r.end_ts, null);
});

test('the baby name is a family setting, trimmed and length-limited', async () => {
  const cookie = await login();
  const put = (body) => call('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  assert.equal((await put({ babyName: '  Alba\u0007 ' })).status, 200);
  const s = await (await call('/api/session', { headers: { cookie } })).json();
  assert.equal(s.babyName, 'Alba');
  assert.equal((await put({ babyName: 'x'.repeat(41) })).status, 400);
  assert.equal((await put({ babyName: 42 })).status, 400);
  const out = await (await call('/api/session')).json();
  assert.ok(!('babyName' in out), 'signed-out visitors must not see the name');
});

test('CSV import adds entries once, understands older exports, and rejects junk', async () => {
  const cookie = await login();
  const csv = [
    'time,kind,ml,side,poo,wee,sick,note,in_progress,weight_g',
    '2026-10-01T01:00:00.000Z,bottle,60,,,,,"top up, ""half"" asleep",,',
    '2026-10-01T04:00:00.000Z,breast,,left,,,,,,',
    '2026-10-01T05:00:00.000Z,nappy,,,yes,yes,,,,',
    '2026-10-02T09:00:00.000Z,weight,,,,,,,,3450',
    'not a time,bottle,10,,,,,,,',
    "2026-10-03T01:00:00.000Z,note,,,,,,'=SUM(1+1),,",
  ].join('\r\n');
  const imp = (body) => call('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', cookie }, body });
  const r1 = await (await imp(csv)).json();
  assert.equal(r1.imported, 5);
  assert.equal(r1.errors.length, 1);
  assert.match(r1.errors[0], /^Row 6/);
  const r2 = await (await imp(csv)).json();
  assert.equal(r2.imported, 0);
  const entries = (await (await call('/api/entries', { headers: { cookie } })).json()).entries;
  const bottle = entries.find((e) => e.kind === 'bottle' && e.ts.startsWith('2026-10-01T01'));
  assert.equal(bottle.ml, 60);
  assert.equal(bottle.note, 'top up, "half" asleep');
  assert.equal(entries.find((e) => e.kind === 'weight').weight_g, 3450);
  assert.equal(entries.find((e) => e.kind === 'note' && e.ts.startsWith('2026-10-03')).note, '=SUM(1+1)');
  assert.equal((await imp('hello')).status, 400);
  const out = await (await call('/api/export.csv', { headers: { cookie } })).text();
  assert.match(out, /'=SUM\(1\+1\)/);
  assert.equal((await call('/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv })).status, 401);
});

test('five wrong passcodes lock the address out', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { passcode: 'wrong passcode ' + i })).status, 401);
  const r = await post('/api/login', { passcode: PASS });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get('retry-after'));
});


// ---- first run (its own server: no passcode set) ----
test('the first visitor chooses the passcode, once', async () => {
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cradlelog-first-'));
  const p = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dir2, CRADLELOG_PASSCODE: '', PUBLIC_URL: base, TRUST_PROXY: '0', NODE_NO_WARNINGS: '1' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/version'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.deepEqual(await (await fetch(base + '/api/session')).json(), { authed: false, setup: true });
    assert.equal((await fetch(base + '/api/entries')).status, 401);
    const setup = (passcode) => fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) });
    assert.equal((await setup('short')).status, 400);
    assert.equal((await setup('1234567')).status, 400); // 7 characters
    const ok = await setup('12345678'); // 8 is enough
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await setup('another passcode')).status, 403); // already claimed
    assert.deepEqual(await (await fetch(base + '/api/session')).json(), { authed: false, setup: false });
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: '12345678' }) });
    assert.equal(login.status, 200);
  } finally { p.kill(); fs.rmSync(dir2, { recursive: true, force: true }); }
});
