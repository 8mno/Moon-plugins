  // ---------- claiming the reward of a finished quest ----------
  // POST /quests/{id}/claim-reward { location, platform, metadata_sealed?, traffic_metadata_sealed? }.
  // Success is only counted when the reply carries claimed_at and no errors.
  var claimTried = {};   // quest id -> { n: attempts, at: last attempt }
  async function claimOne(x) {
    var http = httpModule();
    if (!http) throw new Error('Discord\u2019s HTTP client was not found. Try again in a moment.');
    var sealed = sealedFor(x.id), plats = [];
    [x.platforms, 0, 4].forEach(function (pl) { if (Number.isInteger(pl) && pl >= 0 && pl <= 4 && plats.indexOf(pl) < 0) plats.push(pl); });
    var last = null;
    for (var i = 0; i < plats.length; i++) {
      var body = { location: QUEST_HOME_MOBILE, platform: plats[i] };
      if (sealed.metadataSealed) body.metadata_sealed = sealed.metadataSealed;
      if (sealed.trafficMetadataSealed) body.traffic_metadata_sealed = sealed.trafficMetadataSealed;
      try {
        viaPlugin++;
        var res;
        tally();
        try { res = await http.post({ url: '/quests/' + encodeURIComponent(x.id) + '/claim-reward', body: body, retries: 0 }); }
        finally { viaPlugin--; }
        var rb = isObj(res) && isObj(res.body) ? res.body : res;
        var errs = isObj(rb) && Array.isArray(rb.errors) ? rb.errors : [];
        if (isObj(res) && typeof res.status === 'number' && res.status >= 400) throw res;
        if (errs.length) throw new Error('Discord reported: ' + bodyPreview(errs));
        if (!isObj(rb) || !(rb.claimed_at || rb.claimedAt)) throw new Error('Reply had no claimed_at, so the claim was not confirmed.');
        lastClaimPlatform = plats[i];
        recordEnroll(x.id, true, 'claim platform ' + plats[i] + ' ok', 'claim', bodyPreview(body));
        return;
      } catch (e) {
        last = e;
        recordEnroll(x.id, false, 'claim platform ' + plats[i] + ': ' + errText(e), 'claim', bodyPreview(body));
        if (isObj(e) && (e.status === 429 || e.status === 401 || e.status === 403 || e.status === 404)) { rateLimited(e); break; }
      }
    }
    throw last || new Error('Claim failed');
  }
  var claimedAt = {};    // quest id -> when the plugin claimed it (a stale list must not trigger a second claim)
  function claimDue(x) {
    if (claimedAt[x.id] && Date.now() - claimedAt[x.id] < 30 * 60000) return false;
    var t = own(claimTried, x.id);
    return !t || (t.n < 3 && Date.now() - t.at > 10 * 60000);
  }
  var claiming = false;
  async function autoClaim() {
    if (claiming || !listFresh() || Date.now() < backoffUntil) return;
    var todo = unify(collect()).filter(function (x) { return x.claimable && claimDue(x); });
    if (!todo.length) return;
    claiming = true;
    var any = false;
    try {
      for (var i = 0; i < todo.length; i++) {
        var x = todo[i], t = claimTried[x.id] || { n: 0, at: 0 };
        t.n++; t.at = Date.now(); claimTried[x.id] = t;
        try {
          await claimOne(x); any = true; delete claimTried[x.id]; claimedAt[x.id] = Date.now();
          toast('QI_CLAIM_' + x.id, 'Claimed: ' + (x.known ? x.name : 'a quest') + (x.reward ? ' (' + x.reward + ')' : ''), false, 'ok');
        } catch (e) {
          if (t.n === 1) toast('QI_CLAIMFAIL_' + x.id, 'Could not claim ' + (x.known ? x.name : 'a quest') + ': ' + errText(e).slice(0, 80), true, 'bad');
          if (Date.now() < backoffUntil) break;
        }
        if (i < todo.length - 1) await sleep(2000);
      }
      if (any) await reloadQuests();
    } finally { claiming = false; }
  }
  async function claimList(list, setMsg) {
    if (!listFresh()) { setMsg('Your quests are still loading. Try again in a moment.'); return; }
    var ok = 0, fail = [], okNames = [];
    for (var i = 0; i < list.length; i++) {
      setMsg('Claiming ' + (i + 1) + '/' + list.length + ': ' + list[i].name + '...');
      try { await claimOne(list[i]); ok++; okNames.push(list[i].name); delete claimTried[list[i].id]; claimedAt[list[i].id] = Date.now(); }
      catch (e) { fail.push(list[i].name + ' [' + errText(e) + ']'); if (isObj(e) && e.status === 429) break; }
      if (i < list.length - 1) await sleep(2000);
    }
    await reloadQuests();
    setMsg('Claimed ' + ok + '/' + list.length + (fail.length ? '. Failed: ' + fail.join('; ') : '.'));
    toast('QI_CLAIM', ok + '/' + list.length + ' rewards claimed', ok === 0 && list.length > 0, ok === 0 && list.length > 0 ? 'bad' : 'ok');
    var lines = [];
    if (okNames.length) lines.push('Claimed:\n' + okNames.slice(0, 8).map(function (n) { return '\u2022 ' + n; }).join('\n'));
    if (fail.length) lines.push('Not claimed:\n' + fail.slice(0, 5).map(function (n) { return '\u2022 ' + n; }).join('\n'));
    popup(ok === list.length ? 'All ' + ok + ' claimed' : ok + ' of ' + list.length + ' claimed', lines.join('\n\n'));
  }

  // ---- opt-in: accept quests that appear after the switch was turned on
  var aaTried = {};        // quest id -> { n, at }: every quest is tried at most twice
  var autoAccepting = false;
  function isCaptcha(e) {
    var b = isObj(e) && isObj(e.body) ? e.body : {};
    return !!(b.captcha_key || b.captcha_sitekey || b.captcha_service || b.captchaKey);
  }
  async function autoAccept(onStop) {
    var c = cfgNow();
    // needs a list loaded by the plugin in the last 20 minutes: the saved copy is never enough
    if (!c.autoAccept || autoAccepting || selfAt <= 0 || Date.now() - selfAt > 20 * 60000 || Date.now() < backoffUntil) return;
    var base = new Set(Array.isArray(c.aaBase) ? c.aaBase : []);
    var todo = unify(collect()).filter(function (x) {
      if (base.has(x.id) || LIVE_STATUSES.indexOf(x.status) < 0) return false;
      var t = own(aaTried, x.id);
      return !t || (t.n < 2 && Date.now() - t.at > 30 * 60000);
    }).slice(0, 3);
    if (!todo.length) return;
    autoAccepting = true;
    var any = false;
    try {
      for (var i = 0; i < todo.length; i++) {
        var x = todo[i], t = aaTried[x.id] || { n: 0, at: 0 };
        t.n++; t.at = Date.now(); aaTried[x.id] = t;
        try {
          await enrollOne(x); any = true; t.n = 99;
          toast('QI_AUTO_' + x.id, 'Accepted: ' + (x.known ? x.name : 'a new quest') + (x.reward ? ' (' + x.reward + ')' : ''), false, 'ok');
        } catch (e) {
          if (isCaptcha(e)) {
            // Discord wants a human check: automatic accepting must not go on
            if (onStop) onStop();
            toast('QI_AUTO_CAPTCHA', 'Auto-accept turned off: Discord asked for a captcha. Accept quests yourself.', true, 'bad');
            break;
          }
          if (t.n === 1) toast('QI_AUTOFAIL_' + x.id, 'Could not auto-accept ' + (x.known ? x.name : 'a quest') + ': ' + errText(e).slice(0, 80), true, 'bad');
          if (Date.now() < backoffUntil) break;
        }
        if (i < todo.length - 1) await sleep(c.acceptDelay);
      }
      if (any) await reloadQuests();
    } finally { autoAccepting = false; }
  }
  async function acceptList(list, setMsg) {
    if (!listFresh()) { setMsg('Your quests are still loading. Try again in a moment.'); return; }
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
    await reloadQuests();
    setMsg('Server confirmed ' + ok + '/' + list.length + (fail.length ? '. Failed: ' + fail.join('; ') : '.'));
    toast('QI_ACCEPT', ok + '/' + list.length + ' quests enrolled', ok === 0 && list.length > 0, ok === 0 && list.length > 0 ? 'bad' : 'ok');
    try {
      var lines = [];
      if (okNames.length) lines.push('Accepted:\n' + okNames.slice(0, 8).map(function (n) { return '\u2022 ' + n; }).join('\n'));
      if (fail.length) lines.push('Refused:\n' + fail.slice(0, 5).map(function (n) { return '\u2022 ' + n; }).join('\n'));
      if (lockedCount) lines.push('Discord does not offer ' + (lockedCount === 1 ? 'this quest' : 'these quests') + ' in your region. Turn on a VPN in one of its countries, then tap \u201cRetry refused quests\u201d.');
      popup(ok === list.length ? 'All ' + ok + ' accepted' : ok + ' of ' + list.length + ' accepted', lines.join('\n\n'));
    } catch (e) { /* the toast and the message row already said it */ }
  }

