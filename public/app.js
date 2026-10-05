const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');

let key = localStorage.getItem('hw_key') || '';
let data = { items: [], state: {}, subscribers: 0 };
let tab = 'upcoming';
let showDone = false;
let lastHidden = null;

// ---------------- api ----------------

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { forget(); showLogin('Your saved key stopped working. Sign in again.'); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
  return body;
}

async function load() {
  data = await api('/api/items');
  render();
}

// ---------------- helpers ----------------

function hue(str) {
  let h = 0;
  for (const c of str || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
const courseColor = c => c ? `hsl(${hue(c)} 62% 55%)` : 'var(--muted)';

function pDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function dayLabel(dayKey) {
  const today = pDay(new Date());
  const tomorrow = pDay(new Date(Date.now() + 864e5));
  if (dayKey === today) return 'Today';
  if (dayKey === tomorrow) return 'Tomorrow';
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const days = (dt - new Date()) / 864e5;
  return dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: days < 6 ? 'long' : 'short', month: days < 6 ? undefined : 'short', day: days < 6 ? undefined : 'numeric' });
}
function timeStr(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).replace(':00', '');
}
function relTime(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isDone = it => it.done || it.submitted;

function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button class="link-btn" style="color:inherit;text-decoration:underline">${esc(action.label)}</button>` : '');
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.fn(); };
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, action ? 5000 : 2600);
}

// ---------------- rendering ----------------

const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

function itemRow(it, { showDay = false } = {}) {
  if (it.kind === 'event') {
    return `<div class="item event"><div class="dot">•</div><div class="body"><div class="title">${esc(timeStr(it.due))} · ${esc(it.course || it.title)} class</div></div></div>`;
  }
  const done = isDone(it);
  const left = it.due ? Date.parse(it.due) - Date.now() : null;
  let dueCls = '';
  if (left !== null && !done) dueCls = left < 0 ? 'late' : left < 6 * 3600e3 ? 'soon' : '';
  const dueTxt = it.due ? (showDay ? `${dayLabel(pDay(new Date(it.due)))} ${timeStr(it.due)}` : timeStr(it.due)) : '';
  const tags = [];
  if (it.kind === 'exam') tags.push('<span class="tag exam">Exam</span>');
  if (it.kind === 'prep') tags.push('<span class="tag prep">Prep</span>');
  if (it.kind === 'reading') tags.push('<span class="tag reading">Reading</span>');
  if (it.submitted) tags.push('<span class="tag sub">Submitted</span>');
  const title = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title);
  return `<div class="item ${done ? 'done' : ''}" data-id="${esc(it.id)}">
    <button class="check" data-act="toggle" aria-label="${done ? 'Mark not done' : 'Mark done'}">${CHECK}</button>
    <div class="body">
      <div class="title">${title}</div>
      <div class="meta">
        ${it.course ? `<span class="chip" style="--c:${courseColor(it.course)}">${esc(it.course)}</span>` : ''}
        ${dueTxt ? `<span class="due ${dueCls}">${esc(dueTxt)}</span>` : ''}
        ${it.module ? `<span>${esc(it.module)}</span>` : ''}
        ${tags.join('')}
      </div>
    </div>
    <button class="more" data-act="hide" aria-label="Remove">×</button>
  </div>`;
}

function section(label, items, opts = {}) {
  if (!items.length) return '';
  return `<div class="section"><h2 class="${opts.cls || ''}">${esc(label)}</h2><span class="count">${opts.count ?? ''}</span></div>
    <div class="list">${items.map(i => itemRow(i, opts)).join('')}</div>`;
}

function visible() {
  return data.items.filter(it => !it.hidden && (showDone || !isDone(it) || it.kind === 'event'));
}

function renderUpcoming() {
  const now = Date.now();
  const items = visible().filter(it => it.due);
  const overdue = items.filter(it => it.kind !== 'event' && Date.parse(it.due) < now && !isDone(it) && Date.parse(it.due) > now - 7 * 864e5)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  const future = items.filter(it => Date.parse(it.due) >= now - (showDone ? 864e5 : 0) && (it.kind !== 'event' || Date.parse(it.due) >= now))
    .filter(it => it.kind !== 'event' || pDay(new Date(it.due)) === pDay(new Date()) || pDay(new Date(it.due)) === pDay(new Date(now + 864e5)))
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));

  const groups = new Map();
  for (const it of future) {
    const k = pDay(new Date(it.due));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const undated = visible().filter(it => !it.due && it.kind !== 'event');

  let html = section('Overdue', overdue, { cls: 'overdue', showDay: true, count: overdue.length });
  let shown = 0;
  for (const [k, list] of groups) {
    if (shown > 14 && !['Today', 'Tomorrow'].includes(dayLabel(k))) break;
    const open = list.filter(i => i.kind !== 'event' && !isDone(i)).length;
    html += section(dayLabel(k), list, { count: open ? `${open} open` : '' });
    shown++;
  }
  html += section('No due date', undated, { count: undated.length });
  if (!html) html = emptyState();
  view.innerHTML = html + doneToggle();
}

function renderPrep() {
  const items = visible().filter(it => ['prep', 'reading'].includes(it.kind) && it.kind !== 'event')
    .filter(it => !it.due || Date.parse(it.due) > Date.now() - 864e5);
  const dated = items.filter(it => it.due).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  const undated = items.filter(it => !it.due);
  let html = section('Before class', dated.slice(0, 30), { showDay: true, count: dated.length });
  html += section('Readings from Modules', undated, { count: undated.length });
  if (!html) html = `<div class="empty"><strong>No prep work open</strong>PREP lessons, reading quizzes, prelabs and module readings show up here. Run the Sync bookmark on Canvas to pull module readings.</div>`;
  view.innerHTML = html + doneToggle();
}

function renderCourses() {
  const items = visible().filter(it => it.kind !== 'event' && (!it.due || Date.parse(it.due) > Date.now() - 7 * 864e5));
  const by = new Map();
  for (const it of items) {
    const c = it.course || 'Other';
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(it);
  }
  const names = [...by.keys()].sort();
  let html = '';
  for (const c of names) {
    const list = by.get(c).sort((a, b) => (a.due ? Date.parse(a.due) : 9e15) - (b.due ? Date.parse(b.due) : 9e15));
    html += section(c, list.slice(0, 12), { showDay: true, count: `${list.filter(i => !isDone(i)).length} open` });
  }
  view.innerHTML = (html || emptyState()) + doneToggle();
}

function emptyState() {
  if (!data.state.lastFeed && !data.state.lastSync) {
    return `<div class="empty"><strong>Nothing loaded yet</strong>Tap refresh to pull your Canvas calendar feed, or run the Sync bookmark from Canvas (Settings has it).</div>`;
  }
  return `<div class="empty"><strong>All clear</strong>Nothing open right now.</div>`;
}

function doneToggle() {
  return `<div class="toggle-row"><button class="link-btn" data-act="showdone">${showDone ? 'Hide completed' : 'Show completed'}</button></div>`;
}

function bookmarklet() {
  const W = location.origin;
  const code = `(async()=>{const W=${JSON.stringify(W)},K=${JSON.stringify(key)};const T=m=>{let d=document.getElementById('hwt');if(!d){d=document.createElement('div');d.id='hwt';d.style.cssText='position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;background:#17181b;color:#fff;padding:12px 16px;border-radius:12px;font:600 14px -apple-system,sans-serif;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.3)';document.body.appendChild(d)}d.textContent=m};if(typeof ENV==='undefined'||location.origin===W){T('Open your Canvas site first, then tap this bookmark.');return}T('Syncing with HW Tracker…');try{const g=async u=>{let o=[],n=u;while(n){const r=await fetch(n,{headers:{Accept:'application/json'}});if(!r.ok)throw new Error('Canvas '+r.status);o=o.concat(await r.json());const m=(r.headers.get('link')||'').match(/<([^>]+)>;\\s*rel="next"/);n=m?m[1]:null}return o};const s=new Date(Date.now()-7*864e5).toISOString(),e=new Date(Date.now()+35*864e5).toISOString();const planner=await g('/api/v1/planner/items?per_page=100&start_date='+s+'&end_date='+e);const courses=(await g('/api/v1/courses?enrollment_state=active&per_page=50')).map(c=>({id:c.id,name:c.name}));const modules=[];for(const c of courses){try{const ms=await g('/api/v1/courses/'+c.id+'/modules?include[]=items&per_page=50');modules.push({courseId:c.id,mods:ms.map(m=>({name:m.name,state:m.state,items:(m.items||[]).map(i=>({id:i.id,title:i.title,type:i.type,url:i.html_url,req:!!i.completion_requirement,done:!!(i.completion_requirement&&i.completion_requirement.completed)}))}))})}catch(x){}}const r=await fetch(W+'/api/sync',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+K},body:JSON.stringify({origin:location.origin,planner,courses,modules})});const j=await r.json();T(r.ok?'Synced. '+j.summary:'Sync failed: '+(j.error||r.status))}catch(x){T('Sync failed: '+x.message)}setTimeout(()=>{const d=document.getElementById('hwt');d&&d.remove()},6000)})()`;
  return 'javascript:' + encodeURIComponent(code).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/');
}

const phoneLink = () => location.origin + '/login?k=' + encodeURIComponent(key);

function qrSvg(text) {
  if (typeof qrcode !== 'function') return '';
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function timezones() {
  try { return Intl.supportedValuesOf('timeZone'); }
  catch { return ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Asia/Kolkata']; }
}
const tzOptions = sel => timezones().map(z => `<option value="${esc(z)}" ${z === sel ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('');

function renderSettings() {
  const st = data.state || {};
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';

  let notif;
  if (isIOS && !standalone) {
    notif = `<p>On iPhone, notifications only work from the home screen app.</p>
      <ol><li>Tap the Share button in Safari.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Open HW from your home screen and come back here.</li></ol>`;
  } else if (!pushSupported) {
    notif = `<p>This browser doesn't support push notifications.</p>`;
  } else {
    notif = `<p>${perm === 'granted' ? `On. ${data.subscribers} device${data.subscribers === 1 ? '' : 's'} subscribed.` : perm === 'denied' ? 'Blocked. Turn them on in iOS Settings → Notifications → HW.' : 'Off.'}</p>
      <p>You get a reminder 3 hours before anything unfinished is due, plus an 8pm digest of what's due by the end of tomorrow.</p>
      <div class="row">
        <button class="primary" data-act="enablepush">${perm === 'granted' ? 'Re-subscribe this device' : 'Turn on notifications'}</button>
        <button class="ghost" data-act="testpush">Send test</button>
      </div>`;
  }

  const cfg = data.config || {};
  view.innerHTML = `
    ${standalone || isIOS ? '' : `<div class="card">
      <h3>Open it on your phone</h3>
      <p>Scan this with your iPhone camera to open your tracker already signed in. Then tap Share, then <b>Add to Home Screen</b>.</p>
      <div class="qr">${qrSvg(phoneLink())}</div>
      <p>This code and link sign anyone in to your tracker, so don't share them.</p>
      <div class="row"><button class="ghost" data-act="copylink">Copy sign-in link</button></div>
    </div>`}
    <div class="card"><h3>Notifications</h3>${notif}</div>
    <div class="card">
      <h3>Sync bookmark</h3>
      <p>Tap this bookmark while you're on Canvas to pull what's submitted plus readings from Modules. The calendar feed refreshes on its own every 30 minutes.</p>
      <ol>
        <li>Copy the code below.</li>
        <li>In Safari, bookmark any page (Share → Add Bookmark), name it <b>Sync HW</b>.</li>
        <li>Open Bookmarks, tap Edit, edit <b>Sync HW</b>, and paste the code in as the address.</li>
        <li>On your school's Canvas site, open Bookmarks and tap <b>Sync HW</b>.</li>
      </ol>
      <code class="block" id="bm">${esc(bookmarklet())}</code>
      <div class="row"><button class="primary" data-act="copybm">Copy bookmark code</button></div>
    </div>
    <div class="card">
      <h3>Canvas feed</h3>
      <p>${cfg.feedHost ? `Connected to <b>${esc(cfg.feedHost)}</b>.` : 'No feed connected.'} To switch accounts or fix a broken feed, paste a new Calendar Feed link.</p>
      <input id="newFeed" type="url" inputmode="url" placeholder="https://…/feeds/calendars/user_….ics" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label>Time zone for due dates and the 8pm digest
        <select id="tzSel">${tzOptions(cfg.tz || TZ)}</select></label>
      <div class="row"><button class="primary" data-act="savecfg">Save</button></div>
    </div>
    <div class="card">
      <h3>Status</h3>
      ${st.feedError ? `<p style="color:var(--danger)">Last feed refresh failed: ${esc(st.feedError)}</p>` : ''}
      <dl class="kv">
        <dt>Calendar feed</dt><dd>${esc(relTime(st.lastFeed))}</dd>
        <dt>Last Canvas sync</dt><dd>${esc(relTime(st.lastSync))}</dd>
        <dt>Items tracked</dt><dd>${data.items.filter(i => i.kind !== 'event').length}</dd>
      </dl>
      <div class="row">
        <button class="ghost" data-act="refreshfeed">Refresh feed now</button>
        <button class="ghost" data-act="logout">Sign out</button>
      </div>
    </div>`;
}

function render() {
  $('#title').textContent = { upcoming: 'Upcoming', prep: 'Prep & readings', courses: 'Courses', settings: 'Settings' }[tab];
  const st = data.state || {};
  const open = data.items.filter(i => !isDone(i) && !i.hidden && i.kind !== 'event' && (!i.due || Date.parse(i.due) > Date.now())).length;
  $('#status').textContent = `${open} open · synced ${relTime(st.lastSync || st.lastFeed)}`;
  $('#addBtn').hidden = tab === 'settings';
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ({ upcoming: renderUpcoming, prep: renderPrep, courses: renderCourses, settings: renderSettings })[tab]();
  $('#courseList').innerHTML = [...new Set(data.items.map(i => i.course).filter(Boolean))].sort().map(c => `<option value="${esc(c)}">`).join('');
}

// ---------------- actions ----------------

view.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.item');
  const id = row?.dataset.id;
  const it = id && data.items.find(i => i.id === id);
  const act = btn.dataset.act;
  try {
    if (act === 'toggle' && it) {
      if (it.submitted && !it.done) { toast('Canvas shows this as submitted'); return; }
      it.done = !it.done;
      render();
      await api('/api/items/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ done: it.done }) });
    } else if (act === 'hide' && it) {
      const manual = (it.src || []).includes('manual');
      data.items = data.items.filter(i => i.id !== id);
      lastHidden = it;
      render();
      await api('/api/items/' + encodeURIComponent(id), { method: 'DELETE' });
      toast(manual ? 'Deleted' : 'Hidden', manual ? null : { label: 'Undo', fn: async () => {
        await api('/api/items/' + encodeURIComponent(lastHidden.id), { method: 'PATCH', body: JSON.stringify({ hidden: false }) });
        await load();
      } });
    } else if (act === 'showdone') {
      showDone = !showDone; render();
    } else if (act === 'enablepush') {
      await enablePush();
    } else if (act === 'testpush') {
      const r = await api('/api/test-push', { method: 'POST' });
      toast(r.ok ? 'Test sent' : 'Push service rejected it');
    } else if (act === 'copybm') {
      await navigator.clipboard.writeText(bookmarklet());
      toast('Copied');
    } else if (act === 'copylink') {
      await navigator.clipboard.writeText(phoneLink());
      toast('Copied. Only send it to yourself.');
    } else if (act === 'savecfg') {
      const body = { tz: $('#tzSel').value };
      const feed = $('#newFeed').value.trim();
      if (feed) body.icsUrl = feed;
      btn.disabled = true;
      try {
        const r = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
        await load();
        toast(`Saved. ${r.count} items in your feed.`);
      } finally { btn.disabled = false; }
    } else if (act === 'refreshfeed') {
      await refresh();
    } else if (act === 'logout') {
      logout();
    }
  } catch (err) {
    toast(err.message);
    load().catch(() => {});
  }
});

