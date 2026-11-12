// Cradlelog client. Entries are kept in memory + localStorage; writes go through an
// outbox so logging works with no signal and syncs when it comes back.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  entries: LS.get('cradlelog.entries', []),
  outbox: LS.get('cradlelog.outbox', []), // [{op:'put'|'del', entry|id}]
  babyName: LS.get('cradlelog.babyName', ''),
  birth: LS.get('cradlelog.birth', null),
  hideBreast: LS.get('cradlelog.hideBreast', false),
  feedMin: LS.get('cradlelog.feedMin', 3),
  feedMax: LS.get('cradlelog.feedMax', 4),
  feedSizes: LS.get('cradlelog.feedSizes', [90, 120]),
  tab: LS.get('cradlelog.tab', 'log'),
  range: LS.get('cradlelog.range', 14),
  unit: LS.get('cradlelog.unit', 'kg'),      // weigh-in units on this phone
  online: true,
};

const KIND_LABEL = { bottle: 'Bottle', breast: 'Breast', nappy: 'Nappy', note: 'Note', weight: 'Weigh-in' };

// ---------- weight ----------
const LB = 453.59237;
function lbOz(g) {
  const totalOz = g / (LB / 16);
  let lb = Math.floor(totalOz / 16), oz = Math.round(totalOz - lb * 16);
  if (oz === 16) { lb += 1; oz = 0; }
  return { lb, oz };
}
const kgText = (g) => `${(g / 1000).toFixed(2)} kg`;
const lbText = (g) => { const { lb, oz } = lbOz(g); return `${lb} lb ${oz} oz`; };
// Show the phone's chosen unit first, the other in brackets.
const weightText = (g) => (state.unit === 'lb' ? `${lbText(g)} (${kgText(g)})` : `${kgText(g)} (${lbText(g)})`);
const isFeed = (e) => e.kind === 'bottle' || e.kind === 'breast';

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': opts.type || 'application/json' } : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

// ---------- boot / auth ----------
async function boot() {
  $('#version').textContent = '';
  api('/api/version').then((v) => ($('#version').textContent = `v${v.version}`)).catch(() => {});
  $('#boot').hidden = false;
  $('#boot-msg').textContent = 'Loading the feed log…';
  $('#boot-retry').hidden = true;
  let session;
  try {
    session = await api('/api/session');
  } catch {
    // Offline: show whatever we have cached if we've signed in before.
    if (LS.get('cradlelog.signedIn', false)) { $('#boot').hidden = true; return startApp(); }
    $('#boot-msg').textContent = "Can't reach Cradlelog right now. Check your signal or Wi-Fi, then try again.";
    $('#boot-retry').hidden = false;
    $('#boot-retry').focus();
    return;
  }
  $('#boot').hidden = true;
  applySettings(session);
  // Remember a sign-in made elsewhere (an installed home-screen app starts with empty storage but can arrive already signed in).
  if (session.authed) { LS.set('cradlelog.signedIn', true); return startApp(); }
  showGate(session.setup);
}
$('#boot-retry').addEventListener('click', boot);

// One message bar for errors (stay until dismissed), confirmations (clear themselves)
// and Undo (replaces "are you sure?" prompts, quicker one-handed).
let toastTimer, toastAction = null;
function toast(msg, opts = {}) {
  if (typeof opts === 'number') opts = { autoHide: opts };
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.setAttribute('role', opts.autoHide ? 'status' : 'alert');
  $('#toast-msg').textContent = msg;
  toastAction = opts.action || null;
  $('#toast-action').hidden = !toastAction;
  if (toastAction) $('#toast-action').textContent = toastAction.label;
  el.hidden = false;
  toastHideMs = opts.autoHide || 0;
  if (toastHideMs) toastTimer = setTimeout(() => (el.hidden = true), toastHideMs);
}
// Hold a timed message open while someone is touching or focused on it.
let toastHideMs = 0;
const holdToast = () => clearTimeout(toastTimer);
const releaseToast = () => { if (toastHideMs && !$('#toast').hidden) toastTimer = setTimeout(() => ($('#toast').hidden = true), 4000); };
$('#toast').addEventListener('pointerenter', holdToast);
$('#toast').addEventListener('focusin', holdToast);
$('#toast').addEventListener('pointerleave', releaseToast);
$('#toast').addEventListener('focusout', releaseToast);
function undoToast(msg, undo) {
  toast(msg, { autoHide: 8000, action: { label: 'Undo', fn: undo } });
}
$('#toast-close').addEventListener('click', () => ($('#toast').hidden = true));
$('#toast-action').addEventListener('click', () => {
  const a = toastAction;
  $('#toast').hidden = true;
  toastAction = null;
  a?.fn();
});
$('#open-finish').addEventListener('click', () => {
  const e = state.entries.find((x) => x.id === $('#open-finish').dataset.id);
  if (e) openSheet(e);
});

function showGate(setup) {
  $('#gate').hidden = false;
  $('#app').hidden = true;
  // A new install has no passcode yet: the first person to open it chooses one.
  const choosing = !!setup;
  $('#gate-form').hidden = false;
  $('#gate-msg').textContent = choosing
    ? 'Welcome. Choose a passcode for your family (at least 8 characters). Everyone you share it with can use the app.'
    : 'Enter the family passcode.';
  $('#gate-btn').textContent = choosing ? 'Set passcode' : 'Sign in';
  $('#gate-pass').autocomplete = choosing ? 'new-password' : 'current-password';
  $('#gate-pass2').hidden = !choosing;
  $('#gate-pass2').required = choosing;
  $('#gate-form').onsubmit = async (ev) => {
    ev.preventDefault();
    $('#gate-err').textContent = '';
    if (choosing && $('#gate-pass').value !== $('#gate-pass2').value) { $('#gate-err').textContent = "Those two passcodes don't match."; return; }
    try {
      await api(choosing ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify({ passcode: $('#gate-pass').value }) });
      LS.set('cradlelog.signedIn', true);
      $('#gate').hidden = true;
      startApp();
    } catch (err) {
      $('#gate-err').textContent = err.message;
    }
  };
  $('#gate-pass').focus();
}

let started = false;
function startApp() {
  $('#app').hidden = false;
  if (started) return;
  started = true;
  render();
  sync();
  setInterval(sync, 30_000);
  setInterval(renderStatus, 20_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
  window.addEventListener('online', sync);
}

// ---------- sync ----------
let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    while (state.outbox.length) {
      const job = state.outbox[0];
      try {
        if (job.op === 'put') await api('/api/entries', { method: 'POST', body: JSON.stringify(job.entry) });
        else await api(`/api/entries/${job.id}`, { method: 'DELETE' });
      } catch (err) {
        // The server refused this one (not a network or sign-in problem): drop it so it
        // can't block everything queued behind it, and say so.
        if (!err.status || err.status === 401 || err.status >= 500) throw err;
        if (job.op === 'put') {
          state.entries = state.entries.filter((e) => e.id !== job.entry.id);
          toast(`Couldn't save the ${hm(new Date(job.entry.ts))} ${describe(job.entry).toLowerCase()}: ${err.message}. Please add it again.`);
        } else {
          toast(`Couldn't delete that entry: ${err.message}.`);
        }
      }
      state.outbox.shift();
      LS.set('cradlelog.outbox', state.outbox);
    }
    const { entries, settings } = await api('/api/entries');
    if (settings) applySettings(settings);
    // Anything queued while the request was in flight stays visible.
    const puts = new Map(state.outbox.filter((j) => j.op === 'put').map((j) => [j.entry.id, j.entry]));
    const dels = new Set(state.outbox.filter((j) => j.op === 'del').map((j) => j.id));
    state.entries = [...entries.filter((e) => !puts.has(e.id) && !dels.has(e.id)), ...puts.values()]
      .sort((a, b) => a.ts.localeCompare(b.ts));
    LS.set('cradlelog.entries', state.entries);
    state.online = true;
  } catch (err) {
    if (err.status === 401) { LS.set('cradlelog.signedIn', false); syncing = false; return showGate(false); }
    state.online = false;
  }
  syncing = false;
  render();
  if (state.online && state.outbox.length) sync();
}

