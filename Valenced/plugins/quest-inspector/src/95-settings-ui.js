  // ---------- settings UI ----------
  var VPN_OK = VPN_LINKS.filter(function (v) { return v && typeof v.name === 'string' && typeof v.url === 'string' && /^https:\/\/[^\s]+$/.test(v.url); });
  // Discord-styled popup (the same AlertModal Valenced uses), with the plain system alert as a fallback.
  // buttons: [{ text, style: 'cancel' | 'destructive', onPress }]. The first non-cancel button is the main one.
  var popupSeq = 0;
  function popup(title, message, buttons) {
    var list = Array.isArray(buttons) && buttons.length ? buttons : [{ text: 'Close', style: 'cancel' }];
    try {
      var D = Design, AC = V.discord.actions.AlertActionCreators;
      if (!D.AlertModal || !D.AlertActionButton || !D.Text || !AC || typeof AC.openAlert !== 'function') throw new Error('no alert modal');
      var key = 'QI_POPUP_' + (++popupSeq), mainDone = false;
      var actions = list.map(function (b, i) {
        var variant = b.style === 'cancel' ? 'secondary' : b.style === 'destructive' ? 'destructive' : (!mainDone && (mainDone = true)) ? 'primary' : 'secondary';
        return h(D.AlertActionButton, { key: i, variant: variant, text: b.text, onPress: function () { if (b.onPress) { try { b.onPress(); } catch (e) {} } } });
      });
      AC.openAlert(key, h(D.AlertModal, {
        title: String(title),
        content: h(D.Text, { variant: 'text-md/medium', color: 'text-default' }, String(message || '')),
        actions: h(React.Fragment, null, actions)
      }));
    } catch (e) {
      RN.Alert.alert(String(title), String(message || ''), list.map(function (b) { return { text: b.text, style: b.style, onPress: b.onPress }; }));
    }
  }
  function bar(pct) { var n = Math.max(0, Math.min(10, Math.round(pct / 10))); return '\u25B0'.repeat(n) + '\u25B1'.repeat(10 - n); }
  var STATUS_ICON = { available: '\uD83D\uDFE2', unverified: '\uD83D\uDFE1', enrolled: '\u2705', completed: '\uD83C\uDFC1', claimed: '\uD83C\uDF81', expired: '\u231B', gone: '\u231B', old: '\u231B', locked: '\uD83D\uDD12' };
  var STATUS_WORD = { available: 'available', unverified: 'unverified', enrolled: 'accepted', completed: 'completed', claimed: 'claimed', expired: 'expired', gone: 'expired', old: 'probably expired', locked: 'not offered to you' };
  function statusIcon(x) { return x.claimable ? '\uD83C\uDFC6' : (STATUS_ICON[x.status] || '\u2B1C'); }
  function statusWord(x) { return x.claimable ? 'finished, ready to claim' : (STATUS_WORD[x.status] || x.status); }
  function shortList(list, max) {
    var names = list.slice(0, max).map(function (x) { return '\u2022 ' + (x.known ? x.name : 'Quest ' + String(x.id).slice(-6)) + (x.reward ? ' (' + x.reward + ')' : ''); });
    if (list.length > max) names.push('\u2026and ' + (list.length - max) + ' more');
    return names.join('\n');
  }
  function cycle(list, cur) { return list[(list.indexOf(cur) + 1) % list.length]; }

  function Inspector(props) {
    var storage = props && props.api && props.api.jsonStorage;
    var stored = storage ? storage.use() : null;
    var c = Object.assign({}, DEFAULTS, stored);
    var tick = React.useState(0);
    var msgS = React.useState('');
    var qS = React.useState('');
    var busyS = React.useState(false);
    var selS = React.useState(null);   // id of the quest whose page is open
    var setMsg = msgS[1];
    function set(p) { if (storage) storage.set(p).catch(function () { setMsg('Could not save setting.'); }); }

    React.useEffect(function () {
      if (storage && !c.intro) { set({ intro: true }); setTimeout(howTo, 400); }
    }, []);
    React.useEffect(function () {
      var i = setInterval(function () { tick[1](function (t) { return t + 1; }); }, 4000);
      return function () { clearInterval(i); };
    }, []);

    var d = collect();
    var all = unify(d);
    var view = applyView(all, c, qS[0]);
    var live = all.filter(function (x) { return LIVE_STATUSES.indexOf(x.status) >= 0; });
    var claimable = all.filter(function (x) { return x.claimable; });
    var liveHidden = live.filter(function (x) { return x.hidden; });
    var hiddenCount = all.filter(function (x) { return x.hidden; }).length;
    var hasHttp = !!httpModule();
    var cc = countryCounts(liveHidden);
    function showCountries() {
      var lines = cc.top.map(function (code) { return flag(code, true) + ': ' + cc.counts[code]; });
      if (cc.globalN) lines.push('\uD83C\uDF10 global: ' + cc.globalN);
      if (cc.open) lines.push('limited only by an exclude list (open to most countries): ' + cc.open);
      if (cc.unknown) lines.push('region unknown: ' + cc.unknown);
      popup('Live hidden quests by country', lines.length ? lines.join('\n') : 'Nothing to count yet.');
    }
    var lockedN = all.filter(function (x) { return x.status === 'locked'; }).length;
    var goneN = all.filter(function (x) { return x.status === 'gone'; }).length;
    var stubCount = all.filter(function (x) { return !x.known; }).length;
    var TI = V.components.SearchInput || Design.TextInput || RN.TextInput;
    function onText(x) { qS[1](typeof x === 'string' ? x : ((x && x.nativeEvent && x.nativeEvent.text) || '')); }

    function confirmAccept(list, title) {
      if (busyS[0]) { setMsg('Already accepting, please wait.'); return; }
      if (list.length === 0) {
        setMsg('Nothing to accept. ' + (lockedN ? lockedN + ' quest(s) were refused by Discord as unknown, which usually means they are not offered to your region or account. ' : '') + (goneN ? goneN + ' have expired. ' : '') + 'Tap \u201cRetry refused quests\u201d after changing region.');
        return;
      }
      popup(title, shortList(list, 8) + '\n\nEach one is only counted if Discord confirms it.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept', onPress: function () { busyS[1](true); acceptList(list, setMsg).finally(function () { busyS[1](false); }); } }
      ]);
    }
    function openQuest(x) { selS[1](x.id); }
    function runBusy(fn, msg) { if (busyS[0]) { setMsg('Already working, please wait.'); return; } busyS[1](true); fn().finally(function () { busyS[1](false); }); }
    // the page of one quest: everything known about it, per-task progress and the actions
    function questPage(x) {
      var types = x.types.map(function (t) { return TYPE_LABELS[t] || t.toLowerCase(); }).join(', ');
      var canAccept = LIVE_STATUSES.indexOf(x.status) >= 0 || x.status === 'locked';
      return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 24 } },
        h(V.components.Page, null,
          h(Design.TableRowGroup, { title: 'Quest' },
            h(Design.TableRow, { label: '\u2190 Back to the list', onPress: function () { selS[1](null); } }),
            h(Design.TableRow, { label: statusIcon(x) + ' ' + (x.known ? x.name : 'Quest ' + x.id), subLabel: statusWord(x) + (x.status === 'locked' ? ' (Discord says unknown quest)' : x.status === 'unverified' ? ' (no details yet)' : '') }),
            !!x.app && h(Design.TableRow, { label: 'Game: ' + x.app }),
            !!x.reward && h(Design.TableRow, { label: 'Reward: ' + x.reward }),
            !!timeLeft(x.expMs) && h(Design.TableRow, { label: 'Time: ' + timeLeft(x.expMs), subLabel: Number.isFinite(x.expMs) ? 'Ends ' + new Date(x.expMs).toLocaleString() : undefined }),
            !!types && h(Design.TableRow, { label: 'Type: ' + types }),
            !!regionLabel(x.id, true) && h(Design.TableRow, { label: regionLabel(x.id, true), subLabel: ({ yes: 'Your country is allowed.', no: 'Your country is not allowed.', maybe: 'May work from your country.', unknown: 'Not known if your country is allowed.' })[access(x.id)] }),
            x.hidden && h(Design.TableRow, { label: 'Hidden: ' + hiddenReason(x) }),
            h(Design.TableRow, { label: 'Quest id: ' + x.id, subLabel: 'Tap to copy.', onPress: function () { copyText(x.id, setMsg); } })),
          !!x.tasks.length && h(Design.TableRowGroup, { title: 'Tasks' },
            x.tasks.map(function (t, k) { return h(Design.TableRow, { key: k, label: t.label + ': ' + t.text, subLabel: bar(t.pct) + ' ' + t.pct + '%' }); })),
          h(Design.TableRowGroup, { title: 'Actions' },
            !!x.claimable && h(Design.TableRow, { label: 'Claim reward', onPress: function () { runBusy(function () { return claimList([x], setMsg); }); } }),
            canAccept && h(Design.TableRow, { label: x.status === 'locked' ? 'Try accept anyway' : 'Accept', onPress: function () { runBusy(function () { return acceptList([x], setMsg); }); } }),
            h(Design.TableRow, { label: 'Open in Discord', onPress: function () { RN.Linking.openURL('https://discord.com/quests/' + encodeURIComponent(x.id)).catch(function () { setMsg('Could not open Discord.'); }); } }),
            h(Design.TableRow, { label: 'Copy JSON', onPress: function () { copyText(safe(x.q), setMsg); } }),
            !!msgS[0] && h(Design.TableRow, { label: msgS[0], subLabel: 'Tap to dismiss.', onPress: function () { setMsg(''); } }))));
    }
    var health = healthItems();
    var regionAge = regionsAt ? Math.max(0, Math.round((Date.now() - regionsAt) / 3600000)) + 'h ago' : 'never';

    // what the user should do next, in one sentence
    var lockedList = all.filter(function (x) { return x.status === 'locked' || (x.hidden && LIVE_STATUSES.indexOf(x.status) >= 0 && access(x.id) === 'no'); });
    var ccLocked = countryCounts(lockedList);
    var vpnTop = ccLocked.top.slice(0, 3);
    function vpnHelp() {
      var lines = ccLocked.top.slice(0, 8).map(function (code) { return flag(code, true) + ': unlocks ' + ccLocked.counts[code] + ' quest' + (ccLocked.counts[code] === 1 ? '' : 's'); });
      popup('Quests your region does not get', (lines.length ? lines.join('\n') + '\n\n' : '') +
        '1. Turn on a VPN app set to the country with the most quests (a split-tunnel for Discord is enough).\n2. Come back here and tap “Retry refused quests”.\n3. Tap “Accept all live hidden”.\n\nThe VPN can be turned off again after accepting.');
    }
    var next;
    if (d.fromSnapshot) next = { label: 'Showing your saved list', sub: selfStatus + '. Accepting waits for the fresh list.', press: function () { setMsg('Loading...'); reloadQuests(true).then(function () { setMsg(selfAt ? 'Loaded.' : 'Not loaded: ' + selfStatus); }); } };
    else if (!d.storeFound) next = { label: 'Loading quests...', sub: selfStatus + '. Tap to try again.', press: function () { setMsg('Loading...'); reloadQuests(true).then(function () { setMsg(selfAt ? 'Loaded.' : 'Not loaded: ' + selfStatus); }); } };
    else if (lockedN && !liveHidden.length) next = { label: lockedN + ' quest' + (lockedN === 1 ? '' : 's') + ' not offered in your region', sub: (vpnTop.length ? 'Best VPN country: ' + vpnTop.map(function (k) { return flag(k, true) + ' (' + ccLocked.counts[k] + ')'; }).join(', ') + '. ' : '') + 'Tap for the steps.', press: vpnHelp };
    else if (liveHidden.length) next = { label: liveHidden.length + ' hidden quest' + (liveHidden.length === 1 ? ' is' : 's are') + ' ready to accept', sub: 'Tap to accept them all.', press: function () { confirmAccept(liveHidden, 'Accept ' + liveHidden.length + ' hidden quests?'); } };
    else next = { label: 'Nothing hidden is live right now', sub: 'You will get an alert when a new quest appears.' };
    var q = qS[0];
    var active = all.filter(function (x) { return x.status === 'enrolled' || x.claimable; }).sort(function (a, b) { return (Number.isFinite(a.expMs) ? a.expMs : Infinity) - (Number.isFinite(b.expMs) ? b.expMs : Infinity); });
    function howTo() {
      popup('How to use Quest Inspector', '1. The plugin loads your quests by itself.\n2. The top row tells you the next step. Tap \u201cAccept all live hidden\u201d to accept every hidden quest that is live.\n3. If Discord refuses quests for your region, turn on a VPN in the country shown under \u201cVPN apps\u201d. The plugin notices the new country and checks again.\n4. Accepted quests show their progress at the top, and you get a reminder before they expire.');
    }

    var opened = selS[0] ? all.filter(function (z) { return z.id === selS[0]; })[0] : null;
    if (opened) return questPage(opened);
    // rows of the quest list (also used for the grouped sections)
    function questRow(x) {
      var types = x.types.map(function (t) { return TYPE_LABELS[t] || t.toLowerCase(); }).join(', ');
      var left = x.status === 'expired' || x.status === 'gone' || x.status === 'old' ? '' : timeLeft(x.expMs);
      return h(Design.TableRow, {
        key: x.id, label: statusIcon(x) + ' ' + (x.known ? x.name : 'Quest ' + String(x.id).slice(-8)),
        subLabel: [statusWord(x), x.reward, left, regionLabel(x.id), x.app, types, x.hidden && x.status !== 'locked' ? 'hidden' : '', Number.isFinite(x.progress) && x.status === 'enrolled' ? x.progress + '% done' : ''].filter(Boolean).join(' \u00b7 '),
        onPress: function () { openQuest(x); }
      });
    }
    var sections = groupQuests(view, c.group);

    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 24 } },
      h(V.components.Page, null,
        h(Design.TableRowGroup, { title: 'Next step' },
          h(Design.TableRow, { label: next.label, subLabel: next.sub, onPress: next.press }),
          h(Design.TableRow, { label: 'How to use', subLabel: 'A 30-second guide.', onPress: howTo }),
          !!msgS[0] && h(Design.TableRow, { label: msgS[0], onPress: function () { setMsg(''); }, subLabel: 'Tap to dismiss.' })),

        !!active.length && h(Design.TableRowGroup, { title: 'In progress (' + active.length + ')' },
          active.map(function (x) {
            var pct = Number.isFinite(x.progress) ? x.progress : 0;
            return h(Design.TableRow, {
              key: x.id, label: x.known ? x.name : 'Quest ' + String(x.id).slice(-8),
              subLabel: [bar(pct) + ' ' + pct + '%', x.taskText.join(', '), x.reward, timeLeft(x.expMs)].filter(Boolean).join(' \u00b7 '),
              onPress: function () { openQuest(x); }
            });
          })),

        h(Design.TableRowGroup, { title: 'Accept' },
          h(Design.TableRow, {
            label: 'Accept all live hidden (' + liveHidden.length + ')',
            subLabel: 'Hidden quests that are available now. Skips expired, accepted and finished ones.',
            onPress: function () { confirmAccept(liveHidden, 'Accept ' + liveHidden.length + ' hidden quests?'); }
          }),
          h(Design.TableRow, {
            label: 'Accept all available (' + live.length + ')',
            subLabel: 'Every quest you have not accepted yet, hidden or not.',
            onPress: function () { confirmAccept(live, 'Accept ' + live.length + ' quests?'); }
          }),
          !!claimable.length && h(Design.TableRow, {
            label: 'Claim finished quests (' + claimable.length + ')',
            subLabel: 'Claims the reward of every quest whose tasks are done.',
            onPress: function () { if (busyS[0]) { setMsg('Already working, please wait.'); return; } busyS[1](true); claimList(claimable, setMsg).finally(function () { busyS[1](false); }); }
          }),
          h(Design.TableRow, {
            label: 'Retry refused quests' + (lockedN + goneN ? ' (' + (lockedN + goneN) + ')' : ''),
            subLabel: 'Forget what Discord refused so it is checked again, e.g. after turning a VPN on or off.',
            onPress: function () { clearRefused('all'); probeNextAt = 0; setMsg('Cleared. Refreshing...'); reloadQuests(true).then(function () { return loadProbe(); }).then(function () { setMsg('Checked again: ' + probeStatus); }, function () { setMsg('Cleared. Pull to refresh the Quests screen.'); }); }
          }),
          !!lockedN && h(Design.TableRow, { label: 'Why are some refused?', subLabel: 'Discord does not offer them in your region. Tap for what to do.', onPress: vpnHelp })),

        // inputs go straight in the Page (like Valenced's own plugins), not inside a TableRowGroup
        h(TI, { value: q, placeholder: 'Search name, reward, game, type, country code', size: 'md', onChange: onText, onChangeText: onText }),
        h(Design.TableRowGroup, { title: 'Quests (' + view.length + ' of ' + all.length + ')' },
          h(Design.TableRow, (function () {
            if (userRegion.from === 'ip') return { label: 'Your country: ' + flag(ipCountry.cc, true) + ' (' + ipCountry.cc + ')', subLabel: 'From your IP, so it follows a VPN. ' + (userRegion.guess.length && userRegion.guess.indexOf(ipCountry.cc) < 0 ? 'The quests Discord shows you point to ' + flags(userRegion.guess, 3) + ', so Discord may see you elsewhere. ' : '') + 'Tap to check again.', onPress: function () { setMsg('Checking your country...'); detectCountry(true).then(function () { setMsg(ipCountry.cc ? 'You are in ' + ipCountry.cc + '.' : 'Country check ' + ipCountry.status); }); } };
            if (userRegion.codes.length) return { label: 'Your region: ' + flags(userRegion.codes, 4, true), subLabel: 'Guessed from the ' + userRegion.n + ' region-limited quests Discord shows you. Tap to try your IP instead.', onPress: function () { detectCountry(true).then(function () { setMsg(ipCountry.cc ? 'You are in ' + ipCountry.cc + '.' : 'Country check ' + ipCountry.status); }); } };
            return { label: 'Your country: not known yet', subLabel: (c.detectIp ? 'IP check ' + ipCountry.status + '. ' : 'IP check is off in Options. ') + 'Tap to try.', onPress: function () { detectCountry(true).then(function () { setMsg(ipCountry.cc ? 'You are in ' + ipCountry.cc + '.' : 'Country check ' + ipCountry.status); }); } };
          })()),
          h(Design.TableRow, { label: 'Show: ' + c.filter + ' (' + view.length + ')', subLabel: 'Tap to change. Next: ' + cycle(FILTERS, c.filter) + '. All options: ' + FILTERS.join(', ') + '.', onPress: function () { set({ filter: cycle(FILTERS, c.filter) }); } }),
          h(Design.TableRow, { label: 'Region: ' + c.region, subLabel: 'Tap to change: ' + REGION_FILTERS.join(' / ') + '. You can also search a country code like US or IQ.', onPress: function () { set({ region: cycle(REGION_FILTERS, c.region) }); } }),
          h(Design.TableRow, { label: 'Group by: ' + c.group, subLabel: 'Tap to change: ' + GROUPS.join(' / ') + '.', onPress: function () { set({ group: cycle(GROUPS, c.group) }); } }),
          cc.top.length > 0 && h(Design.TableRow, {
            label: 'Unlock by country: ' + cc.top.slice(0, 3).map(function (code) { return flag(code, true) + ' (' + cc.counts[code] + ')'; }).join(', '),
            subLabel: 'Live hidden quests each country would show you. Tap for the full list.',
            onPress: showCountries
          }),
          view.length === 0
            ? h(Design.TableRow, { label: q ? 'No quests match \u201c' + q + '\u201d' : 'No quests in this view', subLabel: q ? 'Clear the search or change \u201cShow\u201d.' : 'Try \u201cShow: all\u201d.' })
            : c.group === 'none' ? view.map(questRow) : null),
        c.group !== 'none' && sections.map(function (sec) {
          return h(Design.TableRowGroup, { key: sec.title, title: sec.title + ' (' + sec.items.length + ')' }, sec.items.map(questRow));
        }),

        h(Design.TableRowGroup, { title: 'VPN apps' },
          h(Design.TableRow, { label: vpnTop.length ? 'Best country now: ' + vpnTop.map(function (k) { return flag(k, true); }).join(', ') : 'Pick a country that unlocks the most quests', subLabel: 'Switch the VPN to it, and the plugin notices and re-checks by itself.', onPress: vpnHelp }),
          VPN_OK.map(function (v) { return h(Design.TableRow, { key: v.name, label: v.name, subLabel: v.url.replace(/^https:\/\//, ''), onPress: function () { RN.Linking.openURL(v.url).catch(function () { setMsg('Could not open ' + v.url); }); } }); }),
          VPN_OK.length === 0 && h(Design.TableRow, { label: 'No VPN links yet', subLabel: 'Add them in the VPN_LINKS list at the top of the plugin code.' })),

        h(Design.TableRowGroup, { title: 'Options' },
          h(Design.TableSwitchRow, { label: 'Show live hidden quests in Discord’s Quests screen', subLabel: 'Adds hidden quests that are available or accepted to the native list. Reload after changing.', value: !!c.showHidden, onValueChange: function (v) { set({ showHidden: v }); } }),
          h(Design.TableSwitchRow, { label: 'Find my country from my IP', subLabel: 'Asks api.country.is (then ipwho.is) which country your connection is in. Nothing else is sent.', value: !!c.detectIp, onValueChange: function (v) { set({ detectIp: v }); if (v) detectCountry(true); } }),
          h(Design.TableSwitchRow, { label: 'Claim rewards automatically', subLabel: 'Claims a quest\u2019s reward once all its tasks are done. Failures show in the Last accept log.', value: !!c.autoClaim, onValueChange: function (v) { set({ autoClaim: v }); } }),
          h(Design.TableSwitchRow, { label: 'Accept new quests automatically', subLabel: 'Off by default. Only quests that appear after you turn this on. Stops by itself if Discord asks for a captcha.', value: !!c.autoAccept, onValueChange: function (v) {
            if (!v) { set({ autoAccept: false }); return; }
            if (!selfAt) { setMsg('Wait until your quests have loaded, then turn this on.'); return; }
            set({ autoAccept: true, aaBase: all.map(function (z) { return z.id; }).slice(-1000) });
            setMsg('Auto-accept is on. The ' + all.length + ' quests that exist now are left alone.');
          } }),
          h(Design.TableSwitchRow, { label: 'Remind me before accepted quests expire', subLabel: 'A toast 24 hours and 3 hours before.', value: !!c.remind, onValueChange: function (v) { set({ remind: v }); } }),
          h(Design.TableSwitchRow, { label: 'Alert me about new quests', subLabel: 'Says when a new quest is a hidden one.', value: !!c.alertNew, onValueChange: function (v) { set({ alertNew: v }); } }),
          h(Design.TableSwitchRow, { label: 'Soonest-expiring first', value: !!c.sortSoonest, onValueChange: function (v) { set({ sortSoonest: v }); } }),
          h(Design.TableSwitchRow, { label: 'Download quest names automatically', subLabel: 'About 5 MB from GitHub, at most every 6 hours, only when hidden quests have no details.', value: !!c.autoMeta, onValueChange: function (v) { set({ autoMeta: v }); } }),
          h(Design.TableSwitchRow, { label: 'Check hidden quests with Discord', subLabel: 'Small, spaced-out requests that confirm a quest is still active.', value: !!c.autoProbe, onValueChange: function (v) { set({ autoProbe: v }); } }),
          h(Design.TableRow, { label: 'Delay between accepts: ' + (c.acceptDelay / 1000) + 's', subLabel: 'Tap to change: 1s / 1.5s / 3s / 5s.', onPress: function () { set({ acceptDelay: cycle([1000, 1500, 3000, 5000], c.acceptDelay) }); } })),

        h(Design.TableRowGroup, { title: 'Health check (' + health.filter(function (i) { return i.ok === false; }).length + ' problems)' },
          health.map(function (i) { return h(Design.TableRow, { key: i.name, label: (i.ok === true ? '\u2705 ' : i.ok === false ? '\u274C ' : '\u2796 ') + i.name, subLabel: i.detail }); })),

        h(Design.TableRowGroup, { title: 'Details and tools' },
          h(Design.TableRow, { label: all.length + ' quests: ' + live.length + ' available, ' + hiddenCount + ' hidden by client' + (lockedN ? ', ' + lockedN + ' not offered' : '') + (goneN ? ', ' + goneN + ' expired' : '') }),
          h(Design.TableRow, { label: 'Names: ' + (all.length - stubCount) + ' of ' + all.length + ' have details' + (stubCount ? ' (' + stubCount + ' only an id)' : ''), subLabel: 'From a community tracker (' + metaStatus + '). Quests newer than it stay as ids. Tap to download.', onPress: function () { setMsg('Downloading quest details...'); loadMeta(true).then(function (okM) { setMsg(okM ? 'Quest details updated.' : 'Quest details: ' + metaStatus); }); } }),
          h(Design.TableRow, { label: 'Regions: ' + regionStatus, subLabel: 'Updated ' + regionAge + '. Community list, may be out of date. Tap to refresh.', onPress: function () { setMsg('Updating regions...'); loadRegions(true).then(function (okR) { setMsg(okR ? 'Regions updated.' : 'Regions: ' + regionStatus); }); } }),
          h(Design.TableRow, { label: 'Requests sent to Discord in the last hour: ' + sentLastHour(), subLabel: Date.now() < backoffUntil ? 'Discord asked for a pause, resuming in ' + Math.ceil((backoffUntil - Date.now()) / 60000) + ' min.' : 'The plugin keeps this low on purpose: it reloads every 15 min (3 min while a quest is in progress) and checks only what it must.' }),
          h(Design.TableRow, { label: 'Live check: ' + probeStatus, subLabel: 'Asks Discord if each hidden quest is still active (newest 25 at a time). Tap to run now.', onPress: function () { setMsg('Checking with Discord...'); loadProbe().then(function () { setMsg('Live check: ' + probeStatus); }); } }),
          h(Design.TableRow, (function () {
            var e = enrollLog[enrollLog.length - 1];
            if (!e) return { label: 'Last accept: none yet', subLabel: 'Every accept, including Discord’s own button, is recorded here with the server’s answer.' };
            var qq = all.filter(function (x) { return x.id === e.id; })[0];
            return {
              label: 'Last accept: ' + (e.ok ? 'worked' : 'refused') + ' · ' + (qq && qq.known ? qq.name : e.id) + ' · ' + e.src,
              subLabel: e.text + (e.sent ? ' (sent ' + e.sent + ')' : '') + '. Tap to copy the last ' + enrollLog.length + '.',
              onPress: function () { copyText(JSON.stringify(enrollLog.map(function (z) { return { id: z.id, ok: z.ok, by: z.src, reply: z.text, sent: z.sent, secondsAgo: Math.round((Date.now() - z.at) / 1000) }; }), null, 2), setMsg); }
            };
          })()),
          h(Design.TableRow, (function () {
            var f = lastHook.useFilteredQuests;
            if (!f) return { label: 'Discord\u2019s own Quests screen: not opened since start', subLabel: 'The plugin does not need it. This only matters for the \u201cshow hidden quests there\u201d option.' };
            var shown = Array.isArray(f.quests) ? f.quests.length : 0, hid = Array.isArray(f.excludedQuests) ? f.excludedQuests.length : 0;
            return { label: 'Discord\u2019s own Quests screen: shows ' + shown + ', hides ' + hid, subLabel: shown === 0 && selfQuests.length ? 'It is empty but the plugin found ' + selfQuests.length + '. The plugin asked Discord to reload; reopen the screen.' : 'What Discord itself got from the server last time you opened it.' };
          })()),
          !!skippedHidden && h(Design.TableRow, { label: skippedHidden + ' hidden quest(s) not added to Discord’s list', subLabel: 'No details for them yet, so Discord’s quest card could not draw them.' }),
          !hasHttp && h(Design.TableRow, { label: 'Discord HTTP client NOT found', subLabel: 'Needed to load and accept quests. Reload the app and try again.' }),
          h(Design.TableRow, {
            label: 'Refresh quests from Discord',
            subLabel: 'Quest list: ' + selfStatus + (selfAt ? ' (' + Math.max(0, Math.round((Date.now() - selfAt) / 60000)) + ' min ago)' : ''),
            onPress: function () { setMsg('Reloading...'); reloadQuests(true).then(function () { setMsg(selfAt ? 'Reloaded: ' + selfStatus : 'Reload ' + selfStatus); }); }
          }),
          h(Design.TableRow, { label: 'Copy report', subLabel: 'Version, health and recent accepts as text for a bug report. No token, no sealed data.', onPress: function () { copyText(buildReport(), setMsg); } }),
          h(Design.TableRow, { label: 'Copy everything as JSON', subLabel: 'Raw quests plus store/hook keys, for bug reports.', onPress: function () { copyText(safe(d), setMsg); } }))));
  }