async function refresh() {
  const b = $('#refreshBtn');
  b.classList.add('spin');
  try {
    const r = await api('/api/refresh', { method: 'POST' });
    await load();
    toast(r.skipped ? 'No calendar feed set on the server' : `Feed refreshed (${r.count} items)`);
  } catch (e) { toast(e.message); }
  finally { b.classList.remove('spin'); }
}

function urlB64ToUint8(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications not allowed'); render(); return; }
  const reg = await navigator.serviceWorker.ready;
  const { key: vapid } = await fetch('/api/vapid').then(r => r.json());
  if (!vapid) { toast('Server has no push keys set'); return; }
  let sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapid) });
  const r = await api('/api/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
  data.subscribers = r.subscribers;
  toast('Notifications on');
  render();
}

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  render();
  window.scrollTo({ top: 0 });
}));
$('#refreshBtn').addEventListener('click', refresh);

const dlg = $('#addDialog');
$('#addBtn').addEventListener('click', () => { $('#addForm').reset(); dlg.showModal(); });
$('#addCancel').addEventListener('click', () => dlg.close());
$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const due = f.get('due') ? new Date(f.get('due')).toISOString() : null;
  dlg.close();
  try {
    await api('/api/items', { method: 'POST', body: JSON.stringify({ title: f.get('title'), course: f.get('course'), due, kind: f.get('kind') }) });
    await load();
    toast('Added');
  } catch (err) { toast(err.message); }
});