function queuePut(entry) {
  const i = state.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) state.entries[i] = entry; else state.entries.push(entry);
  state.entries.sort((a, b) => a.ts.localeCompare(b.ts));
  state.outbox = state.outbox.filter((j) => !(j.op === 'put' && j.entry.id === entry.id));
  state.outbox.push({ op: 'put', entry });
  persist();
}
function queueDelete(id) {
  state.entries = state.entries.filter((e) => e.id !== id);
  state.outbox = state.outbox.filter((j) => !(j.op === 'put' && j.entry.id === id));
  state.outbox.push({ op: 'del', id });
  persist();
}
function persist() {
  LS.set('cradlelog.entries', state.entries);
  LS.set('cradlelog.outbox', state.outbox);
  render();
  sync();
}

// ---------- time helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (d) => `${dayKey(d)}T${hm(d)}`;
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${pad(m % 60)}m`;
}
function dayLabel(key) {
  const today = dayKey(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return 'Today';
  if (key === dayKey(y)) return 'Yesterday';
  const [Y, M, D] = key.split('-').map(Number);
  return new Date(Y, M - 1, D).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function shortDay(key) {
  const l = dayLabel(key);
  if (l === 'Today' || l === 'Yesterday') return l === 'Today' ? 'Today' : 'Yest.';
  const [Y, M, D] = key.split('-').map(Number);
  return new Date(Y, M - 1, D).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function ageText() {
  if (!state.birth) return '';
  const [Y, M, D] = state.birth.split('-').map(Number);
  const b = new Date(Y, M - 1, D);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - b) / 86400000);
  if (days < 0) return '';
  if (days === 0) return 'Born today';
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
  const w = Math.floor(days / 7), d = days % 7;
  return `${w} week${w === 1 ? '' : 's'}${d ? `, ${d} day${d === 1 ? '' : 's'}` : ''} old`;
}

function summarise(list) {
  const feeds = list.filter(isFeed);
  return {
    ml: feeds.reduce((s, e) => s + (e.ml || 0), 0),
    feeds: feeds.length,
    poos: list.filter((e) => e.poo).length,
    wees: list.filter((e) => e.wee).length,
  };
}

function describe(e) {
  if (e.kind === 'bottle') return e.ml ? `${e.ml}ml bottle` : 'Bottle';
  if (e.kind === 'breast') return `Breast${e.side ? ` · ${e.side}` : ''}${e.ml ? ` · ${e.ml}ml` : ''}`;
  if (e.kind === 'nappy') return [e.wee && 'Wee', e.poo && 'Poo'].filter(Boolean).join(' + ') || 'Nappy';
  if (e.kind === 'weight') return e.weight_g ? `Weighed ${weightText(e.weight_g)}` : 'Weigh-in';
  return 'Note';
}

// ---------- render ----------
// Settings are family-wide: whichever phone changes them, the others pick it up on next sync.
function applySettings(s) {
  if (s.babyName !== undefined) { state.babyName = s.babyName || ''; LS.set('cradlelog.babyName', state.babyName); }
  if (s.birth !== undefined) { state.birth = s.birth || null; LS.set('cradlelog.birth', state.birth); }
  if (s.hideBreast !== undefined) { state.hideBreast = !!s.hideBreast; LS.set('cradlelog.hideBreast', state.hideBreast); }
  if (Array.isArray(s.feedSizes) && s.feedSizes.length) { state.feedSizes = s.feedSizes; LS.set('cradlelog.feedSizes', s.feedSizes); }
  if (s.feedMin !== undefined && s.feedMax !== undefined) {
    state.feedMin = Number(s.feedMin); state.feedMax = Number(s.feedMax);
    LS.set('cradlelog.feedMin', state.feedMin); LS.set('cradlelog.feedMax', state.feedMax);
  }
}

function render() {
  // Hiding breastfeeding only removes the button; past breast feeds stay everywhere else.
  $('.quick-btn.k-breast').hidden = state.hideBreast;
  $('.quick').classList.toggle('three', state.hideBreast);
  $('#age').textContent = ageText();
  // The baby's name replaces the app name at the top, in the tab title and as the home-screen label.
  const title = state.babyName || 'Cradlelog';
  $('#app-title').textContent = title;
  document.title = title;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', title);
  const sync = $('#sync');
  sync.textContent = state.outbox.length ? `${state.outbox.length} to sync` : state.online ? '' : 'Offline';
  sync.classList.toggle('warn', !!state.outbox.length || !state.online);
  renderStatus();
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
  $('#tab-log').hidden = state.tab !== 'log';
  $('#tab-trends').hidden = state.tab !== 'trends';
  if (state.tab === 'log') renderLog(); else renderTrends();
}

function renderStatus() {
  const feeds = state.entries.filter(isFeed);
  const last = feeds[feeds.length - 1];
  if (last) {
    const t = new Date(last.ts);
    const now = Date.now();
    const ms = now - t;
    // Due window = last feed + the family's "every X to Y hours" setting.
    const from = t.getTime() + state.feedMin * 3600000;
    const by = t.getTime() + state.feedMax * 3600000;
    const late = now > by;
    // A started-but-unfinished feed gets its own line and a Finish button.
    const open = [...feeds].reverse().find((e) => e.open);
    $('#open-feed').hidden = !open;
    if (open) {
      const st = new Date(open.ts);
      // After an hour it's probably been forgotten rather than still going.
      const stale = now - st >= 3600000;
      $('#open-feed').classList.toggle('stale', stale);
      $('#open-what').textContent = stale ? 'Forgot to finish this feed?' : `${KIND_LABEL[open.kind]} in progress`;
      $('#open-since').textContent = stale
        ? `${KIND_LABEL[open.kind]} started ${hm(st)}, ${dur(now - st)} ago${open.ml ? `, ${open.ml} ml so far` : ''}. Finish it, or set when it ended.`
        : `Started ${hm(st)}, ${dur(now - st)} ago${open.ml ? ` · ${open.ml} ml so far` : ''}`;
      $('#open-finish').dataset.id = open.id;
    }
    $('#since').textContent = dur(ms);
    $('#since').classList.remove('none');
    $('#since').classList.toggle('late', late);
    $('#last-feed').textContent = `${describe(last)} at ${hm(t)}${dayKey(t) !== dayKey(new Date()) ? ` ${dayLabel(dayKey(t)).toLowerCase()}` : ''}`;
    const next = $('#next');
    next.hidden = false;
    next.classList.toggle('due', now >= from && !late);
    next.classList.toggle('over', late);
    if (now < from) {
      $('#next-when').innerHTML = from === by
        ? `Next feed due at <b>${hm(new Date(by))}</b>`
        : `Next feed between <b>${hm(new Date(from))}</b> and <b>${hm(new Date(by))}</b>`;
      $('#next-in').textContent = `in ${dur(from - now)}`;
    } else if (!late) {
      $('#next-when').innerHTML = `Feed due now, by <b>${hm(new Date(by))}</b> at the latest`;
      $('#next-in').textContent = `${dur(by - now)} left`;
    } else {
      $('#next-when').innerHTML = `Feed was due by <b>${hm(new Date(by))}</b>`;
      $('#next-in').textContent = `${dur(now - by)} overdue`;
    }
  } else {
    $('#since').textContent = 'No feeds yet';
    $('#since').classList.add('none');
    $('#since').classList.remove('late');
    $('#next').hidden = true;
    $('#open-feed').hidden = true;
    $('#last-feed').textContent = state.hideBreast ? 'Tap Bottle below to log the first one.' : 'Tap Bottle or Breast below to log the first one.';
  }
  const today = dayKey(new Date());
  const s = summarise(state.entries.filter((e) => dayKey(new Date(e.ts)) === today));
  $('#today').innerHTML = [
    ['Today', `${s.ml}ml`], ['Feeds', s.feeds], ['Poos', s.poos], ['Wees', s.wees],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderLog() {
  const el = $('#tab-log');
  if (!state.entries.length) { el.innerHTML = '<p class="empty">Nothing logged yet. Tap Bottle to start.</p>'; return; }
  const pending = new Set(state.outbox.filter((j) => j.op === 'put').map((j) => j.entry.id));
  // Dot size follows the same area-by-ml rule as the feed-time chart.
  const maxMl = Math.max(30, ...state.entries.map((e) => e.ml || 0));
  const dotSize = (e) => (isFeed(e) && e.ml ? Math.round(6 + 10 * Math.sqrt(e.ml / maxMl)) : 8);
  const byDay = new Map();
  const asc = state.entries;
  let prevFeed = null;
  const gapOf = new Map();
  for (const e of asc) {
    if (isFeed(e)) { if (prevFeed) gapOf.set(e.id, new Date(e.ts) - new Date(prevFeed.ts)); prevFeed = e; }
    const k = dayKey(new Date(e.ts));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  // Show only the most recent N feeds (and whatever else was logged in that time).
  // Day totals still use the whole day so a part-shown day isn't misleading.
  const allFeeds = asc.filter(isFeed);
  const cutoff = allFeeds.length > state.logLimit ? allFeeds[allFeeds.length - state.logLimit].ts : '';
  const shownFeeds = Math.min(allFeeds.length, state.logLimit);
  const days = [...byDay.entries()].reverse()
    .map(([k, list]) => [k, list, list.filter((e) => e.ts >= cutoff)])
    .filter(([, , shown]) => shown.length);
  const more = allFeeds.length - shownFeeds;
  el.innerHTML = days.map(([k, list, shown]) => {
    const s = summarise(list);
    const bits = [`${s.ml}ml`, `${s.feeds} feed${s.feeds === 1 ? '' : 's'}`];
    if (s.poos) bits.push(`${s.poos} poo${s.poos === 1 ? '' : 's'}`);
    return `<section class="day">
      <div class="day-head"><h3>${dayLabel(k)}</h3><span class="day-sum">${bits.join(' · ')}</span></div>
      <ul class="rows">${[...shown].reverse().map((e) => {
        const tags = [e.kind !== 'nappy' && e.wee && 'wee', e.kind !== 'nappy' && e.poo && 'poo', e.sick && 'sick'].filter(Boolean);
        const gap = gapOf.get(e.id);
        return `<li><button class="row k-${e.kind}${pending.has(e.id) ? ' pending' : ''}${e.open ? ' is-open' : ''}" data-id="${e.id}"
          ${e.open ? 'aria-label="' + esc(`${hm(new Date(e.ts))} ${describe(e)}, in progress. Tap to add the amount.`) + '"' : ''}>
          <span class="row-time">${hm(new Date(e.ts))}</span>
          <span class="row-main">
            <span class="row-what"><span class="dot-wrap"><span class="dot" style="--d:${dotSize(e)}px"></span></span>${esc(describe(e))}</span>
            ${e.note ? `<span class="row-note">${esc(e.note)}</span>` : ''}
          </span>
          <span><span class="tags">${e.open ? `<span class="tag todo">In progress · ${e.ml ? `${e.ml} ml so far` : 'add amount'}</span>` : ''}${feedMins(e) ? `<span class="tag">${feedMins(e)} min</span>` : ''}${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</span>
          ${gap ? `<span class="row-gap">+${dur(gap)}</span>` : ''}</span>
        </button></li>`;
      }).join('')}</ul></section>`;
  }).join('') + (allFeeds.length > LOG_STEP ? `<div class="log-more">
      <p class="hint">${more > 0 ? `Showing the last ${shownFeeds} of ${allFeeds.length} feeds` : `Showing all ${allFeeds.length} feeds`}</p>
      ${more > 0 ? `<button type="button" class="btn" id="log-more">Show ${Math.min(LOG_STEP, more)} more</button>` : ''}
      ${state.logLimit > LOG_STEP ? '<button type="button" class="btn" id="log-less">Show fewer</button>' : ''}
    </div>` : '');
}

// Log length: starts at the last 15 feeds each time the app opens; expands in place.
const LOG_STEP = 15;
state.logLimit = LOG_STEP;
$('#tab-log').addEventListener('click', (ev) => {
  const btn = ev.target.closest('#log-more, #log-less');
  if (!btn) return;
  const firstNew = btn.id === 'log-more';
  const before = $$('#tab-log .row').length;
  state.logLimit = firstNew ? state.logLimit + LOG_STEP : LOG_STEP;
  renderLog();
  if (firstNew) {
    // Keep keyboard and screen-reader users where they were: on the first newly shown row.
    $$('#tab-log .row')[before]?.focus();
  } else {
    $('.tabs').scrollIntoView({ block: 'start' });
    $('#log-more')?.focus({ preventScroll: true });
  }
});

// Feed length in whole minutes, only for feeds finished with an end time.
const feedMins = (e) => (e.end_ts && !e.open ? Math.max(1, Math.round((new Date(e.end_ts) - new Date(e.ts)) / 60000)) : 0);

function renderTrends() {
  const el = $('#tab-trends');
  const feeds = state.entries.filter(isFeed);
  if (feeds.length < 2) { el.innerHTML = '<p class="empty">Trends appear once there are a few feeds logged.</p>'; return; }

  const now = Date.now();
  const H = 3600000;
  const t = (e) => new Date(e.ts).getTime();
  // Gap before each feed, attributed to the feed that ends it (so overnight gaps count).
  const gaps = feeds.slice(1).map((e, i) => ({ end: t(e), ms: t(e) - t(feeds[i]) }));
  const inWin = (x, a, b) => x > a && x <= b;
  const win = (a, b) => {
    const f = feeds.filter((e) => inWin(t(e), a, b));
    const g = gaps.filter((x) => inWin(x.end, a, b));
    const withMl = f.filter((e) => e.ml);
    const longest = g.reduce((m, x) => (x.ms > (m?.ms || 0) ? x : m), null);
    return {
      ml: f.reduce((s, e) => s + (e.ml || 0), 0),
      feeds: f.length,
      avgMl: withMl.length ? withMl.reduce((s, e) => s + e.ml, 0) / withMl.length : null,
      avgGap: g.length ? g.reduce((s, x) => s + x.ms, 0) / g.length : null,
      longest,
      poos: state.entries.filter((e) => e.poo && inWin(t(e), a, b)).length,
      wees: state.entries.filter((e) => e.wee && inWin(t(e), a, b)).length,
    };
  };

  // ---- headline tiles ----
  const last24 = win(now - 24 * H, now);
  const prev24 = win(now - 48 * H, now - 24 * H);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const todaySoFar = win(midnight - 1, now);
  const ydaySoFar = win(midnight - 24 * H - 1, now - 24 * H);
  const lastPoo = [...state.entries].reverse().find((e) => e.poo);
  const delta = (a, b, unit = 'ml') => {
    if (a == null || b == null) return '';
    const d = Math.round(a - b);
    return d === 0 ? 'same as day before' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}${unit} on day before`;
  };
  const lenAvg = feeds.filter((e) => t(e) > now - 7 * 24 * H).map(feedMins).filter(Boolean);
  const tiles = [
    ['Last 24 hours', `${last24.ml}ml`, `${last24.feeds} feeds · ${delta(last24.ml, prev24.ml)}`],
    ['Average feed', last24.avgMl ? `${Math.round(last24.avgMl)}ml` : null, delta(last24.avgMl, prev24.avgMl)],
    ['Average gap', last24.avgGap ? dur(last24.avgGap) : null, 'between feeds, last 24h'],
    ['Longest stretch', last24.longest ? dur(last24.longest.ms) : null,
      last24.longest ? `ended ${hm(new Date(last24.longest.end))}, last 24h` : 'needs two feeds in 24h'],
    ['Feed length', lenAvg.length ? `${Math.round(lenAvg.reduce((s, m) => s + m, 0) / lenAvg.length)} min` : null,
      lenAvg.length ? `last 7 days, ${lenAvg.length} finished feed${lenAvg.length === 1 ? '' : 's'}` : 'appears once feeds are finished with a length'],
    ['Today so far', `${todaySoFar.ml}ml`, `${ydaySoFar.ml}ml by this time yesterday`],
    ['Last poo', lastPoo ? dur(now - t(lastPoo)) : null, `${lastPoo ? 'ago · ' : ''}${last24.poos} poo${last24.poos === 1 ? '' : 's'} · ${last24.wees} wee${last24.wees === 1 ? '' : 's'} in 24h`],
  ];
  // Empty table cells read "none" in muted text rather than a dash.
  const cell = (v) => (v ? `<td>${v}</td>` : '<td class="nil">none</td>');

  // ---- per-day stats over the chosen range ----
  const range = state.range || 14;
  const firstDay = dayKey(new Date(state.entries[0].ts));
  const days = [];
  for (let i = range - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const k = dayKey(d); if (k >= firstDay) days.push(k); }
  const todayKey = dayKey(new Date());
  const stats = days.map((k) => {
    const [Y, M, D] = k.split('-').map(Number);
    const a = new Date(Y, M - 1, D).getTime();
    return { k, a, ...win(a - 1, a + 24 * H - 1) };
  });
  const n = stats.length;
  const W = 340;
  const tick = (s) => (s.k === todayKey ? 'Today' : Number(s.k.slice(8)));
  const every = n > 16 ? 3 : n > 10 ? 2 : 1;
  const xLabels = (h, bw) => stats.map((s, i) => ((n - 1 - i) % every === 0
    ? `<text x="${i * bw + bw / 2}" y="${h - 6}" text-anchor="middle">${tick(s)}</text>` : '')).join('');

  // Bars: one value per day; full-height invisible hit columns carry the tooltip.
  function barChart(values, fmt, cls, label) {
    const h = 160, top = 18, bottom = 22, bw = W / n;
    const max = Math.max(...values.map((v) => v || 0), 1);
    const bars = values.map((v, i) => {
      if (!v) return '';
      const bh = Math.max(2, ((h - top - bottom) * v) / max);
      const x = i * bw + bw * 0.2, w = Math.max(2, bw * 0.6 - 2), y = h - bottom - bh;
      const partial = stats[i].k === todayKey ? ' partial' : '';
      return `<path class="${cls}${partial}" d="M${x},${h - bottom}V${y + 4}q0,-4 4,-4h${w - 8}q4,0 4,4V${h - bottom}Z"/>`
        + (n <= 10 ? `<text class="val" x="${x + w / 2}" y="${y - 5}" text-anchor="middle">${fmt(v, true)}</text>` : '');
    }).join('');
    const hits = values.map((v, i) => {
      const tipText = `${dayLabel(stats[i].k)}${stats[i].k === todayKey ? ' (so far)' : ''}: ${v ? fmt(v) : 'none'}`;
      return `<rect class="hit" tabindex="0" role="img" aria-label="${tipText}" x="${i * bw}" y="0" width="${bw}" height="${h - bottom}" data-tip="${tipText}"/>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${label}">
      <line x1="0" x2="${W}" y1="${h - bottom}" y2="${h - bottom}"/>${bars}${xLabels(h, bw)}${hits}</svg>`;
  }

  // Line: average feed size per day.
  function lineChart() {
    const h = 150, top = 20, bottom = 22, bw = W / n;
    const vals = stats.map((s) => s.avgMl);
    const max = Math.max(...vals.filter(Boolean), 10) * 1.15;
    const pt = (v, i) => [i * bw + bw / 2, h - bottom - ((h - top - bottom) * v) / max];
    const pts = vals.map((v, i) => (v ? pt(v, i) : null));
    const d = pts.map((p, i) => (p ? `${i && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}` : '')).join('');
    const lastI = vals.findLastIndex(Boolean), firstI = vals.findIndex(Boolean);
    const label = (i) => (pts[i] ? `<text class="val" x="${pts[i][0]}" y="${pts[i][1] - 9}" text-anchor="middle">${Math.round(vals[i])}</text>` : '');
    const dots = pts.map((p, i) => (p ? `<circle class="dot-bottle" cx="${p[0]}" cy="${p[1]}" r="4"/>` : '')).join('');
    const hits = vals.map((v, i) => {
      const tipText = `${dayLabel(stats[i].k)}: ${v ? `${Math.round(v)}ml per feed (${stats[i].feeds} feeds)` : 'no amounts'}`;
      return `<rect class="hit" tabindex="0" role="img" aria-label="${tipText}" x="${i * bw}" y="0" width="${bw}" height="${h - bottom}" data-tip="${tipText}"/>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="Average millilitres per feed by day">
      <line x1="0" x2="${W}" y1="${h - bottom}" y2="${h - bottom}"/>
      <path class="line-bottle" d="${d}"/>${dots}${label(firstI)}${lastI !== firstI ? label(lastI) : ''}${xLabels(h, bw)}${hits}</svg>`;
  }

  // Feed clock: one row per day across 24 hours, dot area ∝ ml.
  function feedClock() {
    const rows = stats.slice(-7).reverse();
    const left = 44, right = 8, rowH = 30, top = 18;
    const h = top + rows.length * rowH + 6;
    const xw = W - left - right;
    const x = (ms) => left + (xw * ms) / (24 * H);
    const maxMl = Math.max(...feeds.map((e) => e.ml || 0), 30);
    const grid = [0, 6, 12, 18, 24].map((hr) => `<line class="grid" x1="${x(hr * H)}" x2="${x(hr * H)}" y1="${top - 4}" y2="${h - 4}"/>
      <text x="${x(hr * H)}" y="11" text-anchor="middle">${hr === 24 ? '' : `${pad(hr)}:00`}</text>`).join('');
    const body = rows.map((s, r) => {
      const cy = top + r * rowH + rowH / 2;
      const items = state.entries.filter((e) => inWin(t(e), s.a - 1, s.a + 24 * H - 1));
      const marks = items.map((e) => {
        const cx = x(t(e) - s.a);
        const when = hm(new Date(e.ts));
        if (isFeed(e)) {
          const rad = e.ml ? 3 + 6 * Math.sqrt(e.ml / maxMl) : 4;
          return `<circle class="dot-${e.kind}" cx="${cx}" cy="${cy}" r="${rad.toFixed(1)}"/>
            <circle class="hit" cx="${cx}" cy="${cy}" r="11" data-tip="${when} · ${esc(describe(e))}${e.poo ? ' · poo' : ''}${e.sick ? ' · sick' : ''}"/>`;
        }
        if (e.poo) return `<path class="poo-mark" d="M${cx - 4},${cy + 12}h8l-4,-6z"/>
          <circle class="hit" cx="${cx}" cy="${cy + 10}" r="9" data-tip="${when} · poo"/>`;
        return '';
      }).join('') + items.filter((e) => isFeed(e) && e.poo).map((e) => {
        const cx = x(t(e) - s.a);
        return `<path class="poo-mark" d="M${cx - 4},${cy + 13}h8l-4,-6z"/>`;
      }).join('');
      return `<text x="0" y="${cy + 4}">${tick(s) === 'Today' ? 'Today' : new Date(s.a).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}</text>
        <line class="row-line" x1="${left}" x2="${W - right}" y1="${cy}" y2="${cy}"/>${marks}`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="Feed times for the last 7 days">${grid}${body}</svg>`;
  }

  // Keep the Breast key while any breast feed is still on the 7-day chart.
  const weekStart = stats.slice(-7)[0]?.a ?? now;
  const showBreastKey = !state.hideBreast || feeds.some((e) => e.kind === 'breast' && t(e) >= weekStart);
  const rangeBtns = [7, 14, 30].map((r) => `<button type="button" data-range="${r}" aria-pressed="${r === range}" class="${r === range ? 'on' : ''}">${r} days</button>`).join('');

  el.innerHTML = `
    <div class="tiles">${tiles.map(([k, v, sub]) => `<div class="tile"><p class="tile-k">${k}</p>${v === null
      ? '<p class="tile-v none">Not enough data yet</p>' : `<p class="tile-v">${v}</p>`}<p class="tile-s">${sub}</p></div>`).join('')}</div>

    ${weightCard()}

    <div class="card">
      <h3>When feeds happen</h3>
      <p class="sub">Last 7 days. Bigger dot, bigger feed.</p>
      <div class="legend"><span><i class="sw sw-bottle"></i>Bottle</span>${showBreastKey ? '<span><i class="sw sw-breast"></i>Breast</span>' : ''}<span><i class="sw sw-poo"></i>Poo</span></div>
      ${feedClock()}
    </div>

    <div class="chips range" id="range">${rangeBtns}</div>

    <div class="card">
      <h3>Milk per day</h3>
      <p class="sub">Bottle plus any breast amounts logged. Today is faded until it's over.</p>
      ${barChart(stats.map((s) => s.ml), (v) => `${v}ml`, 'bar-bottle', 'Millilitres per day')}
    </div>

    <div class="card">
      <h3>Average feed size</h3>
      <p class="sub">ml per feed, feeds with an amount only.</p>
      ${lineChart()}
    </div>

    <div class="card">
      <h3>Longest stretch between feeds</h3>
      <p class="sub">Per day, counted on the day the stretch ended.</p>
      ${barChart(stats.map((s) => (s.longest ? s.longest.ms / H : 0)), (v, short) => (short ? `${v.toFixed(1)}h` : dur(v * H)), 'bar-stretch', 'Longest gap between feeds per day')}
    </div>

    <div class="card">
      <h3>Feeds per day</h3>
      ${barChart(stats.map((s) => s.feeds), (v, short) => (short ? v : `${v} feed${v === 1 ? '' : 's'}`), 'bar-count', 'Feeds per day')}
    </div>


    <div class="card">
      <h3>Daily breakdown</h3>
      <div class="table-wrap"><table class="stats">
        <thead><tr><th>Day</th><th>Total</th><th>Feeds</th><th>Per feed</th><th>Gap</th><th>Longest</th><th>Poos</th><th>Wees</th></tr></thead>
        <tbody>${[...stats].reverse().map((s) => `<tr>
          <td>${shortDay(s.k)}</td><td>${s.ml}ml</td><td>${s.feeds}</td>
          ${cell(s.avgMl && `${Math.round(s.avgMl)}ml`)}${cell(s.avgGap && dur(s.avgGap))}
          ${cell(s.longest && dur(s.longest.ms))}<td>${s.poos}</td><td>${s.wees}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

// Weigh-ins over all time (not the 7/14/30 day range: they're days or weeks apart).
function weightCard() {
  const ws = state.entries.filter((e) => e.kind === 'weight' && e.weight_g);
  const head = (sub) => `<div class="card-head"><div><h3>Weight</h3><p class="sub">${sub}</p></div>
    <button type="button" class="btn" id="add-weight">Add weigh-in</button></div>`;
  if (!ws.length) {
    return `<div class="card">${head('No weigh-ins yet. Add one each time the health visitor weighs the baby.')}</div>`;
  }
  const last = ws[ws.length - 1], prev = ws[ws.length - 2];
  // Mid-sentence day: "today", "yesterday" or "3 Nov".
  const dayWord = (ts) => { const l = dayLabel(dayKey(new Date(ts))); return l === 'Today' || l === 'Yesterday' ? l.toLowerCase() : shortDay(dayKey(new Date(ts))); };
  let sub = `Last weighed ${dayWord(last.ts)}: ${weightText(last.weight_g)}.`;
  if (prev) {
    const d = last.weight_g - prev.weight_g;
    const sameDay = dayKey(new Date(prev.ts)) === dayKey(new Date(last.ts));
    const days = Math.max(1, Math.round((new Date(last.ts) - new Date(prev.ts)) / 86400000));
    sub += ` ${d >= 0 ? 'Up' : 'Down'} ${Math.abs(d)} g since ${sameDay ? 'earlier that day'
      : `${dayWord(prev.ts)} (${days} day${days === 1 ? '' : 's'})`}.`;
  }
  if (ws.length < 2) return `<div class="card">${head(sub)}</div>`;
  const W = 340, h = 150, top = 22, bottom = 22, left = 6, right = 6;
  const t0 = new Date(ws[0].ts).getTime(), t1 = new Date(last.ts).getTime();
  const lo = Math.min(...ws.map((w) => w.weight_g)), hi = Math.max(...ws.map((w) => w.weight_g));
  const pad = Math.max(100, (hi - lo) * 0.15);
  const x = (t) => left + ((W - left - right) * (t - t0)) / Math.max(1, t1 - t0);
  const y = (g) => h - bottom - ((h - top - bottom) * (g - lo + pad)) / (hi - lo + 2 * pad);
  const pts = ws.map((w) => [x(new Date(w.ts).getTime()), y(w.weight_g), w]);
  const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  const lbl = (p, anchor) => `<text class="val" x="${p[0]}" y="${p[1] - 9}" text-anchor="${anchor}">${state.unit === 'lb' ? lbText(p[2].weight_g) : kgText(p[2].weight_g)}</text>`;
  const ticks = [pts[0], pts[pts.length - 1]].map((p, i) => `<text x="${p[0]}" y="${h - 6}" text-anchor="${i ? 'end' : 'start'}">${shortDay(dayKey(new Date(p[2].ts)))}</text>`).join('');
  const hits = pts.map(([px, py, w]) => {
    const tip = `${shortDay(dayKey(new Date(w.ts)))}: ${weightText(w.weight_g)}`;
    return `<circle class="hit" tabindex="0" role="img" aria-label="${tip}" cx="${px}" cy="${py}" r="14" data-tip="${tip}"/>`;
  }).join('');
  return `<div class="card">${head(sub)}
    <svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="Weight at each weigh-in">
      <line x1="0" x2="${W}" y1="${h - bottom}" y2="${h - bottom}"/>
      <path class="line-weight" d="${d}"/>${pts.map(([px, py]) => `<circle class="dot-weight" cx="${px}" cy="${py}" r="4.5"/>`).join('')}
      ${lbl(pts[0], 'start')}${lbl(pts[pts.length - 1], 'end')}${ticks}${hits}
    </svg></div>`;
}
$('#tab-trends').addEventListener('click', (ev) => { if (ev.target.closest('#add-weight')) openSheet('weight'); });

// One tooltip for every chart: hover on desktop, tap on phones.
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.append(tip);
function showTip(ev) {
  const target = ev.target.closest?.('[data-tip]');
  if (!target) { tip.hidden = true; return; }
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2))}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8 + window.scrollY)}px`;
}
$('#tab-trends').addEventListener('pointermove', showTip);
$('#tab-trends').addEventListener('pointerdown', showTip);
$('#tab-trends').addEventListener('pointerleave', () => (tip.hidden = true));
// Keyboard: Tab through the bars/days and the same tooltip follows focus.
$('#tab-trends').addEventListener('focusin', showTip);
$('#tab-trends').addEventListener('focusout', () => (tip.hidden = true));
window.addEventListener('scroll', () => (tip.hidden = true), { passive: true });
$('#tab-trends').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-range]');
  if (!b) return;
  state.range = Number(b.dataset.range);
  LS.set('cradlelog.range', state.range);
  renderTrends();
});

// ---------- entry sheet ----------
const sheet = $('#sheet');
let draft = null;

function lastMl() {
  const b = state.entries.filter((e) => e.kind === 'bottle' && e.ml);
  return b.length ? b[b.length - 1].ml : 30;
}

function openSheet(kindOrEntry) {
  const editing = typeof kindOrEntry === 'object';
  draft = editing
    ? { ...kindOrEntry, _edit: true }
    : { id: crypto.randomUUID(), kind: kindOrEntry, ts: new Date().toISOString(), ml: kindOrEntry === 'bottle' ? lastMl() : null,
        side: kindOrEntry === 'breast' ? 'both' : null, poo: false, wee: kindOrEntry === 'nappy', sick: false, note: '', open: false };
  $('#f-time').value = toLocalInput(new Date(draft.ts));
  $('#f-ml').value = draft.ml ?? '';
  $('#f-note').value = draft.note || '';
  $('#f-delete').hidden = !editing;
  // Finishing: end time defaults to now. The server ends feeds at an hour; this covers a phone that hasn't synced yet.
  $('#f-end').value = toLocalInput(new Date());
  $('#f-forgot').checked = !!(editing && draft.open && Date.now() - new Date(draft.ts) >= 3600000);
  $('#f-end').disabled = $('#f-forgot').checked;
  // Weigh-ins don't switch type with feeds and nappies.
  $('#f-kind').hidden = !editing || draft.open || draft.kind === 'weight';
  fillWeight(draft.kind === 'weight' ? draft.weight_g : null);
  syncSheet();
  sheet.showModal();
  // Finishing a started feed: the only thing left to fill in is the amount.
  if (draft.open && (draft.kind === 'bottle')) $('#f-ml').focus();
  if (draft.kind === 'weight' && !editing) $(state.unit === 'lb' ? '#f-lb' : '#f-kg').focus();
}

function syncSheet() {
  const k = draft.kind;
  const finishing = draft._edit && draft.open;
  const canStart = !draft._edit && (k === 'bottle' || k === 'breast');
  $('#sheet-title').textContent = finishing ? `Finish ${KIND_LABEL[k].toLowerCase()}` : draft._edit ? `Edit ${KIND_LABEL[k].toLowerCase()}` : KIND_LABEL[k];
  $('#f-finish-hint').hidden = !finishing;
  if (finishing) {
    const started = new Date(draft.ts);
    $('#f-finish-hint').innerHTML = `Started at <b>${hm(started)}</b>, ${dur(Date.now() - started)} ago. ${k === 'bottle' ? 'Add how much was taken, then' : 'When the feed is done,'} tap Continue feed if the feed isn’t over, or Finish feed if it is.`;
  }
  $('#f-save').textContent = finishing ? 'Finish feed' : 'Save';
  $('#f-continue').hidden = !finishing;
  $('#f-end-wrap').hidden = !finishing;
  $('#f-ml-label').textContent = finishing ? 'Amount so far' : 'Amount';
  $('#f-time-label').textContent = finishing || draft.open ? 'Started at' : 'Time';
  $('#f-start').hidden = !canStart;
  $('#f-start-hint').hidden = !canStart;
  $$('#f-kind button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === k)));
  $('#f-kind [data-v="breast"]').hidden = state.hideBreast && k !== 'breast';
  $('#f-ml-wrap').hidden = !(k === 'bottle' || k === 'breast');
  $('#f-side-wrap').hidden = k !== 'breast';
  $('#f-weight-wrap').hidden = k !== 'weight';
  $('#f-also').hidden = k === 'weight';
  if (k === 'weight') syncWeight();
  $$('#f-side button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === draft.side)));
  $$('.toggle').forEach((b) => b.setAttribute('aria-pressed', String(!!draft[b.dataset.flag])));
  $('#ml-chips').innerHTML = state.feedSizes.map((v) => `<button type="button" data-ml="${v}" aria-pressed="${Number($('#f-ml').value) === v}" class="${Number($('#f-ml').value) === v ? 'on' : ''}">${v}</button>`).join('');
}

$$('.quick-btn').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.kind)));
$('#tab-log').addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (!row) return;
  const e = state.entries.find((x) => x.id === row.dataset.id);
  if (e) openSheet(e);
});
$$('.tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; LS.set('cradlelog.tab', state.tab); render(); }));

$('#f-kind').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  draft.kind = b.dataset.v;
  if (draft.kind === 'breast' && !draft.side) draft.side = 'both';
  syncSheet();
});
$('#f-side').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  draft.side = draft.side === b.dataset.v ? null : b.dataset.v;
  syncSheet();
});
$('#time-chips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const base = Number(b.dataset.min) === 0 ? new Date() : new Date($('#f-time').value || Date.now());
  base.setMinutes(base.getMinutes() + Number(b.dataset.min));
  $('#f-time').value = toLocalInput(base);
});
$$('.step').forEach((b) => b.addEventListener('click', () => {
  const v = Math.max(0, (Number($('#f-ml').value) || 0) + Number(b.dataset.step));
  $('#f-ml').value = v;
  syncSheet();
}));
$('#ml-chips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  $('#f-ml').value = b.dataset.ml;
  syncSheet();
});
$('#f-ml').addEventListener('input', syncSheet);
$('#end-chips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const d = new Date();
  d.setMinutes(d.getMinutes() + Number(b.dataset.min));
  $('#f-end').value = toLocalInput(d);
  $('#f-forgot').checked = false;
  $('#f-end').disabled = false;
});
$('#f-forgot').addEventListener('change', () => { $('#f-end').disabled = $('#f-forgot').checked; });
$$('.toggle').forEach((b) => b.addEventListener('click', () => { draft[b.dataset.flag] = !draft[b.dataset.flag]; syncSheet(); }));
$('#sheet-close').addEventListener('click', () => sheet.close());
sheet.addEventListener('click', (ev) => { if (ev.target === sheet) sheet.close(); });

