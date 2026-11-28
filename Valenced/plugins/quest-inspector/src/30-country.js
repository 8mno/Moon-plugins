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
    if (!force && ipCountry.cc && Date.now() - ipCountry.at < 10 * 60000) return Promise.resolve(false);
    if (!force && !ipCountry.cc && ipCountry.at && Date.now() - ipCountry.at < 2 * 60000) return Promise.resolve(false);
    if (!geoLoading) geoLoading = doDetect().then(function (r) { geoLoading = null; return r; }, function () { geoLoading = null; return false; });
    return geoLoading;
  }
  async function doDetect() {
    var prev = ipCountry.cc, cc = '', err = '';
    for (var i = 0; i < GEO_SOURCES.length && !cc; i++) {
      try {
        var v = String(GEO_SOURCES[i].pick(await fetchJson(GEO_SOURCES[i].url, 8000)) || '').toUpperCase();
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
    clearRefused('locked'); probeNextAt = Date.now() + 30000;   // give the new connection a moment before asking Discord again
    toast('QI_COUNTRY', 'Your country is now ' + flag(cc, true) + '. Checking quests again...', false, 'globe');
    setTimeout(function () { reloadQuests(true); }, 4000);
  }
  // what the server itself told us about a quest from a given country, kept so unknown regions fill in over time
  var learnedMap = {};
  function learn(id, ok) {
    var cc = ipCountry.cc;
    // only trust the country if it was checked recently (a VPN may have been switched since)
    if (!cc || Date.now() - ipCountry.at > 15 * 60000 || !/^\d{5,25}$/.test(id)) return;
    var r = own(learnedMap, id) || { y: [], n: [] };
    var from = ok ? 'y' : 'n', other = ok ? 'n' : 'y';
    if (r[from].indexOf(cc) < 0) r[from] = r[from].concat(cc).slice(-8);
    r[other] = r[other].filter(function (c) { return c !== cc; });
    learnedMap[id] = r;
    var one = {}; one[id] = r;
    try { if (storageRef) storageRef.set({ learned: one }).catch(function () {}); } catch (e) {}
  }

