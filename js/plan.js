// Planned tasks: a light to-do list that lives inside the tracker.
//
// The Plan tab groups what you plan by day (Overdue, Today, Tomorrow, later
// days, Someday), with a week strip whose dots show how much is planned on each
// day. One line adds a plan: "DOCO-700 code review fri 10:00 ~45m" becomes
// task DOCO-700 (an existing task is recognised by name), description
// "code review", Friday at 10:00, about 45 minutes. ▶ starts the timer on it.
//
// Each plan shows planned vs tracked time. A plan with a time gets a reminder
// 5 minutes before, inside the app (and as a system notification if you allow
// them). Without a server, reminders only work while the app is open.

import * as store from './store.js';
import { dayOf, formatHM, formatShort, timeOf, toMs, today, weekStart } from './time.js';
import { announce, confirmDialog, h, runDialog } from './ui.js';
import { projectByName, projectTaskPickers } from './entry-dialog.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LEAD = 5 * 60_000;     // remind 5 minutes before
const SNOOZE = 10 * 60_000;  // "Later"
const LATE = 30 * 60_000;    // still remind up to 30 minutes after, if the app was closed

const norm = (s) => s.trim().toLocaleLowerCase();
const longDay = (d) => d.toLocaleString('en-GB', { weekday: 'long' });
const shortDay = (d) => d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const estimateText = (min) => (min >= 60 ? `~${formatHM(min * 60_000)}` : `~${min}m`);
const dayKey = (ms) => dayOf(ms).toString();

// ---- Quick add: "DOCO-700 code review fri 10:00 ~45m" ------------------------

/** Pull the day, time and estimate out of a line; returns them and what's left. */
export function parseQuick(text, base = today()) {
  let rest = ` ${text} `;
  let day = base.toString(), time = null, estimate = null, dayToken = false;
  const take = (re, fn) => {
    const m = rest.match(re);
    if (!m) return false;
    if (fn(m) === false) return false;
    rest = rest.replace(m[0], ' ');
    return true;
  };

  // Estimate: ~45m, ~1h, ~1h30, ~1:30, ~1.5h, 45m, 2h
  take(/\s~?(\d+(?:[.,]\d+)?)\s?(h|hr|hrs|hours?)(?:\s?(\d{1,2})\s?m?)?(?=\s)/i, (m) => {
    estimate = Math.round(parseFloat(m[1].replace(',', '.')) * 60 + (m[3] ? Number(m[3]) : 0));
  }) || take(/\s~?(\d{1,3})\s?(m|min|mins|minutes?)(?=\s)/i, (m) => { estimate = Number(m[1]); })
    || take(/\s~(\d{1,2}):(\d{2})(?=\s)/, (m) => { estimate = Number(m[1]) * 60 + Number(m[2]); });

  // Time: 10:00, 9:30, 3pm, 11am
  take(/\s(?:at\s)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/i, (m) => { time = `${m[1].padStart(2, '0')}:${m[2]}`; })
    || take(/\s(?:at\s)?(1[0-2]|0?[1-9])\s?(am|pm)(?=\s)/i, (m) => {
      const hr = (Number(m[1]) % 12) + (m[2].toLowerCase() === 'pm' ? 12 : 0);
      time = `${String(hr).padStart(2, '0')}:00`;
    });

  // Day: today, tomorrow, mon…sun, next week, someday, 27.11, 27/11, 27 nov, nov 27
  const ahead = (d) => (Temporal.PlainDate.compare(d, base) < 0 ? d.add({ years: 1 }) : d);
  const dated = (dd, mm) => {
    try { return ahead(Temporal.PlainDate.from({ year: base.year, month: mm, day: dd }, { overflow: 'reject' })); }
    catch { return null; }
  };
  dayToken =
    take(/\s(today|tod)(?=\s)/i, () => { day = base.toString(); })
    || take(/\s(tomorrow|tmr|tom)(?=\s)/i, () => { day = base.add({ days: 1 }).toString(); })
    || take(/\s(someday|later|backlog)(?=\s)/i, () => { day = null; })
    || take(/\snext week(?=\s)/i, () => { day = weekStart(base).add({ weeks: 1 }).toString(); })
    || take(/\s(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?=\s)/i, (m) => {
      const want = WEEKDAYS.indexOf(m[1].toLowerCase()) + 1;
      day = base.add({ days: (want - base.dayOfWeek + 7) % 7 }).toString();
    })
    || take(/\s(\d{4}-\d{2}-\d{2})(?=\s)/, (m) => {
      try { day = Temporal.PlainDate.from(m[1]).toString(); } catch { return false; }
    })
    || take(/\s(\d{1,2})[./](\d{1,2})(?=\s)/, (m) => {
      const d = dated(Number(m[1]), Number(m[2]));
      if (!d) return false;
      day = d.toString();
    })
    || take(/\s(\d{1,2})\s([a-z]{3})[a-z]*(?=\s)/i, (m) => {
      const mm = MONTHS.indexOf(m[2].toLowerCase()) + 1;
      const d = mm && dated(Number(m[1]), mm);
      if (!d) return false;
      day = d.toString();
    })
    || take(/\s([a-z]{3})[a-z]*\s(\d{1,2})(?=\s)/i, (m) => {
      const mm = MONTHS.indexOf(m[1].toLowerCase()) + 1;
      const d = mm && dated(Number(m[2]), mm);
      if (!d) return false;
      day = d.toString();
    });

  return { day, time, estimate, dayToken, rest: rest.replace(/\s+/g, ' ').trim() };
}

