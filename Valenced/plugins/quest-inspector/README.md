# Quest Inspector

A Valenced plugin that lists every quest Discord has for you (hidden ones too), shows where each one is available,
accepts them, and claims the reward when they finish. See the settings screen for the next step it recommends.

## Layout

Edit the files in `src/`, never `index.js` itself. Valenced loads one script, so `node build.js` joins `src/*.js`
(in file-name order) into `index.js` and fills in the version from `manifest.json`. Commit both, because the repo's
CI only zips what is committed. `src/` sections: header and settings defaults (VPN links are at the top), helpers,
quest details (tracker), country, live checks, regions, reading a quest, loading the list (and the saved copy that
fills the screen at start), recording and accepting, claiming and auto-accept, health check and report, Discord's own
Quests screen, the settings screen, then `start()`.

## Test

- `node build.js` rebuilds `index.js`; `node build.js --check` fails if it is out of date.
- `node test/unit.js` unit-tests the pure logic (regions, access, backoff, language, grouping, saved list, redaction).
- `node test/check.js` runs everything: the unit tests, the sync check, and the plugin against a mock Discord
  (no network, no phone): loading without the Quests screen, accepting, claiming once, auto-accept off by default
  and working when on, health rows, and no errors.

Bump `version` in `manifest.json` whenever the plugin changes (x.x.number; the middle number for bigger features),
or the repo build refuses to publish it. Then run `node build.js`, `python3 ../../build.py`, commit and push.