// ---------------- login ----------------

function forget() {
  try { localStorage.removeItem('hw_key'); } catch {}
  key = '';
}

async function logout() {
  forget();
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  showLogin();
}

function showLogin(error = '') {
  document.body.innerHTML = `<div id="app"><form class="login" id="login" action="/" method="post">
    <h1>HW Tracker</h1>
    <p style="color:var(--muted)">Enter your app key once. This device stays signed in after that.</p>
    <input type="text" name="username" value="HW Tracker" autocomplete="username" style="position:absolute;opacity:0;height:0;width:0;pointer-events:none" tabindex="-1" aria-hidden="true">
    <label>App key<input name="k" autocomplete="current-password" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
    <p id="loginErr" style="color:var(--danger);font-size:14px;min-height:1em;margin:8px 0 0">${esc(error)}</p>
    <div style="margin-top:10px;display:grid;gap:8px">
      <button class="primary" style="width:100%">Sign in</button>
      <button type="button" class="ghost" id="pasteKey" style="width:100%">Paste key</button>
    </div>
  </form></div>`;
  const form = document.getElementById('login');
  const submit = async k => {
    const res = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { document.getElementById('loginErr').textContent = body.error || 'Sign in failed'; return; }
    try { localStorage.setItem('hw_key', body.key); } catch {}
    location.replace('/');
  };
  form.addEventListener('submit', e => { e.preventDefault(); submit(new FormData(form).get('k').trim()); });
  document.getElementById('pasteKey').addEventListener('click', async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      form.k.value = t;
      submit(t);
    } catch { document.getElementById('loginErr').textContent = 'Could not read the clipboard. Long-press the box and tap Paste.'; }
  });
}

