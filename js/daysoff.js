// Days off: a month calendar for vacations, sick leave and public holidays.
// It's a personal record only: days off hold no time, so reports and totals
// are unchanged. Tap a day, or drag (or Shift-click) across days, then pick a
// type. Marked days also show on the Track page.

import * as store from './store.js';
import { formatShort, today } from './time.js';
import { announce, h } from './ui.js';

export const TYPE_LABEL = { vacation: 'Vacation', sick: 'Sick leave', holiday: 'Holiday' };
export const TYPE_SHORT = { vacation: 'Vac', sick: 'Sick', holiday: 'Hol' };

const selected = new Set(); // 'YYYY-MM-DD' strings, kept across re-renders
let anchor = null;          // first day of a drag / Shift-click range
let shownMonth = null;

const monthOf = (params) => {
  const m = params.get('month');
  try { return m ? Temporal.PlainYearMonth.from(m) : today().toPlainYearMonth(); } catch { return today().toPlainYearMonth(); }
};
const daysBetween = (a, b) => {
  let [x, y] = Temporal.PlainDate.compare(a, b) <= 0 ? [a, b] : [b, a];
  const out = [];
  for (; Temporal.PlainDate.compare(x, y) <= 0; x = x.add({ days: 1 })) out.push(x.toString());
  return out;
};

