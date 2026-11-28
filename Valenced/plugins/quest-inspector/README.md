# Quest Inspector

A Valenced plugin that lists every quest Discord has for you (hidden ones too), shows where each one is available,
accepts them, and claims the reward when they finish. See the settings screen for the next step it recommends.

## Layout

`index.js` is a single script (Valenced loads one file). It is split into labelled sections, in this order:
settings defaults, lazy `valenced` API access, country names, region list, quest details (tracker) and live checks,
describing a quest, loading the quest list, accepting and claiming, the settings screen, then `start()`.

## Test

`node test/check.js` runs the plugin against a mock Discord (no network, no phone) and checks the main flows:
loading without the Quests screen, accepting, claiming once, and no errors.
Bump `version` in `manifest.json` whenever `index.js` changes, or the repo build refuses to publish it.