/**
 * Find project, task and description in the rest of the line: the longest
 * existing task name it contains, else a project name it starts with, else the
 * whole text is a new task in the project you used last.
 */
export function resolveNames(rest) {
  const text = norm(rest);
  const clean = (s) => s.replace(/^[\s,.:;–—-]+|[\s,.:;–—-]+$/g, '');
  if (!text) return null;
  const allTasks = store.projects().flatMap((p) => store.tasks(p.id).map((t) => ({ t, p })));
  const found = allTasks
    .filter(({ t }) => text.includes(norm(t.name)))
    .toSorted((a, b) => b.t.name.length - a.t.name.length
      || Number(text.includes(norm(b.p.name))) - Number(text.includes(norm(a.p.name))));
  if (found.length) {
    const { t, p } = found[0];
    let desc = rest.slice(0, text.indexOf(norm(t.name))) + rest.slice(text.indexOf(norm(t.name)) + t.name.length);
    if (norm(desc).startsWith(norm(p.name))) desc = desc.trim().slice(p.name.length);
    return { project: p.name, task: t.name, description: clean(desc) };
  }
  // A ticket key first ("DOCO-700 code review"): the key is the task, the rest its description.
  const ticket = (words, project) => {
    const m = words.match(/^([A-Za-z][A-Za-z0-9]*-\d+)\b(.*)$/);
    return m ? { project, task: m[1], description: clean(m[2]) } : { project, task: clean(words), description: '' };
  };
  const p = store.projects().toSorted((a, b) => b.name.length - a.name.length).find((x) => text.startsWith(norm(x.name)));
  if (p && clean(rest.slice(p.name.length))) return ticket(clean(rest.slice(p.name.length)), p.name);
  const last = store.entries()[0];
  return ticket(clean(rest), last ? store.labelsOf(last).project : (store.projects()[0]?.name ?? 'General'));
}

// ---- Plan vs tracked ---------------------------------------------------------

const trackedMs = (p, now = Date.now()) =>
  store.planEntries(p, dayKey).reduce((sum, e) => sum + ((e.end ?? now) - e.start), 0);
const runningFor = (p) => {
  const r = store.running();
  return r && store.planEntries(p, dayKey).some((e) => e.id === r.id) ? r : null;
};

function progress(p) {
  const ms = trackedMs(p);
  const est = p.estimate ? p.estimate * 60_000 : 0;
  if (!est && !ms) return null;
  const label = est ? `${formatHM(ms)} / ${estimateText(p.estimate)}` : `${formatHM(ms)} tracked`;
  const over = est && ms > est ? ms - est : 0;
  const scale = Math.max(ms, est) || 1;
  return h('div', { class: 'plan-progress' },
    est
      ? h('div', { class: 'plan-bar', 'aria-hidden': 'true' },
        h('span', { class: 'in', style: { 'inline-size': `${(Math.min(ms, est) / scale) * 100}%` } }),
        over ? h('span', { class: 'over', style: { 'inline-size': `${(over / scale) * 100}%` } }) : null)
      : null,
    h('span', { class: 'plan-nums' }, label, over ? h('span', { class: 'plan-over' }, ` · ${formatHM(over)} over`) : null),
  );
}