$('#entry-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = new Date($('#f-time').value);
  if (Number.isNaN(t.getTime())) return;
  const ml = $('#f-ml').value === '' ? null : Number($('#f-ml').value);
  let weight_g = null;
  if (draft.kind === 'weight') {
    weight_g = sheetWeight();
    if (!weight_g) { $(state.unit === 'lb' ? '#f-lb' : '#f-kg').focus(); toast('Enter the weight first (between 0.5 and 30 kg).'); return; }
  }
  const before = state.entries.find((e) => e.id === draft.id);
  const entry = entryFromSheet(t, ml, false, weight_g);
  if (draft._edit && draft.open && !$('#f-forgot').checked) {
    const end = new Date($('#f-end').value);
    if (Number.isNaN(end.getTime())) { $('#f-end').focus(); toast('Set when the feed finished, or switch on Forgot to end.'); return; }
    if (end < t) { $('#f-end').focus(); toast('The finish time is before the start time.'); return; }
    entry.end_ts = end.toISOString();
  }
  queuePut(entry);
  sheet.close();
  const what = entry.kind === 'weight' ? `weigh-in: ${weightText(entry.weight_g)}` : `the ${hm(t)} ${describe(entry).toLowerCase()}`;
  if (before) undoToast(`Saved changes to ${what}.`, () => queuePut({ ...before }));
  else undoToast(`Logged ${what}.`, () => queueDelete(entry.id));
});