// ---------------- first-run setup ----------------

function showSetup(error = '') {
  document.body.innerHTML = `<div id="app"><form class="login setup" id="setup">
    <h1>Set up HW Tracker</h1>
    <p style="color:var(--muted)">Connect your Canvas calendar. This takes about a minute.</p>
    <div class="card" style="margin-top:16px">
      <h3>1. Copy your Canvas feed link</h3>
      <ol>
        <li>On a computer, open your school's Canvas and click <b>Calendar</b> in the left menu.</li>
        <li>At the bottom right, click <b>Calendar Feed</b>.</li>
        <li>Copy the link that appears. It ends in <code>.ics</code>.</li>
      </ol>
    </div>
    <div class="card">
      <h3>2. Paste it here</h3>
      <input name="icsUrl" type="url" inputmode="url" required placeholder="https://…/feeds/calendars/user_….ics" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label>Your time zone<select name="tz">${tzOptions(TZ)}</select></label>
      <p id="setupErr" style="color:var(--danger);font-size:14px;min-height:1em;margin:10px 0 0">${esc(error)}</p>
      <button class="primary" style="width:100%;margin-top:8px">Connect Canvas</button>
    </div>
    <p style="color:var(--muted);font-size:13px">Your feed link stays in your own Cloudflare account. Whoever finishes this step owns this tracker, so finish it right after deploying.</p>
  </form></div>`;
  const form = $('#setup');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true; btn.textContent = 'Checking your feed…';
    try {
      const res = await fetch('/api/setup', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icsUrl: form.icsUrl.value, tz: form.tz.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Setup failed');
      key = body.key;
      try { localStorage.setItem('hw_key', key); } catch {}
      showSetupDone(body.count);
    } catch (err) {
      $('#setupErr').textContent = err.message;
      btn.disabled = false; btn.textContent = 'Connect Canvas';
    }
  });
}

