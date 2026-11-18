import * as store from './store.js';
import {
  dayOf, ensureTemporal, formatClock, formatDay, formatHM, formatRange, formatShort,
  startOfDay, timeOf, today, weekStart,
} from './time.js';
import { openEntryDialog, openStartDialog } from './entry-dialog.js';
import { renderReports } from './reports.js';
import { dayRibbon, entriesOnDay, updateRibbons } from './ribbon.js';
import { formatSyncedAt, renderSettings } from './settings.js';
import * as sync from './sync.js';
import { announce, confirmDialog, h, nameDialog, polyfillClosedBy } from './ui.js';

const view = document.getElementById('view');

// ---- Routing -------------------------------------------------------------

const routes = { track: renderTrack, entries: renderEntries, projects: renderProjects, reports: renderReports, settings: renderSettings };

function parseHash() {
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { name: routes[path] ? path : 'track', params: new URLSearchParams(query) };
}

let lastRoute;
function render() {
  const route = parseHash();
  for (const a of document.querySelectorAll('a[data-route]')) {
    if (a.dataset.route === route.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  view.replaceChildren(routes[route.name](route.params));
  // Move focus into the new view only on navigation, not on data refreshes.
  if (lastRoute !== undefined && lastRoute !== route.name) {
    // Start the new view at the top (focus alone would scroll its heading under the sticky nav).
    scrollTo({ top: 0 });
    view.focus({ preventScroll: true });
  }
  lastRoute = route.name;
  renderHeaderTimer();
  renderSyncButton();
  tick();
}

// Re-render after data changes, keeping focus on an element with the same id if possible.
function refresh() {
  const focusId = document.activeElement?.id;
  render();
  if (focusId) document.getElementById(focusId)?.focus();
}

// ---- Shared bits ---------------------------------------------------------

const swatch = (color) => h('span', { class: 'swatch', style: { '--swatch': color }, 'aria-hidden': 'true' });

function entryLabel(e) {
  const l = store.labelsOf(e);
  return h('span', { class: 'entry-label' },
    swatch(l.color),
    h('span', { class: 'entry-project' }, l.project),
    h('span', { class: 'sep', 'aria-hidden': 'true' }, ' › '),
    h('span', { class: 'entry-task' }, l.task),
  );
}

/** Live-updating duration text. `data-start` plus optional `data-base` (already-counted ms). */
const clock = (start, base = 0, cls = 'clock') =>
  h('span', { class: cls, 'data-clock': 'total', 'data-start': start, 'data-base': base });

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-clock]')) {
    const ms = Number(el.dataset.base) + (now - Number(el.dataset.start));
    el.textContent = el.classList.contains('clock') ? formatClock(ms) : formatHM(ms);
  }
  updateRibbons(now);
  const r = store.running();
  document.title = r ? `${formatClock(now - r.start)} · ${store.labelsOf(r).task}` : 'Time Tracker';
}

function renderHeaderTimer() {
  const el = document.getElementById('header-timer');
  const r = store.running();
  el.hidden = !r || parseHash().name === 'track';
  if (r) {
    el.replaceChildren(
      h('span', { class: 'pulse', 'aria-hidden': 'true' }),
      h('span', { class: 'visually-hidden' }, 'Timer running: '),
      clock(r.start),
      ' ',
      h('span', { class: 'header-task' }, store.labelsOf(r).task),
    );
  }
}

function renderSyncButton() {
  const btn = document.getElementById('sync-btn');
  const s = sync.state();
  btn.hidden = s.status === 'off';
  if (btn.hidden) return;
  const dot = s.unsynced && s.status !== 'syncing' ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null;
  const label = {
    syncing: 'Syncing…',
    idle: s.unsynced ? 'Sync' : 'Synced',
    'needs-auth': 'Sync',
    error: 'Sync failed',
  }[s.status];
  const detail = s.status === 'error'
    ? ` with Google Drive: ${s.error}. Press to retry.`
    : ` with Google Drive. Last synced ${formatSyncedAt(s.lastSyncAt)}${s.unsynced ? '. Changes waiting.' : '.'}`;
  btn.disabled = s.status === 'syncing';
  btn.dataset.status = s.status;
  btn.replaceChildren(
    h('span', { class: 'sync-icon', 'aria-hidden': 'true' }, s.status === 'error' ? '⚠' : s.status === 'idle' && !s.unsynced ? '✓' : '⟳'),
    h('span', { class: 'sync-label' }, label),
    h('span', { class: 'visually-hidden' }, detail),
    ...(dot ? [dot] : []),
  );
}