function entryFromSheet(t, ml, open, weight_g = null) {
  const { _edit, ...rest } = draft;
  return {
    ...rest,
    ts: t.toISOString(),
    ml: draft.kind === 'bottle' || draft.kind === 'breast' ? ml : null,
    side: draft.kind === 'breast' ? draft.side : null,
    note: $('#f-note').value.trim() || null,
    open,
    end_ts: open ? null : draft.end_ts ?? null,
    weight_g: draft.kind === 'weight' ? weight_g : null,
  };
}

// Weight fields: kg, or lb + oz. The grams come from whatever was last typed, so
// flipping units to check the other number never changes the value (no rounding drift).
let draftGrams = null;
function readTyped() {
  let g;
  if (state.unit === 'lb') {
    const lb = Number($('#f-lb').value || 0), oz = Number($('#f-oz').value || 0);
    g = Math.round(lb * LB + oz * (LB / 16));
  } else {
    g = Math.round(Number($('#f-kg').value) * 1000);
  }
  draftGrams = g >= 500 && g <= 30000 ? g : null;
}
const sheetWeight = () => draftGrams;
function fillWeight(g) {
  draftGrams = g || null;
  $('#f-kg').value = g ? (g / 1000).toFixed(2) : '';
  const { lb, oz } = g ? lbOz(g) : { lb: '', oz: '' };
  $('#f-lb').value = lb; $('#f-oz').value = oz;
}
function syncWeight() {
  $$('#f-unit button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === state.unit)));
  $('#f-kg-row').hidden = state.unit !== 'kg';
  $('#f-lb-row').hidden = state.unit !== 'lb';
  const g = sheetWeight();
  $('#f-weight-other').textContent = g ? `That's ${state.unit === 'lb' ? kgText(g) : lbText(g)}.` : '';
}
$('#f-unit').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const g = sheetWeight();
  state.unit = b.dataset.v;
  LS.set('cradlelog.unit', state.unit);
  fillWeight(g);
  syncWeight();
});
['#f-kg', '#f-lb', '#f-oz'].forEach((s) => $(s).addEventListener('input', () => { readTyped(); syncWeight(); }));