// ---- The Plan view -------------------------------------------------------------

function openPlans() { return store.plans().filter((p) => !p.done); }

export function overdueCount(t = today().toString()) {
  return openPlans().filter((p) => p.day && p.day < t).length;
}

function sectionsFor(list, t) {
  const tomorrow = Temporal.PlainDate.from(t).add({ days: 1 }).toString();
  const groups = new Map();
  const put = (key, title, p) => { if (!groups.has(key)) groups.set(key, { title, items: [] }); groups.get(key).items.push(p); };
  for (const p of list) {
    if (!p.day) put('~someday', 'Someday', p);
    else if (p.day < t) put('0overdue', 'Overdue', p);
    else if (p.day === t) put(`1${p.day}`, 'Today', p);
    else if (p.day === tomorrow) put(`2${p.day}`, 'Tomorrow', p);
    else put(`3${p.day}`, shortDay(Temporal.PlainDate.from(p.day)), p);
  }
  return [...groups.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, g]) => ({ key, ...g }));
}

function planRow(p, t) {
  const l = store.labelsOf(p);
  const run = runningFor(p);
  const name = `${l.task}${p.description ? `, ${p.description}` : ''}`;
  const when = [
    p.day && p.day < t ? `was ${shortDay(Temporal.PlainDate.from(p.day))}` : null,
    p.time,
    p.estimate ? estimateText(p.estimate) : null,
  ].filter(Boolean).join(' · ');
  const late = p.day && p.day < t;
  return h('li', { class: run ? 'plan-row running' : 'plan-row', style: { '--c': l.color } },
    h('input', { type: 'checkbox', class: 'plan-check', 'aria-label': `Done: ${name}`, checked: Boolean(p.done),
      onchange: async (e) => {
        await store.setPlanDone(p.id, e.target.checked);
        announce(e.target.checked ? `Done: ${l.task}` : `Not done: ${l.task}`);
      } }),
    h('button', { type: 'button', class: 'plan-main', 'aria-label': `Edit ${name}`, onclick: () => openPlanDialog(p) },
      h('span', { class: 'plan-project' }, l.project),
      h('span', { class: 'plan-task' }, l.task),
      p.description ? h('span', { class: 'plan-desc' }, p.description) : null,
      when ? h('span', { class: late ? 'plan-when late' : 'plan-when' }, when) : null,
    ),
    h('div', { class: 'plan-side' },
      late || !p.day
        ? h('button', { type: 'button', class: 'small', onclick: async () => {
            await store.movePlan(p.id, t);
            announce(`${l.task} moved to today`);
          } }, 'Today')
        : null,
      run
        ? h('button', { type: 'button', class: 'ts-toggle stop', 'aria-label': `Stop ${name}`, onclick: () => store.stopTimer() },
          h('span', { class: 'stop-icon', 'aria-hidden': 'true' }))
        : h('button', { type: 'button', class: 'ts-toggle', 'aria-label': `Start ${name}`, onclick: () => startPlan(p) },
          h('span', { class: 'play-icon', 'aria-hidden': 'true' })),
    ),
    progress(p),
  );
}

export async function startPlan(p) {
  await store.startTimer({ taskId: p.taskId, description: p.description ?? '', planId: p.id });
  announce(`Started ${store.labelsOf(p).task}`);
}