async function deleteEntry(e) {
  const ok = await confirmDialog({
    title: 'Delete this entry?',
    message: `${store.labelsOf(e).task}, ${formatDay(dayOf(e.start))} ${timeOf(e.start)}. This can’t be undone.`,
  });
  if (ok) {
    await store.removeEntry(e.id);
    announce('Entry deleted');
  }
}

// ---- Track view (day timesheet) ------------------------------------------

const dayLink = (d) => (d.equals(today()) ? '#/track' : `#/track?day=${d}`);
const weekdayLetter = (d) => d.toLocaleString('en-GB', { weekday: 'narrow' });
const weekdayLong = (d) => d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

/** Entries that started on a calendar day (same rule as Entries and Reports). */
function startedOn(day, list) {
  const from = startOfDay(day);
  const to = startOfDay(day.add({ days: 1 }));
  return list.filter((e) => e.start >= from && e.start < to);
}

/** Total for a list; a running entry makes it a live element. */
function liveTotal(list, attrs = {}) {
  const run = list.find((e) => e.end == null);
  const done = store.totalMs(list.filter((e) => e.end != null));
  return run
    ? h('span', { ...attrs, 'data-clock': 'hm', 'data-start': run.start, 'data-base': done }, formatHM(done + Date.now() - run.start))
    : h('span', attrs, formatHM(done));
}

function renderTrack(params) {
  let day;
  try { day = Temporal.PlainDate.from(params.get('day') ?? ''); } catch { day = today(); }
  const isToday = day.equals(today());
  const all = store.entries();
  const running = store.running();
  const dayEntries = startedOn(day, all);
  const ws = weekStart(day);
  const week = Array.from({ length: 7 }, (_, i) => ws.add({ days: i }));

  // One row per task + description, in the order they were first worked on.
  const groups = [...Map.groupBy(dayEntries.toSorted((a, b) => a.start - b.start),
    (e) => `${e.taskId}\u0000${e.description ?? ''}`).values()];

  const trackTime = () => (isToday ? openStartDialog() : openEntryDialog(null, { date: day }));

  return h('div', { class: 'stack timesheet' },
    h('div', { class: 'ts-head' },
      h('h1', null, isToday ? `Today, ${formatShort(day)}` : `${day.toLocaleString('en-GB', { weekday: 'long' })}, ${formatShort(day)}`),
      h('button', { type: 'button', class: 'primary', id: 'track-time-btn', onclick: trackTime },
        h('span', { 'aria-hidden': 'true' }, '+'), ' Track time'),
    ),

    h('nav', { class: 'week-strip', 'aria-label': 'Days of the week' },
      h('a', { class: 'button icon-btn ghost', href: dayLink(day.subtract({ weeks: 1 })), 'aria-label': 'Previous week' },
        h('span', { 'aria-hidden': 'true' }, '‹')),
      h('ol', null, week.map((d) => {
        const list = startedOn(d, all);
        return h('li', null,
          h('a', {
            href: dayLink(d),
            class: d.equals(today()) ? 'is-today' : null,
            'aria-current': d.equals(day) ? 'date' : null,
          },
            h('span', { class: 'ws-letter', 'aria-hidden': 'true' }, weekdayLetter(d)),
            h('span', { class: 'visually-hidden' }, `${weekdayLong(d)}${d.equals(today()) ? ' (today)' : ''}: `),
            liveTotal(list, { class: 'ws-total' }),
          ));
      })),
      h('a', { class: 'button icon-btn ghost', href: dayLink(day.add({ weeks: 1 })), 'aria-label': 'Next week' },
        h('span', { 'aria-hidden': 'true' }, '›')),
    ),

    dayRibbon(day, entriesOnDay(day, all), { size: 'small' }),

    groups.length
      ? h('section', { 'aria-labelledby': 'ts-list-title' },
          h('h2', { id: 'ts-list-title', class: 'visually-hidden' }, 'Time entries'),
          h('ul', { class: 'ts-list' }, groups.map((g) => timesheetRow(g, day, isToday))),
          h('p', { class: 'ts-total' }, h('span', null, 'Total'), liveTotal(dayEntries, { class: 'ts-total-value' })),
        )
      : h('div', { class: 'ts-empty' },
          h('p', null, isToday ? 'Nothing tracked yet today.' : 'Nothing tracked on this day.'),
          h('button', { type: 'button', onclick: trackTime }, isToday ? 'Start a timer' : 'Add time'),
        ),

    !isToday ? h('p', null, h('a', { href: '#/track' }, 'Back to today')) : null,
    isToday ? startAgain(groups, running) : null,
  );
}

