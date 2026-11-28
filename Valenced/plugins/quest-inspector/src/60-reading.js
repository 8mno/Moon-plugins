  // ---------- reading quest objects (field names defensive; verify with the JSON export) ----------
  function describe(q) {
    var out = { id: '', name: 'unknown', status: 'available', types: [], expMs: NaN, reward: '', app: '', progress: NaN, known: false };
    if (!isObj(q)) return out;
    var cfg = isObj(q.config) ? q.config : (own(metaMap, q.id) || {});
    var msgs = isObj(cfg.messages) ? cfg.messages : {};
    var us = isObj(q.userStatus) ? q.userStatus : (isObj(q.user_status) ? q.user_status : {});
    var tc = cfg.taskConfigV2 || cfg.task_config_v2 || cfg.taskConfig || cfg.task_config;
    var rc = cfg.rewardsConfig || cfg.rewards_config;
    var rw = isObj(rc) && Array.isArray(rc.rewards) && isObj(rc.rewards[0]) ? rc.rewards[0] : null;
    var rm = rw && isObj(rw.messages) ? rw.messages : {};
    out.id = typeof q.id === 'string' ? q.id : '';
    out.name = msgs.questName || msgs.quest_name || msgs.gameTitle || out.id || 'unknown';
    out.expMs = Date.parse(cfg.expiresAt || cfg.expires_at);
    out.types = isObj(tc) && isObj(tc.tasks) ? Object.keys(tc.tasks) : [];
    out.reward = rm.name || rm.nameWithArticle || rm.name_with_article || '';
    var orbs = rw ? Number(rw.orbQuantity || rw.orb_quantity) : NaN;
    if (!out.reward && orbs > 0) out.reward = orbs + ' orbs';
    var tasks = isObj(tc) && isObj(tc.tasks) ? tc.tasks : null;
    var prog = isObj(us.progress) ? us.progress : null;
    out.taskText = [];
    out.tasks = [];
    if (tasks) {
      var sum = 0, n = 0, pg = prog || {};
      Object.keys(tasks).forEach(function (k) {
        var target = isObj(tasks[k]) ? Number(tasks[k].target) : NaN;
        if (!(target > 0)) return;
        var val = isObj(pg[k]) ? Number(pg[k].value) || 0 : 0;
        sum += Math.min(val / target, 1); n++;
        var secs = ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE', 'PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'PLAY_ACTIVITY', 'STREAM_ON_DESKTOP'].indexOf(k) >= 0 && target >= 60;
        var txt0 = secs ? Math.floor(Math.min(val, target) / 60) + '/' + Math.floor(target / 60) + ' min' : Math.min(val, target) + '/' + target;
        out.tasks.push({ label: TYPE_LABELS[k] || k.toLowerCase(), pct: Math.round(Math.min(val / target, 1) * 100), text: txt0 });
        if (prog) out.taskText.push((TYPE_LABELS[k] || k.toLowerCase()) + ' ' + txt0);
      });
      if (n && prog) out.progress = Math.round(sum / n * 100);
    }
    out.app = isObj(cfg.application) && typeof cfg.application.name === 'string' ? cfg.application.name : '';
    var txt = out.app;
    if (isObj(cfg.messages)) Object.keys(cfg.messages).forEach(function (k) { if (typeof cfg.messages[k] === 'string') txt += ' ' + cfg.messages[k]; });
    var lg = guessLanguage(txt);
    if (lg && out.id) langMap[out.id] = lg;
    out.status = (us.claimedAt || us.claimed_at) ? 'claimed'
      : (us.completedAt || us.completed_at) ? 'completed'
      : (Number.isFinite(out.expMs) && out.expMs <= Date.now()) ? 'expired'
      : (us.enrolledAt || us.enrolled_at) ? 'enrolled' : 'available';
    out.claimable = out.status === 'completed' || (out.status === 'enrolled' && out.progress >= 100);
    out.known = isObj(cfg.messages);
    out.platforms = isObj(cfg.rewardsConfig) && Number.isInteger(cfg.rewardsConfig.platforms) ? cfg.rewardsConfig.platforms : null;
    // a stub with no details has no expiry, so guess from the age of its id: quests last weeks, not months
    if (!out.known && out.status === 'available') out.status = out.id && idAgeDays(out.id) <= 30 ? 'unverified' : 'old';
    if (out.status === 'available' || out.status === 'unverified' || out.status === 'old') {
      if (isGone(out.id)) out.status = 'gone';
      else if (isLocked(out.id)) out.status = 'locked';
    }
    return out;
  }

