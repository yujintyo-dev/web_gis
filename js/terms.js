/* 利用規約・注意事項ページ
 * タブ・本文は config.json(管理画面の「利用規約・注意事項」)から作ります。
 * URLの末尾に #タブID を付けると、そのタブを開いた状態で表示します(地図画面の「⚠」から使います)。
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function setAll(cls, text) {
    var list = document.getElementsByClassName(cls);
    for (var i = 0; i < list.length; i++) list[i].textContent = text;
  }
  var tabs = [], conf = {}, vars = {}, names = {};

  function stdBody() {
    var tp = $('std-terms');
    return tp ? tp.innerHTML : '';
  }
  function bodyHtml(t) {
    var html = '';
    if (t.builtin) {
      html = GIS.renderDoc(t.body || stdBody(), vars);
      var extra = (conf.terms || {}).extra;   // 追記事項(1行 = 1段落)。文字として扱います
      if (extra) {
        var lines = String(extra).split(/\r?\n/).filter(function (x) { return x.trim(); });
        if (lines.length) html += '<h2>追記事項</h2>' + lines.map(function (ln) { return '<p>' + GIS.esc(ln) + '</p>'; }).join('');
      }
      return html;
    }
    var ls = t.layers.map(function (id) { return names[id] || id.split('/').pop(); });
    if (ls.length) html += '<p class="target">対象のレイヤー: ' + ls.map(GIS.esc).join('、') + '</p>';
    if (t.summary) html += '<div class="box">' + GIS.esc(t.summary) + '</div>';
    return html + GIS.renderDoc(t.body, vars);
  }

  function show(id, focus) {
    var t = tabs.filter(function (x) { return x.id === id; })[0] || tabs[0];
    if (!t) return;
    Array.prototype.forEach.call($('tabs').children, function (b) {
      var on = b.getAttribute('data-id') === t.id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
      if (on && b.scrollIntoView) try { b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    });
    $('doc').innerHTML = (t.builtin ? '' : '<h2 class="doc-title">' + GIS.esc(t.title) + '</h2>') + bodyHtml(t);
    document.title = t.title + ' - ' + (conf.title || '公開型GIS');
  }

  function build() {
    var nav = $('tabs');
    nav.innerHTML = '';
    tabs.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-id', t.id);
      b.textContent = t.title;
      b.className = t.builtin ? 'tab-main' : 'tab-note';
      b.addEventListener('click', function () {
        if (location.hash !== '#' + t.id) history.replaceState(null, '', '#' + t.id);
        show(t.id);
      });
      b.addEventListener('keydown', function (e) {   // ←→キーでタブを移動
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = tabs[(i + d + tabs.length) % tabs.length];
        history.replaceState(null, '', '#' + n.id);
        show(n.id, true);
      });
      nav.appendChild(b);
    });
    nav.hidden = tabs.length < 2;
  }
  function fromHash() { return decodeURIComponent((location.hash || '').slice(1)); }

  function fetchJSON(url) {
    return fetch(url + '?t=' + Date.now()).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
  }
  Promise.all([fetchJSON('config.json'), fetchJSON('manifest.json')]).then(function (res) {
    conf = res[0] || {};
    var c = conf, t = c.terms || {};
    ((res[1] && res[1].layers) || []).forEach(function (m) { names[m.id] = m.name; });
    Object.keys(c.layers || {}).forEach(function (id) { if (c.layers[id] && c.layers[id].name) names[id] = c.layers[id].name; });
    vars = GIS.docVars(c);
    if (c.title) setAll('t-site', c.title);
    setAll('t-org', vars['運営者']);
    setAll('t-dept', vars['担当課']);
    if (t.contact) { $('t-contact').textContent = String(t.contact); $('t-contact-row').hidden = false; }
    if (t.date) { $('t-date').textContent = String(t.date); $('t-date-row').hidden = false; }
    tabs = GIS.termsTabs(c).filter(function (x) { return !x.hidden; });
    build();
    show(fromHash());
    window.addEventListener('hashchange', function () { show(fromHash()); });
  });
})();
