// The day ribbon: a 24-hour strip shaded from night through dawn, day and dusk,
// with time entries drawn as blocks in their project color.
//
// Positions are fractions of the real local day (start of day → start of next
// day), so DST days of 23 or 25 hours still line up. The running block and the
// "now" marker are updated by `updateRibbons()` on each clock tick.

import * as store from './store.js';
import { formatTotal, startOfDay, timeOf, today } from './time.js';
import { h } from './ui.js';
import { loadDither } from './dither.js';

const pct = (x) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(3)}%`;

// The sky itself is drawn by the dither island (<sky-dither>), loaded on first
// use. Until it draws, or if it can't load, the CSS gradient shows.
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
        'data-entry': e.id,
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


/**
 * Hovering the ribbon points at the entry under the pointer: its blocks stay
 * bright, the rest dim, a label shows the task and time range, and its row in
 * `list` (li[data-entries]) lights up. Hovering a row lights up its blocks.
 * A mouse/pen/touch-drag nicety; the same facts are in the rows themselves.
 */
export function linkRibbon(ribbon, list) {
  const sky = ribbon.querySelector('.sky');
  const tip = h('span', { class: 'blk-tip', 'aria-hidden': 'true', hidden: true });
  ribbon.append(tip);
  const rowOf = (id) => list?.querySelector(`li[data-entries~="${CSS.escape(id)}"]`);
  let current = null;

  function light(row, ids, entry = null) {
    if (current !== row) {
      current?.classList.remove('is-hover');
      row?.classList.add('is-hover');
      current = row;
    }
    const set = new Set(ids);
    sky.toggleAttribute('data-hl', set.size > 0);
    for (const b of sky.querySelectorAll('.blk')) b.classList.toggle('hl', set.has(b.dataset.entry));
    if (!entry) { tip.hidden = true; return; }
    const e = store.entries().find((x) => x.id === entry.dataset.entry);
    if (!e) { tip.hidden = true; return; }
    const l = store.labelsOf(e);
    tip.textContent = `${timeOf(e.start)}–${e.end ? timeOf(e.end) : 'now'} · ${l.task}`; // time first: long names get cut
    tip.hidden = false;
    // Centre the label over the block, kept inside the ribbon.
    const r = ribbon.getBoundingClientRect(), b = entry.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(b.left + b.width / 2 - r.left, half), r.width - half);
    tip.style.insetInlineStart = `${x}px`;
  }
  const clear = () => light(null, []);

  // The block under the pointer, or the nearest one within reach (short entries
  // are thin; a fingertip gets more room than a mouse).
  function pointAt(ev) {
    let best = null, dist = ev.pointerType === 'touch' ? 17 : 9;
    for (const b of sky.querySelectorAll('.blk')) {
      const r = b.getBoundingClientRect();
      const d = ev.clientX < r.left ? r.left - ev.clientX : ev.clientX > r.right ? ev.clientX - r.right : 0;
      if (d < dist) { dist = d; best = b; }
    }
    if (!best) { clear(); return null; }
    const row = rowOf(best.dataset.entry);
    light(row, row ? row.dataset.entries.split(' ') : [best.dataset.entry], best);
    return row;
  }

  // Mouse and pen: follow the pointer, clear when it leaves.
  // Touch: tap a block (or slide a finger along the ribbon) and the choice stays
  // until you tap somewhere else; its row scrolls into view if it's off screen.
  // `touch-action: pan-y` on the ribbon lets a vertical swipe still scroll the page.
  let touchRow = null, touching = false;
  sky.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'touch') return;
    touching = true;
    touchRow = pointAt(ev);
  });
  sky.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'touch') pointAt(ev);
    else if (touching) touchRow = pointAt(ev);
  });
  sky.addEventListener('pointerup', (ev) => {
    if (ev.pointerType !== 'touch' || !touching) return;
    touching = false;
    if (touchRow) {
      const r = touchRow.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) {
        touchRow.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }
  });
  sky.addEventListener('pointercancel', () => { touching = false; clear(); }); // became a page scroll
  sky.addEventListener('pointerleave', (ev) => { if (ev.pointerType !== 'touch') clear(); });
  const onOutside = (ev) => {
    if (!sky.isConnected) return document.removeEventListener('pointerdown', onOutside);
    if (ev.pointerType === 'touch' && !sky.contains(ev.target)) clear();
  };
  document.addEventListener('pointerdown', onOutside);

  for (const row of list?.querySelectorAll('li[data-entries]') ?? []) {
    row.addEventListener('pointerenter', (ev) => { if (ev.pointerType !== 'touch') light(row, row.dataset.entries.split(' ')); });
    row.addEventListener('pointerleave', (ev) => { if (ev.pointerType !== 'touch') clear(); });
  }
}
