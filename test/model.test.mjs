import fs from 'node:fs';
import assert from 'node:assert';
import { parseIcs, icsEventToItem, plannerToItem, mergeItem, shortCourse, zonedToUtc } from '../src/model.js';

const items = parseIcs(fs.readFileSync(new URL('./fixture.ics', import.meta.url), 'utf8')).map(icsEventToItem);
for (const i of items) console.log(i.id.padEnd(12), i.kind.padEnd(10), i.course.padEnd(13), i.due, '|', i.title);

const byId = Object.fromEntries(items.map(i => [i.id, i]));
assert.equal(byId['e:5130732'].kind, 'event');
assert.equal(byId['a:11829647'].kind, 'prep');
assert.equal(byId['a:11829647'].title, 'Lesson 2 [PREP] – MATLAB errors, round-off error, and MATLAB debugger');
assert.equal(byId['a:11829647'].course, 'AMATH 301');
assert.equal(byId['a:11481705'].due, '2026-10-06T06:59:00.000Z'); // Oct 5 11:59pm PDT
assert.equal(byId['a:11720390'].course, 'CHEM 142 Lab'); // override → real assignment id
assert.equal(byId['a:11544981'].kind, 'exam');
assert.equal(byId['a:11783863'].kind, 'assignment'); // pre-exam reflection is not an exam
assert.equal(byId['a:11720404'].kind, 'prep');
assert.equal(byId['a:11783843'].kind, 'prep');
assert.equal(byId['a:11720408'].due, '2026-12-01T16:00:00.000Z');
assert.equal(shortCourse('GEN ST 199 R2'), 'GEN ST 199');
// PST date (after DST ends)
assert.equal(zonedToUtc(2026, 12, 1, 23, 59, 'America/Los_Angeles').toISOString(), '2026-12-02T07:59:00.000Z');
assert.equal(zonedToUtc(2026, 10, 5, 23, 59, 'America/New_York').toISOString(), '2026-10-06T03:59:00.000Z');
assert.equal(zonedToUtc(2026, 3, 8, 2, 30, 'America/Chicago').toISOString().slice(0, 13), '2026-03-08T08');
// all-day due dates follow the configured zone
const ny = parseIcs(fs.readFileSync(new URL('./fixture.ics', import.meta.url), 'utf8'), 'America/New_York').map(icsEventToItem);
assert.equal(ny.find(i => i.id === 'a:11481705').due, '2026-10-06T03:59:00.000Z');

// planner sync merge: submitted + jitter tolerance keeps reminders armed state
const feed = mergeItem(undefined, byId['a:11481705'], 'ics');
feed.notified = { h3: true };
const p = plannerToItem({ plannable_type: 'quiz', plannable_id: 2397232, plannable: { title: 'Hw Ch. 3', assignment_id: 11481705 },
  plannable_date: '2026-10-06T06:59:59Z', context_name: 'PHIL 120 A Au 26: Introduction To Logic', html_url: '/courses/1921517/quizzes/2397232',
  submissions: { submitted: true } }, 'https://canvas.uw.edu');
assert.equal(p.id, 'a:11481705');
const merged = mergeItem(feed, p, 'sync');
assert.equal(merged.submitted, true);
assert.deepEqual(merged.notified, { h3: true });
assert.equal(merged.url, 'https://canvas.uw.edu/courses/1921517/quizzes/2397232');
// feed refresh afterwards must not undo submitted or re-arm
const again = mergeItem(merged, byId['a:11481705'], 'ics');
assert.equal(again.submitted, true);
assert.deepEqual(again.notified, { h3: true });
assert.equal(again.due, '2026-10-06T06:59:59Z');
console.log('model tests passed');
