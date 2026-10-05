// Turning Canvas data (calendar feed + bookmarklet sync) into one list of items.

const PREP_RE = /\[prep\]|\bprep\b|pre-?class|pre-?lecture|pre-?lab|reading quiz|^RQ\b|\breading\b|\bread\b|\bwatch\b/i;
const READING_RE = /\bread|reading|watch|video|chapter|\bch\.?\s*\d|textbook|prep|prepare|review|lecture notes|slides/i;

export function shortCourse(name) {
  if (!name) return '';
  const m = name.match(/^([A-Za-z][A-Za-z &]*?)\s+(\d{3}[A-Z]?)/);
  if (!m) return name.split(':')[0].trim().slice(0, 24);
  let s = `${m[1].toUpperCase()} ${m[2]}`;
  if (/\blabs?\b/i.test(name)) s += ' Lab';
  return s;
}

const EXAM_RE = /^(exam|midterm|quiz \d|final)\b|\b(exam|midterm) \d\b|\bfinal exam\b/i;

export function classify(title, fallback = 'assignment') {
  const t = title || '';
  if (EXAM_RE.test(t) && !/reflection|survey|seat/i.test(t)) return 'exam';
  if (PREP_RE.test(t)) return 'prep';
  return fallback;
}

// ---------- ICS ----------

function unescapeIcs(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

export const DEFAULT_TZ = 'America/Los_Angeles';

export function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function parseIcsDate(prop, value, tz) {
  // prop like "DTSTART;VALUE=DATE" or "DTSTART;TZID=America/Chicago" or "DTSTART"
  const tzid = (prop.match(/TZID=([^;:]+)/) || [])[1];
  const zone = tzid && validTz(tzid) ? tzid : tz;
  if (/VALUE=DATE(?!-)/.test(prop) || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4), mo = value.slice(4, 6), d = value.slice(6, 8);
    // Canvas sends 11:59pm due dates as all-day events: treat as 11:59pm local that day
    return zonedToUtc(+y, +mo, +d, 23, 59, zone).toISOString();
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
  return zonedToUtc(+y, +mo, +d, +h, +mi, zone).toISOString();
}

// Convert a wall-clock time in `tz` to a UTC Date.
export function zonedToUtc(y, mo, d, h, mi, tz = DEFAULT_TZ) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asIfUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - asIfUtc;
  }
  return new Date(guess);
}

export function zonedParts(date, tz = DEFAULT_TZ) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, key: `${o.year}-${o.month}-${o.day}` };
}

export function parseIcs(text, tz = DEFAULT_TZ) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const prop = line.slice(0, i), value = line.slice(i + 1);
    const name = prop.split(';')[0].toUpperCase();
    if (name === 'DTSTART') cur.start = parseIcsDate(prop, value, tz);
    else if (name === 'DTEND') cur.end = parseIcsDate(prop, value, tz);
    else if (name === 'SUMMARY') cur.summary = unescapeIcs(value);
    else if (name === 'UID') cur.uid = value;
    else if (name === 'URL') cur.url = value;
  }
  return events;
}

export function icsEventToItem(ev) {
  if (!ev.uid || !ev.summary) return null;
  let title = ev.summary.trim(), courseFull = '';
  const m = title.match(/^(.*)\s\[([^\]]+)\]$/);
  if (m) { title = m[1].trim(); courseFull = m[2].trim(); }

  let id = null, kind = 'assignment';
  const a = ev.uid.match(/assignment-(\d+)$/) && !/override/.test(ev.uid) ? ev.uid.match(/assignment-(\d+)$/) : null;
  const urlA = (ev.url || '').match(/assignment_(\d+)/);
  if (a) id = 'a:' + a[1];
  else if (urlA) id = 'a:' + urlA[1];
  else if (/calendar-event-(\d+)/.test(ev.uid)) { id = 'e:' + ev.uid.match(/calendar-event-(\d+)/)[1]; kind = 'event'; }
  else id = 'i:' + ev.uid;

  if (kind !== 'event') kind = classify(title);
  return {
    id, title, courseFull, course: shortCourse(courseFull), due: ev.start, url: ev.url || null, kind,
  };
}

