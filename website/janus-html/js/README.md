This folder contains ES module scripts used by the interview pages.

Load order:
- Dependencies (jQuery, Janus, etc.) must be included first in HTML.
- Then `js/main.js` is loaded with `type="module"`.
- `js/main.js` loads HTML partials via `js/includes.js` before initializing.