function timesheetRow(group, day, isToday) {
  const first = group[0];
  const l = store.labelsOf(first);
  const desc = first.description ?? '';
  const run = group.find((e) => e.end == null);
  const name = `${l.task}${desc ? `, ${desc}` : ''}`;

  const toggle = run
    ? h('button', { type: 'button', class: 'ts-toggle stop', 'aria-label': `Stop ${name}`, onclick: async () => {
        await store.stopTimer();
        announce('Timer stopped');
      } }, h('span', { class: 'stop-icon', 'aria-hidden': 'true' }))
    : h('button', { type: 'button', class: 'ts-toggle', 'aria-label': `Start ${name}${isToday ? '' : ' today'}`, onclick: async () => {
        await store.startTimer({ taskId: first.taskId, description: desc });
        announce(`Started ${l.task}`);
        if (!isToday) location.hash = '#/track';
      } }, h('span', { class: 'play-icon', 'aria-hidden': 'true' }));

  const open = () => (group.length === 1 ? openEntryDialog(first) : openIntervals(group, name));

  return h('li', { class: run ? 'ts-row running' : 'ts-row', style: { '--c': l.color } },
    h('button', { type: 'button', class: 'ts-open', onclick: open,
      'aria-label': `Edit ${name}${group.length > 1 ? ` (${group.length} time ranges)` : ''}` },
      h('span', { class: 'ts-project' }, h('span', { class: 'swatch', style: { '--swatch': l.color }, 'aria-hidden': 'true' }), l.project),
      h('span', { class: 'ts-task' }, l.task),
      desc ? h('span', { class: 'ts-desc' }, desc) : null,
    ),
    liveTotal(group, { class: 'ts-dur' }),
    toggle,
  );
}

/** A row that combines several time ranges: list them for editing. */
function openIntervals(group, name) {
  const dialog = h('dialog', { class: 'intervals', 'aria-labelledby': 'iv-title', closedby: 'any' },
    h('h2', { id: 'iv-title' }, name),
    h('ul', { class: 'list' }, group.map((e) => h('li', { class: 'row' },
      h('span', { class: 'row-main entry-time' }, `${timeOf(e.start)}–${e.end ? timeOf(e.end) : 'now'}`),
      h('span', { class: 'entry-dur' }, e.end ? formatHM(e.end - e.start) : 'running'),
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'small', onclick: () => { dialog.close(); openEntryDialog(e); },
          'aria-label': `Edit ${timeOf(e.start)}` }, 'Edit'),
        h('button', { type: 'button', class: 'small danger-text', onclick: () => { dialog.close(); deleteEntry(e); },
          'aria-label': `Delete ${timeOf(e.start)}` }, 'Delete'),
      ),
    ))),
    h('form', { method: 'dialog', class: 'actions' }, h('button', { autofocus: true }, 'Close')),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Recent task + description pairs not already on today's sheet. */
