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
    acceptDelay: 1500,   // ms between "Accept all" requests
    seeded: false,
    seen: []
  };
  var FILTERS = ['live hidden', 'all', 'available', 'enrolled', 'hidden', 'finished'];
  var REGION_FILTERS = ['any', 'global', 'regional'];
  // Third-party, community-kept list of which countries each quest is limited to. It is only used
  // for display, can be out of date, and the plugin works without it.
  var REGIONS_URL = 'https://gist.githubusercontent.com/xGustavvo/3d08b7369eb34b50834815fd43176cae/raw';
  var REGIONS_TTL = 6 * 3600 * 1000;
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
  function regionLabel(id, long) {
    var r = regionFor(id);
    if (!r) return regionsAt ? '\u2754 region unknown' : '';
    var age = r.a ? ' \uD83D\uDD1E' : '';
    if (r.g) return '\uD83C\uDF10 global' + age;
    var parts = [];
    if (r.i.length) parts.push('only ' + flags(r.i, long ? 99 : 6, long));
    if (r.e.length) parts.push('not ' + flags(r.e, long ? 99 : 6, long));
    if (!parts.length) parts.push('\uD83D\uDD12 region-limited');
    return parts.join(' \u00b7 ') + age;
  }
  function regionHay(id) {
    var r = regionFor(id);
    return r ? (r.g ? 'global' : 'regional ' + r.i.concat(r.e).join(' ')) : '';
  }
  function hiddenReason(x) {
    var why = [];
    if (regionKind(x.id) === 'regional') why.push('region-limited');
    if (x.types.length && x.types.every(function (t) { return DESKTOP_ONLY.indexOf(t) >= 0; })) why.push('needs desktop/console');
    return why.length ? 'likely ' + why.join(' + ') : 'reason unknown';
  }

  // ---------- reading quest objects (field names defensive; verify with the JSON export) ----------
  function describe(q) {
    var out = { id: '', name: 'unknown', status: 'available', types: [], expMs: NaN, reward: '', app: '', progress: NaN };
    if (!isObj(q)) return out;
    var cfg = isObj(q.config) ? q.config : {};
    var msgs = isObj(cfg.messages) ? cfg.messages : {};
    var us = isObj(q.userStatus) ? q.userStatus : (isObj(q.user_status) ? q.user_status : {});
    var tc = cfg.taskConfigV2 || cfg.task_config_v2 || cfg.taskConfig || cfg.task_config;
    var rc = cfg.rewardsConfig || cfg.rewards_config;
    var rw = isObj(rc) && Array.isArray(rc.rewards) && isObj(rc.rewards[0]) ? rc.rewards[0] : null;
    var rm = rw && isObj(rw.messages) ? rw.messages : {};
    out.id = typeof q.id === 'string' ? q.id : '';
    out.name = msgs.questName || msgs.quest_name || out.id || 'unknown';
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
    return Array.from(map.values()).map(function (e) {
      var info = describe(e.q);
      info.q = e.q;
      info.hidden = !!e.flags.excluded && !e.flags.shown;
      return info;
    });
  }

  function applyView(list, c, query) {
    var out = list.filter(function (x) {
      var f = c.filter;
      if (f === 'available' && x.status !== 'available') return false;
      if (f === 'enrolled' && x.status !== 'enrolled') return false;
      if (f === 'hidden' && !x.hidden) return false;
      if (f === 'live hidden' && !(x.hidden && (x.status === 'available' || x.status === 'enrolled'))) return false;
      if (c.region === 'global' && regionKind(x.id) !== 'global') return false;
      if (c.region === 'regional' && regionKind(x.id) !== 'regional') return false;
      if (f === 'finished' && ['claimed', 'completed', 'expired'].indexOf(x.status) < 0) return false;
      if (query) {
        var hay = (x.name + ' ' + x.reward + ' ' + x.app + ' ' + x.types.join(' ') + ' ' + regionHay(x.id)).toLowerCase();
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
    var res = await http.post({ url: '/quests/' + encodeURIComponent(x.id) + '/enroll', body: { location: QUEST_HOME_MOBILE }, retries: 0 });
    if (isObj(res) && (res.ok === false || (typeof res.status === 'number' && res.status >= 400))) throw res;
    var body = isObj(res) && isObj(res.body) ? res.body : res;
    if (!isObj(body) || !(body.enrolled_at || body.enrolledAt)) throw new Error('Server reply had no enrolled_at, so this was not confirmed.');
  }
  async function acceptList(list, setMsg) {
    var ok = 0, fail = [], delay = cfgNow().acceptDelay;
    for (var i = 0; i < list.length; i++) {
      setMsg('Accepting ' + (i + 1) + '/' + list.length + ': ' + list[i].name + '...');
      try { await enrollOne(list[i]); ok++; }
      catch (e) {
        fail.push(list[i].name + ' [' + errText(e) + ']');
        if (isObj(e) && e.status === 429) { fail.push('Rate limited, stopped.'); break; }
      }
      if (i < list.length - 1) await sleep(delay);
    }
    var m = enrollModule();
    if (m) { try { await m.fetchCurrentQuests(); } catch (e) {} }
    setMsg('Server confirmed ' + ok + '/' + list.length + (fail.length ? '. Failed: ' + fail.join('; ') : '.'));
    toast('QI_ACCEPT', ok + '/' + list.length + ' quests enrolled', ok === 0 && list.length > 0);
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
  function mergeHidden(res) {
    if (!isObj(res) || !Array.isArray(res.quests) || !Array.isArray(res.excludedQuests) || res.excludedQuests.length === 0) return res;
    var hit = mergedCache.get(res);
    if (hit) return hit;
    var ids = new Set(res.quests.map(function (q) { return q && q.id; }));
    var skipped = 0;
    var extra = res.excludedQuests.filter(function (q) {
      if (!isObj(q) || ids.has(q.id)) return false;
      // only quests that are live right now: not expired, claimed or completed
      var st = describe(q).status;
      if (st !== 'available' && st !== 'enrolled') return false;
      // Discord's QuestCard crashes (e.g. "Cannot read property 'messages' of undefined") on a quest
      // that lacks the data it renders, so only merge quests that have all of it.
      if (!cardReady(q)) { skipped++; return false; }
      return true;
    });
    skippedHidden = skipped;
    if (extra.length === 0) return res;
    var merged = Object.assign({}, res, { quests: res.quests.concat(extra), excludedQuests: [] });
    mergedCache.set(res, merged);
    return merged;
  }

  // ---------- settings UI ----------
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
    var live = all.filter(function (x) { return x.status === 'available'; });
    var liveHidden = live.filter(function (x) { return x.hidden; });
    var hiddenCount = all.filter(function (x) { return x.hidden; }).length;
    var hasHttp = !!httpModule();
    var TI = V.components.SearchInput || Design.TextInput || RN.TextInput;
    function onText(x) { qS[1](typeof x === 'string' ? x : ((x && x.nativeEvent && x.nativeEvent.text) || '')); }

    function confirmAccept(list, title) {
      if (busyS[0] || list.length === 0) return;
      RN.Alert.alert(title, 'Each request goes to Discord and is only counted if the server confirms it.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept', onPress: function () { busyS[1](true); acceptList(list, setMsg).finally(function () { busyS[1](false); }); } }
      ]);
    }
    function openQuest(x) {
      var buttons = [];
      if (x.status === 'available') buttons.push({ text: 'Accept', onPress: function () { acceptList([x], setMsg); } });
      buttons.push({ text: 'Open in Discord', onPress: function () { RN.Linking.openURL('https://discord.com/quests/' + encodeURIComponent(x.id)); } });
      buttons.push({ text: 'Copy JSON', onPress: function () { copyText(safe(x.q), setMsg); } });
      RN.Alert.alert(x.name, [x.status, x.hidden ? 'hidden: ' + hiddenReason(x) : '', regionLabel(x.id, true), x.reward ? 'reward: ' + x.reward : '', timeLeft(x.expMs)].filter(Boolean).join('\n'), buttons);
    }
    var regionAge = regionsAt ? Math.max(0, Math.round((Date.now() - regionsAt) / 3600000)) + 'h ago' : 'never';

    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 24 } },
      h(V.components.Page, null,
        h(Design.TableRowGroup, { title: 'Status' },
          h(Design.TableRow, { label: d.storeFound ? 'Quest store found' : 'Quest store NOT found', subLabel: 'Open Discord\u2019s Quests screen once so everything loads.' }),
          h(Design.TableRow, { label: all.length + ' quests: ' + live.length + ' available, ' + hiddenCount + ' hidden by client (' + liveHidden.length + ' hidden and available)' }),
          !!skippedHidden && h(Design.TableRow, { label: skippedHidden + ' hidden quest(s) not merged into Discord\u2019s list', subLabel: 'They are missing data Discord\u2019s quest card needs. They are still listed below.' }),
          h(Design.TableRow, { label: hasHttp ? 'Accept: Discord HTTP client found' : 'Accept: Discord HTTP client NOT found', subLabel: 'Open the Quests screen once if it is missing.' }),
          h(Design.TableRow, { label: 'Regions: ' + regionStatus, subLabel: 'Updated ' + regionAge + '. Community list, may be out of date. Tap to refresh.', onPress: function () { setMsg('Updating regions...'); loadRegions(true).then(function (okR) { setMsg(okR ? 'Regions updated.' : 'Regions: ' + regionStatus); }); } }),
          !!msgS[0] && h(Design.TableRow, { label: msgS[0] })),

        h(Design.TableRowGroup, { title: 'Options' },
          h(Design.TableSwitchRow, { label: 'Show live hidden quests in Discord\u2019s Quests screen', subLabel: 'Adds hidden quests that are available or accepted to the native list. Reload after changing.', value: !!c.showHidden, onValueChange: function (v) { set({ showHidden: v }); } }),
          h(Design.TableSwitchRow, { label: 'Alert me about new quests', subLabel: 'Says when a new quest is a hidden one.', value: !!c.alertNew, onValueChange: function (v) { set({ alertNew: v }); } }),
          h(Design.TableSwitchRow, { label: 'Soonest-expiring first', value: !!c.sortSoonest, onValueChange: function (v) { set({ sortSoonest: v }); } }),
          h(Design.TableRow, { label: 'Delay between accepts: ' + (c.acceptDelay / 1000) + 's', subLabel: 'Tap to cycle 1s / 1.5s / 3s / 5s.', onPress: function () { set({ acceptDelay: cycle([1000, 1500, 3000, 5000], c.acceptDelay) }); } })),

        h(Design.TableRowGroup, { title: 'Actions' },
          h(Design.TableRow, {
            label: 'Accept all live hidden (' + liveHidden.length + ')',
            subLabel: 'Only hidden quests that are available now. Skips expired, accepted and finished ones.',
            onPress: function () { confirmAccept(liveHidden, 'Accept ' + liveHidden.length + ' hidden quests?'); }
          }),
          h(Design.TableRow, {
            label: 'Accept all available (' + live.length + ')',
            subLabel: 'Every quest you have not accepted yet, hidden or not.',
            onPress: function () { confirmAccept(live, 'Accept ' + live.length + ' quests?'); }
          }),
          h(Design.TableRow, {
            label: 'Refresh quests from Discord',
            onPress: function () {
              var m = enrollModule();
              if (!m) { setMsg('fetchCurrentQuests not found.'); return; }
              Promise.resolve(m.fetchCurrentQuests()).then(function () { setMsg('Refreshed.'); }, function () { setMsg('Refresh failed.'); });
            }
          }),
          h(Design.TableRow, { label: 'Copy everything as JSON', subLabel: 'Raw quests plus store/hook keys, copied to the clipboard.', onPress: function () { copyText(safe(d), setMsg); } })),

        // inputs go straight in the Page (like Valenced's own plugins), not inside a TableRowGroup
        h(TI, { value: qS[0], placeholder: 'Search name, reward, game, type, country code', size: 'md', onChange: onText, onChangeText: onText }),
        h(Design.TableRowGroup, { title: 'Find' },
          h(Design.TableRow, { label: 'Filter: ' + c.filter, subLabel: 'Tap to cycle: ' + FILTERS.join(' / '), onPress: function () { set({ filter: cycle(FILTERS, c.filter) }); } }),
          h(Design.TableRow, { label: 'Region: ' + c.region, subLabel: 'Tap to cycle: ' + REGION_FILTERS.join(' / ') + '. You can also search a code like US or IQ.', onPress: function () { set({ region: cycle(REGION_FILTERS, c.region) }); } })),

        h(Design.TableRowGroup, { title: 'Quests (' + view.length + ')' },
          view.length === 0
            ? h(Design.TableRow, { label: 'No matching quests' })
            : view.map(function (x) {
                var types = x.types.map(function (t) { return TYPE_LABELS[t] || t.toLowerCase(); }).join(', ');
                return h(Design.TableRow, {
                  key: x.id, label: x.name,
                  subLabel: [x.status, x.hidden ? 'hidden (' + hiddenReason(x) + ')' : '', regionLabel(x.id), types, x.reward ? 'reward: ' + x.reward : '', Number.isFinite(x.progress) && x.status === 'enrolled' ? x.progress + '%' : '', timeLeft(x.expMs)].filter(Boolean).join(' \u00b7 '),
                  onPress: function () { openQuest(x); }
                });
              }))));
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
              if (shown++ < 3) toast('QI_NEW_' + d.id, (d.hidden ? 'New hidden quest: ' : 'New quest: ') + d.name + (d.reward ? ' (' + d.reward + ')' : '') + (rl ? ' ' + rl : ''));
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
        loadRegions(false);
        timer = setInterval(check, 8000);
        check();
      });
      cleanup(function () { if (timer) clearInterval(timer); });
    },
    SettingsComponent: Inspector
  });
  return exports;
})({});
