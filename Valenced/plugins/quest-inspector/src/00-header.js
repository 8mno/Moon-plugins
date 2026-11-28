  // ==================== EDIT HERE: the VPN links shown in the settings ====================
  // One line per VPN: { name: 'Shown name', url: 'https://link' }. Only https:// links are used.
  var VPN_LINKS = [
    { name: 'Proton VPN (free plan)', url: 'https://protonvpn.com/free-vpn' },
    { name: 'Windscribe (free plan)', url: 'https://windscribe.com/' },
    { name: 'Ninja VPN', url: 'https://ninjavpn.app/' }
  ];
  // =========================================================================================

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
    filter: 'live hidden', // live hidden | all | available | enrolled | hidden | finished
    region: 'any',       // any | global | regional
    regions: {},         // cached region data, see REGIONS_URL
    regionsAt: 0,
    autoMeta: true,      // download quest names/details for hidden quests (about 5 MB, at most every 6 hours)
    meta: {},            // cached quest configs for hidden quests, see META_URLS
    metaAt: 0,
    autoClaim: true,     // claim the reward by itself when a quest you accepted is finished
    detectIp: true,      // find your country from your IP (api.country.is, then ipwho.is), through the same connection Discord uses
    learned: {},         // quest id -> {y:[countries it worked from], n:[countries Discord refused it from]}
    remind: true,        // toast when an accepted quest is about to expire
    reminded: [],        // reminders already shown (quest id + tier)
    intro: false,        // the first-open how-to was shown
    autoProbe: true,     // ask Discord (GET /quests/{id}) whether hidden quests are still active
    gone: {},            // quest id -> when Discord said it has expired
    goneClearedAt: 0,    // "Retry refused quests" was pressed at this time: older refusals are ignored
    lockedClearedAt: 0,
    locked: {},          // quest id -> when Discord said it is unknown (not offered to this account/region)
    autoAccept: false,   // opt-in: accept quests that appear after it was switched on
    aaBase: [],          // quest ids that already existed when auto-accept was switched on (never auto-accepted)
    group: 'none',       // none | game | reward | status
    snapshot: null,      // { at, json } last quest list, so the screen is filled before the first load
    acceptDelay: 1500,   // ms between "Accept all" requests
    seeded: false,
    seen: []
  };
  var GROUPS = ['none', 'game', 'reward', 'status'];
  var FILTERS = ['live hidden', 'all', 'available', 'enrolled', 'hidden', 'finished', 'not offered'];
  var REGION_FILTERS = ['any', 'global', 'regional'];
  // Third-party, community-kept list of which countries each quest is limited to. It is only used
  // for display, can be out of date, and the plugin works without it.
  var REGIONS_URL = 'https://gist.githubusercontent.com/xGustavvo/3d08b7369eb34b50834815fd43176cae/raw';
  var REGIONS_TTL = 6 * 3600 * 1000;
  // Discord only sends hidden quests as bare stubs (an id, sometimes a replacement_id), with no name,
  // reward or dates. This community tracker keeps the full quest configs. Oldest first, later wins.
  var TRACKER = 'https://raw.githubusercontent.com/xGustavvo/discord-api-tracker/refs/heads/main/';
  var META_URLS = [TRACKER + 'quest.json', TRACKER + 'data/quests-01.json', TRACKER + 'data/quests-02.json'];
  var META_RETRY_FAIL = 30 * 60 * 1000;
  var META_RETRY_OK = 6 * 3600 * 1000;
  var LIVE_STATUSES = ['available', 'unverified'];
  var PROBE_MAX = 10;                      // quests asked about per run
  var PROBE_MAX_AGE_DAYS = 35;             // older ids are not worth asking about
  var PROBE_GONE_TTL = 24 * 3600 * 1000;   // how long "expired" is remembered
  var LOCKED_TTL = 6 * 3600 * 1000;        // how long "not offered to you" is remembered; a country change or "Retry" clears it sooner
  var PROBE_GAP = 1500;                    // ms between requests
  var QUEST_HOME_MOBILE = 12;   // "location" Discord's accept request needs (QUEST_HOME_MOBILE)
  var DESKTOP_ONLY = ['PLAY_ON_DESKTOP', 'PLAY_ON_XBOX', 'PLAY_ON_PLAYSTATION', 'STREAM_ON_DESKTOP'];
  var TYPE_LABELS = {
    WATCH_VIDEO: 'watch video', WATCH_VIDEO_ON_MOBILE: 'watch video (mobile)',
    PLAY_ON_DESKTOP: 'play on desktop', PLAY_ON_XBOX: 'play on Xbox',
    PLAY_ON_PLAYSTATION: 'play on PlayStation', PLAY_ACTIVITY: 'play activity',
    STREAM_ON_DESKTOP: 'stream', ACHIEVEMENT_IN_ACTIVITY: 'activity achievement'
  };

  var PLUGIN_VERSION = '__VERSION__';   // filled in from manifest.json by build.js
  var rowRegistered = false;  // the row in Valenced's settings list
  var lastClaimPlatform = null;
  var lastHook = {};        // last results seen from Discord's own quest hooks
  var lastHookAt = 0;       // when Discord's Quests screen last rendered (its data can be older than our own copy)
  var storageRef = null;    // jsonStorage, set in start()

