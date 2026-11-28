  // ---------- load the quest list ourselves, so the Quests screen never has to be opened ----------
  // GET /quests/@me is the request Discord's own Quests screen makes. Its answer has the visible quests and
  // `excluded_quests` (the hidden stubs), so the plugin can list everything on its own.
  var SELF_TTL = 15 * 60 * 1000, SELF_TTL_ACTIVE = 3 * 60 * 1000;   // reload faster while a quest is in progress, to notice when it finishes
  var selfActive = false;
  var backoffUntil = 0;   // after Discord answers 429 (too many requests) the plugin stops asking for a while
  var backoffLevel = 0, lastLimitAt = 0;
  // Honour Discord's own "retry after" when it gives one; otherwise wait 5 min, doubling (up to 1 hour) while it keeps happening.
  function rateLimited(e) {
    if (!isObj(e) || e.status !== 429) return false;
    var now = Date.now();
    backoffLevel = now - lastLimitAt < 3600000 ? Math.min(backoffLevel + 1, 4) : 1;
    lastLimitAt = now;
    var ra = isObj(e.body) ? Number(e.body.retry_after !== undefined ? e.body.retry_after : e.body.retryAfter) : NaN;
    var wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 + 2000 : 5 * 60000 * Math.pow(2, backoffLevel - 1);
    backoffUntil = now + Math.max(30000, Math.min(wait, 3600000)) + Math.floor(Math.random() * 5000);
    return true;
  }
  // how many requests the plugin itself sent to Discord in the last hour (shown in the settings)
  var sentLog = [];
  function tally() { var now = Date.now(); sentLog.push(now); while (sentLog.length && now - sentLog[0] > 3600000) sentLog.shift(); }
  function sentLastHour() { var now = Date.now(); while (sentLog.length && now - sentLog[0] > 3600000) sentLog.shift(); return sentLog.length; }
  var snapshotAt = 0;   // when the saved list (shown until the first real load) was taken
  var selfQuests = [], selfExcluded = [], selfAt = 0, selfTried = 0, selfStatus = 'not loaded yet', selfLoading = null;
  function fetchSelf(force) {
    if (selfLoading) return selfLoading;
    if (!force && selfAt && Date.now() - selfAt < (selfActive ? SELF_TTL_ACTIVE : SELF_TTL)) return Promise.resolve(false);
    if (!force && Date.now() - selfTried < 20000) return Promise.resolve(false);
    if (force && selfAt && Date.now() - selfTried < 10000) return Promise.resolve(false);   // button mashing never doubles the requests
    if (Date.now() < backoffUntil) return Promise.resolve(false);
    selfLoading = doFetchSelf().then(function (r) { selfLoading = null; return r; }, function () { selfLoading = null; return false; });
    return selfLoading;
  }
  async function doFetchSelf() {
    selfTried = Date.now();
    var http = httpModule();
    if (!http || typeof http.get !== 'function') { selfStatus = 'Discord HTTP client not ready yet'; return false; }
    try {
      tally();
      var res = await http.get({ url: '/quests/@me', retries: 0 });
      var body = isObj(res) && isObj(res.body) ? res.body : res;
      var q = isObj(body) && Array.isArray(body.quests) ? body.quests : null;
      var x = isObj(body) && (Array.isArray(body.excluded_quests) ? body.excluded_quests : Array.isArray(body.excludedQuests) ? body.excludedQuests : null);
      if (!q) throw new Error('reply had no quests list');
      selfQuests = camelize(q).filter(function (e) { return isObj(e) && typeof e.id === 'string'; });
      selfExcluded = camelize(x || []).filter(function (e) { return isObj(e) && typeof e.id === 'string'; });
      selfAt = Date.now();
      selfActive = selfQuests.some(function (e) { var u = isObj(e.userStatus) ? e.userStatus : null; return u && u.enrolledAt && !u.completedAt && !u.claimedAt; });
      selfStatus = selfQuests.length + ' quests + ' + selfExcluded.length + ' hidden, loaded by the plugin';
      saveSnapshot();
      return true;
    } catch (e) {
      selfStatus = rateLimited(e) ? 'Discord asked us to slow down, trying again in 10 min' : 'failed: ' + errText(e);
      return false;
    }
  }
  // ---- saved copy of the list: the settings screen is filled the moment it opens, before the first request answers.
  // It is stored as one JSON string (Valenced merges stored objects and arrays key by key, so a shorter list would keep old leftovers).
  // Only what is needed to draw a row is kept, and no sealed strings. Actions never run on it: they need a fresh load (selfAt > 0).
  function trimQuest(q) {
    var c = isObj(q.config) ? q.config : null, o = { id: q.id };
    if (c) {
      var m = isObj(c.messages) ? c.messages : {}, tc = c.taskConfigV2 || c.taskConfig, rc = c.rewardsConfig, rw = isObj(rc) && Array.isArray(rc.rewards) && isObj(rc.rewards[0]) ? rc.rewards[0] : null, rm = rw && isObj(rw.messages) ? rw.messages : {};
      var tasks = {};
      if (isObj(tc) && isObj(tc.tasks)) Object.keys(tc.tasks).forEach(function (k) { tasks[k] = { target: isObj(tc.tasks[k]) ? tc.tasks[k].target : 0 }; });
      o.config = { expiresAt: c.expiresAt, messages: { questName: m.questName, gameTitle: m.gameTitle }, taskConfigV2: { tasks: tasks },
        rewardsConfig: { platforms: isObj(rc) ? rc.platforms : undefined, rewards: rw ? [{ orbQuantity: rw.orbQuantity, messages: { name: rm.name, nameWithArticle: rm.nameWithArticle } }] : [] },
        application: { name: isObj(c.application) ? c.application.name : undefined } };
    }
    var u = isObj(q.userStatus) ? q.userStatus : null;
    if (u) o.userStatus = { enrolledAt: u.enrolledAt, completedAt: u.completedAt, claimedAt: u.claimedAt, progress: u.progress };
    return o;
  }
  function newestIds(list, max) {
    return list.map(function (e) { return e.id; }).sort(function (a, b) { return a.length !== b.length ? b.length - a.length : (a < b ? 1 : -1); }).slice(0, max);
  }
  function saveSnapshot() {
    try {
      if (!storageRef) return;
      var data = { q: selfQuests.slice(0, 60).map(trimQuest), x: newestIds(selfExcluded, 60) };
      storageRef.set({ snapshot: { at: selfAt, json: JSON.stringify(data) } }).catch(function () {});
    } catch (e) { /* the saved copy is only a convenience */ }
  }
  function loadSnapshot(s) {
    try {
      if (!isObj(s) || typeof s.json !== 'string' || !(s.at > Date.now() - 14 * 86400000)) return;
      var d = JSON.parse(s.json);
      if (!isObj(d) || !Array.isArray(d.q) || !Array.isArray(d.x)) return;
      var ok = function (e) { return isObj(e) && typeof e.id === 'string' && /^\d{5,25}$/.test(e.id); };
      selfQuests = d.q.filter(ok);
      selfExcluded = d.x.filter(function (id) { return typeof id === 'string' && /^\d{5,25}$/.test(id); }).map(function (id) { return { id: id }; });
      snapshotAt = s.at;
      selfStatus = 'saved list from ' + Math.max(0, Math.round((Date.now() - s.at) / 60000)) + ' min ago, refreshing';
    } catch (e) { /* ignore a damaged copy */ }
  }

  // reload both our own copy and Discord's store
  // Discord's own list updates by itself after an accept or claim (it listens to the gateway), so only ask
  // it to reload (a second request to the same endpoint) when the connection changed or the user asked.
  function reloadQuests(alsoNative) {
    var m = alsoNative ? enrollModule() : null;
    var native = m ? Promise.resolve().then(function () { return m.fetchCurrentQuests(); }).catch(function () {}) : Promise.resolve();
    return Promise.all([fetchSelf(true), native]);
  }

  function collect() {
    var s = getStore();
    var f = lastHook.useFilteredQuests;
    var c = lastHook.useClaimedQuests;
    // After a connection change Discord's own list can be an old answer. When our copy is newer than the
    // last time its screen rendered, trust ours alone for what is shown and what is hidden.
    var ours = selfAt > 0 && selfAt >= lastHookAt;
    // the saved copy only stands in until something live exists; it must never outvote Discord's own current lists
    var fromSnapshot = selfAt === 0 && snapshotAt > 0;
    var live = !!f || toList(s && s.quests).length > 0;
    var useSelf = !(fromSnapshot && live);
    return {
      fromSnapshot: fromSnapshot && !live,
      storeFound: !!s || selfAt > 0 || snapshotAt > 0,
      storeKeys: s ? Object.keys(s).slice(0, 40) : [],
      store: ours ? [] : toList(s && s.quests),
      storeClaimed: toList(s && s.claimedQuests),
      hookSeen: !!f,
      hookQuests: ours ? [] : toList(f && f.quests),
      hookExcluded: ours ? [] : toList(f && f.excludedQuests),
      hookClaimed: toList(c && (c.claimedQuests || c.quests)),
      selfQuests: useSelf ? selfQuests : [],
      selfExcluded: useSelf ? selfExcluded : [],
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
    add(d.selfQuests, 'shown'); add(d.selfExcluded, 'excluded');
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

  // Sections for the grouped list. Status sections come in a fixed order; the others biggest first.
  var STATUS_GROUPS = ['Ready to claim', 'In progress', 'Available', 'Not offered to you', 'Finished or expired'];
  function statusGroup(x) {
    if (x.claimable) return STATUS_GROUPS[0];
    if (x.status === 'enrolled') return STATUS_GROUPS[1];
    if (LIVE_STATUSES.indexOf(x.status) >= 0) return STATUS_GROUPS[2];
    if (x.status === 'locked') return STATUS_GROUPS[3];
    return STATUS_GROUPS[4];
  }
  function groupQuests(list, mode) {
    if (mode !== 'game' && mode !== 'reward' && mode !== 'status') return [{ title: '', items: list }];
    var map = {}, order = [];
    list.forEach(function (x) {
      var key = mode === 'status' ? statusGroup(x) : mode === 'game' ? (x.app || 'No game info') : (x.reward || 'No reward info');
      if (!Object.prototype.hasOwnProperty.call(map, key)) { map[key] = []; order.push(key); }
      map[key].push(x);
    });
    if (mode === 'status') order.sort(function (a, b) { return STATUS_GROUPS.indexOf(a) - STATUS_GROUPS.indexOf(b); });
    else order.sort(function (a, b) { return map[b].length - map[a].length || a.localeCompare(b); });
    return order.map(function (k) { return { title: k, items: map[k] }; });
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

