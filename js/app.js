import * as store from './store.js';
import {
  dayOf, ensureTemporal, formatClock, formatDay, formatRange, formatTotal,
  startOfDay, timeOf, today, weekStart,
} from './time.js';
import { openEntryDialog } from './entry-dialog.js';
import { announce, confirmDialog, fillDatalist, h, nameDialog, polyfillClosedBy } from './ui.js';

const view = document.getElementById('view');

// ---- Routing -------------------------------------------------------------

const routes = { track: renderTrack, entries: renderEntries, projects: renderProjects };

function parseHash() {
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { name: routes[path] ? path : 'track', params: new URLSearchParams(query) };
}

let lastRoute;
function render() {
  const route = parseHash();
  for (const a of document.querySelectorAll('.app-nav a')) {
    if (a.dataset.route === route.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  view.replaceChildren(routes[route.name](route.params));
  // Move focus into the new view only on navigation, not on data refreshes.
  if (lastRoute !== undefined && lastRoute !== route.name) view.focus();
  lastRoute = route.name;
  renderHeaderTimer();
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
    el.textContent = el.classList.contains('clock') ? formatClock(ms) : formatTotal(ms);
  }
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

// ---- Track view ----------------------------------------------------------

function renderTrack() {
  const running = store.running();
  const now = Date.now();
  const todayStart = startOfDay(today());
  const todays = store.entries().filter((e) => (e.end ?? now) > todayStart);
  const todayMs = store.totalMs(todays.map((e) => ({ ...e, start: Math.max(e.start, todayStart) })), now);

  return h('div', { class: 'stack' },
    h('h1', { class: 'view-title' }, 'Track'),
    running ? runningCard(running) : startForm(),
    h('p', { class: 'today-total' },
      'Today: ',
      running
        ? h('strong', { 'data-clock': 'total', 'data-start': now, 'data-base': todayMs }, formatTotal(todayMs))
        : h('strong', null, formatTotal(todayMs)),
    ),
    recentList(running),
  );
}

function runningCard(r) {
  const l = store.labelsOf(r);
  return h('section', { class: 'card running', 'aria-labelledby': 'running-title', style: { '--swatch': l.color } },
    h('h2', { id: 'running-title', class: 'visually-hidden' }, 'Running timer'),
    h('p', { class: 'running-label' }, entryLabel(r)),
    r.description ? h('p', { class: 'running-desc' }, r.description) : null,
    h('p', { class: 'running-clock' }, clock(r.start, 0, 'clock big')),
    h('p', { class: 'running-since' }, `Started at ${timeOf(r.start)}`),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary stop', id: 'stop-btn', onclick: async () => {
        await store.stopTimer();
        announce('Timer stopped');
      } }, 'Stop'),
      h('button', { type: 'button', id: 'edit-running-btn', onclick: () => openEntryDialog(r) }, 'Edit'),
      h('button', { type: 'button', class: 'danger-text', onclick: async () => {
        const ok = await confirmDialog({
          title: 'Discard this timer?',
          message: 'The running entry will be deleted without saving.',
          confirmLabel: 'Discard',
        });
        if (ok) { await store.removeEntry(r.id); announce('Timer discarded'); }
      } }, 'Discard'),
    ),
  );
}

