import { sendPush, generateVapidKeys, bytesToB64url } from './push.js';
import {
  parseIcs, icsEventToItem, plannerToItem, modulesToReadings, mergeItem, isOpen,
  zonedParts, validTz, DEFAULT_TZ,
} from './model.js';

const DIGEST_HOUR = 20;              // 8pm local: "here's tomorrow"
const REMIND_BEFORE_MS = 3 * 3600e3; // nudge 3 hours before each open item
const KEEP_PAST_MS = 10 * 864e5;     // drop items more than 10 days past due

// ---------------- config ----------------
// Everything a new install needs is created on first visit and kept in KV, so
// deploying needs no secrets. Secrets set with `wrangler secret` still win, which
// keeps older installs (configured from the command line) working.

async function getConfig(env, origin) {
  const kv = (await env.KV.get('config', 'json')) || {};
  const appKey = env.APP_KEY || kv.appKey || '';
  const icsUrl = kv.icsUrl || env.CANVAS_ICS_URL || '';
  return {
    appKey,
    icsUrl,
    tz: kv.tz || env.TIMEZONE || DEFAULT_TZ,
    vapidPublic: env.VAPID_PUBLIC || kv.vapidPublic || '',
    vapidPrivateJwk: env.VAPID_PRIVATE_JWK || kv.vapidPrivateJwk || '',
    subject: env.VAPID_SUBJECT || kv.subject || (origin ? origin : 'mailto:noreply@example.com'),
    configured: !!(appKey && icsUrl),
    kv,
  };
}

const saveConfig = (env, kv) => env.KV.put('config', JSON.stringify(kv));

// Errors meant for the person using the app (shown as-is, HTTP 400).
const userError = msg => Object.assign(new Error(msg), { user: true });

