import * as store from './store.js';
import {
  dayOf, formatDate, formatDecimal, formatHM, formatMonth, formatRange,
  isWholeMonth, startOfDay, timeOf, today,
} from './time.js';
import { announce, h } from './ui.js';

// ---- Report data ---------------------------------------------------------

/**
 * Finished entries whose start falls in [from, to] (calendar days, inclusive),
 * optionally for one project. Entries are attributed to the day they start on,
 * same as the Entries view. A still-running timer is left out until stopped.
 */
export function buildReport({ from, to, projectId = '' }) {
  const startMs = startOfDay(from);
  const endMs = startOfDay(to.add({ days: 1 }));
  const all = store.entries().filter((e) => e.start >= startMs && e.start < endMs);
  const running = all.find((e) => e.end == null) ?? null;

  const rows = all
    .filter((e) => e.end != null)
    .map((e) => ({ ...e, ...store.labelsOf(e), ms: e.end - e.start, day: dayOf(e.start) }))
    .filter((e) => !projectId || e.projectId === projectId)
    .toSorted((a, b) => a.start - b.start);

  const sum = (list) => list.reduce((s, e) => s + e.ms, 0);
  const projects = [...Map.groupBy(rows, (e) => e.projectId ?? '?')]
    .map(([id, list]) => ({
      id,
      name: list[0].project,
      color: list[0].color,
      ms: sum(list),
      tasks: [...Map.groupBy(list, (e) => e.taskId)]
        .map(([taskId, tl]) => ({ id: taskId, name: tl[0].task, ms: sum(tl) }))
        .toSorted((a, b) => b.ms - a.ms),
    }))
    .toSorted((a, b) => b.ms - a.ms);

  const totalMs = sum(rows);
  const filterName = projectId ? store.project(projectId)?.name ?? 'Unknown project' : '';
  return {
    from,
    to,
    title: isWholeMonth(from, to) ? formatMonth(from.toPlainYearMonth()) : formatRange(from, to),
    filterName,
    rows,
    projects,
    totalMs,
    days: new Set(rows.map((e) => e.day.toString())).size,
    running: running && (!projectId || store.labelsOf(running).projectId === projectId),
  };
}

export const share = (ms, total) =>
  new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 }).format(total ? ms / total : 0);

export function reportFileName(report, ext) {
  const { from, to } = report;
  const period = isWholeMonth(from, to) ? from.toPlainYearMonth().toString() : `${from}_${to}`;
  const slug = report.filterName
    ? `-${report.filterName.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`
    : '';
  return `time-report-${period}${slug}.${ext}`;
}

// ---- Params --------------------------------------------------------------

function readParams(params) {
  const month = today().toPlainYearMonth();
  let from = month.toPlainDate({ day: 1 });
  let to = from.with({ day: from.daysInMonth });
  try {
    if (params.has('from') && params.has('to')) {
      const f = Temporal.PlainDate.from(params.get('from'));
      const t = Temporal.PlainDate.from(params.get('to'));
      if (Temporal.PlainDate.compare(f, t) <= 0) [from, to] = [f, t];
    }
  } catch { /* fall back to this month */ }
  const projectId = store.project(params.get('project') ?? '') ? params.get('project') : '';
  return { from, to, projectId };
}

function reportHash({ from, to, projectId }) {
  const q = new URLSearchParams({ from: from.toString(), to: to.toString() });
  if (projectId) q.set('project', projectId);
  return `#/reports?${q}`;
}

const monthRange = (ym) => {
  const from = ym.toPlainDate({ day: 1 });
  return { from, to: from.with({ day: from.daysInMonth }) };
};

// ---- View ----------------------------------------------------------------

