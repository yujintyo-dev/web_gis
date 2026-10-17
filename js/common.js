/* 地図画面と管理画面で共通に使う部品 */
(function (root) {
  'use strict';
  var GIS = {};

  GIS.esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var esc = GIS.esc;
  var isEmpty = GIS.isEmpty = function (v) { return v === null || v === undefined || v === ''; };

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  // 設定の統合: オブジェクトは中身を再帰的に上書き、配列・文字・数値は丸ごと置き換え
  GIS.deepMerge = function deepMerge(a, b) {
    var out = {}, k;
    for (k in a) out[k] = a[k];
    for (k in b) {
      if (b[k] === undefined) continue;
      out[k] = (isObj(out[k]) && isObj(b[k])) ? deepMerge(out[k], b[k]) : b[k];
    }
    return out;
  };

  // ---------- 入力値の安全化(設定ファイル・データに悪意ある値が入っていても動かないように) ----------
  // 色: #rgb/#rrggbb、色名、rgb()/hsl() だけを許可
  GIS.safeColor = function (c) {
    c = String(c == null ? '' : c).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]{3,20}$/i.test(c) || /^(rgb|hsl)a?\([0-9.,%\s\/deg]+\)$/i.test(c)) return c;
    return '';
  };
  // URL: http/https または相対パスのみ(javascript: などは不可)
  GIS.safeUrl = function (u) {
    u = String(u == null ? '' : u).trim();
    if (!u || /[\u0000-\u001f\u007f\s]/.test(u.replace(/\{[a-z]\}/g, ''))) return '';
    var m = u.match(/^([a-z][a-z0-9+.-]*):/i);
    if (m) return /^https?$/i.test(m[1]) ? u : '';
    if (/^\/\//.test(u) || /\\/.test(u)) return '';
    return u;
  };
  // サイト内の相対パス(外部サーバーや .. を含むものは不可)
  GIS.safeRelPath = function (p) {
    p = String(p == null ? '' : p);
    if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || /^[\/\\]/.test(p) || /\\/.test(p) || /(^|\/)\.\.(\/|$)/.test(p) || /[\u0000-\u001f]/.test(p)) return '';
    return p;
  };
  GIS.safeName = function (n) {
    return String(n == null ? '' : n).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80);
  };

  // HTMLの無害化: 許可したタグ・属性だけを組み立て直す(それ以外は文字として表示)
  var VOID = { br: 1, hr: 1 };
  var ALLOWED = { b: 1, strong: 1, i: 1, em: 1, u: 1, br: 1, hr: 1, p: 1, div: 1, span: 1, small: 1, sub: 1, sup: 1, h3: 1, h4: 1, h5: 1, ul: 1, ol: 1, li: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1, a: 1 };
  function attrVal(attrs, name) {
    var m = new RegExp('(?:^|[\\s"\'/])' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(attrs);
    return m ? (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : null;
  }
  function textSafe(t) { return t.replace(/&(?!#?[a-zA-Z0-9]{1,10};)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  GIS.sanitizeHtml = function (html) {
    var re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--[\s\S]*?-->|[^<]+|</g;
    var out = '', stack = [], m;
    html = String(html == null ? '' : html);
    while ((m = re.exec(html)) !== null) {
      if (m[2] === undefined) {                       // 文字・コメント・単独の <
        if (m[0].slice(0, 4) === '<!--') continue;
        out += textSafe(m[0]);
        continue;
      }
      var tag = m[2].toLowerCase();
      if (!ALLOWED[tag]) continue;                    // 許可外のタグは捨てる(中の文字は残る)
      if (m[1]) {                                     // 閉じタグ
        var k = stack.lastIndexOf(tag);
        if (k < 0) continue;
        while (stack.length > k) out += '</' + stack.pop() + '>';
        continue;
      }
      var o = '<' + tag;
      var cls = attrVal(m[3], 'class');
      if (cls != null && /^[\w\- ]{1,60}$/.test(cls)) o += ' class="' + cls + '"';
      if (tag === 'a') {
        var href = attrVal(m[3], 'href');
        if (href != null && /^https?:\/\/[^\s"'<>`\\]+$/i.test(href)) o += ' href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"';
      }
      out += o + '>';
      if (!VOID[tag]) stack.push(tag);
    }
    while (stack.length) out += '</' + stack.pop() + '>';
    return out;
  };

  // ---------- ポップアップ ----------
  function valueMapOf(m, valueMaps) { return typeof m === 'string' ? (valueMaps || {})[m] : m; }
  GIS.mapValue = function (v, m, valueMaps) {
    var tbl = valueMapOf(m, valueMaps);
    if (tbl && tbl[String(v)] != null && tbl[String(v)] !== '') return tbl[String(v)];
    return v;
  };
  // {キー} または {キー:対応表名} を属性値に置き換える
  GIS.fillTemplate = function (tpl, props, escapeValues, valueMaps) {
    return String(tpl).replace(/\{([^}:]+)(?::([^}]+))?\}/g, function (m, k, mp) {
      var v = props ? props[k] : null;
      if (isEmpty(v)) return '';
      if (mp) v = GIS.mapValue(v, mp, valueMaps);
      return escapeValues ? esc(v) : String(v);
    });
  };
  function fieldHtml(fc, props, hideEmptyDefault, valueMaps) {
    if (typeof fc === 'string') fc = { key: fc };
    var raw = props ? props[fc.key] : null;
    var hide = fc.hideEmpty != null ? fc.hideEmpty : hideEmptyDefault;
    if (isEmpty(raw)) { if (hide) return ''; raw = ''; }
    var v = fc.map ? GIS.mapValue(raw, fc.map, valueMaps) : raw;
    var out;
    if (fc.format === 'number' && !isNaN(Number(v)) && v !== '') out = esc(Number(v).toLocaleString('ja-JP'));
    else if (fc.format === 'link' && /^https?:\/\//.test(String(v))) out = '<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(fc.linkText || v) + '</a>';
    else out = esc(v);
    if (v !== '') out = esc(fc.prefix || '') + out + esc(fc.suffix || '');
    return '<tr><th>' + esc(fc.label != null && fc.label !== '' ? fc.label : fc.key) + '</th><td>' + out + '</td></tr>';
  }
  GIS.popupSectionHtml = function (cfg, props, valueMaps) {
    var pc = cfg.popup || {};
    props = props || {};
    var title = !isEmpty(pc.title) ? GIS.fillTemplate(pc.title, props, false, valueMaps) : cfg.name;
    var body;
    if (pc.template) body = '<div class="pu-body">' + GIS.sanitizeHtml(GIS.fillTemplate(pc.template, props, true, valueMaps)) + '</div>';
    else {
      var hideEmpty = pc.hideEmpty !== false;
      var fields = pc.fields && pc.fields.length ? pc.fields : Object.keys(props);
      var rows = fields.map(function (fc) { return fieldHtml(fc, props, hideEmpty, valueMaps); }).join('');
      body = rows ? '<table class="popup-table">' + rows + '</table>' : '';
    }
    var layerName = !isEmpty(pc.title) ? '<div class="pu-layer">' + esc(cfg.name) + '</div>' : '';
    return '<div class="pu-sec">' + layerName + '<div class="pu-title">' + esc(title) + '</div>' + body + '</div>';
  };

  // ---------- レイヤー設定の組み立て ----------
  GIS.defaultStyle = function (geometry, color) {
    var c = color || '#3388ff';
    if (geometry === 'line') return { color: c, weight: 2 };
    if (geometry === 'point') return { color: c, fillColor: c, radius: 6 };
    return { color: c, weight: 1, fillColor: c, fillOpacity: 0.3 };
  };
  // m: 自動生成された情報(manifest.json)、c: 管理画面で編集した設定(config.json)
  GIS.mergeLayer = function (id, m, c) {
    c = c || {};
    var base;
    var i = id.lastIndexOf('/');
    if (m) {
      base = {
        id: id, name: m.name, category: m.category || '',
        type: m.kind === 'tiles' ? 'tiles' : 'geojson', visible: false,
        minZoom: (m.suggest && m.suggest.minZoom) || 0,
        style: GIS.defaultStyle(m.geometry, m.autoColor),
        popup: {}, download: { enabled: false },
        updated: m.updated, fields: m.fields || [], geometry: m.geometry, count: m.count
      };
      if (m.kind === 'tiles') base.index = m.index; else base.file = m.file;
      if (m.search) base.search = { index: m.search.index };
    } else {
      base = { id: id, name: id.slice(i + 1), category: i < 0 ? '' : id.slice(0, i), type: 'geojson', visible: false, style: {}, popup: {}, download: { enabled: false } };
    }
    var clean = {};
    for (var k in c) if (k !== 'build') clean[k] = JSON.parse(JSON.stringify(c[k]));   // 元の設定を壊さないよう複製
    var cfg = GIS.deepMerge(base, clean);
    cfg.id = id;
    if (cfg.search && cfg.search.enabled === false) delete cfg.search;
    return sanitizeCfg(cfg);
  };

  // 設定ファイルの値を検証する(不正な値は取り除く。使えないレイヤーは broken にする)
  function fixColor(o, k) {
    if (!o || o[k] == null) return;
    var c = GIS.safeColor(o[k]);
    if (c) o[k] = c; else delete o[k];
  }
  function sanitizeCfg(cfg) {
    if (cfg.style) { fixColor(cfg.style, 'color'); fixColor(cfg.style, 'fillColor'); }
    var sb = cfg.styleBy;
    if (sb) {
      if (sb.colors && typeof sb.colors === 'object') Object.keys(sb.colors).forEach(function (k) { fixColor(sb.colors, k); });
      fixColor(sb, 'default');
    }
    if (Array.isArray(cfg.legend)) {
      cfg.legend = cfg.legend.filter(function (l) { return l && typeof l === 'object'; })
        .map(function (l) { return { label: String(l.label == null ? '' : l.label), color: GIS.safeColor(l.color) || '#999999' }; });
    } else delete cfg.legend;
    var d = cfg.download;
    if (d && typeof d === 'object') {
      if (d.fullUrl) { var u = GIS.safeUrl(d.fullUrl); if (u) d.fullUrl = u; else delete d.fullUrl; }
      if (d.filename != null) d.filename = GIS.safeName(d.filename);
    }
    ['file', 'index'].forEach(function (k) {
      if (cfg[k] != null && !GIS.safeRelPath(cfg[k])) { delete cfg[k]; cfg.broken = true; }
    });
    if (cfg.search && cfg.search.index != null && !GIS.safeRelPath(cfg.search.index)) delete cfg.search;
    if (cfg.type === 'tile') { var tu = GIS.safeUrl(cfg.url); if (tu) cfg.url = tu; else cfg.broken = true; }
    else if (cfg.type === 'tiles' && !cfg.index) cfg.broken = true;
    else if (cfg.type !== 'tiles' && cfg.type !== 'tile' && !cfg.file) cfg.broken = true;
    return cfg;
  }

  // ---------- 点レイヤーの属性を取り込んだ面レイヤー: 点レイヤー側のポップアップ設定を引き継ぐ ----------
  // 例: 「地番」(点)で label の表示名を「地番」と設定 → 「筆界」(面)のポップアップでも、取り込んだ label が「地番」と表示される
  var INHERIT_KEYS = ['label', 'prefix', 'suffix', 'format', 'map', 'linkText', 'hideEmpty'];
  function normFields(arr) {
    return (arr || []).map(function (f) { return typeof f === 'string' ? { key: f } : JSON.parse(JSON.stringify(f)); })
      .filter(function (f) { return f && f.key != null; });
  }
  // cfg: 面レイヤーの設定 / src: 点レイヤーの設定 / joinFields: 取り込んだ属性名の一覧。cfg を書き換えて返す
  GIS.applyJoinInheritance = function (cfg, src, joinFields) {
    if (!cfg || !src || !joinFields || !joinFields.length) return cfg;
    if (cfg.popup && cfg.popup.inheritJoined === false) return cfg;      // 引き継がない設定
    var sf = src.popup && src.popup.fields && src.popup.fields.length ? normFields(src.popup.fields) : null;
    if (!sf) return cfg;                                                  // 点レイヤー側で項目を設定していなければ、そのまま
    var sMap = {};
    sf.forEach(function (f) { sMap[f.key] = f; });
    var own = cfg.popup && cfg.popup.fields && cfg.popup.fields.length
      ? normFields(cfg.popup.fields)
      : (cfg.fields || []).map(function (f) { return { key: f.name }; });  // 未設定のときは、全項目(取り込んだ属性を含む)
    var out = [];
    own.forEach(function (f) {
      if (joinFields.indexOf(f.key) < 0) { out.push(f); return; }         // 面レイヤー自身の属性は、そのまま
      var s = sMap[f.key];
      if (!s) return;                                                     // 点レイヤーで表示にしていない項目は、出さない
      INHERIT_KEYS.forEach(function (k) { if (s[k] !== undefined) f[k] = s[k]; });   // 表示名・単位・対応表などは点レイヤーの設定を使う
      out.push(f);
    });
    sf.forEach(function (s) {                                             // 点レイヤーで表示にした項目のうち、まだ無いものを追加
      if (joinFields.indexOf(s.key) >= 0 && !out.some(function (x) { return x.key === s.key; })) out.push(s);
    });
    cfg.popup = cfg.popup || {};
    cfg.popup.fields = out;
    return cfg;
  };

  // ---------- カテゴリ(階層)----------
  // cfgs: 統合済みレイヤー設定の配列、cats: config.categories
  GIS.buildTree = function (cfgs, cats) {
    cats = cats || {};
    var rootNode = { path: '', title: '', items: [], open: true };
    var nodes = { '': rootNode };
    function ensure(path) {
      if (nodes[path]) return nodes[path];
      var i = path.lastIndexOf('/');
      var parent = ensure(i < 0 ? '' : path.slice(0, i));
      var cc = cats[path] || {};
      var n = { path: path, title: cc.title || path.slice(i + 1), items: [], open: cc.open !== false };
      nodes[path] = n;
      parent.items.push({ kind: 'cat', node: n, order: cc.order, name: n.title });
      return n;
    }
    Object.keys(cats).forEach(ensure);
    cfgs.forEach(function (c) {
      ensure(c.category || '').items.push({ kind: 'layer', cfg: c, order: c.order, name: c.name });
    });
    function sortNode(n) {
      n.items.sort(function (a, b) {
        var ao = a.order == null ? (a.kind === 'cat' ? 100000 : 200000) : a.order;
        var bo = b.order == null ? (b.kind === 'cat' ? 100000 : 200000) : b.order;
        if (ao !== bo) return ao - bo;
        return String(a.name).localeCompare(String(b.name), 'ja');
      });
      n.items.forEach(function (it) { if (it.kind === 'cat') sortNode(it.node); });
    }
    sortNode(rootNode);
    return rootNode;
  };
  // 画面の表示順(上から下)に並べたレイヤー設定の一覧
  GIS.flatten = function (node) {
    var out = [];
    node.items.forEach(function (it) {
      if (it.kind === 'layer') out.push(it.cfg); else out = out.concat(GIS.flatten(it.node));
    });
    return out;
  };

  root.GIS = GIS;
})(window);