function normalizeFeedUrl(raw) {
  let u = String(raw || '').trim();
  u = u.replace(/^webcals?:\/\//i, 'https://');
  let url;
  try { url = new URL(u); } catch { throw userError('That is not a link. Copy the whole Calendar Feed URL from Canvas.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'; // for local testing
  if (url.protocol !== 'https:' && !local) throw userError('The feed link should start with https://');
  return url.toString();
}

async function checkFeed(icsUrl) {
  let res;
  try { res = await fetch(icsUrl, { headers: { 'User-Agent': 'canvas-hw-tracker' } }); }
  catch { throw userError('Could not reach that link.'); }
  if (!res.ok) throw userError(`Canvas answered ${res.status} for that link. Copy the Calendar Feed link again.`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw userError('That link is not a calendar feed. In Canvas, open Calendar and use the "Calendar Feed" link.');
  return text;
}

// ---------------- storage ----------------

async function load(env) {
  const [items, subs, state] = await Promise.all([
    env.KV.get('items', 'json'), env.KV.get('subs', 'json'), env.KV.get('state', 'json'),
  ]);
  return { items: items || {}, subs: subs || [], state: state || {} };
}
const saveItems = (env, items) => env.KV.put('items', JSON.stringify(items));
const saveSubs = (env, subs) => env.KV.put('subs', JSON.stringify(subs));
const saveState = (env, state) => env.KV.put('state', JSON.stringify(state));

function prune(items) {
  const cutoff = Date.now() - KEEP_PAST_MS;
  for (const [id, it] of Object.entries(items)) {
    if (it.due && Date.parse(it.due) < cutoff) delete items[id];
    else if (it.kind === 'event' && it.due && Date.parse(it.due) < Date.now() - 864e5) delete items[id];
  }
}

// ---------------- calendar feed ----------------

async function refreshFeed(env, cfg, prefetched) {
  if (!cfg.icsUrl) return { skipped: 'no feed url' };
  let text = prefetched;
  if (!text) {
    const res = await fetch(cfg.icsUrl, { headers: { 'User-Agent': 'canvas-hw-tracker' } });
    if (!res.ok) throw new Error('Calendar feed returned ' + res.status);
    text = await res.text();
  }
  const fresh = parseIcs(text, cfg.tz).map(icsEventToItem).filter(Boolean);

  const { items, state } = await load(env);
  const seen = new Set();
  for (const f of fresh) {
    seen.add(f.id);
    items[f.id] = mergeItem(items[f.id], f, 'ics');
  }
  // Items that vanished from the feed (deleted/unpublished) and only ever came from it.
  for (const [id, it] of Object.entries(items)) {
    const onlyFeed = (it.src || []).every(s => s === 'ics');
    if (onlyFeed && !seen.has(id) && it.due && Date.parse(it.due) > Date.now()) delete items[id];
  }
  prune(items);
  state.lastFeed = new Date().toISOString();
  delete state.feedError;
  await Promise.all([saveItems(env, items), saveState(env, state)]);
  return { count: fresh.length };
}

// ---------------- notifications ----------------

async function pushAll(env, cfg, data, subs) {
  const keep = [];
  const errors = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      const r = await sendPush(sub, data, cfg);
      if (r.ok) sent++; else errors.push('push service ' + r.status);
      if (!r.gone) keep.push(sub);
    } catch (e) {
      errors.push(e.message || String(e));
      keep.push(sub);
    }
  }
  if (keep.length !== subs.length) await saveSubs(env, keep);
  if (errors.length) console.error('push errors', errors);
  pushAll.lastErrors = errors;
  return sent;
}

function fmtTime(iso, tz) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}

async function runReminders(env, cfg) {
  const { items, subs, state } = await load(env);
  if (!subs.length || !cfg.vapidPublic) return { skipped: 'no subscribers' };
  const now = Date.now();
  let changed = false, sent = 0;

  for (const it of Object.values(items)) {
    if (!isOpen(it) || !it.due) continue;
    const left = Date.parse(it.due) - now;
    if (left > 0 && left <= REMIND_BEFORE_MS && !it.notified?.h3) {
      const hrs = Math.max(1, Math.round(left / 3600e3));
      const n = await pushAll(env, cfg, {
        title: `${it.course || 'Due soon'}: due ${fmtTime(it.due, cfg.tz)}`,
        body: `${it.title} (about ${hrs}h left)`,
        url: it.url || '/',
        tag: it.id,
      }, subs);
      sent += n;
      // only mark it if a device actually got it, so a flaky run retries next time
      if (n > 0) { it.notified = { ...(it.notified || {}), h3: true }; changed = true; }
    }
  }

  const p = zonedParts(new Date(now), cfg.tz);
  if (p.h >= DIGEST_HOUR && state.digestDay !== p.key) {
    const tomorrowEnd = endOfDay(now, 1, cfg.tz);
    const due = Object.values(items)
      .filter(it => isOpen(it) && it.due && Date.parse(it.due) > now && Date.parse(it.due) <= tomorrowEnd)
      .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
    const readings = Object.values(items).filter(it => isOpen(it) && it.kind === 'reading' && !it.due);
    if (due.length || readings.length) {
      const lines = due.slice(0, 6).map(it => `${fmtTime(it.due, cfg.tz)} · ${it.course} · ${it.title}`);
      if (due.length > 6) lines.push(`+${due.length - 6} more`);
      if (readings.length) lines.push(`${readings.length} reading${readings.length > 1 ? 's' : ''} still open`);
      sent += await pushAll(env, cfg, {
        title: due.length ? `${due.length} thing${due.length > 1 ? 's' : ''} due by end of tomorrow` : 'Readings still open',
        body: lines.join('\n'),
        url: '/',
        tag: 'digest',
      }, subs);
    }
    state.digestDay = p.key;
    await saveState(env, state);
  }

  if (changed) await saveItems(env, items);
  return { sent };
}

// End of the local day `plusDays` after `now`, in ms (last millisecond of that day).
export function endOfDay(now, plusDays, tz = DEFAULT_TZ) {
  let t = now, advanced = 0, lastKey = zonedParts(new Date(now), tz).key;
  while (advanced <= plusDays) {
    t += 3600e3;
    const k = zonedParts(new Date(t), tz).key;
    if (k !== lastKey) { advanced++; lastKey = k; }
  }
  const p = zonedParts(new Date(t), tz);
  return t - (p.h * 3600e3 + p.mi * 60e3) - 1;
}

// ---------------- HTTP helpers ----------------

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

// The Sync bookmark runs on whatever domain your school's Canvas uses, so any https
// origin may call the API, but only with the app key in a header. Cookies are never
// sent cross-origin here (no Allow-Credentials), so the login cookie can't be abused.
function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  if (!/^https:\/\//.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function keyMatches(got, want) {
  got = got || '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function cookieKey(req) {
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)hw_key=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function bearerKey(req) {
  return (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
}

// Cookie auth only for same-origin requests, so another site can't ride on it.
function authed(req, cfg) {
  if (keyMatches(bearerKey(req), cfg.appKey)) return true;
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) return false;
  return keyMatches(cookieKey(req), cfg.appKey);
}

// HttpOnly server cookie: survives far longer on iOS than storage set from JavaScript.
const sessionCookie = key =>
  `hw_key=${encodeURIComponent(key)}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`;

const MANIFEST = {
  name: 'HW Tracker',
  short_name: 'HW',
  description: 'Canvas homework, prep and readings with reminders',
  scope: '/',
  display: 'standalone',
  background_color: '#0f1115',
  theme_color: '#0f1115',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

// When Safari is already signed in, the home-screen app's start URL carries the
// login, so the installed app opens signed in without typing anything.
function manifestFor(req, cfg) {
  const signedIn = keyMatches(cookieKey(req), cfg.appKey);
  const start_url = signedIn ? '/login?k=' + encodeURIComponent(cfg.appKey) : '/';
  return new Response(JSON.stringify({ ...MANIFEST, start_url }), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' },
  });
}

function loginRedirect(req, cfg) {
  const url = new URL(req.url);
  const k = (url.searchParams.get('k') || '').trim();
  if (!keyMatches(k, cfg.appKey)) return Response.redirect(url.origin + '/#badkey', 302);
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': sessionCookie(k), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

// ---------------- API ----------------

async function handleApi(req, env, cfg) {
  const url = new URL(req.url);
  const path = url.pathname;
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (path === '/api/status') return json({ configured: cfg.configured });
  if (path === '/api/vapid') return json({ key: cfg.vapidPublic || null });

  // First visit: whoever finishes setup owns this install. After that it's locked.
  if (path === '/api/setup' && req.method === 'POST') {
    if (cfg.configured) return json({ error: 'This tracker is already set up. Sign in with its app key.' }, 409);
    const b = await req.json().catch(() => ({}));
    if (env.APP_KEY && !keyMatches(String(b.key || ''), env.APP_KEY)) {
      return json({ error: 'This install has an app key set on the server. Enter it to finish setup.' }, 401);
    }
    const icsUrl = normalizeFeedUrl(b.icsUrl);
    const text = await checkFeed(icsUrl);
    const tz = validTz(b.tz) ? b.tz : DEFAULT_TZ;
    const kv = { ...cfg.kv, icsUrl, tz, createdAt: new Date().toISOString() };
    if (!env.APP_KEY && !kv.appKey) kv.appKey = bytesToB64url(crypto.getRandomValues(new Uint8Array(18)));
    if (!env.VAPID_PUBLIC && !kv.vapidPublic) Object.assign(kv, await generateVapidKeys());
    if (!env.VAPID_SUBJECT) kv.subject = url.origin;
    await saveConfig(env, kv);
    const next = await getConfig(env, url.origin);
    const r = await refreshFeed(env, next, text);
    return json({ ok: true, key: next.appKey, count: r.count }, 200, { 'Set-Cookie': sessionCookie(next.appKey) });
  }

  if (path === '/api/login' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const k = String(b.key || '').trim();
    if (!keyMatches(k, cfg.appKey)) return json({ error: 'That key is not right. Check for a missing or extra character.' }, 401);
    return json({ ok: true, key: k }, 200, { 'Set-Cookie': sessionCookie(k) });
  }
  if (path === '/api/logout' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': 'hw_key=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
  }

  if (!authed(req, cfg)) return json({ error: 'Wrong or missing app key' }, 401, cors);

  // Cookie-only clients (a freshly installed home-screen app) get the key back
  // so the page can build the Sync bookmark and the phone link.
  if (path === '/api/session') return json({ ok: true, key: cfg.appKey });

  if (path === '/api/items' && req.method === 'GET') {
    const { items, state, subs } = await load(env);
    let feedHost = '';
    try { feedHost = new URL(cfg.icsUrl).host; } catch {}
    return json({ items: Object.values(items), state, subscribers: subs.length, config: { tz: cfg.tz, feedHost } });
  }

  if (path === '/api/config' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const kv = { ...cfg.kv };
    let text;
    if (b.icsUrl) { kv.icsUrl = normalizeFeedUrl(b.icsUrl); text = await checkFeed(kv.icsUrl); }
    if (b.tz) { if (!validTz(b.tz)) return json({ error: 'Unknown timezone' }, 400); kv.tz = b.tz; }
    await saveConfig(env, kv);
    const next = await getConfig(env, url.origin);
    const r = await refreshFeed(env, next, text);
    return json({ ok: true, count: r.count, config: { tz: next.tz } });
  }

  if (path === '/api/items' && req.method === 'POST') {
    const b = await req.json();
    if (!b.title) return json({ error: 'title required' }, 400);
    const { items } = await load(env);
    const id = 'c:' + crypto.randomUUID().slice(0, 8);
    items[id] = {
      id, title: String(b.title).slice(0, 200), course: String(b.course || '').slice(0, 40),
      courseFull: '', due: b.due || null, url: b.url || null,
      kind: b.kind === 'reading' ? 'reading' : 'custom',
      done: false, hidden: false, notified: {}, src: ['manual'], updated: new Date().toISOString(),
    };
    await saveItems(env, items);
    return json({ item: items[id] });
  }

  const m = path.match(/^\/api\/items\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const { items } = await load(env);
    if (!items[id]) return json({ error: 'not found' }, 404);
    if (req.method === 'PATCH') {
      const b = await req.json();
      for (const k of ['done', 'hidden']) if (typeof b[k] === 'boolean') items[id][k] = b[k];
      if (b.due !== undefined && items[id].src.includes('manual')) { items[id].due = b.due; items[id].notified = {}; }
      await saveItems(env, items);
      return json({ item: items[id] });
    }
    if (req.method === 'DELETE') {
      if (items[id].src.includes('manual')) delete items[id]; else items[id].hidden = true;
      await saveItems(env, items);
      return json({ ok: true });
    }
  }

  if (path === '/api/sync' && req.method === 'POST') {
    const b = await req.json();
    const origin = /^https:\/\/[^/]+$/.test(b.origin || '') ? b.origin : '';
    const { items, state } = await load(env);
    let n = 0, submitted = 0;
    for (const p of b.planner || []) {
      const f = plannerToItem(p, origin);
      if (!f) continue;
      items[f.id] = mergeItem(items[f.id], f, 'sync');
      n++; if (f.submitted) submitted++;
    }
    const readings = modulesToReadings(b.modules, b.courses);
    const keepReadings = new Set(readings.map(r => r.id));
    for (const [id, it] of Object.entries(items)) {
      if (id.startsWith('m:') && !keepReadings.has(id)) delete items[id];
    }
    for (const r of readings) items[r.id] = mergeItem(items[r.id], r, 'sync');
    prune(items);
    state.lastSync = new Date().toISOString();
    await Promise.all([saveItems(env, items), saveState(env, state)]);
    const open = Object.values(items).filter(it => isOpen(it) && (!it.due || Date.parse(it.due) > Date.now())).length;
    return json({ ok: true, summary: `${n} Canvas items (${submitted} already submitted), ${readings.length} readings. ${open} still open.` }, 200, cors);
  }

  if (path === '/api/refresh' && req.method === 'POST') {
    try { return json(await refreshFeed(env, cfg)); }
    catch (e) { return json({ error: e.message }, 502); }
  }

  if (path === '/api/subscribe' && req.method === 'POST') {
    const sub = await req.json();
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json({ error: 'bad subscription' }, 400);
    const { subs } = await load(env);
    const next = subs.filter(s => s.endpoint !== sub.endpoint);
    next.push({ endpoint: sub.endpoint, keys: sub.keys, added: new Date().toISOString() });
    await saveSubs(env, next);
    return json({ ok: true, subscribers: next.length });
  }

  if (path === '/api/test-push' && req.method === 'POST') {
    const { subs } = await load(env);
    if (!subs.length) return json({ error: 'No devices subscribed yet' }, 400);
    const sent = await pushAll(env, cfg, { title: 'HW Tracker', body: 'Notifications are working.', url: '/', tag: 'test' }, subs);
    return json({ ok: sent > 0, sent, errors: pushAll.lastErrors || [] });
  }

  if (path === '/api/run-reminders' && req.method === 'POST') {
    return json(await runReminders(env, cfg));
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const needsCfg = url.pathname === '/app.webmanifest' || url.pathname === '/login' || url.pathname.startsWith('/api/');
    if (!needsCfg) return env.ASSETS.fetch(req);
    try {
      const cfg = await getConfig(env, url.origin);
      if (url.pathname === '/app.webmanifest') return manifestFor(req, cfg);
      if (url.pathname === '/login') return loginRedirect(req, cfg);
      return await handleApi(req, env, cfg);
    } catch (e) {
      if (!e.user) console.error(e);
      return json({ error: e.user ? e.message : 'Something went wrong: ' + (e.message || e) }, e.user ? 400 : 500, corsHeaders(req));
    }
  },

  async scheduled(event, env) {
    const cfg = await getConfig(env);
    if (!cfg.configured) return;
    try { await refreshFeed(env, cfg); }
    catch (e) {
      console.error('feed', e);
      const { state } = await load(env);
      state.feedError = e.message;
      await saveState(env, state);
    }
    try { await runReminders(env, cfg); } catch (e) { console.error('reminders', e); }
  },
};
