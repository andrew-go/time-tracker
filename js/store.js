// In-memory model backed by IndexedDB.
//
// Every record carries `id`, `updatedAt` and (when removed) `deleted: true`.
// Records are never physically deleted: tombstones let the Google Drive sync
// (step 3) merge devices record-by-record without resurrecting deleted data.
//
// Shapes:
//   project { id, name, color, archived }
//   task    { id, projectId, name, archived }
//   entry   { id, taskId, description, start, end, planId? }   start/end = epoch ms, end null while running
//   plan    { id, taskId, description, day, time, estimate, done }
//           day 'YYYY-MM-DD' or null (someday), time 'HH:MM' or null, estimate minutes or null,
//           done epoch ms or null. Entries started from a plan carry its planId.
//   dayoff  { id, day, type, note }   id === day ('YYYY-MM-DD'), so two devices
//           marking the same day merge into one record. type: vacation | sick | holiday.

import * as db from './db.js';

const state = { projects: new Map(), tasks: new Map(), entries: new Map(), plans: new Map(), daysoff: new Map() };
export const events = new EventTarget();

const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('time-tracker') : null;

const PALETTE = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];

export async function load() {
  for (const name of db.STORES) {
    state[name].clear();
    for (const r of await db.getAll(name)) state[name].set(r.id, r);
  }
}

// Other open tabs/windows changed data: reload and re-render.
channel?.addEventListener('message', async () => {
  await load();
  events.dispatchEvent(new Event('change'));
});

const live = (map) => [...map.values()].filter((r) => !r.deleted);
const norm = (s) => s.trim().toLocaleLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

async function save(store, record) {
  const rec = { ...record, updatedAt: Date.now() };
  state[store].set(rec.id, rec);
  await db.put(store, rec);
  channel?.postMessage(store);
  events.dispatchEvent(new Event('change'));
  return rec;
}

// ---- Queries -------------------------------------------------------------

export const project = (id) => state.projects.get(id);
export const task = (id) => state.tasks.get(id);
export const entry = (id) => state.entries.get(id);

export function projects({ archived = false } = {}) {
  return live(state.projects).filter((p) => archived || !p.archived).toSorted(byName);
}

export function tasks(projectId, { archived = false } = {}) {
  return live(state.tasks)
    .filter((t) => t.projectId === projectId && (archived || !t.archived))
    .toSorted(byName);
}

/** Live entries, newest first. */
export function entries() {
  return live(state.entries).toSorted((a, b) => b.start - a.start);
}

export const running = () => live(state.entries).find((e) => e.end == null);

/** Project + task for an entry, tolerant of missing references. */
export function labelsOf(e) {
  const t = task(e.taskId);
  const p = t && project(t.projectId);
  return {
    project: p?.name ?? 'Unknown project',
    task: t?.name ?? 'Unknown task',
    color: p?.color ?? 'gray',
    projectId: p?.id,
  };
}

