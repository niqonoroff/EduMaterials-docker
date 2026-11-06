# Vendored libraries

These files are pre-bundled ES modules so the site works on GitHub Pages without a build step or a CDN.

- `firebase.js` — Firebase JS SDK 13.2.0 (`firebase/app` + `firebase/database`), Apache-2.0.
  Source: https://github.com/firebase/firebase-js-sdk
- `yjs.js` — Yjs 13.6.33, MIT. License: `LICENSE-yjs.txt`.
  Source: https://github.com/yjs/yjs

Both bundles were produced with esbuild (`--bundle --format=esm --minify`).
