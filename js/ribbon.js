// The day ribbon: a strip shaded from night through dawn, day and dusk, with
// time entries drawn as blocks in their project color.
//
// It shows the day's daylight with a little dark on each side (about 6–18 in
// winter, 3–23 in summer) and widens to whole hours to fit anything tracked
// earlier or later, so little of it is spent on night.
// Positions are fractions of that real span of time, so DST days still line up. The running block and the
// "now" marker are updated by `updateRibbons()` on each clock tick.

import * as store from './store.js';
import { formatTotal, startOfDay, timeOf, toMs, today, zoned } from './time.js';
import { h } from './ui.js';
import { loadDither } from './dither.js';

const pct = (x) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(3)}%`;

// The sky itself is drawn by the dither island (<sky-dither>), loaded on first
// use. Until it draws, or if it can't load, the CSS gradient shows.
/**
 * Sunrise and sunset for `day` as fractions of the day, so the sky's light
 * follows the season instead of a fixed 6:36–18:51. We don't know where you
 * are, so this assumes a northern mid-latitude (50°N, central Europe) and puts
 * solar noon at 12:00 standard time (13:00 under daylight saving time).
 */
export function daylight(day) {
  const rad = Math.PI / 180;
  const decl = -23.44 * rad * Math.cos(((2 * Math.PI) / 365) * (day.dayOfYear + 10));
  const lat = 50 * rad;
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));
  const half = Math.acos(Math.min(1, Math.max(-1, cosH))) / rad / 15; // hours from noon
  const tz = Temporal.Now.timeZoneId();
  const offset = (d) => d.toZonedDateTime({ timeZone: tz, plainTime: '12:00' }).offsetNanoseconds / 3.6e12;
  const standard = Math.min(offset(day.with({ month: 1, day: 1 })), offset(day.with({ month: 7, day: 1 })));
  const noon = 12 + (offset(day) - standard);
  return { rise: (noon - half) / 24, set: (noon + half) / 24 };
}

/**
 * The clock-hour window to show for `day`: daylight plus about 1¼ h of dark on
 * each side (so the coloured sky fills most of the strip and sits in the
 * middle), widened to whole hours to fit anything tracked earlier or later.
 * "Now" doesn't widen it: at night the now line is simply off the strip.
 */
function windowFor(day, entries, now) {
  const dayStart = startOfDay(day);
  const dayEnd = startOfDay(day.add({ days: 1 }));
  const hourOf = (ms) => { const z = zoned(ms); return z.hour + z.minute / 60 + z.second / 3600; };
  const sun = daylight(day);
  let from = Math.max(0, Math.floor(sun.rise * 24 - 1.25));
  let to = Math.min(24, Math.ceil(sun.set * 24 + 1.25));
  for (const e of entries) {
    const a = Math.max(e.start, dayStart), b = Math.min(e.end ?? now, dayEnd);
    if (b <= a) continue;
    from = Math.min(from, Math.floor(hourOf(a)));
    to = Math.max(to, b >= dayEnd ? 24 : Math.ceil(hourOf(b)));
  }
  const at = (hr) => (hr >= 24 ? dayEnd : hr <= 0 ? dayStart : toMs(day.toString(), `${String(hr).padStart(2, '0')}:00`));
  return { from, to, start: at(from), end: at(to) };
}

const hourLabel = (hr) => {
  const m = Math.round(hr * 60);
  return m % 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : String(m / 60);
};

const nowAttr = (fraction) => (fraction >= 0 && fraction <= 1 ? fraction.toFixed(4) : '-1');

/**
 * @param day      Temporal.PlainDate
 * @param entries  entries overlapping that day
 * @param size     'large' or 'small'
 * @param cell     dither cell size in CSS px
 */
export function dayRibbon(day, entries, { size = 'large', cell = 3 } = {}) {
  const now = Date.now();
  const isToday = day.equals(today());
  const win = windowFor(day, entries, now);
  const nowFrac = (now - win.start) / (win.end - win.start);
  const nowShown = isToday && nowFrac >= 0 && nowFrac <= 1;
  const start = win.start;
  const span = win.end - win.start;

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
  const sun = daylight(day);
  const inWin = (frac) => (frac * 24 - win.from) / (win.to - win.from);
  return h('div', { class: `ribbon ${size}`, 'data-start': start, 'data-span': span, 'data-today': isToday ? '' : null },
    h('div', { class: 'sky', role: 'img', 'aria-label': summary,
      style: { '--sun-rise': pct(inWin(sun.rise)), '--sun-noon': pct(inWin((sun.rise + sun.set) / 2)), '--sun-set': pct(inWin(sun.set)) } },
      h('sky-dither', { now: nowShown ? nowAttr(nowFrac) : '-1', cell,
        rise: sun.rise.toFixed(4), set: sun.set.toFixed(4), from: String(win.from), to: String(win.to) }),
      blocks,
      isToday ? h('span', { class: 'now', hidden: !nowShown, style: { '--l': pct(nowFrac) } }) : null,
    ),
    size === 'large'
      ? h('div', { class: 'scale', 'aria-hidden': 'true' },
        [0, 1, 2, 3, 4].map((i) => h('span', null, hourLabel(win.from + ((win.to - win.from) * i) / 4))))
      : null,
  );
}

/** Grow running blocks and move "now" markers. Called every second. */
export function updateRibbons(now = Date.now()) {
  for (const r of document.querySelectorAll('.ribbon')) {
    const start = Number(r.dataset.start);
    const span = Number(r.dataset.span);
    // A running timer reached the window's end: ask the view to redraw it wider.
    if (r.querySelector('.blk.run') && now >= start + span && span < 24 * 3_600_000 - 1) {
      document.dispatchEvent(new CustomEvent('ribbon-outgrown'));
      return;
    }
    for (const b of r.querySelectorAll('.blk.run')) {
      b.style.setProperty('--w', pct((Math.min(now, start + span) - Number(b.dataset.from)) / span));
    }
    const f = (now - start) / span;
    const line = r.querySelector('.now');
    if (line) {
      line.hidden = f < 0 || f > 1; // at night "now" is off the strip
      line.style.setProperty('--l', pct(f));
      const sky = r.querySelector('sky-dither');
      const value = line.hidden ? '-1' : nowAttr(f);
      if (sky && sky.getAttribute('now') !== value) sky.setAttribute('now', value);
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
