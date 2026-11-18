// The day ribbon: a 24-hour strip shaded from night through dawn, day and dusk,
// with time entries drawn as blocks in their project color.
//
// Positions are fractions of the real local day (start of day → start of next
// day), so DST days of 23 or 25 hours still line up. The running block and the
// "now" marker are updated by `updateRibbons()` on each clock tick.

import * as store from './store.js';
import { formatTotal, startOfDay, timeOf, today } from './time.js';
import { h } from './ui.js';

const pct = (x) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(3)}%`;

// The sky itself is drawn by the dither island (React + dithercn), loaded on
// first use. Until it draws, or if it can't load, the CSS gradient shows.
let ditherLoad;
function loadDither() {
  ditherLoad ??= (async () => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('../vendor/dither/dither.css', import.meta.url).href;
    document.head.append(css);
    await import('../vendor/dither/dither.js');
  })().catch((err) => {
    console.warn('Dithered sky unavailable, using the gradient.', err);
  });
  return ditherLoad;
}

const nowAttr = (fraction) => (fraction >= 0 && fraction <= 1 ? fraction.toFixed(4) : '-1');

/**
 * @param day      Temporal.PlainDate
 * @param entries  entries overlapping that day
 * @param size     'large' or 'small'
 * @param cell     dither cell size in CSS px
 */
export function dayRibbon(day, entries, { size = 'large', cell = 3 } = {}) {
  const start = startOfDay(day);
  const span = startOfDay(day.add({ days: 1 })) - start;
  const now = Date.now();
  const isToday = day.equals(today());

  const blocks = entries
    .filter((e) => (e.end ?? now) > start && e.start < start + span)
    .map((e) => {
      const from = Math.max(e.start, start);
      const to = Math.min(e.end ?? now, start + span);
      return h('span', {
        class: e.end == null ? 'blk run' : 'blk',
        style: {
          '--l': pct((from - start) / span),
          '--w': pct((to - from) / span),
          '--c': store.labelsOf(e).color,
        },
        'data-from': e.end == null ? from : null,
      });
    });

  const tracked = entries.reduce((s, e) => s + (Math.min(e.end ?? now, start + span) - Math.max(e.start, start)), 0);
  const first = entries.length ? Math.max(Math.min(...entries.map((e) => e.start)), start) : null;
  const summary = entries.length
    ? `${isToday ? 'Today' : 'Day'}: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, ${formatTotal(tracked)} tracked, from ${timeOf(first)}`
    : `${isToday ? 'Today' : 'Day'}: nothing tracked yet`;

  loadDither();
  return h('div', { class: `ribbon ${size}`, 'data-start': start, 'data-span': span },
    h('div', { class: 'sky', role: 'img', 'aria-label': summary },
      h('sky-dither', { now: isToday ? nowAttr((now - start) / span) : '-1', cell }),
      blocks,
      isToday ? h('span', { class: 'now', style: { '--l': pct((now - start) / span) } }) : null,
    ),
    size === 'large'
      ? h('div', { class: 'scale', 'aria-hidden': 'true' }, ['0', '6', '12', '18', '24'].map((t) => h('span', null, t)))
      : null,
  );
}

/** Grow running blocks and move "now" markers. Called every second. */
export function updateRibbons(now = Date.now()) {
  for (const r of document.querySelectorAll('.ribbon')) {
    const start = Number(r.dataset.start);
    const span = Number(r.dataset.span);
    for (const b of r.querySelectorAll('.blk.run')) {
      b.style.setProperty('--w', pct((Math.min(now, start + span) - Number(b.dataset.from)) / span));
    }
    r.querySelector('.now')?.style.setProperty('--l', pct((now - start) / span));
    const sky = r.querySelector('sky-dither');
    if (sky && sky.getAttribute('now') !== '-1') {
      const value = nowAttr((now - start) / span);
      if (sky.getAttribute('now') !== value) sky.setAttribute('now', value);
    }
  }
}

/** Entries overlapping a calendar day (including ones that started the day before). */
export function entriesOnDay(day, list = store.entries()) {
  const start = startOfDay(day);
  const end = startOfDay(day.add({ days: 1 }));
  const now = Date.now();
  return list.filter((e) => (e.end ?? now) > start && e.start < end);
}

