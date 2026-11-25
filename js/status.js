// "Copy for status": the day's work as plain text for a daily status.
// Tracked time is grouped per task + description (as on the Track sheet), and
// open planned tasks from the Plan tab follow as "Planned next".

import * as store from './store.js';
import { formatHM, today } from './time.js';
import { announce, h, runDialog } from './ui.js';

const longDate = (d) => d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const weekday = (d) => d.toLocaleString('en-GB', { weekday: 'short' });

/** Plain-text status for `day` (Temporal.PlainDate); `groups` are the Track sheet's rows. */
export function statusText(day, groups, now = Date.now()) {
  const ms = (list) => list.reduce((s, e) => s + ((e.end ?? now) - e.start), 0);
  const total = ms(groups.flat());
  const lines = [`Daily status, ${longDate(day)} (${formatHM(total)})`, ''];

  lines.push(day.equals(today()) ? 'Done today' : 'Done');
  for (const g of groups) {
    const l = store.labelsOf(g[0]);
    const desc = g[0].description ? `: ${g[0].description}` : '';
    const running = g.some((e) => e.end == null) ? ', in progress' : '';
    lines.push(`• ${l.project} / ${l.task}${desc} (${formatHM(ms(g))}${running})`);
  }

  // Open plans: unfinished from this day or before, then the next week.
  const d = day.toString();
  const until = day.add({ days: 7 }).toString();
  const next = store.plans().filter((p) => !p.done && p.day && p.day <= until)
    .filter((p) => p.day > d || !groups.some((g) => g[0].taskId === p.taskId && (g[0].description ?? '') === (p.description ?? '')))
    .slice(0, 8);
  if (next.length) {
    lines.push('', 'Planned next');
    for (const p of next) {
      const l = store.labelsOf(p);
      const pd = Temporal.PlainDate.from(p.day);
      const when = p.day < d ? 'carried over' : p.day === d ? 'today' : Temporal.PlainDate.compare(pd, day.add({ days: 1 })) === 0 ? 'tomorrow' : weekday(pd);
      lines.push(`• ${l.task}${p.description ? `: ${p.description}` : ''}, ${when}${p.time ? ` ${p.time}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Copy to the clipboard; if the browser refuses, show the text selected so it can be copied by hand. */
export async function copyStatus(day, groups) {
  const text = statusText(day, groups);
  try {
    await navigator.clipboard.writeText(text);
    announce('Status copied. Paste it into Claude or Slack.');
  } catch {
    const area = h('textarea', { readonly: true, rows: 12, class: 'status-text', 'aria-label': 'Daily status' });
    area.value = text;
    const dialog = h('dialog', { class: 'status-dialog', 'aria-labelledby': 'status-title', closedby: 'any' },
      h('form', { method: 'dialog' },
        h('h2', { id: 'status-title' }, 'Copy your status'),
        h('p', { class: 'hint' }, 'The browser didn’t allow copying. Select all and copy it here.'),
        area,
        h('div', { class: 'actions' }, h('button', { value: 'close', class: 'primary' }, 'Done'))));
    document.body.append(dialog);
    const done = runDialog(dialog);
    area.select();
    await done;
    dialog.remove();
  }
  return text;
}