function showSetupDone(count) {
  document.body.innerHTML = `<div id="app"><div class="login setup">
    <h1>You're connected</h1>
    <p style="color:var(--muted)">Found ${count} items in your Canvas calendar.</p>
    <div class="card" style="margin-top:16px">
      <h3>Put it on your phone</h3>
      <p>Scan this with your iPhone camera. It opens your tracker already signed in. Then tap Share, then <b>Add to Home Screen</b>, open it from your home screen, and turn on notifications in Settings.</p>
      <div class="qr">${qrSvg(phoneLink())}</div>
      <div class="row"><button class="ghost" id="copyLink">Copy sign-in link</button></div>
    </div>
    <div class="card">
      <h3>Save your app key</h3>
      <p>You'll only need it if a device ever signs out. Keep it in your password manager.</p>
      <code class="block">${esc(key)}</code>
      <div class="row"><button class="ghost" id="copyKey">Copy key</button></div>
    </div>
    <button class="primary" style="width:100%;margin-top:14px" id="go">Open my tracker</button>
  </div></div>`;
  $('#copyLink').onclick = async () => { await navigator.clipboard.writeText(phoneLink()); $('#copyLink').textContent = 'Copied'; };
  $('#copyKey').onclick = async () => { await navigator.clipboard.writeText(key); $('#copyKey').textContent = 'Copied'; };
  $('#go').onclick = () => location.replace('/');
}

// ---------------- boot ----------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

(async () => {
  if (location.hash === '#badkey') {
    history.replaceState(null, '', '/');
    showLogin('That sign-in link has the wrong key.');
    return;
  }
  try {
    const st = await fetch('/api/status').then(r => r.json());
    if (!st.configured) { showSetup(); return; }
  } catch {}
  if (!key) {
    // No saved key: the login cookie may still be there (or come from the sign-in link).
    try {
      const r = await fetch('/api/session', { credentials: 'same-origin' });
      if (r.ok) { key = (await r.json()).key || ''; try { localStorage.setItem('hw_key', key); } catch {} }
    } catch {}
  }
  if (!key) { showLogin(); return; }
  load().catch(e => toast(e.message));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && key) load().catch(() => {}); });
})();
