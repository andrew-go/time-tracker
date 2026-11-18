// Google sign-in (Google Identity Services token model) and the Drive REST calls
// used for sync.
//
// Scope: drive.appdata only. The app reads and writes one file in Drive's hidden
// "appDataFolder" and cannot see any of your other Drive files.
//
// Browser-only OAuth gives a short-lived access token (about 1 hour) and no
// refresh token. A new token needs a user gesture (a click), so sync.js renews it
// from the Sync button. The token lives only in memory, never in storage.

import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_NAME = 'time-tracker.json';

let gisPromise;
let tokenClient;
let pending; // { resolve, reject } for the in-flight token request
let token = null; // { value, expiresAt }

export const isConfigured = () => Boolean(GOOGLE_CLIENT_ID);
export const hasToken = () => token != null && Date.now() < token.expiresAt;

export class AuthError extends Error {}

/** Load Google's sign-in library. It must come from Google, so it is the one script not bundled locally. */
export function loadGis() {
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      gisPromise = undefined;
      reject(new Error('Couldn’t reach Google. Check your internet connection.'));
    };
    document.head.append(s);
  });
  return gisPromise;
}

const ERROR_TEXT = {
  popup_closed: 'The Google sign-in window was closed before finishing.',
  popup_failed_to_open: 'The Google sign-in window was blocked. Allow pop-ups for this site and try again.',
};

/**
 * Get an access token. Must be called from a click handler (opens a Google popup;
 * after the first consent it usually closes by itself).
 */
export async function requestToken({ hint } = {}) {
  await loadGis();
  const { oauth2 } = globalThis.google.accounts;
  tokenClient ??= oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) return pending?.reject(new Error(resp.error_description || resp.error));
      if (!oauth2.hasGrantedAllScopes(resp, SCOPE)) {
        return pending?.reject(new Error('Google Drive access wasn’t granted. Tick the Drive checkbox when connecting.'));
      }
      token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) - 60) * 1000 };
      pending?.resolve();
    },
    error_callback: (err) => pending?.reject(new Error(ERROR_TEXT[err?.type] ?? err?.message ?? 'Google sign-in failed.')),
  });
  pending?.reject(new Error('Superseded by a new sign-in request.'));
  const { promise, resolve, reject } = Promise.withResolvers();
  pending = { resolve, reject };
  tokenClient.requestAccessToken({ prompt: '', login_hint: hint });
  try {
    await promise;
  } finally {
    pending = undefined;
  }
}

export function signOut() {
  if (token && globalThis.google?.accounts?.oauth2) globalThis.google.accounts.oauth2.revoke(token.value, () => {});
  token = null;
}

async function api(url, init = {}) {
  if (!hasToken()) throw new AuthError('Google sign-in expired.');
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token.value}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    token = null;
    throw new AuthError('Google sign-in expired.');
  }
  if (!res.ok && res.status !== 404) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
    throw new Error(`Google Drive error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

export async function accountEmail() {
  try {
    const res = await api(`${DRIVE}/about?fields=user(emailAddress)`);
    return res.ok ? (await res.json()).user?.emailAddress ?? '' : '';
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return '';
  }
}

/** Id of the sync file in appDataFolder, or null if there isn't one yet. */
export async function findFile() {
  const q = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${FILE_NAME}' and trashed = false`,
    fields: 'files(id,modifiedTime)',
    orderBy: 'modifiedTime desc',
  });
  const res = await api(`${DRIVE}/files?${q}`);
  return (await res.json()).files?.[0]?.id ?? null;
}

/** File contents, or null if the file no longer exists. */
export async function readFile(id) {
  const res = await api(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media`);
  if (res.status === 404) return null;
  return res.json();
}

export async function createFile(content) {
  const boundary = `tt-${crypto.randomUUID()}`;
  const metadata = { name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');
  const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json()).id;
}

/** Returns false if the file is gone (so the caller can create a new one). */
export async function updateFile(id, content) {
  const res = await api(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: content,
  });
  return res.status !== 404;
}
