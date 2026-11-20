// Spring combo box: the "pick one or type a new name" field for projects and tasks.
// Adapted from the Spring Dropdown on designbookmark.com/motion. The menu's
// height is a spring, so it drops with a little overshoot; rows fall in one
// after another; the hover highlight has a stiff leading edge and a soft
// trailing edge, so it stretches between rows; picking a row draws its check,
// rolls the new name up into the field and folds the menu away.
//
// It stays an ordinary text input (ARIA 1.2 combobox with a listbox popup), so
// typing a name that isn't in the list still works and creates it on save.
// Keys: ArrowDown/ArrowUp open and move, Enter picks, Escape closes the menu
// (not the dialog), Tab leaves. With reduced motion every spring snaps.
import { h } from './ui.js';

// Springs as [stiffness, damping], the same values as the original component.
const SPRING = {
  height: [300, 23],  // menu height
  chevron: [300, 18], // chevron turn
  fade: [400, 34],    // menu opacity
  press: [500, 18],   // field squeeze on press / pick
  roll: [340, 26],    // value rolling into the field
  row: [300, 24],     // each row falling in
  tick: [260, 26],    // check mark drawing
  lead: [620, 36],    // highlight edge facing the move
  trail: [200, 20],   // highlight edge that lags behind
  hlFade: [400, 32],  // highlight opacity
};
const ROW = 44, PAD = 6, MAX_ROWS = 6, TICK = 22;

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const S = (x, [k, c]) => ({ x, v: 0, t: x, k, c });
const tune = (s, [k, c]) => { s.k = k; s.c = c; };
const step = (s, dt) => { const a = -s.k * (s.x - s.t) - s.c * s.v; s.v += a * dt; s.x += s.v * dt; };
const still = (s) => Math.abs(s.x - s.t) < 1e-3 && Math.abs(s.v) < 1e-3;
const settle = (s) => { s.x = s.t; s.v = 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const norm = (s) => s.trim().toLocaleLowerCase();

const svg = (cls, d, width) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('class', cls);
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke-width', width);
  el.append(path);
  return el;
};

let uid = 0;

/**
 * Upgrade a text input into a spring combo box.
 * `options()` is called each time the menu opens and returns [{ label, color }].
 */
