# Valenced plugins

Each folder in `plugins/` is one plugin (`manifest.json` + `index.js`, optional `assets/`).
`build.py` zips them into `pool/` and writes `index.json`. GitHub Actions runs it on every push.

## Setup (once)
1. Put this repo on GitHub (any name). The repo root holds the `Valenced/` folder and `.github/`.
2. Settings > Pages > Deploy from branch `main`, folder `/ (root)`.
3. Settings > Actions > General > Workflow permissions: Read and write.
4. Add this URL in Valenced as a repository:
   `https://<username>.github.io/<repo>/Valenced/index.json`

## Add a plugin
Create `Valenced/plugins/<name>/manifest.json` + `index.js`, push. Done.

## Release an update
Bump `"version"` in that plugin's `manifest.json`, push. A published version can't be changed,
so the build fails if you edit a plugin without bumping its version.

## Build locally
`python3 Valenced/build.py https://<username>.github.io/<repo>/Valenced`