/** Distinct task + description pairs from recent entries, for one-click restart. */
export function recentCombos(limit = 8) {
  const seen = new Set();
  const out = [];
  for (const e of entries()) {
    const t = task(e.taskId);
    const p = t && project(t.projectId);
    if (!t || !p || t.archived || p.archived) continue;
    const key = `${e.taskId}\u0000${norm(e.description ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ taskId: e.taskId, description: e.description ?? '' });
    if (out.length === limit) break;
  }
  return out;
}

export function totalMs(list, now = Date.now()) {
  return list.reduce((sum, e) => sum + ((e.end ?? now) - e.start), 0);
}

// ---- Projects & tasks ----------------------------------------------------

export function createProject(name, color) {
  color ??= PALETTE[live(state.projects).length % PALETTE.length];
  return save('projects', { id: crypto.randomUUID(), name: name.trim(), color, archived: false });
}

export const updateProject = (id, patch) => save('projects', { ...project(id), ...patch });

export function createTask(projectId, name) {
  return save('tasks', { id: crypto.randomUUID(), projectId, name: name.trim(), archived: false });
}

export const updateTask = (id, patch) => save('tasks', { ...task(id), ...patch });

/** Reuse a project by name (case-insensitive), un-archiving it if needed. */
export async function findOrCreateProject(name) {
  const found = live(state.projects).find((p) => norm(p.name) === norm(name));
  if (!found) return createProject(name);
  return found.archived ? updateProject(found.id, { archived: false }) : found;
}

export async function findOrCreateTask(projectId, name) {
  const found = live(state.tasks).find((t) => t.projectId === projectId && norm(t.name) === norm(name));
  if (!found) return createTask(projectId, name);
  return found.archived ? updateTask(found.id, { archived: false }) : found;
}

/** Resolve typed project/task names into a task record, creating what's missing. */
export async function resolveTask(projectName, taskName) {
  const p = await findOrCreateProject(projectName);
  return findOrCreateTask(p.id, taskName);
}

export const nameTaken = (list, name, exceptId) =>
  list.some((r) => r.id !== exceptId && norm(r.name) === norm(name));

// ---- Time entries --------------------------------------------------------

export async function startTimer({ taskId, description = '', planId = null }) {
  const now = Date.now();
  const current = running();
  if (current) await save('entries', { ...current, end: now });
  const rec = { id: crypto.randomUUID(), taskId, description: description.trim(), start: now, end: null };
  if (planId) rec.planId = planId;
  return save('entries', rec);
}

export async function stopTimer() {
  const current = running();
  if (current) await save('entries', { ...current, end: Date.now() });
}

export function saveEntry({ id, taskId, description = '', start, end }) {
  const base = id ? entry(id) : { id: crypto.randomUUID() };
  return save('entries', { ...base, taskId, description: description.trim(), start, end });
}

export const removeEntry = (id) => save('entries', { ...entry(id), deleted: true });

// ---- Days off ---------------------------------------------------------------

export const DAY_OFF_TYPES = ['vacation', 'sick', 'holiday'];
/** The day-off record for 'YYYY-MM-DD', or undefined. */
export const dayOff = (day) => { const r = state.daysoff.get(day); return r && !r.deleted ? r : undefined; };
export const daysOff = () => live(state.daysoff).toSorted((a, b) => a.day.localeCompare(b.day));

/** Mark (or, with type null, unmark) a set of days in one go. */
export async function setDaysOff(days, type, note = '') {
  for (const day of days) {
    const cur = state.daysoff.get(day);
    if (type) await save('daysoff', { ...(cur ?? {}), id: day, day, type, note: note.trim(), deleted: false });
    else if (cur && !cur.deleted) await save('daysoff', { ...cur, deleted: true });
  }
}

// ---- Planned tasks ----------------------------------------------------------

export const plan = (id) => state.plans.get(id);

/** Live plans, by day (someday last), then time, then when they were added. */
export function plans() {
  const key = (p) => `${p.day ?? '9999-99-99'} ${p.time ?? '99:99'}`;
  return live(state.plans).toSorted((a, b) => key(a).localeCompare(key(b)) || (a.created ?? 0) - (b.created ?? 0));
}

export function savePlan({ id, taskId, description = '', day = null, time = null, estimate = null, done = null }) {
  const base = id ? plan(id) : { id: crypto.randomUUID(), created: Date.now() };
  return save('plans', { ...base, taskId, description: description.trim(), day, time, estimate, done });
}

export const setPlanDone = (id, done) => save('plans', { ...plan(id), done: done ? Date.now() : null });
export const movePlan = (id, day) => save('plans', { ...plan(id), day });
export const removePlan = (id) => save('plans', { ...plan(id), deleted: true });

/** Time tracked for a plan: entries started from it, plus same-task entries on its day. */
export function planEntries(p, dayOfEntry) {
  return live(state.entries).filter((e) => e.planId === p.id
    || (!e.planId && p.day && e.taskId === p.taskId && dayOfEntry(e.start) === p.day));
}

/**
 * Split one entry into consecutive parts: [{ taskId, description, start, end }].
 * The original record becomes one of the parts (the running one if the timer is
 * still going, otherwise the first), so sync sees an update plus new entries.
 */
export async function splitEntry(id, parts) {
  const original = entry(id);
  if (!original || parts.length < 2) return;
  const keep = original.end == null ? parts.length - 1 : 0;
  for (const [i, p] of parts.entries()) {
    const base = i === keep ? original : { id: crypto.randomUUID() };
    await save('entries', { ...base, taskId: p.taskId, description: p.description.trim(), start: p.start, end: p.end });
  }
}

// ---- Snapshots, merge (sync and backup) ----------------------------------

export const SNAPSHOT_FORMAT = 'time-tracker';

/**
 * For backup files (not Drive sync): point incoming projects and tasks at the
 * ones you already have with the same name, so restoring or importing a file
 * never creates a second "Docomotion". Returns a new snapshot; input untouched.
 */
export function alignByName(data) {
  const projectIds = new Map();
  const projects = data.projects.filter((p) => {
    if (p.deleted || state.projects.has(p.id) || typeof p.name !== 'string') return true;
    const mine = live(state.projects).find((x) => norm(x.name) === norm(p.name));
    if (!mine) return true;
    projectIds.set(p.id, mine.id);
    return false;
  });
  const taskIds = new Map();
  const tasks = data.tasks
    .map((t) => (projectIds.has(t.projectId) ? { ...t, projectId: projectIds.get(t.projectId) } : t))
    .filter((t) => {
      if (t.deleted || state.tasks.has(t.id) || typeof t.name !== 'string') return true;
      const mine = live(state.tasks).find((x) => x.projectId === t.projectId && norm(x.name) === norm(t.name));
      if (!mine) return true;
      taskIds.set(t.id, mine.id);
      return false;
    });
  const remap = (r) => (taskIds.has(r.taskId) ? { ...r, taskId: taskIds.get(r.taskId) } : r);
  const entries = data.entries.map(remap);
  return { ...data, projects, tasks, entries, ...(data.plans ? { plans: data.plans.map(remap) } : {}) };
}

/** Everything, including tombstones, as one JSON-serializable object. */
export function snapshot() {
  return {
    format: SNAPSHOT_FORMAT,
    version: 1,
    exportedAt: Date.now(),
    ...Object.fromEntries(db.STORES.map((name) => [name, [...state[name].values()]])),
  };
}

const isRecord = (r) => r && typeof r.id === 'string' && Number.isFinite(r.updatedAt);
const VALID = {
  projects: (r) => isRecord(r) && typeof r.name === 'string',
  tasks: (r) => isRecord(r) && typeof r.name === 'string' && typeof r.projectId === 'string',
  entries: (r) => isRecord(r) && typeof r.taskId === 'string' && Number.isFinite(r.start) && (r.end == null || Number.isFinite(r.end)),
  daysoff: (r) => isRecord(r) && typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day)
    && r.id === r.day && (r.deleted || ['vacation', 'sick', 'holiday'].includes(r.type)),
  plans: (r) => isRecord(r) && typeof r.taskId === 'string'
    && (r.day == null || /^\d{4}-\d{2}-\d{2}$/.test(r.day)) && (r.time == null || /^\d{2}:\d{2}$/.test(r.time)),
};

/** Last write wins; ties broken deterministically so every device picks the same record. */
const wins = (a, b) =>
  a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && JSON.stringify(a) > JSON.stringify(b));

export function isSnapshot(data) {
  return data?.format === SNAPSHOT_FORMAT && db.CORE_STORES.every((name) => Array.isArray(data[name]))
    && db.STORES.every((name) => data[name] == null || Array.isArray(data[name]));
}

/**
 * Merge another snapshot (from Drive or a backup file) into local data,
 * record by record. Incoming records are stored as-is (their updatedAt is kept).
 * Returns how many local records changed and whether the other side is missing
 * anything we have (so it needs an upload).
 */
export async function mergeSnapshot(other) {
  if (!isSnapshot(other)) throw new Error('This isn’t a Time Tracker data file.');
  let localChanged = 0;
  let otherBehind = false;

  for (const name of db.STORES) {
    const theirs = new Map((other[name] ?? []).filter(VALID[name]).map((r) => [r.id, r]));
    const incoming = [];
    for (const r of theirs.values()) {
      const mine = state[name].get(r.id);
      if (!mine || wins(r, mine)) incoming.push(r);
      else if (wins(mine, r)) otherBehind = true;
    }
    for (const id of state[name].keys()) if (!theirs.has(id)) otherBehind = true;
    if (incoming.length) {
      await db.putMany(name, incoming);
      for (const r of incoming) state[name].set(r.id, r);
      localChanged += incoming.length;
    }
  }

  // Timers started on two devices: keep the newest running, stop the others when it started.
  const runningNow = live(state.entries).filter((e) => e.end == null).toSorted((a, b) => b.start - a.start);
  for (const old of runningNow.slice(1)) {
    const fixed = { ...old, end: Math.max(old.start, runningNow[0].start), updatedAt: Date.now() };
    state.entries.set(fixed.id, fixed);
    await db.put('entries', fixed);
    localChanged += 1;
    otherBehind = true;
  }

  if (localChanged) {
    channel?.postMessage('merge');
    events.dispatchEvent(new Event('change'));
  }
  return { localChanged, otherBehind };
}

/** Has anything changed locally since `since` (epoch ms)? */
export function changedSince(since) {
  return db.STORES.some((name) => [...state[name].values()].some((r) => r.updatedAt > since));
}

export const counts = () => ({
  projects: live(state.projects).length,
  tasks: live(state.tasks).length,
  entries: live(state.entries).length,
  plans: live(state.plans).length,
  daysoff: live(state.daysoff).length,
});
