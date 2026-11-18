import * as store from './store.js';
import * as sync from './sync.js';
import { dayOf, formatDate, timeOf, today } from './time.js';
import { announce, confirmDialog, downloadBlob, h } from './ui.js';

const plural = new Intl.PluralRules('en');
const count = (n, one, many) => `${n} ${plural.select(n) === 'one' ? one : many}`;

export function formatSyncedAt(ms) {
  if (!ms) return 'never';
  const day = dayOf(ms);
  return day.equals(today()) ? `today at ${timeOf(ms)}` : `${formatDate(day)} at ${timeOf(ms)}`;
}

export function renderSettings() {
  return h('div', { class: 'stack' },
    h('h1', { class: 'view-title' }, 'Settings'),
    syncSection(),
    backupSection(),
    storageSection(),
  );
}

function syncSection() {
  const s = sync.state();
  const body = [];

  if (!s.configured) {
    body.push(h('p', null, 'Sync isn’t set up yet: the app needs a Google OAuth Client ID in ', h('code', null, 'js/config.js'), '.'));
  } else if (!s.connected) {
    body.push(
      h('p', null, 'Keep a copy of your data in your Google Drive and use the app on several devices.'),
      h('p', { class: 'hint' }, 'The app only gets access to its own hidden folder in your Drive. It can’t see or change any of your other files.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'primary', id: 'connect-btn', disabled: s.status === 'syncing', onclick: async () => {
          try {
            await sync.connect();
            announce('Google Drive connected');
          } catch (err) {
            announce(err.message);
          }
        } }, s.status === 'syncing' ? 'Connecting…' : 'Connect Google Drive'),
      ),
    );
  } else {
    body.push(
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, 'Account'), h('dd', null, s.email || 'Google account')),
        h('div', null, h('dt', null, 'Last synced'), h('dd', null, formatSyncedAt(s.lastSyncAt))),
        h('div', null, h('dt', null, 'Status'), h('dd', { id: 'sync-status-text' }, statusText(s))),
      ),
      s.status === 'error' ? h('p', { class: 'error-text', role: 'alert' }, '⚠ ', s.error) : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'primary', id: 'sync-now-btn', disabled: s.status === 'syncing',
          onclick: () => sync.syncNow({ interactive: true }) }, s.status === 'syncing' ? 'Syncing…' : 'Sync now'),
        h('button', { type: 'button', id: 'disconnect-btn', onclick: async () => {
          const ok = await confirmDialog({
            title: 'Disconnect Google Drive?',
            message: 'This device stops syncing. Your data stays on this device and in Google Drive.',
            confirmLabel: 'Disconnect',
          });
          if (ok) { await sync.disconnect(); announce('Google Drive disconnected'); }
        } }, 'Disconnect'),
      ),
      h('p', { class: 'hint' },
        'Google keeps the connection for about an hour at a time. After that, press ', h('strong', null, 'Sync'),
        ' at the top to continue. A Google window may flash briefly.'),
    );
  }

  return h('section', { class: 'card stack-sm', 'aria-labelledby': 'sync-title' },
    h('h2', { id: 'sync-title' }, 'Google Drive sync'),
    body,
  );
}

function statusText(s) {
  switch (s.status) {
    case 'syncing': return 'Syncing…';
    case 'needs-auth': return s.unsynced ? 'Changes waiting. Press Sync to continue.' : 'Paused. Press Sync to continue.';
    case 'error': return 'Last sync failed';
    default: return s.unsynced ? 'Changes waiting to sync' : 'Up to date';
  }
}

function backupSection() {
  const download = () => {
    downloadBlob(sync.backupBlob(), `time-tracker-backup-${today()}.json`);
    announce('Backup downloaded');
  };

  const restore = async (e) => {
    e.preventDefault();
    const input = e.target.elements.file;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { data, summary } = await sync.readBackup(file);
      const ok = await confirmDialog({
        title: 'Restore this backup?',
        message: `It has ${count(summary.projects, 'project', 'projects')}, ${count(summary.tasks, 'task', 'tasks')} and ${count(summary.entries, 'entry', 'entries')}` +
          `${summary.exportedAt ? ` (saved ${formatSyncedAt(summary.exportedAt)})` : ''}. ` +
          'It is merged with what’s on this device: for anything in both, the most recently changed version is kept. Nothing else is removed.',
        confirmLabel: 'Restore',
      });
      if (!ok) return;
      const { localChanged } = await sync.restoreBackup(data);
      announce(localChanged ? `Restored ${localChanged} records` : 'Nothing new in this backup');
      input.value = '';
    } catch (err) {
      input.setCustomValidity(err.message);
      input.reportValidity();
    }
  };

  const c = store.counts();
  return h('section', { class: 'card stack-sm', 'aria-labelledby': 'backup-title' },
    h('h2', { id: 'backup-title' }, 'Backup'),
    h('p', null, `This device has ${count(c.projects, 'project', 'projects')}, ${count(c.tasks, 'task', 'tasks')} and ${count(c.entries, 'entry', 'entries')}.`),
    h('div', { class: 'actions' },
      h('button', { type: 'button', id: 'backup-btn', onclick: download }, 'Download backup'),
    ),
    h('form', { class: 'stack-sm', 'aria-labelledby': 'restore-label', onsubmit: restore },
      h('div', { class: 'field' },
        h('label', { id: 'restore-label', for: 'restore-file' }, 'Restore from a backup file'),
        h('input', { id: 'restore-file', name: 'file', type: 'file', accept: '.json,application/json', required: true,
          'aria-describedby': 'restore-help', onchange: (e) => e.target.setCustomValidity('') }),
        h('p', { id: 'restore-help', class: 'hint' }, 'A .json file made with “Download backup”. You’ll see what’s in it before anything changes.'),
      ),
      h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Restore…')),
    ),
  );
}

function storageSection() {
  const out = h('dd', null, 'Checking…');
  navigator.storage?.persisted?.().then((p) => {
    out.textContent = p ? 'Protected: the browser won’t clear it to free space' : 'Not protected: the browser may clear it if space runs low. Install the app or turn on sync.';
  }) ?? (out.textContent = 'Unknown');
  return h('section', { class: 'card stack-sm', 'aria-labelledby': 'storage-title' },
    h('h2', { id: 'storage-title' }, 'Storage on this device'),
    h('dl', { class: 'facts' }, h('div', null, h('dt', null, 'Local data'), out)),
  );
}
