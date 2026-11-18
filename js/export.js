// Report export. Loaded on demand, so jsPDF (~145 KB gzipped) and the fonts
// only download the first time you export.

import { reportFileName, share } from './reports.js';
import { formatDate, formatDecimal, formatHM, timeOf, today } from './time.js';
import { downloadBlob } from './ui.js';

// ---- CSV -----------------------------------------------------------------

// Cells starting with these could run as formulas in Excel / Sheets.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  let s = String(value ?? '');
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(report) {
  const header = ['Date', 'Start', 'End', 'Project', 'Task', 'Description', 'Duration (h:mm)', 'Hours'];
  const lines = report.rows.map((e) => [
    e.day.toString(), timeOf(e.start), timeOf(e.end), e.project, e.task,
    e.description ?? '', formatHM(e.ms), formatDecimal(e.ms),
  ]);
  lines.push(['Total', '', '', '', '', '', formatHM(report.totalMs), formatDecimal(report.totalMs)]);
  return [header, ...lines].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function exportCsv(report) {
  // BOM so Excel opens UTF-8 (Cyrillic etc.) correctly.
  downloadBlob(new Blob(['﻿', toCsv(report)], { type: 'text/csv;charset=utf-8' }), reportFileName(report, 'csv'));
}

// ---- PDF -----------------------------------------------------------------

const FONT = 'NotoSans';
let libs;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function loadLibs() {
  libs ??= (async () => {
    const fontUrl = (name) => new URL(`../vendor/fonts/${name}`, import.meta.url);
    const fetchFont = async (name) => {
      const res = await fetch(fontUrl(name));
      if (!res.ok) throw new Error(`Font ${name} failed to load (${res.status})`);
      return toBase64(await res.arrayBuffer());
    };
    const [{ jsPDF, autoTable }, regular, bold] = await Promise.all([
      import('../vendor/pdf.js'),
      fetchFont('NotoSans-Regular.ttf'),
      fetchFont('NotoSans-Bold.ttf'),
    ]);
    return { jsPDF, autoTable, regular, bold };
  })();
  try {
    return await libs;
  } catch (err) {
    libs = undefined; // allow a retry, e.g. after coming back online
    throw err;
  }
}

const hexToRgb = (hex) => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex ?? '');
  return m ? m.slice(1).map((x) => parseInt(x, 16)) : [128, 128, 128];
};

export async function buildPdf(report) {
  const { jsPDF, autoTable, regular, bold } = await loadLibs();
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.addFileToVFS('NotoSans-Regular.ttf', regular);
  doc.addFont('NotoSans-Regular.ttf', FONT, 'normal');
  doc.addFileToVFS('NotoSans-Bold.ttf', bold);
  doc.addFont('NotoSans-Bold.ttf', FONT, 'bold');

  const margin = 40;
  const ink = [28, 31, 37];
  const muted = [90, 96, 108];
  const accent = [15, 118, 110];
  doc.setProperties({ title: `Time report – ${report.title}`, creator: 'Time Tracker' });

  // Header
  doc.setFont(FONT, 'bold').setFontSize(20).setTextColor(...ink);
  doc.text('Time report', margin, 56);
  doc.setFont(FONT, 'normal').setFontSize(12).setTextColor(...muted);
  doc.text(report.filterName ? `${report.title} · ${report.filterName}` : report.title, margin, 76);
  doc.setFontSize(9);
  doc.text(`Generated ${formatDate(today())}`, doc.internal.pageSize.getWidth() - margin, 56, { align: 'right' });

  // Totals line
  doc.setFont(FONT, 'bold').setFontSize(12).setTextColor(...ink);
  doc.text(`Total: ${formatHM(report.totalMs)} (${formatDecimal(report.totalMs)} h)`, margin, 104);
  doc.setFont(FONT, 'normal').setFontSize(10).setTextColor(...muted);
  doc.text(`${report.rows.length} entries · ${report.days} days tracked`, margin, 120);

  const base = {
    margin: { left: margin, right: margin, bottom: 50 },
    styles: { font: FONT, fontSize: 9, cellPadding: 5, textColor: ink, lineColor: [220, 223, 228], lineWidth: 0.5 },
    headStyles: { font: FONT, fontStyle: 'bold', fillColor: accent, textColor: 255 },
    theme: 'grid',
  };

  // Summary by project / task
  const summaryBody = report.projects.flatMap((p) => [
    { cells: [p.name, formatHM(p.ms), formatDecimal(p.ms), share(p.ms, report.totalMs)], project: p },
    ...p.tasks.map((t) => ({ cells: [`    ${t.name}`, formatHM(t.ms), formatDecimal(t.ms), share(t.ms, report.totalMs)] })),
  ]);
  autoTable(doc, {
    ...base,
    startY: 136,
    head: [['Project / task', 'Hours', 'Decimal', 'Share']],
    body: summaryBody.map((r) => r.cells),
    foot: [['Total', formatHM(report.totalMs), formatDecimal(report.totalMs), '100%']],
    footStyles: { font: FONT, fontStyle: 'bold', fillColor: [236, 238, 242], textColor: ink },
    columnStyles: { 1: { halign: 'right', cellWidth: 60 }, 2: { halign: 'right', cellWidth: 60 }, 3: { halign: 'right', cellWidth: 50 } },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const row = summaryBody[data.row.index];
      if (row.project) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [246, 247, 249];
      }
    },
    didDrawCell: (data) => {
      // Project color marker in the first column
      const row = data.section === 'body' && summaryBody[data.row.index];
      if (row?.project && data.column.index === 0) {
        doc.setFillColor(...hexToRgb(row.project.color));
        doc.rect(data.cell.x, data.cell.y, 3, data.cell.height, 'F');
      }
    },
  });

  // Entries
  doc.setFont(FONT, 'bold').setFontSize(12).setTextColor(...ink);
  let y = doc.lastAutoTable.finalY + 32;
  if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = 56; }
  doc.text('Entries', margin, y);
  autoTable(doc, {
    ...base,
    startY: y + 10,
    head: [['Date', 'Time', 'Project › Task', 'Description', 'Hours']],
    body: report.rows.map((e) => [
      formatDate(e.day),
      `${timeOf(e.start)}–${timeOf(e.end)}`,
      `${e.project} › ${e.task}`,
      e.description || '',
      formatHM(e.ms),
    ]),
    columnStyles: {
      0: { cellWidth: 70 },
      1: { cellWidth: 70 },
      2: { cellWidth: 140 },
      4: { halign: 'right', cellWidth: 45 },
    },
  });

  // Page numbers
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont(FONT, 'normal').setFontSize(8).setTextColor(...muted);
    doc.text(`Page ${i} of ${pages}`, doc.internal.pageSize.getWidth() - margin, doc.internal.pageSize.getHeight() - 24, { align: 'right' });
  }
  return doc;
}

export async function exportPdf(report) {
  const doc = await buildPdf(report);
  downloadBlob(doc.output('blob'), reportFileName(report, 'pdf'));
}
