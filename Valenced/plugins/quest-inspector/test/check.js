// Runs smoke.js (the plugin against a mock Discord, no network) and checks what it did.
//   node test/check.js
const { execFileSync } = require('child_process');
const path = require('path');
const out = execFileSync('node', [path.join(__dirname, 'smoke.js')], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
const checks = [
  ['loads the quest list without Discord\'s Quests screen', /\d+ quests: \d+ available, \d+ hidden by client/],
  ['accepts hidden quests with location 12', /\/enroll \{"location":12,"metadata_sealed":"M1","traffic_metadata_sealed":"S1"\}|\/enroll \{"location":12/],
  ['claims a finished quest exactly once', (o) => (o.match(/toast QI_CLAIM_11111/g) || []).length === 1],
  ['shows the finished quest as ready to claim', /ready to claim/],
  ['has no plugin errors', (o) => !/^ERR /m.test(o)]
];
let bad = 0;
checks.forEach(([name, test]) => {
  const ok = typeof test === 'function' ? test(out) : test.test(out);
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) bad++;
});
process.exit(bad ? 1 : 0);