function weekStrip(selected, t, list) {
  const base = selected ? Temporal.PlainDate.from(selected) : Temporal.PlainDate.from(t);
  const week = Array.from({ length: 7 }, (_, i) => weekStart(base).add({ days: i }));
  const link = (d) => `#/plan?day=${d}`;
  return h('nav', { class: 'week-strip plan-week', 'aria-label': 'Planned per day' },
    h('a', { class: 'button icon-btn ghost', href: link(week[0].subtract({ days: 7 })), 'aria-label': 'Previous week' },
      h('span', { 'aria-hidden': 'true' }, '‹')),
    h('ol', null, week.map((d) => {
      const n = list.filter((p) => p.day === d.toString()).length;
      return h('li', null, h('a', {
        href: d.toString() === selected ? '#/plan' : link(d),
        class: d.toString() === t ? 'is-today' : null,
        'aria-current': d.toString() === selected ? 'date' : null,
      },
        h('span', { class: 'ws-letter', 'aria-hidden': 'true' }, longDay(d)[0]),
        h('span', { class: 'ws-num', 'aria-hidden': 'true' }, String(d.day)),
        h('span', { class: 'visually-hidden' }, `${longDay(d)} ${formatShort(d)}${d.toString() === t ? ' (today)' : ''}: ${n} planned`),
        h('span', { class: 'plan-dots', 'aria-hidden': 'true' },
          Array.from({ length: Math.min(n, 3) }, () => h('i')), n > 3 ? h('b', null, '+') : null),
      ));
    })),
    h('a', { class: 'button icon-btn ghost', href: link(week[6].add({ days: 1 })), 'aria-label': 'Next week' },
      h('span', { 'aria-hidden': 'true' }, '›')),
  );
}

function quickAdd(selected) {
  const input = h('input', { id: 'plan-quick', name: 'quick', autocomplete: 'off', enterkeyhint: 'done',
    placeholder: 'DOCO-700 code review fri 10:00 ~45m', 'aria-describedby': 'plan-quick-preview' });
  const preview = h('div', { class: 'plan-chips', id: 'plan-quick-preview', 'aria-live': 'polite' });
  const base = () => (selected ? Temporal.PlainDate.from(selected) : today());
  const read = () => {
    const q = parseQuick(input.value, base());
    const names = resolveNames(q.rest);
    return names && { ...q, ...names };
  };
  const show = () => {
    const r = read();
    preview.replaceChildren(...(r ? [
      h('span', { class: 'chip', style: { '--c': projectByName(r.project)?.color ?? 'var(--control)' } },
        h('i', { 'aria-hidden': 'true' }), `${r.project} · ${r.task}`),
      r.description ? h('span', { class: 'chip' }, r.description) : null,
      h('span', { class: 'chip' }, r.day ? shortDay(Temporal.PlainDate.from(r.day)) : 'Someday'),
      r.time ? h('span', { class: 'chip' }, r.time) : null,
      r.estimate ? h('span', { class: 'chip' }, estimateText(r.estimate)) : null,
    ].filter(Boolean) : []));
  };
  input.addEventListener('input', show);
  const form = h('form', { class: 'plan-quick', onsubmit: async (e) => {
    e.preventDefault();
    const r = read();
    if (!r) { input.focus(); return; }
    const t = await store.resolveTask(r.project, r.task);
    await store.savePlan({ taskId: t.id, description: r.description, day: r.day, time: r.time, estimate: r.estimate });
    announce(`Planned ${r.task}${r.day ? ` for ${shortDay(Temporal.PlainDate.from(r.day))}` : ' for someday'}`);
    input.value = '';
    show();
    document.getElementById('plan-quick')?.focus();
  } },
    h('label', { for: 'plan-quick' }, 'Add to plan'),
    h('div', { class: 'plan-quick-row' },
      input,
      h('button', { type: 'submit', class: 'primary' }, 'Add'),
    ),
    preview,
    h('p', { class: 'hint' }, 'Write the task, then a day (today, tomorrow, fri, 27.11, someday), a time (10:00) and an estimate (~45m). ',
      h('button', { type: 'button', class: 'linklike', onclick: () => openPlanDialog(null, { day: selected ?? today().toString() }) }, 'Fill in a form instead')),
  );
  return form;
}

