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
  // A hidden quest arrives as a stub. If the tracker has its config, build a full quest from it.
  function materialize(q) {
    if (!isObj(q)) return null;
    if (isObj(q.config) && hasMessages(q.config)) return q;
    var m = own(metaMap, q.id);
    if (!m) return null;
    return { id: q.id, config: m, userStatus: q.userStatus || q.user_status || null, preview: false, targetedContent: [] };
  }
  function mergeHidden(res) {
    if (!isObj(res) || !Array.isArray(res.quests) || !Array.isArray(res.excludedQuests) || res.excludedQuests.length === 0) return res;
    var hit = mergedCache.get(res);
    if (hit) return hit;
    var ids = new Set(res.quests.map(function (q) { return q && q.id; }));
    var skipped = 0, extra = [];
    res.excludedQuests.forEach(function (q) {
      if (!isObj(q) || ids.has(q.id)) return;
      var full = materialize(q);
      // Discord's QuestCard crashes on a quest that lacks the data it renders, so only merge complete ones
      if (!full || !cardReady(full)) { skipped++; return; }
      if (describe(full).status !== 'available' && describe(full).status !== 'enrolled') return;
      extra.push(full);
    });
    skippedHidden = skipped;
    if (extra.length === 0) return res;
    var merged = Object.assign({}, res, { quests: res.quests.concat(extra), excludedQuests: [] });
    mergedCache.set(res, merged);
    return merged;
  }

