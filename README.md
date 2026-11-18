# Time Tracker

A simple personal time tracker that runs as an installable web app (PWA).
Projects → tasks → time entries with descriptions. Data lives on the device
(IndexedDB) and works offline. Monthly reports export to PDF and CSV. Data syncs between devices through a
hidden app folder in your Google Drive, and can be backed up to a JSON file.

## Run locally

No build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

The service worker (offline mode) only registers over HTTPS, so it is skipped
on localhost and active on GitHub Pages.

## Deploy to GitHub Pages

1. Create a repo named `time-tracker` and push this folder to `main`.
2. In the repo, go to **Settings → Pages**, set **Source: Deploy from a branch** and pick `main` / root.
3. The app will be at `https://<user>.github.io/time-tracker/`.
4. In Chrome or Edge, use the install icon in the address bar to install it as an app.

**On every deploy that changes app files, bump `VERSION` in `sw.js`** (and keep its `SHELL` list in sync). Open copies of the app then reload into the new version automatically.

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | App shell, navigation, shared dialogs |
| `css/app.css` | Styles: cascade layers, `light-dark()` tokens, container queries |
| `js/app.js` | Router and the Track / Entries / Projects views |
| `js/store.js` | Data model and all mutations (sync-ready records) |
| `js/db.js` | IndexedDB wrapper |
| `js/time.js` | Temporal-based date/duration helpers |
| `js/entry-dialog.js` | Add / edit time entry dialog |
| `js/reports.js` | Reports view and report data (month/range, project filter) |
| `js/export.js` | PDF (jsPDF + autotable) and CSV export, loaded on demand |
| `js/settings.js` | Settings view: sync, backup/restore, storage status |
| `js/sync.js` | Drive sync engine (merge, auto-sync, status) and backup files |
| `js/google.js` | Google sign-in (Identity Services token model) and Drive REST calls |
| `js/config.js` | Google OAuth Client ID (public by design) |
| `js/ui.js` | DOM helpers, confirm/name dialogs |
| `vendor/pdf.js` | jsPDF + jspdf-autotable bundle (MIT) |
| `vendor/fonts/` | Noto Sans subset (Latin + Cyrillic, OFL) for PDFs |
| `vendor/fonts/web/` | Golos Text + Unbounded, Latin + Cyrillic subsets (OFL) for the UI |
| `js/ribbon.js` | The day ribbon (24-hour strip with entries as blocks) |
| `vendor/temporal-polyfill.js` | Temporal polyfill, loaded only where `Temporal` is missing (Safari) |
| `sw.js` | Offline cache |

## Data model

Every record has `id`, `updatedAt`, and `deleted` (tombstone) so devices can be
merged record-by-record during sync.

- **project** `{ id, name, color, archived }`
- **task** `{ id, projectId, name, archived }`
- **entry** `{ id, taskId, description, start, end }`: `start`/`end` are epoch ms; `end` is `null` while the timer runs.

## Roadmap

1. ✅ Data layer, Track, Entries, Projects, offline PWA shell
2. ✅ Monthly reports + PDF / CSV export
3. ✅ Google Drive sync (`appDataFolder`) + JSON backup/restore
4. Install/offline polish, deploy

## Google Drive sync

- Scope `drive.appdata` only: one file, `time-tracker.json`, in Drive's hidden app folder.
- Each sync downloads it, merges record by record (newest `updatedAt` wins, tombstones keep
  deletions, ties broken deterministically), and uploads if Drive was missing anything.
  If timers were started on two devices, the newest keeps running and the older one is stopped.
- Browser-only OAuth gives a ~1 hour access token and no refresh token. While the token is valid
  the app syncs automatically (4 s after a change, every 5 minutes, when the app is hidden).
  After it expires, the **Sync** button in the header renews it with one click.
  The token is kept in memory only.
- OAuth client: Google Cloud project "Time Tracker", app in Testing mode with the owner as test
  user, authorized JavaScript origin `https://andrew-go.github.io`.

## Design: "Daylight"

The day is the organizing idea. A 24-hour ribbon shaded night → dawn → day → dusk shows
entries as blocks in their project color (large on Track, a thin strip on each day in
Entries). Everything else is quiet ink on paper. Type: Golos Text for the interface,
Unbounded for the clock and big numbers. Light and dark palettes are paired with
`light-dark()` tokens in `css/app.css`.
