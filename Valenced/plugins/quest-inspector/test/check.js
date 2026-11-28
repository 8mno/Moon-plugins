// Runs smoke.js (the plugin against a mock Discord, no network) and checks what it did.
//   node test/check.js
const { execFileSync } = require('child_process');
const path = require('path');
const out = execFileSync('node', [path.join(__dirname, 'smoke.js')], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
const unit = (() => { try { return { out: execFileSync('node', [path.join(__dirname, 'unit.js')], { encoding: 'utf8' }), ok: true }; } catch (e) { return { out: String(e.stdout || e.message), ok: false }; } })();
if (!unit.ok) console.log(unit.out);
const outAA = execFileSync('node', [path.join(__dirname, 'smoke.js')], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { QI_AUTOACCEPT: '1' }) });
const checks = [
  ['live checks stay within the per-run limit', (o) => { const m = /probed ids: (\d+)/.exec(o); return !!m && Number(m[1]) <= 8; }],
  ['auto-accept is off by default', (o) => !/toast QI_AUTO/.test(o)],
  ['auto-accept tries new quests when switched on', () => /toast QI_AUTO(FAIL)?_\d+/.test(outAA)],
  ['unit tests pass (node test/unit.js)', () => unit.ok],
  ['manifest version is in index.js', () => require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').includes("PLUGIN_VERSION = '" + require('../manifest.json').version + "'")],
  ['health check and report rows are shown', (o) => /Copy report/.test(o) && /Discord HTTP client/.test(o)],
  ['loads the quest list without Discord\'s Quests screen', /\d+ quests: \d+ available, \d+ hidden by client/],
  ['accepts hidden quests with location 12', /\/enroll \{"location":12,"metadata_sealed":"M1","traffic_metadata_sealed":"S1"\}|\/enroll \{"location":12/],
  ['claims a finished quest exactly once', (o) => (o.match(/toast QI_CLAIM_11111/g) || []).length === 1],
  ['shows the finished quest as ready to claim', /ready to claim/],
  ['index.js matches src/ (run node build.js)', () => require('../build.js').bundle() === require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')],
  ['has no plugin errors', (o) => !/^ERR /m.test(o)]
];
let bad = 0;
checks.forEach(([name, test]) => {
  const ok = typeof test === 'function' ? test(out) : test.test(out);
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) bad++;
});
process.exit(bad ? 1 : 0);