// Start a feed now and fill in the amount later. The clocks count from this start time.
$('#f-start').addEventListener('click', () => {
  const t = new Date($('#f-time').value || Date.now());
  if (Number.isNaN(t.getTime())) return;
  const entry = entryFromSheet(t, null, true);
  queuePut(entry);
  sheet.close();
  undoToast(`${KIND_LABEL[draft.kind]} started at ${hm(t)}. Tap Finish feed when it's done.`, () => queueDelete(entry.id));
});
// Continue feed: save the amount so far and keep the feed open.
$('#f-continue').addEventListener('click', () => {
  const t = new Date($('#f-time').value);
  if (Number.isNaN(t.getTime())) return;
  const before = state.entries.find((e) => e.id === draft.id);
  const ml = $('#f-ml').value === '' ? null : Number($('#f-ml').value);
  const entry = entryFromSheet(t, ml, true);
  queuePut(entry);
  sheet.close();
  undoToast(`Saved ${ml ? `${ml} ml` : 'progress'} so far. The ${draft.kind} feed is still going.`, () => before && queuePut({ ...before }));
});
// No "are you sure?": delete straight away and offer Undo.
$('#f-delete').addEventListener('click', () => {
  const before = state.entries.find((e) => e.id === draft.id);
  queueDelete(draft.id);
  sheet.close();
  if (before) undoToast(`Deleted the ${hm(new Date(before.ts))} ${describe(before).toLowerCase()}.`, () => queuePut({ ...before, deleted: false }));
});