function startAgain(groups, running) {
  const onSheet = new Set(groups.map((g) => `${g[0].taskId}\u0000${g[0].description ?? ''}`));
  const combos = store.recentCombos(12).filter((c) => !onSheet.has(`${c.taskId}\u0000${c.description}`)).slice(0, 5);
  if (!combos.length) return null;
  return h('section', { class: 'recent', 'aria-labelledby': 'recent-title' },
    h('h2', { id: 'recent-title' }, 'Start again'),
    h('ul', { class: 'ts-list quiet' }, combos.map((c) => {
      const l = store.labelsOf({ taskId: c.taskId });
      const name = `${l.task}${c.description ? `, ${c.description}` : ''}`;
      return h('li', { class: 'ts-row', style: { '--c': l.color } },
        h('div', { class: 'ts-open static' },
          h('span', { class: 'ts-project' }, h('span', { class: 'swatch', style: { '--swatch': l.color }, 'aria-hidden': 'true' }), l.project),
          h('span', { class: 'ts-task' }, l.task),
          c.description ? h('span', { class: 'ts-desc' }, c.description) : null,
        ),
        h('button', { type: 'button', class: 'ts-toggle', 'aria-label': `Start ${name}`, disabled: running?.taskId === c.taskId && (running.description ?? '') === c.description,
          onclick: async () => { await store.startTimer(c); announce(`Started ${l.task}`); } },
          h('span', { class: 'play-icon', 'aria-hidden': 'true' })),
      );
    })),
  );
}

// ---- Entries view --------------------------------------------------------

function renderEntries(params) {
  let from;
  try { from = weekStart(Temporal.PlainDate.from(params.get('week') ?? '')); }
  catch { from = weekStart(today()); }
  const to = from.add({ days: 6 });
  const startMs = startOfDay(from);
  const endMs = startOfDay(to.add({ days: 1 }));
  const now = Date.now();
  const list = store.entries().filter((e) => e.start >= startMs && e.start < endMs);
  const byDay = Map.groupBy(list, (e) => dayOf(e.start).toString());
  const finishedMs = store.totalMs(list.filter((e) => e.end != null));
  const running = list.find((e) => e.end == null);
  const weekLink = (d) => `#/entries?week=${d}`;
  const isThisWeek = from.equals(weekStart(today()));

  return h('div', { class: 'stack' },
    h('div', { class: 'view-head' },
      h('h1', { class: 'view-title' }, 'Entries'),
      h('button', { type: 'button', class: 'primary', id: 'add-entry-btn', onclick: () => openEntryDialog() }, 'Add entry'),
    ),
    h('nav', { class: 'week-nav', 'aria-label': 'Week' },
      h('a', { class: 'button icon-btn', href: weekLink(from.subtract({ weeks: 1 })), 'aria-label': 'Previous week' },
        h('span', { 'aria-hidden': 'true' }, '‹')),
      h('p', { class: 'week-label' },
        h('strong', null, formatRange(from, to)),
        h('span', { class: 'week-total' }, ' · ',
          running ? h('span', { 'data-clock': 'total', 'data-start': running.start, 'data-base': finishedMs }) : formatHM(finishedMs)),
      ),
      h('a', { class: 'button icon-btn', href: weekLink(from.add({ weeks: 1 })), 'aria-label': 'Next week' },
        h('span', { 'aria-hidden': 'true' }, '›')),
      isThisWeek ? null : h('a', { class: 'button', href: '#/entries' }, 'This week'),
    ),
    list.length === 0
      ? h('p', { class: 'empty' }, 'No time tracked this week.')
      : [...byDay].map(([day, dayEntries]) => daySection(Temporal.PlainDate.from(day), dayEntries, now)),
  );
}

