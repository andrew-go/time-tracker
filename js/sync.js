// Google Drive sync + JSON backup.
//
// One JSON snapshot lives in Drive's appDataFolder. A sync downloads it, merges
// it into local data record by record (newest updatedAt wins, tombstones keep
// deletions), and uploads the merged result if Drive was missing anything.
// Every device keeps a full local copy, so sync is never needed to use the app.

import * as db from './db.js';
import * as google from './google.js';
import * as store from './store.js';

const AUTO_DELAY = 4_000; // after a change
const PERIODIC = 5 * 60_000;

export const events = new EventTarget();

let meta = {}; // persisted: { connected, email, fileId, lastSyncAt }
let status = 'off'; // off | idle | syncing | needs-auth | error
let error = '';
let running = null;
let again = false;
let merging = false;
let timer;

const setStatus = (s, err = '') => {
  status = s;
  error = err;
  events.dispatchEvent(new Event('change'));
};

const saveMeta = (patch) => {
  meta = { ...meta, ...patch };
  return db.setMeta('sync', meta);
};

export const state = () => ({
  status,
  error,
  configured: google.isConfigured(),
  connected: Boolean(meta.connected),
  email: meta.email ?? '',
  lastSyncAt: meta.lastSyncAt ?? 0,
  unsynced: Boolean(meta.connected) && store.changedSince(meta.lastSyncAt ?? 0),
});

export async function initSync() {
  meta = (await db.getMeta('sync')) ?? {};

  store.events.addEventListener('change', () => {
    if (!meta.connected || merging) return;
    events.dispatchEvent(new Event('change')); // "unsynced" indicator
    schedule(AUTO_DELAY);
  });
  setInterval(() => { if (meta.connected && google.hasToken()) syncNow(); }, PERIODIC);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && meta.connected && google.hasToken() && state().unsynced) syncNow();
  });

  if (!meta.connected || !google.isConfigured()) return setStatus('off');
  setStatus('needs-auth');
  // Preload Google's library so the Sync click can open the popup immediately.
  google.loadGis().catch(() => {});
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (google.hasToken()) syncNow();
    else if (status !== 'needs-auth') setStatus('needs-auth');
  }, delay);
}

/** First-time connection. Call from a click. */
export async function connect() {
  setStatus('syncing');
  try {
    await google.requestToken();
    await saveMeta({ connected: true, email: await google.accountEmail() });
    await syncNow();
  } catch (err) {
    setStatus(meta.connected ? 'error' : 'off', err.message);
    throw err;
  }
}

export async function disconnect() {
  google.signOut();
  meta = {};
  await db.setMeta('sync', meta);
  setStatus('off');
}

/**
 * Sync now. With `interactive` (from a click), renews the Google sign-in if it
 * expired. Concurrent calls coalesce into one extra run.
 */
export async function syncNow({ interactive = false } = {}) {
  if (!meta.connected) return;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setStatus('syncing');
    try {
      if (!google.hasToken()) {
        if (!interactive) return setStatus('needs-auth');
        await google.requestToken({ hint: meta.email || undefined });
      }
      do {
        again = false;
        await syncOnce();
      } while (again);
      setStatus('idle');
    } catch (err) {
      if (err instanceof google.AuthError) setStatus('needs-auth');
      else {
        console.error(err);
        setStatus('error', err.message);
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce() {
  const startedAt = Date.now();
  let fileId = meta.fileId ?? (await google.findFile());
  let remote = fileId ? await google.readFile(fileId) : null;
  if (fileId && remote === null) {
    // File was removed (e.g. Drive app data cleared): look again, else start fresh.
    fileId = await google.findFile();
    remote = fileId ? await google.readFile(fileId) : null;
  }

  let otherBehind = true;
  if (remote) {
    merging = true;
    try {
      ({ otherBehind } = await store.mergeSnapshot(remote));
    } finally {
      merging = false;
    }
  }

  if (otherBehind || !fileId) {
    const content = JSON.stringify(store.snapshot());
    if (!fileId || !(await google.updateFile(fileId, content))) fileId = await google.createFile(content);
  }
  await saveMeta({ fileId, lastSyncAt: startedAt });
}

// ---- Backup file ---------------------------------------------------------

export function backupBlob() {
  return new Blob([JSON.stringify(store.snapshot(), null, 1)], { type: 'application/json' });
}

/** Parse and summarize a backup file before merging it. */
export async function readBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('This file isn’t valid JSON.');
  }
  if (!store.isSnapshot(data)) throw new Error('This isn’t a Time Tracker backup file.');
  const live = (list) => list.filter((r) => !r.deleted).length;
  return {
    data,
    summary: { projects: live(data.projects), tasks: live(data.tasks), entries: live(data.entries), exportedAt: data.exportedAt },
  };
}

export const restoreBackup = (data) => store.mergeSnapshot(data);