function startForm() {
  fillDatalist(document.getElementById('dl-projects'), store.projects().map((p) => p.name));
  const taskList = h('datalist', { id: 'dl-start-tasks' });

  const updateTasks = (e) => {
    const n = e.target.value.trim().toLocaleLowerCase();
    const p = store.projects().find((x) => x.name.toLocaleLowerCase() === n);
    fillDatalist(taskList, p ? store.tasks(p.id).map((t) => t.name) : []);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    e.submitter.disabled = true;
    const t = await store.resolveTask(data.get('project'), data.get('task'));
    await store.startTimer({ taskId: t.id, description: data.get('description') });
    announce('Timer started');
    document.getElementById('stop-btn')?.focus();
  };

  return h('form', { class: 'card start-form', 'aria-labelledby': 'start-title', onsubmit: onSubmit },
    h('h2', { id: 'start-title' }, 'Start a timer'),
    h('div', { class: 'field' },
      h('label', { for: 'sf-project' }, 'Project ', h('span', { class: 'req', 'aria-hidden': 'true' }, '*')),
      h('input', { id: 'sf-project', name: 'project', list: 'dl-projects', required: true, autocomplete: 'off',
        enterkeyhint: 'next', 'aria-describedby': 'sf-help', oninput: updateTasks }),
    ),
    h('div', { class: 'field' },
      h('label', { for: 'sf-task' }, 'Task ', h('span', { class: 'req', 'aria-hidden': 'true' }, '*')),
      h('input', { id: 'sf-task', name: 'task', list: 'dl-start-tasks', required: true, autocomplete: 'off', enterkeyhint: 'next' }),
      taskList,
    ),
    h('div', { class: 'field' },
      h('label', { for: 'sf-description' }, 'Description'),
      h('input', { id: 'sf-description', name: 'description', autocomplete: 'off', enterkeyhint: 'go' }),
    ),
    h('p', { id: 'sf-help', class: 'hint' }, 'Pick an existing project and task, or type a new name to create it.'),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'submit' }, 'Start'),
      h('button', { type: 'button', onclick: () => openEntryDialog() }, 'Add time manually'),
    ),
  );
}

function recentList(running) {
  const combos = store.recentCombos();
  if (!combos.length) {
    return h('p', { class: 'empty' }, 'Your recent tasks will appear here for one-click restart.');
  }
  return h('section', { 'aria-labelledby': 'recent-title' },
    h('h2', { id: 'recent-title' }, 'Recent'),
    h('ul', { class: 'list' },
      combos.map((c, i) => {
        const isCurrent = running && running.taskId === c.taskId && (running.description ?? '') === c.description;
        const name = store.task(c.taskId).name;
        return h('li', { class: 'row' },
          h('div', { class: 'row-main' },
            entryLabel({ taskId: c.taskId }),
            c.description ? h('span', { class: 'row-desc' }, c.description) : null,
          ),
          h('button', {
            type: 'button', class: 'icon-btn play', id: `recent-${i}`, disabled: isCurrent,
            'aria-label': `Start ${name}${c.description ? `: ${c.description}` : ''}`,
            onclick: async () => {
              await store.startTimer(c);
              announce(`Started ${name}`);
              document.getElementById('stop-btn')?.focus();
            },
          }, h('span', { 'aria-hidden': 'true' }, '▶')),
        );
      }),
    ),
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
          running ? h('span', { 'data-clock': 'total', 'data-start': running.start, 'data-base': finishedMs }) : formatTotal(finishedMs)),
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
        : h('span', { class: 'day-total' }, formatTotal(doneMs)),
    ),
    h('ul', { class: 'list' },
      dayEntries.map((e) => h('li', { class: 'row entry' },
        h('span', { class: 'entry-time' }, `${timeOf(e.start)}–${e.end ? timeOf(e.end) : 'now'}`),
        h('div', { class: 'row-main' },
          entryLabel(e),
          e.description ? h('span', { class: 'row-desc' }, e.description) : null,
        ),
        e.end
          ? h('span', { class: 'entry-dur' }, formatTotal(e.end - e.start))
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
      h('span', { class: 'project-total' }, formatTotal(totalMs)),
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
    h('span', { class: 'entry-dur' }, formatTotal(ms)),
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

  render();
  addEventListener('hashchange', render);
  store.events.addEventListener('change', refresh);
  setInterval(tick, 1000);
  // A new day can start while the app is open in the background.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js');
  }
}

main().catch((err) => {
  console.error(err);
  view.replaceChildren(h('p', { class: 'error' }, `Something went wrong while starting: ${err.message}`));
});
