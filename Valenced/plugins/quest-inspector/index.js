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
    filter: 'all',       // all | available | enrolled | hidden | finished
    acceptDelay: 1500,   // ms between "Accept all" requests
    seeded: false,
    seen: []
  };
  var FILTERS = ['all', 'available', 'enrolled', 'hidden', 'finished'];
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
  function share(text, setMsg) {
    try { RN.Share.share({ message: text }); }
    catch (e) { setMsg('Could not open share sheet.'); }
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

  // ---------- reading quest objects (field names defensive; verify with the JSON export) ----------
  function describe(q) {
    var out = { id: '', name: 'unknown', status: 'available', types: [], expMs: NaN, reward: '', app: '' };
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
      if (f === 'finished' && ['claimed', 'completed', 'expired'].indexOf(x.status) < 0) return false;
      if (query) {
        var hay = (x.name + ' ' + x.reward + ' ' + x.app + ' ' + x.types.join(' ')).toLowerCase();
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
  function errText(e) {
    if (!isObj(e)) return 'Request failed.';
    var body = isObj(e.body) ? e.body : {};
    var st = typeof e.status === 'number' ? ' HTTP ' + e.status : '';
    var m = typeof body.message === 'string' ? body.message : (typeof e.message === 'string' ? e.message : 'Request failed.');
    return 'Accept failed' + st + ': ' + m;
  }
  // Same action as Discord's own "Accept quest" button. Sends no progress.
  async function acceptOne(m, x) {
    await m.enrollInQuest(x.id, {});
  }
  async function acceptList(list, setMsg) {
    var m = enrollModule();
    if (!m) { setMsg('enrollInQuest not found. Open the Quests screen first.'); return; }
    var ok = 0, fail = [], delay = cfgNow().acceptDelay;
    for (var i = 0; i < list.length; i++) {
      setMsg('Accepting ' + (i + 1) + '/' + list.length + ': ' + list[i].name + '...');
      try { await acceptOne(m, list[i]); ok++; }
      catch (e) {
        var t = errText(e);
        fail.push(list[i].name + ' (' + t.replace('Accept failed', '').replace(/^:? ?/, '') + ')');
        if (isObj(e) && e.status === 429) { fail.push('Rate limited, stopped.'); break; }
      }
      if (i < list.length - 1) await sleep(delay);
    }
    try { await m.fetchCurrentQuests(); } catch (e) {}
    setMsg('Accepted ' + ok + '/' + list.length + (fail.length ? '. Failed: ' + fail.join('; ') : '.'));
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
    var available = all.filter(function (x) { return x.status === 'available'; });
    var em = enrollModule();
    var TI = V.components.SearchInput || Design.TextInput || RN.TextInput;
    function onText(x) { qS[1](typeof x === 'string' ? x : ((x && x.nativeEvent && x.nativeEvent.text) || '')); }

    function openQuest(x) {
      var buttons = [];
      if (x.status === 'available') buttons.push({ text: 'Accept', onPress: function () { acceptList([x], setMsg); } });
      buttons.push({ text: 'Open in Discord', onPress: function () { RN.Linking.openURL('https://discord.com/quests/' + encodeURIComponent(x.id)); } });
      buttons.push({ text: 'Share JSON', onPress: function () { share(safe(x.q), setMsg); } });
      RN.Alert.alert(x.name, [x.status, x.hidden ? 'hidden by client' : '', x.reward ? 'reward: ' + x.reward : '', timeLeft(x.expMs)].filter(Boolean).join(' · '), buttons);
    }

    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 24 } },
      h(V.components.Page, null,
        h(Design.TableRowGroup, { title: 'Status' },
          h(Design.TableRow, { label: d.storeFound ? 'Quest store found' : 'Quest store NOT found', subLabel: 'Open Discord\u2019s Quests screen once so everything loads.' }),
          h(Design.TableRow, { label: all.length + ' quests: ' + available.length + ' available, ' + all.filter(function (x) { return x.hidden; }).length + ' hidden by client' }),
          !!skippedHidden && h(Design.TableRow, { label: skippedHidden + ' hidden quest(s) not merged into Discord’s list', subLabel: 'They are missing data Discord’s quest card needs. They are still listed below.' }),
          h(Design.TableRow, { label: em ? 'enrollInQuest found (args: ' + em.enrollInQuest.length + ')' : 'enrollInQuest not found' }),
          !!msgS[0] && h(Design.TableRow, { label: msgS[0] })),

        h(Design.TableRowGroup, { title: 'Options' },
          h(Design.TableSwitchRow, { label: 'Show hidden quests in Discord\u2019s Quests screen', subLabel: 'Merges client-excluded quests into the native list. Reload after changing.', value: !!c.showHidden, onValueChange: function (v) { set({ showHidden: v }); } }),
          h(Design.TableSwitchRow, { label: 'Alert me about new quests', value: !!c.alertNew, onValueChange: function (v) { set({ alertNew: v }); } }),
          h(Design.TableSwitchRow, { label: 'Soonest-expiring first', value: !!c.sortSoonest, onValueChange: function (v) { set({ sortSoonest: v }); } }),
          h(Design.TableRow, { label: 'Delay between accepts: ' + (c.acceptDelay / 1000) + 's', subLabel: 'Tap to cycle 1s / 1.5s / 3s / 5s.', onPress: function () { set({ acceptDelay: cycle([1000, 1500, 3000, 5000], c.acceptDelay) }); } })),

        h(Design.TableRowGroup, { title: 'Actions' },
          h(Design.TableRow, {
            label: 'Accept all available (' + available.length + ')',
            subLabel: 'Accepts one by one, with the delay above. Same as tapping Accept in Discord.',
            onPress: function () {
              if (busyS[0] || available.length === 0) return;
              RN.Alert.alert('Accept ' + available.length + ' quests?', 'Each one is accepted like the normal Accept button.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Accept all', onPress: function () { busyS[1](true); acceptList(available, setMsg).finally(function () { busyS[1](false); }); } }
              ]);
            }
          }),
          h(Design.TableRow, {
            label: 'Refresh quests from Discord',
            onPress: function () {
              var m = enrollModule();
              if (!m) { setMsg('fetchCurrentQuests not found.'); return; }
              Promise.resolve(m.fetchCurrentQuests()).then(function () { setMsg('Refreshed.'); }, function () { setMsg('Refresh failed.'); });
            }
          }),
          h(Design.TableRow, { label: 'Share everything as JSON', subLabel: 'Raw quests plus store/hook keys. Useful for checking field names.', onPress: function () { share(safe(d), setMsg); } })),

        // inputs go straight in the Page (like Valenced's own plugins), not inside a TableRowGroup
        h(TI, { value: qS[0], placeholder: 'Search name, reward, game, type', size: 'md', onChange: onText, onChangeText: onText }),
        h(Design.TableRowGroup, { title: 'Find' },
          h(Design.TableRow, { label: 'Filter: ' + c.filter, subLabel: 'Tap to cycle: ' + FILTERS.join(' / '), onPress: function () { set({ filter: cycle(FILTERS, c.filter) }); } })),

        h(Design.TableRowGroup, { title: 'Quests (' + view.length + ')' },
          view.length === 0
            ? h(Design.TableRow, { label: 'No matching quests' })
            : view.map(function (x) {
                var types = x.types.map(function (t) { return TYPE_LABELS[t] || t.toLowerCase(); }).join(', ');
                return h(Design.TableRow, {
                  key: x.id, label: x.name,
                  subLabel: [x.status, x.hidden ? 'hidden by client' : '', types, x.reward ? 'reward: ' + x.reward : '', timeLeft(x.expMs)].filter(Boolean).join(' \u00b7 '),
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
          var s = getStore();
          if (!s) return;
          var quests = toList(s.quests).filter(function (q) { return isObj(q) && typeof q.id === 'string'; });
          if (quests.length === 0) return;
          if (!seenMemo) seenMemo = new Set(c.seen);
          var fresh = quests.filter(function (q) { return !seenMemo.has(q.id); });
          if (fresh.length === 0) return;
          fresh.forEach(function (q) { seenMemo.add(q.id); });
          if (c.seeded) {
            var shown = 0;
            fresh.forEach(function (q) {
              var d = describe(q);
              if (['expired', 'claimed', 'completed'].indexOf(d.status) >= 0) return;
              if (shown++ < 3) toast('QI_NEW_' + q.id, 'New quest: ' + d.name + (d.reward ? ' (' + d.reward + ')' : ''));
            });
            if (shown > 3) toast('QI_NEW_MORE', '+' + (shown - 3) + ' more new quests');
          }
          ctx.jsonStorage.set({ seeded: true, seen: Array.from(seenMemo).slice(-500) }).catch(function () {});
        } catch (e) { ctx.plugin.reportError(e); }
      }
      var timer = null;
      Promise.resolve(ctx.jsonStorage.get()).catch(function () {}).then(function () {
        timer = setInterval(check, 8000);
        check();
      });
      cleanup(function () { if (timer) clearInterval(timer); });
    },
    SettingsComponent: Inspector
  });
  return exports;
})({});
