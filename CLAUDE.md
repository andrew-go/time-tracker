# Project rules

- Vanilla HTML/CSS/JS ES modules, no build step, no framework. Hosted on GitHub Pages.
- **Use Google Chrome's Modern Web Guidance** (https://developer.chrome.com/docs/modern-web-guidance)
  for all HTML/CSS/client-side JS work. Before implementing a UI pattern or web API, search and
  retrieve the relevant guide:
  `npx -y modern-web-guidance@latest search "<2-5 word query>"` then
  `npx -y modern-web-guidance@latest retrieve "<id>"`.
  Claude Code users can install it as a plugin:
  `claude plugin marketplace add GoogleChrome/modern-web-guidance` and
  `claude plugin install modern-web-guidance@googlechrome`.
- **Browser support:** Baseline Widely available features are used freely. For anything newer, follow
  the guide's fallback (e.g. Temporal polyfill loaded only when missing, `closedby` light-dismiss fallback).
  Vendor fallbacks locally in `vendor/` so the app keeps working offline; never load from a CDN.
  The one exception is Google's sign-in library (`accounts.google.com/gsi/client`), which must be
  loaded from Google; it's loaded only when sync is connected.
- Never put user data into `innerHTML`; build DOM with `h()` from `js/ui.js`.
- Dates/times: use Temporal (`js/time.js`), not `Date` arithmetic. Store instants as epoch ms.
- All data mutations go through `js/store.js` so `updatedAt` / tombstones stay consistent for sync.
- Every deploy that changes app files must bump `VERSION` in `sw.js`, or installed copies keep serving the old cached version.
