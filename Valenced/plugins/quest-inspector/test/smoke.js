const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'index.js'), 'utf8');
const log = [];
const day = 86400000;
const mk = (id, exp, us) => ({ id, config: { expiresAt: new Date(Date.now() + exp).toISOString(), messages: { questName: 'Q' + id }, taskConfigV2: { tasks: { WATCH_VIDEO: { target: 900 } } }, rewardsConfig: { rewards: [{ orbQuantity: 700, messages: { name: 'Orbs' } }] }, application: { name: 'G' } }, userStatus: us });
const sn = (d) => String((BigInt(Date.now() - d * 86400000) - 1420070400000n) << 22n);
const ID_LIVE = sn(3), ID_EXPIRED_IN_TRACKER = sn(40), ID_NEW_UNKNOWN = sn(5), ID_OLD_UNKNOWN = sn(200), ID_BARE = sn(4), ID_PROBE_OK = sn(8), ID_PROBE_GONE = sn(12);
const quests = [
  mk('11111', 2*3600000, {enrolledAt:'x', progress:{WATCH_VIDEO:{value:450}}}),
  { id: ID_LIVE }, { id: ID_EXPIRED_IN_TRACKER }, { id: ID_NEW_UNKNOWN }, { id: ID_OLD_UNKNOWN }, { id: ID_BARE }, { id: ID_PROBE_OK }, { id: ID_PROBE_GONE },
];
const hooks = { useFilteredQuests: () => ({ quests: [quests[0]], excludedQuests: quests.slice(1) }), useClaimedQuests: () => ({ quests: [] }) };
const store = { quests: new Map(), claimedQuests: new Map(), getQuest() {}, getQuestConfig() {} };
const enroll = { fetchCurrentQuests: async () => log.push('fetchCurrent'), enrollInQuest() {} };
const posts = [];
const gets = [];
const HTTP = { get: async (o) => { if (o.url === '/quests/@me') { gets.push('@me'); return { body: { quests: [{ id: '11111', config: { expires_at: new Date(Date.now() + 86400000).toISOString(), messages: { quest_name: 'Visible One' }, task_config_v2: { tasks: { WATCH_VIDEO: { target: 900 } } }, rewards_config: { rewards: [{ orb_quantity: 700 }] }, application: { name: 'G' } }, user_status: { enrolled_at: 'x', progress: { WATCH_VIDEO: { value: 900 } } }, traffic_metadata_sealed: 'S9' }], excluded_quests: quests.slice(1).map(q => ({ id: q.id })) } }; } gets.push(o.url.split('/').pop()); if (o.url.endsWith(ID_PROBE_OK)) return { body: trackerCfg(ID_PROBE_OK, 'Probed Quest', 3 * day) }; const e = new Error('nf'); e.status = 404; e.body = { message: 'Unknown Quest' }; throw e; }, post: async (o) => {
  posts.push(o); if (o.url.includes('claim-reward')) return { status: 200, body: { claimed_at: '2026-11-28T00:00:00Z', entitlements: [] } };
  if (o.url.includes(ID_LIVE)) { const e = new Error('Unknown Quest'); e.status = 404; e.body = { message: 'Unknown quest', code: 260008 }; throw e; }
  if (o.url.includes(ID_BARE)) { const e = new Error('x'); e.status = 404; e.body = { message: 'Quest has expired', code: 260017 }; throw e; }
  if (o.url.includes('22222')) return { ok: true, status: 200, body: { quest_id: '22222', enrolled_at: '2026-11-25T00:00:00Z' } };
  if (o.url.includes('66666')) { const e = new Error('x'); e.status = 400; e.body = { message: 'Invalid location', code: 50035 }; throw e; }
  return { body: {} };
} };
const h = (t, p, ...c) => ({ t, p, c: c.flat(Infinity) });
const React = { Fragment: 'FRAG', useLayoutEffect: () => {}, createElement: h, useState: (v) => [v, () => {}], useEffect: () => {} };
const clip = [];
const V = {
  utils: { discord: { lookupGeneratedIconComponent: (n) => n === 'ClockWarningIcon' ? undefined : { n } } },
  react: { React, ReactNative: { ScrollView: 'SV', TextInput: 'TI', Share: { share: () => log.push('SHARE') }, Alert: { alert: (t, m, b) => { log.push('alert:' + t); const a = b && b.find(x => x.text === 'Accept'); if (a && !t.includes('x')) pendingAlert = a; } }, Linking: {}, AppState: { currentState: 'active' } } },
  externals: { ReactNativeClipboard: { Clipboard: { setString: s => clip.push(s.length) } } },
  discord: { design: { Design: { TableRowGroup: 'TRG', TableRow: 'TR', TableSwitchRow: 'TSR', TextInput: 'DTI', AlertModal: 'AM', AlertActionButton: 'AAB', Text: 'TXT' } }, modules: { settings: { onSettingsModulesLoaded: (cb) => { cb(); return () => {}; }, registerSettingsItem: (k, it) => { global.ROWITEM = it; log.push('ROW ' + k); return () => {}; }, addSettingsItemToSection: (sec, k, i) => { log.push('SECTION ' + sec + ' ' + k + ' ' + i); return () => {}; }, refreshSettings: () => log.push('REFRESH') } }, actions: { AlertActionCreators: { openAlert: (k, el) => { global.POPUPS = (global.POPUPS || []); global.POPUPS.push(el); log.push('POPUP ' + k + ' ' + el.p.title + ' buttons=' + el.p.actions.c.map(b => b.p.variant + ':' + b.p.text).join(',')); } }, ToastActionCreators: { open: (k, o) => log.push('toast ' + k + ' ' + JSON.stringify(Object.assign({}, o, { icon: o.icon ? 'ICON:' + o.icon.n : undefined }))) } } },
  components: { Page: 'Page' },
  modules: { finders: {
    filters: { withProps: (...p) => p },
    lookupModule: (f) => f.includes('HTTP') ? [{ HTTP }, 3] : f.includes('getQuest') ? [store, 1] : f.includes('enrollInQuest') ? [enroll, 2] : [],
    getModules: (f, cb) => { if (f.includes('useFilteredQuests')) cb(hooks); return () => {}; },
  } },
  patcher: { instead: (mod, name, fn) => { const o = mod[name]; mod[name] = function (...a) { return fn.call(this, a, o); }; return () => { mod[name] = o; }; } },
};
let pendingAlert = null;
const trackerCfg = (id, name, expMs) => ({ id, config_version: 2, starts_at: '2026-10-01T00:00:00+00:00', expires_at: new Date(Date.now() + expMs).toISOString(), messages: { quest_name: name + (name==='Expired' ? ' 한국어' : ''), game_title: 'Game ' + name, game_publisher: 'Pub' }, application: { id: '1', name: 'App ' + name }, task_config_v2: { tasks: { WATCH_VIDEO: { type: 'WATCH_VIDEO', target: 900 } } }, rewards_config: { assignment_method: 1, rewards: [{ type: 4, orb_quantity: 700, messages: { name: '700 Orbs', name_with_article: '700 Orbs' } }] }, assets: { hero: 'quests/' + id + '/h.jpg' }, '__proto__': { polluted: 1 } });
const fetched = [];
global.fetch = async (u) => { if (u.includes('country.is')) return { ok: true, status: 200, json: async () => ({ ip: '1.1.1.1', country: 'IQ' }) }; fetched.push(u.split('/').pop()); if (u.includes('quest.json')) return { ok: true, status: 200, json: async () => [trackerCfg(ID_BARE, 'Bare', day)] }; if (u.includes('quests-01')) return { ok: true, status: 200, json: async () => [{ id: ID_EXPIRED_IN_TRACKER, config: trackerCfg(ID_EXPIRED_IN_TRACKER, 'Expired', -day), user_status: null }] }; if (u.includes('quests-02')) return { ok: true, status: 200, json: async () => [{ id: ID_LIVE, config: trackerCfg(ID_LIVE, 'Live Quest', 2 * day), user_status: null, targeted_content: null }] }; return { ok: true, status: 200, json: async () => ({ quests: [{ id: ID_LIVE, is_global: false, regions: { include: ['IQ'], exclude: [] } }, { id: '11111', is_global: false, regions: { include: ['IQ','TR'], exclude: [] } }, { id: ID_BARE, is_global: false, regions: { include: ['DE'], exclude: [] } }] }) }; };
const _old = async (u) => ({ ok: true, status: 200, json: async () => ({ quests: [
  { id: '22222', show_age_gate: true, is_global: false, regions: { include: ['US', 'UK', 'IQ'], exclude: [] } },
  { id: '33333', show_age_gate: false, is_global: true, regions: { include: [], exclude: [] } },
  { id: '__proto__', is_global: true }, { id: 'abc', is_global: true } ] }) });
