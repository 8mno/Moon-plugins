  // ---------- plugin ----------
  // Test hook: only exists when a test sets globalThis.__QI_TEST__ before loading the script.
  if (typeof globalThis !== 'undefined' && globalThis.__QI_TEST__) {
    exports.__test = {
      parseRegions: parseRegions, inferRegion: inferRegion, access: access, rateLimited: rateLimited, guessLanguage: guessLanguage,
      cname: cname, flag: flag, describe: describe, redact: redact, bar: bar, timeLeft: timeLeft, regionLabel: regionLabel,
      state: function () { return { backoffUntil: backoffUntil, backoffLevel: backoffLevel }; },
      reset: function () { backoffUntil = 0; backoffLevel = 0; lastLimitAt = 0; },
      setRegions: function (m) { regionMap = m; replacedBy = {}; },
      setUser: function (codes) { userRegion = { codes: codes, n: codes.length, from: 'ip', guess: [] }; },
      setLearned: function (m) { learnedMap = m; }
    };
  }
  exports.default = plugin({
    jsonStorage: { load: true, default: DEFAULTS },
    start: function (ctx) {
      var cleanup = ctx.cleanup;
      storageRef = ctx.jsonStorage;
      if (ctx.plugin.startedLate) { ctx.plugin.requireReload(); return; }

      // Discord's Quests screen can be left showing an old (empty) answer after the connection changes.
      // When it shows no quests but our own fresh copy has some, ask Discord to reload its list (at most every 30 s).
      var lastKick = 0;
      function kickIfStale(res) {
        try {
          if (!isObj(res) || (Array.isArray(res.quests) && res.quests.length) || !selfQuests.length || Date.now() - lastKick < 30000) return;
          lastKick = Date.now();
          var m = enrollModule();
          if (m) setTimeout(function () { try { Promise.resolve(m.fetchCurrentQuests()).catch(function () {}); } catch (e) {} }, 0);
        } catch (e) { /* never break the screen */ }
      }

      // observe Discord's quest hooks; optionally merge hidden quests into the native list
      cleanup(finders.getModules(
        finders.filters.withProps('useFilteredQuests', 'useClaimedQuests'),
        function (mod) {
          ['useFilteredQuests', 'useClaimedQuests'].forEach(function (name) {
            cleanup(V.patcher.instead(mod, name, function (args, orig) {
              var res = Reflect.apply(orig, this, args);
              lastHook[name] = res; lastHookAt = Date.now();
              if (name === 'useFilteredQuests') kickIfStale(res);
              if (name === 'useFilteredQuests' && cfgNow().showHidden) {
                try { return mergeHidden(res); } catch (e) { ctx.plugin.reportError(e); }
              }
              return res;
            }));
          });
        },
        { max: Infinity }
      ));

      // Watch accept requests (read-only: the original call always runs unchanged and its result is returned as is)
      var httpPatched = false;
      function patchHttp() {
        if (httpPatched) return;
        try {
          var http = httpModule();
          if (!http) return;
          httpPatched = true;
          cleanup(V.patcher.instead(http, 'post', function (args, orig) {
            var p = Reflect.apply(orig, this, args);
            try {
              var o = args[0];
              var m = isObj(o) && typeof o.url === 'string' ? /\/quests\/(\d{5,25})\/enroll\b/.exec(o.url) : null;
              if (m) {
                var id = m[1], src = viaPlugin > 0 ? 'plugin' : 'Discord', sent = bodyPreview(o.body);
                Promise.resolve(p).then(function (r) {
                  recordEnroll(id, true, 'HTTP ' + (isObj(r) && r.status ? r.status : 'ok') + ' ' + bodyPreview(isObj(r) ? r.body : ''), src, sent);
                }, function (e) { recordEnroll(id, false, errText(e), src, sent); markRefused(id, e); });
              }
            } catch (e) { /* never let logging break a request */ }
            return p;
          }));
        } catch (e) { ctx.plugin.reportError(e); }
      }
      patchHttp();

      // new-quest alerts
      var seenMemo = null, startedAt = Date.now();
      function check() {
        try {
          if (RN.AppState.currentState !== 'active') return;
          var c = cfgNow();
          if (!c.alertNew) return;
          // the first pass only records what already exists, so wait until our own full list is in
          // (or two minutes have passed), or every already-hidden quest would be announced as new
          if (!c.seeded && !selfAt && Date.now() - startedAt < 120000) return;
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
              if (shown++ < 3) toast('QI_NEW_' + d.id, (d.hidden ? 'New hidden quest: ' : 'New quest: ') + (d.known ? d.name : 'no details yet') + (d.reward ? ' (' + d.reward + ')' : '') + (rl ? ' ' + rl : ''));
            });
            if (shown > 3) toast('QI_NEW_MORE', '+' + (shown - 3) + ' more new quests');
          }
          ctx.jsonStorage.set({ seeded: true, seen: Array.from(seenMemo).slice(-500) }).catch(function () {});
        } catch (e) { ctx.plugin.reportError(e); }
      }
      var remMemo = null;
      function remind() {
        try {
          if (RN.AppState.currentState !== 'active') return;
          var c = cfgNow();
          if (!c.remind) return;
          if (!remMemo) remMemo = new Set(c.reminded);
          var changed = false;
          unify(collect()).forEach(function (x) {
            if (x.status !== 'enrolled' || !Number.isFinite(x.expMs)) return;
            var left = x.expMs - Date.now();
            if (left <= 0 || left > 24 * 3600000) return;
            var tier = left <= 3 * 3600000 ? '3' : '24', key = x.id + ':' + tier;
            if (remMemo.has(key)) return;
            remMemo.add(key); remMemo.add(x.id + ':24'); changed = true;
            toast('QI_EXP_' + key, (x.known ? x.name : 'A quest') + ' expires in ' + timeLeft(x.expMs).replace(' left', '') + (Number.isFinite(x.progress) ? ' (' + x.progress + '% done)' : ''), false, 'clock');
          });
          if (changed) ctx.jsonStorage.set({ reminded: Array.from(remMemo).slice(-300) }).catch(function () {});
        } catch (e) { ctx.plugin.reportError(e); }
      }
      var timer = null;
      Promise.resolve(ctx.jsonStorage.get()).catch(function () {}).then(function () {
        var cs = cfgNow();
        if (isObj(cs.regions) && Object.keys(cs.regions).length) setRegions(cs.regions, Number(cs.regionsAt) || 0);
        if (isObj(cs.meta) && Object.keys(cs.meta).length) setMeta(cs.meta, Number(cs.metaAt) || 0);
        if (isObj(cs.gone)) Object.keys(cs.gone).forEach(function (k) { if (/^\d{5,25}$/.test(k) && typeof cs.gone[k] === 'number' && cs.gone[k] > (Number(cs.goneClearedAt) || 0)) goneMap[k] = cs.gone[k]; });
        if (isObj(cs.locked)) Object.keys(cs.locked).forEach(function (k) { if (/^\d{5,25}$/.test(k) && typeof cs.locked[k] === 'number' && cs.locked[k] > (Number(cs.lockedClearedAt) || 0)) lockedMap[k] = cs.locked[k]; });
        if (isObj(cs.learned)) Object.keys(cs.learned).forEach(function (k) { var r = cs.learned[k]; if (/^\d{5,25}$/.test(k) && isObj(r) && Array.isArray(r.y) && Array.isArray(r.n)) learnedMap[k] = { y: codeList(r.y), n: codeList(r.n) }; });
        loadRegions(false);
        if (cs.detectIp) detectCountry(true);
        fetchSelf(true);
        timer = setInterval(function () { patchHttp(); if (RN.AppState.currentState === 'active') { if (cfgNow().detectIp) detectCountry(false); fetchSelf(false); maybeMeta(); maybeProbe(); remind(); if (cfgNow().autoClaim) autoClaim().catch(function (e) { ctx.plugin.reportError(e); }); } check(); }, 8000);
        check();
      });
      cleanup(function () { if (timer) clearInterval(timer); });

      // a row of its own in Valenced's settings list (next to Plugins, Themes, Developer ...)
      try {
        var S = V.discord.modules.settings, ROW = 'moon.quest-inspector.row', offs = [];
        cleanup(function () { offs.forEach(function (f) { try { f(); } catch (e) {} }); });
        var QuestScreen = function (sp) {
          React.useLayoutEffect(function () { try { sp.navigation.setOptions({ title: 'Quest Inspector' }); } catch (e) {} }, []);
          return h(Inspector, { api: { jsonStorage: ctx.jsonStorage } });
        };
        var useTrailing = function () {
          var t = React.useState(0);
          React.useEffect(function () { var i = setInterval(function () { t[1](function (n) { return n + 1; }); }, 6000); return function () { clearInterval(i); }; }, []);
          try {
            var all = unify(collect()), n = all.filter(function (x) { return x.hidden && (LIVE_STATUSES.indexOf(x.status) >= 0 || x.status === 'enrolled'); }).length;
            return n ? n + ' hidden' : (all.length ? all.length + ' quests' : '');
          } catch (e) { return ''; }
        };
        var register = function () {
          offs.push(S.registerSettingsItem(ROW, {
            parent: null, type: 'route',
            IconComponent: function () { return h(V.components.TableRowAssetIcon, { name: 'QuestsIcon' }); },
            useTitle: function () { return 'Quest Inspector'; },
            useTrailing: useTrailing,
            screen: { route: ROW, getComponent: function () { return QuestScreen; } }
          }));
          offs.push(S.addSettingsItemToSection('VALENCED', ROW, -1));
          rowRegistered = true;
          if (typeof S.refreshSettings === 'function') S.refreshSettings();
        };
        cleanup(S.onSettingsModulesLoaded(register));
      } catch (e) { ctx.plugin.reportError(e); }
    },
    SettingsComponent: Inspector
  });