// ---------- bookmarklet sync ----------

export function plannerToItem(p, origin) {
  const pl = p.plannable || {};
  const type = p.plannable_type;
  let id, kind;
  if (type === 'announcement') return null; // news posts, not work
  if (type === 'calendar_event') { id = 'e:' + p.plannable_id; kind = 'event'; }
  else if (type === 'planner_note') { id = 'n:' + p.plannable_id; kind = 'custom'; }
  else {
    const aid = pl.assignment_id || (type === 'assignment' ? p.plannable_id : null);
    const prefix = { discussion_topic: 'd', wiki_page: 'p', quiz: 'q', assessment_request: 'r' }[type] || 'x';
    id = aid ? 'a:' + aid : prefix + ':' + p.plannable_id;
    kind = type === 'wiki_page' ? 'reading' : classify(pl.title || pl.name);
  }
  const s = p.submissions || {};
  const url = p.html_url ? (p.html_url.startsWith('http') ? p.html_url : origin + p.html_url) : null;
  return {
    id,
    title: pl.title || pl.name || 'Untitled',
    courseFull: p.context_name || '',
    course: shortCourse(p.context_name || ''),
    due: p.plannable_date || pl.due_at || pl.todo_date || null,
    url,
    kind,
    submitted: !!(s.submitted || s.graded || s.excused) || !!(p.planner_override && p.planner_override.marked_complete),
  };
}

export function modulesToReadings(modulesByCourse, courses) {
  const names = Object.fromEntries((courses || []).map(c => [c.id, c.name]));
  const out = [];
  for (const c of modulesByCourse || []) {
    const courseFull = names[c.courseId] || '';
    for (const m of c.mods || []) {
      if (m.state === 'completed' || m.state === 'locked') continue;
      for (const it of m.items || []) {
        if (!['Page', 'File', 'ExternalUrl', 'ExternalTool'].includes(it.type)) continue;
        if (!it.req || it.done) continue;
        if (!READING_RE.test(it.title || '')) continue;
        out.push({
          id: 'm:' + it.id,
          title: it.title,
          courseFull,
          course: shortCourse(courseFull),
          due: null,
          url: it.url || null,
          kind: 'reading',
          module: m.name,
        });
      }
    }
  }
  return out;
}

// Merge a fresh record into an existing one, keeping user state (done, hidden, notified).
export function mergeItem(existing, fresh, source) {
  const base = existing || { done: false, hidden: false, notified: {}, src: [] };
  const merged = { ...base, ...fresh };
  // A sync from Canvas knows the course name better than the feed; keep the richer one.
  if (existing && existing.courseFull && !fresh.courseFull) merged.courseFull = existing.courseFull;
  if (existing && existing.course && !fresh.course) merged.course = existing.course;
  if (existing && existing.kind === 'prep' && fresh.kind === 'assignment') merged.kind = 'prep';
  if (existing && existing.submitted && fresh.submitted === undefined) merged.submitted = true;
  // The feed rounds 11:59pm due dates to the minute while Canvas says 11:59:59,
  // so treat anything within 2 minutes as the same time. A real change re-arms reminders.
  if (existing && existing.due && fresh.due) {
    const diff = Math.abs(Date.parse(existing.due) - Date.parse(fresh.due));
    if (diff < 120e3) merged.due = source === 'sync' ? fresh.due : existing.due;
    else merged.notified = {};
  } else if (existing && existing.due !== fresh.due) merged.notified = {};
  if (existing && existing.kind === 'exam') merged.kind = 'exam';
  merged.done = base.done;
  merged.hidden = base.hidden;
  merged.src = Array.from(new Set([...(base.src || []), source]));
  merged.updated = new Date().toISOString();
  return merged;
}

export function isOpen(it) {
  return !it.done && !it.submitted && !it.hidden && it.kind !== 'event';
}