export function renderPlan(params) {
  const t = today().toString();
  const selected = params.get('day');
  const all = store.plans();
  const open = all.filter((p) => !p.done);
  const shown = selected ? open.filter((p) => p.day === selected || (selected === t && p.day && p.day < t)) : open;
  const doneRecent = all.filter((p) => p.done && p.done > Date.now() - 7 * 86_400_000).toSorted((a, b) => b.done - a.done);
  const sections = sectionsFor(shown, t);

  const overdue = open.filter((p) => p.day && p.day < t);
  return h('div', { class: 'stack plan' },
    h('div', { class: 'ts-head' },
      h('h1', null, selected ? `Plan, ${shortDay(Temporal.PlainDate.from(selected))}` : 'Plan'),
      selected ? h('a', { href: '#/plan', class: 'button' }, 'Show all') : null,
    ),
    weekStrip(selected, t, open),
    quickAdd(selected),
    notificationOffer(),
    sections.length
      ? sections.map((s) => h('section', { class: 'plan-section', 'aria-labelledby': `ps-${s.key}` },
        h('div', { class: 'plan-section-head' },
          h('h2', { id: `ps-${s.key}`, class: s.key === '0overdue' ? 'late' : null }, s.title,
            h('span', { class: 'plan-count' }, ` ${s.items.length}`)),
          s.key === '0overdue' && overdue.length > 1
            ? h('button', { type: 'button', class: 'small', onclick: async () => {
                for (const p of overdue) await store.movePlan(p.id, t);
                announce(`Moved ${overdue.length} tasks to today`);
              } }, 'Move all to today')
            : null),
        h('ul', { class: 'plan-list' }, s.items.map((p) => planRow(p, t)))))
      : h('p', { class: 'empty' }, selected ? 'Nothing planned for this day.' : 'Nothing planned yet. Add the first task above.'),
    doneRecent.length
      ? h('details', { class: 'plan-done' },
        h('summary', null, `Done this week (${doneRecent.length})`),
        h('ul', { class: 'plan-list' }, doneRecent.map((p) => planRow(p, t))))
      : null,
  );
}

// ---- Add / edit dialog -----------------------------------------------------------

const dlg = () => document.getElementById('plan-dialog');
const $ = (sel) => dlg().querySelector(sel);
let pickersReady = false;

export async function openPlanDialog(existing = null, preset = {}) {
  const form = $('#plan-form');
  if (!pickersReady) { projectTaskPickers($('#pf-project'), $('#pf-task')); pickersReady = true; }
  form.reset();
  $('#plan-title').textContent = existing ? 'Edit planned task' : 'Plan a task';
  $('#pf-delete').hidden = !existing;
  const src = existing ?? preset;
  if (existing) {
    const l = store.labelsOf(existing);
    $('#pf-project').value = l.project;
    $('#pf-task').value = l.task;
  } else {
    const last = store.entries()[0];
    $('#pf-project').value = preset.project ?? (last ? store.labelsOf(last).project : '');
    $('#pf-task').value = preset.task ?? '';
  }
  $('#pf-description').value = src.description ?? '';
  $('#pf-day').value = src.day ?? '';
  $('#pf-time').value = src.time ?? '';
  const est = $('#pf-estimate');
  if (src.estimate && ![...est.options].some((o) => o.value === String(src.estimate))) {
    est.append(h('option', { value: String(src.estimate) }, estimateText(src.estimate)));
  }
  est.value = src.estimate ? String(src.estimate) : '';

  const result = await runDialog(dlg());
  if (result === 'delete' && existing) {
    if (await confirmDialog({ title: 'Delete this planned task?', message: `${store.labelsOf(existing).task} will be removed from your plan. Time you tracked on it stays.` })) {
      await store.removePlan(existing.id);
      announce('Planned task deleted');
    }
    return;
  }
  if (result !== 'save') return;
  const task = await store.resolveTask($('#pf-project').value, $('#pf-task').value);
  await store.savePlan({
    ...(existing ?? {}), id: existing?.id, taskId: task.id, description: $('#pf-description').value,
    day: $('#pf-day').value || null, time: $('#pf-time').value || null,
    estimate: est.value ? Number(est.value) : null,
  });
  announce(existing ? 'Planned task saved' : 'Task planned');
}

// ---- Reminders ---------------------------------------------------------------------

const KEY = 'tt-reminders'; // per device: { planId: epoch ms when to show again, or 0 = handled }
const readMarks = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const writeMarks = (m) => { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* private mode */ } };
let showing = null;          // plan id on screen
const switches = new Map();  // plan id → timeout for "Start at 14:00"