export function renderDaysOff(params) {
  const month = monthOf(params);
  if (!shownMonth || !shownMonth.equals(month)) { selected.clear(); anchor = null; shownMonth = month; }
  const first = month.toPlainDate({ day: 1 });
  const lead = first.dayOfWeek - 1; // Monday first
  const t = today().toString();
  const link = (m) => `#/days-off?month=${m}`;

  // ---- the grid ----
  let dragging = false, dragFrom = null, moved = false;
  const cells = [];
  const paint = () => {
    for (const c of cells) {
      c.classList.toggle('is-selected', selected.has(c.dataset.day));
      c.setAttribute('aria-pressed', String(selected.has(c.dataset.day)));
    }
    bar.hidden = selected.size === 0;
    count.textContent = selected.size === 1
      ? formatShort(Temporal.PlainDate.from([...selected][0]))
      : `${selected.size} days selected`;
    const types = new Set([...selected].map((d) => store.dayOff(d)?.type ?? null));
    for (const b of bar.querySelectorAll('[data-type]')) b.setAttribute('aria-pressed', String(types.size === 1 && types.has(b.dataset.type)));
    clearBtn.hidden = ![...selected].some((d) => store.dayOff(d));
  };
  const dayFromPoint = (x, y) => document.elementFromPoint(x, y)?.closest?.('.do-day')?.dataset.day ?? null;

  const grid = h('div', { class: 'do-grid', role: 'group', 'aria-label': `Days of ${first.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}` },
    ...Array.from({ length: lead }, () => h('span', { class: 'do-pad', 'aria-hidden': 'true' })),
    ...Array.from({ length: month.daysInMonth }, (_, i) => {
      const d = first.add({ days: i });
      const key = d.toString();
      const off = store.dayOff(key);
      const weekend = d.dayOfWeek >= 6;
      const label = `${d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${off ? `, ${TYPE_LABEL[off.type]}${off.note ? `: ${off.note}` : ''}` : ''}${key === t ? ', today' : ''}`;
      const cell = h('button', {
        type: 'button',
        class: ['do-day', off ? `is-${off.type}` : null, weekend ? 'is-weekend' : null, key === t ? 'is-today' : null].filter(Boolean).join(' '),
        'data-day': key,
        'aria-label': label,
        title: off?.note || null,
        onclick: (e) => {
          if (moved) { moved = false; return; } // the end of a drag, already handled
          if (e.shiftKey && anchor) {
            for (const x of daysBetween(Temporal.PlainDate.from(anchor), d)) selected.add(x);
          } else if (selected.has(key)) selected.delete(key);
          else { selected.add(key); anchor = key; }
          paint();
        },
      }, h('span', { class: 'do-num' }, String(d.day)));
      cells.push(cell);
      return cell;
    }));

  // Drag across days (mouse, pen or finger) to select a range.
  grid.addEventListener('pointerdown', (e) => {
    const day = e.target.closest?.('.do-day')?.dataset.day;
    if (!day || e.button > 0) return;
    dragging = true; dragFrom = day; moved = false;
  });
  grid.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const day = dayFromPoint(e.clientX, e.clientY);
    if (!day || (day === dragFrom && !moved)) return;
    if (!moved) { selected.clear(); moved = true; e.target.releasePointerCapture?.(e.pointerId); }
    selected.clear();
    for (const x of daysBetween(Temporal.PlainDate.from(dragFrom), Temporal.PlainDate.from(day))) selected.add(x);
    anchor = dragFrom;
    paint();
  });
  const stop = () => { dragging = false; };
  grid.addEventListener('pointerup', stop);
  grid.addEventListener('pointercancel', () => { dragging = false; moved = false; });

  // ---- what to do with the selection ----
  const count = h('span', { class: 'do-count', 'aria-live': 'polite' });
  const note = h('input', { id: 'do-note', name: 'note', autocomplete: 'off', placeholder: 'Note (optional)', 'aria-label': 'Note' });
  const apply = async (type) => {
    const days = [...selected];
    selected.clear(); // before saving: each save redraws the view
    await store.setDaysOff(days, type, note.value);
    announce(type ? `${days.length === 1 ? 'Day' : `${days.length} days`} marked as ${TYPE_LABEL[type].toLowerCase()}` : `Cleared ${days.length === 1 ? 'the day' : `${days.length} days`}`);
  };
  const clearBtn = h('button', { type: 'button', class: 'small danger-text', onclick: () => apply(null) }, 'Clear');
  const bar = h('div', { class: 'do-bar', hidden: true },
    h('div', { class: 'do-bar-head' }, count,
      h('button', { type: 'button', class: 'small', onclick: () => { selected.clear(); paint(); } }, 'Deselect')),
    h('div', { class: 'do-types' },
      store.DAY_OFF_TYPES.map((type) => h('button', { type: 'button', class: `do-type is-${type}`, 'data-type': type, onclick: () => apply(type) },
        h('i', { 'aria-hidden': 'true' }), TYPE_LABEL[type]))),
    h('div', { class: 'do-bar-foot' }, note, clearBtn),
  );

  // ---- this year so far ----
  const year = month.year;
  const tally = Object.fromEntries(store.DAY_OFF_TYPES.map((type) => [type, 0]));
  for (const r of store.daysOff()) if (r.day.startsWith(`${year}-`)) tally[r.type] += 1;

  const view = h('div', { class: 'stack days-off' },
    h('div', { class: 'do-head' },
      h('a', { class: 'button icon-btn ghost', href: link(month.subtract({ months: 1 })), 'aria-label': 'Previous month' }, h('span', { 'aria-hidden': 'true' }, '‹')),
      h('h1', null, first.toLocaleString('en-GB', { month: 'long', year: 'numeric' })),
      h('a', { class: 'button icon-btn ghost', href: link(month.add({ months: 1 })), 'aria-label': 'Next month' }, h('span', { 'aria-hidden': 'true' }, '›')),
    ),
    h('p', { class: 'hint' }, 'Your vacations, sick leave and holidays, for your own history. They don’t change reports. Tap a day, or drag across days, then pick what it was.'),
    h('div', { class: 'do-cal' },
      h('div', { class: 'do-week', 'aria-hidden': 'true' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => h('span', null, x))),
      grid),
    h('ul', { class: 'do-legend', 'aria-label': 'Legend' },
      store.DAY_OFF_TYPES.map((type) => h('li', { class: `is-${type}` }, h('i', { 'aria-hidden': 'true' }), TYPE_LABEL[type]))),
    bar,
    h('p', { class: 'do-tally' }, h('span', null, `${year}`),
      h('span', null, store.DAY_OFF_TYPES.map((type, i) => [i ? ' · ' : '', h('b', { class: `is-${type}` }, String(tally[type])), ` ${TYPE_LABEL[type].toLowerCase()}`]).flat())),
    month.equals(today().toPlainYearMonth()) ? null : h('a', { href: '#/days-off', class: 'button' }, 'Back to this month'),
  );
  queueMicrotask(paint);
  return view;
}
