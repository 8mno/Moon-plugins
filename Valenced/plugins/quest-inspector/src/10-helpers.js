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
      toast('QI_COPIED', 'Copied to clipboard', false, 'copy');
      return;
    } catch (e) {}
    try { RN.Share.share({ message: text }); }
    catch (e2) { setMsg('Could not copy or share.'); }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Toast icons are Discord's own icon components, looked up by name (the same way Valenced's own toasts do it).
  // A name that does not exist just gives no icon.
  var iconCache = {};
  function icon(names) {
    var key = names.join('|');
    if (Object.prototype.hasOwnProperty.call(iconCache, key)) return iconCache[key];
    var found;
    for (var i = 0; i < names.length && !found; i++) {
      try { found = V.utils.discord.lookupGeneratedIconComponent(names[i]); } catch (e) { found = undefined; }
    }
    if (found) iconCache[key] = found;   // a miss is retried later, in case the modules were not loaded yet
    return found;
  }
  var ICONS = {
    new: ['QuestsIcon', 'GiftIcon'], ok: ['CircleCheckIcon'], bad: ['CircleXIcon', 'FileWarningIcon'],
    copy: ['CopyIcon'], clock: ['ClockIcon', 'ClockWarningIcon', 'TimerIcon'], globe: ['GlobeEarthIcon']
  };
  function toast(key, text, bad, kind) {
    try {
      var o = { text: text };
      if (bad) o.variant = 'critical';
      var ic = icon(ICONS[kind || (bad ? 'bad' : 'new')] || []);
      if (ic) o.icon = ic;
      V.discord.actions.ToastActionCreators.open(key, o);
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

