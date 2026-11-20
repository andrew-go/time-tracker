// Expanding rows for the Track timesheet, adapted from the Expand Card on
// designbookmark.com/motion. Tap a row and it opens in place into a card with
// its time ranges and actions; the other rows step back (dim and shrink a
// touch). Tap again, or press Escape inside it, to fold it away.
//
// Every row has the original component's springs:
//   p  open progress (height, colour edge)       stiffness 240, damping 21
//   a  details fade-in, starts 160 ms after p     260, 28
//   o  opacity of the rows that step back         300, 30
//   s  scale of the rows that step back           300, 26
// The original's "ride to the top" (y) is left out: in a list on a page the row
// stays where it is, so nothing jumps under your finger.
// With reduced motion every spring snaps to its end.

const SPRING = { p: [240, 21], a: [260, 28], o: [300, 30], s: [300, 26] };
const BACK_OPACITY = 0.55, BACK_SCALE = 0.985, DETAILS_DELAY = 160;

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const S = (x, [k, c]) => ({ x, v: 0, t: x, k, c });
const step = (s, dt) => { const a = -s.k * (s.x - s.t) - s.c * s.v; s.v += a * dt; s.x += s.v * dt; };
const still = (s) => Math.abs(s.x - s.t) < 1e-3 && Math.abs(s.v) < 1e-3;
const settle = (s) => { s.x = s.t; s.v = 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Wire up a list of rows. Each row: li[data-key] > button[aria-controls] … and
 * div.ts-more > div.ts-more-inner. `openKey` is the row that starts open
 * (already open, no animation); `onChange(key|null)` remembers it across re-renders.
 */
export function expandList(list, { openKey = null, onChange = () => {} } = {}) {
  const rows = [...list.querySelectorAll(':scope > li[data-key]')].map((li) => {
    const button = li.querySelector('[aria-controls]');
    const more = li.querySelector('.ts-more');
    const on = li.dataset.key === openKey;
    return {
      li, button, more, inner: more.firstElementChild, key: li.dataset.key,
      p: S(on ? 1 : 0, SPRING.p), a: S(on ? 1 : 0, SPRING.a),
      o: S(openKey && !on ? BACK_OPACITY : 1, SPRING.o), s: S(openKey && !on ? BACK_SCALE : 1, SPRING.s),
    };
  });
  let open = rows.some((r) => r.key === openKey) ? openKey : null;
  let raf = 0, last = 0;
  const timers = new Set();

  function show(key) {
    open = key;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const r of rows) {
      const me = r.key === key;
      r.p.t = me ? 1 : 0;
      r.o.t = key && !me ? BACK_OPACITY : 1;
      r.s.t = key && !me ? BACK_SCALE : 1;
      r.button.setAttribute('aria-expanded', String(me));
      if (me) {
        r.more.hidden = false;
        r.more.inert = false;
        if (reduce.matches) r.a.t = 1;
        else {
          const t = setTimeout(() => { timers.delete(t); if (open === r.key) { r.a.t = 1; kick(); } }, DETAILS_DELAY);
          timers.add(t);
        }
      } else {
        r.a.t = 0;
        r.more.inert = true;
      }
    }
    onChange(key);
    kick();
  }

  for (const r of rows) {
    r.button.setAttribute('aria-expanded', String(r.key === open));
    r.more.hidden = r.key !== open;
    r.more.inert = r.key !== open;
    r.button.addEventListener('click', () => show(open === r.key ? null : r.key));
    r.li.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open === r.key && !e.defaultPrevented) {
        e.preventDefault();
        show(null);
        r.button.focus();
      }
    });
  }

  function kick() {
    if (reduce.matches) { rows.forEach((r) => [r.p, r.a, r.o, r.s].forEach(settle)); render(); return; }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function frame(now) {
    if (!list.isConnected) { raf = 0; return; } // the view re-rendered
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    for (let k = 0; k < 4; k++) rows.forEach((r) => [r.p, r.a, r.o, r.s].forEach((s) => step(s, dt / 4)));
    render();
    const moving = timers.size || rows.some((r) => [r.p, r.a, r.o, r.s].some((s) => !still(s)));
    if (moving) raf = requestAnimationFrame(frame);
    else { raf = 0; rows.forEach((r) => [r.p, r.a, r.o, r.s].forEach(settle)); render(); }
  }

  function render() {
    for (const r of rows) {
      const p = r.p.x, q = clamp(p, 0, 1);
      const moving = !(still(r.p) && (p === 0 || p === 1));
      // While it moves the height follows the spring (overshoot included);
      // at rest it is plain `auto`, so content changes reflow normally.
      r.more.style.blockSize = moving ? `${Math.max(0, p * r.inner.offsetHeight).toFixed(2)}px` : (p >= 1 ? '' : '0px');
      if (!moving && p === 0) r.more.hidden = true;
      r.li.style.setProperty('--edge', `${(4 * q).toFixed(2)}px`);
      r.li.toggleAttribute('data-open', r.key === open);
      const a = clamp(r.a.x, 0, 1);
      r.inner.style.opacity = a.toFixed(3);
      r.inner.style.translate = `0 ${((1 - r.a.x) * 10).toFixed(2)}px`;
      r.li.style.opacity = clamp(r.o.x, 0, 1).toFixed(3);
      r.li.style.scale = r.s.x === 1 ? '' : r.s.x.toFixed(4);
    }
  }

  render();
  return { close: () => show(null) };
}
