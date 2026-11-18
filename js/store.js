// In-memory model backed by IndexedDB.
//
// Every record carries `id`, `updatedAt` and (when removed) `deleted: true`.
// Records are never physically deleted: tombstones let the Google Drive sync
// (step 3) merge devices record-by-record without resurrecting deleted data.
//
// Shapes:
//   project { id, name, color, archived }
//   task    { id, projectId, name, archived }
//   entry   { id, taskId, description, start, end }   start/end = epoch ms, end null while running

import * as db from './db.js';

const state = { projects: new Map(), tasks: new Map(), entries: new Map() };
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

export async function startTimer({ taskId, description = '' }) {
  const now = Date.now();
  const current = running();
  if (current) await save('entries', { ...current, end: now });
  return save('entries', { id: crypto.randomUUID(), taskId, description: description.trim(), start: now, end: null });
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