// ---------- settings ----------
const settings = $('#settings');
$('#open-settings').addEventListener('click', () => {
  $('#s-name').value = state.babyName;
  $('#s-birth').value = state.birth || '';
  $('#s-breast').checked = !state.hideBreast;
  $('#s-sizes').value = state.feedSizes.join(', ');
  fillFeedGap();
  refreshAlerts();
  settings.showModal();
});

// Import: send a CSV saved from "Download all entries"; the server skips anything already there.
$('#s-import').addEventListener('click', () => $('#s-import-file').click());
$('#s-import-file').addEventListener('change', async () => {
  const file = $('#s-import-file').files[0];
  $('#s-import-file').value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('That file is too large to import.'); return; }
  try {
    const r = await api('/api/import', { method: 'POST', type: 'text/csv', body: await file.text() });
    const bad = r.errors.length ? ` ${r.errors.length > 1 ? `${r.errors.length} rows` : '1 row'} could not be read: ${r.errors[0]}` : '';
    toast(`Imported ${r.imported} ${r.imported === 1 ? 'entry' : 'entries'}${r.skipped && !r.errors.length ? `, ${r.skipped} already there` : ''}.${bad}`);
    sync();
  } catch (err) { toast(err.message || "Couldn't import that file."); }
});

// Sign out: ends this phone's session and clears the copy of the log kept on it.
$('#s-signout').addEventListener('click', async () => {
  if (state.outbox.length) { toast(`${state.outbox.length} entries haven't synced yet. Connect and wait for them to sync before signing out.`); return; }
  try { await api('/api/logout', { method: 'POST' }); } catch (err) { if (err.status !== 401) { toast("Couldn't sign out. Check your connection and try again."); return; } }
  try { Object.keys(localStorage).filter((k) => k.startsWith('cradlelog.')).forEach((k) => localStorage.removeItem(k)); } catch {}
  location.reload();
});