export function renderReports(params) {
  const { from, to, projectId } = readParams(params);
  const report = buildReport({ from, to, projectId });
  const ym = from.toPlainYearMonth();
  const monthLink = (m) => reportHash({ ...monthRange(m), projectId });

  const onSubmit = (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    location.hash = reportHash({
      from: Temporal.PlainDate.from(data.get('from')),
      to: Temporal.PlainDate.from(data.get('to')),
      projectId: data.get('project'),
    });
  };

  const checkRange = (e) => {
    const form = e.target.form;
    const f = form.elements.from.value;
    const t = form.elements.to.value;
    form.elements.to.setCustomValidity(f && t && t < f ? 'End date must be on or after the start date.' : '');
  };

  const download = async (kind, button) => {
    button.disabled = true;
    try {
      const { exportPdf, exportCsv } = await import('./export.js');
      await (kind === 'pdf' ? exportPdf(report) : exportCsv(report));
      announce(`${kind.toUpperCase()} downloaded`);
    } catch (err) {
      console.error(err);
      announce(`Couldn’t create the ${kind.toUpperCase()}: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  };

  const projectOptions = store.projects({ archived: true }).map((p) =>
    h('option', { value: p.id, selected: p.id === projectId }, p.archived ? `${p.name} (archived)` : p.name));

  return h('div', { class: 'stack' },
    h('h1', { class: 'view-title' }, 'Reports'),

    h('search', { class: 'card report-filters' },
      h('form', { 'aria-label': 'Report period and project', onsubmit: onSubmit, oninput: checkRange },
        h('nav', { class: 'month-nav', 'aria-label': 'Month' },
          h('a', { class: 'button icon-btn', href: monthLink(ym.subtract({ months: 1 })), 'aria-label': 'Previous month' },
            h('span', { 'aria-hidden': 'true' }, '‹')),
          h('a', { class: 'button', href: monthLink(today().toPlainYearMonth()) }, 'This month'),
          h('a', { class: 'button icon-btn', href: monthLink(ym.add({ months: 1 })), 'aria-label': 'Next month' },
            h('span', { 'aria-hidden': 'true' }, '›')),
        ),
        h('div', { class: 'field-row' },
          h('div', { class: 'field' },
            h('label', { for: 'rf-from' }, 'From'),
            h('input', { id: 'rf-from', name: 'from', type: 'date', required: true, value: from.toString() }),
          ),
          h('div', { class: 'field' },
            h('label', { for: 'rf-to' }, 'To'),
            h('input', { id: 'rf-to', name: 'to', type: 'date', required: true, value: to.toString() }),
          ),
          h('div', { class: 'field' },
            h('label', { for: 'rf-project' }, 'Project'),
            h('select', { id: 'rf-project', name: 'project' },
              h('option', { value: '', selected: !projectId }, 'All projects'),
              projectOptions,
            ),
          ),
        ),
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'Show report')),
      ),
    ),

    h('section', { class: 'report', 'aria-labelledby': 'report-title' },
      h('div', { class: 'view-head' },
        h('h2', { id: 'report-title' }, report.title, report.filterName ? ` · ${report.filterName}` : ''),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'primary', id: 'pdf-btn', disabled: !report.rows.length,
            onclick: (e) => download('pdf', e.currentTarget) }, 'Download PDF'),
          h('button', { type: 'button', id: 'csv-btn', disabled: !report.rows.length,
            onclick: (e) => download('csv', e.currentTarget) }, 'Download CSV'),
        ),
      ),
      h('dl', { class: 'stats' },
        stat('Total', formatHM(report.totalMs), `${formatDecimal(report.totalMs)} h`),
        stat('Entries', String(report.rows.length)),
        stat('Days tracked', String(report.days)),
      ),
      report.running ? h('p', { class: 'hint' }, 'A timer is still running in this period. It’s included once you stop it.') : null,
      report.rows.length === 0
        ? h('p', { class: 'empty' }, 'No time tracked in this period.')
        : [summaryTable(report), entriesTable(report)],
    ),
  );
}

const stat = (label, value, sub) =>
  h('div', { class: 'stat' },
    h('dt', null, label),
    h('dd', null, h('span', { class: 'stat-value' }, value), sub ? h('span', { class: 'stat-sub' }, sub) : null),
  );

function tableRegion(id, caption, labels, head, body) {
  return h('div', { class: 'table-wrapper', tabindex: '0', role: 'region', 'aria-labelledby': id },
    h('table', { class: 'report-table', style: Object.fromEntries(labels.map((l, i) => [`--label-${i + 1}`, `"${l}"`])) },
      h('caption', { id }, caption),
      h('thead', null, h('tr', null, head)),
      h('tbody', null, body),
    ),
  );
}

function summaryTable(report) {
  const labels = ['Project / task', 'Hours', 'Decimal', 'Share'];
  return tableRegion('summary-caption', 'Hours by project and task', labels,
    labels.map((l, i) => h('th', { scope: 'col', class: i ? 'num' : null }, l)),
    report.projects.flatMap((p) => [
      h('tr', { class: 'project-row' },
        h('th', { scope: 'row' }, h('span', { class: 'swatch', style: { '--swatch': p.color }, 'aria-hidden': 'true' }), p.name),
        h('td', { class: 'num' }, formatHM(p.ms)),
        h('td', { class: 'num' }, formatDecimal(p.ms)),
        h('td', { class: 'num' }, share(p.ms, report.totalMs)),
      ),
      ...p.tasks.map((t) => h('tr', { class: 'task-row' },
        h('th', { scope: 'row' }, h('span', { class: 'visually-hidden' }, `${p.name} › `), t.name),
        h('td', { class: 'num' }, formatHM(t.ms)),
        h('td', { class: 'num' }, formatDecimal(t.ms)),
        h('td', { class: 'num' }, share(t.ms, report.totalMs)),
      )),
    ]),
  );
}

function entriesTable(report) {
  const labels = ['Date', 'Time', 'Project › Task', 'Description', 'Hours'];
  return tableRegion('entries-caption', 'All entries', labels,
    labels.map((l, i) => h('th', { scope: 'col', class: i === 4 ? 'num' : null }, l)),
    report.rows.map((e) => h('tr', null,
      h('th', { scope: 'row', class: 'nowrap' }, formatDate(e.day)),
      h('td', { class: 'nowrap' }, `${timeOf(e.start)}–${timeOf(e.end)}`),
      h('td', null, `${e.project} › ${e.task}`),
      h('td', { class: 'desc' }, e.description || '—'),
      h('td', { class: 'num' }, formatHM(e.ms)),
    )),
  );
}
