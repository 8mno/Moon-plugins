  // ---------- health check and report ----------
  // Every moving part, as { ok, name, detail }. ok: true | false | null (null = not applicable / unknown yet).
  function healthItems() {
    var items = [], now = Date.now();
    function add(ok, name, detail) { items.push({ ok: ok, name: name, detail: detail }); }
    var all = [];
    try { all = unify(collect()); } catch (e) {}
    add(!!httpModule(), 'Discord HTTP client', httpModule() ? 'found' : 'not found: loading and accepting cannot work. Reload the app.');
    add(selfAt > 0, 'Quest list', selfAt > 0 ? selfStatus + ', ' + Math.max(0, Math.round((now - selfAt) / 60000)) + ' min ago' : selfStatus);
    add(ipCountry.cc ? true : (cfgNow().detectIp ? false : null), 'Country', ipCountry.cc ? ipCountry.cc + ' (IP)' : (cfgNow().detectIp ? 'not detected: IP check ' + ipCountry.status : 'IP check is off'));
    add(regionsAt > 0, 'Region list', regionsAt > 0 ? regionStatus + ', ' + Math.max(0, Math.round((now - regionsAt) / 3600000)) + 'h old' : regionStatus);
    var known = all.filter(function (x) { return x.known; }).length;
    add(all.length === 0 ? null : (known === all.length ? true : (known > 0 ? null : false)), 'Quest names', known + ' of ' + all.length + ' have details (' + metaStatus + ')');
    var ic = ['new', 'ok', 'bad', 'copy', 'clock'].filter(function (k) { return !!icon(ICONS[k]); });
    add(ic.length === 5 ? true : (ic.length ? null : false), 'Toast icons', ic.length + ' of 5 found');
    add(rowRegistered, 'Settings row', rowRegistered ? 'registered in the Valenced list' : 'not registered (open the plugin from Plugins instead)');
    add(lastClaimPlatform === null ? null : true, 'Claim platform', lastClaimPlatform === null ? 'no claim made yet' : 'worked with platform ' + lastClaimPlatform);
    var paused = now < backoffUntil;
    add(!paused, 'Requests to Discord', sentLastHour() + ' in the last hour (background limit ' + BG_BUDGET + ')' + (paused ? ', paused by Discord for ' + Math.ceil((backoffUntil - now) / 60000) + ' min' : ''));
    return items;
  }
  // Remove sealed strings and anything that looks like a token from text that is copied out.
  function redact(t) {
    return String(t == null ? '' : t)
      .replace(/("(?:metadata_sealed|traffic_metadata_sealed)"\s*:\s*")[^"]*(")/g, '$1[removed]$2')
      .replace(/[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, '[token removed]');
  }
  function buildReport() {
    var lines = ['Quest Inspector ' + PLUGIN_VERSION, 'time: ' + new Date().toISOString(), ''];
    healthItems().forEach(function (i) { lines.push((i.ok === true ? '[ok] ' : i.ok === false ? '[FAIL] ' : '[--] ') + i.name + ': ' + i.detail); });
    var c = cfgNow();
    lines.push('', 'options: ' + ['showHidden', 'detectIp', 'autoClaim', 'remind', 'alertNew', 'autoMeta', 'autoProbe', 'autoAccept'].map(function (k) { return k + '=' + (c[k] ? 'on' : 'off'); }).join(' '));
    lines.push('', 'recent accepts/claims (newest last):');
    if (!enrollLog.length) lines.push('  none');
    enrollLog.slice(-10).forEach(function (z) { lines.push('  ' + (z.ok ? 'ok ' : 'FAIL ') + z.id + ' ' + z.src + ' ' + z.text + (z.sent ? ' sent ' + z.sent : '') + ' ' + Math.round((Date.now() - z.at) / 1000) + 's ago'); });
    return redact(lines.join('\n'));
  }