// ---------- feed alerts (per phone) ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
function alertsNote(text) {
  $('#s-alerts-note').textContent = text || '';
  $('#s-alerts-note').hidden = !text;
}
async function refreshAlerts() {
  const sw = $('#s-alerts');
  if (!pushSupported()) {
    sw.checked = false; sw.disabled = true; $('#s-alerts-test').hidden = true;
    alertsNote(isIOS() && !isInstalled()
      ? 'On iPhone, alerts need Cradlelog on your Home Screen: tap Share, then "Add to Home Screen", open it from there and turn this on.'
      : "This browser can't show alerts. Try Chrome, or Safari from the Home Screen on iPhone.");
    return;
  }
  sw.disabled = false;
  const sub = await currentSub().catch(() => null);
  const on = !!sub && Notification.permission === 'granted';
  sw.checked = on;
  $('#s-alerts-test').hidden = !on;
  alertsNote(Notification.permission === 'denied'
    ? 'Notifications are blocked for Cradlelog. Allow them in your phone or browser settings, then turn this on.' : '');
}
const b64ToBytes = (s) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
$('#s-alerts').addEventListener('change', async () => {
  const sw = $('#s-alerts');
  sw.disabled = true;
  try {
    if (sw.checked) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error(perm === 'denied'
        ? 'Notifications are blocked for Cradlelog. Allow them in your phone or browser settings, then try again.'
        : 'Alerts need permission to show notifications.');
      const { publicKey } = await api('/api/push/key');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      toast('Feed alerts are on for this phone.', 5000);
    } else {
      const sub = await currentSub();
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe();
      }
      toast('Feed alerts are off for this phone.', 5000);
    }
  } catch (err) {
    toast(err.message || "Couldn't change alerts. Check your signal and try again.");
  }
  await refreshAlerts();
});
$('#s-alerts-test').addEventListener('click', async () => {
  try {
    const sub = await currentSub();
    await api('/api/push/test', { method: 'POST', body: JSON.stringify({ endpoint: sub?.endpoint }) });
    toast('Test alert sent. It should appear in a few seconds.', 5000);
  } catch (err) {
    toast(err.message || "Couldn't send a test alert.");
  }
});

