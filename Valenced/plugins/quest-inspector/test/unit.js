// Unit tests for the pure logic. No network, no Discord.   node test/unit.js
const fs = require('fs'), path = require('path'), assert = require('assert');
globalThis.__QI_TEST__ = true;
const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => deep() });
const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
// the script's own exports object is the one the hook is put on, so hand it ours
new Function('valenced', 'plugin', src.replace('})({});', '})(globalThis.__EXP = {});'))(deep(), (o) => o);
const exp = globalThis.__EXP;

const t = exp.__test; assert(t, 'test hook missing');
let bad = 0;
function test(name, fn) { try { fn(); console.log('PASS ' + name); } catch (e) { bad++; console.log('FAIL ' + name + ': ' + e.message); } }
const ID1 = '1400000000000000001', ID2 = '1400000000000000002', ID3 = '1400000000000000003';

test('parseRegions reads include/exclude/global/age gate/replacement', () => {
  const m = t.parseRegions({ quests: [
    { id: ID1, is_global: false, show_age_gate: true, regions: { include: ['US', 'UK'], exclude: [] } },
    { id: ID2, is_global: true, regions: { include: [], exclude: ['CN'] }, replacement_id: ID3 },
    { id: '__proto__', is_global: true }, { id: 'abc' }, { id: 5 }] });
  assert.deepStrictEqual(Object.keys(m).sort(), [ID1, ID2]);
  assert.deepStrictEqual(m[ID1], { g: false, i: ['US', 'UK'], e: [], a: true, r: '' });
  assert.strictEqual(m[ID2].g, true); assert.strictEqual(m[ID2].r, ID3); assert.deepStrictEqual(m[ID2].e, ['CN']);
});
test('parseRegions rejects junk', () => {
  assert.strictEqual(t.parseRegions(null), null);
  assert.strictEqual(t.parseRegions({ quests: [] }), null);
  assert.strictEqual(t.parseRegions({ quests: [{ id: 'x' }] }), null);
});
test('parseRegions accepts an array as the include list', () => {
  const m = t.parseRegions({ quests: [{ id: ID1, regions: ['IQ'] }] });
  assert.deepStrictEqual(m[ID1].i, ['IQ']);
});
test('inferRegion intersects include lists and drops excludes', () => {
  t.setRegions({ [ID1]: { g: false, i: ['US', 'IQ', 'DE'], e: [], a: false, r: '' }, [ID2]: { g: false, i: ['IQ', 'DE', 'FR'], e: ['DE'], a: false, r: '' } });
  const r = t.inferRegion([{ id: ID1, hidden: false, status: 'available' }, { id: ID2, hidden: false, status: 'available' }]);
  assert.deepStrictEqual(r.codes, ['IQ']);
});
test('inferRegion ignores hidden or non-available quests and answers unknown on conflict', () => {
  t.setRegions({ [ID1]: { g: false, i: ['US'], e: [], a: false, r: '' }, [ID2]: { g: false, i: ['IQ'], e: [], a: false, r: '' } });
  assert.deepStrictEqual(t.inferRegion([{ id: ID1, hidden: true, status: 'available' }]).codes, []);
  assert.deepStrictEqual(t.inferRegion([{ id: ID1, hidden: false, status: 'expired' }]).codes, []);
  assert.deepStrictEqual(t.inferRegion([{ id: ID1, hidden: false, status: 'available' }, { id: ID2, hidden: false, status: 'available' }]).codes, []);
});
test('access: yes / no / maybe / unknown', () => {
  t.setRegions({ [ID1]: { g: false, i: ['US'], e: [], a: false, r: '' }, [ID2]: { g: true, i: [], e: [], a: false, r: '' }, [ID3]: { g: false, i: [], e: [], a: false, r: '' } });
  t.setLearned({});
  t.setUser(['US']); assert.strictEqual(t.access(ID1), 'yes'); assert.strictEqual(t.access(ID2), 'yes');
  t.setUser(['IQ']); assert.strictEqual(t.access(ID1), 'no');
  t.setUser(['US', 'IQ']); assert.strictEqual(t.access(ID1), 'maybe');
  t.setUser(['IQ']); assert.strictEqual(t.access(ID3), 'unknown');
  t.setUser([]); assert.strictEqual(t.access(ID1), 'unknown');
  assert.strictEqual(t.access('999'), 'unknown');
});
test('access uses learned countries when the list says nothing', () => {
  t.setRegions({}); t.setLearned({ [ID1]: { y: ['IQ'], n: ['US'] } });
  t.setUser(['IQ']); assert.strictEqual(t.access(ID1), 'yes');
  t.setUser(['US']); assert.strictEqual(t.access(ID1), 'no');
});
test('rateLimited ignores non-429 and honours retry_after', () => {
  t.reset();
  assert.strictEqual(t.rateLimited({ status: 500 }), false); assert.strictEqual(t.rateLimited(null), false);
  const before = Date.now();
  assert.strictEqual(t.rateLimited({ status: 429, body: { retry_after: 60 } }), true);
  const wait = t.state().backoffUntil - before;
  assert(wait >= 62000 && wait <= 62000 + 6000, 'wait ' + wait);
});
test('rateLimited backs off 5 min, doubles, and is capped at 1 hour', () => {
  t.reset();
  const waits = [];
  for (let i = 0; i < 7; i++) { const b = Date.now(); t.rateLimited({ status: 429 }); waits.push(t.state().backoffUntil - b); }
  assert(waits[0] >= 300000 && waits[0] < 306000, String(waits[0]));
  assert(waits[1] >= 600000 && waits[1] < 606000, String(waits[1]));
  assert(waits[2] >= 1200000, String(waits[2]));
  assert(waits[6] <= 3600000 + 6000, String(waits[6]));
  t.reset();
  t.rateLimited({ status: 429, body: { retry_after: 1 } });
  assert(t.state().backoffUntil - Date.now() >= 29000, 'minimum 30s');
});
test('guessLanguage', () => {
  assert.strictEqual(t.guessLanguage(''), null);
  assert.strictEqual(t.guessLanguage('plain english text'), null);
  const jp = t.guessLanguage('クエスト'); assert(jp && jp.lang && jp.codes.length);
  const ar = t.guessLanguage('مهمة'); assert(ar && ar.lang === 'Arabic' && ar.codes.length === 0);
});
test('cname / flag', () => {
  assert.strictEqual(t.cname('IQ'), 'Iraq'); assert.strictEqual(t.cname('uk'), 'United Kingdom'); assert.strictEqual(t.cname('ZZ'), 'ZZ');
  assert.strictEqual(t.flag('US'), '🇺🇸'); assert.strictEqual(t.flag('UK', true), '🇬🇧 United Kingdom');
  assert.strictEqual(t.flag('???'), '???');
});
test('describe: name, reward, progress, claimable', () => {
  const q = { id: ID1, config: { expiresAt: new Date(Date.now() + 3600000).toISOString(), messages: { questName: 'Quest A' }, taskConfigV2: { tasks: { WATCH_VIDEO: { target: 600 } } }, rewardsConfig: { rewards: [{ orbQuantity: 700 }] }, application: { name: 'Game' } }, userStatus: { enrolledAt: 'x', progress: { WATCH_VIDEO: { value: 300 } } } };
  const d = t.describe(q);
  assert.strictEqual(d.name, 'Quest A'); assert.strictEqual(d.reward, '700 orbs'); assert.strictEqual(d.app, 'Game');
  assert.strictEqual(d.progress, 50); assert.strictEqual(d.status, 'enrolled'); assert(d.taskText[0].includes('5/10 min'), d.taskText[0]);
  q.userStatus.progress.WATCH_VIDEO.value = 600; q.userStatus.completedAt = 'y';
  const d2 = t.describe(q); assert.strictEqual(d2.progress, 100); assert.strictEqual(d2.claimable, true);
  q.userStatus.claimedAt = 'z'; assert.strictEqual(t.describe(q).status, 'claimed');
});
test('describe copes with junk', () => {
  assert.strictEqual(t.describe(null).known, false); assert.strictEqual(t.describe(5).name, 'unknown'); assert.strictEqual(t.describe({ id: ID1 }).id, ID1);
});
test('redact removes sealed strings and tokens', () => {
  const tok = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GabcDE.' + 'x'.repeat(30);
  const s = t.redact('{"location":12,"metadata_sealed":"SECRET1","traffic_metadata_sealed":"SECRET2"} ' + tok);
  assert(!s.includes('SECRET1') && !s.includes('SECRET2') && !s.includes(tok)); assert(s.includes('location'));
});
test('bar and timeLeft', () => {
  assert.strictEqual(t.bar(0), '▱'.repeat(10)); assert.strictEqual(t.bar(100), '▰'.repeat(10)); assert.strictEqual(t.bar(55).length, 10);
  assert.strictEqual(t.timeLeft(NaN), ''); assert.strictEqual(t.timeLeft(Date.now() - 1), 'expired');
  assert(/^\d+m left$/.test(t.timeLeft(Date.now() + 5 * 60000 + 500))); assert(/d \d+h left$/.test(t.timeLeft(Date.now() + 3 * 86400000)));
});
test('groupQuests: none, status order, game and reward by size', () => {
  const mk = (id, o) => Object.assign({ id, name: id, app: '', reward: '', status: 'available', claimable: false }, o);
  const list = [mk('1', { status: 'expired', app: 'B' }), mk('2', { claimable: true, app: 'A' }), mk('3', { status: 'enrolled', app: 'A', reward: 'Orbs' }), mk('4', { status: 'locked', app: 'A', reward: 'Orbs' }), mk('5', { reward: 'Orbs' }), mk('6', { reward: 'Orbs' })];
  assert.strictEqual(t.groupQuests(list, 'none').length, 1);
  assert.deepStrictEqual(t.groupQuests(list, 'status').map(g => g.title), ['Ready to claim', 'In progress', 'Available', 'Not offered to you', 'Finished or expired']);
  const g = t.groupQuests(list, 'game'); assert.strictEqual(g[0].title, 'A'); assert.strictEqual(g[0].items.length, 3); assert(g.some(x => x.title === 'No game info'));
  const r = t.groupQuests(list, 'reward'); assert.strictEqual(r[0].title, 'Orbs'); assert.strictEqual(r[0].items.length, 4);
  assert.strictEqual(t.groupQuests(list, '__proto__').length, 1);
});
test('describe lists every task with a percentage, even before accepting', () => {
  const d = t.describe({ id: ID1, config: { messages: { questName: 'A' }, taskConfigV2: { tasks: { WATCH_VIDEO: { target: 600 }, PLAY_ON_DESKTOP: { target: 1200 } } } } });
  assert.strictEqual(d.tasks.length, 2); assert.strictEqual(d.tasks[0].pct, 0); assert(Number.isNaN(d.progress)); assert.deepStrictEqual(d.taskText, []);
});
test('isCaptcha', () => {
  assert.strictEqual(t.isCaptcha({ status: 400, body: { captcha_key: ['captcha-required'], captcha_sitekey: 'x' } }), true);
  assert.strictEqual(t.isCaptcha({ status: 404, body: { code: 260008 } }), false); assert.strictEqual(t.isCaptcha(null), false);
});
test('saved list: trimmed, no sealed strings, capped, loads back', () => {
  const q = { id: ID1, metadataSealed: 'SECRET', trafficMetadataSealed: 'SECRET2', config: { expiresAt: 'x', messages: { questName: 'N', extra: 'y'.repeat(5000) }, taskConfigV2: { tasks: { WATCH_VIDEO: { target: 9, junk: 1 } } }, rewardsConfig: { rewards: [{ orbQuantity: 5, messages: { name: 'R' }, huge: 'z'.repeat(5000) }] }, application: { name: 'G' } }, userStatus: { enrolledAt: 'e', progress: { WATCH_VIDEO: { value: 3 } } } };
  const j = JSON.stringify(t.trimQuest(q)); assert(!j.includes('SECRET') && !j.includes('yyyy') && !j.includes('zzzz'));
  const ids = Array.from({ length: 100 }, (_, i) => String(1400000000000000000 + i * 1000)); const top = t.newestIds(ids.map(id => ({ id })), 60);
  assert.strictEqual(top.length, 60); assert.strictEqual(top[0], ids[99]);
  t.loadSnapshot({ at: Date.now() - 60000, json: JSON.stringify({ q: [t.trimQuest(q)], x: [ID2] }) });
  const st = t.snapshotState(); assert.strictEqual(st.q.length, 1); assert.strictEqual(st.x[0].id, ID2); assert.strictEqual(st.selfAt, 0); assert(st.at > 0);
  assert.strictEqual(t.describe(st.q[0]).name, 'N');
});
test('saved list ignores damaged or old data', () => {
  const before = t.snapshotState().q.length;
  t.loadSnapshot({ at: Date.now(), json: '{bad' }); t.loadSnapshot({ at: 5, json: '{"q":[],"x":[]}' }); t.loadSnapshot(null);
  assert.strictEqual(t.snapshotState().q.length, before);
});
process.exit(bad ? 1 : 0);