let inited = false;
for (const k of ['discord', 'components']) { const val = V[k]; delete V[k]; Object.defineProperty(V, k, { get() { if (!inited) throw new Error('before init: ' + k); return val; } }); }
let opts_loadMeta = async () => {}; let opts; new Function('valenced', 'plugin', src)(V, o => (opts = o));
const find = (n, f) => { if (!n || typeof n !== 'object') return; if (f(n)) out.push(n); (n.c || []).forEach(x => find(x, f)); };
let out = [];
const labels = (tree) => { out = []; find(tree, n => n.p && n.p.label); return out.map(n => n.p.label + (n.p.subLabel ? ' || ' + n.p.subLabel : '')); };
(async () => {
  inited = true;
  const jsonStorage = { cache: { autoAccept: process.env.QI_AUTOACCEPT === '1', aaBase: [], remind: true, reminded: [],  detectIp: true, vpns: 'Ninja VPN=https://ninja.example/x; bad=http://nope', learned: {},  showHidden: true, alertNew: true, seeded: true, seen: [], filter: 'live hidden', region: 'any', regions: {}, regionsAt: 0, meta: {}, metaAt: 0, autoMeta: true, autoProbe: true, gone: {}, acceptDelay: 10, sortSoonest: true }, get: async () => ({}), set: async (p) => { Object.assign(jsonStorage.cache, p); log.push('set ' + Object.keys(p)); }, use: () => jsonStorage.cache };
  const ctx = { cleanup() {}, jsonStorage, plugin: { startedLate: false, reportError: e => log.push('ERR ' + e.stack), requireReload() {} } };
  opts.start.call(ctx.plugin, ctx);
  await new Promise(r => setTimeout(r, 9000)); await new Promise(r => setTimeout(r, 14000));
  await opts_loadMeta();
  console.log('merged native list:', JSON.stringify(hooks.useFilteredQuests().quests.map(q => q.id)));
  console.log('meta cached ids:', Object.keys(jsonStorage.cache.meta).length, 'fetched:', fetched.join(','));
  let tree = opts.SettingsComponent({ api: { jsonStorage } });
  console.log('--- default view (live hidden)'); labels(tree).filter(l => /^Q\d|Accept all|Regions:|Accept:|quests:|Copy report|. Discord HTTP client|. Quest list/.test(l)).forEach(l => console.log(' ', l));
  // accept all live hidden
  out = []; find(tree, n => n.p && /^Accept all live hidden/.test(n.p.label || '')); out[0].p.onPress();
  await global.POPUPS[global.POPUPS.length-1].p.actions.c.find(b => b.p.variant === 'primary').p.onPress(); await new Promise(r => setTimeout(r, 400));
  console.log('--- POSTs'); posts.forEach(p => console.log(' ', p.url, JSON.stringify(p.body), 'retries', p.retries));
  console.log('--- clipboard');
  out = []; find(tree, n => n.p && /^Copy everything/.test(n.p.label || '')); out[0].p.onPress(); console.log('  copied lens', clip);
  console.log('--- log'); log.filter(l => /toast|ERR|SHARE|fetchCurrent/.test(l)).forEach(l => console.log(' ', l));
  // region filter + search
  jsonStorage.cache.filter = 'all'; jsonStorage.cache.region = 'any';
  await HTTP.post({ url: '/quests/' + ID_LIVE + '/enroll', body: { location: 11 } }).catch(() => {});
  await HTTP.post({ url: '/quests/' + ID_BARE + '/enroll', body: { location: 11 } }).catch(() => {});
  await HTTP.post({ url: '/channels/1/messages', body: {} });
  await new Promise(r => setTimeout(r, 50));
  console.log('posts seen by mock:', posts.length);
  console.log('probed ids:', gets.length, 'stored gone:', Object.keys(jsonStorage.cache.gone).length);
  console.log('--- all rows');
  const t2 = opts.SettingsComponent({ api: { jsonStorage } });
  labels(t2).filter(l => !/^(Quest store|Accept|Regions|Names|Show|Alert|Soonest|Delay|Download|Refresh|Copy|Filter|Region:|No matching)/.test(l) && !/quests:/.test(l)).forEach(l => console.log(' ', l));
  console.log(labels(t2).find(l => /^Names:/.test(l)));
  const trailing = global.ROWITEM.useTrailing(); console.log('TRAILING:', trailing);
  const k = global.ROWITEM; console.log('ROW item:', k.type, k.parent, k.useTitle(), typeof k.screen.getComponent());
  const scr = k.screen.getComponent()({ navigation: { setOptions() {} } }); console.log('screen renders:', typeof scr, scr.t === undefined ? 'fn' : scr.t.name);
  // trigger some popups via the tree
  out = []; find(tree, n => n.p && /^How to use/.test(n.p.label || '')); console.log('found', out.length, out[0] && Object.keys(out[0].p)); out[0].p.onPress();
  out = []; find(tree, n => n.p && /^Why are some refused|^Pick a country|^Best country/.test(n.p.label || '')); out[0].p.onPress();
  log.filter(l => /^(ROW|SECTION|REFRESH|POPUP)/.test(l)).forEach(l => console.log(' ', l));
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
