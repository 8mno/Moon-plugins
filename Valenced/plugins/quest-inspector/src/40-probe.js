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
  // Clearing must also reach storage, otherwise the old refusals come back after a restart.
  // (Storage merges objects, so a key cannot be removed; a "cleared at" time is stored instead.)
  function clearRefused(which) {
    lockedMap = {};
    if (which !== 'locked') goneMap = {};
    var t = Date.now();
    try { if (storageRef) storageRef.set(which === 'locked' ? { lockedClearedAt: t } : { goneClearedAt: t, lockedClearedAt: t }).catch(function () {}); } catch (e) {}
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
    return stubIds().filter(function (id) { return !isGone(id) && !isLocked(id) && idAgeDays(id) <= PROBE_MAX_AGE_DAYS && access(id) !== 'no'; })
      .sort(function (a, b) { return idAgeDays(a) - idAgeDays(b); });   // newest first
  }
  // manual: true when the user tapped "Live check" (the hourly background budget does not apply then)
  function loadProbe(manual) {
    if (probing) return probing;
    probing = probeStubs(manual).then(function (r) { probing = null; return r; }, function () { probing = null; return false; });
    return probing;
  }
  // GET /quests/{id} should return the full config only while the quest is active (per the community
  // docs; not confirmed for hidden quests, so the outcome counts are shown in Status).
  async function probeStubs(manual) {
    var http = httpModule();
    if (!http || typeof http.get !== 'function') { probeStatus = 'Discord HTTP client not found'; return false; }
    var todo = probeCandidates();
    if (todo.length === 0) { probeStatus = 'nothing to check'; probeNextAt = Date.now() + META_RETRY_OK; return false; }
    var room = manual ? PROBE_MAX : Math.max(0, Math.min(PROBE_MAX, BG_BUDGET - 10 - sentLastHour()));
    if (room === 0) { probeStatus = 'waiting: this hour\u2019s request budget is used'; probeNextAt = Date.now() + 15 * 60000; return false; }
    var batch = todo.slice(0, room), found = {}, gone = {}, locked = {}, n = { ok: 0, gone: 0, locked: 0, err: 0 }, lastErr = '';
    probeStatus = 'checking ' + batch.length + '...';
    for (var i = 0; i < batch.length; i++) {
      try {
        tally();
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
          if (rateLimited(e)) break;
        }
      }
      if (i < batch.length - 1) await sleep(PROBE_GAP + Math.floor(Math.random() * 1500));
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
    if (probing || metaLoading || Date.now() < probeNextAt || Date.now() < backoffUntil || !cfgNow().autoProbe) return;
    if (sentLastHour() >= BG_BUDGET - 10 || probeCandidates().length === 0) return;
    probeNextAt = Date.now() + META_RETRY_FAIL;
    loadProbe();
  }

  // snowflake ids carry their creation time
  function idAgeDays(id) { return (Date.now() - (Math.floor(Number(id) / 4194304) + 1420070400000)) / 86400000; }