// Half-hour steps from 30 minutes to 8 hours.
const GAP_STEPS = Array.from({ length: 16 }, (_, i) => (i + 1) / 2);
const gapLabel = (h) => (h < 1 ? '30 min' : `${Math.floor(h)}${h % 1 ? '½' : ''} hour${h === 1 ? '' : 's'}`);
function fillFeedGap() {
  for (const [id, val] of [['#s-feed-min', state.feedMin], ['#s-feed-max', state.feedMax]]) {
    const steps = GAP_STEPS.includes(val) ? GAP_STEPS : [...GAP_STEPS, val].sort((a, b) => a - b);
    $(id).innerHTML = steps.map((h) => `<option value="${h}"${h === val ? ' selected' : ''}>${gapLabel(h)}</option>`).join('');
  }
}
function saveFeedGap(changed) {
  let min = Number($('#s-feed-min').value), max = Number($('#s-feed-max').value);
  // Keep the pair in order by moving the other end to match.
  if (min > max) { if (changed === 'min') max = min; else min = max; }
  state.feedMin = min; state.feedMax = max;
  LS.set('cradlelog.feedMin', min); LS.set('cradlelog.feedMax', max);
  fillFeedGap();
  renderStatus();
  api('/api/settings', { method: 'PUT', body: JSON.stringify({ feedMin: min, feedMax: max }) })
    .catch(() => toast("Couldn't save the feed times. Check your signal and try again."));
}
$('#s-feed-min').addEventListener('change', () => saveFeedGap('min'));
$('#s-feed-max').addEventListener('change', () => saveFeedGap('max'));
$('#s-sizes').addEventListener('change', () => {
  const v = [...new Set($('#s-sizes').value.split(/[^0-9]+/).filter(Boolean).map(Number))]
    .filter((n) => n >= 1 && n <= 1000).sort((a, b) => a - b).slice(0, 12);
  if (!v.length) { $('#s-sizes').value = state.feedSizes.join(', '); toast('Enter at least one size in ml, like 90, 120.'); return; }
  state.feedSizes = v;
  LS.set('cradlelog.feedSizes', v);
  $('#s-sizes').value = v.join(', ');
  api('/api/settings', { method: 'PUT', body: JSON.stringify({ feedSizes: v }) })
    .catch(() => toast("Couldn't save the feed sizes. Check your signal and try again."));
});
$('#s-breast').addEventListener('change', () => {
  state.hideBreast = !$('#s-breast').checked;
  LS.set('cradlelog.hideBreast', state.hideBreast);
  render();
  api('/api/settings', { method: 'PUT', body: JSON.stringify({ hideBreast: state.hideBreast }) })
    .catch(() => toast("Couldn't save that setting. Check your signal and try again."));
});
$('#s-name').addEventListener('change', () => {
  state.babyName = $('#s-name').value.trim();
  LS.set('cradlelog.babyName', state.babyName);
  render();
  api('/api/settings', { method: 'PUT', body: JSON.stringify({ babyName: state.babyName }) })
    .catch(() => toast("Couldn't save the name. Check your signal and try again."));
});
$('#s-birth').addEventListener('change', async () => {
  state.birth = $('#s-birth').value || null;
  LS.set('cradlelog.birth', state.birth);
  render();
  api('/api/settings', { method: 'PUT', body: JSON.stringify({ birth: state.birth || '' }) }).catch(() => {});
});
settings.addEventListener('click', (ev) => { if (ev.target === settings) settings.close(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
