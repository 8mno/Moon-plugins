  // ---------- record what the server says to every accept (ours and Discord's own button) ----------
  var enrollLog = [];       // newest last, capped
  var viaPlugin = 0;        // > 0 while the plugin itself is sending an accept
  function recordEnroll(id, ok, text, src, sent) {
    enrollLog.push({ id: id, ok: ok, text: String(text).slice(0, 300), src: src, sent: sent || '', at: Date.now() });
    if (enrollLog.length > 12) enrollLog.shift();
  }
  // Remember a refusal so the quest leaves the live list: expired for a day, "not offered" for 30 minutes
  function markRefused(id, e) {
    var kind = refusalKind(e);
    if (!kind) return;
    var one = {}; one[id] = Date.now();
    (kind === 'gone' ? goneMap : lockedMap)[id] = one[id];
    if (kind === 'locked') learn(id, false);
    try { if (storageRef) storageRef.set(kind === 'gone' ? { gone: one } : { locked: one }).catch(function () {}); } catch (e2) {}
  }
  function bodyPreview(b) { try { return JSON.stringify(b).slice(0, 200); } catch (e) { return ''; } }

