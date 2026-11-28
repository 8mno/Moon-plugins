  // ---------- regions ----------
  var regionMap = {};       // quest id -> { g: isGlobal, i: [include], e: [exclude], a: ageGate, r: replacementId }
  var replacedBy = {};      // replacement id -> record
  var regionsAt = 0;
  var regionStatus = 'not loaded';

  function codeList(x) { return Array.isArray(x) ? x.filter(function (c) { return typeof c === 'string' && c.length <= 8; }) : []; }
  function parseRegions(json) {
    var list = isObj(json) && Array.isArray(json.quests) ? json.quests : [];
    var out = {}, n = 0;
    list.forEach(function (r) {
      if (!isObj(r) || typeof r.id !== 'string' || !/^\d{5,25}$/.test(r.id)) return;
      var inc = [], exc = [];
      if (Array.isArray(r.regions)) inc = codeList(r.regions);
      else if (isObj(r.regions)) { inc = codeList(r.regions.include); exc = codeList(r.regions.exclude); }
      var rid = typeof r.replacement_id === 'string' && /^\d{5,25}$/.test(r.replacement_id) ? r.replacement_id : '';
      out[r.id] = { g: r.is_global === true, i: inc, e: exc, a: r.show_age_gate === true, r: rid };
      n++;
    });
    return n > 0 ? out : null;
  }
  function setRegions(map, at) {
    // the map may come back from storage, so re-check every record instead of trusting its shape
    var clean = {};
    Object.keys(map).forEach(function (k) {
      var r = map[k];
      if (!/^\d{5,25}$/.test(k) || !isObj(r) || !Array.isArray(r.i) || !Array.isArray(r.e)) return;
      clean[k] = { g: r.g === true, i: codeList(r.i), e: codeList(r.e), a: r.a === true, r: typeof r.r === 'string' && /^\d{5,25}$/.test(r.r) ? r.r : '' };
    });
    regionMap = clean; regionsAt = at; replacedBy = {};
    Object.keys(clean).forEach(function (k) { if (clean[k].r) replacedBy[clean[k].r] = clean[k]; });
    regionStatus = Object.keys(clean).length + ' quests';
  }
  var regionsLoading = null;
  function loadRegions(force) {
    if (!force && regionsAt && Date.now() - regionsAt < REGIONS_TTL) return Promise.resolve(false);
    if (!regionsLoading) {
      regionsLoading = fetchRegions().then(function (r) { regionsLoading = null; return r; }, function () { regionsLoading = null; return false; });
    }
    return regionsLoading;
  }
  async function fetchRegions() {
    regionStatus = 'loading...';
    var map;
    try {
      map = parseRegions(await fetchJson(REGIONS_URL, 15000));
      if (!map) throw new Error('unexpected format');
    } catch (e) {
      regionStatus = 'failed: ' + (e && e.message ? e.message : e);
      return false;
    }
    setRegions(map, Date.now());
    try { if (storageRef) await storageRef.set({ regions: map, regionsAt: regionsAt }); } catch (e) {}
    return true;
  }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; }
  function regionFor(id) { return own(regionMap, id) || own(replacedBy, id) || null; }
  function regionKind(id) { var r = regionFor(id); return !r ? 'unknown' : r.g ? 'global' : 'regional'; }
  // Country names (ISO 3166). Quest region lists only carry two-letter codes.
  var COUNTRY_NAMES = null;
  function cname(code) {
    var c = String(code).toUpperCase();
    if (c === 'UK') c = 'GB';
    if (!COUNTRY_NAMES) {
      COUNTRY_NAMES = {};
      'AD:Andorra|AE:United Arab Emirates|AF:Afghanistan|AG:Antigua and Barbuda|AI:Anguilla|AL:Albania|AM:Armenia|AO:Angola|AQ:Antarctica|AR:Argentina|AS:American Samoa|AT:Austria|AU:Australia|AW:Aruba|AX:Åland Islands|AZ:Azerbaijan|BA:Bosnia and Herzegovina|BB:Barbados|BD:Bangladesh|BE:Belgium|BF:Burkina Faso|BG:Bulgaria|BH:Bahrain|BI:Burundi|BJ:Benin|BL:Saint Barthélemy|BM:Bermuda|BN:Brunei|BO:Bolivia|BQ:Caribbean Netherlands|BR:Brazil|BS:Bahamas|BT:Bhutan|BW:Botswana|BY:Belarus|BZ:Belize|CA:Canada|CC:Cocos Islands|CD:DR Congo|CF:Central African Republic|CG:Republic of the Congo|CH:Switzerland|CI:Côte d\'Ivoire|CK:Cook Islands|CL:Chile|CM:Cameroon|CN:China|CO:Colombia|CR:Costa Rica|CU:Cuba|CV:Cape Verde|CW:Curaçao|CX:Christmas Island|CY:Cyprus|CZ:Czechia|DE:Germany|DJ:Djibouti|DK:Denmark|DM:Dominica|DO:Dominican Republic|DZ:Algeria|EC:Ecuador|EE:Estonia|EG:Egypt|EH:Western Sahara|ER:Eritrea|ES:Spain|ET:Ethiopia|FI:Finland|FJ:Fiji|FK:Falkland Islands|FM:Micronesia|FO:Faroe Islands|FR:France|GA:Gabon|GB:United Kingdom|GD:Grenada|GE:Georgia|GF:French Guiana|GG:Guernsey|GH:Ghana|GI:Gibraltar|GL:Greenland|GM:Gambia|GN:Guinea|GP:Guadeloupe|GQ:Equatorial Guinea|GR:Greece|GT:Guatemala|GU:Guam|GW:Guinea-Bissau|GY:Guyana|HK:Hong Kong|HN:Honduras|HR:Croatia|HT:Haiti|HU:Hungary|ID:Indonesia|IE:Ireland|IL:Israel|IM:Isle of Man|IN:India|IO:British Indian Ocean Territory|IQ:Iraq|IR:Iran|IS:Iceland|IT:Italy|JE:Jersey|JM:Jamaica|JO:Jordan|JP:Japan|KE:Kenya|KG:Kyrgyzstan|KH:Cambodia|KI:Kiribati|KM:Comoros|KN:Saint Kitts and Nevis|KP:North Korea|KR:South Korea|KW:Kuwait|KY:Cayman Islands|KZ:Kazakhstan|LA:Laos|LB:Lebanon|LC:Saint Lucia|LI:Liechtenstein|LK:Sri Lanka|LR:Liberia|LS:Lesotho|LT:Lithuania|LU:Luxembourg|LV:Latvia|LY:Libya|MA:Morocco|MC:Monaco|MD:Moldova|ME:Montenegro|MF:Saint Martin|MG:Madagascar|MH:Marshall Islands|MK:North Macedonia|ML:Mali|MM:Myanmar|MN:Mongolia|MO:Macao|MP:Northern Mariana Islands|MQ:Martinique|MR:Mauritania|MS:Montserrat|MT:Malta|MU:Mauritius|MV:Maldives|MW:Malawi|MX:Mexico|MY:Malaysia|MZ:Mozambique|NA:Namibia|NC:New Caledonia|NE:Niger|NF:Norfolk Island|NG:Nigeria|NI:Nicaragua|NL:Netherlands|NO:Norway|NP:Nepal|NR:Nauru|NU:Niue|NZ:New Zealand|OM:Oman|PA:Panama|PE:Peru|PF:French Polynesia|PG:Papua New Guinea|PH:Philippines|PK:Pakistan|PL:Poland|PM:Saint Pierre and Miquelon|PN:Pitcairn Islands|PR:Puerto Rico|PS:Palestine|PT:Portugal|PW:Palau|PY:Paraguay|QA:Qatar|RE:Réunion|RO:Romania|RS:Serbia|RU:Russia|RW:Rwanda|SA:Saudi Arabia|SB:Solomon Islands|SC:Seychelles|SD:Sudan|SE:Sweden|SG:Singapore|SH:Saint Helena|SI:Slovenia|SJ:Svalbard and Jan Mayen|SK:Slovakia|SL:Sierra Leone|SM:San Marino|SN:Senegal|SO:Somalia|SR:Suriname|SS:South Sudan|ST:São Tomé and Príncipe|SV:El Salvador|SX:Sint Maarten|SY:Syria|SZ:Eswatini|TC:Turks and Caicos Islands|TD:Chad|TG:Togo|TH:Thailand|TJ:Tajikistan|TK:Tokelau|TL:Timor-Leste|TM:Turkmenistan|TN:Tunisia|TO:Tonga|TR:Türkiye|TT:Trinidad and Tobago|TV:Tuvalu|TW:Taiwan|TZ:Tanzania|UA:Ukraine|UG:Uganda|US:United States|UY:Uruguay|UZ:Uzbekistan|VA:Vatican City|VC:Saint Vincent and the Grenadines|VE:Venezuela|VG:British Virgin Islands|VI:U.S. Virgin Islands|VN:Vietnam|VU:Vanuatu|WF:Wallis and Futuna|WS:Samoa|XK:Kosovo|YE:Yemen|YT:Mayotte|ZA:South Africa|ZM:Zambia|ZW:Zimbabwe'.split('|').forEach(function (e) { COUNTRY_NAMES[e.slice(0, 2)] = e.slice(3); });
    }
    return Object.prototype.hasOwnProperty.call(COUNTRY_NAMES, c) ? COUNTRY_NAMES[c] : c;
  }
  function flag(code, withName) {
    var c = String(code).toUpperCase();
    if (c === 'UK') c = 'GB';
    if (!/^[A-Z]{2}$/.test(c)) return String(code);
    var f = String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65);
    return withName ? f + ' ' + cname(c) : f;
  }
  function flags(list, max, withName) {
    var s = list.slice(0, max).map(function (c) { return flag(c, withName); }).join(withName ? ', ' : ' ');
    return list.length > max ? s + ' +' + (list.length - max) : s;
  }
  // A weak hint for quests missing from the region list: the language of the quest's own text.
  // Only scripts and letters that point at very few countries are used, and it is always shown as a guess.
  var LANG_RULES = [
    { re: /[\u3040-\u30FF]/, lang: 'Japanese', codes: ['JP'] },
    { re: /[\uAC00-\uD7AF\u1100-\u11FF]/, lang: 'Korean', codes: ['KR'] },
    { re: /[\u0E00-\u0E7F]/, lang: 'Thai', codes: ['TH'] },
    { re: /[\u0590-\u05FF]/, lang: 'Hebrew', codes: ['IL'] },
    { re: /[\u0900-\u097F]/, lang: 'Hindi', codes: ['IN'] },
    { re: /[\u0370-\u03FF]/, lang: 'Greek', codes: ['GR', 'CY'] },
    { re: /[\u0600-\u06FF]/, lang: 'Arabic', codes: [] },
    { re: /[\u0400-\u04FF]/, lang: 'Russian or Cyrillic', codes: ['RU', 'UA', 'KZ'] },
    { re: /[\u4E00-\u9FFF]/, lang: 'Chinese', codes: ['CN', 'TW', 'HK'] },
    { re: /[\u01A1\u01B0\u0111\u1EA0-\u1EF9]/i, lang: 'Vietnamese', codes: ['VN'] },
    { re: /[\u011F\u015F\u0131\u0130]/, lang: 'Turkish', codes: ['TR'] },
    { re: /[\u0105\u0119\u0142\u015B\u017A\u017C]/i, lang: 'Polish', codes: ['PL'] },
    { re: /[\u011B\u0159\u016F]/i, lang: 'Czech', codes: ['CZ'] },
    { re: /[\u0151\u0171]/i, lang: 'Hungarian', codes: ['HU'] },
    { re: /\u00DF/, lang: 'German', codes: ['DE', 'AT', 'CH'] },
    { re: /[\u00E3\u00F5]/i, lang: 'Portuguese', codes: ['BR', 'PT'] },
    { re: /[\u00F1\u00BF\u00A1]/i, lang: 'Spanish', codes: ['ES', 'MX'] }
  ];
  var langMap = {};            // quest id -> { lang, codes }
  function guessLanguage(text) {
    if (!text) return null;
    for (var i = 0; i < LANG_RULES.length; i++) if (LANG_RULES[i].re.test(text)) return { lang: LANG_RULES[i].lang, codes: LANG_RULES[i].codes };
    return null;
  }
  // Which country Discord thinks you are in is not exposed anywhere, but it can be worked out: every
  // regional quest Discord really shows you (not hidden, still available) must allow your country.
  // Intersect their include lists and drop their exclude lists; what is left is your country.
  var userRegion = { codes: [], n: 0, from: '', guess: [] };
  function inferRegion(list) {
    var cand = null, banned = {}, n = 0;
    list.forEach(function (x) {
      if (x.hidden || x.status !== 'available') return;
      var r = regionFor(x.id);
      if (!r || r.g) return;
      if (r.i.length) {
        var inc = {}; r.i.forEach(function (c) { inc[c] = 1; });
        cand = cand ? cand.filter(function (c) { return inc[c]; }) : r.i.slice();
        n++;
      }
      r.e.forEach(function (c) { banned[c] = 1; });
      if (r.e.length) n++;
    });
    if (cand) cand = cand.filter(function (c) { return !banned[c]; });
    // an empty answer means the lists disagree (old list, or a VPN switched mid-way): say "unknown"
    return cand && cand.length && cand.length <= 12 ? { codes: cand, n: n } : { codes: [], n: 0 };
  }
  // 'yes' | 'no' | 'maybe' | 'unknown': would Discord show this quest to the country you are in now?
  function access(id) {
    var r = regionFor(id), me = userRegion.codes, L = own(learnedMap, id);
    if (L && me.length && (!r || (!r.g && !r.i.length && !r.e.length))) {
      if (L.y.some(function (c) { return me.indexOf(c) >= 0; })) return 'yes';
      if (L.n.some(function (c) { return me.indexOf(c) >= 0; })) return 'no';
    }
    if (!r || !me.length) return 'unknown';
    if (r.g) return 'yes';
    var ok = me.filter(function (c) { return (!r.i.length || r.i.indexOf(c) >= 0) && r.e.indexOf(c) < 0; }).length;
    if (!r.i.length && !r.e.length) return 'unknown';
    return ok === me.length ? 'yes' : ok === 0 ? 'no' : 'maybe';
  }
  function regionLabel(id, long) {
    var r = regionFor(id);
    if (!r) {
      var L = own(learnedMap, id), seen = [];
      if (L && L.y.length) seen.push('works from ' + flags(L.y, 4));
      if (L && L.n.length) seen.push('refused from ' + flags(L.n, 4));
      if (seen.length) return '\uD83D\uDD0D ' + seen.join(' \u00b7 ');
      var lg = own(langMap, id);
      if (lg) return '\uD83D\uDD0E text is ' + lg.lang + (lg.codes.length ? ', so maybe ' + flags(lg.codes, 3, long || lg.codes.length === 1) : '') + ' (a guess)';
      return regionsAt ? '\u2754 region unknown (not in the list yet)' : '';
    }
    var age = r.a ? ' \uD83D\uDD1E' : '';
    if (r.g) return '\uD83C\uDF10 global' + age;
    var parts = [];
    if (r.i.length) parts.push('only ' + flags(r.i, long ? 99 : 6, long || r.i.length <= 2));
    if (r.e.length) parts.push('not ' + flags(r.e, long ? 99 : 6, long || r.e.length <= 2));
    if (!parts.length) parts.push('\uD83D\uDD12 region-limited');
    var a = access(id);
    return parts.join(' \u00b7 ') + (a === 'yes' ? ' \u00b7 \u2705 your region' : a === 'no' ? ' \u00b7 \uD83D\uDEAB not your region' : '') + age;
  }
  function regionHay(id) {
    var r = regionFor(id);
    return r ? (r.g ? 'global' : 'regional ' + r.i.concat(r.e).join(' ')) : '';
  }
  function hiddenReason(x) {
    var why = [];
    if (regionKind(x.id) === 'regional') why.push(access(x.id) === 'no' ? 'not offered in ' + flags(userRegion.codes, 3, true) : 'region-limited');
    if (x.types.length && x.types.every(function (t) { return DESKTOP_ONLY.indexOf(t) >= 0; })) why.push('needs desktop/console');
    return why.length ? 'likely ' + why.join(' + ') : 'reason unknown';
  }

  // How many of these quests each country unlocks, from the region list (quests limited by an
  // exclude list only are open to most countries, so they are counted separately).
  function countryCounts(list) {
    var counts = Object.create(null), globalN = 0, open = 0, unknown = 0;
    list.forEach(function (x) {
      var r = regionFor(x.id);
      if (!r) {
        var L = own(learnedMap, x.id);
        if (L && L.y.length) L.y.forEach(function (c) { if (userRegion.codes.indexOf(c) < 0) counts[c] = (counts[c] || 0) + 1; });
        else unknown++;
        return;
      }
      if (r.g) { globalN++; return; }
      if (r.i.length) r.i.forEach(function (c) { if (userRegion.codes.indexOf(c) < 0) counts[c] = (counts[c] || 0) + 1; });
      else open++;
    });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
    return { counts: counts, top: top, globalN: globalN, open: open, unknown: unknown };
  }

