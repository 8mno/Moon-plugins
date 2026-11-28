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
    if (want.size === 0) { metaStatus = 'nothing to look up yet (quests not loaded yet)'; return false; }
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