function daySection(day, dayEntries, now) {
  const id = `day-${day}`;
  const running = dayEntries.find((e) => e.end == null);
  const doneMs = store.totalMs(dayEntries.filter((e) => e.end != null));
  return h('section', { class: 'day', 'aria-labelledby': id },
    h('h2', { id, class: 'day-head' },
      h('span', null, formatDay(day)),
      running
        ? h('span', { class: 'day-total', 'data-clock': 'total', 'data-start': running.start, 'data-base': doneMs })
        : h('span', { class: 'day-total' }, formatHM(doneMs)),
    ),
    dayRibbon(day, dayEntries, { size: 'small' }),
    h('ul', { class: 'list' },
      dayEntries.map((e) => h('li', { class: 'row entry' },
        h('span', { class: 'entry-time' }, `${timeOf(e.start)}–${e.end ? timeOf(e.end) : 'now'}`),
        h('div', { class: 'row-main' },
          entryLabel(e),
          e.description ? h('span', { class: 'row-desc' }, e.description) : null,
        ),
        e.end
          ? h('span', { class: 'entry-dur' }, formatHM(e.end - e.start))
          : clock(e.start, 0, 'entry-dur clock'),
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'small', id: `edit-${e.id}`, onclick: () => openEntryDialog(e),
            'aria-label': `Edit ${store.labelsOf(e).task} at ${timeOf(e.start)}` }, 'Edit'),
          h('button', { type: 'button', class: 'small danger-text', onclick: () => deleteEntry(e),
            'aria-label': `Delete ${store.labelsOf(e).task} at ${timeOf(e.start)}` }, 'Delete'),
        ),
      )),
    ),
  );
}

// ---- Projects view -------------------------------------------------------

let showArchived = false;

function renderProjects() {
  const projects = store.projects({ archived: showArchived });
  const allEntries = store.entries();
  const msByTask = new Map();
  for (const e of allEntries) {
    if (e.end != null) msByTask.set(e.taskId, (msByTask.get(e.taskId) ?? 0) + (e.end - e.start));
  }

  const addProject = async (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    const name = input.value.trim();
    if (store.nameTaken(store.projects({ archived: true }), name)) {
      input.setCustomValidity('A project with this name already exists.');
      input.reportValidity();
      return;
    }
    await store.createProject(name);
    announce(`Project “${name}” added`);
    document.getElementById('np-name')?.focus();
  };

  return h('div', { class: 'stack' },
    h('h1', { class: 'view-title' }, 'Projects'),
    h('form', { class: 'inline-form', 'aria-label': 'New project', onsubmit: addProject },
      h('label', { for: 'np-name', class: 'visually-hidden' }, 'New project name'),
      h('input', { id: 'np-name', name: 'name', required: true, placeholder: 'New project name', autocomplete: 'off',
        maxlength: 120, oninput: (e) => e.target.setCustomValidity('') }),
      h('button', { type: 'submit', class: 'primary' }, 'Add project'),
    ),
    h('div', { class: 'toggle' },
      h('input', { type: 'checkbox', id: 'show-archived', checked: showArchived,
        onchange: (e) => { showArchived = e.target.checked; refresh(); } }),
      h('label', { for: 'show-archived' }, 'Show archived'),
    ),
    projects.length === 0
      ? h('p', { class: 'empty' }, 'No projects yet. Add one above, or just type a name when you start a timer.')
      : projects.map((p) => projectCard(p, msByTask)),
  );
}

