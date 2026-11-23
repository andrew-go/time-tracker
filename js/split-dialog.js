// Split an entry: cut one long entry into consecutive parts, each with its own
// project, task and description. The parts always cover exactly the original
// time range: you move the cut points, and each part runs to the next cut.
//
// A bar at the top shows the parts to scale in their project colours, so you
// can see the split before saving. All writes go through store.splitEntry.

import * as store from './store.js';
import { dayOf, formatHM, timeOf, toMs } from './time.js';
import { announce, h, runDialog } from './ui.js';
import { projectByName, projectTaskPickers } from './entry-dialog.js';

const $ = (sel) => document.getElementById('split-dialog').querySelector(sel);
const FIVE = 300_000;

/** "HH:MM" → ms inside the entry: a time before the start means after midnight. */
function atTime(entry, str) {
  const day = dayOf(entry.start);
  let ms = toMs(day.toString(), str);
  if (ms < entry.start) ms = toMs(day.add({ days: 1 }).toString(), str);
  return ms;
}

const midpoint = (a, b) => {
  const m = Math.round((a + (b - a) / 2) / FIVE) * FIVE;
  return m > a && m < b ? m : Math.round(a + (b - a) / 2);
};

/** Open the split dialog for `entry`. Resolves true when the entry was split. */
export async function openSplitDialog(entry) {
  const running = entry.end == null;
  const endOf = () => (running ? Date.now() : entry.end);
  const labels = store.labelsOf(entry);
  const form = $('#split-form');
  const list = $('#split-parts');
  const bar = $('#split-bar');

  if (endOf() - entry.start < 2 * 60_000) {
    announce('This entry is too short to split.');
    return false;
  }

  // Model: cut points between parts, and what each part is.
  let cuts = [midpoint(entry.start, endOf())];
  let parts = [0, 1].map(() => ({ project: labels.project, task: labels.task, description: entry.description ?? '' }));

  const bounds = () => [entry.start, ...cuts, endOf()];
  const colorOf = (name) => projectByName(name)?.color ?? 'var(--control)';

  /** Copy what's typed in the form back into the model (before rebuilding it). */
  function readForm() {
    list.querySelectorAll(':scope > li').forEach((li, i) => {
      parts[i] = {
        project: li.querySelector('[name="project"]').value,
        task: li.querySelector('[name="task"]').value,
        description: li.querySelector('[name="description"]').value,
      };
      const cut = li.querySelector('[name="cut"]');
      if (cut?.value) cuts[i] = atTime(entry, cut.value);
    });
  }

  function build() {
    const b = bounds();
    list.replaceChildren(...parts.map((p, i) => {
      const last = i === parts.length - 1;
      const id = (f) => `sp-${i}-${f}`;
      const field = (name, label, value, required) => h('div', { class: 'field' },
        h('label', { for: id(name) }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
        h('input', { id: id(name), name, value, required, autocomplete: 'off' }));
      const li = h('li', { class: 'split-part', style: { '--c': colorOf(p.project) } },
        h('div', { class: 'split-head' },
          h('h3', { class: 'split-num' }, `Part ${i + 1}`),
          h('span', { class: 'split-range' },
            h('span', { class: 'split-from' }, timeOf(b[i])), ' – ',
            last
              ? h('span', null, running ? 'now' : timeOf(b[i + 1]))
              : h('input', { type: 'time', name: 'cut', value: timeOf(b[i + 1]), required: true,
                  'aria-label': `Part ${i + 1} ends at`, class: 'split-cut' }),
          ),
          h('span', { class: 'split-dur' }),
          parts.length > 2
            ? h('button', { type: 'button', class: 'small danger-text', 'aria-label': `Remove part ${i + 1}`,
                onclick: () => removePart(i) }, 'Remove')
            : null,
        ),
        h('div', { class: 'field-row' },
          field('project', 'Project', p.project, true),
          field('task', 'Task', p.task, true)),
        field('description', 'Description', p.description, false),
      );
      projectTaskPickers(li.querySelector('[name="project"]'), li.querySelector('[name="task"]'));
      return li;
    }));
    $('#split-save').textContent = `Split into ${parts.length}`;
    update();
  }

  /** Validate cut points, refresh durations, colours and the bar. */
  function update() {
    const end = endOf();
    let error = '';
    const lis = [...list.children];
    lis.forEach((li, i) => {
      const cut = li.querySelector('[name="cut"]');
      if (!cut) return;
      cut.setCustomValidity('');
      if (!cut.value) return;
      const ms = atTime(entry, cut.value);
      const prev = i === 0 ? entry.start : cuts[i - 1];
      const next = i === lis.length - 2 ? end : (cuts[i + 1] ?? end);
      if (ms <= prev || ms >= next) {
        const msg = `Part ${i + 1} must end after ${timeOf(prev)} and before ${running && i === lis.length - 2 ? 'now' : timeOf(next)}.`;
        cut.setCustomValidity(msg);
        error ||= msg;
      }
      cuts[i] = ms;
    });
    const b = bounds();
    lis.forEach((li, i) => {
      li.querySelector('.split-from').textContent = timeOf(b[i]);
      li.querySelector('.split-dur').textContent = b[i + 1] > b[i] ? formatHM(b[i + 1] - b[i]) : '–';
      li.style.setProperty('--c', colorOf(li.querySelector('[name="project"]').value));
    });
    bar.replaceChildren(...lis.map((li, i) => h('span', {
      style: { 'flex-grow': String(Math.max(b[i + 1] - b[i], 0)), '--c': colorOf(li.querySelector('[name="project"]').value) },
    })));
    $('#split-hint').textContent = error;
  }

  function addPart() {
    readForm();
    // Cut the longest part in half; the new part starts as a copy of it.
    const b = bounds();
    let longest = 0;
    for (let i = 1; i < parts.length; i++) if (b[i + 1] - b[i] > b[longest + 1] - b[longest]) longest = i;
    cuts.splice(longest, 0, midpoint(b[longest], b[longest + 1]));
    parts.splice(longest + 1, 0, { ...parts[longest], description: '' });
    build();
    list.children[longest + 1]?.querySelector('[name="description"]').focus();
  }

  function removePart(i) {
    readForm();
    parts.splice(i, 1);
    // The removed part's time goes to the part before it (or after, for the first).
    cuts.splice(i === 0 ? 0 : i - 1, 1);
    build();
    list.children[Math.max(0, i - 1)]?.querySelector('[name="project"]').focus();
  }

  form.reset();
  $('#split-summary').textContent =
    `${labels.project} · ${labels.task}${entry.description ? ` · ${entry.description}` : ''}, ` +
    `${timeOf(entry.start)}–${running ? 'now' : timeOf(entry.end)} (${formatHM(endOf() - entry.start)})`;
  build();

  const onInput = () => update();
  const add = $('#split-add');
  add.onclick = addPart;
  form.addEventListener('input', onInput);
  const result = await runDialog(document.getElementById('split-dialog'));
  form.removeEventListener('input', onInput);
  if (result !== 'save') return false;

  readForm();
  // The entry may have changed elsewhere (sync, another tab) while the dialog was open.
  const now = store.entry(entry.id);
  if (!now || now.deleted || now.start !== entry.start || (now.end ?? null) !== (entry.end ?? null)) {
    announce('The entry changed while you were splitting it. Nothing was split.');
    return false;
  }
  const b = bounds();
  const resolved = [];
  for (const [i, p] of parts.entries()) {
    const task = await store.resolveTask(p.project, p.task);
    resolved.push({ taskId: task.id, description: p.description, start: b[i], end: i === parts.length - 1 && running ? null : b[i + 1] });
  }
  await store.splitEntry(entry.id, resolved);
  announce(`Split into ${parts.length} entries`);
  return true;
}
