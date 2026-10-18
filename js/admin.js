/* 管理画面: config.json をフォームで編集し、ダウンロード/GitHub保存する */
(function () {
  'use strict';

  var manifest = { layers: [] };
  var config = {};
  var mById = {};
  var sel = { t: 'global' };      // 選択中: global / maps / cat / layer
  var tab = 'basic';
  var dirty = false;
  var lastInput = null;           // ポップアップの {項目} 挿入先
  var previewFn = null;
  var DEFAULT_NOTICE = 'この地図情報は、あくまでも参考図であり、全ての内容を表示しているものではありません。法的な図面や詳細図面等の閲覧、正確な情報につきましては、担当課にてご確認ください。';
  var PAL = ['#e8590c', '#1971c2', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#f08c00', '#5c940d', '#6741d9', '#e03131', '#868e96', '#12b886'];

  function $(id) { return document.getElementById(id); }
  var ed = $('editor');

  // ---------------- 小物 ----------------
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  function row(label, input, help) {
    return h('label', { 'class': 'row' }, [h('span', { 'class': 'lb', text: label }), input, help ? h('small', { text: help }) : null]);
  }
  function tIn(val, fn, o) {
    o = o || {};
    var i = h('input', { type: o.type || 'text', value: val == null ? '' : val, placeholder: o.ph || '', step: o.step, min: o.min, max: o.max, list: o.list });
    i.addEventListener('change', function () {
      if (o.type === 'number') fn(i.value === '' ? undefined : Number(i.value)); else fn(i.value);
    });
    return i;
  }
  function chk(val, fn) {
    var i = h('input', { type: 'checkbox', checked: val });
    i.addEventListener('change', function () { fn(i.checked); });
    return i;
  }
  function sel_(val, opts, fn) {
    var s = h('select');
    opts.forEach(function (o) { s.appendChild(h('option', { value: o.v, text: o.t })); });
    s.value = val == null ? '' : val;
    s.addEventListener('change', function () { fn(s.value); });
    return s;
  }
  function colorIn(val, fn) {
    var ok = /^#[0-9a-f]{6}$/i.test(val || '');
    var i = h('input', { type: 'color', value: ok ? val : '#888888' });
    i.addEventListener('input', function () { fn(i.value); });
    return i;
  }
  function rangeIn(val, fn) {
    var i = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: val == null ? 0.3 : val });
    i.addEventListener('input', function () { fn(Number(i.value)); });
    return i;
  }

  // ---------------- 設定の読み書き ----------------
  function setPath(obj, keys, val, keepEmpty) {
    var stack = [obj];
    for (var i = 0; i < keys.length - 1; i++) {
      var cur = stack[stack.length - 1];
      if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') {
        if (val === undefined) return;
        cur[keys[i]] = {};
      }
      stack.push(cur[keys[i]]);
    }
    var last = keys[keys.length - 1];
    var del = val === undefined || val === null || (val === '' && !keepEmpty) || (typeof val === 'number' && isNaN(val));
    if (del) delete stack[stack.length - 1][last]; else stack[stack.length - 1][last] = val;
  }
  function cl(id, create) {
    config.layers = config.layers || {};
    if (!config.layers[id] && create) config.layers[id] = {};
    return config.layers[id];
  }
  function setL(id, keys, val, keepEmpty) { setPath(cl(id, true), keys, val, keepEmpty); changed(); }
  function setC(keys, val, keepEmpty) { setPath(config, keys, val, keepEmpty); changed(); }
  function eff(id, depth) {
    var cfg = GIS.mergeLayer(id, mById[id] || null, cl(id));
    var m = mById[id];
    if (m && m.joinFrom && !depth && mById[m.joinFrom.points]) {   // 点レイヤーの属性を取り込んだ面レイヤー
      GIS.applyJoinInheritance(cfg, eff(m.joinFrom.points, 1), m.joinFrom.fields);
    }
    return cfg;
  }
  // 点レイヤーのポップアップ設定を引き継いでいる場合の情報(なければ null)
  function joinedInfo(id) {
    var m = mById[id];
    if (!m || !m.joinFrom || !mById[m.joinFrom.points]) return null;
    var pc = (cl(id) && cl(id).popup) || {};
    if (pc.inheritJoined === false) return null;
    var src = eff(m.joinFrom.points, 1);
    var sf = src.popup && src.popup.fields && src.popup.fields.length
      ? src.popup.fields.map(function (f) { return typeof f === 'string' ? { key: f } : f; }) : null;
    return { srcId: m.joinFrom.points, srcName: src.name, keys: m.joinFrom.fields, sf: sf };
  }
  function fieldsOf(id) { return (mById[id] && mById[id].fields) || []; }
  function changed() {
    dirty = true;
    var s = $('state'); s.textContent = '未保存の変更あり'; s.className = 'dirty';
    if (previewFn) previewFn();
  }
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  // 保存用: 空の項目を取り除く
  function prune(o, top) {
    if (Array.isArray(o)) return o;
    if (o && typeof o === 'object') {
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          prune(v);
          if (!Object.keys(v).length && !(top === 'valueMaps')) delete o[k];
        } else if (Array.isArray(v) && !v.length) delete o[k];
        else if (v === undefined || v === null || (v === '' && k !== 'category')) delete o[k];
      });
    }
    return o;
  }
  function cleanConfig() {
    var c = JSON.parse(JSON.stringify(config));
    ['map', 'categories', 'layers', 'notice', 'terms'].forEach(function (k) { if (c[k]) prune(c[k]); });
    if (c.layers) Object.keys(c.layers).forEach(function (id) { if (!Object.keys(c.layers[id]).length) delete c.layers[id]; });
    if (c.categories) Object.keys(c.categories).forEach(function (p) { if (!Object.keys(c.categories[p]).length) delete c.categories[p]; });
    ['categories', 'layers', 'notice', 'terms'].forEach(function (k) { if (c[k] && !Object.keys(c[k]).length) delete c[k]; });
    if (c.map && !Object.keys(c.map).length) delete c.map;
    return c;
  }
  function configText() { return JSON.stringify(cleanConfig(), null, 2) + '\n'; }

  // ---------------- 左のツリー ----------------
  function allCfgs() {
    var cfgs = [], seen = {};
    manifest.layers.forEach(function (m) {
      seen[m.id] = true;
      if (!m.error) cfgs.push(eff(m.id));
    });
    Object.keys(config.layers || {}).forEach(function (id) {
      if (!seen[id] && config.layers[id].type) cfgs.push(eff(id));
    });
    return cfgs;
  }
  function selClass(t, key) { return sel.t === t && (t === 'layer' ? sel.id === key : sel.path === key) ? ' sel' : ''; }

  function renderTree() {
    var nav = $('tree');
    nav.innerHTML = '';
    nav.appendChild(h('div', { 'class': 'tree-top' }, [
      h('button', { type: 'button', text: '⚙ 全体設定(名前・初期位置)', onclick: function () { select({ t: 'global' }); } }),
      h('button', { type: 'button', text: '🔤 対応表(コード→名称)', onclick: function () { select({ t: 'maps' }); } }),
      h('button', { type: 'button', text: '＋ カテゴリを追加', onclick: addCategory })
    ]));
    var root = GIS.buildTree(allCfgs(), config.categories);
    nav.appendChild(nodeList(root));
    var errs = manifest.layers.filter(function (m) { return m.error; });
    if (errs.length) {
      nav.appendChild(h('h3', { text: '変換エラー(公開されません)' }));
      errs.forEach(function (m) { nav.appendChild(h('div', { 'class': 'err', text: m.id + ': ' + m.error })); });
    }
  }
  function nodeList(node) {
    var ul = h('ul');
    node.items.forEach(function (it, i) {
      var li = h('li');
      var mv = [
        h('button', { type: 'button', 'class': 'mv', text: '▲', title: '上へ', onclick: function (e) { e.stopPropagation(); move(node, i, -1); } }),
        h('button', { type: 'button', 'class': 'mv', text: '▼', title: '下へ', onclick: function (e) { e.stopPropagation(); move(node, i, 1); } })
      ];
      if (it.kind === 'layer') {
        var c = it.cfg;
        var badges = [];
        if (c.hidden) badges.push(h('span', { 'class': 'badge', text: '非公開' }));
        else if (c.visible) badges.push(h('span', { 'class': 'badge', text: '初期表示' }));
        li.appendChild(h('div', { 'class': 'node' + selClass('layer', c.id), onclick: function () { select({ t: 'layer', id: c.id }); } },
          [h('span', { 'class': 'nm', text: '▭ ' + c.name })].concat(badges, mv)));
      } else {
        li.appendChild(h('div', { 'class': 'node' + selClass('cat', it.node.path), onclick: function () { select({ t: 'cat', path: it.node.path }); } },
          [h('span', { 'class': 'nm', text: '📁 ' + it.node.title })].concat(mv)));
        li.appendChild(nodeList(it.node));
      }
      ul.appendChild(li);
    });
    return ul;
  }
  function move(node, i, d) {
    var j = i + d;
    if (j < 0 || j >= node.items.length) return;
    var t = node.items[i]; node.items[i] = node.items[j]; node.items[j] = t;
    node.items.forEach(function (it, k) {
      if (it.kind === 'cat') setPath(config, ['categories', it.node.path, 'order'], (k + 1) * 10);
      else setPath(cl(it.cfg.id, true), ['order'], (k + 1) * 10);
    });
    changed();
    renderTree();
  }
  function addCategory() {
    var name = prompt('カテゴリ名を入力してください。\n階層にするときは「親/子」のように / で区切ります。(例: 都市計画/規制)');
    if (!name) return;
    name = name.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    config.categories = config.categories || {};
    if (!config.categories[name]) config.categories[name] = {};
    changed();
    renderTree();
    select({ t: 'cat', path: name });
  }
  function select(s) { sel = s; renderTree(); renderEditor(); window.scrollTo(0, 0); }

  // ---------------- 右の編集画面 ----------------
  function renderEditor() {
    ed.innerHTML = '';
    previewFn = null;
    lastInput = null;
    if (sel.t === 'global') editGlobal();
    else if (sel.t === 'maps') editMaps();
    else if (sel.t === 'cat') editCat(sel.path);
    else editLayer(sel.id);
  }

  // ---- 全体設定 ----
  function editGlobal() {
    var m = config.map || {};
    var c = m.center || [36, 138];
    ed.appendChild(h('h2', { text: '全体設定' }));
    ed.appendChild(row('サイトの名前', tIn(config.title || '', function (v) { setC(['title'], v); }), 'ブラウザのタブに表示されます'));
    ed.appendChild(row('データ更新日を表示', chk(config.showUpdated !== false, function (v) { setC(['showUpdated'], v); })));
    ed.appendChild(row('地図右下の出典表示', tIn([].concat(config.attribution || []).join(' / '), function (v) {
      setC(['attribution'], v.trim() ? v.split('/').map(function (x) { return x.trim(); }).filter(Boolean) : undefined);
    }, { ph: '例: 地番図: ○○市(令和8年) / 用途地域: △△県' }), '「 / 」で区切ると複数表示できます。データの提供元の表記ルールに従ってください'));
    ed.appendChild(h('h3', { text: '画面下の案内帯(クリックで利用規約へ)' }));
    var nc = config.notice || {};
    ed.appendChild(row('案内帯を表示', chk(nc.enabled !== false, function (v) { setC(['notice', 'enabled'], v ? undefined : false); }), '参考図であることの案内です。通常は表示したままにしてください'));
    var nta = h('textarea', { rows: 3, placeholder: DEFAULT_NOTICE });
    nta.value = nc.text || '';
    nta.addEventListener('change', function () { setC(['notice', 'text'], nta.value.trim()); });
    ed.appendChild(row('案内文', nta, '空欄なら、標準の文言(参考図であること・担当課での確認のお願い)になります'));
    ed.appendChild(h('h3', { text: '利用規約ページ(terms.html)に表示する情報' }));
    var tm = config.terms || {};
    ed.appendChild(row('運営者名', tIn(tm.org || '', function (v) { setC(['terms', 'org'], v); }, { ph: '例: ○○市' }), '空欄のときは「本サービスの運営者」と表示されます'));
    ed.appendChild(row('担当課', tIn(tm.dept || '', function (v) { setC(['terms', 'dept'], v); }, { ph: '例: ○○課' }), '「担当課にてご確認ください」の部分に使われます。空欄のときは「担当課」と表示されます'));
    ed.appendChild(row('連絡先', tIn(tm.contact || '', function (v) { setC(['terms', 'contact'], v); }, { ph: '例: 電話 000-000-0000 / メール xxx@example.jp' })));
    ed.appendChild(row('制定日・改定日', tIn(tm.date || '', function (v) { setC(['terms', 'date'], v); }, { ph: '例: 2026年10月17日' })));
    var eta = h('textarea', { rows: 4, placeholder: '1行が1つの段落になります' });
    eta.value = tm.extra || '';
    eta.addEventListener('change', function () { setC(['terms', 'extra'], eta.value.trim()); });
    ed.appendChild(row('追記事項', eta, '自治体・組織の定めなど、規約に付け足したい文章(任意)'));
    ed.appendChild(h('h3', { text: '最初に表示する場所' }));
    ed.appendChild(h('p', { 'class': 'help', text: '下の地図を動かして、最初に見せたい位置とズームに合わせてください。' }));
    var mapDiv = h('div', { 'class': 'map-pick' });
    var lat = tIn(c[0], function () { upd(true); }, { type: 'number', step: 'any' });
    var lng = tIn(c[1], function () { upd(true); }, { type: 'number', step: 'any' });
    var zm = tIn(m.zoom, function () { upd(true); }, { type: 'number', min: 1, max: 22 });
    ed.appendChild(row('緯度', lat));
    ed.appendChild(row('経度', lng));
    ed.appendChild(row('ズーム', zm, '数字が大きいほど拡大(17で街区、15で町全体くらい)'));
    ed.appendChild(row('最小ズーム', tIn(m.minZoom, function (v) { setC(['map', 'minZoom'], v); }, { type: 'number' }), '引きすぎを防ぎます'));
    ed.appendChild(row('最大ズーム', tIn(m.maxZoom, function (v) { setC(['map', 'maxZoom'], v); }, { type: 'number' })));
    ed.appendChild(mapDiv);
    var mm = L.map(mapDiv).setView(c, m.zoom || 15);
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { maxNativeZoom: 18, maxZoom: 20, attribution: '国土地理院' }).addTo(mm);
    function upd(fromInput) {
      if (fromInput) { mm.setView([Number(lat.value), Number(lng.value)], Number(zm.value) || 15); return; }
      var ce = mm.getCenter();
      lat.value = ce.lat.toFixed(6); lng.value = ce.lng.toFixed(6); zm.value = mm.getZoom();
      var nc = [Number(ce.lat.toFixed(6)), Number(ce.lng.toFixed(6))];
      var oc = (config.map && config.map.center) || [];
      if (oc[0] === nc[0] && oc[1] === nc[1] && (config.map || {}).zoom === mm.getZoom()) return; // 変化なし
      setC(['map', 'center'], nc);
      setC(['map', 'zoom'], mm.getZoom());
    }
    mm.on('moveend', function () { upd(false); });
    setTimeout(function () { mm.invalidateSize(); }, 50);
  }

  // ---- 対応表 ----
  function editMaps() {
    ed.appendChild(h('h2', { text: '対応表(コード → 名称)' }));
    ed.appendChild(h('p', { 'class': 'help', html: 'データに入っているコード(大字コードなど)を、わかりやすい名前に置き換える表です。<br>1行に1つ、<code>コード=名称</code> の形で書きます。ポップアップの「対応表」と、検索の「大字」選択で使われます。' }));
    config.valueMaps = config.valueMaps || {};
    Object.keys(config.valueMaps).forEach(function (name) {
      var tbl = config.valueMaps[name] || {};
      var ta = h('textarea', { rows: 10, placeholder: '1001=今市\n1002=瀬川' });
      ta.value = Object.keys(tbl).map(function (k) { return k + '=' + tbl[k]; }).join('\n');
      var stat = h('p', { 'class': 'help' });
      function parseMap(text) {   // 「コード=名称」のほか、タブ・カンマ・コロン・空白区切りも読み取る
        var o = {}, n = 0, bad = [];
        text.split(/\r?\n/).forEach(function (line) {
          if (!line.trim()) return;
          var mt = line.match(/^\s*([^\s=＝,，、:：]+)\s*(?:[=＝,，、:：]|\s)\s*(.*?)\s*$/);
          if (mt && mt[2]) { o[mt[1]] = mt[2]; n++; } else if (!mt || !/[=＝,，、:：]\s*$/.test(line)) bad.push(line.trim());
        });
        return { o: o, n: n, bad: bad };
      }
      function showStat(r) {
        stat.textContent = '名称を読み取れた行: ' + r.n + '件' + (r.bad.length ? ' / 読み取れない行: ' + r.bad.length + '件(例: ' + r.bad.slice(0, 2).join(' | ') + ')。「コード=名称」の形で書いてください' : '');
      }
      showStat(parseMap(ta.value));
      ta.addEventListener('change', function () {
        var r = parseMap(ta.value);
        showStat(r);
        setC(['valueMaps', name], r.o, true);
      });
      // コード一覧の取り込み
      var cand = [];
      manifest.layers.forEach(function (m) {
        (m.fields || []).forEach(function (f) { if (f.unique && f.unique.length > 1) cand.push({ v: m.id + '\n' + f.name, t: m.id + ' の ' + f.name + '(' + f.unique.length + '種類)' }); });
      });
      var pick = sel_('', [{ v: '', t: '(コード一覧を取り込む元を選ぶ)' }].concat(cand), function (v) {
        if (!v) return;
        var p = v.split('\n'), m = mById[p[0]];
        var f = m.fields.filter(function (x) { return x.name === p[1]; })[0];
        var have = {};
        ta.value.split(/\r?\n/).forEach(function (l) { var mt = l.match(/^\s*([^=＝,\t]+?)\s*[=＝,\t]/); if (mt) have[mt[1]] = true; });
        var add = f.unique.map(function (u) { return u[0]; }).sort().filter(function (k) { return !have[k]; });
        ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + add.map(function (k) { return k + '='; }).join('\n');
        pick.value = '';
      });
      ed.appendChild(h('h3', { text: '対応表: ' + name }));
      ed.appendChild(pick);
      ed.appendChild(ta);
      ed.appendChild(stat);
      ed.appendChild(h('p', { 'class': 'help', text: '名称を書かなかったコードは、「大字コード1001」のようにコードで表示されます。' }));
      ed.appendChild(h('button', { type: 'button', 'class': 'danger small', text: 'この対応表を削除', onclick: function () {
        if (!confirm('対応表「' + name + '」を削除しますか?')) return;
        delete config.valueMaps[name]; changed(); renderEditor();
      } }));
    });
    ed.appendChild(h('p'));
    ed.appendChild(h('button', { type: 'button', text: '＋ 対応表を追加', onclick: function () {
      var n = prompt('対応表の名前(半角英数。例: oaza)');
      if (!n) return;
      config.valueMaps[n.trim()] = config.valueMaps[n.trim()] || {};
      changed(); renderEditor();
    } }));
  }

  // ---- カテゴリ ----
  function editCat(path) {
    var cc = (config.categories || {})[path] || {};
    ed.appendChild(h('h2', { text: 'カテゴリ: ' + path }));
    ed.appendChild(row('表示名', tIn(cc.title || '', function (v) { setC(['categories', path, 'title'], v); renderTree(); }, { ph: path.split('/').pop() })));
    ed.appendChild(row('最初から開いておく', chk(cc.open !== false, function (v) { setC(['categories', path, 'open'], v); })));
    ed.appendChild(h('p', { 'class': 'help', html: 'レイヤーをこのカテゴリに入れるには、レイヤーの「カテゴリ」に <code>' + GIS.esc(path) + '</code> と入力します。<br>data フォルダ内のフォルダ名は、自動でカテゴリになります。' }));
    ed.appendChild(h('button', { type: 'button', 'class': 'danger small', text: 'カテゴリ設定を削除', onclick: function () {
      if (!confirm('このカテゴリの設定(表示名・順序)を削除しますか?\n※ レイヤー自体は消えません')) return;
      delete (config.categories || {})[path]; changed(); select({ t: 'global' });
    } }));
  }

  // ---- レイヤー ----
  function editLayer(id) {
    var m = mById[id];
    var e = eff(id);
    ed.appendChild(h('h2', { text: e.name }));
    if (m) {
      var kind = m.kind === 'tiles' ? '分割データ(表示範囲だけ読み込み)' : '1ファイル';
      var g = { polygon: '面', line: '線', point: '点', mixed: '混在' }[m.geometry] || m.geometry;
      ed.appendChild(h('div', { 'class': 'info', html: '図形: ' + g + ' / ' + (m.count || 0).toLocaleString() + ' 件 / ' + kind + '<br>データ更新: ' + GIS.esc(m.updated || '') +
        (m.joined != null ? '<br>地番の結び付け: ' + m.joined.toLocaleString() + ' 件' : '') }));
    }
    if (m && m.keepAll && (m.sourceFields || []).length) {
      ed.appendChild(h('div', { 'class': 'err', text: '⚠ このレイヤーは元データの全属性(' + m.sourceFields.length + '個)を公開しています。ポップアップに出していない属性も、データを直接取得すれば誰でも見られます。「データ変換」タブで公開する属性を絞り込めます。' }));
    }
    var tabs = [['basic', '基本'], ['style', '見た目'], ['popup', 'ポップアップ'], ['dl', 'ダウンロード・検索']];
    if (m) tabs.push(['build', 'データ変換']);
    ed.appendChild(h('div', { 'class': 'tabs' }, tabs.map(function (t) {
      return h('button', { type: 'button', 'class': tab === t[0] ? 'on' : '', text: t[1], onclick: function () { tab = t[0]; renderEditor(); } });
    })));
    var box = h('div');
    ed.appendChild(box);
    if (tab === 'basic') tabBasic(box, id, e, m);
    else if (tab === 'style') tabStyle(box, id, e, m);
    else if (tab === 'popup') tabPopup(box, id, e, m);
    else if (tab === 'dl') tabDl(box, id, e, m);
    else if (tab === 'build' && m) tabBuild(box, id, e, m);
    ed.appendChild(h('p'));
    ed.appendChild(h('button', { type: 'button', 'class': 'danger small', text: 'このレイヤーの設定を初期状態に戻す', onclick: function () {
      if (!confirm('「' + e.name + '」の表示設定をすべて初期状態に戻しますか?\n(データ自体は消えません)')) return;
      if (config.layers) delete config.layers[id];
      changed(); renderTree(); renderEditor();
    } }));
  }

  function tabBasic(box, id, e, m) {
    var cats = {};
    allCfgs().forEach(function (c) { if (c.category) cats[c.category] = true; });
    Object.keys(config.categories || {}).forEach(function (p) { cats[p] = true; });
    var dl = h('datalist', { id: 'cats' }, Object.keys(cats).sort().map(function (p) { return h('option', { value: p }); }));
    box.appendChild(dl);
    box.appendChild(row('表示名', tIn(e.name, function (v) { setL(id, ['name'], v); renderTree(); })));
    box.appendChild(row('カテゴリ', tIn(e.category || '', function (v) {
      setL(id, ['category'], v.trim().replace(/^\/+|\/+$/g, ''), true); renderTree();
    }, { list: 'cats', ph: '(なし=一番上の階層)' }), '「親/子」のように / で階層にできます'));
    box.appendChild(row('最初から表示する', chk(e.visible === true, function (v) { setL(id, ['visible'], v); renderTree(); })));
    box.appendChild(row('表示を始めるズーム', tIn(e.minZoom, function (v) { setL(id, ['minZoom'], v); }, { type: 'number', min: 0, max: 22 }),
      '大きいデータは、拡大したときだけ表示すると軽くなります'));
    if (e.type === 'tiles') box.appendChild(row('同時に読み込む区画の上限', tIn(e.maxTiles, function (v) { setL(id, ['maxTiles'], v); }, { type: 'number', ph: '80' }),
      '表示範囲が広いと上限を超え「拡大してください」と表示されます'));
    box.appendChild(row('出典(パネルに表示)', tIn(e.source || '', function (v) { setL(id, ['source'], v); }, { ph: '例: ○○市 地番図データ' }), 'レイヤー名の下に「出典: …」と表示されます'));
    box.appendChild(row('データ時点の表示', tIn(e.updatedLabel || '', function (v) { setL(id, ['updatedLabel'], v); }, { ph: e.updated || '例: 令和8年1月' }),
      '空欄なら、自動変換した日付を表示します'));
    box.appendChild(row('サイトに出さない(非公開)', chk(e.hidden === true, function (v) { setL(id, ['hidden'], v ? true : undefined); renderTree(); })));
  }

  function tabStyle(box, id, e, m) {
    var s = e.style || {};
    var g = m ? m.geometry : 'mixed';
    var polygon = g === 'polygon' || g === 'mixed', point = g === 'point' || g === 'mixed';
    box.appendChild(row('線の色', colorIn(s.color, function (v) { setL(id, ['style', 'color'], v); })));
    box.appendChild(row('線の太さ', tIn(s.weight, function (v) { setL(id, ['style', 'weight'], v); }, { type: 'number', step: 0.5, min: 0 })));
    if (polygon || point) box.appendChild(row('塗りの色', colorIn(s.fillColor, function (v) { setL(id, ['style', 'fillColor'], v); })));
    if (polygon) box.appendChild(row('塗りの濃さ', rangeIn(s.fillOpacity, function (v) { setL(id, ['style', 'fillOpacity'], v); }), '0=透明、1=不透明'));
    if (point) box.appendChild(row('点の大きさ', tIn(s.radius, function (v) { setL(id, ['style', 'radius'], v); }, { type: 'number', min: 1 })));
    box.appendChild(row('図形を描かない', chk(s.invisible === true, function (v) { setL(id, ['style', 'invisible'], v ? true : undefined); }), '文字(ラベル)だけを出したいレイヤー用'));

    box.appendChild(h('h3', { text: '属性による色分け' }));
    var cand = fieldsOf(id).filter(function (f) { return f.unique && f.unique.length <= 40; });
    var sb = e.styleBy || null;
    box.appendChild(row('色分けする属性', sel_(sb ? sb.field : '', [{ v: '', t: '(色分けしない)' }].concat(cand.map(function (f) { return { v: f.name, t: f.name + '(' + f.unique.length + '種類)' }; })), function (v) {
      if (!v) { setL(id, ['styleBy'], undefined); renderEditor(); return; }
      var f = cand.filter(function (x) { return x.name === v; })[0];
      var colors = {}, labels = {};
      var old = (sb && sb.field === v) ? sb : null;
      f.unique.forEach(function (u, i) {
        colors[u[0]] = old && old.colors && old.colors[u[0]] ? old.colors[u[0]] : PAL[i % PAL.length];
        if (old && old.labels && old.labels[u[0]]) labels[u[0]] = old.labels[u[0]];
      });
      setL(id, ['styleBy'], { field: v, colors: colors, labels: labels, 'default': '#cccccc' });
      renderEditor();
    })));
    if (sb && sb.colors) {
      var f = cand.filter(function (x) { return x.name === sb.field; })[0];
      var t = h('table', { 'class': 'grid' }, [h('tr', {}, [h('th', { text: '色' }), h('th', { text: '値' }), h('th', { text: '件数' }), h('th', { text: '凡例の表示名' })])]);
      (f ? f.unique : Object.keys(sb.colors).map(function (k) { return [k, '']; })).forEach(function (u) {
        var k = u[0];
        t.appendChild(h('tr', {}, [
          h('td', {}, [colorIn(sb.colors[k], function (v) { cl(id).styleBy.colors[k] = v; delete cl(id).legend; changed(); })]),
          h('td', { text: k }), h('td', { text: String(u[1]) }),
          h('td', {}, [tIn((sb.labels || {})[k] || '', function (v) {
            var c = cl(id).styleBy; c.labels = c.labels || {};
            if (v) c.labels[k] = v; else delete c.labels[k];
            delete cl(id).legend; changed();
          })])
        ]));
      });
      box.appendChild(t);
      box.appendChild(row('凡例を表示', chk(sb.legend !== false, function (v) { setL(id, ['styleBy', 'legend'], v ? undefined : false); })));
      if (e.legend && e.legend.length) box.appendChild(h('p', { 'class': 'help', text: '※ このレイヤーには手書きの凡例が設定されています。上の色や凡例名を編集すると、自動生成の凡例に切り替わります。' }));
    }

    box.appendChild(h('h3', { text: '地図上の文字(ラベル)' }));
    var all = fieldsOf(id);
    box.appendChild(row('文字に使う属性', sel_(e.labelField || '', [{ v: '', t: '(出さない)' }].concat(all.map(function (f) { return { v: f.name, t: f.name }; })), function (v) { setL(id, ['labelField'], v); })));
    box.appendChild(row('文字を出すズーム', tIn(e.labelMinZoom, function (v) { setL(id, ['labelMinZoom'], v); }, { type: 'number', ph: '18' }), '画面内で最大400件まで表示します'));
  }

  function popupRows(id, ji) {
    var fl = fieldsOf(id).map(function (f) { return f.name; });
    var pf = cl(id) && cl(id).popup && cl(id).popup.fields;
    var rows = [];
    function mk(on, fc) {
      if (typeof fc === 'string') fc = { key: fc };
      return { on: on, key: fc.key, label: fc.label || '', prefix: fc.prefix || '', suffix: fc.suffix || '', format: fc.format || '', map: typeof fc.map === 'string' ? fc.map : '' };
    }
    if (pf && pf.length) {
      pf.forEach(function (fc) { rows.push(mk(true, fc)); });
      fl.forEach(function (k) { if (!rows.some(function (r) { return r.key === k; })) rows.push(mk(false, { key: k })); });
    } else fl.forEach(function (k) { rows.push(mk(true, { key: k })); });
    if (ji && ji.sf) {   // 取り込んだ属性は、点レイヤーの設定(表示/非表示・表示名・単位・対応表)を使う
      var sMap = {};
      ji.sf.forEach(function (f) { sMap[f.key] = f; });
      rows.forEach(function (r) {
        if (ji.keys.indexOf(r.key) < 0) return;
        var sv = sMap[r.key];
        r.joined = true; r.on = !!sv;
        if (sv) { r.label = sv.label || ''; r.prefix = sv.prefix || ''; r.suffix = sv.suffix || ''; r.format = sv.format || ''; r.map = typeof sv.map === 'string' ? sv.map : ''; }
      });
      ji.sf.forEach(function (sv) {
        if (ji.keys.indexOf(sv.key) >= 0 && !rows.some(function (r) { return r.key === sv.key; })) { var r2 = mk(true, sv); r2.joined = true; rows.push(r2); }
      });
    }
    return rows;
  }
  function writeRows(id, rows) {
    var prev = {};   // 面レイヤー側に、すでに保存されている項目設定(引き継ぎをオフにしたときに使うため、取り込み属性でも消さない)
    (((cl(id) && cl(id).popup && cl(id).popup.fields) || [])).forEach(function (f) { if (typeof f === 'string') f = { key: f }; prev[f.key] = f; });
    var out = rows.filter(function (r) { return r.on; }).map(function (r) {
      if (r.joined) return prev[r.key] ? JSON.parse(JSON.stringify(prev[r.key])) : { key: r.key };   // 取り込んだ属性: 点レイヤーの設定が使われるため、ここでは並び順だけ変える
      var o = { key: r.key };
      ['label', 'prefix', 'suffix', 'format', 'map'].forEach(function (k) { if (r[k]) o[k] = r[k]; });
      return o;
    });
    setL(id, ['popup', 'fields'], out);
  }

  function tabPopup(box, id, e, m) {
    var pc = e.popup || {};
    var ji = joinedInfo(id);
    var rows = popupRows(id, ji);
    if (m && m.joinFrom && mById[m.joinFrom.points]) {
      var srcN = eff(m.joinFrom.points, 1).name;
      box.appendChild(row('点レイヤーのポップアップ設定を引き継ぐ', chk(pc.inheritJoined !== false, function (v) {
        setL(id, ['popup', 'inheritJoined'], v ? undefined : false); renderEditor();
      }), '点レイヤー「' + srcN + '」から取り込んだ属性(' + m.joinFrom.fields.join('、') + ')の、表示名・単位・対応表などを、点レイヤーの設定に合わせます'));
    }
    box.appendChild(row('ポップアップを表示', chk(pc.enabled !== false, function (v) { setL(id, ['popup', 'enabled'], v ? undefined : false); }), '地図をクリックしたときの表示です'));
    var title = tIn(pc.title || '', function (v) { setL(id, ['popup', 'title'], v); }, { ph: '(空欄ならレイヤー名)' });
    title.addEventListener('focus', function () { lastInput = title; });
    box.appendChild(row('見出し', title, '{属性名} で値を差し込めます 例: {YoutoName}'));
    var chips = h('div', { 'class': 'chips' }, fieldsOf(id).map(function (f) {
      return h('span', { 'class': 'chip', text: '{' + f.name + '}', onclick: function () {
        var t = lastInput || title; var tx = '{' + f.name + '}';
        var p = t.selectionStart == null ? t.value.length : t.selectionStart;
        t.value = t.value.slice(0, p) + tx + t.value.slice(t.selectionEnd == null ? p : t.selectionEnd);
        t.dispatchEvent(new Event('change')); t.focus();
      } });
    }));
    box.appendChild(row('項目を差し込む', chips, '見出しや自由HTMLの入力欄を選んでから、項目名をクリック'));
    box.appendChild(row('空の項目を隠す', chk(pc.hideEmpty !== false, function (v) { setL(id, ['popup', 'hideEmpty'], v ? undefined : false); })));
    box.appendChild(row('重なった図形の表示数', tIn(pc.maxFeatures, function (v) { setL(id, ['popup', 'maxFeatures'], v); }, { type: 'number', min: 1, ph: '1' })));
    box.appendChild(row('クリックした図形を強調', chk(pc.highlight !== false, function (v) { setL(id, ['popup', 'highlight'], v ? undefined : false); })));

    var useTpl = !!pc.template;
    var mode = h('div', { 'class': 'checks' }, [
      h('label', {}, [h('input', { type: 'radio', name: 'pmode', checked: !useTpl, onchange: function () { setL(id, ['popup', 'template'], undefined); renderEditor(); } }), '項目リストで作る']),
      h('label', {}, [h('input', { type: 'radio', name: 'pmode', checked: useTpl, onchange: function () { setL(id, ['popup', 'template'], pc.template || '<b>{' + (rows[0] ? rows[0].key : 'name') + '}</b>'); renderEditor(); } }), '自由なHTMLで作る'])
    ]);
    box.appendChild(row('作り方', mode));

    if (useTpl) {
      var ta = h('textarea', { rows: 6 });
      ta.value = pc.template;
      ta.addEventListener('focus', function () { lastInput = ta; });
      ta.addEventListener('change', function () { setL(id, ['popup', 'template'], ta.value); });
      box.appendChild(ta);
      box.appendChild(h('p', { 'class': 'help', html: '<code>{属性名}</code> または <code>{属性名:対応表名}</code> が値に置き換わります。値は自動で安全な文字に変換されます。' }));
    } else {
      var maps = Object.keys(config.valueMaps || {});
      var table = h('table', { 'class': 'grid' });
      box.appendChild(h('p', { 'class': 'help', text: '表示する属性にチェックを入れ、表示名・単位などを設定します。▲▼で順番を変えられます。(1つも選ばないと全項目が表示されます)' }));
      if (ji) {
        var openSrc = h('button', { type: 'button', 'class': 'small', text: '点レイヤー「' + ji.srcName + '」のポップアップ設定を開く', onclick: function () { tab = 'popup'; select({ t: 'layer', id: ji.srcId }); } });
        box.appendChild(h('div', { 'class': 'info' }, [
          ji.sf ? '◆ の項目は、点レイヤー「' + ji.srcName + '」から取り込んだ属性です。表示するか・表示名・単位・形式・対応表は、点レイヤー側のポップアップ設定が使われます(ここで変更できるのは、並び順だけです)。'
                : '点レイヤー「' + ji.srcName + '」でポップアップの項目を設定すると、取り込んだ属性(' + ji.keys.join('、') + ')の表示名・単位・対応表が、ここにも反映されます。',
          h('br'), openSrc
        ]));
      }
      box.appendChild(table);
      var sample = {};
      fieldsOf(id).forEach(function (f) { sample[f.name] = f.samples && f.samples[0] != null ? f.samples[0] : ''; });
      var draw = function () {
        table.innerHTML = '';
        table.appendChild(h('tr', {}, ['表示', '属性', '表示名', '前', '後(単位)', '形式', '対応表', ''].map(function (t) { return h('th', { text: t }); })));
        rows.forEach(function (r, i) {
          var sv = sample[r.key];
          var lock = function (el) { if (r.joined) el.disabled = true; return el; };   // 点レイヤーから取り込んだ属性は、ここでは編集しない
          var tr = h('tr', { 'class': r.on ? '' : 'off' }, [
            h('td', {}, [lock(chk(r.on, function (v) { r.on = v; writeRows(id, rows); draw(); }))]),
            h('td', { 'class': 'k' }, [h('span', { text: (r.joined ? '◆ ' : '') + r.key }), h('small', { text: sv !== '' ? String(sv) : '' })]),
            h('td', {}, [lock(tIn(r.label, function (v) { r.label = v; writeRows(id, rows); }, { ph: r.key }))]),
            h('td', {}, [lock(tIn(r.prefix, function (v) { r.prefix = v; writeRows(id, rows); }))]),
            h('td', {}, [lock(tIn(r.suffix, function (v) { r.suffix = v; writeRows(id, rows); }))]),
            h('td', {}, [lock(sel_(r.format, [{ v: '', t: '標準' }, { v: 'number', t: '数値(桁区切り)' }, { v: 'link', t: 'リンク' }], function (v) { r.format = v; writeRows(id, rows); }))]),
            h('td', {}, [lock(sel_(r.map, [{ v: '', t: 'なし' }].concat(maps.map(function (n) { return { v: n, t: n }; })), function (v) { r.map = v; writeRows(id, rows); }))]),
            h('td', {}, [
              h('button', { type: 'button', 'class': 'small', text: '▲', onclick: function () { if (i > 0) { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); writeRows(id, rows); draw(); } } }),
              h('button', { type: 'button', 'class': 'small', text: '▼', onclick: function () { if (i < rows.length - 1) { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); writeRows(id, rows); draw(); } } })
            ])
          ]);
          table.appendChild(tr);
        });
      };
      draw();
    }

    // プレビュー
    var samples = (m && m.sampleRows) || [];
    var pv = h('div', { 'class': 'preview' });
    var si = 0;
    var pick = sel_('0', samples.map(function (_, i) { return { v: String(i), t: 'サンプル' + (i + 1) }; }), function (v) { si = Number(v); show(); });
    function show() {
      var cfg = eff(id);
      pv.innerHTML = samples.length ? GIS.popupSectionHtml(cfg, samples[si], config.valueMaps) : '<span class="help">サンプルデータがありません</span>';
    }
    previewFn = show;
    box.appendChild(h('h3', { text: 'プレビュー' }));
    if (samples.length) box.appendChild(pick);
    box.appendChild(pv);
    show();
  }

  function tabDl(box, id, e, m) {
    var d = e.download || {};
    box.appendChild(h('h3', { text: 'GeoJSONダウンロード' }));
    box.appendChild(row('ダウンロードを許可', chk(d.enabled === true, function (v) { setL(id, ['download', 'enabled'], v); })));
    box.appendChild(h('p', { 'class': 'help', html: e.type === 'tiles' ? '許可すると、公開サイトで「いま見えている範囲」をGeoJSONで保存できます。' : '許可すると、公開サイトでレイヤー全体をGeoJSONで保存できます。<br>※ 許可すると誰でもデータを入手できます。公開してよいデータか確認してください。' }));
    box.appendChild(row('ファイル名', tIn(d.filename || '', function (v) { setL(id, ['download', 'filename'], v); }, { ph: id.split('/').pop() }), '拡張子(.geojson)は自動で付きます'));
    box.appendChild(row('全体ファイルのURL', tIn(d.fullUrl || '', function (v) { setL(id, ['download', 'fullUrl'], v); }, { ph: 'https://github.com/…/releases/download/…' }),
      '任意。大きなデータの全体を配るときは、GitHubのReleasesに置いたURLを入れます'));

    box.appendChild(h('h3', { text: '検索' }));
    var s = e.search;
    if (m && m.search) {
      box.appendChild(row('このレイヤーを検索対象にする', chk(!(s && s.enabled === false), function (v) { setL(id, ['search', 'enabled'], v ? undefined : false); })));
      box.appendChild(row('大字名の対応表', sel_(s && s.groupMap || '', [{ v: '', t: '(なし)' }].concat(Object.keys(config.valueMaps || {}).map(function (n) { return { v: n, t: n }; })), function (v) { setL(id, ['search', 'groupMap'], v); }), '検索結果に出す大字名と、「大字名 地番」での絞り込みに使います。「対応表」画面で、コード→名称を登録してください'));
      box.appendChild(row('ジャンプ先のズーム', tIn(s && s.zoom, function (v) { setL(id, ['search', 'zoom'], v); }, { type: 'number', ph: '19' })));
      var ids = allCfgs().filter(function (c) { return c.id !== id; });
      var cur = (s && s.showLayers) || [];
      var cb = h('div', { 'class': 'checks' }, ids.map(function (c) {
        return h('label', {}, [chk(cur.indexOf(c.id) >= 0, function (v) {
          var arr = ((cl(id).search || {}).showLayers || []).slice();
          var k = arr.indexOf(c.id);
          if (v && k < 0) arr.push(c.id); if (!v && k >= 0) arr.splice(k, 1);
          setL(id, ['search', 'showLayers'], arr);
        }), c.name]);
      }));
      box.appendChild(row('検索結果を選んだとき一緒に表示するレイヤー', cb));
    } else if (m && m.kind === 'geojson') {
      var fl = fieldsOf(id);
      var curF = (s && s.fields) || [];
      box.appendChild(h('p', { 'class': 'help', text: '検索に使う属性を選びます。選ばなければ検索対象になりません。' }));
      box.appendChild(h('div', { 'class': 'checks' }, fl.map(function (f) {
        return h('label', {}, [chk(curF.indexOf(f.name) >= 0, function (v) {
          var arr = (((cl(id) || {}).search || {}).fields || []).slice();
          var k = arr.indexOf(f.name);
          if (v && k < 0) arr.push(f.name); if (!v && k >= 0) arr.splice(k, 1);
          setL(id, ['search', 'fields'], arr);
        }), f.name]);
      })));
      box.appendChild(row('結果の表示形式', tIn(s && s.display || '', function (v) { setL(id, ['search', 'display'], v); }, { ph: '{名称}' })));
    } else {
      box.appendChild(h('p', { 'class': 'help', text: '大きなデータを検索するには、「データ変換」タブで検索用データの作成を設定してください。' }));
    }
  }

  function tabBuild(box, id, e, m) {
    var b = (cl(id) && cl(id).build) || {};
    box.appendChild(h('p', { 'class': 'help', html: '<b>データの変換方法</b>の設定です。変更して保存すると、公開時にこのレイヤーが<b>再変換</b>されます(数分かかります)。<br>地図の見た目やポップアップだけの変更では再変換されません。' }));
    var sf = m.sourceFields || [];

    box.appendChild(h('h3', { text: '残す属性(公開する属性)' }));
    box.appendChild(h('p', { 'class': 'help', text: '外した属性は公開データに含まれません(軽くなり、個人情報などの流出も防げます)。チェックの付いた属性は、ポップアップに出さなくても誰でも取得できます。' }));
    if (!b.keep) {
      var used = {};
      var ef = e.popup || {};
      (ef.fields || []).forEach(function (f) { used[typeof f === 'string' ? f : f.key] = true; });
      if (e.labelField) used[e.labelField] = true;
      if (e.styleBy && e.styleBy.field) used[e.styleBy.field] = true;
      if (b.search) { if (b.search.label) used[b.search.label] = true; if (b.search.group) used[b.search.group] = true; }
      var need = sf.filter(function (n) { return used[n]; });
      var wrap = h('div', { 'class': 'err' }, [h('div', { text: '⚠ 現在は元データの全属性(' + sf.length + '個)を公開しています。' })]);
      if (need.length && need.length < sf.length) {
        wrap.appendChild(h('button', { type: 'button', 'class': 'small', text: '使っている属性だけを残す(' + need.length + '個: ' + need.join('、') + ')', onclick: function () {
          setL(id, ['build', 'keep'], need); renderEditor();
        } }));
      } else if (!need.length) {
        wrap.appendChild(h('div', { 'class': 'help', text: 'ポップアップの項目を選んでから、ここで絞り込むと便利です。' }));
      }
      box.appendChild(wrap);
    }
    var keep = b.keep ? b.keep.slice() : sf.slice();
    box.appendChild(h('div', { 'class': 'checks' }, sf.map(function (n) {
      return h('label', {}, [chk(keep.indexOf(n) >= 0, function (v) {
        var k = keep.indexOf(n);
        if (v && k < 0) keep.push(n); if (!v && k >= 0) keep.splice(k, 1);
        var all = sf.every(function (x) { return keep.indexOf(x) >= 0; });
        setL(id, ['build', 'keep'], all ? undefined : sf.filter(function (x) { return keep.indexOf(x) >= 0; }));
      }), n]);
    })));

    if (m.geometry === 'polygon') {
      box.appendChild(h('h3', { text: '点データの属性を取り込む(地番など)' }));
      box.appendChild(h('p', { 'class': 'help', text: '面データに属性が少ないとき、中にある点データの属性(地番など)を位置で結び付けて追加します。' }));
      var pts = manifest.layers.filter(function (x) { return x.geometry === 'point' && x.id !== id && !x.error; });
      var j = b.join || {};
      box.appendChild(row('点レイヤー', sel_(j.points || '', [{ v: '', t: '(使わない)' }].concat(pts.map(function (x) { return { v: x.id, t: x.id }; })), function (v) {
        if (!v) setL(id, ['build', 'join'], undefined); else setL(id, ['build', 'join'], { points: v, fields: [] });
        renderEditor();
      })));
      if (j.points && mById[j.points]) {
        var jf = (j.fields || []).slice();
        box.appendChild(row('取り込む属性', h('div', { 'class': 'checks' }, (mById[j.points].sourceFields || []).map(function (n) {
          return h('label', {}, [chk(jf.indexOf(n) >= 0, function (v) {
            var k = jf.indexOf(n);
            if (v && k < 0) jf.push(n); if (!v && k >= 0) jf.splice(k, 1);
            setL(id, ['build', 'join'], { points: j.points, fields: jf.slice() });
          }), n]);
        })), '最初に選んだ属性が空の筆は「結び付かなかった」扱いになります'));
      }
    }

    box.appendChild(h('h3', { text: '検索用データの作成' }));
    box.appendChild(h('p', { 'class': 'help', text: '地番などの文字検索に使うデータを作ります。' }));
    var bs = b.search || {};
    var opt = function (none) { return [{ v: '', t: none }].concat(sf.map(function (n) { return { v: n, t: n }; })); };
    box.appendChild(row('検索する文字の属性', sel_(bs.label || '', opt('(検索データを作らない)'), function (v) {
      if (!v) setL(id, ['build', 'search'], undefined); else setL(id, ['build', 'search'], { label: v, group: bs.group || '' });
    })));
    box.appendChild(row('グループ分けの属性', sel_(bs.group || '', opt('(グループなし)'), function (v) {
      if (bs.label) setL(id, ['build', 'search', 'group'], v);
    }), '例: 大字コード。検索画面で絞り込みに使います'));

    box.appendChild(h('h3', { text: '詳細設定' }));
    box.appendChild(row('区画の大きさ(度)', tIn(b.cell, function (v) { setL(id, ['build', 'cell'], v); }, { type: 'number', step: 'any', ph: '0.005' }), '0.005 ≒ 450m四方。データが非常に密なら小さく'));
    box.appendChild(row('データのURL', tIn(b.url || '', function (v) { setL(id, ['build', 'url'], v); }, { ph: 'https://github.com/…/releases/download/…' }),
      'data フォルダに置けない大きなファイルをURLから取得する場合のみ(通常は空欄)'));
  }

  // ---------------- 保存 ----------------
  $('btn-dl').addEventListener('click', function () {
    var blob = new Blob([configText()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'config.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  var gh = { owner: $('gh-owner'), repo: $('gh-repo'), branch: $('gh-branch'), token: $('gh-token'), remember: $('gh-remember'), msg: $('gh-msg') };
  function loadCreds() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem('gis_admin') || '{}'); } catch (e) {}
    if (c.token) {  // 旧バージョンが保存したトークンは消す
      delete c.token;
      try { localStorage.setItem('gis_admin', JSON.stringify(c)); } catch (e) {}
    }
    try { c.token = sessionStorage.getItem('gis_admin_token') || ''; } catch (e) { c.token = ''; }
    var host = location.hostname, path = location.pathname.split('/').filter(Boolean);
    if (!c.owner && /\.github\.io$/.test(host)) { c.owner = host.split('.')[0]; if (path.length && !/\.html$/.test(path[0])) c.repo = path[0]; else c.repo = host; }
    return c;
  }
  $('btn-save').addEventListener('click', function () {
    var c = loadCreds();
    gh.owner.value = c.owner || ''; gh.repo.value = c.repo || ''; gh.branch.value = c.branch || 'main';
    gh.token.value = c.token || ''; gh.remember.checked = !!c.token;
    gh.msg.textContent = ''; gh.msg.className = 'msg';
    $('modal').hidden = false;
  });
  $('gh-cancel').addEventListener('click', function () { $('modal').hidden = true; });
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }
  $('gh-run').addEventListener('click', function () {
    var o = gh.owner.value.trim(), r = gh.repo.value.trim(), br = gh.branch.value.trim() || 'main', tk = gh.token.value.trim();
    if (!o || !r || !tk) { gh.msg.className = 'msg ng'; gh.msg.textContent = 'ユーザー名・リポジトリ名・トークンを入力してください'; return; }
    try {
      localStorage.setItem('gis_admin', JSON.stringify({ owner: o, repo: r, branch: br }));   // トークンは保存しない
      if (gh.remember.checked) sessionStorage.setItem('gis_admin_token', tk); else sessionStorage.removeItem('gis_admin_token');
    } catch (e) {}
    var api = 'https://api.github.com/repos/' + encodeURIComponent(o) + '/' + encodeURIComponent(r) + '/contents/config.json';
    var headers = { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    gh.msg.className = 'msg'; gh.msg.textContent = '保存中…';
    fetch(api + '?ref=' + encodeURIComponent(br), { headers: headers }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('config.json を確認できません(' + res.status + ')。名前・トークンの権限を確認してください');
      return res.json();
    }).then(function (cur) {
      var body = { message: '管理画面から設定を更新', content: b64(configText()), branch: br };
      if (cur && cur.sha) body.sha = cur.sha;
      return fetch(api, { method: 'PUT', headers: headers, body: JSON.stringify(body) });
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error((j && j.message) || ('保存に失敗しました(' + res.status + ')')); });
      dirty = false;
      var s = $('state'); s.textContent = '保存しました'; s.className = '';
      gh.msg.className = 'msg ok';
      gh.msg.innerHTML = '保存しました。数分後に公開サイトへ反映されます。<br><a href="https://github.com/' + GIS.esc(o) + '/' + GIS.esc(r) + '/actions" target="_blank" rel="noopener">反映の進み具合を見る</a>';
    }).catch(function (e) { gh.msg.className = 'msg ng'; gh.msg.textContent = e.message; });
  });

  // ---------------- 起動 ----------------
  function fetchJSON(url, optional) {
    return fetch(url + '?t=' + Date.now()).then(function (r) {
      if (!r.ok) { if (optional) return {}; throw new Error(url + ' が読み込めません'); }
      return r.json();
    });
  }
  Promise.all([fetchJSON('manifest.json', false), fetchJSON('config.json', true).catch(function () { return {}; })]).then(function (res) {
    manifest = res[0] || { layers: [] };
    config = res[1] || {};
    manifest.layers.forEach(function (m) { mById[m.id] = m; });
    $('state').textContent = '読み込み完了';
    renderTree();
    renderEditor();
  }).catch(function (e) {
    ed.innerHTML = '';
    ed.appendChild(h('div', { 'class': 'err', text: '読み込みに失敗しました: ' + e.message + '(公開サイトのURL、または「python tools/build.py」で作った _site フォルダの admin.html を開いてください)' }));
  });
})();
