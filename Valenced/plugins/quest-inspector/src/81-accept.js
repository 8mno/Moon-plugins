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
  // look through every copy of the quest (ours and Discord's) for the sealed strings it came with
  function sealedFor(id) {
    var out = { metadataSealed: '', trafficMetadataSealed: '' };
    try {
      var d = collect();
      [d.selfQuests, d.selfExcluded, d.hookQuests, d.hookExcluded, d.store].forEach(function (list) {
        list.forEach(function (q) {
          if (!isObj(q) || q.id !== id) return;
          ['metadataSealed', 'trafficMetadataSealed'].forEach(function (k) {
            var v = q[k] !== undefined ? q[k] : q[k.replace(/[A-Z]/g, function (m) { return '_' + m.toLowerCase(); })];
            if (!out[k] && typeof v === 'string' && v && v.length < 4000) out[k] = v;
          });
        });
      });
    } catch (e) { /* send without them */ }
    return out;
  }
  async function enrollOne(x) {
    var http = httpModule();
    if (!http) throw new Error('Discord\u2019s HTTP client was not found. Try again in a moment.');
    var res;
    // Discord's client echoes back the sealed ad-decision strings that came with the quest. The plugin does the
    // same when the quest object has them; hidden stubs do not, so for those only the location is sent.
    var body0 = { location: QUEST_HOME_MOBILE };
    var sealed = sealedFor(x.id);
    if (sealed.metadataSealed) body0.metadata_sealed = sealed.metadataSealed;
    if (sealed.trafficMetadataSealed) body0.traffic_metadata_sealed = sealed.trafficMetadataSealed;
    viaPlugin++;
    tally();
    try { res = await http.post({ url: '/quests/' + encodeURIComponent(x.id) + '/enroll', body: body0, retries: 0 }); }
    finally { viaPlugin--; }
    if (isObj(res) && (res.ok === false || (typeof res.status === 'number' && res.status >= 400))) throw res;
    var body = isObj(res) && isObj(res.body) ? res.body : res;
    if (!isObj(body) || !(body.enrolled_at || body.enrolledAt)) throw new Error('Server reply had no enrolled_at, so this was not confirmed.');
    learn(x.id, true);
  }
