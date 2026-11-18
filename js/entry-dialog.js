import * as store from './store.js';
import { dayOf, timeOf, toMs, today } from './time.js';
import { announce, fillDatalist, runDialog } from './ui.js';

const dialog = () => document.getElementById('entry-dialog');
const $ = (sel) => dialog().querySelector(sel);

function projectByName(name) {
  const n = name.trim().toLocaleLowerCase();
  return store.projects({ archived: true }).find((p) => p.name.toLocaleLowerCase() === n);
}

function refreshTaskSuggestions() {
  const p = projectByName($('#ef-project').value);
  fillDatalist($('#dl-entry-tasks'), p ? store.tasks(p.id).map((t) => t.name) : []);
}

const roundTo5 = (ms) => Math.floor(ms / 300_000) * 300_000;

/** Computes start/end in ms from the form, plus a validation message. */
function readTimes(isRunning) {
  const date = $('#ef-date').value;
  const startStr = $('#ef-start').value;
  const endStr = $('#ef-end').value;
  if (!date || !startStr) return { error: '' };
  const start = toMs(date, startStr);
  if (isRunning) {
    return start > Date.now()
      ? { error: 'A running timer can’t start in the future.' }
      : { start, end: null };
  }
  if (!endStr) return { error: '' };
  if (endStr === startStr) return { error: 'End time must be different from start time.' };
  // An end time earlier than the start means the entry runs past midnight.
  const nextDay = endStr < startStr;
  const endDate = nextDay ? Temporal.PlainDate.from(date).add({ days: 1 }).toString() : date;
  return { start, end: toMs(endDate, endStr), nextDay };
}

function validate(isRunning) {
  const { error = '', nextDay } = readTimes(isRunning);
  const field = isRunning ? $('#ef-start') : $('#ef-end');
  $('#ef-start').setCustomValidity('');
  $('#ef-end').setCustomValidity('');
  field.setCustomValidity(error);
  $('#ef-hint').textContent = isRunning
    ? 'Timer is running. Stop it to set the end time.'
    : error || (nextDay ? 'Ends the next day.' : '');
}

/** Open the add/edit dialog. Resolves true when something was saved. */
export async function openEntryDialog(existing = null) {
  const isRunning = existing != null && existing.end == null;
  const form = $('#entry-form');
  form.reset();

  $('#entry-dialog-title').textContent = existing ? 'Edit entry' : 'Add entry';
  if (existing) {
    const { project, task } = store.labelsOf(existing);
    $('#ef-project').value = project;
    $('#ef-task').value = task;
    $('#ef-description').value = existing.description ?? '';
    $('#ef-date').value = dayOf(existing.start).toString();
    $('#ef-start').value = timeOf(existing.start);
    $('#ef-end').value = isRunning ? '' : timeOf(existing.end);
  } else {
    const end = roundTo5(Date.now());
    $('#ef-date').value = today().toString();
    $('#ef-start').value = timeOf(end - 3_600_000);
    $('#ef-end').value = timeOf(end);
  }
  $('#ef-end').disabled = isRunning;
  $('#ef-end').required = !isRunning;
  refreshTaskSuggestions();
  validate(isRunning);

  const onProject = () => refreshTaskSuggestions();
  const onTime = () => validate(isRunning);
  $('#ef-project').addEventListener('input', onProject);
  form.addEventListener('input', onTime);
  const pending = runDialog(dialog()); // opens synchronously
  (existing ? $('#ef-description') : $('#ef-project')).focus();

  const result = await pending;
  $('#ef-project').removeEventListener('input', onProject);
  form.removeEventListener('input', onTime);
  if (result !== 'save') return false;

  const { start, end } = readTimes(isRunning);
  const t = await store.resolveTask($('#ef-project').value, $('#ef-task').value);
  await store.saveEntry({
    id: existing?.id,
    taskId: t.id,
    description: $('#ef-description').value,
    start,
    end: isRunning ? null : end,
  });
  announce(existing ? 'Entry updated' : 'Entry added');
  return true;
}
