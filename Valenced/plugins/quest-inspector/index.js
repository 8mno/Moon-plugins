(function (exports) {
  var V = valenced;

  // Valenced evaluates this script *before* Discord's index module is initialized (preInit).
  // Reading e.g. valenced.discord.design at that point throws, which kills the plugin at boot
  // (it shows as disabled after a reload, with no settings gear). So nothing from the valenced
  // API may be read while this file loads: every API object below is resolved on first use.
  function lazy(get) {
    return new Proxy({}, {
      get: function (_, key) { return get()[key]; }
    });
  }
  var React = lazy(function () { return V.react.React; });
  var RN = lazy(function () { return V.react.ReactNative; });
  var Design = lazy(function () { return V.discord.design.Design; });
  var finders = lazy(function () { return V.modules.finders; });
  function h() { return React.createElement.apply(null, arguments); }

  var DEFAULTS = {
    showHidden: false,   // merge client-excluded quests into Discord's own Quests screen
    alertNew: true,      // toast when a new quest appears
    sortSoonest: true,   // soonest-expiring first
    filter: 'live hidden', // live hidden | all | available | enrolled | hidden | finished
    region: 'any',       // any | global | regional
    regions: {},         // cached region data, see REGIONS_URL
    regionsAt: 0,
    autoMeta: true,      // download quest names/details for hidden quests (about 5 MB, at most every 6 hours)
    meta: {},            // cached quest configs for hidden quests, see META_URLS
    metaAt: 0,
    detectIp: true,      // find your country from your IP (api.country.is, then ipwho.is), through the same connection Discord uses
    learned: {},         // quest id -> {y:[countries it worked from], n:[countries Discord refused it from]}
    vpns: '',            // your own VPN links: Name=https://link; Other=https://link
    autoProbe: true,     // ask Discord (GET /quests/{id}) whether hidden quests are still active
    gone: {},            // quest id -> when Discord said it has expired
    locked: {},          // quest id -> when Discord said it is unknown (not offered to this account/region)
    acceptDelay: 1500,   // ms between "Accept all" requests
    seeded: false,
    seen: []
  };
  var FILTERS = ['live hidden', 'all', 'available', 'enrolled', 'hidden', 'finished', 'not offered'];
  var REGION_FILTERS = ['any', 'global', 'regional'];
  // Third-party, community-kept list of which countries each quest is limited to. It is only used
  // for display, can be out of date, and the plugin works without it.
  var REGIONS_URL = 'https://gist.githubusercontent.com/xGustavvo/3d08b7369eb34b50834815fd43176cae/raw';
  var REGIONS_TTL = 6 * 3600 * 1000;
  // Discord only sends hidden quests as bare stubs (an id, sometimes a replacement_id), with no name,
  // reward or dates. This community tracker keeps the full quest configs. Oldest first, later wins.
  var TRACKER = 'https://raw.githubusercontent.com/xGustavvo/discord-api-tracker/refs/heads/main/';
  var META_URLS = [TRACKER + 'quest.json', TRACKER + 'data/quests-01.json', TRACKER + 'data/quests-02.json'];
  var META_RETRY_FAIL = 30 * 60 * 1000;
  var META_RETRY_OK = 6 * 3600 * 1000;
  var LIVE_STATUSES = ['available', 'unverified'];
  var PROBE_MAX = 25;                      // quests asked about per run
  var PROBE_MAX_AGE_DAYS = 60;             // older ids are not worth asking about
  var PROBE_GONE_TTL = 24 * 3600 * 1000;   // how long "expired" is remembered
  var LOCKED_TTL = 30 * 60 * 1000;         // how long "not offered to you" is remembered (short, so a new VPN gets a fresh try)
  var PROBE_GAP = 500;                     // ms between requests
  var QUEST_HOME_MOBILE = 12;   // "location" Discord's accept request needs (QUEST_HOME_MOBILE)
  var DESKTOP_ONLY = ['PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'STREAM_ON_DESKTOP'];
  var TYPE_LABELS = {
    WATCH_VIDEO: 'watch video', WATCH_VIDEO_ON_MOBILE: 'watch video (mobile)',
    PLAY_ON_DESKTOP: 'play on desktop', PLAY_ON_XBOX: 'play on Xbox',
    PLAY_ON_PLAYSTATION: 'play on PlayStation', PLAY_ACTIVITY: 'play activity',
    STREAM_ON_DESKTOP: 'stream', ACHIEVEMENT_IN_ACTIVITY: 'activity achievement'
  };

  var lastHook = {};        // last results seen from Discord's own quest hooks
  var storageRef = null;    // jsonStorage, set in start()

  // ---------- helpers ----------
  function isObj(x) { return typeof x === 'object' && x !== null; }
  function toList(c) {
    if (c instanceof Map) return Array.from(c.values());
    if (Array.isArray(c)) return c;
    if (isObj(c)) return Object.values(c);
    return [];
  }
  function safe(o) {
    var seen = new WeakSet();
    try {
      return JSON.stringify(o, function (k, v) {
        if (typeof v === 'function') return undefined;
        if (v instanceof Map) return Array.from(v.values());
        if (isObj(v)) { if (seen.has(v)) return '[circular]'; seen.add(v); }
        return v;
      }, 2);
    } catch (e) { return 'unserializable: ' + (e && e.message); }
  }
  // The share sheet silently fails for big payloads on some builds, so copy to the clipboard first.
  function copyText(text, setMsg) {
    try {
      V.externals.ReactNativeClipboard.Clipboard.setString(text);
      setMsg('Copied ' + text.length + ' characters to the clipboard.');
      toast('QI_COPIED', 'Copied to clipboard');
      return;
    } catch (e) {}
    try { RN.Share.share({ message: text }); }
    catch (e2) { setMsg('Could not copy or share.'); }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function toast(key, text, bad) {
    try {
      V.discord.actions.ToastActionCreators.open(key, bad ? { text: text, variant: 'critical' } : { text: text });
    } catch (e) {}
  }
  function cfgNow() {
    return Object.assign({}, DEFAULTS, storageRef && storageRef.cache);
  }
  function getStore() {
    var r = finders.lookupModule(finders.filters.withProps('getQuest', 'getQuestConfig'));
    return r && r[0];
  }
  function enrollModule() {
    var r = finders.lookupModule(finders.filters.withProps('fetchCurrentQuests', 'enrollInQuest'));
    return r && r[0];
  }
  function timeLeft(ms) {
    if (!Number.isFinite(ms)) return '';
    var d = ms - Date.now();
    if (d <= 0) return 'expired';
    var m = Math.floor(d / 60000), hr = Math.floor(m / 60), day = Math.floor(hr / 24);
    if (day > 0) return day + 'd ' + (hr % 24) + 'h left';
    if (hr > 0) return hr + 'h ' + (m % 60) + 'm left';
    return m + 'm left';
  }

  // ---------- quest details for hidden quests ----------
  var metaMap = {};          // quest id -> camelCased quest config from the tracker
  var metaAt = 0;
  var metaStatus = 'not loaded';
  var metaLoading = null;
  var metaNextAt = 0;

  function camelKey(k) { return k.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); }); }
  function camelize(v) {
    if (Array.isArray(v)) return v.map(camelize);
    if (!isObj(v)) return v;
    var o = {};
    Object.keys(v).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      o[camelKey(k)] = camelize(v[k]);
    });
    return o;
  }
  function setMeta(map, at) {
    var clean = {};
    Object.keys(map).forEach(function (k) {
      if (/^\d{5,25}$/.test(k) && isObj(map[k]) && isObj(map[k].messages)) clean[k] = map[k];
    });
    metaMap = clean; metaAt = at;
    metaStatus = Object.keys(clean).length + ' quests';
  }
  async function fetchJson(url, ms) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    try {
      var res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { if (t) clearTimeout(t); }
  }
  function stubIds() {
    return unify(collect()).filter(function (x) { return !x.known; }).map(function (x) { return x.id; });
  }
  function loadMeta(force) {
    if (metaLoading) return metaLoading;
    metaLoading = fetchMeta(force).then(function (r) { metaLoading = null; return r; }, function () { metaLoading = null; return false; });
    return metaLoading;
  }
  async function fetchMeta(force) {
    var want = new Set(stubIds());
    if (want.size === 0) { metaStatus = 'nothing to look up yet (open the Quests screen once)'; return false; }
    metaStatus = 'downloading...';
    var found = {}, errs = [];
    for (var i = 0; i < META_URLS.length; i++) {
      try {
        var arr = await fetchJson(META_URLS[i], 90000);
        if (!Array.isArray(arr)) throw new Error('unexpected format');
        for (var j = 0; j < arr.length; j++) {
          var e = arr[j];
          if (!isObj(e)) continue;
          var cfg = isObj(e.config) ? e.config : e;
          var id = typeof e.id === 'string' ? e.id : (typeof cfg.id === 'string' ? cfg.id : '');
          if (id && want.has(id) && isObj(cfg.messages)) found[id] = camelize(cfg);
        }
        arr = null;
      } catch (err) { errs.push(String(err && err.message ? err.message : err)); }
    }
    var n = Object.keys(found).length;
    if (errs.length === META_URLS.length) { metaStatus = 'failed: ' + errs[0]; metaNextAt = Date.now() + META_RETRY_FAIL; return false; }
    var merged = Object.assign({}, metaMap, found);
    setMeta(merged, Date.now());
    metaNextAt = Date.now() + (errs.length ? META_RETRY_FAIL : META_RETRY_OK);
    metaStatus = Object.keys(metaMap).length + ' quests' + (errs.length ? ' (some files failed)' : '');
    try { if (storageRef) await storageRef.set({ meta: found, metaAt: metaAt }); } catch (e2) {}
    return n > 0;
  }
  function maybeMeta() {
    if (metaLoading || Date.now() < metaNextAt || !cfgNow().autoMeta) return;
    if (stubIds().length === 0) return;
    metaNextAt = Date.now() + META_RETRY_FAIL;
    loadMeta(false);
  }
  // ---------- which country you are in right now (IP based) ----------
  // The request is made from inside Discord's app, so it takes the same route as Discord's own traffic:
  // when a VPN is on for Discord, this sees the VPN's country.
  var ipCountry = { cc: '', at: 0, status: 'not checked' };
  var GEO_SOURCES = [
    { url: 'https://api.country.is/', pick: function (j) { return j && j.country; } },
    { url: 'https://ipwho.is/', pick: function (j) { return j && j.success !== false && j.country_code; } }
  ];
  var geoLoading = null;
  function detectCountry(force) {
    if (!force && ipCountry.cc && Date.now() - ipCountry.at < 5 * 60000) return Promise.resolve(false);
    if (!force && !ipCountry.cc && ipCountry.at && Date.now() - ipCountry.at < 2 * 60000) return Promise.resolve(false);
    if (!geoLoading) geoLoading = doDetect().then(function (r) { geoLoading = null; return r; }, function () { geoLoading = null; return false; });
    return geoLoading;
  }
  async function doDetect() {
    var prev = ipCountry.cc, cc = '', err = '';
    for (var i = 0; i < GEO_SOURCES.length && !cc; i++) {
      try {
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
        var res = await fetch(GEO_SOURCES[i].url, ctrl ? { signal: ctrl.signal } : undefined);
        if (t) clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var v = String(GEO_SOURCES[i].pick(await res.json()) || '').toUpperCase();
        if (/^[A-Z]{2}$/.test(v)) cc = v; else throw new Error('no country in reply');
      } catch (e) { err = (e && e.message) || String(e); }
    }
    ipCountry.at = Date.now();
    if (!cc) { ipCountry.status = 'failed: ' + err; return false; }
    ipCountry.cc = cc; ipCountry.status = 'from your IP';
    if (prev && prev !== cc) onCountryChanged(prev, cc);
    return true;
  }
  // a VPN was switched on or off: what Discord refused before may be offered now
  function onCountryChanged(prev, cc) {
    lockedMap = {}; probeNextAt = 0;
    toast('QI_COUNTRY', 'Your country is now ' + flag(cc) + ' ' + cc + '. Checking quests again...');
    var m = enrollModule();
    if (m) { try { Promise.resolve(m.fetchCurrentQuests()).catch(function () {}); } catch (e) {} }
  }
  // what the server itself told us about a quest from a given country, kept so unknown regions fill in over time
  var learnedMap = {};
  function learn(id, ok) {
    var cc = ipCountry.cc;
    if (!cc || !/^\d{5,25}$/.test(id)) return;
    var r = own(learnedMap, id) || { y: [], n: [] };
    var from = ok ? 'y' : 'n', other = ok ? 'n' : 'y';
    if (r[from].indexOf(cc) < 0) r[from] = r[from].concat(cc).slice(-8);
    r[other] = r[other].filter(function (c) { return c !== cc; });
    learnedMap[id] = r;
    var one = {}; one[id] = r;
    try { if (storageRef) storageRef.set({ learned: one }).catch(function () {}); } catch (e) {}
  }

  // ---------- asking Discord whether a hidden quest is still active ----------
  var goneMap = {};          // quest id -> timestamp of the last "not active" answer
  var probeStatus = 'not run yet';
  var probing = null;
  var probeNextAt = 0;
  function isGone(id) {
    var t = own(goneMap, id);
    return typeof t === 'number' && Date.now() - t < PROBE_GONE_TTL;
  }
  var lockedMap = {};        // quest id -> timestamp of the last "unknown quest" answer
  function isLocked(id) {
    var t = own(lockedMap, id);
    return typeof t === 'number' && Date.now() - t < LOCKED_TTL;
  }
  // 260017 = "Quest has expired"; 260008 = "Unknown quest" (the server does not offer it to this account)
  function refusalKind(e) {
    if (!isObj(e)) return null;
    var body = isObj(e.body) ? e.body : {};
    var t = errText(e);
    if (body.code === 260017 || /expired|has ended|no longer/i.test(t)) return 'gone';
    if (body.code === 260008 || /unknown quest/i.test(t) || e.status === 404) return 'locked';
    return null;
  }
  function probeCandidates() {
    return stubIds().filter(function (id) { return !isGone(id) && !isLocked(id) && idAgeDays(id) <= PROBE_MAX_AGE_DAYS; })
      .sort(function (a, b) { return idAgeDays(a) - idAgeDays(b); });   // newest first
  }
  function loadProbe() {
    if (probing) return probing;
    probing = probeStubs().then(function (r) { probing = null; return r; }, function () { probing = null; return false; });
    return probing;
  }
  // GET /quests/{id} should return the full config only while the quest is active (per the community
  // docs; not confirmed for hidden quests, so the outcome counts are shown in Status).
  async function probeStubs() {
    var http = httpModule();
    if (!http || typeof http.get !== 'function') { probeStatus = 'Discord HTTP client not found'; return false; }
    var todo = probeCandidates();
    if (todo.length === 0) { probeStatus = 'nothing to check'; probeNextAt = Date.now() + META_RETRY_OK; return false; }
    var batch = todo.slice(0, PROBE_MAX), found = {}, gone = {}, locked = {}, n = { ok: 0, gone: 0, locked: 0, err: 0 }, lastErr = '';
    probeStatus = 'checking ' + batch.length + '...';
    for (var i = 0; i < batch.length; i++) {
      try {
        var res = await http.get({ url: '/quests/' + encodeURIComponent(batch[i]), retries: 0 });
        var body = isObj(res) && isObj(res.body) ? res.body : res;
        var cfg = isObj(body) && isObj(body.config) ? body.config : body;
        if (isObj(cfg) && isObj(cfg.messages)) { found[batch[i]] = camelize(cfg); n.ok++; learn(batch[i], true); }
        else { n.err++; lastErr = 'reply had no quest data'; }
      } catch (e) {
        var kind = isObj(e) && e.status === 404 ? refusalKind(e) : null;
        if (kind === 'gone') { gone[batch[i]] = Date.now(); n.gone++; }
        else if (kind === 'locked') { locked[batch[i]] = Date.now(); n.locked++; learn(batch[i], false); }
        else {
          n.err++; lastErr = errText(e);
          if (isObj(e) && e.status === 429) break;
        }
      }
      if (i < batch.length - 1) await sleep(PROBE_GAP);
    }
    if (n.ok) setMeta(Object.assign({}, metaMap, found), metaAt || Date.now());
    Object.assign(goneMap, gone);
    Object.assign(lockedMap, locked);
    probeNextAt = Date.now() + (todo.length > batch.length ? 15 * 60000 : META_RETRY_OK);
    probeStatus = n.ok + ' active, ' + n.gone + ' expired, ' + n.locked + ' not offered to you, ' + n.err + ' unclear' + (lastErr ? ' (' + lastErr + ')' : '');
    try { if (storageRef) await storageRef.set({ meta: found, gone: gone, locked: locked }); } catch (e2) {}
    return n.ok + n.gone + n.locked > 0;
  }
  function maybeProbe() {
    if (probing || metaLoading || Date.now() < probeNextAt || !cfgNow().autoProbe) return;
    if (probeCandidates().length === 0) return;
    probeNextAt = Date.now() + META_RETRY_FAIL;
    loadProbe();
  }

  // snowflake ids carry their creation time
  function idAgeDays(id) { return (Date.now() - (Math.floor(Number(id) / 4194304) + 1420070400000)) / 86400000; }

  // ---------- regions ----------
  var regionMap = {};       // quest id -> { g: isGlobal, i: [include], e: [exclude], a: ageGate, r: replacementId }
  var replacedBy = {};      // replacement id -> record
  var regionsAt = 0;
  var regionStatus = 'not loaded';

  function codeList(x) { return Array.isArray(x) ? x.filter(function (c) { return typeof c === 'string' && c.length <= 8; }) : []; }
  function parseRegions(json) {
    var list = isObj(json) && Array.isArray(json.quests) ? json.quests : [];
    var out = {}, n = 0;
    list.forEach(function (r) {
      if (!isObj(r) || typeof r.id !== 'string' || !/^\d{5,25}$/.test(r.id)) return;
      var inc = [], exc = [];
      if (Array.isArray(r.regions)) inc = codeList(r.regions);
      else if (isObj(r.regions)) { inc = codeList(r.regions.include); exc = codeList(r.regions.exclude); }
      var rid = typeof r.replacement_id === 'string' && /^\d{5,25}$/.test(r.replacement_id) ? r.replacement_id : '';
      out[r.id] = { g: r.is_global === true, i: inc, e: exc, a: r.show_age_gate === true, r: rid };
      n++;
    });
    return n > 0 ? out : null;
  }
  function setRegions(map, at) {
    // the map may come back from storage, so re-check every record instead of trusting its shape
    var clean = {};
    Object.keys(map).forEach(function (k) {
      var r = map[k];
      if (!/^\d{5,25}$/.test(k) || !isObj(r) || !Array.isArray(r.i) || !Array.isArray(r.e)) return;
      clean[k] = { g: r.g === true, i: codeList(r.i), e: codeList(r.e), a: r.a === true, r: typeof r.r === 'string' && /^\d{5,25}$/.test(r.r) ? r.r : '' };
    });
    regionMap = clean; regionsAt = at; replacedBy = {};
    Object.keys(clean).forEach(function (k) { if (clean[k].r) replacedBy[clean[k].r] = clean[k]; });
    regionStatus = Object.keys(clean).length + ' quests';
  }
  var regionsLoading = null;
  function loadRegions(force) {
    if (!force && regionsAt && Date.now() - regionsAt < REGIONS_TTL) return Promise.resolve(false);
    if (!regionsLoading) {
      regionsLoading = fetchRegions().then(function (r) { regionsLoading = null; return r; });
    }
    return regionsLoading;
  }
  async function fetchRegions() {
    regionStatus = 'loading...';
    var map;
    try {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
      var res = await fetch(REGIONS_URL, ctrl ? { signal: ctrl.signal } : undefined);
      if (t) clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      map = parseRegions(await res.json());
      if (!map) throw new Error('unexpected format');
    } catch (e) {
      regionStatus = 'failed: ' + (e && e.message ? e.message : e);
      return false;
    }
    setRegions(map, Date.now());
    try { if (storageRef) await storageRef.set({ regions: map, regionsAt: regionsAt }); } catch (e) {}
    return true;
  }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; }
  function regionFor(id) { return own(regionMap, id) || own(replacedBy, id) || null; }
  function regionKind(id) { var r = regionFor(id); return !r ? 'unknown' : r.g ? 'global' : 'regional'; }
  function flag(code, withCode) {
    var c = String(code).toUpperCase();
    if (c === 'UK') c = 'GB';
    if (!/^[A-Z]{2}$/.test(c)) return String(code);
    var f = String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65);
    return withCode ? f + ' ' + c : f;
  }
  function flags(list, max, withCode) {
    var s = list.slice(0, max).map(function (c) { return flag(c, withCode); }).join(withCode ? ', ' : ' ');
    return list.length > max ? s + ' +' + (list.length - max) : s;
  }
  // Which country Discord thinks you are in is not exposed anywhere, but it can be worked out: every
  // regional quest Discord really shows you (not hidden, still available) must allow your country.
  // Intersect their include lists and drop their exclude lists; what is left is your country.
  var userRegion = { codes: [], n: 0, from: '', guess: [] };
  function inferRegion(list) {
    var cand = null, banned = {}, n = 0;
    list.forEach(function (x) {
      if (x.hidden || x.status !== 'available') return;
      var r = regionFor(x.id);
      if (!r || r.g) return;
      if (r.i.length) {
        var inc = {}; r.i.forEach(function (c) { inc[c] = 1; });
        cand = cand ? cand.filter(function (c) { return inc[c]; }) : r.i.slice();
        n++;
      }
      r.e.forEach(function (c) { banned[c] = 1; });
      if (r.e.length) n++;
    });
    if (cand) cand = cand.filter(function (c) { return !banned[c]; });
    // an empty answer means the lists disagree (old list, or a VPN switched mid-way): say "unknown"
    return cand && cand.length && cand.length <= 12 ? { codes: cand, n: n } : { codes: [], n: 0 };
  }
  // 'yes' | 'no' | 'maybe' | 'unknown': would Discord show this quest to the country you are in now?
  function access(id) {
    var r = regionFor(id), me = userRegion.codes, L = own(learnedMap, id);
    if (L && me.length && (!r || (!r.g && !r.i.length && !r.e.length))) {
      if (L.y.some(function (c) { return me.indexOf(c) >= 0; })) return 'yes';
      if (L.n.some(function (c) { return me.indexOf(c) >= 0; })) return 'no';
    }
    if (!r || !me.length) return 'unknown';
    if (r.g) return 'yes';
    var ok = me.filter(function (c) { return (!r.i.length || r.i.indexOf(c) >= 0) && r.e.indexOf(c) < 0; }).length;
    if (!r.i.length && !r.e.length) return 'unknown';
    return ok === me.length ? 'yes' : ok === 0 ? 'no' : 'maybe';
  }
  function regionLabel(id, long) {
    var r = regionFor(id);
    if (!r) {
      var L = own(learnedMap, id), seen = [];
      if (L && L.y.length) seen.push('works from ' + flags(L.y, 4));
      if (L && L.n.length) seen.push('refused from ' + flags(L.n, 4));
      if (seen.length) return '\uD83D\uDD0D ' + seen.join(' \u00b7 ');
      return regionsAt ? '\u2754 region unknown (not in the list yet)' : '';
    }
    var age = r.a ? ' \uD83D\uDD1E' : '';
    if (r.g) return '\uD83C\uDF10 global' + age;
    var parts = [];
    if (r.i.length) parts.push('only ' + flags(r.i, long ? 99 : 6, long));
    if (r.e.length) parts.push('not ' + flags(r.e, long ? 99 : 6, long));
    if (!parts.length) parts.push('\uD83D\uDD12 region-limited');
    var a = access(id);
    return parts.join(' \u00b7 ') + (a === 'yes' ? ' \u00b7 \u2705 your region' : a === 'no' ? ' \u00b7 \uD83D\uDEAB not your region' : '') + age;
  }
  function regionHay(id) {
    var r = regionFor(id);
    return r ? (r.g ? 'global' : 'regional ' + r.i.concat(r.e).join(' ')) : '';
  }
  function hiddenReason(x) {
    var why = [];
    if (regionKind(x.id) === 'regional') why.push(access(x.id) === 'no' ? 'not offered in ' + flags(userRegion.codes, 3) : 'region-limited');
    if (x.types.length && x.types.every(function (t) { return DESKTOP_ONLY.indexOf(t) >= 0; })) why.push('needs desktop/console');
    return why.length ? 'likely ' + why.join(' + ') : 'reason unknown';
  }

  // How many of these quests each country unlocks, from the region list (quests limited by an
  // exclude list only are open to most countries, so they are counted separately).
  function countryCounts(list) {
    var counts = Object.create(null), globalN = 0, open = 0, unknown = 0;
    list.forEach(function (x) {
      var r = regionFor(x.id);
      if (!r) {
        var L = own(learnedMap, x.id);
        if (L && L.y.length) L.y.forEach(function (c) { if (userRegion.codes.indexOf(c) < 0) counts[c] = (counts[c] || 0) + 1; });
        else unknown++;
        return;
      }
      if (r.g) { globalN++; return; }
      if (r.i.length) r.i.forEach(function (c) { if (userRegion.codes.indexOf(c) < 0) counts[c] = (counts[c] || 0) + 1; });
      else open++;
    });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
    return { counts: counts, top: top, globalN: globalN, open: open, unknown: unknown };
  }

  // ---------- reading quest objects (field names defensive; verify with the JSON export) ----------
  function describe(q) {
    var out = { id: '', name: 'unknown', status: 'available', types: [], expMs: NaN, reward: '', app: '', progress: NaN, known: false };
    if (!isObj(q)) return out;
    var cfg = isObj(q.config) ? q.config : (own(metaMap, q.id) || {});
    var msgs = isObj(cfg.messages) ? cfg.messages : {};
    var us = isObj(q.userStatus) ? q.userStatus : (isObj(q.user_status) ? q.user_status : {});
    var tc = cfg.taskConfigV2 || cfg.task_config_v2 || cfg.taskConfig || cfg.task_config;
    var rc = cfg.rewardsConfig || cfg.rewards_config;
    var rw = isObj(rc) && Array.isArray(rc.rewards) && isObj(rc.rewards[0]) ? rc.rewards[0] : null;
    var rm = rw && isObj(rw.messages) ? rw.messages : {};
    out.id = typeof q.id === 'string' ? q.id : '';
    out.name = msgs.questName || msgs.quest_name || msgs.gameTitle || out.id || 'unknown';
    out.expMs = Date.parse(cfg.expiresAt || cfg.expires_at);
    out.types = isObj(tc) && isObj(tc.tasks) ? Object.keys(tc.tasks) : [];
    out.reward = rm.name || rm.nameWithArticle || rm.name_with_article || '';
    var orbs = rw ? Number(rw.orbQuantity || rw.orb_quantity) : NaN;
    if (!out.reward && orbs > 0) out.reward = orbs + ' orbs';
    var tasks = isObj(tc) && isObj(tc.tasks) ? tc.tasks : null;
    var prog = isObj(us.progress) ? us.progress : null;
    if (tasks && prog) {
      var sum = 0, n = 0;
      Object.keys(tasks).forEach(function (k) {
        var target = isObj(tasks[k]) ? Number(tasks[k].target) : NaN;
        if (!(target > 0)) return;
        sum += Math.min((isObj(prog[k]) ? Number(prog[k].value) || 0 : 0) / target, 1); n++;
      });
      if (n) out.progress = Math.round(sum / n * 100);
    }
    out.app = isObj(cfg.application) && typeof cfg.application.name === 'string' ? cfg.application.name : '';
    out.status = (us.claimedAt || us.claimed_at) ? 'claimed'
      : (us.completedAt || us.completed_at) ? 'completed'
      : (Number.isFinite(out.expMs) && out.expMs <= Date.now()) ? 'expired'
      : (us.enrolledAt || us.enrolled_at) ? 'enrolled' : 'available';
    out.known = isObj(cfg.messages);
    // a stub with no details has no expiry, so guess from the age of its id: quests last weeks, not months
    if (!out.known && out.status === 'available') out.status = out.id && idAgeDays(out.id) <= 30 ? 'unverified' : 'old';
    if (out.status === 'available' || out.status === 'unverified' || out.status === 'old') {
      if (isGone(out.id)) out.status = 'gone';
      else if (isLocked(out.id)) out.status = 'locked';
    }
    return out;
  }

  function collect() {
    var s = getStore();
    var f = lastHook.useFilteredQuests;
    var c = lastHook.useClaimedQuests;
    return {
      storeFound: !!s,
      storeKeys: s ? Object.keys(s).slice(0, 40) : [],
      store: toList(s && s.quests),
      storeClaimed: toList(s && s.claimedQuests),
      hookSeen: !!f,
      hookQuests: toList(f && f.quests),
      hookExcluded: toList(f && f.excludedQuests),
      hookClaimed: toList(c && (c.claimedQuests || c.quests)),
      hookKeys: isObj(f) ? Object.keys(f) : []
    };
  }

  // one entry per quest id, with where it was found
  function unify(d) {
    var map = new Map();
    function add(list, flag) {
      list.forEach(function (q) {
        if (!isObj(q) || typeof q.id !== 'string') return;
        var e = map.get(q.id);
        if (!e) { e = { q: q, flags: {} }; map.set(q.id, e); }
        e.flags[flag] = true;
      });
    }
    add(d.store, 'store'); add(d.hookQuests, 'shown'); add(d.hookExcluded, 'excluded');
    add(d.storeClaimed, 'claimed'); add(d.hookClaimed, 'claimed');
    var infos = Array.from(map.values()).map(function (e) {
      var info = describe(e.q);
      info.q = e.q;
      info.hidden = !!e.flags.excluded && !e.flags.shown;
      return info;
    });
    var guess = inferRegion(infos);
    userRegion = cfgNow().detectIp && ipCountry.cc ? { codes: [ipCountry.cc], n: guess.n, from: 'ip', guess: guess.codes } : { codes: guess.codes, n: guess.n, from: 'quests', guess: guess.codes };
    return infos;
  }

  function applyView(list, c, query) {
    var out = list.filter(function (x) {
      var f = c.filter;
      if (f === 'available' && LIVE_STATUSES.indexOf(x.status) < 0) return false;
      if (f === 'enrolled' && x.status !== 'enrolled') return false;
      if (f === 'hidden' && !x.hidden) return false;
      if (f === 'not offered' && x.status !== 'locked') return false;
      if (f === 'live hidden' && !(x.hidden && (LIVE_STATUSES.indexOf(x.status) >= 0 || x.status === 'enrolled'))) return false;
      if (c.region === 'global' && regionKind(x.id) !== 'global') return false;
      if (c.region === 'regional' && regionKind(x.id) !== 'regional') return false;
      if (f === 'finished' && ['claimed', 'completed', 'expired', 'old', 'gone'].indexOf(x.status) < 0) return false;
      if (query) {
        var hay = (x.name + ' ' + x.id + ' ' + x.reward + ' ' + x.app + ' ' + x.types.join(' ') + ' ' + regionHay(x.id)).toLowerCase();
        if (hay.indexOf(query.toLowerCase()) < 0) return false;
      }
      return true;
    });
    out.sort(function (a, b) {
      if (c.sortSoonest) {
        var ea = Number.isFinite(a.expMs) ? a.expMs : Infinity, eb = Number.isFinite(b.expMs) ? b.expMs : Infinity;
        if (ea !== eb) return ea - eb;
      }
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  // ---------- record what the server says to every accept (ours and Discord's own button) ----------
  var enrollLog = [];       // newest last, capped
  var viaPlugin = 0;        // > 0 while the plugin itself is sending an accept
  function recordEnroll(id, ok, text, src, sent) {
    enrollLog.push({ id: id, ok: ok, text: String(text).slice(0, 300), src: src, sent: sent || '', at: Date.now() });
    if (enrollLog.length > 12) enrollLog.shift();
  }
  // Remember a refusal so the quest leaves the live list: expired for a day, "not offered" for 30 minutes
  function markRefused(id, e) {
    var kind = refusalKind(e);
    if (!kind) return;
    var one = {}; one[id] = Date.now();
    (kind === 'gone' ? goneMap : lockedMap)[id] = one[id];
    if (kind === 'locked') learn(id, false);
    try { if (storageRef) storageRef.set(kind === 'gone' ? { gone: one } : { locked: one }).catch(function () {}); } catch (e2) {}
  }
  function bodyPreview(b) { try { return JSON.stringify(b).slice(0, 200); } catch (e) { return ''; } }

  // ---------- accepting ----------
  function httpModule() {
    var r = finders.lookupModule(finders.filters.withProps('HTTP'));
    var m = r && r[0];
    return m && isObj(m.HTTP) && typeof m.HTTP.post === 'function' ? m.HTTP : null;
  }
  function errText(e) {
    if (!isObj(e)) return 'Request failed.';
    var body = isObj(e.body) ? e.body : {};
    var st = typeof e.status === 'number' ? 'HTTP ' + e.status + ': ' : '';
    var m = typeof body.message === 'string' ? body.message : (typeof e.message === 'string' ? e.message : 'Request failed.');
    var code = typeof body.code === 'number' ? ' (code ' + body.code + ')' : '';
    return st + m + code;
  }
  // The accept request Discord's own button sends: POST /quests/{id}/enroll with a "location".
  // The server's reply carries enrolled_at, and that is the only thing counted as success.
  async function enrollOne(x) {
    var http = httpModule();
    if (!http) throw new Error('Discord\u2019s HTTP client was not found. Open the Quests screen once and retry.');
    var res;
    viaPlugin++;
    try { res = await http.post({ url: '/quests/' + encodeURIComponent(x.id) + '/enroll', body: { location: QUEST_HOME_MOBILE }, retries: 0 }); }
    finally { viaPlugin--; }
    if (isObj(res) && (res.ok === false || (typeof res.status === 'number' && res.status >= 400))) throw res;
    var body = isObj(res) && isObj(res.body) ? res.body : res;
    if (!isObj(body) || !(body.enrolled_at || body.enrolledAt)) throw new Error('Server reply had no enrolled_at, so this was not confirmed.');
    learn(x.id, true);
  }
  async function acceptList(list, setMsg) {
    var ok = 0, fail = [], okNames = [], lockedCount = 0, delay = cfgNow().acceptDelay;
    for (var i = 0; i < list.length; i++) {
      setMsg('Accepting ' + (i + 1) + '/' + list.length + ': ' + list[i].name + '...');
      try { await enrollOne(list[i]); ok++; okNames.push(list[i].name); }
      catch (e) {
        if (refusalKind(e) === 'locked') lockedCount++;
        fail.push(list[i].name + ' [' + errText(e) + ']');
        if (isObj(e) && e.status === 429) { fail.push('Rate limited, stopped.'); break; }
      }
      if (i < list.length - 1) await sleep(delay);
    }
    var m = enrollModule();
    if (m) { try { await m.fetchCurrentQuests(); } catch (e) {} }
    setMsg('Server confirmed ' + ok + '/' + list.length + (fail.length ? '. Failed: ' + fail.join('; ') : '.'));
    toast('QI_ACCEPT', ok + '/' + list.length + ' quests enrolled', ok === 0 && list.length > 0);
    try {
      var lines = [];
      if (okNames.length) lines.push('Accepted:\n' + okNames.slice(0, 8).map(function (n) { return '\u2022 ' + n; }).join('\n'));
      if (fail.length) lines.push('Refused:\n' + fail.slice(0, 5).map(function (n) { return '\u2022 ' + n; }).join('\n'));
      if (lockedCount) lines.push('Discord does not offer ' + (lockedCount === 1 ? 'this quest' : 'these quests') + ' in your region. Turn on a VPN in one of its countries, then tap \u201cRetry refused quests\u201d.');
      RN.Alert.alert(ok === list.length ? 'All ' + ok + ' accepted' : ok + ' of ' + list.length + ' accepted', lines.join('\n\n'));
    } catch (e) { /* the toast and the message row already said it */ }
  }

  // ---------- Discord's own Quests screen: optionally show hidden quests ----------
  // Keep the same merged object for the same hook result, so React consumers that put the
  // result in effect/memo deps don't see a brand-new object on every render.
  var mergedCache = new WeakMap();
  var skippedHidden = 0;   // hidden quests left out of the native list because a card can't render them
  function hasMessages(o) { return isObj(o) && isObj(o.messages); }
  function cardReady(q) {
    var cfg = isObj(q) && isObj(q.config) ? q.config : null;
    if (!cfg || !hasMessages(cfg)) return false;
    var rc = cfg.rewardsConfig || cfg.rewards_config;
    var rewards = isObj(rc) && Array.isArray(rc.rewards) ? rc.rewards : null;
    if (!rewards || rewards.length === 0) return false;
    for (var i = 0; i < rewards.length; i++) if (!hasMessages(rewards[i])) return false;
    return isObj(cfg.application);
  }
  // A hidden quest arrives as a stub. If the tracker has its config, build a full quest from it.
  function materialize(q) {
    if (!isObj(q)) return null;
    if (isObj(q.config) && hasMessages(q.config)) return q;
    var m = own(metaMap, q.id);
    if (!m) return null;
    return { id: q.id, config: m, userStatus: q.userStatus || q.user_status || null, preview: false, targetedContent: [] };
  }
  function mergeHidden(res) {
    if (!isObj(res) || !Array.isArray(res.quests) || !Array.isArray(res.excludedQuests) || res.excludedQuests.length === 0) return res;
    var hit = mergedCache.get(res);
    if (hit) return hit;
    var ids = new Set(res.quests.map(function (q) { return q && q.id; }));
    var skipped = 0, extra = [];
    res.excludedQuests.forEach(function (q) {
      if (!isObj(q) || ids.has(q.id)) return;
      var full = materialize(q);
      // Discord's QuestCard crashes on a quest that lacks the data it renders, so only merge complete ones
      if (!full || !cardReady(full)) { skipped++; return; }
      if (describe(full).status !== 'available' && describe(full).status !== 'enrolled') return;
      extra.push(full);
    });
    skippedHidden = skipped;
    if (extra.length === 0) return res;
    var merged = Object.assign({}, res, { quests: res.quests.concat(extra), excludedQuests: [] });
    mergedCache.set(res, merged);
    return merged;
  }

  // ---------- settings UI ----------
  // VPN links: a few built-in ones, plus whatever you type as "Name=https://link; Other=https://link"
  var VPN_DEFAULTS = [{ name: 'Proton VPN (free plan)', url: 'https://protonvpn.com/free-vpn' }, { name: 'Windscribe (free plan)', url: 'https://windscribe.com/' }];
  function parseVpns(str) {
    var out = VPN_DEFAULTS.slice();
    String(str || '').split(/[;\n]+/).forEach(function (part) {
      var m = /^\s*([^=]{1,40}?)\s*=\s*(https:\/\/[^\s]+)\s*$/.exec(part);
      if (!m) return;
      out = out.filter(function (v) { return v.name.toLowerCase() !== m[1].toLowerCase(); });
      out.push({ name: m[1], url: m[2] });
    });
    return out;
  }
  var STATUS_ICON = { available: '\uD83D\uDFE2', unverified: '\uD83D\uDFE1', enrolled: '\u2705', completed: '\uD83C\uDFC1', claimed: '\uD83C\uDF81', expired: '\u231B', gone: '\u231B', old: '\u231B', locked: '\uD83D\uDD12' };
  var STATUS_WORD = { available: 'available', unverified: 'unverified', enrolled: 'accepted', completed: 'completed', claimed: 'claimed', expired: 'expired', gone: 'expired', old: 'probably expired', locked: 'not offered to you' };
  function statusIcon(x) { return STATUS_ICON[x.status] || '\u2B1C'; }
  function statusWord(x) { return STATUS_WORD[x.status] || x.status; }
  function shortList(list, max) {
    var names = list.slice(0, max).map(function (x) { return '\u2022 ' + (x.known ? x.name : 'Quest ' + String(x.id).slice(-6)) + (x.reward ? ' (' + x.reward + ')' : ''); });
    if (list.length > max) names.push('\u2026and ' + (list.length - max) + ' more');
    return names.join('\n');
  }
  function cycle(list, cur) { return list[(list.indexOf(cur) + 1) % list.length]; }

  function Inspector(props) {
    var storage = props && props.api && props.api.jsonStorage;
    var stored = storage ? storage.use() : null;
    var c = Object.assign({}, DEFAULTS, stored);
    var tick = React.useState(0);
    var msgS = React.useState('');
    var qS = React.useState('');
    var busyS = React.useState(false);
    var setMsg = msgS[1];
    function set(p) { if (storage) storage.set(p).catch(function () { setMsg('Could not save setting.'); }); }

    React.useEffect(function () {
      var i = setInterval(function () { tick[1](function (t) { return t + 1; }); }, 4000);
      return function () { clearInterval(i); };
    }, []);

    var d = collect();
    var all = unify(d);
    var view = applyView(all, c, qS[0]);
    var live = all.filter(function (x) { return LIVE_STATUSES.indexOf(x.status) >= 0; });
    var liveHidden = live.filter(function (x) { return x.hidden; });
    var hiddenCount = all.filter(function (x) { return x.hidden; }).length;
    var hasHttp = !!httpModule();
    var cc = countryCounts(liveHidden);
    function showCountries() {
      var lines = cc.top.map(function (code) { return flag(code, true) + ': ' + cc.counts[code]; });
      if (cc.globalN) lines.push('\uD83C\uDF10 global: ' + cc.globalN);
      if (cc.open) lines.push('limited only by an exclude list (open to most countries): ' + cc.open);
      if (cc.unknown) lines.push('region unknown: ' + cc.unknown);
      RN.Alert.alert('Live hidden quests by country', lines.length ? lines.join('\n') : 'Nothing to count yet.');
    }
    var lockedN = all.filter(function (x) { return x.status === 'locked'; }).length;
    var goneN = all.filter(function (x) { return x.status === 'gone'; }).length;
    var stubCount = all.filter(function (x) { return !x.known; }).length;
    var TI = V.components.SearchInput || Design.TextInput || RN.TextInput;
    function onText(x) { qS[1](typeof x === 'string' ? x : ((x && x.nativeEvent && x.nativeEvent.text) || '')); }

    function confirmAccept(list, title) {
      if (busyS[0]) { setMsg('Already accepting, please wait.'); return; }
      if (list.length === 0) {
        setMsg('Nothing to accept. ' + (lockedN ? lockedN + ' quest(s) were refused by Discord as unknown, which usually means they are not offered to your region or account. ' : '') + (goneN ? goneN + ' have expired. ' : '') + 'Tap \u201cRetry refused quests\u201d after changing region.');
        return;
      }
      RN.Alert.alert(title, shortList(list, 8) + '\n\nEach one is only counted if Discord confirms it.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept', onPress: function () { busyS[1](true); acceptList(list, setMsg).finally(function () { busyS[1](false); }); } }
      ]);
    }
    function openQuest(x) {
      var buttons = [];
      if (LIVE_STATUSES.indexOf(x.status) >= 0 || x.status === 'locked') buttons.push({ text: x.status === 'locked' ? 'Try accept anyway' : 'Accept', onPress: function () { acceptList([x], setMsg); } });
      buttons.push({ text: 'Open in Discord', onPress: function () { RN.Linking.openURL('https://discord.com/quests/' + encodeURIComponent(x.id)); } });
      buttons.push({ text: 'Copy JSON', onPress: function () { copyText(safe(x.q), setMsg); } });
      RN.Alert.alert(statusIcon(x) + ' ' + (x.known ? x.name : 'Quest ' + x.id), [statusWord(x) + (x.status === 'locked' ? ' (Discord says unknown quest)' : x.status === 'unverified' ? ' (no details yet)' : ''), x.reward ? 'Reward: ' + x.reward : '', x.app ? 'Game: ' + x.app : '', timeLeft(x.expMs), regionLabel(x.id, true), x.hidden ? 'Hidden: ' + hiddenReason(x) : ''].filter(Boolean).join('\n'), buttons);
    }
    var regionAge = regionsAt ? Math.max(0, Math.round((Date.now() - regionsAt) / 3600000)) + 'h ago' : 'never';

    // what the user should do next, in one sentence
    var lockedList = all.filter(function (x) { return x.status === 'locked' || (x.hidden && LIVE_STATUSES.indexOf(x.status) >= 0 && access(x.id) === 'no'); });
    var ccLocked = countryCounts(lockedList);
    var vpnTop = ccLocked.top.slice(0, 3);
    function vpnHelp() {
      var lines = ccLocked.top.slice(0, 8).map(function (code) { return flag(code, true) + ': unlocks ' + ccLocked.counts[code] + ' quest' + (ccLocked.counts[code] === 1 ? '' : 's'); });
      RN.Alert.alert('Quests your region does not get', (lines.length ? lines.join('\n') + '\n\n' : '') +
        '1. Turn on a VPN app set to the country with the most quests (a split-tunnel for Discord is enough).\n2. Come back here and tap “Retry refused quests”.\n3. Tap “Accept all live hidden”.\n\nThe VPN can be turned off again after accepting.');
    }
    var next;
    if (!d.storeFound) next = { label: 'Open Discord’s Quests screen once', sub: 'The plugin needs it to load before it can list anything.' };
    else if (lockedN && !liveHidden.length) next = { label: lockedN + ' quest' + (lockedN === 1 ? '' : 's') + ' not offered in your region', sub: (vpnTop.length ? 'Best VPN country: ' + vpnTop.map(function (k) { return flag(k) + ' ' + ccLocked.counts[k]; }).join('  ') + '. ' : '') + 'Tap for the steps.', press: vpnHelp };
    else if (liveHidden.length) next = { label: liveHidden.length + ' hidden quest' + (liveHidden.length === 1 ? ' is' : 's are') + ' ready to accept', sub: 'Tap to accept them all.', press: function () { confirmAccept(liveHidden, 'Accept ' + liveHidden.length + ' hidden quests?'); } };
    else next = { label: 'Nothing hidden is live right now', sub: 'You will get an alert when a new quest appears.' };
    var q = qS[0];
    var vpnList = parseVpns(c.vpns);
    function onVpns(x) { set({ vpns: typeof x === 'string' ? x : ((x && x.nativeEvent && x.nativeEvent.text) || '') }); }

    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 24 } },
      h(V.components.Page, null,
        h(Design.TableRowGroup, { title: 'Next step' },
          h(Design.TableRow, { label: next.label, subLabel: next.sub, onPress: next.press }),
          !!msgS[0] && h(Design.TableRow, { label: msgS[0], onPress: function () { setMsg(''); }, subLabel: 'Tap to dismiss.' })),

        h(Design.TableRowGroup, { title: 'Accept' },
          h(Design.TableRow, {
            label: 'Accept all live hidden (' + liveHidden.length + ')',
            subLabel: 'Hidden quests that are available now. Skips expired, accepted and finished ones.',
            onPress: function () { confirmAccept(liveHidden, 'Accept ' + liveHidden.length + ' hidden quests?'); }
          }),
          h(Design.TableRow, {
            label: 'Accept all available (' + live.length + ')',
            subLabel: 'Every quest you have not accepted yet, hidden or not.',
            onPress: function () { confirmAccept(live, 'Accept ' + live.length + ' quests?'); }
          }),
          h(Design.TableRow, {
            label: 'Retry refused quests' + (lockedN + goneN ? ' (' + (lockedN + goneN) + ')' : ''),
            subLabel: 'Forget what Discord refused so it is checked again, e.g. after turning a VPN on or off.',
            onPress: function () { goneMap = {}; lockedMap = {}; probeNextAt = 0; setMsg('Cleared. Refreshing...'); var m = enrollModule(); Promise.resolve(m && m.fetchCurrentQuests()).then(function () { return loadProbe(); }).then(function () { setMsg('Checked again: ' + probeStatus); }, function () { setMsg('Cleared. Pull to refresh the Quests screen.'); }); }
          }),
          !!lockedN && h(Design.TableRow, { label: 'Why are some refused?', subLabel: 'Discord does not offer them in your region. Tap for what to do.', onPress: vpnHelp })),

        // inputs go straight in the Page (like Valenced's own plugins), not inside a TableRowGroup
        h(TI, { value: q, placeholder: 'Search name, reward, game, type, country code', size: 'md', onChange: onText, onChangeText: onText }),
        h(Design.TableRowGroup, { title: 'Quests (' + view.length + ' of ' + all.length + ')' },
          h(Design.TableRow, (function () {
            if (userRegion.from === 'ip') return { label: 'Your country: ' + flag(ipCountry.cc) + ' ' + ipCountry.cc, subLabel: 'From your IP, so it follows a VPN. ' + (userRegion.guess.length && userRegion.guess.indexOf(ipCountry.cc) < 0 ? 'The quests Discord shows you point to ' + flags(userRegion.guess, 3) + ', so Discord may see you elsewhere. ' : '') + 'Tap to check again.', onPress: function () { setMsg('Checking your country...'); detectCountry(true).then(function () { setMsg(ipCountry.cc ? 'You are in ' + ipCountry.cc + '.' : 'Country check ' + ipCountry.status); }); } };
            if (userRegion.codes.length) return { label: 'Your region: ' + flags(userRegion.codes, 4) + ' (' + userRegion.codes.join(', ') + ')', subLabel: 'Guessed from the ' + userRegion.n + ' region-limited quests Discord shows you. Tap to try your IP instead.', onPress: function () { detectCountry(true).then(function () { setMsg(ipCountry.cc ? 'You are in ' + ipCountry.cc + '.' : 'Country check ' + ipCountry.status); }); } };
            return { label: 'Your country: not known yet', subLabel: (c.detectIp ? 'IP check ' + ipCountry.status + '. ' : 'IP check is off in Options. ') + 'Tap to try.', onPress: function () { detectCountry(true).then(function () { setMsg(ipCountry.cc ? 'You are in ' + ipCountry.cc + '.' : 'Country check ' + ipCountry.status); }); } };
          })()),
          h(Design.TableRow, { label: 'Show: ' + c.filter + ' (' + view.length + ')', subLabel: 'Tap to change. Next: ' + cycle(FILTERS, c.filter) + '. All options: ' + FILTERS.join(', ') + '.', onPress: function () { set({ filter: cycle(FILTERS, c.filter) }); } }),
          h(Design.TableRow, { label: 'Region: ' + c.region, subLabel: 'Tap to change: ' + REGION_FILTERS.join(' / ') + '. You can also search a country code like US or IQ.', onPress: function () { set({ region: cycle(REGION_FILTERS, c.region) }); } }),
          cc.top.length > 0 && h(Design.TableRow, {
            label: 'Unlock by country: ' + cc.top.slice(0, 4).map(function (code) { return flag(code) + ' ' + cc.counts[code]; }).join('  '),
            subLabel: 'Live hidden quests each country would show you. Tap for the full list.',
            onPress: showCountries
          }),
          view.length === 0
            ? h(Design.TableRow, { label: q ? 'No quests match “' + q + '”' : 'No quests in this view', subLabel: q ? 'Clear the search or change “Show”.' : 'Try “Show: all”.' })
            : view.map(function (x) {
                var types = x.types.map(function (t) { return TYPE_LABELS[t] || t.toLowerCase(); }).join(', ');
                var left = x.status === 'expired' || x.status === 'gone' || x.status === 'old' ? '' : timeLeft(x.expMs);
                return h(Design.TableRow, {
                  key: x.id, label: statusIcon(x) + ' ' + (x.known ? x.name : 'Quest ' + String(x.id).slice(-8)),
                  subLabel: [statusWord(x), x.reward, left, regionLabel(x.id), x.app, types, x.hidden && x.status !== 'locked' ? 'hidden' : '', Number.isFinite(x.progress) && x.status === 'enrolled' ? x.progress + '% done' : ''].filter(Boolean).join(' \u00b7 '),
                  onPress: function () { openQuest(x); }
                });
              })),

        h(Design.TableRowGroup, { title: 'VPN apps' },
          h(Design.TableRow, { label: vpnTop.length ? 'Best country now: ' + vpnTop.map(function (k) { return flag(k) + ' ' + k; }).join('  ') : 'Pick a country that unlocks the most quests', subLabel: 'Switch the VPN to it, and the plugin notices and re-checks by itself.', onPress: vpnHelp }),
          vpnList.map(function (v) { return h(Design.TableRow, { key: v.name, label: v.name, subLabel: v.url.replace(/^https:\/\//, ''), onPress: function () { RN.Linking.openURL(v.url).catch(function () { setMsg('Could not open ' + v.url); }); } }); }),
          h(TI, { value: c.vpns, placeholder: 'Add your own: Name=https://link; Other=https://link', size: 'md', onChange: onVpns, onChangeText: onVpns })),

        h(Design.TableRowGroup, { title: 'Options' },
          h(Design.TableSwitchRow, { label: 'Show live hidden quests in Discord’s Quests screen', subLabel: 'Adds hidden quests that are available or accepted to the native list. Reload after changing.', value: !!c.showHidden, onValueChange: function (v) { set({ showHidden: v }); } }),
          h(Design.TableSwitchRow, { label: 'Find my country from my IP', subLabel: 'Asks api.country.is (then ipwho.is) which country your connection is in. Nothing else is sent.', value: !!c.detectIp, onValueChange: function (v) { set({ detectIp: v }); if (v) detectCountry(true); } }),
          h(Design.TableSwitchRow, { label: 'Alert me about new quests', subLabel: 'Says when a new quest is a hidden one.', value: !!c.alertNew, onValueChange: function (v) { set({ alertNew: v }); } }),
          h(Design.TableSwitchRow, { label: 'Soonest-expiring first', value: !!c.sortSoonest, onValueChange: function (v) { set({ sortSoonest: v }); } }),
          h(Design.TableSwitchRow, { label: 'Download quest names automatically', subLabel: 'About 5 MB from GitHub, at most every 6 hours, only when hidden quests have no details.', value: !!c.autoMeta, onValueChange: function (v) { set({ autoMeta: v }); } }),
          h(Design.TableSwitchRow, { label: 'Check hidden quests with Discord', subLabel: 'Small, spaced-out requests that confirm a quest is still active.', value: !!c.autoProbe, onValueChange: function (v) { set({ autoProbe: v }); } }),
          h(Design.TableRow, { label: 'Delay between accepts: ' + (c.acceptDelay / 1000) + 's', subLabel: 'Tap to change: 1s / 1.5s / 3s / 5s.', onPress: function () { set({ acceptDelay: cycle([1000, 1500, 3000, 5000], c.acceptDelay) }); } })),

        h(Design.TableRowGroup, { title: 'Details and tools' },
          h(Design.TableRow, { label: all.length + ' quests: ' + live.length + ' available, ' + hiddenCount + ' hidden by client' + (lockedN ? ', ' + lockedN + ' not offered' : '') + (goneN ? ', ' + goneN + ' expired' : '') }),
          h(Design.TableRow, { label: 'Names: ' + (all.length - stubCount) + ' of ' + all.length + ' have details' + (stubCount ? ' (' + stubCount + ' only an id)' : ''), subLabel: 'From a community tracker (' + metaStatus + '). Quests newer than it stay as ids. Tap to download.', onPress: function () { setMsg('Downloading quest details...'); loadMeta(true).then(function (okM) { setMsg(okM ? 'Quest details updated.' : 'Quest details: ' + metaStatus); }); } }),
          h(Design.TableRow, { label: 'Regions: ' + regionStatus, subLabel: 'Updated ' + regionAge + '. Community list, may be out of date. Tap to refresh.', onPress: function () { setMsg('Updating regions...'); loadRegions(true).then(function (okR) { setMsg(okR ? 'Regions updated.' : 'Regions: ' + regionStatus); }); } }),
          h(Design.TableRow, { label: 'Live check: ' + probeStatus, subLabel: 'Asks Discord if each hidden quest is still active (newest 25 at a time). Tap to run now.', onPress: function () { setMsg('Checking with Discord...'); loadProbe().then(function () { setMsg('Live check: ' + probeStatus); }); } }),
          h(Design.TableRow, (function () {
            var e = enrollLog[enrollLog.length - 1];
            if (!e) return { label: 'Last accept: none yet', subLabel: 'Every accept, including Discord’s own button, is recorded here with the server’s answer.' };
            var qq = all.filter(function (x) { return x.id === e.id; })[0];
            return {
              label: 'Last accept: ' + (e.ok ? 'worked' : 'refused') + ' · ' + (qq && qq.known ? qq.name : e.id) + ' · ' + e.src,
              subLabel: e.text + (e.sent ? ' (sent ' + e.sent + ')' : '') + '. Tap to copy the last ' + enrollLog.length + '.',
              onPress: function () { copyText(JSON.stringify(enrollLog.map(function (z) { return { id: z.id, ok: z.ok, by: z.src, reply: z.text, sent: z.sent, secondsAgo: Math.round((Date.now() - z.at) / 1000) }; }), null, 2), setMsg); }
            };
          })()),
          !!skippedHidden && h(Design.TableRow, { label: skippedHidden + ' hidden quest(s) not added to Discord’s list', subLabel: 'No details for them yet, so Discord’s quest card could not draw them.' }),
          (!d.storeFound || !hasHttp) && h(Design.TableRow, { label: (d.storeFound ? '' : 'Quest store NOT found. ') + (hasHttp ? '' : 'Discord HTTP client NOT found.'), subLabel: 'Open Discord’s Quests screen once, then come back.' }),
          h(Design.TableRow, {
            label: 'Refresh quests from Discord',
            onPress: function () {
              var m = enrollModule();
              if (!m) { setMsg('fetchCurrentQuests not found.'); return; }
              Promise.resolve(m.fetchCurrentQuests()).then(function () { setMsg('Refreshed.'); }, function () { setMsg('Refresh failed.'); });
            }
          }),
          h(Design.TableRow, { label: 'Copy everything as JSON', subLabel: 'Raw quests plus store/hook keys, for bug reports.', onPress: function () { copyText(safe(d), setMsg); } }))));
  }

  // ---------- plugin ----------
  exports.default = plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start: function (ctx) {
      var cleanup = ctx.cleanup;
      storageRef = ctx.jsonStorage;
      if (ctx.plugin.startedLate) { ctx.plugin.requireReload(); return; }

      // observe Discord's quest hooks; optionally merge hidden quests into the native list
      cleanup(finders.getModules(
        finders.filters.withProps('useFilteredQuests', 'useClaimedQuests'),
        function (mod) {
          ['useFilteredQuests', 'useClaimedQuests'].forEach(function (name) {
            cleanup(V.patcher.instead(mod, name, function (args, orig) {
              var res = Reflect.apply(orig, this, args);
              lastHook[name] = res;
              if (name === 'useFilteredQuests' && cfgNow().showHidden) {
                try { return mergeHidden(res); } catch (e) { ctx.plugin.reportError(e); }
              }
              return res;
            }));
          });
        },
        { max: Infinity }
      ));

      // Watch accept requests (read-only: the original call always runs unchanged and its result is returned as is)
      var httpPatched = false;
      function patchHttp() {
        if (httpPatched) return;
        try {
          var http = httpModule();
          if (!http) return;
          httpPatched = true;
          cleanup(V.patcher.instead(http, 'post', function (args, orig) {
            var p = Reflect.apply(orig, this, args);
            try {
              var o = args[0];
              var m = isObj(o) && typeof o.url === 'string' ? /\/quests\/(\d{5,25})\/enroll\b/.exec(o.url) : null;
              if (m) {
                var id = m[1], src = viaPlugin > 0 ? 'plugin' : 'Discord', sent = bodyPreview(o.body);
                Promise.resolve(p).then(function (r) {
                  recordEnroll(id, true, 'HTTP ' + (isObj(r) && r.status ? r.status : 'ok') + ' ' + bodyPreview(isObj(r) ? r.body : ''), src, sent);
                }, function (e) { recordEnroll(id, false, errText(e), src, sent); markRefused(id, e); });
              }
            } catch (e) { /* never let logging break a request */ }
            return p;
          }));
        } catch (e) { ctx.plugin.reportError(e); }
      }
      patchHttp();

      // new-quest alerts
      var seenMemo = null;
      function check() {
        try {
          if (RN.AppState.currentState !== 'active') return;
          var c = cfgNow();
          if (!c.alertNew) return;
          var quests = unify(collect());
          if (quests.length === 0) return;
          if (!seenMemo) seenMemo = new Set(c.seen);
          var fresh = quests.filter(function (x) { return !seenMemo.has(x.id); });
          if (fresh.length === 0) return;
          fresh.forEach(function (x) { seenMemo.add(x.id); });
          if (c.seeded) {
            var shown = 0;
            fresh.forEach(function (d) {
              if (['expired', 'claimed', 'completed'].indexOf(d.status) >= 0) return;
              var rl = regionLabel(d.id);
              if (shown++ < 3) toast('QI_NEW_' + d.id, (d.hidden ? 'New hidden quest: ' : 'New quest: ') + (d.known ? d.name : 'no details yet') + (d.reward ? ' (' + d.reward + ')' : '') + (rl ? ' ' + rl : ''));
            });
            if (shown > 3) toast('QI_NEW_MORE', '+' + (shown - 3) + ' more new quests');
          }
          ctx.jsonStorage.set({ seeded: true, seen: Array.from(seenMemo).slice(-500) }).catch(function () {});
        } catch (e) { ctx.plugin.reportError(e); }
      }
      var timer = null;
      Promise.resolve(ctx.jsonStorage.get()).catch(function () {}).then(function () {
        var cs = cfgNow();
        if (isObj(cs.regions) && Object.keys(cs.regions).length) setRegions(cs.regions, Number(cs.regionsAt) || 0);
        if (isObj(cs.meta) && Object.keys(cs.meta).length) setMeta(cs.meta, Number(cs.metaAt) || 0);
        if (isObj(cs.gone)) Object.keys(cs.gone).forEach(function (k) { if (/^\d{5,25}$/.test(k) && typeof cs.gone[k] === 'number') goneMap[k] = cs.gone[k]; });
        if (isObj(cs.locked)) Object.keys(cs.locked).forEach(function (k) { if (/^\d{5,25}$/.test(k) && typeof cs.locked[k] === 'number') lockedMap[k] = cs.locked[k]; });
        if (isObj(cs.learned)) Object.keys(cs.learned).forEach(function (k) { var r = cs.learned[k]; if (/^\d{5,25}$/.test(k) && isObj(r) && Array.isArray(r.y) && Array.isArray(r.n)) learnedMap[k] = { y: codeList(r.y), n: codeList(r.n) }; });
        loadRegions(false);
        if (cs.detectIp) detectCountry(true);
        timer = setInterval(function () { patchHttp(); if (RN.AppState.currentState === 'active') { if (cfgNow().detectIp) detectCountry(false); maybeMeta(); maybeProbe(); } check(); }, 8000);
        check();
      });
      cleanup(function () { if (timer) clearInterval(timer); });
    },
    SettingsComponent: Inspector
  });
  return exports;
})({});