export function springCombo(input, { options, label }) {
  const id = `combo-${++uid}`;
  input.removeAttribute('list');
  const slotA = h('span', { class: 'combo-slot' });
  const slotB = h('span', { class: 'combo-slot' });
  const chev = svg('combo-chev', 'm6 9 6 6 6-6', 2);
  const toggle = h('button', { type: 'button', class: 'combo-toggle', tabindex: '-1', 'aria-label': `Show ${label}` }, chev);
  const hl = h('i', { class: 'combo-hl', 'aria-hidden': 'true' });
  const track = h('div', { class: 'combo-track' }, hl);
  const list = h('div', { class: 'combo-list', role: 'listbox', id: `${id}-list`, 'aria-label': label }, track);
  const menu = h('div', { class: 'combo-menu', hidden: true }, list);
  const box = h('div', { class: 'combo' });
  input.replaceWith(box);
  box.append(input, h('span', { class: 'combo-roll', 'aria-hidden': 'true' }, slotA, slotB), toggle, menu);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);

  const H = S(0, SPRING.height), C = S(0, SPRING.chevron), O = S(0, SPRING.fade);
  const TS = S(1, SPRING.press), R = S(1, SPRING.roll);
  const HT = S(PAD, SPRING.lead), HB = S(PAD + ROW, SPRING.lead), HO = S(0, SPRING.hlFade);
  const springs = [H, C, O, TS, R, HT, HB, HO];
  let rows = [], maxRows = MAX_ROWS, open = false, hov = -1, rolling = false, raf = 0, last = 0, closeTimer = 0;
  const timers = new Set();
  const after = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const fullHeight = () => PAD * 2 + ROW * Math.min(rows.length, maxRows);

  // ---- rows ----------------------------------------------------------------

  function build(showAll) {
    const q = norm(input.value);
    const all = options();
    const exact = all.some((o) => norm(o.label) === q);
    const shown = showAll || exact || !q ? all : all.filter((o) => norm(o.label).includes(q));
    for (const r of rows) r.el.remove();
    rows = shown.map((o, i) => {
      const tick = svg('combo-tick', 'M5 12.5l4.5 4.5L19 7.5', 2.2);
      const el = h('div', {
        class: 'combo-opt', role: 'option', id: `${id}-o${i}`, 'aria-selected': 'false',
        style: { '--c': o.color ?? 'var(--control)', top: `${PAD + i * ROW}px` },
        onpointermove: () => { if (open) hover(i); },
        onclick: () => { if (open) pick(i); },
      }, h('i', { class: 'combo-dot', 'aria-hidden': 'true' }), h('span', { class: 'combo-label' }, o.label), tick);
      track.append(el);
      const on = norm(o.label) === q;
      if (on) el.setAttribute('aria-selected', 'true');
      return { el, label: o.label, tick: tick.firstChild, s: S(open ? 1 : 0, SPRING.row), k: S(on ? 1 : 0, SPRING.tick) };
    });
    track.style.blockSize = `${PAD * 2 + ROW * rows.length}px`;
    list.scrollTop = 0;
    hov = -1;
    HO.t = 0;
    input.removeAttribute('aria-activedescendant');
  }

  function hover(i, snap = false) {
    if (i === hov || i < 0 || i >= rows.length) return;
    const top = PAD + i * ROW;
    if (snap || hov < 0) { HT.x = HT.t = top; HB.x = HB.t = top + ROW; HT.v = HB.v = 0; }
    else {
      const down = i > hov;
      tune(down ? HB : HT, SPRING.lead); tune(down ? HT : HB, SPRING.trail);
      HT.t = top; HB.t = top + ROW;
    }
    hov = i; HO.t = 1;
    input.setAttribute('aria-activedescendant', rows[i].el.id);
    // keep the row in view inside the list without scrolling the dialog
    if (top - PAD < list.scrollTop) list.scrollTop = top - PAD;
    else if (top + ROW + PAD > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW + PAD - list.clientHeight;
    kick();
  }

  // ---- open / close / pick --------------------------------------------------

  function setOpen(o, { showAll = false } = {}) {
    if (o) {
      clearTimeout(closeTimer);
      // Show as many rows as fit below the field (3 to 6); the rest scroll.
      const room = (visualViewport?.height ?? innerHeight) - input.getBoundingClientRect().bottom - 24;
      maxRows = clamp(Math.floor((room - PAD * 2) / ROW), 3, MAX_ROWS);
      list.style.maxBlockSize = `${PAD * 2 + ROW * maxRows}px`;
      build(showAll);
      if (!rows.length) o = false;
    }
    if (open === o) { if (o) { H.t = fullHeight(); kick(); } return; }
    open = o;
    input.setAttribute('aria-expanded', String(o));
    box.toggleAttribute('data-open', o);
    if (o) menu.hidden = false;
    H.t = o ? fullHeight() : 0; C.t = o ? 1 : 0; O.t = o ? 1 : 0;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const n = rows.length;
    rows.forEach((r, i) => {
      if (reduce.matches) r.s.t = o ? 1 : 0; // no stagger: everything appears at once
      else after(o ? 50 + i * 45 : (n - 1 - i) * 20, () => { r.s.t = open ? 1 : 0; kick(); });
    });
    if (o) {
      const cur = rows.findIndex((r) => norm(r.label) === norm(input.value));
      if (cur > -1) hover(cur, true);
    } else {
      hov = -1; HO.t = 0;
      input.removeAttribute('aria-activedescendant');
    }
    kick();
  }

  function pick(i) {
    const r = rows[i];
    if (!r) return;
    if (r.label !== input.value) {
      // Roll: the old name slides up and out, the new one rises into place.
      slotA.textContent = input.value;
      slotB.textContent = r.label;
      input.value = r.label;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setCustomValidity('');
      R.x = 0; R.v = 0; R.t = 1; rolling = true;
      box.toggleAttribute('data-rolling', true);
    }
    rows.forEach((x, j) => { x.k.t = j === i ? 1 : 0; x.el.setAttribute('aria-selected', String(j === i)); });
    TS.x = 0.955;
    kick();
    closeTimer = setTimeout(() => setOpen(false), 240);
  }

  // ---- events ---------------------------------------------------------------

  const press = () => { TS.x = 0.965; kick(); };
  toggle.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
  toggle.addEventListener('click', () => { press(); input.focus(); setOpen(!open, { showAll: true }); });
  input.addEventListener('click', () => { if (!open) { press(); setOpen(true, { showAll: true }); } });
  menu.addEventListener('pointerdown', (e) => e.preventDefault());
  input.addEventListener('input', (e) => {
    if (!e.isTrusted) return; // our own pick
    if (input.value.trim()) setOpen(true); else setOpen(false);
  });
  input.addEventListener('blur', () => setOpen(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true, { showAll: true }); if (hov < 0) hover(e.key === 'ArrowDown' ? 0 : rows.length - 1, true); }
      else hover(hov < 0 ? 0 : hov + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && open && hov > -1) {
      e.preventDefault();
      pick(hov);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault(); // keep the dialog open
      e.stopPropagation();
      setOpen(false);
    }
  });

  // ---- animation loop: runs only while something is moving ------------------

  function kick() {
    if (reduce.matches) { springs.forEach(settle); rows.forEach((r) => { settle(r.s); settle(r.k); }); render(); return; }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const sub = 4;
    for (let k = 0; k < sub; k++) {
      springs.forEach((s) => step(s, dt / sub));
      rows.forEach((r) => { step(r.s, dt / sub); step(r.k, dt / sub); });
    }
    render();
    const moving = timers.size || springs.some((s) => !still(s)) || rows.some((r) => !still(r.s) || !still(r.k));
    raf = moving ? requestAnimationFrame(frame) : 0;
    if (!moving) {
      springs.forEach(settle);
      render();
    }
  }

  function render() {
    const full = fullHeight();
    box.style.scale = TS.x.toFixed(4);
    chev.style.rotate = `${(180 * C.x).toFixed(2)}deg`;
    const hgt = Math.max(0, H.x), o = clamp(O.x, 0, 1);
    menu.style.blockSize = `${hgt.toFixed(2)}px`;
    menu.style.opacity = o.toFixed(3);
    menu.style.scale = `${(0.9 + 0.1 * clamp(H.x / (full || 1), 0, 1.06)).toFixed(4)} 1`;
    menu.hidden = !open && hgt < 1;
    rows.forEach((r) => {
      r.el.style.opacity = clamp(r.s.x, 0, 1).toFixed(3);
      r.el.style.translate = `0 ${((r.s.x - 1) * 14).toFixed(2)}px`;
      r.tick.style.strokeDashoffset = (TICK * (1 - clamp(r.k.x, 0, 1))).toFixed(2);
    });
    const end = PAD * 2 + ROW * rows.length;
    hl.style.opacity = (clamp(HO.x, 0, 1) * o).toFixed(3);
    const ht = clamp(Math.min(HT.x, HB.x - 16), PAD, end - PAD - 16), hb = clamp(HB.x, ht + 16, end - PAD);
    hl.style.blockSize = `${(hb - ht).toFixed(2)}px`;
    hl.style.translate = `0 ${ht.toFixed(2)}px`;
    if (rolling) {
      const r = R.x;
      slotB.style.opacity = clamp(r, 0, 1).toFixed(3);
      slotB.style.translate = `0 ${((1 - r) * 20).toFixed(2)}px`;
      slotA.style.opacity = clamp(1 - r, 0, 1).toFixed(3);
      slotA.style.translate = `0 ${(-r * 20).toFixed(2)}px`;
      if (still(R)) { rolling = false; box.removeAttribute('data-rolling'); }
    }
  }

  // Closing the dialog (or resetting its form) mid-animation leaves no menu behind.
  input.form?.addEventListener('reset', () => {
    open = true; setOpen(false);
    springs.forEach(settle); rolling = false; box.removeAttribute('data-rolling');
    render();
  });

  render();
  return { close: () => setOpen(false) };
}
