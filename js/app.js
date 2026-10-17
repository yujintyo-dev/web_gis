/* 公開型GIS メインスクリプト
 * レイヤーは data フォルダに置くだけで自動登録されます。表示設定は管理画面(admin.html)で変更します。
 * (このファイルは基本的に触らなくて大丈夫です)
 */
(function () {
  'use strict';

  // ================= ユーティリティ =================
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 全角→半角、ハイフン類の統一、空白除去(検索用)
  function normalize(s) {
    return String(s == null ? '' : s).normalize('NFKC')
      .replace(/[‐‑‒–—―−ー－]/g, '-').replace(/\s+/g, '').toLowerCase();
  }
  function isEmpty(v) { return v === null || v === undefined || v === ''; }

  var conf = { map: {}, valueMaps: {}, layers: [] };

  // ================= 地図 =================
  var map = L.map('map', { preferCanvas: true, zoomSnap: 1, wheelPxPerZoomLevel: 90 });
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  var ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
  var bases = [
    { id: 'std', name: '地理院地図(標準)',
      layer: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
        { attribution: ATTR, maxNativeZoom: 18, maxZoom: 22, minZoom: 2 }) },
    { id: 'photo', name: '航空写真(地理院シームレス)',
      layer: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
        { attribution: ATTR, maxNativeZoom: 18, maxZoom: 22, minZoom: 2 }) }
  ];
  function setBase(id) {
    bases.forEach(function (b) {
      if (b.id === id) { if (!map.hasLayer(b.layer)) b.layer.addTo(map); b.layer.bringToBack(); }
      else if (map.hasLayer(b.layer)) map.removeLayer(b.layer);
    });
    try { localStorage.setItem('gis_base', id); } catch (e) {}
  }

  // ================= 範囲指定読み込み(Range) =================
  var wholeCache = {};
  var pending = 0;
  function updateLoading() { statusEl.className = pending > 0 ? 'loading' : ''; }

  // パックファイルの一部だけをダウンロードする(GitHub Pagesは対応)
  function fetchBytes(url, off, len) {
    if (wholeCache[url]) return Promise.resolve(wholeCache[url].subarray(off, off + len));
    pending++; updateLoading();
    return fetch(url, { headers: { Range: 'bytes=' + off + '-' + (off + len - 1) } })
      .then(function (r) {
        if (r.status === 206) return r.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        if (r.status === 200) { // Range非対応サーバー: 全体を受け取って使い回す
          return r.arrayBuffer().then(function (b) {
            var u = new Uint8Array(b); wholeCache[url] = u; return u.subarray(off, off + len);
          });
        }
        throw new Error(url + ' (' + r.status + ')');
      })
      .then(function (u) { pending--; updateLoading(); return u; },
        function (e) { pending--; updateLoading(); throw e; });
  }
  var decoder = new TextDecoder('utf-8');
  function parseBytes(u8) { return JSON.parse(decoder.decode(u8)); }
  function dirOf(url) { return url.replace(/[^\/]*$/, ''); }

  // ================= 図形の判定(クリック位置の検索用) =================
  function bboxOf(c, b) {
    b = b || [1e9, 1e9, -1e9, -1e9];
    if (typeof c[0] === 'number') {
      if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
      if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
    } else { for (var i = 0; i < c.length; i++) bboxOf(c[i], b); }
    return b;
  }
  // 外接矩形をキャッシュ(ダウンロード時に混ざらないよう enumerable:false)
  function fbox(f) {
    if (!f._bb) Object.defineProperty(f, '_bb', { value: bboxOf(f.geometry.coordinates), enumerable: false });
    return f._bb;
  }
  function inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inPolygon(x, y, rings) {
    if (!inRing(x, y, rings[0])) return false;
    for (var i = 1; i < rings.length; i++) if (inRing(x, y, rings[i])) return false;
    return true;
  }
  function segDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, t = 0;
    var l2 = dx * dx + dy * dy;
    if (l2 > 0) { t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2; t = Math.max(0, Math.min(1, t)); }
    var qx = a.x + t * dx - p.x, qy = a.y + t * dy - p.y;
    return Math.sqrt(qx * qx + qy * qy);
  }
  function lineHit(p, line, tol) {
    var prev = null;
    for (var i = 0; i < line.length; i++) {
      var q = map.latLngToLayerPoint([line[i][1], line[i][0]]);
      if (prev && segDist(p, prev, q) <= tol) return true;
      prev = q;
    }
    return false;
  }
  function hitTest(f, ll) {
    var g = f.geometry; if (!g) return false;
    var bb = fbox(f), x = ll.lng, y = ll.lat, t = g.type;
    if (t === 'Polygon' || t === 'MultiPolygon') {
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) return false;
      if (t === 'Polygon') return inPolygon(x, y, g.coordinates);
      return g.coordinates.some(function (p) { return inPolygon(x, y, p); });
    }
    var p = map.latLngToLayerPoint(ll);
    if (t === 'Point') return map.latLngToLayerPoint([g.coordinates[1], g.coordinates[0]]).distanceTo(p) <= 12;
    if (t === 'MultiPoint') return g.coordinates.some(function (c) { return map.latLngToLayerPoint([c[1], c[0]]).distanceTo(p) <= 12; });
    if (t === 'LineString') return lineHit(p, g.coordinates, 8);
    if (t === 'MultiLineString') return g.coordinates.some(function (l) { return lineHit(p, l, 8); });
    return false;
  }

  // ================= スタイル =================
  function makeStyle(cfg, props, op) {
    var s = cfg.style || {};
    var fill = s.fillColor || s.color || '#3388ff';
    if (cfg.styleBy && props) {
      var c = (cfg.styleBy.colors || {})[String(props[cfg.styleBy.field])];
      fill = c || cfg.styleBy.default || fill;
    }
    var color = s.color || fill;
    if (s.invisible) return { interactive: false, stroke: false, fill: false, opacity: 0, fillOpacity: 0 };
    return {
      interactive: false,
      color: color, weight: s.weight != null ? s.weight : 1,
      opacity: (s.opacity != null ? s.opacity : 1) * op,
      fill: s.fill !== false, fillColor: fill,
      fillOpacity: (s.fillOpacity != null ? s.fillOpacity : 0.2) * op
    };
  }
  function makeGeoJSON(st, data) {
    var cfg = st.cfg;
    return L.geoJSON(data, {
      style: function (f) { return makeStyle(cfg, f.properties, st.opacity); },
      pointToLayer: function (f, ll) {
        var o = makeStyle(cfg, f.properties, st.opacity);
        o.radius = (cfg.style && cfg.style.invisible) ? 1 : ((cfg.style && cfg.style.radius) || 6);
        o.weight = (cfg.style && cfg.style.invisible) ? 0 : (cfg.style && cfg.style.weight != null ? cfg.style.weight : 1.5);
        o.fillOpacity = (cfg.style && cfg.style.invisible) ? 0 : 0.85 * st.opacity;
        return L.circleMarker(ll, o);
      }
    });
  }

  // ================= レイヤーの状態 =================
  var states = [];
  var kindOf = { tile: 'raster', tiles: 'tiles' };

  function setHint(st, text) {
    if (!st.hint) return;
    if (text) { st.hint.textContent = text; st.hint.hidden = false; } else st.hint.hidden = true;
  }
  function minZoomOf(st) { return st.cfg.minZoom || 0; }
  function zoomOk(st) { return map.getZoom() >= minZoomOf(st); }

  // 描画順(設定ファイルで後ろに書いたレイヤーほど上)
  var reorderTimer = null;
  function scheduleReorder() {
    clearTimeout(reorderTimer);
    reorderTimer = setTimeout(function () {
      states.forEach(function (st) {
        if (st.kind === 'raster') return;
        if (st.kind === 'geojson' && st.layer && map.hasLayer(st.layer)) st.layer.bringToFront();
        if (st.kind === 'tiles') st.tiles.forEach(function (t) { if (t.onMap) t.layer.bringToFront(); });
      });
      highlight.bringToFront();
    }, 0);
  }

  // ---------- geojson(1ファイル)----------
  function loadData(st) {
    if (st.promise) return st.promise;
    st.promise = fetch(st.cfg.file).then(function (r) {
      if (!r.ok) throw new Error(st.cfg.file + ' が読み込めません');
      return r.json();
    }).then(function (gj) {
      st.geojson = gj;
      st.layer = makeGeoJSON(st, gj);
      return st;
    }).catch(function (e) { console.error(e); st.error = true; setHint(st, '読み込み失敗: ' + e.message); return st; });
    return st.promise;
  }

  // ---------- tiles(分割データ)----------
  function loadIndex(st) {
    if (st.indexPromise) return st.indexPromise;
    st.indexPromise = fetch(st.cfg.index).then(function (r) {
      if (!r.ok) throw new Error(st.cfg.index + ' が読み込めません');
      return r.json();
    }).then(function (idx) { st.index = idx; st.base = dirOf(st.cfg.index); return st; })
      .catch(function (e) { console.error(e); setHint(st, '読み込み失敗: ' + e.message); return st; });
    return st.indexPromise;
  }
  function neededKeys(st, b, extra) {
    var c = st.index.cell, e = extra == null ? c * 0.5 : extra;
    var x0 = Math.floor((b.getWest() - e) / c), x1 = Math.floor((b.getEast() + e) / c);
    var y0 = Math.floor((b.getSouth() - e) / c), y1 = Math.floor((b.getNorth() + e) / c);
    var keys = [];
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 5000) return { keys: keys, tooMany: true };
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
      var k = x + '_' + y; if (st.index.tiles[k]) keys.push(k);
    }
    return { keys: keys, tooMany: keys.length > (st.cfg.maxTiles || 80) };
  }
  function loadTile(st, key) {
    var t = st.tiles.get(key);
    if (t) { t.used = Date.now(); return t.promise; }
    var info = st.index.tiles[key];
    t = { key: key, onMap: false, used: Date.now(), features: null, layer: null };
    t.promise = fetchBytes(st.base + st.index.packs[info[0]], info[1], info[2]).then(function (u8) {
      t.features = parseBytes(u8);
      t.layer = makeGeoJSON(st, t.features);
      return t;
    }).catch(function (e) { console.error(e); st.tiles.delete(key); throw e; });
    st.tiles.set(key, t);
    return t.promise;
  }
  function removeTiles(st) {
    st.needed = {};
    st.tiles.forEach(function (t) { if (t.onMap) { map.removeLayer(t.layer); t.onMap = false; } });
  }
  function evictTiles(st) {
    if (st.tiles.size <= 150) return;
    var arr = [];
    st.tiles.forEach(function (t, k) { if (!t.onMap && !st.needed[k] && t.layer) arr.push(t); });
    arr.sort(function (a, b) { return a.used - b.used; });
    for (var i = 0; arr.length && st.tiles.size > 110 && i < arr.length; i++) st.tiles.delete(arr[i].key);
  }
  function updateTiles(st) {
    return loadIndex(st).then(function () {
      if (!st.index) return;
      if (!st.visible || !zoomOk(st)) {
        removeTiles(st);
        setHint(st, st.visible ? 'ズーム' + minZoomOf(st) + '以上で表示されます' : null);
        return;
      }
      var r = neededKeys(st, map.getBounds());
      if (r.tooMany) { removeTiles(st); setHint(st, '表示範囲が広すぎます。拡大してください'); return; }
      setHint(st, null);
      st.needed = {};
      r.keys.forEach(function (k) { st.needed[k] = true; });
      st.tiles.forEach(function (t, k) {
        if (!st.needed[k] && t.onMap) { map.removeLayer(t.layer); t.onMap = false; }
      });
      return Promise.all(r.keys.map(function (k) {
        return loadTile(st, k).then(function (t) {
          if (st.needed[k] && st.visible && !t.onMap) { t.layer.addTo(map); t.onMap = true; scheduleReorder(); }
        }, function () {});
      })).then(function () { evictTiles(st); updateLabels(); });
    });
  }

  // ---------- 共通の同期 ----------
  function sync(st) {
    if (st.kind === 'raster') {
      var want = st.visible && zoomOk(st);
      setHint(st, st.visible && !want ? 'ズーム' + minZoomOf(st) + '以上で表示されます' : null);
      if (want && !map.hasLayer(st.layer)) st.layer.addTo(map);
      if (!want && map.hasLayer(st.layer)) map.removeLayer(st.layer);
      return Promise.resolve();
    }
    if (st.kind === 'tiles') return updateTiles(st);
    var w = st.visible && zoomOk(st);
    setHint(st, st.visible && !w ? 'ズーム' + minZoomOf(st) + '以上で表示されます' : null);
    if (w) {
      return loadData(st).then(function () {
        if (st.layer && st.visible && zoomOk(st) && !map.hasLayer(st.layer)) { st.layer.addTo(map); scheduleReorder(); updateLabels(); }
      });
    }
    if (st.layer && map.hasLayer(st.layer)) map.removeLayer(st.layer);
    return Promise.resolve();
  }
  function syncAll() { return Promise.all(states.map(sync)); }

  function setOpacity(st, v) {
    st.opacity = v;
    if (st.kind === 'raster') { st.layer.setOpacity(v); return; }
    var fn = function (f) { return makeStyle(st.cfg, f.properties, v); };
    if (st.kind === 'geojson' && st.layer) st.layer.setStyle(fn);
    if (st.kind === 'tiles') st.tiles.forEach(function (t) { if (t.layer) t.layer.setStyle(fn); });
  }

  // ---------- ラベル(画面内・拡大時のみ。軽量化のため件数に上限)----------
  var MAX_LABELS = 400;
  function eachFeatureLayer(st, fn) {
    if (st.kind === 'geojson' && st.layer && map.hasLayer(st.layer)) st.layer.eachLayer(fn);
    else if (st.kind === 'tiles') st.tiles.forEach(function (t) { if (t.onMap) t.layer.eachLayer(fn); });
  }
  function updateLabels() {
    var z = map.getZoom(), b = map.getBounds(), count = 0;
    states.forEach(function (st) {
      var cfg = st.cfg;
      if (!cfg.labelField) return;
      var on = z >= (cfg.labelMinZoom || 18);
      eachFeatureLayer(st, function (l) {
        var show = false;
        if (on && count < MAX_LABELS) {
          var inView = l.getBounds ? b.intersects(l.getBounds()) : b.contains(l.getLatLng());
          var text = l.feature.properties && l.feature.properties[cfg.labelField];
          if (inView && !isEmpty(text)) {
            show = true; count++;
            if (!l.getTooltip()) {
              var span = document.createElement('span');
              span.textContent = String(text);   // 文字として扱う(HTMLとして解釈させない)
              l.bindTooltip(span, { permanent: true, direction: 'center', className: 'parcel-label', interactive: false });
            }
          }
        }
        if (!show && l.getTooltip()) l.unbindTooltip();
      });
    });
  }

  // ================= ポップアップ(config.json の popup 設定で組み立て) =================
  function valueMap(m) { return typeof m === 'string' ? (conf.valueMaps || {})[m] : m; }
  function popupSection(st, f) { return GIS.popupSectionHtml(st.cfg, f.properties || {}, conf.valueMaps); }

  var highlight = L.geoJSON(null, {
    style: { color: '#e03131', weight: 3, fillColor: '#ffe066', fillOpacity: 0.3, interactive: false },
    pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 10, color: '#e03131', weight: 3, fillOpacity: 0.3, interactive: false }); },
    interactive: false
  }).addTo(map);
  var marker = null;

  function featuresOf(st) {
    if (st.kind === 'geojson') return (st.layer && map.hasLayer(st.layer) && st.geojson) ? st.geojson.features : [];
    if (st.kind === 'tiles') {
      var arr = [];
      st.tiles.forEach(function (t) { if (t.onMap && t.features) arr.push(t.features); });
      return arr;
    }
    return [];
  }
  function findHits(st, ll, max) {
    var hits = [];
    var lists = st.kind === 'geojson' ? [featuresOf(st)] : featuresOf(st);
    for (var i = 0; i < lists.length && hits.length < max; i++) {
      var list = lists[i];
      for (var j = 0; j < list.length && hits.length < max; j++) {
        if (hitTest(list[j], ll)) hits.push(list[j]);
      }
    }
    return hits;
  }
  // 指定位置の情報をまとめて表示(上にあるレイヤーから順に)
  function showInfoAt(ll) {
    var html = '', all = [];
    for (var i = states.length - 1; i >= 0; i--) {
      var st = states[i], pc = st.cfg.popup || {};
      if (st.kind === 'raster' || pc.enabled === false || !st.visible) continue;
      findHits(st, ll, pc.maxFeatures || 1).forEach(function (f) {
        html += popupSection(st, f);
        if (st.cfg.popup && st.cfg.popup.highlight === false) return;
        all.push(f);
      });
    }
    highlight.clearLayers();
    if (!html) { map.closePopup(); return false; }
    if (all.length) { highlight.addData({ type: 'FeatureCollection', features: all }); highlight.bringToFront(); }
    L.popup({ maxWidth: 320, maxHeight: 320, className: 'gis-popup' }).setLatLng(ll).setContent(html).openOn(map);
    return true;
  }
  map.on('click', function (e) {
    $('search-results').hidden = true;
    showInfoAt(e.latlng);
  });
  map.on('popupclose', function () { highlight.clearLayers(); });

  // ================= ダウンロード =================
  function saveJSON(obj, filename) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/geo+json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function dlBase(st) { return (st.cfg.download && st.cfg.download.filename) || GIS.safeName(String(st.cfg.id).split('/').pop()) || 'layer'; }
  function downloadWhole(st) {
    loadData(st).then(function () {
      if (!st.geojson) return;
      saveJSON(st.geojson, dlBase(st) + '.geojson');
    });
  }
  function downloadView(st) {
    if (!zoomOk(st)) { alert('ズーム' + minZoomOf(st) + '以上に拡大してから実行してください。'); return; }
    loadIndex(st).then(function () {
      var b = map.getBounds();
      var r = neededKeys(st, b, 0);
      if (r.tooMany) { alert('表示範囲が広すぎます。拡大してから実行してください。'); return; }
      Promise.all(r.keys.map(function (k) { return loadTile(st, k); })).then(function (ts) {
        var out = [];
        ts.forEach(function (t) {
          t.features.forEach(function (f) {
            var bb = fbox(f);
            if (bb[2] >= b.getWest() && bb[0] <= b.getEast() && bb[3] >= b.getSouth() && bb[1] <= b.getNorth()) out.push(f);
          });
        });
        if (!out.length) { alert('表示範囲にデータがありません。'); return; }
        saveJSON({ type: 'FeatureCollection', name: dlBase(st), features: out }, dlBase(st) + '_view.geojson');
      }).catch(function () { alert('データの取得に失敗しました。'); });
    });
  }

  // ================= パネルUI(カテゴリ階層つき) =================
  var stById = {};
  var groupBoxes = [];
  var treeRoot = null;

  function descendants(node) {
    var out = [];
    node.items.forEach(function (it) {
      if (it.kind === 'layer') out.push(stById[it.cfg.id]); else out = out.concat(descendants(it.node));
    });
    return out;
  }
  function refreshGroups() {
    groupBoxes.forEach(function (g) {
      var ds = descendants(g.node);
      var on = ds.filter(function (s) { return s.visible; }).length;
      g.cb.checked = ds.length > 0 && on === ds.length;
      g.cb.indeterminate = on > 0 && on < ds.length;
    });
  }

  function makeLayerItem(st) {
    var cfg = st.cfg;
    var item = document.createElement('div');
    item.className = 'layer-item';
    var color = (cfg.style && (cfg.style.fillColor || cfg.style.color)) || '#999';
    var legendItems = cfg.legend;
    if ((!legendItems || !legendItems.length) && cfg.styleBy && cfg.styleBy.colors && cfg.styleBy.legend !== false) {
      var lb = cfg.styleBy.labels || {};
      legendItems = Object.keys(cfg.styleBy.colors).map(function (k) { return { label: lb[k] != null ? lb[k] : k, color: cfg.styleBy.colors[k] }; });
    }
    var legend = '';
    if (legendItems && legendItems.length) {
      legend = '<ul class="legend">' + legendItems.map(function (l) {
        return '<li><span class="swatch" style="background:' + esc(l.color) + ';border-color:' + esc(l.color) + '"></span>' + esc(l.label) + '</li>';
      }).join('') + '</ul>';
    }
    var dl = cfg.download || {};
    var dlHtml = '';
    if (dl.enabled === true && st.kind !== 'raster') {
      dlHtml = '<div class="dl-row">';
      if (st.kind === 'tiles') {
        dlHtml += '<button type="button" class="dl-btn" data-act="view">⬇ 表示範囲をGeoJSON保存</button>';
        if (dl.fullUrl) dlHtml += '<a class="dl-btn" href="' + esc(dl.fullUrl) + '" target="_blank" rel="noopener">⬇ 全体をダウンロード</a>';
      } else if (dl.fullUrl) {
        dlHtml += '<a class="dl-btn" href="' + esc(dl.fullUrl) + '" download>⬇ GeoJSONダウンロード</a>';
      } else {
        dlHtml += '<button type="button" class="dl-btn" data-act="whole">⬇ GeoJSONダウンロード</button>';
      }
      dlHtml += '</div>';
    }
    var upd = (cfg.updated && conf.showUpdated !== false) ? '<div class="upd">データ更新: ' + esc(cfg.updatedLabel || cfg.updated) + '</div>' : '';
    if (cfg.source) upd += '<div class="upd">出典: ' + esc(cfg.source) + '</div>';
    item.innerHTML =
      '<label><input type="checkbox"' + (st.visible ? ' checked' : '') + '>' +
      '<span class="swatch" style="border-color:' + esc(color) + ';background:' + esc((cfg.style && cfg.style.fillColor) || 'transparent') + '"></span>' +
      '<span>' + esc(cfg.name) + '</span></label>' + upd +
      '<input type="range" min="0.1" max="1" step="0.1" value="' + st.opacity + '" aria-label="透明度">' +
      '<div class="hint" hidden></div>' + legend + dlHtml;
    var cb = item.querySelector('input[type=checkbox]');
    var rg = item.querySelector('input[type=range]');
    st.hint = item.querySelector('.hint');
    st.checkbox = cb;
    cb.addEventListener('change', function () { st.visible = cb.checked; sync(st); refreshGroups(); });
    rg.addEventListener('input', function () { setOpacity(st, parseFloat(rg.value)); });
    var btn = item.querySelector('.dl-btn[data-act]');
    if (btn) btn.addEventListener('click', function () {
      if (btn.getAttribute('data-act') === 'view') downloadView(st); else downloadWhole(st);
    });
    return item;
  }

  function renderNode(node, box) {
    node.items.forEach(function (it) {
      if (it.kind === 'layer') { box.appendChild(makeLayerItem(stById[it.cfg.id])); return; }
      var n = it.node;
      if (!descendants(n).length) return; // 中身が空のカテゴリは出さない
      var wrap = document.createElement('div'); wrap.className = 'cat';
      var head = document.createElement('div'); head.className = 'cat-head';
      var arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'cat-arrow'; arrow.setAttribute('aria-label', '開閉');
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', n.title + ' をまとめて表示');
      var title = document.createElement('span'); title.className = 'cat-title'; title.textContent = n.title;
      head.appendChild(arrow); head.appendChild(cb); head.appendChild(title);
      var body = document.createElement('div'); body.className = 'cat-body';
      function setOpen(o) { body.hidden = !o; arrow.textContent = o ? '▾' : '▸'; }
      setOpen(n.open);
      arrow.addEventListener('click', function () { setOpen(body.hidden); });
      title.addEventListener('click', function () { setOpen(body.hidden); });
      cb.addEventListener('change', function () {
        descendants(n).forEach(function (s) { s.visible = cb.checked; if (s.checkbox) s.checkbox.checked = cb.checked; sync(s); });
        refreshGroups();
      });
      groupBoxes.push({ cb: cb, node: n });
      wrap.appendChild(head); wrap.appendChild(body);
      box.appendChild(wrap);
      renderNode(n, body);
    });
  }

  function buildPanel() {
    var baseBox = $('base-list');
    var saved = null;
    try { saved = localStorage.getItem('gis_base'); } catch (e) {}
    var startBase = bases.some(function (b) { return b.id === saved; }) ? saved : 'std';
    bases.forEach(function (b) {
      var label = document.createElement('label');
      label.innerHTML = '<input type="radio" name="base" value="' + b.id + '"' + (b.id === startBase ? ' checked' : '') + '> ' + esc(b.name);
      label.firstChild.addEventListener('change', function () { setBase(b.id); });
      baseBox.appendChild(label);
    });
    setBase(startBase);
    renderNode(treeRoot, $('layer-list'));
    refreshGroups();
  }

  $('btn-layers').addEventListener('click', function () { $('panel').hidden = !$('panel').hidden; });
  $('panel-close').addEventListener('click', function () { $('panel').hidden = true; });

  // ================= 現在地 =================
  var locMarker = null;
  $('btn-locate').addEventListener('click', function () { map.locate({ setView: true, maxZoom: 18 }); });
  map.on('locationfound', function (e) {
    if (locMarker) map.removeLayer(locMarker);
    locMarker = L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#1c7ed6', fillOpacity: 1, interactive: false }).addTo(map);
  });
  map.on('locationerror', function () { alert('現在地を取得できませんでした。ブラウザの位置情報許可を確認してください。'); });

  // ================= 検索 =================
  var resultsEl = $('search-results');
  var groupSel = $('search-group');
  function showMessage(text) { resultsEl.innerHTML = '<li class="msg">' + esc(text) + '</li>'; resultsEl.hidden = false; }

  // ---- 分割検索データ(大字ごと)----
  function shardStates() { return states.filter(function (s) { return s.cfg.search && s.cfg.search.index; }); }
  function loadSearchIndex(st) {
    if (st.searchIndexPromise) return st.searchIndexPromise;
    st.searchIndexPromise = fetch(st.cfg.search.index).then(function (r) {
      if (!r.ok) throw new Error(st.cfg.search.index + ' が読み込めません');
      return r.json();
    })
      .then(function (idx) { if (!idx || !idx.shards) throw new Error('検索データの形式が不正です'); st.searchIndex = idx; st.searchBase = dirOf(st.cfg.search.index); st.shardCache = {}; return st; })
      .catch(function (e) { console.error(e); return st; });
    return st.searchIndexPromise;
  }
  function loadShard(st, code) {
    if (st.shardCache[code]) return st.shardCache[code].promise;
    var info = st.searchIndex.shards[code];
    var entry = {};
    entry.promise = fetchBytes(st.searchBase + st.searchIndex.packs[info[0]], info[1], info[2]).then(function (u8) {
      entry.rows = parseBytes(u8);
      entry.norm = entry.rows.map(function (r) { return normalize(r[0]); });
      return entry;
    });
    st.shardCache[code] = entry;
    return entry.promise;
  }
  function groupName(st, code) {
    var m = valueMap(st.cfg.search.groupMap);
    return (m && m[code]) ? m[code] : '大字コード' + code;
  }
  function hasGroupName(st, code) {
    var m = valueMap(st.cfg.search.groupMap);
    return !!(m && m[code]);
  }
  function buildGroupSelect() {
    var ss = shardStates();
    if (!ss.length) return Promise.resolve();
    var st = ss[0];
    return loadSearchIndex(st).then(function () {
      if (!st.searchIndex) return;
      var codes = Object.keys(st.searchIndex.shards);
      var named = codes.map(function (c) { return { c: c, n: groupName(st, c), has: hasGroupName(st, c) }; });
      named.sort(function (a, b) {                       // 名称あり(五十音順) → 名称なし(コード順)
        if (a.has !== b.has) return a.has ? -1 : 1;
        return a.has ? a.n.localeCompare(b.n, 'ja') : (a.c < b.c ? -1 : a.c > b.c ? 1 : 0);
      });
      var anyNamed = named.some(function (o) { return o.has; });
      $('search-input').setAttribute('placeholder', anyNamed ? '地番を検索(例: 1117-18 / 今市 1117-18)' : '地番を検索(例: 1117-18)');
      var label = st.cfg.search.groupLabel || '大字';
      var opts = '<option value="*">' + esc(label) + ': すべて</option>';
      named.forEach(function (o) { opts += '<option value="' + esc(o.c) + '">' + esc(o.n) + '(' + st.searchIndex.shards[o.c][3] + ')</option>'; });
      groupSel.innerHTML = opts;
      groupSel.hidden = false;
    });
  }

  function displayText(st, hit) {
    var tpl = (st.cfg.search && st.cfg.search.display) || '{label}';
    var props = hit.f ? hit.f.properties : { label: hit.label, group: hit.group };
    return tpl.replace(/\{([^}]+)\}/g, function (m, k) { return props && props[k] != null ? props[k] : ''; });
  }

  function doSearch(query) {
    var terms = query.normalize('NFKC').split(/\s+/).map(normalize).filter(Boolean);
    if (!terms.length) { resultsEl.hidden = true; return; }
    var targets = states.filter(function (st) { return st.cfg.search && (st.cfg.search.index || st.cfg.search.fields); });
    if (!targets.length) { showMessage('検索対象のレイヤーが設定されていません'); return; }
    showMessage('検索中…');
    var joined = terms.join('');
    var jobs = targets.map(function (st) {
      var sc = st.cfg.search;
      if (sc.index) { // 分割検索データ
        return loadSearchIndex(st).then(function () {
          if (!st.searchIndex) return [];
          var sel = groupSel.hidden ? '*' : groupSel.value;
          var codes = sel === '*' ? Object.keys(st.searchIndex.shards) : [sel];
          var lt = terms;                                  // 地番として探す語
          if (sel === '*') {                               // 「大字: すべて」のとき、入力語に大字名があれば、その大字に絞る
            var gt = terms.filter(function (t) { return /[^0-9\-]/.test(t); });   // 数字とハイフンだけの語は、地番として扱う
            if (gt.length) {
              var matched = codes.filter(function (c) {
                var nm = normalize(groupName(st, c));
                return gt.every(function (t) { return nm.indexOf(t) >= 0; });
              });
              if (matched.length) { codes = matched; lt = terms.filter(function (t) { return gt.indexOf(t) < 0; }); }
            }
          }
          return Promise.all(codes.map(function (c) { return loadShard(st, c).then(function (e) { return { c: c, e: e }; }); }))
            .then(function (list) {
              var hits = [];
              list.forEach(function (it) {
                for (var i = 0; i < it.e.norm.length && hits.length < 500; i++) {
                  var n = it.e.norm[i], ok = true;
                  for (var t = 0; t < lt.length; t++) if (n.indexOf(lt[t]) < 0) { ok = false; break; }
                  if (ok) {
                    var r = it.e.rows[i];
                    hits.push({ st: st, label: r[0], lon: r[1], lat: r[2], group: groupName(st, it.c), code: it.c, exact: n === lt.join('') });
                  }
                }
              });
              return hits;
            });
        });
      }
      return loadData(st).then(function () { // 通常のgeojson内検索
        if (!st.geojson) return [];
        if (!st.index2) {
          st.index2 = st.geojson.features.map(function (f) {
            return normalize(sc.fields.map(function (k) { return f.properties && f.properties[k]; }).join(''));
          });
        }
        var hits = [];
        for (var i = 0; i < st.index2.length && hits.length < 500; i++) {
          var ok = true;
          for (var t = 0; t < terms.length; t++) if (st.index2[i].indexOf(terms[t]) < 0) { ok = false; break; }
          if (ok) hits.push({ st: st, f: st.geojson.features[i], exact: st.index2[i] === joined });
        }
        return hits;
      });
    });
    Promise.all(jobs).then(function (lists) {
      var hits = [].concat.apply([], lists);
      if (!hits.length) { showMessage('該当するものが見つかりません'); return; }
      hits.sort(function (a, b) { return (b.exact ? 1 : 0) - (a.exact ? 1 : 0); });
      resultsEl.innerHTML = '';
      hits.slice(0, 30).forEach(function (h) {
        var li = document.createElement('li');
        li.innerHTML = esc(displayText(h.st, h)) + '<small>' + esc(h.st.cfg.name) + '</small>';
        li.addEventListener('click', function () { goTo(h); });
        resultsEl.appendChild(li);
      });
      if (hits.length > 30) {
        var more = document.createElement('li'); more.className = 'msg';
        more.textContent = (hits.length >= 500 ? '500件以上' : hits.length + '件') + '該当しました。大字の指定や条件の追加で絞り込んでください。';
        resultsEl.appendChild(more);
      }
      resultsEl.hidden = false;
    }).catch(function (e) { console.error(e); showMessage('検索に失敗しました'); });
  }

  function goTo(h) {
    resultsEl.hidden = true;
    var sc = h.st.cfg.search || {};
    // 関連レイヤーを自動でONにする
    var ids = [h.st.cfg.id].concat(sc.showLayers || []);
    states.forEach(function (s) {
      if (ids.indexOf(s.cfg.id) >= 0 && !s.visible) { s.visible = true; if (s.checkbox) s.checkbox.checked = true; }
    });
    refreshGroups();
    var ll, zoom = sc.zoom || 19;
    if (h.f) {
      var b = L.geoJSON(h.f).getBounds();
      ll = b.getCenter();
      if (b.getSouthWest().equals(b.getNorthEast())) map.setView(ll, zoom, { animate: false });
      else map.fitBounds(b, { maxZoom: zoom, padding: [60, 60], animate: false });
    } else {
      ll = L.latLng(h.lat, h.lon);
      map.setView(ll, zoom, { animate: false });
    }
    if (marker) map.removeLayer(marker);
    marker = L.circleMarker(ll, { radius: 7, color: '#e03131', weight: 3, fillOpacity: 0.2, interactive: false }).addTo(map);
    syncAll().then(function () { showInfoAt(ll); });
  }

  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault(); doSearch($('search-input').value); $('search-input').blur();
  });
  $('search-input').addEventListener('input', function () {
    if (!this.value) { resultsEl.hidden = true; if (marker) { map.removeLayer(marker); marker = null; } }
  });

  // ================= ステータス表示 =================
  var statusEl = $('status');
  function showStatus(ll) {
    statusEl.textContent = 'Z' + map.getZoom() + '  ' + ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6);
  }
  map.on('mousemove', function (e) { showStatus(e.latlng); });
  map.on('move', function () { showStatus(map.getCenter()); });

  var moveTimer = null;
  map.on('moveend zoomend', function () {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(function () { syncAll(); updateLabels(); if (printOn) updatePrintInfo(); }, 200);
  });


  // ================= 案内帯の高さ(下の部品が重ならないように) =================
  function syncNotice() {
    var n = $('notice');
    var hh = (n && !n.hidden) ? (n.offsetHeight || 0) : 0;
    document.documentElement.style.setProperty('--notice-h', hh + 'px');
  }
  window.addEventListener('resize', syncNotice);
  if (typeof ResizeObserver !== 'undefined' && $('notice')) { try { new ResizeObserver(syncNotice).observe($('notice')); } catch (e) {} }

  // ================= 印刷(プレビュー → 印刷) =================
  var PAPER = { A4: [210, 297], A3: [297, 420] };   // mm(縦向き)
  var PMARGIN = 8;                                   // 余白(mm)
  var printOn = false, autoPrint = false;
  var pageStyle = document.createElement('style');
  document.head.appendChild(pageStyle);
  function mm2px(mm) { return mm * 96 / 25.4; }

  function isShown(st) {
    if (!st.visible) return false;
    if (st.kind === 'raster') return map.hasLayer(st.layer);
    if (st.kind === 'geojson') return !!(st.layer && map.hasLayer(st.layer));
    var any = false;
    st.tiles.forEach(function (t) { if (t.onMap) any = true; });
    return any;
  }
  function swatchEl(kind, color, fill) {
    var sw = document.createElement('span');
    sw.className = 'pf-sw' + (kind === 'line' ? ' line' : kind === 'point' ? ' point' : '');
    var c = GIS.safeColor(color) || '#666666', f = GIS.safeColor(fill) || '';
    if (kind === 'line') sw.style.borderTopColor = c; else { sw.style.borderColor = c; sw.style.background = f || c; }
    return sw;
  }
  function legendFor(st) {
    var cfg = st.cfg;
    var subs = cfg.legend;
    if ((!subs || !subs.length) && cfg.styleBy && cfg.styleBy.colors && cfg.styleBy.legend !== false) {
      var lb = cfg.styleBy.labels || {};
      subs = Object.keys(cfg.styleBy.colors).map(function (k) { return { label: lb[k] != null ? lb[k] : k, color: cfg.styleBy.colors[k] }; });
    }
    return subs || [];
  }
  function buildPrintLegend() {
    var box = $('pf-legend');
    box.innerHTML = '';
    if (!$('pp-legend').checked || !treeRoot) return;
    GIS.flatten(treeRoot).forEach(function (cfg) {   // 画面のレイヤー一覧と同じ順(上から)
      var st = stById[cfg.id];
      if (!st || !isShown(st) || st.kind === 'raster') return;
      var subs = legendFor(st);
      var inv = cfg.style && cfg.style.invisible;
      if (inv && !subs.length && !cfg.labelField) return;
      var item = document.createElement('div');
      item.className = 'pf-item';
      var nm = document.createElement('div');
      nm.className = 'pf-name';
      var s = cfg.style || {};
      if (inv) { var t0 = document.createElement('span'); t0.textContent = 'Ａ'; nm.appendChild(t0); }
      else if (!subs.length) nm.appendChild(swatchEl(cfg.geometry === 'line' ? 'line' : cfg.geometry === 'point' ? 'point' : 'poly', s.color, cfg.geometry === 'line' ? '' : s.fillColor));
      var tx = document.createElement('span');
      tx.textContent = cfg.name + (inv ? '(文字)' : '');
      nm.appendChild(tx);
      item.appendChild(nm);
      subs.forEach(function (l) {
        var row = document.createElement('div');
        row.className = 'pf-sub';
        row.appendChild(swatchEl('poly', l.color, l.color));
        var lt = document.createElement('span');
        lt.textContent = l.label;
        row.appendChild(lt);
        item.appendChild(row);
      });
      box.appendChild(item);
    });
  }
  function scaleText() {
    var c = map.getCenter(), z = map.getZoom();
    var mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, z);   // 1ピクセルが何mか
    var d = mpp / 0.000264583;                                                    // 96dpi: 1px = 0.2646mm
    var step = d < 2000 ? 50 : d < 20000 ? 100 : 1000;
    return '縮尺 約 1:' + (Math.round(d / step) * step).toLocaleString('ja-JP');
  }
  function updatePrintInfo() {
    var t = ($('pp-title').value || '').trim();
    $('ph-title').textContent = t || conf.title || '地図';
    var now = new Date();
    var land = $('pp-orient').value !== 'portrait';
    $('ph-meta').textContent = '印刷日: ' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日\n' +
      scaleText() + '(' + $('pp-size').value + (land ? '横' : '縦') + ' 等倍で印刷した場合の目安)';
    $('ph-meta').style.whiteSpace = 'pre-line';
    buildPrintLegend();
    // 注意書き・出典
    var notes = $('pf-notes');
    notes.innerHTML = '';
    function add(text) { if (!text) return; var p = document.createElement('p'); p.textContent = text; notes.appendChild(p); }
    add(($('notice-text') && $('notice-text').textContent) || '');
    var base = bases.filter(function (b) { return map.hasLayer(b.layer); })[0];
    add('背景: ' + (base ? base.name : '') + '(出典: 国土地理院)');
    var meta = [];
    states.slice().reverse().forEach(function (st) {
      if (st.kind === 'raster' || !isShown(st)) return;
      var bits = [];
      if (st.cfg.updated && conf.showUpdated !== false) bits.push('データ更新 ' + (st.cfg.updatedLabel || st.cfg.updated));
      if (st.cfg.source) bits.push('出典 ' + st.cfg.source);
      if (bits.length) meta.push(st.cfg.name + '(' + bits.join(' / ') + ')');
    });
    add(meta.length ? 'データ: ' + meta.join('、') : '');
    [].concat(conf.attribution || []).forEach(function (a) { add('出典: ' + a); });
    try { add('利用規約: ' + new URL('terms.html', location.href).href); } catch (e) {}
  }
  function applyPaper() {
    var size = $('pp-size').value || 'A4';
    var sz = PAPER[size] || PAPER.A4, land = $('pp-orient').value !== 'portrait';
    var w = land ? sz[1] : sz[0], hh = land ? sz[0] : sz[1];
    pageStyle.textContent = '@page { size: ' + size + ' ' + (land ? 'landscape' : 'portrait') + '; margin: ' + PMARGIN + 'mm; }';
    var pw = Math.floor(mm2px(w - PMARGIN * 2)), ph = Math.floor(mm2px(hh - PMARGIN * 2)) - 4;
    var st = document.documentElement.style;
    st.setProperty('--pw', pw + 'px'); st.setProperty('--ph', ph + 'px');
    st.setProperty('--ps', String(Math.min(1, ((window.innerWidth || pw) - 24) / pw)));
    map.invalidateSize();
    updatePrintInfo();
  }
  // 地図の部品(タイル・図形)が読み込み終わるまで待ってから、印刷ボタンを有効にする
  function waitLoaded() {
    var t0 = Date.now(), btn = $('pp-print'), ps = $('pp-state');
    btn.disabled = true; ps.textContent = '地図を読み込み中…';
    syncAll().then(function () {
      (function poll() {
        var base = bases.filter(function (b) { return map.hasLayer(b.layer); })[0];
        var busy = pending > 0 || (base && base.layer._loading);
        if ((busy || Date.now() - t0 < 900) && Date.now() - t0 < 12000) { setTimeout(poll, 300); return; }
        updatePrintInfo();
        ps.textContent = '準備できました。地図を動かして範囲を調整し、「印刷する」を押してください';
        btn.disabled = false;
      })();
    });
  }
  function enterPrint(auto) {
    if (printOn) return;
    printOn = true; autoPrint = !!auto;
    map.closePopup(); highlight.clearLayers(); $('search-results').hidden = true; $('panel').hidden = true;
    document.body.classList.add('print-mode');
    applyPaper();
    if (auto) { map.invalidateSize(); updatePrintInfo(); } else { window.scrollTo(0, 0); waitLoaded(); }
  }
  function leavePrint() {
    if (!printOn) return;
    printOn = false; autoPrint = false;
    document.body.classList.remove('print-mode');
    pageStyle.textContent = '';
    setTimeout(function () { map.invalidateSize(); syncNotice(); syncAll(); }, 50);
  }
  $('btn-print').addEventListener('click', function () { enterPrint(false); });
  $('pp-print').addEventListener('click', function () { window.print(); });
  $('pp-close').addEventListener('click', leavePrint);
  ['pp-size', 'pp-orient'].forEach(function (id) { $(id).addEventListener('change', function () { applyPaper(); waitLoaded(); }); });
  $('pp-title').addEventListener('input', updatePrintInfo);
  $('pp-legend').addEventListener('change', updatePrintInfo);
  window.addEventListener('resize', function () { if (printOn) applyPaper(); });
  // Ctrl+P など、ボタン以外から印刷されたときも、できるだけきれいに(読み込み済みの範囲で)印刷する
  window.addEventListener('beforeprint', function () { if (!printOn) enterPrint(true); });
  window.addEventListener('afterprint', function () { if (autoPrint) leavePrint(); });

  // ================= 起動 =================
  function fetchJSON(url, optional) {
    return fetch(url + '?t=' + Date.now()).then(function (r) {
      if (!r.ok) { if (optional) return {}; throw new Error(url + ' が読み込めません'); }
      return r.json();
    });
  }
  syncNotice();
  Promise.all([fetchJSON('manifest.json', false), fetchJSON('config.json', true).catch(function () { return {}; })])
    .then(function (res) {
      var manifest = res[0], c = res[1] || {};
      conf = c; conf.valueMaps = c.valueMaps || {};
      if (c.title) document.title = c.title;
      var nc = c.notice || {};
      if (nc.text) $('notice-text').textContent = String(nc.text);
      if (nc.enabled === false) $('notice').hidden = true;
      syncNotice();
      var m = c.map || {};
      map.setMinZoom(m.minZoom || 5);
      map.setMaxZoom(m.maxZoom || 20);
      map.setView(m.center || [35.68, 139.76], m.zoom || 15);
      [].concat(c.attribution || []).forEach(function (t) { if (t) map.attributionControl.addAttribution(esc(t)); });
      if (m.maxBounds) map.setMaxBounds(m.maxBounds);

      // 自動生成された情報(manifest)+ 管理画面の設定(config)を合成
      var cl = c.layers || {}, seen = {}, cfgs = [], allCfg = {};
      (manifest.layers || []).forEach(function (e) {
        seen[e.id] = true;
        if (e.error) { console.warn('[' + e.id + '] ' + e.error); return; }
        var cc = cl[e.id] || {};
        var mc = GIS.mergeLayer(e.id, e, cc);
        allCfg[e.id] = mc;                       // 非公開のレイヤーも、設定の引き継ぎ元として保持する
        if (cc.hidden) return;
        if (mc.broken) { console.warn('[' + e.id + '] 設定が不正なため表示しません'); return; }
        cfgs.push(mc);
      });
      // 点レイヤーの属性を取り込んだ面レイヤーは、点レイヤーのポップアップ設定(表示名・単位・対応表)を使う
      (manifest.layers || []).forEach(function (e) {
        if (e.joinFrom && allCfg[e.id] && allCfg[e.joinFrom.points]) GIS.applyJoinInheritance(allCfg[e.id], allCfg[e.joinFrom.points], e.joinFrom.fields);
      });
      Object.keys(cl).forEach(function (id) { // dataフォルダに無い画像タイルなどを config だけで追加する場合
        if (seen[id] || !cl[id].type || cl[id].hidden) return;
        var xc = GIS.mergeLayer(id, null, cl[id]);
        if (xc.broken) { console.warn('[' + id + '] 設定が不正なため表示しません'); return; }
        cfgs.push(xc);
      });

      treeRoot = GIS.buildTree(cfgs, c.categories);
      var flat = GIS.flatten(treeRoot);              // 画面の上から順
      flat.slice().reverse().forEach(function (cfg) { // 地図では上のレイヤーほど手前
        var st = { cfg: cfg, kind: kindOf[cfg.type] || 'geojson', visible: cfg.visible === true, opacity: 1, tiles: new Map(), needed: {} };
        if (st.kind === 'raster') {
          st.layer = L.tileLayer(cfg.url, {
            attribution: cfg.attribution ? esc(cfg.attribution) : '', minZoom: cfg.minZoom || 0,
            maxNativeZoom: cfg.maxNativeZoom || 18, maxZoom: 22, tms: !!cfg.tms
          });
        }
        states.push(st);
        stById[cfg.id] = st;
      });
      buildPanel();
      showStatus(map.getCenter());
      buildGroupSelect();
      syncAll();
    })
    .catch(function (e) {
      alert('設定の読み込みに失敗しました。\n' + e.message +
        '\n\n【公開サイトの場合】GitHub Actions のビルド完了まで数分かかります(初回)。' +
        '\n【手元(Live Server)の場合】先に「python tools/build.py」を実行し、できた _site フォルダの index.html を開いてください。');
      map.setView([35.68, 139.76], 15); setBase('std');
    });
})();