function projectCard(p, msByTask) {
  const tasks = store.tasks(p.id, { archived: showArchived });
  const totalMs = store.tasks(p.id, { archived: true }).reduce((s, t) => s + (msByTask.get(t.id) ?? 0), 0);
  const headId = `p-${p.id}`;

  const rename = async () => {
    const res = await nameDialog({
      title: 'Edit project',
      name: p.name,
      color: p.color,
      validate: (n) => store.nameTaken(store.projects({ archived: true }), n, p.id) ? 'A project with this name already exists.' : '',
    });
    if (res) { await store.updateProject(p.id, res); announce('Project updated'); }
  };

  const addTask = async (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    const name = input.value.trim();
    if (store.nameTaken(store.tasks(p.id, { archived: true }), name)) {
      input.setCustomValidity('This project already has a task with this name.');
      input.reportValidity();
      return;
    }
    await store.createTask(p.id, name);
    announce(`Task “${name}” added`);
    document.getElementById(`nt-${p.id}`)?.focus();
  };

  return h('section', { class: `card project${p.archived ? ' archived' : ''}`, 'aria-labelledby': headId, style: { '--swatch': p.color } },
    h('div', { class: 'project-head' },
      h('h2', { id: headId }, swatch(p.color), p.name, p.archived ? h('span', { class: 'badge' }, 'Archived') : null),
      h('span', { class: 'project-total' }, formatHM(totalMs)),
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'small', onclick: rename, 'aria-label': `Edit project ${p.name}` }, 'Edit'),
        h('button', { type: 'button', class: 'small', 'aria-label': `${p.archived ? 'Restore' : 'Archive'} project ${p.name}`,
          onclick: async () => {
            await store.updateProject(p.id, { archived: !p.archived });
            announce(p.archived ? 'Project restored' : 'Project archived');
          } }, p.archived ? 'Restore' : 'Archive'),
      ),
    ),
    tasks.length
      ? h('ul', { class: 'list tasks' }, tasks.map((t) => taskRow(p, t, msByTask.get(t.id) ?? 0)))
      : h('p', { class: 'empty small' }, 'No tasks yet.'),
    p.archived ? null : h('form', { class: 'inline-form', 'aria-label': `New task in ${p.name}`, onsubmit: addTask },
      h('label', { for: `nt-${p.id}`, class: 'visually-hidden' }, `New task in ${p.name}`),
      h('input', { id: `nt-${p.id}`, name: 'name', required: true, placeholder: 'New task', autocomplete: 'off',
        maxlength: 120, oninput: (e) => e.target.setCustomValidity('') }),
      h('button', { type: 'submit' }, 'Add task'),
    ),
  );
}

function taskRow(p, t, ms) {
  const rename = async () => {
    const res = await nameDialog({
      title: 'Rename task',
      name: t.name,
      validate: (n) => store.nameTaken(store.tasks(p.id, { archived: true }), n, t.id) ? 'This project already has a task with this name.' : '',
    });
    if (res) { await store.updateTask(t.id, { name: res.name }); announce('Task renamed'); }
  };
  return h('li', { class: `row${t.archived ? ' archived' : ''}` },
    h('div', { class: 'row-main' },
      h('span', null, t.name),
      t.archived ? h('span', { class: 'badge' }, 'Archived') : null,
    ),
    h('span', { class: 'entry-dur' }, formatHM(ms)),
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'small', onclick: rename, 'aria-label': `Rename task ${t.name}` }, 'Rename'),
      h('button', { type: 'button', class: 'small', 'aria-label': `${t.archived ? 'Restore' : 'Archive'} task ${t.name}`,
        onclick: async () => {
          await store.updateTask(t.id, { archived: !t.archived });
          announce(t.archived ? 'Task restored' : 'Task archived');
        } }, t.archived ? 'Restore' : 'Archive'),
    ),
  );
}

// ---- Boot ----------------------------------------------------------------

async function main() {
  await ensureTemporal();
  await store.load();
  polyfillClosedBy();
  navigator.storage?.persist?.(); // ask the browser not to evict our data

  await sync.initSync();
  render();
  addEventListener('hashchange', render);
  sync.events.addEventListener('change', () => {
    renderSyncButton();
    if (parseHash().name === 'settings') refresh();
  });
  document.getElementById('sync-btn').addEventListener('click', () => sync.syncNow({ interactive: true }));
  store.events.addEventListener('change', refresh);
  setInterval(tick, 1000);
  // A new day can start while the app is open in the background.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js');
    watchForUpdates();
  }
}

/**
 * When a newly deployed version takes over, reload so the page runs the new code.
 * Skipped on the very first install, and postponed while a dialog is open so
 * nothing being typed is lost. All data is already saved in IndexedDB.
 */
function watchForUpdates() {
  if (!navigator.serviceWorker.controller) return; // first visit: nothing old to replace
  let reloading = false;
  const reloadWhenIdle = () => {
    if (reloading) return;
    if (document.querySelector('dialog[open]')) {
      document.addEventListener('close', reloadWhenIdle, { capture: true, once: true });
      return;
    }
    reloading = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reloadWhenIdle);
  // Check for a new version when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) navigator.serviceWorker.getRegistration().then((r) => r?.update());
  });
}

main().catch((err) => {
  console.error(err);
  view.replaceChildren(h('p', { class: 'error' }, `Something went wrong while starting: ${err.message}`));
});