function notificationOffer() {
  if (!('Notification' in globalThis) || Notification.permission !== 'default' || !('serviceWorker' in navigator)) return null;
  if (!openPlans().some((p) => p.time)) return null;
  return h('p', { class: 'hint plan-notify' }, 'Reminders show here in the app. ',
    h('button', { type: 'button', class: 'linklike', onclick: async (e) => {
      const r = await Notification.requestPermission();
      e.target.closest('p').replaceChildren(r === 'granted'
        ? 'Notifications are on. They come while the app is open, also in the background.'
        : 'Notifications are off. You can turn them on in the browser’s site settings.');
    } }, 'Also notify me when the app is in the background'));
}

const dueAt = (p) => toMs(p.day, p.time);

/** Called every second: show the next reminder that is due. */
export function checkReminders(now = Date.now()) {
  const t = today().toString();
  const marks = readMarks();
  // forget marks for plans that are gone or from other days
  for (const id of Object.keys(marks)) { const p = store.plan(id); if (!p || p.deleted || p.day !== t) delete marks[id]; }
  writeMarks(marks);

  if (showing) {
    const p = store.plan(showing);
    if (!p || p.deleted || p.done || runningFor(p)) hide();
    return;
  }
  const due = openPlans().find((p) => {
    if (p.day !== t || !p.time || runningFor(p)) return false;
    const at = dueAt(p);
    if (now < at - LEAD || now > at + LATE) return false;
    const mark = marks[p.id];
    return mark === undefined || (mark > 0 && now >= mark);
  });
  if (due) show(due, now);
}

function show(p, now) {
  showing = p.id;
  const l = store.labelsOf(p);
  const at = dueAt(p);
  const mins = Math.round((at - now) / 60_000);
  const what = p.description || l.task;
  const title = mins > 0 ? `${what} starts in ${mins} min` : mins === 0 ? `${what} starts now` : `${what} was planned for ${p.time}`;
  const r = store.running();
  const detail = [p.description ? `${l.project} · ${l.task}` : l.project, `planned ${p.time}`, p.estimate ? estimateText(p.estimate) : null].filter(Boolean).join(' · ')
    + (r ? `. You’re tracking ${store.labelsOf(r).task}.` : '.');
  const mark = (v) => { const m = readMarks(); m[p.id] = v; writeMarks(m); };
  const box = document.getElementById('reminder');
  box.style.setProperty('--c', l.color);
  box.replaceChildren(
    h('div', { class: 'reminder-text' },
      h('strong', null, title),
      h('span', null, detail)),
    h('div', { class: 'reminder-actions' },
      r && at > now
        ? h('button', { type: 'button', class: 'primary', onclick: () => {
            mark(0); hide();
            clearTimeout(switches.get(p.id));
            switches.set(p.id, setTimeout(() => {
              switches.delete(p.id);
              const cur = store.plan(p.id);
              if (cur && !cur.deleted && !cur.done) startPlan(cur);
            }, at - Date.now()));
            announce(`Will switch to ${l.task} at ${p.time}, if the app is open`);
          } }, `Switch at ${p.time}`)
        : null,
      h('button', { type: 'button', class: r && at > now ? null : 'primary', onclick: () => { mark(0); hide(); startPlan(p); } }, 'Start now'),
      h('button', { type: 'button', onclick: () => { mark(Date.now() + SNOOZE); hide(); announce('Reminder in 10 minutes'); } }, 'Later'),
      h('button', { type: 'button', class: 'icon-btn ghost', 'aria-label': 'Dismiss reminder', onclick: () => { mark(0); hide(); } },
        h('span', { 'aria-hidden': 'true' }, '×')),
    ),
  );
  box.hidden = false;
  if (document.hidden && globalThis.Notification?.permission === 'granted') {
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, { body: detail, tag: `plan-${p.id}`, data: { url: './#/plan' } }))
      .catch(() => {});
  }
}

function hide() {
  showing = null;
  const box = document.getElementById('reminder');
  box.hidden = true;
  box.replaceChildren();
}
